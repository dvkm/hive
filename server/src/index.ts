// hive daemon entrypoint. Bun.serve on 127.0.0.1:4700 (override HIVE_PORT).
// INCIDENT HOTFIX 2026-08-25 (task 4917e8ecd667): an unhandled async rejection
// escaping a spawned subprocess (gh ENOENT via exec.ts) exits the Bun process,
// crash-looping the server under launchd. Log and survive instead; the error
// streak machinery already surfaces degradation in /api/health. Applied
// straight to the live checkout during the incident; carried onto main here so
// the next deploy does not silently drop it.
process.on("unhandledRejection", (e) => {
  console.error("[hive] unhandledRejection (survived):", e);
});
import { openDb, defaultDbPath } from "./db.ts";
import { makeHandler, keepSupervisorWarm, notifyManagerOfEvent, repairDuplicateQuizPasses, sweepManagerInboxes, wakeDueManagers } from "./api.ts";
import { startReconciler, reAdoptAgentsOnBoot } from "./reconciler.ts";
import { startDispatcher } from "./dispatcher.ts";
import { startReaper } from "./reaper.ts";
import { checkAllMonitors } from "./monitors.ts";
import { startDigest, setNotifier } from "./notifications.ts";
import { startGchatPoll } from "./intake/gchat.ts";
import { startJiraSync } from "./intake/jira.ts";
import { startWatchers } from "./watch.ts";
import { startAutoReviewer } from "./reviewer.ts";
import { startDriftWatch } from "./drift.ts";
import { startPromoter } from "./promoter.ts";
import { selfAuditOnce, startSelfAudit } from "./selfAudit.ts";
import { followServingBranchOnBoot } from "./servingBranch.ts";
import { setEventHook, setTerminalHook, expireOrphanedDecisions, repairRequeueProvenance, backfillStuckPrUrls, advanceReadyJiraMirrors } from "./state.ts";
import { bootstrapAuthority } from "./authority.ts";
import { cleanupTask } from "./cleanup.ts";
import { herdr as defaultHerdr } from "./runtime/herdr.ts";
import { defaultExec } from "./exec.ts";
import { claimLease, startLease, holdsLease, interloperReason, interloperAdvice, registerInstance, unregisterInstance, evictContenders, LEASE_MS } from "./lease.ts";
import { enqueue } from "./notifications.ts";
import { setSetting, now } from "./db.ts";

const port = Number(process.env.HIVE_PORT || 4700);
const dbPath = defaultDbPath();
const db = openDb(dbPath);

// Refuse to be the second server on the live fleet database. A custom port with
// the default DB is the signature of a throwaway/test server that forgot
// HIVE_DB, and one of those ran reconciler laps against the live fleet for 25
// minutes on 2026-08-19, evicting working agents until a human killed it by
// hand. Exiting HERE means no listener, no lease, no loops — nothing of this
// process ever touches the fleet. Set HIVE_ALLOW_SHARED_DB=1 to override.
{
  const reason = interloperReason(dbPath, port);
  if (reason) {
    console.error(`[hive] REFUSING TO START: ${reason}.`);
    console.error(`[hive] ${interloperAdvice(port)}`);
    // One card per incident, not per retry: a refused server under a supervisor
    // (launchd, `bun --watch`) relaunches on a loop and would otherwise fill the
    // tray with the same sentence.
    const recent = db
      .query("SELECT 1 FROM notifications WHERE kind = 'server_refused' AND ts > datetime('now', '-10 minutes') LIMIT 1")
      .get();
    if (!recent)
      enqueue(db, {
        kind: "server_refused",
        urgency: "normal",
        title: "Blocked a second hive server on the live database",
        body: `Something started a hive server on port ${port} against the fleet DB. It was refused and nothing was touched. ${interloperAdvice(port)}`,
      });
    process.exit(1);
  }
}

const carriedQuizPasses = repairDuplicateQuizPasses(db);
if (carriedQuizPasses) console.log(`[hive] preserved ${carriedQuizPasses} completed quiz pass(es) across duplicate reviews`);
const handle = makeHandler(db, { supervise: true });

