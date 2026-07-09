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
import { parseEvent, parseTask } from "./rows.ts";
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
  in_review: ["verifying"],
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
    throw new TransitionError(`invalid transition: '${from}' -> '${to}'`);
  }

  if (to === "done") {
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
