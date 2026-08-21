// Task state machine + event writing. Server-enforced per SPEC.md.
//
// queued -> in_progress -> (needs_decision <-> in_progress) -> in_review
//        -> verifying -> done
// Any non-terminal state -> failed | cancelled (with a reason event).
// Transition to `done` is REJECTED unless >= 1 evidence row exists
// (scouts additionally require an evidence row of kind = 'report').
import type { DB } from "./db.ts";
import { newId, now } from "./db.ts";
import { broadcast } from "./bus.ts";
import { parseEvent, parseTask, parseDecision } from "./rows.ts";
import { redact } from "./secrets.ts";
import { enqueue } from "./notifications.ts";
import { broadcastTask } from "./health.ts";
import { isTrackingOnlyTask, isJiraMirror } from "./supervision.ts";

export const STATES = [
  "queued",
  "in_progress",
  "needs_decision",
  "in_review",
  "verifying",
  "done",
  "failed",
  "cancelled",
] as const;
export type State = (typeof STATES)[number];

export const TERMINAL: State[] = ["done", "failed", "cancelled"];

// Defined in supervision.ts (one definition, derived from isExternalTask).
// Re-exported here because the existing callers import it from state.
export { isTrackingOnlyTask };

export const TRACKING_ONLY_REQUEUE_ERROR = "a mirrored Jira task has no agent work to requeue";
export const TRACKING_ONLY_OWNERSHIP_ERROR = "tracking-only tasks cannot create Hive-owned agent work";

// Allowed "forward" transitions. failed/cancelled are handled separately
// because they are reachable from any non-terminal state.
const FORWARD: Record<State, State[]> = {
  queued: ["in_progress"],
  in_progress: ["needs_decision", "in_review"],
  needs_decision: ["in_progress"],
  in_review: ["verifying", "in_progress"], // in_progress = captain requested changes

  verifying: ["done", "in_progress"], // failed smoke checks bounce back
  done: [],
  failed: ["queued"], // re-queue a failed task for another attempt (attention tray)
  cancelled: [],
};

export class TransitionError extends Error {}

// Fired after a task reaches an unambiguously-final state (done / cancelled) so
// the server can auto-tear-down its worktree + herdr session. Kept as an
// injected hook (set only in production wiring, index.ts) so state.ts stays free
// of the herdr/subprocess dependency and tests transition without side effects.
// NOT fired for `failed`: a failed task may still be auto-requeued/retried, and
// its worktree is handled by the recovery path + the reaper backstop.
type TerminalHook = (db: DB, taskId: string, to: State) => void;
let terminalHook: TerminalHook | null = null;
export function setTerminalHook(fn: TerminalHook | null): void {
  terminalHook = fn;
}

// Fired for every durable task event. Production uses this to wake the chat
// supervisor when one of its workers reaches a meaningful milestone; tests
// leave it unset so event writes stay side-effect free.
type EventHook = (db: DB, event: any) => void;
let eventHook: EventHook | null = null;
export function setEventHook(fn: EventHook | null): void {
  eventHook = fn;
}

export function getTask(db: DB, id: string): any | null {
  const r = db.query("SELECT * FROM tasks WHERE id = ?").get(id);
  return r ? parseTask(r) : null;
}

// A dependency is "met" once its code has landed: PR merged (verifying) or
// fully done. Every other state — still queued/working/in review, or failed/
// cancelled — blocks the dependent. Returns the blocking dep rows (id, number,
// title, state) so callers can name them in a visible 'blocked by task X'.
// ponytail: a failed dep auto-requeues under a NEW id, so a task depending on
// the old (now-failed) id blocks until the director edits/cancels it. Visible,
// not silent — upgrade to re-point deps at the requeue successor if it bites.
const DEP_MET_STATES = ["verifying", "done"];
export function unmetDeps(db: DB, task: { depends_on?: string[] } | null | undefined): { id: string; number: number; title: string; state: string }[] {
  const ids = task?.depends_on ?? [];
  if (!ids.length) return [];
  const blocking: { id: string; number: number; title: string; state: string }[] = [];
  for (const id of ids) {
    const dep = db.query("SELECT id, number, title, state FROM tasks WHERE id = ?").get(id) as
      | { id: string; number: number; title: string; state: string }
      | undefined;
    // A vanished dependency can never be met, so it stays blocking (visible).
    if (!dep || !DEP_MET_STATES.includes(dep.state)) blocking.push(dep ?? { id, number: 0, title: "(unknown task)", state: "missing" });
  }
  return blocking;
}