// First-run bootstrap: make sure the standing safety rules exist. Idempotent.
const seeded = bootstrapAuthority(db);
if (seeded) console.log(`[hive] bootstrapped ${seeded} standing authority rule(s)`);

// Backfill: expire any open decision whose task is already terminal (legacy
// orphans predating transition-time expiry). Idempotent.
const orphaned = expireOrphanedDecisions(db);
if (orphaned) console.log(`[hive] expired ${orphaned} orphaned open decision(s) on terminal tasks`);

// Backfill/backstop: verify (or quarantine) any requeue row whose lineage
// hasn't been checked yet — legacy rows predating provenance tracking, or
// ones interrupted mid-check by a restart. Idempotent (repairRequeueProvenance
// only ever rescans unverified rows).
const quarantinedRequeues = repairRequeueProvenance(db);
if (quarantinedRequeues) console.log(`[hive] quarantined ${quarantinedRequeues} requeue task(s) with unverifiable provenance`);

// Backfill: link pr_url for tasks already stuck in in_review whose PR URL only
// ever landed as free text in a state_change reason (hive-1717). Idempotent.
const backfilledPrUrls = backfillStuckPrUrls(db);
if (backfilledPrUrls) console.log(`[hive] backfilled pr_url for ${backfilledPrUrls} stuck in_review task(s)`);

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

// Single-writer lease. Claimed only now that the listener is up, so a server
// that cannot even bind never evicts a healthy one. Newest wins: any predecessor
// still running against this DB (including a `bun --watch` worker that survived
// a launchctl kickstart by re-parenting to launchd — 2026-08-19, four of them,
// none holding the port) sees the lease change on its next heartbeat and exits.
const { instance, displaced } = claimLease(db);
  // Register BEFORE any loop starts: this row is how a future lease holder can
  // find and terminate this process if it ever stops standing down on its own.
  registerInstance(db, instance, process.pid, port);
  if (displaced)
    console.warn(
      `[hive] took the DB lease from a previous server (instance=${displaced.instance} pid=${displaced.pid} at=${displaced.at}); it will stand down within one heartbeat`
    );
  startLease(db, instance, (holder) => {
    console.error(`[hive] DB lease lost to instance=${holder?.instance ?? "?"} pid=${holder?.pid ?? "?"}; standing down so only one server runs the loops`);
    unregisterInstance(db, instance);
    process.exit(0);
  });
  process.on("exit", () => {
    try {
      unregisterInstance(db, instance);
    } catch {
      /* the DB may already be closed; the next holder drops the row anyway */
    }
  });

  // Enforcement: asking a predecessor to stand down does not reach one that is
  // wedged, or a `bun --watch` worker orphaned by a launchctl kickstart. Kill
  // what is still attached, and tell the director — an eviction is never
  // routine, and the director used to have to do it by hand.
  setInterval(() => {
    if (!holdsLease(db, instance)) return; // we are the one on the way out
    for (const { contender, signal } of evictContenders(db, instance)) {
      console.warn(`[hive] evicted a second server: pid=${contender.pid} port=${contender.port} instance=${contender.instance} (${signal})`);
      if (signal !== "SIGTERM") continue; // the SIGKILL escalation is automatic; one card is enough
      enqueue(db, {
        kind: "server_evicted",
        urgency: "normal",
        title: "Evicted a second hive server from the fleet database",
        body: `A second server (pid ${contender.pid}, port ${contender.port}) was still running loops against the fleet DB after losing the lease. Hive terminated it — nothing for you to do.`,
      });
    }
  }, LEASE_MS);

// Boot stamp: the teardown guard reads it so nothing is failed, requeued or
// reaped in the first minutes after a restart/self-deploy, when herdr's agent
// registry may still be cold and every live agent probes as gone.
setSetting(db, "server_started_at", now());

// Whatever landed while this server was down has not reached its checkout yet.
// Bring the serving checkout up to the base branch before the loops start, so
// boot runs the code that actually landed. (`bun --watch` reloads on the merge.)
followServingBranchOnBoot(db).catch((e) => console.error("[hive] serving-branch follow on boot:", e));

