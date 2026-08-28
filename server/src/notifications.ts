// Server-side notification queue + delivery policy.
//
// Notable events (a decision opened, a task done/failed, an incident opened, a
// task gone stale) enqueue a notification row. Delivery:
//   - `urgent` (high-risk open decision, incident) -> immediate macOS push.
//   - `normal` -> batched: startDigest() delivers ONE digest notification every
//     HIVE_DIGEST_MS summarizing counts ("3 done, 1 needs decision"). Never
//     per-event spam.
// `delivered_at` doubles as "the director has been made aware" (push, digest, or by
// opening the header bell via POST /api/notifications/ack); the bell's unread
// count is the rows where delivered_at IS NULL.
import type { DB } from "./db.ts";
import { newId, now } from "./db.ts";
import { broadcast, appClientCount } from "./bus.ts";
import { pushToAll } from "./push.ts";
import type { PushPayload } from "./push.ts";
import type { Exec } from "./exec.ts";
import { notTestProjectSql } from "./testProjects.ts";
import { classOfKind, holdIfAway } from "./away.ts";
import type { PushClass } from "./away.ts";

export type Urgency = "normal" | "urgent";

export interface NotifInput {
  kind: string; // decision | done | failed | incident | stale
  title: string;
  body?: string | null;
  urgency?: Urgency;
  task_id?: string | null;
  decision_id?: string | null;
  // How this push is classified for away mode. Defaults from `kind` (see
  // away.ts). Set it explicitly when the kind alone does not say enough — a
  // security or spend alert must not be held overnight.
  class?: PushClass;
}

// Module-level desktop app sink. Off by default (null) so tests and the CLI never
// pop real notifications; the server turns it on with the real Exec (index.ts).
let notifier: Exec | null = null;
export function setNotifier(exec: Exec | null): void {
  notifier = exec;
}

// Where clicking a notification should land in the app. These are the same
// paths the web UI already uses, so a deeplink is just a normal route.
export function deeplinkPath(n: { kind?: string; task_id?: string | null; decision_id?: string | null }): string {
  // The catch-up digest is one pass over many tasks, so it opens the queue, not a task.
  if (n.kind === "quiz_digest") return "/inbox";
  if (n.decision_id) return `/decisions#dcard-${n.decision_id}`;
  if (n.task_id) return `/tasks/${n.task_id}`;
  return "/";
}

export function notificationLaunchArgv(
  url: string,
  platform: NodeJS.Platform = process.platform
): string[] {
  if (platform === "darwin") return ["open", "-g", "-b", "dev.hive.app", url];
  if (platform === "win32") return ["explorer.exe", url];
  return ["xdg-open", url];
}

// Cold-start path only: the desktop app is not attached to the stream, so hand
// the whole notification to the OS through a hive:// URL and let the registered
// desktop app render it.
async function launchAndNotify(exec: Exec, n: { id: string; title: string; body: string; path: string }): Promise<void> {
  try {
    const url = new URL("hive://notify");
    url.searchParams.set("id", n.id);
    url.searchParams.set("title", n.title);
    url.searchParams.set("body", n.body);
    url.searchParams.set("path", n.path);
    await exec(notificationLaunchArgv(url.toString()));
  } catch {
    /* non-fatal: desktop app missing or protocol not registered */
  }
}

// Deliver one native notification. The desktop app is the only thing that can
// raise one, so prefer the live SSE connection it already holds: no shell-out,
// no LaunchServices lookup, and the app confirms it rendered by POSTing
// /api/notifications/<id>/shown. With no app attached, fall back to launching
// it through the hive:// scheme.
export function deliverNative(n: { id: string; title: string; body?: string | null; path: string }, exec: Exec | null): "stream" | "launch" | "none" {
  const msg = { type: "notify", id: n.id, title: n.title, body: n.body ?? "", path: n.path };
  if (appClientCount() > 0) {
    broadcast(msg);
    return "stream";
  }
  if (exec) {
    void launchAndNotify(exec, { id: n.id, title: n.title, body: n.body ?? "", path: n.path });
    return "launch";
  }
  return "none";
}

