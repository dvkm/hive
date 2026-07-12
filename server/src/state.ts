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

export function getTask(db: DB, id: string): any | null {
  const r = db.query("SELECT * FROM tasks WHERE id = ?").get(id);
  return r ? parseTask(r) : null;
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

// Write an append-only event row and broadcast it. Returns the parsed event.
export function writeEvent(
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
  const parsed = parseEvent(row);
  broadcast({ type: "event", event: parsed });
  return parsed;
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

// The finished-handoff, shared by every herdr-signal path (the reconciler's
// poll backstop and the supervise wait loop): an agent observed idle/gone on an
// in_progress task that has a real work product (a pr_url, or a scout report)
// advances to in_review. Deliberately independent of anything the agent emits.
// Returns true when the task was advanced.
export function advanceIfFinished(db: DB, taskId: string, agentStatus: string, source: string): boolean {
  if (agentStatus !== "idle" && agentStatus !== "gone") return false; // working/blocked/unknown → leave it be
  const task = getTask(db, taskId);
  if (!task || task.state !== "in_progress") return false;
  const hasReport = task.kind === "scout" && evidenceCount(db, taskId, "report") >= 1;
  if (!task.pr_url && !hasReport) return false; // no product to review → health surfaces it, don't advance
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
  if (!canTransition(from, to)) {
    // Agents jump straight to done often enough (4/16 sampled sessions) that
    // the error should teach the path, not just reject.
    const hint =
      to === "done" && (from === "in_progress" || from === "in_review")
        ? " — done is reached via review: emit `ready --pr-url <url>` (in_review), then the director merges (verifying -> done)"
        : "";
    throw new TransitionError(`invalid transition: '${from}' -> '${to}'${hint}`);
  }

  // Evidence gates apply to hive-driven work. Tracking-only tasks
  // (source='external': another agent using the board as a kanban, never
  // dispatched) move freely — hive records, it doesn't supervise them.
  if (to === "done" && task.source !== "external") {
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

  // Re-queuing a failed task (attention tray) resets its runtime binding so the
  // next spawn is clean — a queued task must not point at a dead agent/worktree.
  if (to === "queued") {
    db.query(
      "UPDATE tasks SET state = ?, updated_at = ?, agent_target = NULL, worktree_path = NULL, branch = NULL WHERE id = ?"
    ).run(to, now(), taskId);
  } else {
    db.query("UPDATE tasks SET state = ?, updated_at = ? WHERE id = ?").run(to, now(), taskId);
  }
  writeEvent(db, {
    task_id: taskId,
    source,
    type: "state_change",
    payload: { from, to, reason: opts.reason ?? null },
  });
  const updated = getTask(db, taskId);
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