// Background supervision: coarse reconciler (herdr status + gh PR sync + stale
// flagging) and per-project URL monitors. Both are failure-isolated internally.
const reconcileMs = Number(process.env.HIVE_RECONCILE_MS || 60_000);
const monitorMs = Number(process.env.HIVE_MONITOR_MS || 60_000);
const staleMs = Number(process.env.HIVE_STALE_MS || 15 * 60 * 1000);
// Re-adopt every live agent BEFORE the first reconcile lap, so a restart never
// leaves an agent unaddressable (herdr keeps the panes; hive just lost the
// registration). Fire-and-forget: it must not delay the loops, and boot grace
// already holds teardown while it runs.
reAdoptAgentsOnBoot(db, { supervise: true }).catch((e) => console.error("[hive] boot re-adopt:", e));

startReconciler(db, { intervalMs: reconcileMs, staleMs, supervise: true, instanceId: instance });

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
// The same hook keeps a still-open thread's session warm when syncAgents
// observes it die, so the next director message doesn't pay the cold start.
setEventHook((db, event) => {
  notifyManagerOfEvent(db, defaultHerdr, { supervise: true }, event);
  keepSupervisorWarm(db, defaultHerdr, { supervise: true }, event);
});
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
startReaper(db, { intervalMs: reapMs, instanceId: instance });

// Notification delivery: hand alerts to hive.app (urgent -> immediate push)
// and start the batched digest loop (normal -> one digest every HIVE_DIGEST_MS).
setNotifier(defaultExec);
startDigest(db);

// Google Chat intake: poll allowlisted spaces (per-project config.gchat_spaces)
// and draft tasks from stakeholder messages. Hard no-op until configured.
startGchatPoll(db);

// Watchers: poll configured docs/pages (per-project config.watchers) and queue
// an act-on-change task carrying the diff. Hard no-op until configured.
startWatchers(db);

// JIRA sync: mirror a Jira project's issues onto the board and keep `status`,
// comments, and hive's own reports/evidence in step (per-project config.jira).
// Hard no-op until a project sets enabled:true, and a second gate (write:false)
// keeps it read-only until the director has read a shadow cycle.
startJiraSync(db);
// Mirrors whose work finished while this server was down (and every ticket
// shipped before the link existed) are advanced once, here — the same rule the
// live path uses, so it closes nothing the live path would not have (HIVE-546).
try {
  const advanced = advanceReadyJiraMirrors(db);
  if (advanced) console.log(`[hive] advanced ${advanced} jira mirror(s) whose linked work is done`);
} catch (e) {
  console.error("[hive] jira mirror catch-up:", e);
}

// Auto-reviewer: pre-review every task that reaches in_review (sonnet one-shot
// over the PR diff) and post the result onto the review card. Opt-out per
// project: config.auto_review = false.
startAutoReviewer(db);
// In-run scope-drift watch: compares each live branch's accumulated footprint
// against its brief every few commits, so a run that grows past what was asked
// raises a card while trimming is still cheap (#1001).
startDriftWatch(db);

// Continuous promotion evaluator: projects with config.promote {from, to} get
// an evaluation task queued whenever `from` moves ahead of `to`. No-op otherwise.
const promoteMs = Number(process.env.HIVE_PROMOTE_MS || 30 * 60 * 1000);
startPromoter(db, { intervalMs: promoteMs });

// Hive audits its own recent trajectories and usage weekly, then sends one
// evidence-backed improvement through the same guarded ship path as other work.
try {
  selfAuditOnce(db);
} catch (e) {
  console.error("[hive] self-audit boot attempt failed; hourly loop will retry:", e);
}
const selfAuditPollMs = Number(process.env.HIVE_SELF_AUDIT_POLL_MS || 60 * 60 * 1000);
startSelfAudit(db, selfAuditPollMs);

console.log(`[hive] server on http://${server.hostname}:${server.port}  db=${dbPath}`);