// Record a visible 'blocked by task X' — but only when the blocking set changed
// since the last such event, so a 30s dispatch loop doesn't spam the timeline.
// Mirrors the dedup discipline of nudgeConflict/ci_failure in the reconciler.
export function noteDependencyBlock(
  db: DB,
  taskId: string,
  blocking: { number: number; title: string }[],
  source: string
): void {
  const blocked_by = blocking.map((b) => `#${b.number} ${b.title}`);
  const note = `blocked by ${blocked_by.join(", ")}`;
  const last = db
    .query("SELECT payload FROM events WHERE task_id = ? AND type = 'dependency_blocked' ORDER BY ts DESC LIMIT 1")
    .get(taskId) as { payload: string } | undefined;
  if (last) {
    try {
      if (JSON.parse(last.payload).note === note) return; // same blockers already surfaced
    } catch {}
  }
  writeEvent(db, { task_id: taskId, source, type: "dependency_blocked", payload: { note, blocked_by } });
  broadcastTask(db, getTask(db, taskId));
}

// A task deferred pending an OFFLINE human action (e.g. sudo). It stays
// in_progress, but the stale/nudge machinery skips it while deferred_until is in
// the future — that is what stops the endless "gone quiet" nudges (task #329
// replied 9× to the same nudge). Far-future timestamp = indefinite; a real date
// = auto-resume then.
export function isDeferred(
  task: { deferred_until?: string | null } | null | undefined,
  nowMs: number = Date.now()
): boolean {
  const until = task?.deferred_until;
  return !!until && Date.parse(until) > nowMs;
}

export function deferTask(
  db: DB,
  taskId: string,
  until: string,
  opts: { source?: string; note?: string } = {}
): any {
  db.query("UPDATE tasks SET deferred_until = ?, updated_at = ? WHERE id = ?").run(until, now(), taskId);
  writeEvent(db, { task_id: taskId, source: opts.source ?? "agent", type: "deferred", payload: { until, note: opts.note ?? null } });
  const t = getTask(db, taskId);
  broadcastTask(db, t);
  return t;
}

export function undeferTask(db: DB, taskId: string, opts: { source?: string; note?: string } = {}): any {
  db.query("UPDATE tasks SET deferred_until = NULL, updated_at = ? WHERE id = ?").run(now(), taskId);
  writeEvent(db, { task_id: taskId, source: opts.source ?? "director", type: "undeferred", payload: { note: opts.note ?? null } });
  const t = getTask(db, taskId);
  broadcastTask(db, t);
  return t;
}

export function canTransition(from: State, to: State): boolean {
  if (!STATES.includes(to)) return false;
  if (to === "failed") return !TERMINAL.includes(from);
  // A failed task can be dismissed to cancelled from the attention tray; any
  // other non-terminal state can be cancelled too. done/cancelled cannot.
  if (to === "cancelled") return from !== "done" && from !== "cancelled";
  return FORWARD[from]?.includes(to) ?? false;
}

export function evidenceCount(db: DB, taskId: string, kind?: string): number {
  const sql = kind
    ? "SELECT COUNT(*) AS n FROM evidence WHERE task_id = ? AND kind = ?"
    : "SELECT COUNT(*) AS n FROM evidence WHERE task_id = ?";
  const row = kind
    ? db.query(sql).get(taskId, kind)
    : db.query(sql).get(taskId);
  return (row as { n: number }).n;
}

// Count evidence captured from a specific commit SHA (stamped into meta.commit_sha
// when the agent emits it). Drives the freshness gate: the evidence the director
// sees must reflect the latest commit, so a handoff after new commits requires
// re-captured evidence tied to the current HEAD (the #223 stale-screenshot bug).
export function evidenceAtSha(db: DB, taskId: string, sha: string): number {
  const row = db
    .query("SELECT COUNT(*) AS n FROM evidence WHERE task_id = ? AND json_extract(meta, '$.commit_sha') = ?")
    .get(taskId, sha);
  return (row as { n: number }).n;
}

