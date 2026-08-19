// Auto-resume an agent whose OWN final message named unfinished next work.
//
// Task #976: an agent ended a turn with "Continuing autonomously - next the
// gate, then sync to the reviewed head, both suites, then the hardened canary
// once." — four named next steps, nothing blocking — and then sat idle until
// the director manually told it to resume.
//
// This is NOT the timer-based "gone quiet" nudge (reconciler.flagStale). That
// one fires on silence, so it is slow and fires just as hard on tasks that are
// legitimately parked. This one fires the instant the turn ENDS (the Stop
// hook's agent_turn_end event) and only when the agent ITSELF said it had more
// to do. The steer quotes that sentence back, so hive needs no opinion about
// what should happen next — the agent's own words are the instruction.
//
// Conservative in one direction on purpose: a missed commitment costs one timer
// nudge later; a false one re-prods an agent that correctly finished.
import type { DB } from "./db.ts";
import { getTask, isDeferred, unmetDeps, writeEvent } from "./state.ts";
import { enqueue } from "./notifications.ts";

// A genuinely stuck agent must not be poked forever. Cap per task, then the
// director owns it.
export const MAX_AUTO_RESUMES = 3;

// Sentences that commit THIS agent to work it has not done yet — only the
// phrasings the incident review named, no clever generalisation.
// Every one of them names the SPEAKER as the one with work left: either
// explicitly ("I will", "I'll") or by an elided first-person subject
// ("Continuing", "Resuming"). A bare "Next steps:" heading is deliberately NOT
// here — it says what happens next without saying who does it, and it is the
// canonical heading of a handoff summary, so it would fire on agents that
// correctly finished. A next-steps list whose items say "I'll ..." still
// matches on the item line.
const COMMITMENT: RegExp[] = [
  /^(?:continuing|resuming|proceeding|carrying on|picking (?:this|it) back up)\b/i,
  /\bstaying on (?:it|this|that)\b/i,
  /\b(?:i|we)\s*(?:['’]ll|\s*will)\b/i, // "I will", "I'll", "we'll", "next I will", "once X lands I will"
];

// Vetoes scanned over the WHOLE message: any of these and we keep our hands
// off, even if some sentence looks like a commitment.
//
// (a) the next step belongs to someone else,
const NOT_OURS: RegExp[] = [
  /\b(?:you|the director|david|the reviewer|the user|ci)\s+(?:will|should|can|may|needs? to|must)\b/i,
  /\bfor (?:you|the director|review)\b/i,
  /\b(?:over|up|back) to you\b/i,
  /\bif you\b/i, // "I'll be here if you need anything" — addressed at the human
];
// (b) the agent is waiting on a human or an external system — a legitimate stop,
const WAITING: RegExp[] = [
  /\b(?:waiting|wait)\s+(?:on|for)\b/i,
  /\bawaiting\b/i,
  /\bblocked\s+(?:on|by)\b/i,
  /\bonce (?:you|the director|david|approved|it(?:'|’)?s approved|the decision)\b/i,
  /\bneeds? (?:your|a|the director(?:'|’)?s) (?:decision|approval|answer|input|review)\b/i,
  /\b(?:let me know|should i\b|shall i\b|want me to\b|do you want)\b/i,
];
// (c) the "commitment" is actually a report of work already done.
const PAST: RegExp[] = [
  /\b(?:i|we)\s+(?:have\s+)?(?:already\s+)?(?:continued|resumed|finished|completed|wrapped)\b/i,
];

// Split into sentences, ignoring fenced code (a "next I will" inside a code
// block or a quoted brief is not a commitment).
function sentences(text: string): string[] {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .split(/\n+|(?<=[.!?])\s+/)
    .map((s) => s.replace(/^[\s>*\-•\d.)]+/, "").trim())
    .filter(Boolean);
}

// The exact sentence in which the agent committed to more work, or null. Public
// so the detector can be unit-tested against real transcript text.
export function namedCommitment(text: string): string | null {
  if (!text?.trim()) return null;
  const body = text.replace(/```[\s\S]*?```/g, " ");
  if ([...WAITING, ...NOT_OURS].some((re) => re.test(body))) return null;
  // Last match wins: a plan stated early and revised at the end should quote the
  // revision.
  let found: string | null = null;
  for (const s of sentences(text)) {
    if (PAST.some((re) => re.test(s))) continue;
    if (COMMITMENT.some((re) => re.test(s))) found = s;
  }
  return found ? found.slice(0, 400) : null;
}

export type ResumeAction =
  | { action: "none" }
  | { action: "resume"; quote: string; resumes: number }
  | { action: "escalate"; quote: string; resumes: number };

// Did this agent commit to more work and then stop with nothing blocking it?
// Read-only: every caller-visible side effect lives in autoResumeOnTurnEnd.
export function resumeDecision(db: DB, taskId: string): ResumeAction {
  const task = getTask(db, taskId);
  if (!task) return { action: "none" };
  // in_progress only. needs_decision / in_review / verifying / queued are parked
  // on the director or the merge flow, and terminal states are done with.
  if (task.state !== "in_progress") return { action: "none" };
  // Tracking-only mirrors and chat supervisors are not worker tasks — same
  // exclusions the dispatcher and reconciler already apply.
  if (task.source === "external" || task.source === "chat_supervisor") return { action: "none" };
  if (!task.agent_target) return { action: "none" };
  if (isDeferred(task)) return { action: "none" };
  if (unmetDeps(db, task).length) return { action: "none" };
  if (db.query("SELECT 1 FROM decisions WHERE task_id = ? AND status = 'open' LIMIT 1").get(taskId))
    return { action: "none" };

  // The agent's last WORD, and proof nothing happened after it. tool_use and the
  // status heartbeats are turn mechanics, not activity; anything else newer
  // (evidence, a steer, a state change, a previous auto_resume) means this
  // message is no longer the last thing that happened, so leave it alone.
  const last = db
    .query(
      `SELECT type, payload FROM events WHERE task_id = ?
         AND type NOT IN ('tool_use','agent_status','agent_turn_end','usage')
       ORDER BY ts DESC, rowid DESC LIMIT 1`
    )
    .get(taskId) as { type: string; payload: string } | undefined;
  if (!last || (last.type !== "assistant_text" && last.type !== "status")) return { action: "none" };
  let payload: any = {};
  try {
    payload = JSON.parse(last.payload);
  } catch {
    return { action: "none" };
  }
  const text = String((last.type === "assistant_text" ? payload.text : payload.note) ?? "");
  const quote = namedCommitment(text);
  if (!quote) return { action: "none" };

  const resumes = (
    db.query("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = 'auto_resume'").get(taskId) as { n: number }
  ).n;
  if (resumes < MAX_AUTO_RESUMES) return { action: "resume", quote, resumes: resumes + 1 };
  // Cap reached: hand it to the director ONCE. An agent that keeps re-committing
  // and re-stopping would otherwise trade poking the agent for poking the
  // director, which is the same bug pointed the other way.
  const escalated = db
    .query("SELECT 1 FROM events WHERE task_id = ? AND type = 'auto_resume' AND json_extract(payload, '$.escalated') = 1 LIMIT 1")
    .get(taskId);
  return escalated ? { action: "none" } : { action: "escalate", quote, resumes };
}

export type SteerFn = (taskId: string, message: string) => Promise<boolean>;

// Called when an agent's turn ends. Steers the agent with its own sentence, or
// escalates once the cap is hit. Every outcome is a visible `auto_resume` event.
export async function autoResumeOnTurnEnd(db: DB, taskId: string, steer: SteerFn): Promise<ResumeAction> {
  const decision = resumeDecision(db, taskId);
  if (decision.action === "none") return decision;

  if (decision.action === "escalate") {
    const task = getTask(db, taskId);
    writeEvent(db, {
      task_id: taskId,
      source: "system",
      type: "auto_resume",
      payload: { escalated: true, resumes: decision.resumes, quote: decision.quote },
    });
    enqueue(db, {
      kind: "auto_resume",
      task_id: taskId,
      title: `Stops after saying it will continue: ${task?.title ?? taskId}`,
      body: `${decision.resumes} auto-resumes already. Last words: “${decision.quote}”`,
    });
    return decision;
  }

  writeEvent(db, {
    task_id: taskId,
    source: "system",
    type: "auto_resume",
    payload: { resumes: decision.resumes, quote: decision.quote },
  });
  await steer(
    taskId,
    `You ended your last turn saying: “${decision.quote}”\n\n` +
      `That work is not done and nothing is blocking it. Continue now. ` +
      `If you are actually blocked, say what is blocking you with ` +
      `\`hive emit ${taskId} blocked --note "..."\` instead of ending the turn.`
  );
  return decision;
}