// A task under a test/ephemeral project (see testProjects.ts) never pushes a
// notification — no OS push, no digest entry, no bell count. That's the exact
// pain an agent's own live E2E run caused (task #1020): real notifications
// firing for scratch decisions/tasks it created by mistake.
function isTestProjectTask(db: DB, taskId: string): boolean {
  return !!db
    .query(`SELECT 1 FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = ? AND NOT ${notTestProjectSql("p.config")}`)
    .get(taskId);
}

// Enqueue a notification: insert the row + SSE broadcast. Urgent notifications
// deliver immediately as a native notification; normal ones wait for the
// digest. `deps.exec` overrides the module notifier (tests).
//
// An urgent row is NOT pre-marked delivered. `delivered_at` now means the
// desktop app told us it actually rendered the notification (or the digest ran,
// or the bell was opened). Before, the server stamped it the moment it shelled
// out, so a notification macOS never showed still counted as seen.
export function enqueue(db: DB, n: NotifInput, deps: { exec?: Exec; push?: typeof pushToAll } = {}): any {
  if (n.task_id && isTestProjectTask(db, n.task_id)) return null;
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
    delivered_at: null,
  };
  db.query(
    "INSERT INTO notifications (id, ts, kind, task_id, decision_id, title, body, urgency, delivered_at) VALUES (?,?,?,?,?,?,?,?,?)"
  ).run(row.id, row.ts, row.kind, row.task_id, row.decision_id, row.title, row.body, row.urgency, row.delivered_at);
  broadcast({ type: "notification", notification: row });
  const path = deeplinkPath(row);
  if (urgency === "urgent") {
    deliverNative({ id: row.id, title: row.title, body: row.body, path }, exec);
    // Urgent → also push to the phone (PWA web push). Best-effort, never throws.
    const payload: PushPayload = { title: n.title, body: n.body ?? null, url: path };
    if (n.decision_id) {
      const decision = db.query("SELECT title, options FROM decisions WHERE id = ? AND status = 'open'").get(n.decision_id) as
        | { title: string; options: string }
        | null;
      if (decision) {
        payload.title = decision.title;
        payload.decisionId = n.decision_id;
        try {
          payload.actions = (JSON.parse(decision.options || "[]") as { key?: unknown; label?: unknown }[])
            .filter((option) => typeof option.key === "string" && !!option.key && typeof option.label === "string" && !!option.label)
            .map((option) => ({ action: option.key as string, title: option.label as string }));
        } catch {
          payload.actions = [];
        }
      }
    }
    // Away mode holds low-urgency pushes and batches them into one summary
    // when it lifts. Classes in `always_through` still go out immediately.
    if (!holdIfAway(db, n.class ?? classOfKind(n.kind), payload)) {
      void (deps.push ?? pushToAll)(db, payload).catch(() => {});
    }
  }
  return row;
}

const KIND_LABEL: Record<string, string> = {
  decision: "needs decision",
  done: "done",
  failed: "failed",
  incident: "incident",
  stale: "stale",
  review: "in review",
  answer: "answered",
  auto_resume: "stopped mid-commitment",
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
  deliverNative({ id: `digest-${at}`, title: "hive digest", body: summary, path: "/inbox" }, deps.exec ?? notifier);
  return { delivered: true, count: pending.length, summary };
}

// The desktop app confirms it actually rendered a native notification. This is
// the only signal that a macOS notification really fired; a digest id (not a
// row) is accepted and ignored.
export function markShown(db: DB, id: string): boolean {
  const r = db.query("UPDATE notifications SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL").run(now(), id);
  return r.changes > 0;
}

// The app can also report that macOS REFUSED to render one. The common refusal
// is UNErrorDomain error 1 — notifications are switched off for hive — and it
// used to be invisible: the old path swallowed every error and marked the row
// delivered anyway. Keep the latest so `hive notify --test` can name the cause.
// ponytail: last-one-wins in memory, not a table. It only has to answer "why
// did the notification I just fired not appear?".
let lastError: { id: string; error: string; at: string } | null = null;
export function recordDeliveryError(id: string, error: string): void {
  lastError = { id, error, at: now() };
}
export function lastDeliveryError(): { id: string; error: string; at: string } | null {
  return lastError;
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
