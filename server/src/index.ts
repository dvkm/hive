// hive daemon entrypoint. Bun.serve on 127.0.0.1:4700 (override HIVE_PORT).
import { openDb, defaultDbPath } from "./db.ts";
import { makeHandler } from "./api.ts";
import { startReconciler } from "./reconciler.ts";
import { startDispatcher } from "./dispatcher.ts";
import { startReaper } from "./reaper.ts";
import { checkAllMonitors } from "./monitors.ts";
import { startDigest, setNotifier } from "./notifications.ts";
import { startGchatPoll } from "./intake/gchat.ts";
import { setTerminalHook } from "./state.ts";
import { cleanupTask } from "./cleanup.ts";
import { herdr as defaultHerdr } from "./runtime/herdr.ts";
import { defaultExec } from "./exec.ts";

const port = Number(process.env.HIVE_PORT || 4700);
const dbPath = defaultDbPath();
const db = openDb(dbPath);
const handle = makeHandler(db, { supervise: true });

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  idleTimeout: 0, // keep SSE connections open
  fetch: handle,
});

// Background supervision: coarse reconciler (herdr status + gh PR sync + stale
// flagging) and per-project URL monitors. Both are failure-isolated internally.
const reconcileMs = Number(process.env.HIVE_RECONCILE_MS || 60_000);
const monitorMs = Number(process.env.HIVE_MONITOR_MS || 60_000);
const staleMs = Number(process.env.HIVE_STALE_MS || 15 * 60 * 1000);
startReconciler(db, { intervalMs: reconcileMs, staleMs });

// Dispatcher: pick up `queued` tasks in auto-dispatch projects and spawn agents
// (opt-in per project; the reason web-UI tasks used to sit in Queued forever).
const dispatchMs = Number(process.env.HIVE_DISPATCH_MS || 30_000);
startDispatcher(db, { intervalMs: dispatchMs, supervise: true });
setInterval(() => {
  checkAllMonitors(db).catch((e) => console.error("[hive] monitor cycle crashed:", e));
}, monitorMs);

// Auto-cleanup of finished tasks: tear down worktree + herdr session the moment
// a task reaches done/cancelled, and a periodic reaper sweep as the backstop for
// anything skipped/missed. Both guard against losing unmerged/uncommitted work.
setTerminalHook((db, taskId) => {
  cleanupTask(db, defaultHerdr, taskId).catch((e) => console.error("[hive] auto-cleanup:", e));
});
const reapMs = Number(process.env.HIVE_REAP_MS || 300_000);
startReaper(db, { intervalMs: reapMs });

// Notification delivery: turn on the osascript sink (urgent -> immediate push)
// and start the batched digest loop (normal -> one digest every HIVE_DIGEST_MS).
setNotifier(defaultExec);
startDigest(db);

// Google Chat intake: poll allowlisted spaces (per-project config.gchat_spaces)
// and draft tasks from stakeholder messages. Hard no-op until configured.
startGchatPoll(db);

console.log(`[hive] server on http://${server.hostname}:${server.port}  db=${dbPath}`);
