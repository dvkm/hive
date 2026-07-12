// Server-side notification queue + delivery policy.
//
// Notable events (a decision opened, a task done/failed, an incident opened, a
// task gone stale) enqueue a notification row. Delivery:
//   - `urgent` (high-risk open decision, incident) -> immediate macOS push.
//   - `normal` -> batched: startDigest() delivers ONE digest notification every
//     HIVE_DIGEST_MS summarizing counts ("3 done, 1 needs decision"). Never
//     per-event spam.
// `delivered_at` doubles as "David has been made aware" (push, digest, or by
// opening the header bell via POST /api/notifications/ack); the bell's unread
// count is the rows where delivered_at IS NULL.
import type { DB } from "./db.ts";
import { newId, now } from "./db.ts";
import { broadcast } from "./bus.ts";
import type { Exec } from "./exec.ts";

export type Urgency = "normal" | "urgent";

export interface NotifInput {
  kind: string; // decision | done | failed | incident | stale
  title: string;
  body?: string | null;
  urgency?: Urgency;
  task_id?: string | null;
  decision_id?: string | null;
}

// Module-level osascript sink. Off by default (null) so tests and the CLI never
// pop real notifications; the server turns it on with the real Exec (index.ts).
let notifier: Exec | null = null;
export function setNotifier(exec: Exec | null): void {
  notifier = exec;
}

async function osaNotify(exec: Exec, title: string, message: string): Promise<void> {
  try {
    const q = (s: string) => s.replace(/"/g, '\\"');
    await exec(["osascript", "-e", `display notification "${q(message)}" with title "${q(title)}"`]);
  } catch {
    /* non-fatal: osascript missing / not macOS */
  }
}

// Enqueue a notification: insert the row + SSE broadcast. Urgent notifications
// deliver immediately (marking delivered_at) via the configured exec; normal
// ones wait for the digest. `deps.exec` overrides the module notifier (tests).
export function enqueue(db: DB, n: NotifInput, deps: { exec?: Exec } = {}): any {
  const urgency: Urgency = n.urgency ?? "normal";
  const exec = deps.exec ?? notifier;
  const row = {
    id: newId("ntf"),
    ts: now(),
    kind: n.kind,
    task_id: n.task_id ?? null,
    decision_id: n.decision_id ?? null,
    title: n.title,
    body: n.body ?? null,
    urgency,
    delivered_at: urgency === "urgent" && exec ? now() : null,
  };
  db.query(
    "INSERT INTO notifications (id, ts, kind, task_id, decision_id, title, body, urgency, delivered_at) VALUES (?,?,?,?,?,?,?,?,?)"
  ).run(row.id, row.ts, row.kind, row.task_id, row.decision_id, row.title, row.body, row.urgency, row.delivered_at);
  broadcast({ type: "notification", notification: row });
  if (urgency === "urgent" && exec) void osaNotify(exec, n.title, n.body ?? "");
  return row;
}

const KIND_LABEL: Record<string, string> = {
  decision: "needs decision",
  done: "done",
  failed: "failed",
  incident: "incident",
  stale: "stale",
  answer: "answered",
};

// "2 done, 1 failed, 1 needs decision" — counts by kind, in enqueue order.
export function summarize(rows: { kind: string }[]): string {
  const order: string[] = [];
  const counts: Record<string, number> = {};
  for (const r of rows) {
    if (!(r.kind in counts)) order.push(r.kind);
    counts[r.kind] = (counts[r.kind] ?? 0) + 1;
  }
  return order.map((k) => `${counts[k]} ${KIND_LABEL[k] ?? k}`).join(", ");
}

export interface DigestDeps {
  exec?: Exec;
  now?: () => string; // injectable clock (tests)
}

// Deliver ONE digest for all pending normal notifications, then mark them
// delivered so they never repeat. No-op (delivered:false) when nothing pends.
export function runDigest(db: DB, deps: DigestDeps = {}): { delivered: boolean; count: number; summary: string } {
  const pending = db
    .query("SELECT id, kind FROM notifications WHERE urgency = 'normal' AND delivered_at IS NULL ORDER BY ts")
    .all() as { id: string; kind: string }[];
  if (pending.length === 0) return { delivered: false, count: 0, summary: "" };
  const summary = summarize(pending);
  const at = (deps.now ?? now)();
  const ids = pending.map((p) => p.id);
  db.query(
    `UPDATE notifications SET delivered_at = ? WHERE id IN (${ids.map(() => "?").join(",")})`
  ).run(at, ...ids);
  const exec = deps.exec ?? notifier;
  if (exec) void osaNotify(exec, "hive digest", summary);
  return { delivered: true, count: pending.length, summary };
}

// Mark undelivered notifications as seen (the header bell was opened). Returns
// how many were acked.
export function ackNotifications(db: DB): number {
  const r = db.query("UPDATE notifications SET delivered_at = ? WHERE delivered_at IS NULL").run(now());
  return r.changes;
}

// Background digest loop. Started only from index.ts (never in tests).
export function startDigest(db: DB, deps: DigestDeps & { intervalMs?: number } = {}): () => void {
  const intervalMs = deps.intervalMs ?? Number(process.env.HIVE_DIGEST_MS || 30 * 60 * 1000);
  const timer = setInterval(() => {
    try {
      runDigest(db, deps);
    } catch (e) {
      console.error("[hive] digest cycle failed:", e);
    }
  }, intervalMs);
  return () => clearInterval(timer);
}