function insertEvent(
  db: DB,
  args: { task_id: string; source: string; type: string; payload?: unknown }
): any {
  const row = {
    id: newId("evt"),
    task_id: args.task_id,
    ts: now(),
    source: args.source,
    type: args.type,
    payload: JSON.stringify(redact(args.payload ?? {})),
  };
  db.query(
    "INSERT INTO events (id, task_id, ts, source, type, payload) VALUES (?,?,?,?,?,?)"
  ).run(row.id, row.task_id, row.ts, row.source, row.type, row.payload);
  return parseEvent(row);
}

function publishEvent(db: DB, event: any): void {
  broadcast({ type: "event", event });
  if (eventHook) {
    try {
      eventHook(db, event);
    } catch (e) {
      console.error("[hive] event hook:", e);
    }
  }
}

// Write an append-only event row and broadcast it. Returns the parsed event.
export function writeEvent(
  db: DB,
  args: { task_id: string; source: string; type: string; payload?: unknown }
): any {
  const event = insertEvent(db, args);
  publishEvent(db, event);
  return event;
}

export function mutateWithEvent<T>(
  db: DB,
  mutate: () => T,
  args: { task_id: string; source: string; type: string; payload?: unknown }
): T {
  const [result, event] = db.transaction(() => [mutate(), insertEvent(db, args)] as const)();
  publishEvent(db, event);
  return result;
}

// Expire every still-open decision on a task: its options can no longer be
// acted on once the task is terminal, and an orphaned open card sits forever in
// the inbox. Writes a decision_expired event and broadcasts the expired card so
// the inbox clears live over SSE. Idempotent (only touches status='open' rows).
export function expireOpenDecisions(db: DB, taskId: string, reason: string): number {
  const rows = db.query("SELECT * FROM decisions WHERE task_id = ? AND status = 'open'").all(taskId) as any[];
  for (const r of rows) {
    db.query("UPDATE decisions SET status = 'expired' WHERE id = ?").run(r.id);
    writeEvent(db, { task_id: taskId, source: "system", type: "decision_expired", payload: { decision_id: r.id, reason } });
    broadcast({ type: "decision", decision: parseDecision({ ...r, status: "expired" }) });
  }
  return rows.length;
}

// Backfill/backstop: expire open decisions whose task is already terminal
// (legacy orphans created before transition-time expiry existed). Idempotent —
// safe to call on every startup.
export function expireOrphanedDecisions(db: DB): number {
  const tasks = db
    .query(
      `SELECT DISTINCT d.task_id AS task_id FROM decisions d JOIN tasks t ON t.id = d.task_id
       WHERE d.status = 'open' AND t.state IN ('done','failed','cancelled')`
    )
    .all() as { task_id: string }[];
  let n = 0;
  for (const t of tasks) n += expireOpenDecisions(db, t.task_id, "task terminal (backfill)");
  return n;
}

