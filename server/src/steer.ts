// Steer delivery receipts + queued redelivery.
//
// A steer to a task with no live agent used to vanish silently, so David
// re-sent the same message up to 3× (2026-07-09/10). Every steer now carries a
// delivery status on its own `steer` event payload:
//
//   delivered — herdr accepted it and the agent's pane got the Enter
//   queued    — nothing was live to receive it; the next spawn delivers it
//   failed    — the task is terminal, so no spawn will ever come
//
// The events table is the log of record — no side table, no migration. A queued
// steer is just a `steer` event whose payload says so, flipped to delivered when
// the respawn brief carries it.
import type { DB } from "./db.ts";
import { now } from "./db.ts";
import { writeEvent } from "./state.ts";

export type Delivery = "delivered" | "queued" | "failed";

// A programmatic steer recorded QUEUED without touching herdr (callers that
// have no Herdr handle: cost guardrails, decision-dismiss recovery). Payload
// shape matches internalSteer's queued path, so drainSteers delivers it to a
// live agent within a reconciler cycle and a respawn brief carries it otherwise.
export function queueSteerEvent(db: DB, taskId: string, message: string, reason: string): void {
  writeEvent(db, {
    task_id: taskId,
    source: "system",
    type: "steer",
    payload: { message, target: null, attachments: [], delivery: "queued", error: reason },
  });
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
