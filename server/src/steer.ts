// Steer delivery receipts + queued redelivery.
//
// A steer to a task with no live agent used to vanish silently, so David
// re-sent the same message up to 3× (2026-07-09/10). Every steer now carries a
// delivery status on its own `steer` event payload:
//
//   delivered — herdr accepted it and the agent's pane got the Enter
//   queued    — nothing was live to receive it; the next spawn delivers it
//   failed    — either the task is terminal, or it's a never-spawned
//               source=external task (see queueSteerEvent below) — either
//               way, no spawn is ever coming to carry it
//
// The events table is the log of record — no side table, no migration. A queued
// steer is just a `steer` event whose payload says so, flipped to delivered when
// the respawn brief carries it.
import type { DB } from "./db.ts";
import { now } from "./db.ts";
import { writeEvent, getTask, transition } from "./state.ts";
import { neverDispatched } from "./supervision.ts";

export type Delivery = "delivered" | "queued" | "failed";

// A programmatic steer recorded QUEUED without touching herdr (callers that
// have no Herdr handle: cost guardrails, decision-dismiss recovery). Payload
// shape matches internalSteer's queued path, so drainSteers delivers it to a
// live agent within a reconciler cycle and a respawn brief carries it otherwise.
//
// neverDispatched (supervision.ts) means nothing — no live agent, no future
// spawn — will ever carry this message, so 'queued' would be a lie that sits
// unread forever (task #977). Record it 'failed' instead, same as a terminal
// task gets elsewhere. Returns false in that case so a caller that wants to
// surface it (e.g. reject the request) can.
//
// Deliberately does NOT special-case a Jira-linked task the way sendSteer's
// own jiraLinked branch does (posting the message as an outbound Jira
// comment): sendSteer's messages are director-authored text meant for a
// human to read, but every caller here writes hive-internal automation
// text ("do not retry", "note the call as a checkpoint") that would leak
// into a real ticket as a live comment nobody watching that Jira issue
// should see.
export function queueSteerEvent(db: DB, taskId: string, message: string, reason: string): boolean {
  const dead = neverDispatched(db, { id: taskId, source: getTask(db, taskId)?.source });
  writeEvent(db, {
    task_id: taskId,
    source: "system",
    type: "steer",
    payload: {
      message,
      target: null,
      attachments: [],
      delivery: dead ? "failed" : "queued",
      error: dead ? `${reason} — task is untracked (source=external) and has never been spawned, message undeliverable` : reason,
    },
  });
  return !dead;
}

export interface QueuedSteer {
  id: string; // event id
  message: string;
}

export function queuedSteers(db: DB, taskId: string): QueuedSteer[] {
  const rows = db
    .query(
      `SELECT id, json_extract(payload, '$.message') AS message FROM events
        WHERE task_id = ? AND type = 'steer' AND json_extract(payload, '$.delivery') = 'queued'
        ORDER BY ts`
    )
    .all(taskId) as { id: string; message: string | null }[];
  return rows.filter((r): r is QueuedSteer => !!r.message);
}

// Flip queued -> delivered, recording HOW it finally landed: `respawn` (the
// fresh agent's brief carried it) or `drain` (the reconciler re-sent it to an
// agent that was alive all along, just briefly unreachable).
export function markSteersDelivered(db: DB, ids: string[], via: "respawn" | "drain" = "respawn"): void {
  if (!ids.length) return;
  const ts = now();
  // json_remove drops the reason it was queued: it is stale once delivered, and
  // a lingering `error` on a delivered steer reads like a failure.
  const q = db.query(
    `UPDATE events SET payload =
       json_remove(
         json_set(payload, '$.delivery', 'delivered', '$.delivered_at', ?, '$.delivered_via', ?),
         '$.error')
     WHERE id = ?`
  );
  for (const id of ids) q.run(ts, via, id);
}

export function resumeReviewForDeliveredSteers(
  db: DB,
  taskId: string,
  steers: QueuedSteer[],
  via: "respawn" | "drain"
): void {
  const task = getTask(db, taskId);
  if (!steers.length || task?.state !== "in_review") return;
  const lastSync = db
    .query("SELECT payload FROM events WHERE task_id = ? AND type = 'pr_synchronized' ORDER BY ts DESC LIMIT 1")
    .get(taskId) as { payload: string } | undefined;
  let head_sha: string | null = null;
  try {
    head_sha = lastSync ? (JSON.parse(lastSync.payload).head_sha ?? null) : null;
  } catch {
    head_sha = null;
  }
  writeEvent(db, {
    task_id: taskId,
    source: "system",
    type: "changes_requested",
    payload: {
      notes: steers.map((steer) => steer.message).join("\n\n"),
      delivered: true,
      head_sha,
      delivery_via: via,
    },
  });
  transition(db, taskId, "in_progress", { source: "system", reason: "queued agent work delivered" });
}

// Prepended to the respawn brief, above the task heading, so it is the first
// thing the fresh agent reads.
export function steerPreamble(steers: QueuedSteer[]): string {
  if (!steers.length) return "";
  return (
    "## Steers waiting for you\n" +
    "The director sent these while no agent was running. Action them as part of this task.\n\n" +
    steers.map((s, i) => `${i + 1}. ${s.message}`).join("\n") +
    "\n\n"
  );
}