// The one guard against re-queuing a PR whose latest review verdict is "changes
// requested" before the agent has actually acted (#163, #234). Returns true =
// still unaddressed = DON'T insert into the review queue. "Addressed" means
// something new landed after the latest changes_requested: a new commit pushed
// (the reconciler's `pr_synchronized` event — hive's stand-in for GitHub's
// synchronize webhook), fresh evidence, or a fresh review_summary. Any of the
// three clears the block. Callers apply this at every point that inserts into
// the queue (the idle backstop here, and handOffToReview for the reconciler/
// link-pr paths), so a bare CI-green poll can no longer bounce a task the
// director just sent back straight into review with no new work on it.
export function changesRequestUnaddressed(db: DB, taskId: string): boolean {
  const cr: any = db
    .query("SELECT ts, payload FROM events WHERE task_id = ? AND type = 'changes_requested' ORDER BY ts DESC LIMIT 1")
    .get(taskId);
  if (!cr?.ts) return false; // never sent back → nothing to guard
  // Evidence-only / review_summary path: a changes_requested can be evidence-only
  // (#163), so either of these after the request clears the block immediately.
  const nonCommit = db
    .query(
      `SELECT 1 FROM events WHERE task_id = ? AND type = 'review_summary' AND ts > ?
       UNION SELECT 1 FROM evidence WHERE task_id = ? AND ts > ? LIMIT 1`
    )
    .get(taskId, cr.ts, taskId, cr.ts);
  if (nonCommit) return false;
  // Commit signal: the baseline is the head SHA at request time (stamped into the
  // changes_requested payload; null when no pr_synchronized existed yet). A
  // pr_synchronized on the SAME head — or the first post-request observation when
  // the head was unknown — is NOT new work; only a later DIFFERENT head is.
  let baseline: string | null = null;
  try {
    baseline = JSON.parse(cr.payload ?? "{}").head_sha ?? null;
  } catch {
    baseline = null;
  }
  const syncs = db
    .query("SELECT payload FROM events WHERE task_id = ? AND type = 'pr_synchronized' AND ts > ? ORDER BY ts ASC")
    .all(taskId, cr.ts) as { payload: string }[];
  for (const s of syncs) {
    let sha: string | null = null;
    try {
      sha = JSON.parse(s.payload).head_sha ?? null;
    } catch {
      sha = null;
    }
    if (baseline === null) {
      baseline = sha; // first observation when head-at-request was unknown
      continue;
    }
    if (sha !== null && sha !== baseline) return false; // genuinely new commit → addressed
  }
  return true; // still unaddressed
}

// A director answer can invalidate the report and its quiz. Never hand the
// task back for review until the agent has summarized the answer's effect.
export function decisionAnswerUnaddressed(db: DB, taskId: string): boolean {
  const answer = db.query("SELECT rowid FROM events WHERE task_id = ? AND type = 'decision_answered' ORDER BY rowid DESC LIMIT 1").get(taskId) as { rowid: number } | undefined;
  if (!answer) return false;
  const review = db.query("SELECT rowid FROM events WHERE task_id = ? AND type = 'review_summary' ORDER BY rowid DESC LIMIT 1").get(taskId) as { rowid: number } | undefined;
  return !review || review.rowid < answer.rowid;
}

const QUEUED_INPUT_HANDOFF_GRACE_MS = 2 * 60 * 1000;

// The finished-handoff, shared by every herdr-signal path (the reconciler's
// poll backstop and the supervise wait loop): an agent observed idle/gone on an
// in_progress task that has a real work product (a pr_url, or a scout report)
// advances to in_review, except while a queued-input recovery is pending or in
// its brief grace period. Deliberately independent of anything the agent emits.
// Returns true when the task was advanced.
export function advanceIfFinished(db: DB, taskId: string, agentStatus: string, source: string): boolean {
  if (agentStatus !== "idle" && agentStatus !== "gone") return false; // working/blocked/unknown → leave it be
  const task = getTask(db, taskId);
  if (!task || task.state !== "in_progress" || isTrackingOnlyTask(task)) return false;
  const queuedRecovery = db
    .query("SELECT ts, payload FROM events WHERE task_id = ? AND type = 'queued_input_recovered' ORDER BY ts DESC, rowid DESC LIMIT 1")
    .get(taskId) as { ts: string; payload: string } | undefined;
  if (queuedRecovery) {
    const delivered = JSON.parse(queuedRecovery.payload).delivered;
    if (delivered === null || Date.now() - Date.parse(queuedRecovery.ts) < QUEUED_INPUT_HANDOFF_GRACE_MS) return false;
  }
  const hasReport = task.kind === "scout" && evidenceCount(db, taskId, "report") >= 1;
  if (!task.pr_url && !hasReport) return false; // no product to review → health surfaces it, don't advance
  // Review means CI is green. failing/pending holds here; the reconciler's
  // syncPRs promotes the moment checks pass (and steers the agent on red).
  // null = no checks known (repo without CI) — that flows as before.
  if (task.pr_url && (task.ci_status === "failing" || task.ci_status === "pending")) return false;
  // The idle backstop must not hand the director an empty review: a PR with no
  // evidence isn't reviewable (the protocol says attach evidence BEFORE ready;
  // the agent's explicit `ready` emit is gated the same way elsewhere).
  if (!hasReport && evidenceCount(db, taskId) < 1) return false;
  // After a changes-request, mere idleness is NOT "addressed" (#163). Require
  // visible new work before re-advancing — the shared guard below.
  if (changesRequestUnaddressed(db, taskId)) return false;
  if (decisionAnswerUnaddressed(db, taskId)) return false;
  writeEvent(db, {
    task_id: taskId,
    source,
    type: "ready_for_review",
    payload: { pr_url: task.pr_url ?? null, via: agentStatus, kind: task.kind },
  });
  transition(db, taskId, "in_review", {
    source,
    reason: hasReport ? "scout report ready; agent idle" : "PR open; agent idle",
  });
  return true;
}

