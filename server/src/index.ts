// hive daemon entrypoint. Bun.serve on 127.0.0.1:4700 (override HIVE_PORT).
import { openDb, defaultDbPath } from "./db.ts";
import { makeHandler, notifyManagerOfEvent, sweepManagerInboxes, wakeDueManagers } from "./api.ts";
import { startReconciler } from "./reconciler.ts";
import { startDispatcher } from "./dispatcher.ts";
import { startReaper } from "./reaper.ts";
import { checkAllMonitors } from "./monitors.ts";
import { startDigest, setNotifier } from "./notifications.ts";
import { startGchatPoll } from "./intake/gchat.ts";
import { startWatchers } from "./watch.ts";
import { startAutoReviewer } from "./reviewer.ts";
import { startPromoter } from "./promoter.ts";
import { setEventHook, setTerminalHook, expireOrphanedDecisions } from "./state.ts";
import { bootstrapAuthority } from "./authority.ts";
import { cleanupTask } from "./cleanup.ts";
import { herdr as defaultHerdr } from "./runtime/herdr.ts";
import { defaultExec } from "./exec.ts";

const port = Number(process.env.HIVE_PORT || 4700);
const dbPath = defaultDbPath();
const db = openDb(dbPath);
const handle = makeHandler(db, { supervise: true });

// First-run bootstrap: make sure the standing safety rules exist. Idempotent.
const seeded = bootstrapAuthority(db);
if (seeded) console.log(`[hive] bootstrapped ${seeded} standing authority rule(s)`);

// Backfill: expire any open decision whose task is already terminal (legacy
// orphans predating transition-time expiry). Idempotent.
const orphaned = expireOrphanedDecisions(db);
if (orphaned) console.log(`[hive] expired ${orphaned} orphaned open decision(s) on terminal tasks`);

// Mint the remote API token once (phones/tablets present it; loopback never
// needs it). Shown by `hive remote`.
{
  const { getSetting, setSetting } = await import("./db.ts");
  if (!getSetting(db, "api_token"))
    setSetting(db, "api_token", new Bun.CryptoHasher("sha256").update(crypto.randomUUID()).digest("hex").slice(0, 32));
}

// HIVE_BIND=0.0.0.0 exposes the server on the LAN (token-gated). Plain HTTP:
// fine for a home LAN or a Tailscale interface, not for untrusted networks.
const server = Bun.serve({
  hostname: process.env.HIVE_BIND || "127.0.0.1",
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
// Close the autonomous management loop: meaningful descendant events wake the
// chat supervisor that delegated the work, including after nested follow-ups.
setEventHook((db, event) => notifyManagerOfEvent(db, defaultHerdr, { supervise: true }, event));
sweepManagerInboxes(db, defaultHerdr, { supervise: true })
  .then((count) => {
    if (count) console.log(`[hive] woke ${count} project manager(s) for inbox sweep`);
  })
  .catch((e) => console.error("[hive] manager inbox sweep:", e));
const managerWakeMs = Number(process.env.HIVE_MANAGER_WAKE_MS || 30_000);
setInterval(() => {
  wakeDueManagers(db, defaultHerdr, { supervise: true }).catch((e) => console.error("[hive] scheduled manager wakeup:", e));
}, managerWakeMs);
const reapMs = Number(process.env.HIVE_REAP_MS || 300_000);
startReaper(db, { intervalMs: reapMs });

// Notification delivery: turn on the osascript sink (urgent -> immediate push)
// and start the batched digest loop (normal -> one digest every HIVE_DIGEST_MS).
setNotifier(defaultExec);
startDigest(db);

// Google Chat intake: poll allowlisted spaces (per-project config.gchat_spaces)
// and draft tasks from stakeholder messages. Hard no-op until configured.
startGchatPoll(db);

// Watchers: poll configured docs/pages (per-project config.watchers) and queue
// an act-on-change task carrying the diff. Hard no-op until configured.
startWatchers(db);

// Auto-reviewer: pre-review every task that reaches in_review (sonnet one-shot
// over the PR diff) and post the result onto the review card. Opt-out per
// project: config.auto_review = false.
startAutoReviewer(db);

// Continuous promotion evaluator: projects with config.promote {from, to} get
// an evaluation task queued whenever `from` moves ahead of `to`. No-op otherwise.
const promoteMs = Number(process.env.HIVE_PROMOTE_MS || 30 * 60 * 1000);
startPromoter(db, { intervalMs: promoteMs });

console.log(`[hive] server on http://${server.hostname}:${server.port}  db=${dbPath}`);
