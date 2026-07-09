// hive daemon entrypoint. Bun.serve on 127.0.0.1:4700 (override HIVE_PORT).
import { openDb, defaultDbPath } from "./db.ts";
import { makeHandler } from "./api.ts";
import { startReconciler } from "./reconciler.ts";
import { checkAllMonitors } from "./monitors.ts";
import { startDigest, setNotifier } from "./notifications.ts";
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
setInterval(() => {
  checkAllMonitors(db).catch((e) => console.error("[hive] monitor cycle crashed:", e));
}, monitorMs);

// Notification delivery: turn on the osascript sink (urgent -> immediate push)
// and start the batched digest loop (normal -> one digest every HIVE_DIGEST_MS).
setNotifier(defaultExec);
startDigest(db);

console.log(`[hive] server on http://${server.hostname}:${server.port}  db=${dbPath}`);