// Perform a state transition. Throws TransitionError on invalid transition or
// when a `done` transition lacks required evidence. Writes a state_change event.
export function transition(
  db: DB,
  taskId: string,
  to: State,
  opts: { source?: string; reason?: string } = {}
): any {
  const task = getTask(db, taskId);
  if (!task) throw new TransitionError(`unknown task: ${taskId}`);
  const from = task.state as State;
  const source = opts.source ?? "director";

  if (from === to) throw new TransitionError(`task already in state '${to}'`);
  // Requeue means "retry the agent work". For a JIRA MIRROR there is none, so
  // the operation is undefined rather than merely risky — refuse it. A plain
  // source='external' task a director actually spawned DOES have agent work to
  // retry, so it requeues normally (hive-996); scoping this to mirrors is what
  // keeps both true.
  if (from === "failed" && to === "queued" && isJiraMirror(task)) {
    throw new TransitionError(TRACKING_ONLY_REQUEUE_ERROR);
  }
  if (!canTransition(from, to)) {
    // Agents jump straight to done often enough (4/16 sampled sessions) that
    // the error should teach the path, not just reject.
    const hint =
      to === "done" && (from === "in_progress" || from === "in_review")
        ? " — done is reached via review: emit `ready --pr-url <url>` (in_review), then the director merges (verifying -> done)"
        : "";
    throw new TransitionError(`invalid transition: '${from}' -> '${to}'${hint}`);
  }

  // Evidence gates apply to hive-driven work. Tracking-only tasks (source
  // 'external', or a Jira mirror) move freely: hive records them, it does not
  // supervise them.
  if (to === "done" && !isTrackingOnlyTask(task)) {
    if (evidenceCount(db, taskId) < 1) {
      throw new TransitionError(
        "cannot transition to 'done': task has no evidence"
      );
    }
    if (task.kind === "scout" && evidenceCount(db, taskId, "report") < 1) {
      throw new TransitionError(
        "cannot transition to 'done': scout task requires a report evidence"
      );
    }
  }

  const updated = mutateWithEvent(db, () => {
    // Re-queuing a failed task (attention tray) resets its runtime binding so the
    // next spawn is clean — a queued task must not point at a dead agent/worktree.
    if (to === "queued") {
      db.query(
        "UPDATE tasks SET state = ?, updated_at = ?, agent_target = NULL, worktree_path = NULL, branch = NULL WHERE id = ?"
      ).run(to, now(), taskId);
    } else {
      db.query("UPDATE tasks SET state = ?, updated_at = ? WHERE id = ?").run(to, now(), taskId);
    }
    return getTask(db, taskId);
  }, {
    task_id: taskId,
    source,
    type: "state_change",
    payload: { from, to, reason: opts.reason ?? null },
  });
  broadcastTask(db, updated);
  // A terminal task can no longer act on any open decision — expire them so the
  // inbox clears and the answer endpoint can't be hit against a dead task.
  if (TERMINAL.includes(to)) expireOpenDecisions(db, taskId, `task ${to}`);
  // Notify on notable terminal-ish outcomes (batched into the digest).
  if (to === "done")
    enqueue(db, { kind: "done", task_id: taskId, title: `Task done: ${task.title}`, body: task.summary ?? undefined });
  else if (to === "failed")
    enqueue(db, { kind: "failed", task_id: taskId, title: `Task failed: ${task.title}`, body: opts.reason ?? undefined });
  // Auto-teardown on an unambiguously-final state. failed is excluded (still retriable).
  if ((to === "done" || to === "cancelled") && terminalHook) {
    try {
      terminalHook(db, taskId, to);
    } catch (e) {
      console.error("[hive] terminal cleanup hook:", e);
    }
  }
  return updated;
}
