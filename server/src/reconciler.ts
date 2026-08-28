// Coarse time-based reconciler: the fallback to the event-driven paths (herdr
// waits + Claude Code hooks). Every cycle it (1) syncs herdr agent status for
// tasks with an agent_target, (2) syncs CI/merge state via `gh pr view` for
// tasks with a pr_url, (3) flags tasks silent beyond a threshold as `stale`.
//
// Guard: a reconciler failure must never crash the server. Each sub-step is
// isolated; the whole cycle is wrapped, and at most one `reconciler_error`
// signal is broadcast per cycle.
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import type { DB } from "./db.ts";
import { now, newId, evidenceDir, isOffline, setSetting, getSetting } from "./db.ts";
import { broadcast } from "./bus.ts";
import { startLoop } from "./loop.ts";
import { writeEvent, transition, getTask, advanceIfFinished, unmetDeps, noteDependencyBlock, isDeferred, undeferTask, isTrackingOnlyTask, queuedInputRecoveryPending, repairRequeueProvenance, TERMINAL, type State } from "./state.ts";
import { Herdr, herdr as defaultHerdr, sendFailure, type AgentStatus } from "./runtime/herdr.ts";
import { spawnMeta } from "./cleanup.ts";
import { queuedSteers, markSteersDelivered, queueSteerEvent, resumeReviewForDeliveredSteers } from "./steer.ts";
import { inBackoff, isReviewed, MAX_AGENTS_DEFAULT } from "./dispatcher.ts";
import { smokeThenAdvance, type MonitorDeps } from "./monitors.ts";
import { enqueue } from "./notifications.ts";
import { parseEvidence } from "./rows.ts";
import { broadcastTask, noteToolStart } from "./health.ts";
import { supervisedSql, neverDispatched, isJiraMirror } from "./supervision.ts";
import { notTestProjectSql } from "./testProjects.ts";
import { recordSystemLearning, captureRecurringRefs } from "./learn.ts";
import { diagnosePane, dialogAutoApprovable, editDialogPaths, parseResetClock } from "./diagnose.ts";
import { AUTO_MERGE_PAUSED, requeueTask, openRecoveryDecision, openBreakerDecision, linkPrIfMarked, handOffToReview, createDecision, mergeTask, apiAnswerDecision, apiDismissDecision, spawnAgent, internalSteer, pendingPostShipQuizCount } from "./api.ts";
import { teardownBlocked, recentDeadVerdicts, DEAD_BURST_N, DEAD_BURST_MS } from "./teardownGuard.ts";
import type { Exec } from "./exec.ts";
import { defaultExec, mapLimit, projectBaseBranch, preferSafeRef } from "./exec.ts";
import { captureBranchScope } from "./rebaseGuard.ts";
import { landOnce } from "./landQueue.ts";
import { sidecarOnce } from "./sidecar.ts";
import { classifyEscalation, optionNeedsDirectorInput } from "./policy.ts";
import { runPrGardener } from "./prGardener.ts";
import { autoAckPlans } from "./planCritic.ts";
import { ambiguityCleared, cautionCleared, latestAutoReviewVerdict } from "./reviewer.ts";

const NON_TERMINAL = "('queued','in_progress','needs_decision','in_review','verifying')";
const RECOVERABLE = "('in_progress','needs_decision','in_review','verifying')";
// Auto-requeue at most twice on repeated agent death, then escalate to a card.
const MAX_AUTO_REQUEUE = 2;
// Nudge an alive-but-silent agent up to 3 times, then escalate to a card.
const MAX_SILENT_NUDGES = 3;
const DEFAULT_FAILED_TRIAGE_REQUEUE_HOURS = 4;
const TURN_COMPLETE_RESPAWN = "agent turn is complete; respawn required";
// `gh pr view` is a poll: if GitHub is slow this cycle, the next cycle retries in
// a minute anyway, so waiting the 60s defaultExec default just stalls the lap.
const GH_PROBE_TIMEOUT_MS = 12_000;
// ponytail: a flat cap, not per-project. Enough to hide a few stalls without
// forking a `gh` process per open PR.
const GH_PROBE_CONCURRENCY = 6;

export interface ReconcilerDeps {
  herdr?: Herdr;
  exec?: Exec; // for `gh`
  staleMs?: number; // default 15m
  smoke?: MonitorDeps; // deps for smokeThenAdvance on merge->verifying
  nowMs?: () => number; // injectable clock (tests)
  supervise?: boolean; // start the herdr push-wait loop on agents this loop spawns
  instanceId?: string; // this server's lease instance; a displaced server must not reap
}

const DEFAULT_STALE_MS = 15 * 60 * 1000;

function isTrackingOnlyId(db: DB, id: string): boolean {
  const task = getTask(db, id);
  return !!task && isTrackingOnlyTask(task);
}

// The task the reconciler is mid-way through acting on may have moved to a
// different PR (or a terminal state) while an `await exec` for the OLD PR was
// in flight — a replacement `ready` emit, a concurrent POST /merge, or
// another reconcile cycle. Re-checking this before every transition/write
// keeps a slow gh probe for a since-replaced PR from mutating the task that
// replaced it (task HIVE-307).
function currentPrTask(db: DB, task: { id: string; pr_url: string }): any | null {
  const current = getTask(db, task.id);
  if (!current || TERMINAL.includes(current.state as State) || current.pr_url !== task.pr_url) return null;
  return current;
}

function isJiraMirrorId(db: DB, id: string): boolean {
  const task = getTask(db, id);
  return !!task && isJiraMirror(task);
}

function agentWorkComplete(db: DB, task: any): boolean {
  if (TERMINAL.includes(task.state as State) || task.state === "in_review" || task.state === "verifying") return true;
  if (db.query("SELECT 1 FROM events WHERE task_id = ? AND type = 'state_change' AND json_extract(payload, '$.to') = 'in_review' LIMIT 1").get(task.id)) return true;
  if (!task.pr_url) return false;
  const parentId = task.pr_url === task.resume_pr_url && task.parent_task_id ? task.parent_task_id : task.id;
  const outcome = db
    .query("SELECT type FROM events WHERE task_id IN (?, ?) AND type IN ('pr_closed','pr_merged','merged') AND json_extract(payload, '$.pr_url') = ? ORDER BY rowid DESC LIMIT 1")
    .get(task.id, parentId, task.pr_url) as { type: string } | undefined;
  return task.pr_state === "MERGED" || (task.pr_state !== "CLOSED" && outcome?.type !== "pr_closed");
}

export async function reconcileOnce(db: DB, deps: ReconcilerDeps = {}): Promise<void> {
  const startedAt = Date.now();
  let errored = false;
  let steps = 0;
  let errors = 0;
  let lastError: string | null = null;
  const fail = (where: string, e: unknown) => {
    errors++;
    lastError = `${where}: ${String((e as any)?.message ?? e)}`;
    if (!errored) {
      errored = true;
      console.error(`[hive] reconciler ${where}:`, e);
      broadcast({ type: "reconciler_error", error: String((e as any)?.message ?? e), where });
    }
  };
  // Runs one labeled sub-step, isolated so a failure never stops the rest of
  // the cycle; counts toward the run-summary log below.
  const step = async (where: string, fn: () => unknown) => {
    steps++;
    try {
      await fn();
    } catch (e) {
      fail(where, e);
    }
  };
  const logRun = (outcome: string) => {
    console.log(`[hive] reconciler run: duration_ms=${Date.now() - startedAt} steps=${steps} errors=${errors} outcome=${outcome}`);
  };
  // Liveness + failure heartbeat for /api/health (task #1096: `gh` ENOENT under
  // linkPRs made every cycle error for ~27min with zero outward signal — /health
  // stayed ok:true the whole time). Written on every return path below, success
  // or error, so /health can tell "loop finished" apart from "loop wedged
  // mid-cycle" (same distinction dispatcher/reaper already make). The error
  // streak resets on any clean cycle, so a single blip doesn't linger.
  const heartbeat = () => {
    setSetting(db, "last_reconcile_at", now());
    if (errors > 0) {
      const streak = Number(getSetting(db, "reconciler_error_streak") ?? "0") + 1;
      setSetting(db, "reconciler_error_streak", String(streak));
      if (lastError) setSetting(db, "reconciler_last_error", lastError);
    } else {
      setSetting(db, "reconciler_error_streak", "0");
    }
  };
  await step("surfaceTrackingBindings", () => surfaceTrackingBindings(db));
  await step("syncAgents", () => syncAgents(db, deps));
  await step("drainSteers", () => drainSteers(db, deps));
  await step("advanceFinished", () => advanceFinished(db, deps));
  await step("nagOpenDecisions", () => nagOpenDecisions(db, (deps.nowMs ?? (() => Date.now()))()));
  await step("unparkAnswered", () => unparkAnswered(db, (deps.nowMs ?? (() => Date.now()))()));
  // Away-mode release valve: a plan the director never acked frees its agent
  // after the project's plan_gate.auto_ack_hours. Local (herdr + sqlite), so it
  // sits above the offline cutoff — an offline director is exactly the case it
  // exists for.
  await step("autoAckPlans", () =>
    autoAckPlans(db, {
      steer: (id, message) => internalSteer(db, deps.herdr ?? defaultHerdr, id, message),
      nowMs: (deps.nowMs ?? (() => Date.now()))(),
    })
  );
  await step("remindUnreviewedIntake", () => remindUnreviewedIntake(db, (deps.nowMs ?? (() => Date.now()))()));
  await step("notifyQuizDigest", () => notifyQuizDigest(db, (deps.nowMs ?? (() => Date.now()))()));
  await step("captureRecurringRefs", () => captureRecurringRefs(db));
  await step("repairRequeueProvenance", () => repairRequeueProvenance(db));
  await step("surfaceDeadDependencies", () => surfaceDeadDependencies(db));
  // Offline mode: everything above is local (herdr + sqlite) and keeps state
  // honest; everything below either needs the network (gh) or would punish
  // agents for being offline (stale flags, nudges, failure escalation). Stop here.
  if (isOffline(db)) {
    logRun("offline");
    heartbeat();
    return;
  }
  await step("syncPRs", () => syncPRs(db, deps));
  await step("revalidateCiDecisions", () => revalidateCiDecisions(db));
  await step("linkPRs", () => linkPRs(db, deps));
  await step("prGardener", () => runPrGardener(db, {
    exec: deps.exec ?? defaultExec,
    nowMs: deps.nowMs,
    land: async (taskId) => {
      const response = await mergeTask(db, deps.herdr ?? defaultHerdr, taskId, { actor: "pr-gardener" }, { exec: deps.exec });
      if (response.ok) return { ok: true };
      const body = await response.json().catch(() => ({})) as any;
      return { ok: false, error: body.error ?? `HTTP ${response.status}` };
    },
    directorDeciding: (taskId) => passedByDirector(db, taskId),
    decide: (input) => createDecision(db, input),
  }));
  await step("resumeUsageLimited", () => resumeUsageLimited(db, (deps.nowMs ?? (() => Date.now()))()));
  await step("requeueStaleFailed", () => requeueStaleFailed(db, (deps.nowMs ?? (() => Date.now()))()));
  await step("flagStale", () => flagStale(db, deps));
  await step("recoverStale", () => recoverStale(db, deps));
  await step("sweepVerifying", () => sweepVerifying(db, deps));
  await step("autoMergeReady", () => autoMergeReady(db, deps));
  await step("landOnce", () => landOnce(db, { exec: deps.exec }));
  // Started, not awaited: sidecar checks can take minutes, and the rest of
  // the cycle (plus the health heartbeat below) must not wait on them. It
  // single-flights internally, so a still-running pass just skips this cycle.
  await step("sidecar", () => {
    void sidecarOnce(db, { exec: deps.exec });
  });
  await step("autoAnswerStale", () => autoAnswerStale(db, deps.herdr ?? defaultHerdr, (deps.nowMs ?? (() => Date.now()))()));
  logRun(errors > 0 ? "error" : "ok");
  heartbeat();
}

export function surfaceDeadDependencies(db: DB): void {
  const tasks = db.query("SELECT id FROM tasks WHERE state = 'queued' AND depends_on IS NOT NULL").all() as { id: string }[];
  for (const { id } of tasks) {
    const task = getTask(db, id);
    const blocking = unmetDeps(db, task);
    if (!blocking.length || !blocking.every((dep) => TERMINAL.includes(dep.state as State))) continue;
    const blockingTaskIds = blocking.map((dep) => dep.id).sort();
    const last = db.query("SELECT payload FROM events WHERE task_id = ? AND type = 'dead_dependencies' ORDER BY ts DESC, rowid DESC LIMIT 1").get(id) as { payload: string } | undefined;
    if (last) {
      const previous = JSON.parse(last.payload).blocking_task_ids;
      if (Array.isArray(previous) && JSON.stringify(previous.sort()) === JSON.stringify(blockingTaskIds)) continue;
    }
    writeEvent(db, {
      task_id: id,
      source: "reconciler",
      type: "dead_dependencies",
      payload: {
        note: `This queued task cannot start because every blocking dependency ended without completing: ${blocking.map((dep) => `#${dep.number} ${dep.title} (${dep.state})`).join(", ")}.`,
        blocking_task_ids: blockingTaskIds,
      },
    });
    broadcastTask(db, getTask(db, id));
  }
}

export function surfaceTrackingBindings(db: DB): void {
  const tasks = db
    .query("SELECT id, number, title, source, source_ref, agent_target, worktree_path, branch FROM tasks WHERE agent_target IS NOT NULL OR worktree_path IS NOT NULL OR branch IS NOT NULL")
    .all() as any[];
  for (const task of tasks) {
    if (!isTrackingOnlyTask(task)) continue;
    if (db.query("SELECT 1 FROM events WHERE task_id = ? AND type = 'tracking_binding_detected' LIMIT 1").get(task.id))
      continue;
    const location = task.worktree_path ?? task.branch ?? task.agent_target ?? "unknown binding";
    writeEvent(db, {
      task_id: task.id,
      source: "reconciler",
      type: "tracking_binding_detected",
      payload: {
        note: `Legacy Hive work is still attached at ${location}. Inspect it before cancelling; terminal tasks can then use the cleanup action.`,
        agent_target: task.agent_target,
        worktree_path: task.worktree_path,
        branch: task.branch,
      },
    });
    enqueue(db, {
      kind: "tracking_binding",
      urgency: "urgent",
      task_id: task.id,
      title: `Legacy Hive work attached to tracking-only task #${task.number}: ${task.title}`,
      body: `Inspect ${location} before cancelling the task, then run cleanup once it is terminal. The binding was preserved.`,
    });
  }
}

// ---- proactive boot re-adoption ----
// probeAgent already re-registers a live-but-unregistered pane (readopt), but
// that only runs on the reconciler's 60s lap — after a server restart an agent
// sits unaddressable for up to a full lap, which is exactly when the fleet looks
// dead. Drive ONE immediate pass at boot so a restart is transparent from t=0.
// It only probes/readopts: it never fails or requeues, and teardown stays gated
// by boot grace + the breaker, so it is safe to run before the loops start.
export async function reAdoptAgentsOnBoot(db: DB, deps: ReconcilerDeps = {}): Promise<{ probed: number; readopted: number }> {
  const h = deps.herdr ?? defaultHerdr;
  const tasks = db
    .query(`SELECT id, agent_target FROM tasks WHERE agent_target IS NOT NULL AND state IN ${NON_TERMINAL}`)
    .all() as { id: string; agent_target: string }[];
  const countReadopts = (taskId: string) =>
    (db.query("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = 'readopted'").get(taskId) as { n: number }).n;
  let probed = 0;
  let readopted = 0;
  for (const t of tasks) {
    if (isJiraMirrorId(db, t.id)) continue;
    probed++;
    const before = countReadopts(t.id);
    try {
      await probeAgent(h, db, t.id, t.agent_target); // re-registers a live pane; writes a `readopted` event
    } catch (e) {
      console.error(`[hive] boot re-adopt ${t.id}:`, e);
      continue;
    }
    if (countReadopts(t.id) > before) readopted++;
  }
  if (probed) console.log(`[hive] boot re-adopt: probed ${probed} agent-bearing task(s), re-adopted ${readopted}`);
  return { probed, readopted };
}

// ---- agent status sync ----
// Probe every agent-bearing task. A vanished agent is recorded as status
// `gone` (so health can show "dead" within one cycle); a live status change is
// recorded as before. Recording is change-gated so the timeline never spams.
async function syncAgents(db: DB, deps: ReconcilerDeps): Promise<void> {
  const h = deps.herdr ?? defaultHerdr;
  const tasks = db
    .query(`SELECT id, agent_target FROM tasks WHERE agent_target IS NOT NULL AND state IN ${NON_TERMINAL}`)
    .all() as { id: string; agent_target: string }[];
  for (const t of tasks) {
    if (isJiraMirrorId(db, t.id)) continue;
    const { alive, status, unconfirmed } = await probeAgent(h, db, t.id, t.agent_target);
    if (unconfirmed) {
      noteUnconfirmedDeath(db, t.id);
      continue; // herdr can't resolve it and its pane is still there: touch nothing
    }
    const next = alive ? status : "gone";
    if (next === "unknown") continue; // couldn't determine; leave prior status intact
    if (next !== lastAgentStatus(db, t.id)) {
      writeEvent(db, { task_id: t.id, source: "herdr", type: "agent_status", payload: { status: next } });
      broadcastTask(db, getTask(db, t.id)); // health may have flipped (blocked / gone)
    }
    // React to dialogs EVERY cycle, not just on a status transition. Claude's
    // startup trust dialog reports `idle`, auto-mode setup reports `done`, and
    // tool permission dialogs report `blocked`. Idempotent: a handled dialog
    // disappears from the pane.
    let handledDialog = false;
    if (next === "blocked" || next === "idle" || next === "done") {
      try {
        handledDialog = await handleBlockedAgent(db, h, t.id, t.agent_target);
      } catch (e) {
        console.error(`[hive] handleBlockedAgent ${t.id}:`, e);
      }
    }
    // A completed interactive turn cannot consume another submission. If one
    // is waiting, release only the terminal session, keep the branch/worktree,
    // and let the dispatcher's existing reattach pass start a fresh turn with
    // the queued steer in its brief. A handled startup dialog gets one cycle to
    // change status instead of being mistaken for a completed turn.
    if (next === "done" && !handledDialog && queuedSteers(db, t.id).length) {
      const task = getTask(db, t.id);
      const meta = spawnMeta(db, t.id);
      const session = await h.closeSession({
        agentTarget: t.agent_target,
        tabId: meta.tab_id,
        expectTerminalId: meta.terminal_id,
        expectCwd: task?.worktree_path,
        request: { caller: "reconciler.reconcileOnce", reason: "completed turn has queued steer", taskId: t.id },
      });
      if (!session.closed) continue;
      if (meta.workspace_id && task?.worktree_path) await h.closeWorkspace({
        workspaceId: meta.workspace_id,
        expectCwd: task.worktree_path,
        request: { caller: "reconciler.reconcileOnce", reason: "completed turn has queued steer", taskId: t.id },
      });
      db.query("UPDATE tasks SET agent_target = NULL, updated_at = ? WHERE id = ?").run(now(), t.id);
      writeEvent(db, {
        task_id: t.id,
        source: "reconciler",
        type: "agent_released",
        payload: { reason: "completed turn has queued steer", branch: task?.branch, worktree_path: task?.worktree_path },
      });
      broadcastTask(db, getTask(db, t.id));
    }
  }
}

// Probe an agent, but never report DEAD without positive evidence. herdr's
// `agent get` answers agent_not_found for an agent whose registration was lost
// (a desktop-app restart wipes the registry; the panes and the claude processes
// in them survive) — indistinguishable, from the probe alone, from a real
// death. Herdr.confirmGone cross-checks the pane list; an unconfirmed death
// degrades to alive+unknown, which every caller already treats as "leave it
// alone" (2026-08-19 incident: 12+ live agents failed and their tabs closed).
export async function probeAgent(
  h: Herdr,
  db: DB,
  taskId: string,
  target: string
): Promise<{ alive: boolean; status: AgentStatus; unconfirmed?: boolean }> {
  const p = await h.probe(target);
  if (p.alive) return p;
  // A server takeover can briefly make `agent get` miss an agent that is
  // already present in herdr's live registry. Trust the fleet snapshot before
  // consulting pane absence, which can otherwise turn that startup race into
  // a false death verdict.
  if ((await h.listAgents()).some((agent) => agent.name === target))
    return { alive: true, status: "unknown" };
  const task = getTask(db, taskId);
  const meta = spawnMeta(db, taskId);
  const hint = { cwd: task?.worktree_path ?? null, tabId: meta.tab_id, terminalId: meta.terminal_id };
  const gone = await h.confirmGone(hint);
  if (gone) return p;
  // Alive but unregistered. Don't just leave it alone — REGISTER IT BACK, so
  // steers, dialog handling and status all work again on an agent that never
  // stopped working. Everything downstream keeps addressing it by agent_target.
  const re = await h.readopt({ name: target, ...hint });
  if (re.readopted) {
    writeEvent(db, {
      task_id: taskId,
      source: "reconciler",
      type: "readopted",
      payload: { agent_target: target, pane_id: re.paneId, terminal_id: re.terminalId, reason: re.reason },
    });
    const again = await h.probe(target);
    if (again.alive) return again;
  }
  return { alive: true, status: "unknown", unconfirmed: true };
}

// Unregistered-but-running (or herdr unreachable): log it — which also resets
// the task's silence clock, so the next look is a stale threshold away — and
// after a few laps put it in front of the director instead of guessing. Never
// tears anything down.
const MAX_UNCONFIRMED_DEATHS = 3;

function noteUnconfirmedDeath(db: DB, taskId: string): void {
  const n = (
    db
      .query(
        `SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = 'recovery'
           AND json_extract(payload, '$.decision') = 'unconfirmed-dead'`
      )
      .get(taskId) as any
  ).n as number;
  // Bounded: an event per cycle forever would also reset the silence clock
  // forever, masking a genuinely mute agent from flagStale.
  if (n < MAX_UNCONFIRMED_DEATHS) {
    writeEvent(db, { task_id: taskId, source: "reconciler", type: "recovery", payload: { decision: "unconfirmed-dead" } });
    return;
  }
  const already = db
    .query("SELECT 1 FROM notifications WHERE kind = 'agent_unreachable' AND task_id = ? LIMIT 1")
    .get(taskId);
  if (already) return;
  const task = getTask(db, taskId);
  enqueue(db, {
    kind: "agent_unreachable",
    urgency: "urgent",
    task_id: taskId,
    title: `Agent unreachable but not dead: ${task?.title ?? taskId}`,
    body: "herdr cannot resolve the agent, but its pane is still there (or herdr is down). Nothing was torn down — check the pane.",
  });
}

function lastAgentStatus(db: DB, taskId: string): string | null {
  const r = db
    .query("SELECT payload FROM events WHERE task_id = ? AND type = 'agent_status' ORDER BY ts DESC LIMIT 1")
    .get(taskId) as { payload: string } | undefined;
  if (!r) return null;
  try {
    return JSON.parse(r.payload).status ?? null;
  } catch {
    return null;
  }
}

// ---- queued-steer drain ----
// A steer herdr refuses is queued rather than dropped (steer.ts), but until this
// it was drained ONLY at spawn time. So a socket blip while the agent was alive
// and working queued the message and then never redelivered it: no respawn was
// coming, and it sat there until the task ended. Every cycle, re-attempt any
// queued steer against an agent that still has an active turn.
//
// Cheap: the queued-steer read is checked BEFORE any probe, so the ordinary case
// (nothing queued) costs one small query per agent-bearing task and zero herdr
// calls. Idempotent: a steer stays queued until a send actually lands, so a
// failure here simply retries next cycle — or rides the next respawn.
//
// Deliberately writes no event of its own. The `steer` event's own receipt
// flipping to delivered IS the record, and a fresh event here would reset the
// task's silence clock (flagStale reads the newest event), masking a mute agent.
async function drainSteers(db: DB, deps: ReconcilerDeps): Promise<void> {
  const h = deps.herdr ?? defaultHerdr;
  const tasks = db
    .query(`SELECT id, agent_target FROM tasks WHERE agent_target IS NOT NULL AND state IN ${NON_TERMINAL}`)
    .all() as { id: string; agent_target: string }[];
  for (const t of tasks) {
    if (isJiraMirrorId(db, t.id)) continue;
    const pending = queuedSteers(db, t.id);
    if (!pending.length) continue; // the common case: no probe, no herdr call
    // Dead agent → leave them queued; the next spawn's brief carries them. A herdr
    // hiccup reads as alive+unknown (parseAgentProbe), so the send below is what
    // actually decides, and it fails safe.
    if (!(await h.probe(t.agent_target)).alive) continue;

    const delivered: string[] = [];
    for (const s of pending) {
      // sendFailure, never the exit code: herdr exits 0 with an agent_not_found
      // body, which is exactly how a steer disappears without a trace.
      let failure: string | null;
      try {
        failure = sendFailure(await h.send(t.agent_target, s.message));
      } catch (e: any) {
        failure = String(e?.message ?? e);
      }
      // Stop at the first failure rather than skipping it: the agent went away
      // mid-drain, and the remaining steers must stay queued IN ORDER so the
      // respawn brief replays them as the director wrote them.
      if (failure) break;
      delivered.push(s.id);
    }
    markSteersDelivered(db, delivered, "drain");
    resumeReviewForDeliveredSteers(
      db,
      t.id,
      pending.filter((steer) => delivered.includes(steer.id)),
      "drain"
    );
  }
}

// ---- ready-for-review advancement (fixes tasks stuck in in_progress) ----
// An agent that finished — opened a PR (ship/chore) or wrote its report (scout) —
// and then went idle/done/gone used to sit in `in_progress` forever: nothing moved it
// into the review queue. This is the backstop that unsticks it regardless of
// agent discipline (the explicit `hive emit <id> ready` path is the clean signal;
// this catches the agents whose interactive turn finishes without that emit).
//
// Trigger: state=in_progress, agent status idle, done, OR gone (NOT working/blocked/
// unknown — an agent that opens a PR and keeps working still reports `working`),
// AND a real work product exists (a pr_url, or a scout `report`). Advancing on a
// single idle read is safe precisely because mid-work reads `working`; after a
// queued-input recovery, advanceIfFinished adds a short grace period for the
// recovered turn to start. Runs BEFORE recoverStale so a handed-off task is
// never failed/requeued.
async function advanceFinished(db: DB, _deps: ReconcilerDeps): Promise<void> {
  const tasks = db
    .query(`SELECT id FROM tasks WHERE state = 'in_progress' AND agent_target IS NOT NULL`)
    .all() as { id: string }[];
  for (const t of tasks) {
    // Never advance a task past its dependency gate. The dispatcher blocks
    // auto-spawn, but the manual /spawn endpoint bypasses that — this holds a
    // blocked task in_progress until its deps merge, surfacing the reason.
    const task = getTask(db, t.id);
    const blocking = unmetDeps(db, task);
    if (blocking.length) {
      noteDependencyBlock(db, t.id, blocking, "reconciler");
      continue;
    }
    const status = lastAgentStatus(db, t.id);
    if (status) advanceIfFinished(db, t.id, status, "reconciler");
  }
}

// ---- PR / CI sync via gh ----
async function syncPRs(db: DB, deps: ReconcilerDeps): Promise<void> {
  const exec = deps.exec ?? defaultExec;
  const h = deps.herdr ?? defaultHerdr;
  const tasks = db
    .query(`SELECT id, state, pr_url, ci_status, head_sha, pr_state, agent_target, project_id, branch FROM tasks WHERE pr_url IS NOT NULL AND state IN ${NON_TERMINAL}`)
    .all() as { id: string; state: string; pr_url: string; ci_status: string | null; head_sha: string | null; pr_state: string | null; agent_target: string | null; project_id: string; branch: string | null }[];

  // Probe every PR first, a few at a time, then act on the results serially.
  // Serially probing meant K slow `gh` calls cost K timeouts (HIVE-438: 175s
  // laps against a 24-40s baseline); bounded-concurrent, K slow calls cost
  // about one. Only the network read is parallel — every DB write below stays
  // on one thread, in the same order as before.
  const probes = await mapLimit(tasks, GH_PROBE_CONCURRENCY, async (t) => {
    // A Jira mirror has no hive-owned PR at all, so there is nothing to record;
    // skip it outright. A non-Jira external task DOES get its observed PR facts
    // recorded (ci_status, head_sha, ...) and is skipped further down, at the
    // ACTIONABLE phase only — see the neverDispatched guard below (hive-996).
    if (isJiraMirrorId(db, t.id)) return null;
    const r = await exec(
      ["gh", "pr", "view", t.pr_url, "--json", "state,statusCheckRollup,mergeable,headRefOid,baseRefName,baseRefOid"],
      { timeoutMs: GH_PROBE_TIMEOUT_MS }
    );
    if (r.code !== 0) return null; // gh unavailable / auth: skip, try next cycle
    try {
      return { t, data: JSON.parse(r.stdout) as any };
    } catch {
      return null;
    }
  });

  for (const probe of probes) {
    if (!probe) continue;
    const { t, data } = probe;
    // The task's state may have moved on since the SELECT above — a concurrent
    // POST /merge, autoMergeReady, or an overlapping reconcile cycle can land
    // while this `await exec` was in flight and advance the task to a terminal
    // state, OR the agent can have replaced this PR with another one (a fresh
    // `ready` re-links pr_url). Every branch below transitions off the task's
    // state or writes events tagged with this PR; re-read fresh and skip once
    // terminal or re-linked, rather than trusting the stale `t` snapshot —
    // that stale read is exactly what threw "invalid transition: 'done' ->
    // 'verifying'" in production (task #621), and an untagged skip here would
    // let a slow probe for a REPLACED PR advance the task that replaced it.
    let live = currentPrTask(db, t);
    if (!live) continue;
    let state: string = live.state;
    let deferred = isDeferred(live);
    // Record a new pushed commit as `pr_synchronized` (hive's stand-in for
    // GitHub's synchronize webhook) so changesRequestUnaddressed can tell "the
    // agent pushed a fix" from "CI is still green on the same old head". The
    // first observation is a baseline (no changes_requested exists yet when a PR
    // is first linked); only a CHANGED head afterward counts as new work.
    // ponytail: last-seen head is read back from the prior pr_synchronized event
    // (no task column); a PR reaches review long before any changes_requested,
    // so the baseline is always in place by the time the guard matters.
    const headSha: string | null = data.headRefOid ?? null;
    if (headSha) {
      const lastSync: any = db
        .query("SELECT payload FROM events WHERE task_id = ? AND type = 'pr_synchronized' ORDER BY ts DESC LIMIT 1")
        .get(t.id);
      const lastSha = lastSync ? (JSON.parse(lastSync.payload).head_sha ?? null) : null;
      if (headSha !== lastSha) {
        writeEvent(db, { task_id: t.id, source: "reconciler", type: "pr_synchronized", payload: { head_sha: headSha } });
      }
    }
    // Snapshot the branch's intended scope ONCE, at first sight — before any
    // no-mistakes CI-monitor rebase can run (a rebase only fires after the PR
    // falls behind, which is later). mergeTask diffs the branch's final scope
    // against this to catch a destructive auto-rebase (task #314). One event per
    // task: the existence check makes this idempotent across cycles.
    if (t.branch) {
      const have = db.query("SELECT 1 FROM events WHERE task_id = ? AND type = 'branch_scope' LIMIT 1").get(t.id);
      if (!have) {
        const project = db.query("SELECT config, repo_path FROM projects WHERE id = ?").get(t.project_id) as
          | { config: string; repo_path: string | null }
          | undefined;
        if (project?.repo_path) {
          let base = "main";
          try {
            base = projectBaseBranch(JSON.parse(project.config ?? "{}"));
          } catch {}
          base = preferSafeRef(data.baseRefName, base);
          const scopeHead = data.headRefOid || t.branch;
          const scope = await captureBranchScope(exec, project.repo_path, data.baseRefOid || base, scopeHead);
          const afterScope = getTask(db, t.id);
          if (!afterScope || TERMINAL.includes(afterScope.state as State) || afterScope.pr_url !== t.pr_url) continue;
          if (scope) writeEvent(db, { task_id: t.id, source: "reconciler", type: "branch_scope", payload: { ...scope, head_sha: data.headRefOid ?? null } });
        }
      }
    }
    const prState = String(data.state ?? "").toUpperCase() || null;
    if (prState && prState !== t.pr_state) {
      db.query("UPDATE tasks SET pr_state = ?, updated_at = ? WHERE id = ?").run(prState, now(), t.id);
    }
    const { status: ci, red } = await probeRed(exec, data.statusCheckRollup, data.baseRefOid ?? null);
    // ci_status only changes when the answer changes; ci_checked_at records
    // every LOOK, which is what a decision card citing CI has to show.
    db.query("UPDATE tasks SET ci_checked_at = ? WHERE id = ?").run(now(), t.id);
    if (ci && ci !== t.ci_status) {
      db.query("UPDATE tasks SET ci_status = ?, updated_at = ? WHERE id = ?").run(ci, now(), t.id);
      writeEvent(db, { task_id: t.id, source: "reconciler", type: "ci_status", payload: { ci_status: ci } });
      broadcast({ type: "task", task: getTask(db, t.id) });
      if (ci === "unavailable") notifyCiUnavailable(db, t.id, t.pr_url);
    }
    // Infra-red: the signal itself is the bug, so dispatch ONE diagnostic task
    // for it across every PR it hits, and record the signal on this task so a
    // decision card raised here can inherit the director's single ruling.
    const signal = ci === "unavailable" ? ciSignalKey(red) : null;
    if (signal) {
      // One event per (head, signal): the probe repeats every cycle while a PR
      // sits red, and the timeline must not fill up with the same fact.
      const logged = db
        .query(
          `SELECT 1 FROM events WHERE task_id = ? AND type = 'ci_infra'
             AND json_extract(payload, '$.signal') = ? AND COALESCE(json_extract(payload, '$.head_sha'), '') = ? LIMIT 1`
        )
        .get(t.id, signal, headSha ?? "");
      if (!logged)
        writeEvent(db, { task_id: t.id, source: "reconciler", type: "ci_infra", payload: { signal, checks: red, head_sha: headSha } });
      ensureInfraTask(db, t.project_id, signal, red, t.pr_url);
    }
    if (data.headRefOid && data.headRefOid !== t.head_sha) {
      db.query("UPDATE tasks SET head_sha = ?, updated_at = ? WHERE id = ?").run(data.headRefOid, now(), t.id);
      broadcast({ type: "task", task: getTask(db, t.id) });
    }
    // A never-dispatched external task (see supervision.ts) has no agent to
    // nudge, so every AGENT-DIRECTED branch below is skipped for it. It used to
    // skip the whole actionable phase, which also swallowed the MERGED->done
    // observation and parked merged tasks in in_review forever (HIVE-473). A
    // terminal PR state is a fact hive observed, not a nudge, so it still runs.
    const agentless = neverDispatched(db, live);
    // Re-check once more right before the actionable phase: the bookkeeping
    // above (probeRed, ci_status writes) awaited too, and is the last chance
    // for a PR replacement/closure race to have landed.
    live = currentPrTask(db, t);
    if (!live) continue;
    state = live.state;
    deferred = isDeferred(live);
    // Time-based fallback for the link-time hand-off — but review means "CI is
    // green and the director can merge", so failing/pending checks HOLD the
    // task in_progress (this is also what promotes a held `ready`: the moment
    // checks pass, the task moves to review; failing checks steer the agent).
    if (String(data.state).toUpperCase() === "OPEN" && state === "in_progress" && !agentless) {
      if (ci === "failing") {
        await nudgeCiFailure(db, h, t, data.headRefOid ?? null);
      } else if (ci !== "pending") {
        if (handOffToReview(db, t.id, "reconciler")) broadcast({ type: "task", task: getTask(db, t.id) });
      }
    }
    if (String(data.state).toUpperCase() === "MERGED" && state === "in_review") {
      writeEvent(db, { task_id: t.id, source: "reconciler", type: "pr_merged", payload: { pr_url: t.pr_url } });
      transition(db, t.id, "verifying", { source: "reconciler", reason: "PR merged" });
      // Post-merge smoke runs once on entering verifying.
      await advanceAfterMerge(db, t.id, deps);
    } else if (String(data.state).toUpperCase() === "CLOSED" && state === "in_review" && agentless) {
      // No agent to bounce it back to and no in_progress worth returning it to,
      // so just record the fact — once, since nothing here moves the task off
      // in_review and the probe repeats every cycle.
      const already = db.query("SELECT 1 FROM events WHERE task_id = ? AND type = 'pr_closed' LIMIT 1").get(t.id);
      if (!already) writeEvent(db, { task_id: t.id, source: "reconciler", type: "pr_closed", payload: { pr_url: t.pr_url } });
    } else if (String(data.state).toUpperCase() === "CLOSED" && state === "in_review") {
      // Closed-not-merged: nothing reviewable exists. Self-heal instead of
      // waiting for the director to discover it via a failed merge click.
      writeEvent(db, { task_id: t.id, source: "reconciler", type: "pr_closed", payload: { pr_url: t.pr_url } });
      queueSteerEvent(
        db,
        t.id,
        `Your PR ${t.pr_url} is CLOSED (not merged), so this task has nothing to review. If you replaced it, ` +
          `emit ready with the new PR url (that re-links the task); otherwise reopen or recreate the PR.`,
        "queued by closed-PR bounce"
      );
      transition(db, t.id, "in_progress", { source: "reconciler", reason: "PR closed without merging — returned to the agent" });
      broadcast({ type: "task", task: getTask(db, t.id) });
    } else if (deferred && state === "in_progress" && ["MERGED", "CLOSED"].includes(String(data.state).toUpperCase())) {
      // A deferred task has no agent driving it forward, so unlike the
      // non-deferred case below it can't just sit and wait to be noticed — a
      // terminal PR state is the one thing that must still cut through the
      // park (hive-303). Clear the deferral and run it through the same
      // merged/closed handling as an in_review task would get.
      undeferTask(db, t.id, { source: "reconciler", note: "PR reached a terminal state while deferred" });
      if (String(data.state).toUpperCase() === "MERGED") {
        writeEvent(db, { task_id: t.id, source: "reconciler", type: "pr_merged", payload: { pr_url: t.pr_url } });
        // in_progress can't jump straight to verifying — hop through in_review
        // first, same path a non-deferred task takes on its way to merge.
        transition(db, t.id, "in_review", { source: "reconciler", reason: "PR merged while deferred — catching up review" });
        transition(db, t.id, "verifying", { source: "reconciler", reason: "PR merged (deferred task undeferred)" });
        await advanceAfterMerge(db, t.id, deps);
      } else {
        writeEvent(db, { task_id: t.id, source: "reconciler", type: "pr_closed", payload: { pr_url: t.pr_url } });
      }
    } else if (state === "in_progress" && ["MERGED", "CLOSED"].includes(String(data.state).toUpperCase())) {
      // A PR can be merged/closed by a human while its task is still held in
      // in_progress (handoff to in_review is held on pending/failing CI — see
      // the OPEN+in_progress branch above), and the task can die before ever
      // reaching in_review. Record the terminal PR event either way so
      // predecessorOpenPrUrl (api.ts) never cites an already-dead PR in a
      // requeue brief — but skip the in_review side effects (steer, smoke,
      // verifying transition): the task never reached review, so there's
      // nothing to bounce back or advance. One-shot per task (no transition
      // moves it off in_progress to stop this from recurring every cycle).
      const type = String(data.state).toUpperCase() === "MERGED" ? "pr_merged" : "pr_closed";
      const already = db.query("SELECT 1 FROM events WHERE task_id = ? AND type = ? LIMIT 1").get(t.id, type);
      if (!already) writeEvent(db, { task_id: t.id, source: "reconciler", type, payload: { pr_url: t.pr_url } });
    } else if (ci === "failing" && state === "in_review" && !agentless) {
      // Checks went red AFTER the handoff: red is not reviewable. Send it back
      // to the agent to iterate; it returns automatically when green.
      await nudgeCiFailure(db, h, t, data.headRefOid ?? null);
      transition(db, t.id, "in_progress", { source: "reconciler", reason: "CI failing — returned to the agent to iterate" });
      broadcast({ type: "task", task: getTask(db, t.id) });
    } else if (!deferred && !agentless && String(data.mergeable).toUpperCase() === "CONFLICTING") {
      // A deliberately parked task (deferred_until in the future) shouldn't
      // draw pr_conflict noise or steer an inactive agent (hive-303). No event
      // is written while deferred, so undefer's next cycle sees a fresh
      // head_sha/dedup state and nudges once, immediately.
      await nudgeConflict(db, h, t, data.headRefOid ?? null, exec);
    }
  }
}

// Post-merge advance out of `verifying`. A task hive drives runs its smoke
// checks. A tracking-only task (an external board row) has no hive worktree to
// smoke and no evidence gate, and both smokeThenAdvance and sweepVerifying bail
// out on it — so without this it would just swap a stuck `in_review` for a
// stuck `verifying`. For it, merged IS done (HIVE-473).
async function advanceAfterMerge(db: DB, taskId: string, deps: ReconcilerDeps): Promise<void> {
  if (isTrackingOnlyId(db, taskId)) {
    transition(db, taskId, "done", { source: "reconciler", reason: "PR merged (tracking-only task: no post-merge smoke)" });
    broadcast({ type: "task", task: getTask(db, taskId) });
    return;
  }
  try {
    await smokeThenAdvance(db, taskId, deps.smoke ?? {});
  } catch (e) {
    console.error(`[hive] smoke run failed for ${taskId}:`, e);
  }
}

// Failing checks put the AGENT back to work — one nudge per pushed head SHA
// (same dedupe discipline as nudgeConflict), so a red run never spams but a
// push that still fails re-nudges.
async function nudgeCiFailure(
  db: DB,
  h: Herdr,
  t: { id: string; pr_url: string; agent_target: string | null },
  headSha: string | null
): Promise<void> {
  const last = db
    .query("SELECT payload FROM events WHERE task_id = ? AND type = 'ci_failure' ORDER BY ts DESC LIMIT 1")
    .get(t.id) as { payload: string } | undefined;
  if (last) {
    try {
      if ((JSON.parse(last.payload).head_sha ?? null) === headSha) return;
    } catch {}
  }
  const msg =
    `hive: CI is FAILING on your PR ${t.pr_url}. Run \`gh pr checks ${t.pr_url}\` to see the failures, fix them, and push. ` +
    `The task returns to review automatically when checks pass — do not emit ready while CI is red.`;
  let delivered = false;
  let error: string | null = null;
  if (t.agent_target) {
    try {
      const r = await h.send(t.agent_target, msg);
      error = sendFailure(r);
      delivered = error === null;
    } catch (e: any) {
      error = String(e?.message ?? e);
    }
  }
  // Nobody live read it (released after review handoff, or dead): queue it so the
  // dispatcher's reattach pass respawns an agent carrying it. The per-head-SHA
  // dedupe above means at most one queued steer per pushed head, not a backlog.
  if (!delivered) queueSteerEvent(db, t.id, msg, "CI failing; no live agent");
  writeEvent(db, {
    task_id: t.id,
    source: "reconciler",
    type: "ci_failure",
    payload: { pr_url: t.pr_url, head_sha: headSha, delivered, ...(error ? { error } : {}) },
  });
}

// ---- PR conflict watchdog ----
// A PR GitHub reports CONFLICTING gets its agent told to resolve it — conflict
// resolution is the agent's job, not the captain's. Deduped per head SHA: one
// nudge per pushed state of the branch, so a cycle tick never spams but a push
// that still conflicts re-nudges. Lifecycle is untouched: an in_review task
// stays reviewable (the merge button's own failure path bounces it if the
// captain gets there first), and a delivered send flips the agent to `working`,
// which keeps advanceFinished from churning states.
async function nudgeConflict(
  db: DB,
  h: Herdr,
  t: { id: string; pr_url: string; agent_target: string | null; project_id: string; branch: string | null },
  headSha: string | null,
  exec: Exec
): Promise<void> {
  const last = db
    .query("SELECT payload FROM events WHERE task_id = ? AND type = 'pr_conflict' ORDER BY ts DESC LIMIT 1")
    .get(t.id) as { payload: string } | undefined;
  if (last) {
    try {
      if ((JSON.parse(last.payload).head_sha ?? null) === headSha) return; // already nudged for this push
    } catch {}
  }
  const project = db.query("SELECT config, repo_path FROM projects WHERE id = ?").get(t.project_id) as
    | { config: string; repo_path: string | null }
    | undefined;
  let base = "main";
  try {
    base = projectBaseBranch(JSON.parse(project?.config ?? "{}"));
  } catch {}

  const msg = `hive: your PR ${t.pr_url} has merge conflicts with '${base}'. Fetch and merge the latest 'origin/${base}' into your branch (or rebase onto it), resolve the conflicts, rerun the tests, then push.`;
  let delivered = false;
  let error: string | null = null;
  if (t.agent_target) {
    try {
      const r = await h.send(t.agent_target, msg);
      error = sendFailure(r);
      delivered = error === null;
    } catch (e: any) {
      error = String(e?.message ?? e);
    }
  }
  // Same as nudgeCiFailure: an in_review task's agent is usually released, so
  // queue the nudge for the reattach respawn instead of dropping it.
  if (!delivered) queueSteerEvent(db, t.id, msg, "PR conflicting; no live agent");
  writeEvent(db, {
    task_id: t.id,
    source: "reconciler",
    type: "pr_conflict",
    payload: { pr_url: t.pr_url, head_sha: headSha, delivered, ...(error ? { error } : {}) },
  });
}

// ---- PR → task linking via gh ----
// Scan each project's open PRs and link any carrying a hive marker back to its
// task (by `hive-task: <id>` body footer, falling back to the `[hive-<n>]`
// title). linkPrIfMarked only sets pr_url when the task isn't already linked, so
// this is idempotent and never clobbers an agent-reported PR.
// ponytail: re-lists all open PRs per project every cycle; fine for a localhost
// tool with a handful of repos. Add a since-cursor if repos ever have many PRs.
async function linkPRs(db: DB, deps: ReconcilerDeps): Promise<void> {
  const exec = deps.exec ?? defaultExec;
  // Test/ephemeral projects are excluded (task #1667): their repo_path is a
  // scratch dir that gets cleaned up, and running gh against a directory that
  // no longer exists is what wedged this step for ~10h. They have no real PRs
  // to link either.
  const projects = db
    .query(`SELECT id, repo_path FROM projects WHERE repo_path IS NOT NULL AND ${notTestProjectSql()}`)
    .all() as { id: string; repo_path: string }[];
  let startFailure: string | null = null;
  for (const p of projects) {
    const r = await exec(["gh", "pr", "list", "--state", "open", "--json", "number,title,body,url"], { cwd: p.repo_path });
    // 127 is defaultExec's "the child never started" (missing binary, or a
    // repo_path that no longer exists), as opposed to gh running and failing.
    if (r.code === 127 && startFailure === null) startFailure = r.stderr.trim();
    if (r.code !== 0) continue; // gh unavailable / not a gh repo: skip, retry next cycle
    let list: any;
    try {
      list = JSON.parse(r.stdout);
    } catch {
      continue;
    }
    if (!Array.isArray(list)) continue;
    for (const pr of list) linkPrIfMarked(db, { title: pr.title, body: pr.body, url: pr.url });
  }
  noteToolStart(db, "gh", startFailure);
}

// One rollup entry counts as red. Shared by ciStatusOf and the non-start probe
// below so both agree on exactly which checks are the failing ones.
function isFailedCheck(c: any): boolean {
  const conclusion = String(c.conclusion ?? "").toUpperCase();
  const state = String(c.state ?? "").toUpperCase(); // StatusContext
  return (
    conclusion === "FAILURE" || conclusion === "ERROR" || conclusion === "CANCELLED" || conclusion === "TIMED_OUT" ||
    state === "FAILURE" || state === "ERROR"
  );
}

// A PR rollup can retain several executions of the same workflow job. GitHub
// gives us the workflow + job identity and the execution time, so only the
// newest execution should vote. Keep distinct heads separate when supplied;
// gh's PR rollup is already scoped to the current head.
function latestChecks(rollup: any): any[] {
  if (!Array.isArray(rollup)) return [];
  const latest = new Map<string, { check: any; order: number }>();
  const ungrouped: any[] = [];
  for (const c of rollup) {
    const type = String(c?.__typename ?? "");
    const identity = type === "CheckRun" && c.workflowName && c.name
      ? `${type}:${c.workflowName}:${c.name}`
      : type === "StatusContext" && c.context ? `${type}:${c.context}` : null;
    if (!identity) {
      ungrouped.push(c);
      continue;
    }
    const key = `${String(c.headSha ?? c.head_sha ?? "")}:${identity}`;
    const run = Number(/\/actions\/runs\/(\d+)/.exec(String(c.detailsUrl ?? ""))?.[1] ?? 0);
    const order = Date.parse(c.startedAt ?? c.createdAt ?? c.completedAt ?? "") || run;
    if (!latest.has(key) || order > latest.get(key)!.order) latest.set(key, { check: c, order });
  }
  return [...ungrouped, ...[...latest.values()].map(({ check }) => check)];
}

// Derive a coarse ci_status from gh's statusCheckRollup (a mix of CheckRun and
// StatusContext objects). failing > pending > passing.
export function ciStatusOf(rollup: any): string | null {
  const checks = latestChecks(rollup);
  if (checks.length === 0) return null;
  let anyPending = false;
  for (const c of checks) {
    const status = String(c.status ?? "").toUpperCase();
    const state = String(c.state ?? "").toUpperCase(); // StatusContext
    if (isFailedCheck(c)) return "failing";
    if (status === "QUEUED" || status === "IN_PROGRESS" || status === "PENDING" || state === "PENDING")
      anyPending = true;
  }
  return anyPending ? "pending" : "passing";
}

// GitHub still creates a check run and marks it {conclusion: FAILURE} when it
// REFUSES to start the job — unpaid Actions billing, a spending limit, no
// runner. In the rollup that is byte-for-byte a red test, so the ready gate
// held the handoff and told the agent to "fix the failures and push", which no
// commit can do: the job never ran (task #1210, seen live on PR #121, failed in
// 3s with steps: []). GitHub says so in the check run's annotation, and every
// one of those messages starts with the same phrase.
const NON_START_ANNOTATION = /job was not started/i;

// True when GitHub's own annotation says this failing check never started.
// Everything unexpected — no details URL, gh error, output that isn't an
// annotation array — returns false. A genuine red test must never be downgraded
// because a probe misfired.
async function isNonStart(exec: Exec, check: any): Promise<boolean> {
  // detailsUrl: https://github.com/<owner>/<repo>/actions/runs/<run>/job/<id>,
  // where <id> is also the check-run id.
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/.*\/job\/(\d+)/.exec(String(check?.detailsUrl ?? ""));
  if (!m) return false;
  const r = await exec(["gh", "api", `repos/${m[1]}/${m[2]}/check-runs/${m[3]}/annotations`]);
  if (r.code !== 0) return false;
  try {
    const anns = JSON.parse(r.stdout);
    return Array.isArray(anns) && anns.some((a: any) => NON_START_ANNOTATION.test(String(a?.message ?? "")));
  } catch {
    return false;
  }
}

// The other two infra shapes, both seen on a consuming project's PR #811: the job "ran" but
// executed ZERO steps in a couple of seconds (no runner picked it up), and the
// exact same check is already red on the base branch, where this PR's diff does
// not exist. Neither can be fixed by a commit on the PR.
const NO_STEPS_MAX_MS = 20_000;

function jobRef(check: any): { owner: string; repo: string; job: string } | null {
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/.*\/job\/(\d+)/.exec(String(check?.detailsUrl ?? ""));
  return m ? { owner: m[1], repo: m[2], job: m[3] } : null;
}

// True when the Actions job record shows no steps at all and a runtime of
// seconds. Anything unparseable → false: a genuine red test is never downgraded
// because a probe misfired.
async function ranNoSteps(exec: Exec, check: any): Promise<boolean> {
  const ref = jobRef(check);
  if (!ref) return false;
  const r = await exec(["gh", "api", `repos/${ref.owner}/${ref.repo}/actions/jobs/${ref.job}`]);
  if (r.code !== 0) return false;
  try {
    const job = JSON.parse(r.stdout);
    if (!Array.isArray(job?.steps) || job.steps.length > 0) return false;
    const started = Date.parse(job?.started_at ?? "");
    const completed = Date.parse(job?.completed_at ?? "");
    if (!Number.isFinite(started) || !Number.isFinite(completed)) return false;
    return completed - started <= NO_STEPS_MAX_MS;
  } catch {
    return false;
  }
}

// Names of the checks already failing on the PR's base commit — the same
// failure without this PR's diff. One gh call per red PR, not per check.
async function baseFailures(exec: Exec, check: any, baseSha: string | null | undefined): Promise<Set<string>> {
  const ref = jobRef(check);
  if (!ref || !baseSha) return new Set();
  const r = await exec(["gh", "api", `repos/${ref.owner}/${ref.repo}/commits/${baseSha}/check-runs`]);
  if (r.code !== 0) return new Set();
  try {
    const runs = JSON.parse(r.stdout)?.check_runs;
    if (!Array.isArray(runs)) return new Set();
    return new Set(runs.filter(isFailedCheck).map((c: any) => String(c?.name ?? "")));
  } catch {
    return new Set();
  }
}

// Why a red check is infra, in the order the probes are cheapest and most
// certain. `null` = the diff plausibly caused it, i.e. code-red.
const INFRA_REASONS: Record<string, string> = {
  "not-started": "GitHub never started the job",
  "no-steps": "the job ran zero steps and ended in seconds — no runner picked it up",
  "red-on-base": "the same check is already red on the base branch, without this PR's changes",
};

export type RedCheck = { name: string; infra: string | null };

// Classify every red check on a rollup as infra or code. Only ever called on a
// rollup that is already red.
export async function classifyRed(exec: Exec, rollup: any, baseSha?: string | null): Promise<RedCheck[]> {
  const red = latestChecks(rollup).filter(isFailedCheck);
  let base: Set<string> | null = null;
  const out: RedCheck[] = [];
  for (const c of red) {
    const name = String(c?.name ?? c?.context ?? "check");
    let infra: string | null = null;
    if (await isNonStart(exec, c)) infra = "not-started";
    else if (await ranNoSteps(exec, c)) infra = "no-steps";
    else {
      if (base === null) base = await baseFailures(exec, c, baseSha);
      if (name && base.has(name)) infra = "red-on-base";
    }
    out.push({ name, infra });
  }
  return out;
}

// A stable id for "this same outage", shared by every PR it hits: the failing
// check names plus why. Two PRs blocked by the billing lapse on 'syntax' and
// 'parity' produce one key, so they get one task and one ruling.
export function ciSignalKey(red: RedCheck[]): string | null {
  const infra = red.filter((c) => c.infra);
  if (!infra.length || infra.length !== red.length) return null; // any code-red → not an outage
  const names = [...new Set(infra.map((c) => c.name))].sort().join(",");
  const why = [...new Set(infra.map((c) => c.infra))].sort().join(",");
  return `${names}:${why}`;
}

export function ciSignalSentence(red: RedCheck[]): string {
  const reasons = [...new Set(red.map((c) => c.infra).filter(Boolean))].map((k) => INFRA_REASONS[k as string] ?? k);
  const names = [...new Set(red.map((c) => c.name))].join(", ");
  return `${names}: ${reasons.join("; ")}`;
}

// Surface a non-start to the director, not to the agent — the agent can't fix
// it. Once per hour for the whole fleet: the failure mode this exists for is
// EVERY open PR going red at the same moment (Actions billing lapses), and a
// push per task would bury the one thing that matters.
const CI_UNAVAILABLE_QUIET_MS = 60 * 60 * 1000;

function notifyCiUnavailable(db: DB, taskId: string, prUrl: string): void {
  const since = new Date(Date.now() - CI_UNAVAILABLE_QUIET_MS).toISOString();
  const recent = db.query("SELECT 1 FROM notifications WHERE kind = 'ci_unavailable' AND ts > ? LIMIT 1").get(since);
  if (recent) return;
  enqueue(db, {
    kind: "ci_unavailable",
    task_id: taskId,
    title: "GitHub refused to run CI — checks are red for a reason no agent can fix",
    body: `The job never started on ${prUrl}. Check Actions billing and runners. Handoffs are NOT held, so review is unblocked.`,
  });
}

const INFRA_TASK_COOLDOWN_MS = 24 * 60 * 60 * 1000;

// LIKE pattern for the `ci-signal:` marker a diagnostic task carries in its
// brief. Check names are workflow/job names, but nothing stops one containing a
// % or _, which LIKE would read as a wildcard — escape them.
function signalMarkerLike(signal: string): string {
  return `%ci-signal: ${signal.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

// Is the diagnostic task for this outage still live? A standing ruling on an
// outage only holds while the outage does, and this task is how hive tracks it:
// once it is done/failed/cancelled, the next red card asks the director again.
export function infraTaskOpen(db: DB, projectId: string, signal: string): boolean {
  return !!db
    .query(`SELECT id FROM tasks WHERE project_id = ? AND brief LIKE ? ESCAPE '\\' AND state IN ${NON_TERMINAL} LIMIT 1`)
    .get(projectId, signalMarkerLike(signal));
}

// One diagnostic task per outage signal, for the whole fleet — not one per
// blocked PR. Deduped on the `ci-signal:` marker in the brief, so the six PRs
// that shared today's billing block share one task. Skipped while an earlier
// task for the same signal is still open.
export function ensureInfraTask(db: DB, projectId: string, signal: string, red: RedCheck[], prUrl: string): string | null {
  const marker = signalMarkerLike(signal);
  // Still open, or closed within a day: an outage nobody can fix from here (a
  // billing lapse) would otherwise mint a fresh task every cycle after the last
  // one is closed.
  const recent = db
    .query(
      `SELECT id FROM tasks WHERE brief LIKE ? ESCAPE '\\' AND (state IN ${NON_TERMINAL} OR created_at > ?) LIMIT 1`
    )
    .get(marker, new Date(Date.now() - INFRA_TASK_COOLDOWN_MS).toISOString()) as { id: string } | undefined;
  if (recent) return null;
  const t = now();
  const id = newId();
  const names = [...new Set(red.map((c) => c.name))].join(", ");
  const title = `CI infrastructure red: ${names}`;
  const brief =
    `Automated: the check(s) ${names} are red for a reason no PR can fix.\n\n` +
    `Signal: ${ciSignalSentence(red)}.\n` +
    `First seen on ${prUrl}. Every PR hitting this same signal shares THIS task — do not open one per PR.\n\n` +
    `Diagnose the signal itself (GitHub Actions billing, spending limit, runner availability, or a broken workflow on the base branch), ` +
    `fix it or report exactly what a human must change, and attach evidence that a rerun of ${names} now passes.\n\n` +
    `ci-signal: ${signal}`;
  db.query(
    `INSERT INTO tasks (id, project_id, title, brief, state, kind, created_at, updated_at)
     VALUES (?,?,?,?, 'queued', 'chore', ?, ?)`
  ).run(id, projectId, title, brief, t, t);
  writeEvent(db, { task_id: id, source: "reconciler", type: "created", payload: { title, ci_signal: signal, pr_url: prUrl } });
  broadcast({ type: "task", task: getTask(db, id) });
  return id;
}

// ciStatusOf plus the one thing the rollup can't tell you on its own: a
// 'failing' rollup whose failing checks ALL never started is 'unavailable', not
// 'failing'. Callers gate on 'failing'/'pending' and let 'unavailable' through
// like a repo with no CI at all, because holding the agent there is a trap.
// Mixed — one real red test alongside a non-start — stays 'failing': a genuine
// failure always wins.
// ponytail: one extra `gh api` per failing check per cycle, and only while a PR
// is red — green and pending rollups never probe. Cache per head SHA if a repo
// ever sits red across many tasks for long enough to matter.
export async function probeRed(
  exec: Exec,
  rollup: any,
  baseSha?: string | null
): Promise<{ status: string | null; red: RedCheck[] }> {
  const status = ciStatusOf(rollup);
  if (status !== "failing") return { status, red: [] };
  const red = await classifyRed(exec, rollup, baseSha);
  return { status: red.length && red.every((c) => c.infra) ? "unavailable" : "failing", red };
}

export async function ciStatusProbed(exec: Exec, rollup: any, baseSha?: string | null): Promise<string | null> {
  return (await probeRed(exec, rollup, baseSha)).status;
}

// A stable read of a PR's live state/head/CI, for callers about to act on it
// (merge). Reads twice and only trusts an answer where head, state, and the
// check rollup agree across both reads — a force-push or a check landing
// mid-probe just re-reads rather than handing back a torn snapshot. Up to 3
// attempts before giving up. Used to give `gh pr merge` the verified head as
// an atomic `--match-head-commit` precondition (task HIVE-307).
export async function probePrReadiness(
  exec: Exec,
  prUrl: string
): Promise<{ ok: true; data: any; ci: string | null } | { ok: false }> {
  const fields = "state,statusCheckRollup,headRefOid";
  for (let attempt = 0; attempt < 3; attempt++) {
    const first = await exec(["gh", "pr", "view", prUrl, "--json", fields]);
    if (first.code !== 0) return { ok: false };
    let data: any;
    try {
      data = JSON.parse(first.stdout || "{}");
    } catch {
      return { ok: false };
    }
    const ci = await ciStatusProbed(exec, data.statusCheckRollup);
    const confirmed = await exec(["gh", "pr", "view", prUrl, "--json", fields]);
    if (confirmed.code !== 0) return { ok: false };
    let current: any;
    try {
      current = JSON.parse(confirmed.stdout || "{}");
    } catch {
      return { ok: false };
    }
    if (
      data.headRefOid === current.headRefOid &&
      String(data.state ?? "").toUpperCase() === String(current.state ?? "").toUpperCase() &&
      JSON.stringify(data.statusCheckRollup ?? null) === JSON.stringify(current.statusCheckRollup ?? null)
    )
      return { ok: true, data: current, ci };
  }
  return { ok: false };
}

// Signal freshness. A card that cited red checks is only worth the director's
// attention while the checks are still red. syncPRs re-probes every cycle, so
// the moment they turn green the question is moot: close it, tell the agent, and
// let it carry on — showing stale facts is worse than showing nothing.
export function revalidateCiDecisions(db: DB): number {
  const rows = db
    .query(
      `SELECT d.id, d.title, t.ci_status FROM decisions d JOIN tasks t ON t.id = d.task_id
        WHERE d.status = 'open' AND d.ci_status_at_card IN ('failing', 'unavailable') AND t.ci_status = 'passing'`
    )
    .all() as { id: string; title: string; ci_status: string }[];
  for (const r of rows) {
    apiDismissDecision(db, r.id, {
      reason: "ci_signal_changed",
      steer:
        `hive closed your decision card "${r.title}" on its own: the checks it was about are GREEN now, ` +
        `so the question no longer applies. Re-check the PR and carry on; ask again only if something is still blocked.`,
    });
  }
  return rows.length;
}

// ---- stale detection ----
// Open decisions age badly: median answer latency was 2.5h and 22 of 95 cards
// expired unanswered, each stranding whatever waited on it. The first
// notification rides createDecision; this escalates — an URGENT re-notify (macOS
// push) at 15m and again at 60m, keyed off prior decision_nag rows so each tier
// fires once. Exported for tests.
const NAG_TIERS_MS = [15 * 60 * 1000, 60 * 60 * 1000];

export function nagOpenDecisions(db: DB, nowMs: number = Date.now()): void {
  const open = db
    .query("SELECT id, task_id, ts, title FROM decisions WHERE status = 'open'")
    .all() as { id: string; task_id: string; ts: string; title: string }[];
  for (const d of open) {
    const age = nowMs - Date.parse(d.ts);
    const due = NAG_TIERS_MS.filter((t) => age >= t).length;
    if (!due) continue;
    const sent = (
      db.query("SELECT COUNT(*) AS n FROM notifications WHERE kind = 'decision_nag' AND decision_id = ?").get(d.id) as any
    ).n as number;
    if (sent >= due) continue;
    const mins = Math.round(age / 60000);
    enqueue(db, {
      kind: "decision_nag",
      urgency: "urgent",
      task_id: d.task_id,
      decision_id: d.id,
      title: `Decision waiting ${mins >= 60 ? `${Math.round(mins / 60)}h` : `${mins}m`}: ${d.title}`,
      body: "An agent may be parked on this. Answer or dismiss it.",
    });
  }
}

// Auto-merge: the director's review click is predictable when EVERYTHING
// already says yes — CI green, the auto-reviewer found no risks and no
// questions, evidence attached, no changes ever requested. For task kinds a
// project opts into (config.auto_merge = {kinds: ["chore", ...]}), merge
// those without waiting. Anything contested (caution verdict, risks, red CI,
// a changes_requested in history) still parks for the human. A notification
// reports every auto-merge; the existing verifying/smoke gates still run.
// Passing the understanding check proves the director READ the change. It is
// never approval to ship: having understood it, they may well decide it is not
// what they wanted. So any pass on the latest review — Focus, the review card,
// the task page, it makes no difference — parks the task for an explicit Ship or
// Request changes click (director ruling, HIVE-421).
export function passedByDirector(db: DB, taskId: string): boolean {
  return !!db.query(
    `SELECT 1 FROM events passed
      WHERE passed.task_id = ? AND passed.type = 'understanding_quiz_passed'
        AND json_extract(passed.payload, '$.review_event_id') = (
          SELECT id FROM events
           WHERE task_id = ? AND type = 'review_summary'
           ORDER BY ts DESC, rowid DESC LIMIT 1)`
  ).get(taskId, taskId);
}

// One attempt is usually enough to learn a merge is refused; two tolerates a
// one-off blip. A third identical try is just noise on the card.
const MAX_AUTO_MERGE_ATTEMPTS = 2;

// How many auto-merge attempts were already refused at this exact head. A new
// head is a new situation, so its budget starts over.
function autoMergeFailures(db: DB, taskId: string, head: string | null): number {
  const row = db
    .query(
      `SELECT COUNT(*) n FROM events
        WHERE task_id = ? AND type = 'auto_merge_failed' AND json_valid(payload)
          AND json_extract(payload, '$.head_sha') IS ?`
    )
    .get(taskId, head) as { n: number };
  return row.n;
}

async function errorText(res: Response): Promise<string> {
  try {
    const body: any = await res.clone().json();
    return String(body?.error ?? "");
  } catch {
    return "";
  }
}

// Failures get their own event type: three `auto_merged` rows with ok:false
// read like three merges in the event log, which is exactly how HIVE-473 hid
// in plain sight. `auto_merged` now means merged.
function recordAutoMergeFailure(
  db: DB,
  task: { id: string; number: number; title: string; head_sha: string | null },
  status: number | null,
  error: string
): void {
  // A pause is not a refusal — the task's readiness changed mid-merge, and the
  // next cycle re-reads it. Recording it would burn the budget for nothing.
  if (error === AUTO_MERGE_PAUSED) return;
  const spent = autoMergeFailures(db, task.id, task.head_sha) + 1;
  const gaveUp = spent >= MAX_AUTO_MERGE_ATTEMPTS;
  writeEvent(db, {
    task_id: task.id,
    source: "reconciler",
    type: "auto_merge_failed",
    payload: { ok: false, status, error, head_sha: task.head_sha, attempts: spent, ...(gaveUp ? { gave_up: true } : {}) },
  });
  if (!gaveUp) return;
  enqueue(db, {
    kind: "failed",
    task_id: task.id,
    title: `Auto-merge gave up on #${task.number}`,
    body: `Hive tried to merge this ${MAX_AUTO_MERGE_ATTEMPTS} times and was refused each time. Merge it yourself, or push a commit so hive tries again. Last error: ${(error || `HTTP ${status}`).slice(0, 200)}`,
  });
}

export async function autoMergeReady(db: DB, deps: ReconcilerDeps = {}): Promise<void> {
  const h = deps.herdr ?? defaultHerdr;
  const rows = db
    .query(
      `SELECT t.id, t.number, t.title, t.kind, t.pr_url, t.head_sha, p.config FROM tasks t JOIN projects p ON p.id = t.project_id
        WHERE t.state = 'in_review' AND t.ci_status = 'passing' AND ${supervisedSql("t.source", "t.agent_target")}`
    )
    .all() as { id: string; number: number; title: string; kind: string; pr_url: string | null; head_sha: string | null; config: string }[];
  for (const r of rows) {
    if (isTrackingOnlyId(db, r.id)) continue;
    // A quiz pass proves understanding, not approval to ship. Leave the task
    // parked so the director can still choose Ship or Request changes.
    if (passedByDirector(db, r.id)) continue;
    // A queued steer is requested work the agent has not received yet. Never
    // merge the branch before a fresh turn can address it.
    if (queuedSteers(db, r.id).length) continue;
    // #1234 review-12: don't auto-merge out from under a queued-input recovery
    // that just fired on this same task — the redelivered turn may still push.
    if (queuedInputRecoveryPending(db, r.id)) continue;
    let kinds: string[] = [];
    try {
      const c = JSON.parse(r.config ?? "{}");
      kinds = Array.isArray(c.auto_merge?.kinds) ? c.auto_merge.kinds : [];
    } catch {
      continue;
    }
    // Same helper the merge gate reads (understandingChecksRequired ->
    // latestAutoReviewVerdict). Two different readings of "the latest review"
    // is what made this loop forever (HIVE-499).
    const verdict = latestAutoReviewVerdict(db, r.id);
    if (!verdict) continue; // no usable pre-review yet — wait for it
    if (verdict.verdict !== "looks_good" && verdict.verdict !== "caution") continue;
    // A PR-backed task's most recent review must have been taken against the
    // PR head that's about to be merged — a delayed review from before a
    // force-push or PR replacement must never auto-merge the new head
    // (task HIVE-307). Not fatal: just wait for autoReviewOnce to catch up.
    if (r.pr_url && ((verdict.reviewed_pr_url ?? null) !== r.pr_url || (verdict.reviewed_head_sha ?? null) !== (r.head_sha ?? null))) continue;
    // The pre-review's risks and questions are the ambiguity signal, but they
    // are suspicions until checked: the per-risk verification pass (HIVE-406)
    // re-reads the real code for this exact head. When it refuted every risk
    // and answered every question from the code, the ambiguity is gone and a
    // caution verdict lands like a clean one; one confirmed risk, one
    // human-only question, or any gap keeps the card parked for the director.
    const cleared = ambiguityCleared(db, r.id, verdict.reviewed_head_sha, verdict);
    if (verdict.verdict === "caution" && !cautionCleared(db, r.id, verdict.reviewed_head_sha, verdict)) continue;
    // Same policy the planner uses for its breakdown cards: a PR merge is
    // always revertible (reversible=true) and touches the shared main branch
    // (blastRadius="shared"), and the project's auto_merge.kinds allow-list IS
    // the stored preference — unset/not-listed means "preference unknown".
    const escalation = classifyEscalation({
      reversible: true,
      blastRadius: "shared",
      ambiguous: !cleared,
      preferenceKnown: kinds.includes(r.kind),
    });
    if (escalation.effect !== "auto_handle") continue;
    const contested = db
      .query("SELECT 1 FROM events WHERE task_id = ? AND type = 'changes_requested' LIMIT 1")
      .get(r.id);
    if (contested) continue; // a human pushed back once — never auto-merge this task
    const evidence = (db.query("SELECT COUNT(*) n FROM evidence WHERE task_id = ?").get(r.id) as any).n;
    if (!evidence) continue;
    // Nothing about this task changes between reconciler cycles, so a refusal
    // at this head will be refused again next cycle, and the cycle after that.
    // HIVE-473 wrote three identical 409s in two minutes and would have kept
    // going forever. Spend a small budget per head, then stop and say so once.
    if (autoMergeFailures(db, r.id, r.head_sha) >= MAX_AUTO_MERGE_ATTEMPTS) continue;
    try {
      const beforeMutation = () => {
        const task = getTask(db, r.id);
        if (!task || task.state !== "in_review" || task.ci_status !== "passing") return false;
        if (passedByDirector(db, r.id)) return false;
        if (queuedSteers(db, r.id).length || queuedInputRecoveryPending(db, r.id)) return false;
        return !db.query("SELECT 1 FROM events WHERE task_id = ? AND type = 'changes_requested' LIMIT 1").get(r.id);
      };
      const res = await mergeTask(db, h, r.id, {}, { exec: deps.exec }, { beforeMutation });
      if (res.status === 200) {
        writeEvent(db, { task_id: r.id, source: "reconciler", type: "auto_merged", payload: { ok: true, status: res.status } });
        enqueue(db, {
          kind: "auto_merged",
          task_id: r.id,
          title: `Auto-merged #${r.number}: ${r.title.slice(0, 70)}`,
          body: "Green CI, clean pre-review, evidence attached. Now verifying.",
        });
        continue;
      }
      recordAutoMergeFailure(db, r, res.status, await errorText(res));
    } catch (e) {
      recordAutoMergeFailure(db, r, null, String((e as any)?.message ?? e));
    }
  }
}

// Auto-answer: a decision card that sits past the project's timeout
// (config.decision_auto_answer_hours, off unless set) and carries a
// RECOMMENDED option gets answered with that recommendation — except
// risk='high' cards (authority/prod), which always wait for the human.
// The notification names what was chosen, so silence is informed consent,
// not surprise.
export function autoAnswerStale(db: DB, herdr: Herdr, nowMs: number = Date.now()): void {
  const rows = db
    .query(
      `SELECT d.id, d.task_id, d.ts, d.title, d.options, p.config FROM decisions d
         JOIN tasks t ON t.id = d.task_id JOIN projects p ON p.id = t.project_id
        WHERE d.status = 'open' AND COALESCE(d.risk, 'normal') != 'high' AND ${supervisedSql("t.source", "t.agent_target")}`
    )
    .all() as { id: string; task_id: string; ts: string; title: string; options: string; config: string }[];
  for (const r of rows) {
    if (isTrackingOnlyId(db, r.task_id)) continue;
    let hours = 0;
    try {
      hours = Number(JSON.parse(r.config ?? "{}").decision_auto_answer_hours) || 0;
    } catch {
      continue;
    }
    if (hours <= 0) continue;
    if (nowMs - Date.parse(r.ts) < hours * 3600_000) continue;
    let rec: any;
    try {
      rec = JSON.parse(r.options || "[]").find((o: any) => o.recommended);
    } catch {
      continue;
    }
    if (!rec?.key) continue;
    // An auto-answer is only meaningful when acting on the option needs nothing
    // further from the director. If the recommended option asks them to attach a
    // credential/token/file, answering it strands the agent — notify once and
    // leave the card open for a human (incident dec_8f964774097e).
    if (optionNeedsDirectorInput(rec)) {
      const already = db
        .query("SELECT 1 FROM events WHERE task_id = ? AND type = 'auto_answer_skipped' LIMIT 1")
        .get(r.task_id);
      if (already) continue;
      writeEvent(db, { task_id: r.task_id, source: "reconciler", type: "auto_answer_skipped", payload: { decision_id: r.id } });
      enqueue(db, {
        kind: "auto_answer_skipped",
        task_id: r.task_id,
        decision_id: r.id,
        title: `Needs you: "${r.title.slice(0, 70)}"`,
        body: `Open ${hours}h but the recommended option "${rec.label ?? rec.key}" needs you to supply something — not auto-answered.`,
      });
      continue;
    }
    apiAnswerDecision(db, herdr, r.id, {
      answer_key: rec.key,
      answer_note: `auto-answered with the recommended option after ${hours}h (project timeout policy — set decision_auto_answer_hours to 0 to disable)`,
      source: "system",
      actor: "reconciler-auto-answer",
    });
    enqueue(db, {
      kind: "auto_answered",
      task_id: r.task_id,
      decision_id: r.id,
      title: `Auto-answered "${rec.label ?? rec.key}": ${r.title.slice(0, 70)}`,
      body: `Open ${hours}h with a recommendation and no reply.`,
    });
  }
}

// Verifying watchdog: a task enters `verifying` exactly once (merge time) and
// smoke runs exactly once — a crash, restart, or the silent evidence-gate catch
// in smokeThenAdvance leaves it wedged forever with no signal. Sweep: re-run
// the advance for any verifying task idle past the threshold; if it STILL
// won't advance (the done gate wants evidence), steer the agent to attach it
// and tell the director once.
const VERIFY_WEDGE_MS = 15 * 60 * 1000;

export async function sweepVerifying(db: DB, deps: ReconcilerDeps = {}): Promise<void> {
  const nowMs = (deps.nowMs ?? (() => Date.now()))();
  const rows = db
    .query("SELECT id, title, updated_at FROM tasks WHERE state = 'verifying'")
    .all() as { id: string; title: string; updated_at: string }[];
  for (const r of rows) {
    if (isTrackingOnlyId(db, r.id)) continue;
    if (nowMs - Date.parse(r.updated_at) < VERIFY_WEDGE_MS) continue;
    try {
      await smokeThenAdvance(db, r.id, deps.smoke ?? {});
    } catch (e) {
      console.error(`[hive] verify sweep ${r.id}:`, e);
    }
    const after = getTask(db, r.id);
    if (after?.state !== "verifying") {
      broadcast({ type: "task", task: after });
      continue;
    }
    const already = db
      .query("SELECT 1 FROM events WHERE task_id = ? AND type = 'verify_wedged' LIMIT 1")
      .get(r.id);
    if (already) continue;
    writeEvent(db, { task_id: r.id, source: "reconciler", type: "verify_wedged", payload: {} });
    queueSteerEvent(
      db,
      r.id,
      "Your task is merged but WEDGED in verifying: the done gate needs at least one evidence item and " +
        "none is attached. Attach proof of the shipped behavior (screenshot/test output/log) with " +
        "`hive emit <task-id> evidence --file ... --note ...` — the task completes automatically after.",
      "queued by verify sweep"
    );
    enqueue(db, { kind: "stale", task_id: r.id, title: `Wedged in verifying (needs evidence): ${r.title}` });
  }
}

// Intake tasks wait for the director's review before dispatch — correct, but a
// forgotten one rots in `queued` invisibly. One reminder after a day.
const INTAKE_REMINDER_MS = 24 * 60 * 60 * 1000;

// ONE push for the whole post-ship catch-up, never one per shipped change.
// It fires at most once a day, and early only when the pile first reaches
// three. The last notified count lives in settings so the "reached three" nudge
// cannot repeat on every cycle.
export const QUIZ_DIGEST_MS = 24 * 60 * 60 * 1000;
export function notifyQuizDigest(db: DB, nowMs: number = Date.now()): void {
  const count = pendingPostShipQuizCount(db);
  if (count === 0) {
    setSetting(db, "quiz_digest_last_count", "0");
    return;
  }
  const lastCount = Number(getSetting(db, "quiz_digest_last_count") ?? "0");
  const last = db.query("SELECT ts FROM notifications WHERE kind = 'quiz_digest' ORDER BY ts DESC LIMIT 1").get() as { ts: string } | undefined;
  const dueDaily = !last || nowMs - Date.parse(last.ts) >= QUIZ_DIGEST_MS;
  const reachedThree = count >= 3 && lastCount < 3;
  if (!dueDaily && !reachedThree) return;
  setSetting(db, "quiz_digest_last_count", String(count));
  enqueue(db, {
    kind: "quiz_digest",
    urgency: "urgent",
    title: `Catch up on ${count} shipped ${count === 1 ? "change" : "changes"}`,
    body: "One pass, one question at a time. Open Needs you when you have a minute.",
  });
}

export function remindUnreviewedIntake(db: DB, nowMs: number = Date.now()): void {
  const rows = db
    .query(
      `SELECT id, title, created_at FROM tasks
        WHERE state = 'queued' AND source LIKE 'intake_%'
          AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.task_id = tasks.id AND n.kind = 'intake_unreviewed')`
    )
    .all() as { id: string; title: string; created_at: string }[];
  for (const r of rows) {
    if (nowMs - Date.parse(r.created_at) < INTAKE_REMINDER_MS) continue;
    if (isReviewed(db, r.id)) continue;
    enqueue(db, {
      kind: "intake_unreviewed",
      task_id: r.id,
      title: `Intake waiting on review for 24h+: ${r.title.slice(0, 70)}`,
      body: "It will never dispatch until reviewed (or cancelled).",
    });
  }
}

// A task parked in needs_decision with NOTHING open to answer is stuck forever
// and eats a dispatch slot (needs_decision counts as working): task #96 re-
// parked itself 16 minutes AFTER its card was answered, and the unpark that
// rides apiAnswerDecision had already fired into the void. The grace period
// covers the legitimate emit-needs-decision-then-open-card ordering. Exported
// for tests.
const UNPARK_GRACE_MS = 3 * 60 * 1000;

export function unparkAnswered(db: DB, nowMs: number = Date.now()): void {
  const rows = db
    .query(
      `SELECT t.id, t.updated_at FROM tasks t
        WHERE t.state = 'needs_decision'
          AND NOT EXISTS (SELECT 1 FROM decisions d WHERE d.task_id = t.id AND d.status = 'open')
          AND ${supervisedSql("t.source", "t.agent_target")}`
    )
    .all() as { id: string; updated_at: string }[];
  for (const r of rows) {
    if (isTrackingOnlyId(db, r.id)) continue;
    if (nowMs - Date.parse(r.updated_at) < UNPARK_GRACE_MS) continue;
    transition(db, r.id, "in_progress", {
      source: "reconciler",
      reason: "needs_decision with no open decision card — unparked",
    });
    queueSteerEvent(
      db,
      r.id,
      "You are parked in needs_decision but there is NO open decision card — everything you asked was " +
        "already answered (or expired). Read the answers in your task feed, act on them, and move the " +
        "task forward: emit ready (or done with evidence). If you truly need a decision, open a real card.",
      "queued by needs_decision unpark"
    );
    broadcast({ type: "task", task: getTask(db, r.id) });
  }
}

function flagStale(db: DB, deps: ReconcilerDeps): void {
  const staleMs = deps.staleMs ?? DEFAULT_STALE_MS;
  const nowMs = (deps.nowMs ?? (() => Date.now()))();
  // Only tasks that are actively worked (an agent could go silent).
  // needs_decision / in_review are parked on the DIRECTOR — silence there is
  // expected, and flagging it spawned pointless recovery nudges (2026-07-10).
  // Never-spawned tracking-only tasks are externally driven, and chat
  // supervisors are intentionally idle between turns/wakeups: neither gets
  // worker staleness. A manually-spawned external task has a real agent that
  // can go stale like any other, so it isn't exempt (supervisedSql).
  // A task deferred pending a human action
  // (deferred_until in the future) is intentionally parked — skip it so the
  // "gone quiet" nudge/notification never fires (task #679).
  const nowIso = new Date(nowMs).toISOString();
  const tasks = db
    .query(
      `SELECT id FROM tasks WHERE state IN ('in_progress','verifying') AND ${supervisedSql()}
         AND (deferred_until IS NULL OR deferred_until <= ?)`
    )
    .all(nowIso) as { id: string }[];
  for (const t of tasks) {
    if (isJiraMirrorId(db, t.id)) continue;
    // Held by the dependency gate: advanceFinished refuses to advance it and
    // dependency_blocked is deduped, so it stays intentionally quiet — never
    // stale (skipping the flag also spares it recoverStale, which the flag drives).
    if (unmetDeps(db, getTask(db, t.id)).length) continue;
    const last = db
      .query("SELECT ts, type FROM events WHERE task_id = ? ORDER BY ts DESC LIMIT 1")
      .get(t.id) as { ts: string; type: string } | undefined;
    if (!last) continue;
    if (last.type === "stale") continue; // already flagged; don't spam
    const age = nowMs - Date.parse(last.ts);
    if (age > staleMs) {
      writeEvent(db, {
        task_id: t.id,
        source: "reconciler",
        type: "stale",
        payload: { silent_ms: age, threshold_ms: staleMs },
      });
      const task = getTask(db, t.id);
      // A task can re-stale every cycle-plus-nudge round trip; the same title
      // notified 8× in a day (seen live). One stale notification per task per
      // 24h — the event log above still records every occurrence.
      const recent = db
        .query("SELECT 1 FROM notifications WHERE kind = 'stale' AND task_id = ? AND ts > ? LIMIT 1")
        .get(t.id, new Date(nowMs - 24 * 60 * 60 * 1000).toISOString());
      if (!recent) enqueue(db, { kind: "stale", task_id: t.id, title: `Task stale: ${task?.title ?? t.id}` });
    }
  }
}

// ---- stale recovery (observed → acted on) ----
// For each agent-bearing task whose newest event is `stale`, probe the agent
// and act (SPEC "Stale recovery"):
//   dead        → capture pane tail as evidence, fail, auto-requeue under a cap
//                 (MAX_AUTO_REQUEUE) then a decision card.
//   alive+silent → nudge via `herdr agent send`; after MAX_SILENT_NUDGES, fail
//                 and open a decision card.
// Each action re-arms the flow: writing an event resets the task's age, so the
// next stale flag (one threshold later) drives the next step — that spacing IS
// the requeue/nudge backoff.
async function recoverStale(db: DB, deps: ReconcilerDeps): Promise<void> {
  const h = deps.herdr ?? defaultHerdr;
  const nowMs = (deps.nowMs ?? (() => Date.now()))();
  const tasks = db
    .query(`SELECT id, agent_target FROM tasks WHERE agent_target IS NOT NULL AND COALESCE(source, '') != 'chat_supervisor' AND state IN ${RECOVERABLE}`)
    .all() as { id: string; agent_target: string }[];
  for (const t of tasks) {
    // A handed-off task (advanceFinished / director moved it to in_review, or it's
    // verifying) is owned by a human/the merge flow: a gone agent there is expected
    // (its work is done), so it must NOT be failed/requeued.
    const cur = getTask(db, t.id);
    // A JIRA MIRROR never has an agent of hive's, so there is nothing to
    // recover. A plain source='external' task with agent_target set DOES have
    // one (a recovery respawn, or a legacy pre-#996 manual dispatch), and a
    // dead agent there must still be failed rather than left in_progress
    // forever — scoping this to mirrors is what keeps both true.
    if (cur && isJiraMirror(cur)) continue;
    if (cur && agentWorkComplete(db, cur)) continue;
    // Deferred pending a human action: neither nudge nor fail it (the goneNow
    // branch below would otherwise fail an idle-but-deferred task) — task #679.
    if (cur && isDeferred(cur)) continue;
    // A vanished agent (syncAgents just recorded `gone`) recovers within THIS
    // cycle — the SPEC requires detecting a ghost within one cycle, not waiting
    // out the stale threshold. The silent path is driven by a `stale` flag,
    // read past agent_status noise so a status sync can't hide the flag.
    const goneNow = lastAgentStatus(db, t.id) === "gone";
    const meaningful = db
      .query("SELECT type FROM events WHERE task_id = ? AND type != 'agent_status' ORDER BY ts DESC LIMIT 1")
      .get(t.id) as { type: string } | undefined;
    const staleFlagged = meaningful?.type === "stale";
    if (!goneNow && !staleFlagged) continue;

    const { alive, status, unconfirmed } = await probeAgent(h, db, t.id, t.agent_target);
    if (unconfirmed) continue; // syncAgents already logged it; never recover on a guess
    if (!alive) {
      // Both teardown gates sit HERE, in front of the only path that fails and
      // requeues a task. A server that just booted, or a fleet-wide burst of
      // death verdicts, means hive is the thing that lost its footing — the
      // agents are processes and will still be there next lap.
      const blocked = teardownBlocked(db, nowMs, deps.instanceId);
      if (blocked) {
        console.log(`[hive] recovery held for ${t.id}: ${blocked}`);
        continue;
      }
      const dead = recentDeadVerdicts(db, nowMs);
      if (dead >= DEAD_BURST_N) {
        if (cur) openBreakerDecision(db, cur, dead, Math.round(DEAD_BURST_MS / 60_000));
        continue; // breaker now open: every later task this lap is held by teardownBlocked
      }
      await recoverDead(db, h, t.id, t.agent_target);
    } else if (staleFlagged) {
      // Quiet but WORKING is not stuck — long tool runs and big builds are
      // silent by nature. Only idle/blocked/unknown agents enter recovery.
      if (status === "working") continue;
      await recoverSilent(db, h, t.id, t.agent_target, deps);
    }
  }
}

async function recoverDead(db: DB, h: Herdr, taskId: string, target: string): Promise<void> {
  const task = getTask(db, taskId);
  if (!task || TERMINAL.includes(task.state as State)) return;
  // A respawn can land while the probe above is in flight: the verdict is about
  // the OLD agent, but the teardown below (and the cleanup the `failed`
  // transition fires) would execute against the FRESH tab/worktree, killing a
  // 100ms-old agent. Bail if the binding moved on.
  if (task.agent_target !== target) return;

  const tail = await h.read(target, 200);
  attachLog(db, taskId, tail, "agent pane tail at death (stale recovery)");
  await reclaimDeadWorktree(db, h, task);
  const attempts = requeueDepth(db, task); // requeues already made in this lineage
  writeEvent(db, { task_id: taskId, source: "reconciler", type: "recovery", payload: { decision: "dead", attempts } });
  transition(db, taskId, "failed", { source: "reconciler", reason: "agent vanished; recovered from stale" });

  if (attempts >= MAX_AUTO_REQUEUE) {
    openRecoveryDecision(db, task, attempts);
    enqueue(db, { kind: "failed", task_id: taskId, title: `Recovery cap reached: ${task.title}` });
  } else {
    const newId = requeueTask(db, task);
    writeEvent(db, { task_id: taskId, source: "reconciler", type: "requeued", payload: { new_task_id: newId, attempt: attempts + 1 } });
    {
      const t = getTask(db, taskId);
      if (t) recordSystemLearning(db, t.project_id, "agent died mid-task (auto-requeued)", `Task: ${t.title}`, taskId);
    }
    enqueue(db, { kind: "failed", task_id: taskId, title: `Auto-requeued (attempt ${attempts + 1}): ${task.title}` });
  }
}

// Reclaim a task's worktree before it's abandoned (dead-agent recovery,
// context-full requeue, or a manual fail+requeue): the next spawn on this
// branch (a respawn, or the director answering the recovery card) would
// otherwise collide with the lingering worktree. Preserves any uncommitted
// work to a ghost branch and records the `worktree_reclaimed` event that
// requeueTask's resume brief reads to surface it.
// Never fatal: a reclaim failure is recorded and recovery proceeds.
export async function reclaimDeadWorktree(db: DB, h: Herdr, task: any): Promise<void> {
  if (!task.branch || !task.worktree_path) return;
  const project = db.query("SELECT repo_path FROM projects WHERE id = ?").get(task.project_id) as
    | { repo_path: string | null }
    | undefined;
  if (!project?.repo_path) return;
  try {
    const r = await h.reclaimWorktree({
      repoPath: project.repo_path,
      branch: task.branch,
      taskId: task.id,
      hintPath: task.worktree_path,
    });
    writeEvent(db, {
      task_id: task.id,
      source: "reconciler",
      type: r.reclaimed ? "worktree_reclaimed" : "worktree_reclaim_skipped",
      payload: { ghost_branch: r.ghost_branch, path: r.path, reason: r.reason },
    });
  } catch (e) {
    writeEvent(db, {
      task_id: task.id,
      source: "reconciler",
      type: "worktree_reclaim_failed",
      payload: { error: String((e as any)?.message ?? e) },
    });
  }
}

// A usage-limited session is a hard wall with a printed reset time: nudging it
// re-triggers the same "hit your session limit" reply (one task burned 4 nudges
// over 47 minutes, then sat ~19h until a manual redispatch — the reset was 7
// minutes after the last nudge). Park it once with the parsed resume time;
// resumeUsageLimited() queues the wake-up steer when the clock passes.
function recoverUsageLimit(db: DB, task: any, excerpt: string): void {
  const open = db
    .query(
      `SELECT 1 FROM events WHERE task_id = ? AND type = 'usage_limit'
        AND ts > COALESCE((SELECT MAX(ts) FROM events WHERE task_id = ? AND type = 'usage_limit_resumed'), '')
        LIMIT 1`
    )
    .get(task.id, task.id);
  if (open) return; // already parked on this limit window; stay quiet
  const resumeAt = parseResetClock(excerpt, Date.now()) ?? new Date(Date.now() + 60 * 60 * 1000).toISOString();
  writeEvent(db, {
    task_id: task.id,
    source: "reconciler",
    type: "usage_limit",
    payload: { resume_at: resumeAt, excerpt: excerpt.slice(0, 300) },
  });
}

// The wake-up half: once a parked task's resume_at passes, queue a steer (the
// drain/respawn machinery delivers it) and mark the window resumed. A session
// answers normally again after its reset — observed live, task #105.
export function resumeUsageLimited(db: DB, nowMs: number = Date.now()): void {
  const rows = db
    .query(
      `SELECT e.task_id, MAX(e.ts) AS ts, json_extract(e.payload, '$.resume_at') AS resume_at
         FROM events e JOIN tasks t ON t.id = e.task_id
        WHERE e.type = 'usage_limit' AND t.state IN ('in_progress', 'needs_decision')
          AND e.ts > COALESCE((SELECT MAX(ts) FROM events WHERE task_id = e.task_id AND type = 'usage_limit_resumed'), '')
        GROUP BY e.task_id`
    )
    .all() as { task_id: string; resume_at: string | null }[];
  for (const r of rows) {
    if (isJiraMirrorId(db, r.task_id)) continue;
    if (!r.resume_at || Date.parse(r.resume_at) > nowMs) continue;
    queueSteerEvent(
      db,
      r.task_id,
      "Your usage-limit window has reset — you are unblocked. Re-read your last few steps, emit a status note, and continue the task.",
      "queued by usage-limit resume"
    );
    writeEvent(db, { task_id: r.task_id, source: "reconciler", type: "usage_limit_resumed", payload: { resume_at: r.resume_at } });
  }
}

async function recoverSilent(db: DB, h: Herdr, taskId: string, target: string, deps: ReconcilerDeps = {}): Promise<void> {
  const task = getTask(db, taskId);
  if (!task || TERMINAL.includes(task.state as State)) return;

  // Diagnose BEFORE nudging: the pane usually names the problem, and each
  // class has a graceful path. Nudge→fail is only for the truly unexplained.
  const tail = await h.read(target, 200);
  const diag = diagnosePane(tail);
  if (diag?.kind === "blocked_dialog") {
    await handleBlockedAgent(db, h, taskId, target);
    return;
  }
  if (diag?.kind === "auth_lost") return recoverAuthLost(db, h, task, diag.excerpt, tail, deps);
  if (diag?.kind === "context_full") return recoverContextFull(db, h, task, tail);
  if (diag?.kind === "usage_limit") return recoverUsageLimit(db, task, diag.excerpt);
  if (diag?.kind === "queued_input") return recoverQueuedInput(db, h, task, target, diag.excerpt);
  if (diag?.kind === "api_error") {
    // Transient (rate limit / network / overload): extend patience instead of
    // burning a nudge — this event resets the silence clock for one threshold.
    writeEvent(db, {
      task_id: taskId,
      source: "reconciler",
      type: "recovery",
      payload: { decision: "transient-api-error", excerpt: diag.excerpt.slice(0, 300) },
    });
    return;
  }

  const nudges = nudgesSinceActivity(db, taskId);
  if (nudges >= MAX_SILENT_NUDGES) {
    attachLog(db, taskId, tail, "agent pane tail at silent-escalation");
    writeEvent(db, { task_id: taskId, source: "reconciler", type: "recovery", payload: { decision: "silent-escalate", nudges } });
    transition(db, taskId, "failed", { source: "reconciler", reason: `agent silent; ${nudges} nudges ignored` });
    openRecoveryDecision(db, task, requeueDepth(db, task));
    enqueue(db, { kind: "failed", task_id: taskId, title: `Agent unresponsive: ${task.title}` });
  } else {
    let error: string | null;
    try {
      const r = await h.send(
        target,
        `hive: you've gone quiet. Reply with \`hive emit ${taskId} status --note "..."\` or say what's blocking you.`
      );
      error = sendFailure(r);
    } catch (e: any) {
      error = String(e?.message ?? e);
    }
    writeEvent(db, {
      task_id: taskId,
      source: "reconciler",
      type: "recovery_nudge",
      payload: { nudge: nudges + 1, delivered: error === null, ...(error ? { error } : {}) },
    });
    broadcastTask(db, getTask(db, taskId));
    if (error?.toLowerCase().includes(TURN_COMPLETE_RESPAWN)) await respawnCompletedTurn(db, h, task, deps);
  }
}

async function respawnCompletedTurn(db: DB, h: Herdr, task: any, deps: ReconcilerDeps): Promise<void> {
  const nowMs = (deps.nowMs ?? (() => Date.now()))();
  const blocked = teardownBlocked(db, nowMs, deps.instanceId);
  if (blocked) {
    writeEvent(db, { task_id: task.id, source: "reconciler", type: "recovery", payload: { decision: "turn-complete-respawn-held", reason: blocked } });
    return;
  }
  const dead = recentDeadVerdicts(db, nowMs);
  if (dead >= DEAD_BURST_N) {
    openBreakerDecision(db, task, dead, Math.round(DEAD_BURST_MS / 60_000));
    writeEvent(db, { task_id: task.id, source: "reconciler", type: "recovery", payload: { decision: "turn-complete-respawn-held", reason: "recovery breaker" } });
    return;
  }
  if (inBackoff(db, task.id, nowMs)) {
    writeEvent(db, { task_id: task.id, source: "reconciler", type: "recovery", payload: { decision: "turn-complete-respawn-held", reason: "spawn backoff" } });
    return;
  }
  const project = db.query("SELECT config FROM projects WHERE id = ?").get(task.project_id) as { config: string | null } | undefined;
  const config = JSON.parse(project?.config ?? "{}");
  const cap = Number.isFinite(config.max_agents) ? Number(config.max_agents) : MAX_AGENTS_DEFAULT;
  const otherAgents = db.query(`SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND id != ? AND agent_target IS NOT NULL AND COALESCE(source, '') != 'chat_supervisor' AND state IN ('in_progress','needs_decision')`).get(task.project_id, task.id) as { n: number };
  if (otherAgents.n >= cap) {
    writeEvent(db, { task_id: task.id, source: "reconciler", type: "recovery", payload: { decision: "turn-complete-respawn-held", reason: "project max_agents" } });
    return;
  }

  queueSteerEvent(db, task.id, `The prior agent turn completed before it received Hive's recovery nudge. Continue task ${task.id} from the existing branch and worktree.`, "queued for turn-complete respawn");
  const result = await spawnAgent(db, h, task.id, { supervise: deps.supervise, exec: deps.exec });
  writeEvent(db, {
    task_id: task.id,
    source: "reconciler",
    type: "recovery",
    payload: { decision: "turn-complete-respawn", respawned: result.ok, ...(result.ok ? { agent_target: result.agent_target } : { error: result.error }) },
  });
  broadcastTask(db, getTask(db, task.id));
}

export function requeueStaleFailed(db: DB, nowMs: number = Date.now()): void {
  const failed = db.query(`SELECT t.*, p.config AS project_config,
      COALESCE((SELECT MAX(ts) FROM events WHERE task_id = t.id AND type = 'state_change' AND json_extract(payload, '$.to') = 'failed'), t.updated_at) AS failed_at
    FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.state = 'failed'`).all() as any[];
  for (const task of failed) {
    const configured = JSON.parse(task.project_config ?? "{}").failed_triage_requeue_hours;
    const hours = configured === undefined ? DEFAULT_FAILED_TRIAGE_REQUEUE_HOURS : Number(configured);
    if (!Number.isFinite(hours) || hours <= 0 || nowMs - Date.parse(task.failed_at) < hours * 60 * 60 * 1000) continue;
    // A blanket skip on source='requeue' parked a lineage forever the moment
    // it was requeued once — including by a fleet-wide death wave, which kills
    // requeued tasks same as any other. Cap by depth instead, same escalation
    // line the dead-agent recovery path (recoverDead) uses: first/second
    // generation still auto-requeues past the triage window, deeper than that
    // parks for a human.
    const depth = requeueDepth(db, task);
    if (depth >= MAX_AUTO_REQUEUE) continue;
    if (db.query("SELECT 1 FROM events WHERE task_id = ? AND type IN ('changes_requested','requeued') LIMIT 1").get(task.id)) continue;
    const failure = db.query("SELECT source FROM events WHERE task_id = ? AND type = 'state_change' AND json_extract(payload, '$.to') = 'failed' ORDER BY ts DESC LIMIT 1").get(task.id) as { source: string } | undefined;
    if (failure?.source === "director") continue;

    const newId = requeueTask(db, task);
    writeEvent(db, { task_id: task.id, source: "reconciler", type: "requeued", payload: { new_task_id: newId, attempt: depth + 1, reason: "failed task exceeded triage window" } });
    writeEvent(db, { task_id: task.id, source: "reconciler", type: "recovery", payload: { decision: "failed-triage-auto-requeue", new_task_id: newId, attempt: depth + 1 } });
    enqueue(db, { kind: "failed", task_id: task.id, title: `Auto-requeued after ${hours}h awaiting triage: ${task.title}` });
  }
}

// ---- blocked-signal handler (herdr status -> immediate reaction) ----
// Called the moment syncAgents observes an agent flip to `blocked` (60s worst
// case), and again from recoverSilent as the backstop. Known-safe dialogs
// (read-only MCP tools + project config.dialog_auto_approve patterns) are
// answered automatically with "2" (yes, don't ask again in this worktree) so
// the same tool never re-prompts; everything else opens the answerable card.
export async function handleBlockedAgent(db: DB, h: Herdr, taskId: string, target: string): Promise<boolean> {
  const task = getTask(db, taskId);
  if (!task || TERMINAL.includes(task.state as State)) return false;
  const tail = await h.read(target, 200);
  const diag = diagnosePane(tail);
  if (diag?.kind === "auto_mode_setup") {
    const r = await h.answerDialog(target, "Escape");
    writeEvent(db, {
      task_id: taskId,
      source: "reconciler",
      type: "dialog_auto_declined",
      payload: { delivered: r.code === 0, kind: "auto_mode_setup", excerpt: diag.excerpt.slice(0, 300) },
    });
    return true;
  }
  if (diag?.kind === "trust_dialog") {
    const r = await h.answerDialog(target, "1");
    writeEvent(db, {
      task_id: taskId,
      source: "reconciler",
      type: "dialog_auto_approved",
      payload: { delivered: r.code === 0, kind: "workspace_trust", excerpt: diag.excerpt.slice(0, 300) },
    });
    return true;
  }
  if (diag?.kind === "queued_input") {
    await recoverQueuedInput(db, h, task, target, diag.excerpt);
    return true;
  }
  if (diag?.kind === "usage_limit") {
    // Catch the park the moment status flips (~60s), same as every other
    // dialog kind here — waiting for the 15-minute stale timer is exactly the
    // churn window that burned quota on 2026-08-26 (HIVE-451).
    recoverUsageLimit(db, task, diag.excerpt);
    return true;
  }
  if (diag?.kind !== "blocked_dialog") return false; // blocked but no visible dialog: leave to the silent path

  const project = db.query("SELECT config FROM projects WHERE id = ?").get(task.project_id) as { config: string } | undefined;
  let config: any = {};
  try {
    config = JSON.parse(project?.config ?? "{}");
  } catch {
    /* bad config never breaks recovery */
  }
  const extra: string[] = config.dialog_auto_approve ?? [];

  if (config.auto_answer_dialogs === true && (await autoAnswerBenignWrite(db, h, task, target, tail))) return true;

  if (dialogAutoApprovable(diag.excerpt, extra)) {
    const r = await h.answerDialog(target, "2");
    writeEvent(db, {
      task_id: taskId,
      source: "reconciler",
      type: "dialog_auto_approved",
      payload: { delivered: r.code === 0, excerpt: diag.excerpt.slice(0, 300) },
    });
    return true;
  }
  await recoverBlockedDialog(db, task, diag.excerpt, tail);
  return true;
}

// A live agent went idle with input still QUEUED but never consumed: the
// steer's own Enter landed (recorded `delivered`), Claude Code queued it
// exactly as its UI intends, and then the turn that should have drained the
// queue never started (task #1098, incident 2026-08-19 — director found 3
// steers sitting behind "Press up to edit queued messages" with no spinner
// since delivery). The keystroke sequence verified live to unstick it: Up
// (pulls the queued message into the editable input line) then Enter (submits
// it) — reused from answerDialog's key-then-Enter delivery. Runs every cycle
// syncAgents sees the idle status (~60s worst case), not gated behind the
// 15-minute stale threshold, since the pane already names the exact problem.
const MAX_QUEUED_INPUT_NUDGES = 3;

function queuedInputEpisode(
  db: DB,
  taskId: string
): { attempts: number; startedAt: string | null; latestDelivered: boolean | null | undefined } {
  const rows = db.query("SELECT type, ts, payload FROM events WHERE task_id = ? ORDER BY ts DESC, rowid DESC").all(taskId) as {
    type: string;
    ts: string;
    payload: string;
  }[];
  let n = 0;
  let startedAt: string | null = null;
  let latestDelivered: boolean | null | undefined;
  for (const r of rows) {
    if (r.type === "queued_input_recovered") {
      if (n === 0) latestDelivered = JSON.parse(r.payload).delivered;
      n++;
      startedAt = r.ts;
    } else if (r.type === "agent_status" || r.type === "stale") continue; // reconciler noise
    else break; // real activity resets the count
  }
  return { attempts: n, startedAt, latestDelivered };
}

async function recoverQueuedInput(db: DB, h: Herdr, task: any, target: string, excerpt: string): Promise<void> {
  const episode = queuedInputEpisode(db, task.id);
  if (episode.attempts >= MAX_QUEUED_INPUT_NUDGES) {
    if (episode.latestDelivered === null) return;
    const already = db
      .query("SELECT 1 FROM notifications WHERE kind = 'queued_input_stuck' AND task_id = ? AND ts >= ? LIMIT 1")
      .get(task.id, episode.startedAt);
    if (already) return; // already alerted; don't spam, and don't keep hammering the pane either
    enqueue(db, {
      kind: "queued_input_stuck",
      urgency: "urgent",
      task_id: task.id,
      title: `Agent idle with unconsumed queued input: ${task.title}`,
      body: `Sent Up+Enter to the pane ${MAX_QUEUED_INPUT_NUDGES}× but the queue never drained. Check the pane manually.\n\n${excerpt}`,
    });
    return;
  }
  const attempt = writeEvent(db, {
    task_id: task.id,
    source: "reconciler",
    type: "queued_input_recovered",
    payload: { delivered: null, excerpt: excerpt.slice(0, 300) },
  });
  let r = await h.answerDialog(target, "Up");
  if (r.code !== 0) r = await h.answerDialog(target, "Enter");
  const delivered = { ...attempt.payload, delivered: r.code === 0 };
  db.query("UPDATE events SET payload = ? WHERE id = ?").run(JSON.stringify(delivered), attempt.id);
  // No re-broadcast: the web timeline appends every SSE event rather than
  // replacing by id, so re-sending this same event id would show two rows
  // (#1234 review-15). Same tradeoff already accepted in steer.ts's
  // markSteersDelivered — the live feed shows the pending row until the next
  // full fetch (GET /api/feed), which reads the corrected payload.
}

// ---- graceful failure-class handlers (pane-diagnosed) ----

// The dialog is a codex file-write confirmation and every file it touches is
// the agent's own: answer it here instead of waking the director. Three of
// these were hand-approved on 2026-08-25, all of them review.json writes the
// agent had just been told to make. Opt-in per project (config.auto_answer_dialogs).
//
// "The agent's own" means its worktree, or a temp file named for this task —
// the two places a worker is told to write. Anything else (a path outside
// both, a `..` escape, a relative path we cannot resolve, a command approval
// rather than an edit) fails the check and still parks for the director.
const TEMP_ROOTS = ["/tmp/", "/private/tmp/", "/var/folders/"];

function ownedByTask(path: string, task: { id: string; number?: number | null; worktree_path?: string | null }): boolean {
  if (!path.startsWith("/") || path.includes("..")) return false;
  const wt = task.worktree_path;
  if (wt && path.startsWith(wt.replace(/\/$/, "") + "/")) return true;
  if (!TEMP_ROOTS.some((r) => path.startsWith(r))) return false;
  // A shared temp root is only "its own" when the name carries this task.
  return path.includes(task.id) || (task.number != null && path.includes(`-${task.number}-`));
}

async function autoAnswerBenignWrite(db: DB, h: Herdr, task: any, target: string, tail: string): Promise<boolean> {
  const paths = editDialogPaths(tail);
  if (!paths || !paths.every((p) => ownedByTask(p, task))) return false;
  // "1" = yes, proceed for THIS edit only. Never "2" (don't ask again for
  // these files): each write should re-clear the same bar.
  const r = await h.answerDialog(target, "1");
  writeEvent(db, {
    task_id: task.id,
    source: "supervisor",
    type: "dialog_auto_answered",
    payload: { delivered: r.code === 0, key: "1", paths, reason: "codex write inside the task's own worktree or scratchpad" },
  });
  return true;
}

// A dialog froze the agent: open ONE answerable card (approve/deny resolve by
// sending the keystroke to the pane — resolveBlockedForDecision in api.ts).
// The task parks in needs_decision instead of rotting to failed.
async function recoverBlockedDialog(db: DB, task: any, excerpt: string, tail: string): Promise<void> {
  const open = db
    .query("SELECT 1 FROM decisions WHERE task_id = ? AND status = 'open' AND title LIKE 'Agent blocked on a dialog%' LIMIT 1")
    .get(task.id);
  if (open) return; // card already waiting — don't spam
  attachLog(db, task.id, tail, "agent pane tail: blocked on a dialog");
  const firstLine = excerpt.split("\n").find((l) => l.trim()) ?? "permission prompt";
  const d = createDecision(db, {
    task_id: task.id,
    title: `Agent blocked on a dialog: ${firstLine.trim().slice(0, 70)}`,
    context:
      `The agent's pane is frozen on an interactive prompt. Answering here sends the keystroke to the pane remotely.\n\n${excerpt}`,
    risk: "medium",
    blast_radius: `agent ${task.agent_target} (task #${task.number})`,
    options: [
      { key: "approve", label: "Approve (option 1)", detail: "Send '1' + Enter to the pane; the agent continues." },
      { key: "deny", label: "Deny (option 3)", detail: "Send '3' + Enter; the agent is told no and adapts." },
    ],
  });
  writeEvent(db, { task_id: task.id, source: "reconciler", type: "blocked_card", payload: { decision_id: d.id } });
  // Re-read: createDecision may already have parked the task, and a redundant
  // transition throws (crashed the sync loop 2026-07-11).
  const fresh = getTask(db, task.id);
  if (fresh?.state === "in_progress")
    transition(db, task.id, "needs_decision", { source: "reconciler", reason: "agent blocked on an interactive dialog" });
  enqueue(db, { kind: "decision", task_id: task.id, decision_id: d.id, title: `Agent blocked on a dialog: ${task.title}`, urgency: "urgent" });
}

// The worker lost auth. Notifying the director is necessary but was the WHOLE
// recovery, and a notification does not unfreeze a pane: the agent sat at the
// login wall indefinitely while this very event reset its health clock, so the
// task read "healthy" lap after lap with a byte-identical tail (#1149/#1156,
// 2026-08-20 — two tasks flipped stale → auth-lost → healthy twice, 15 minutes
// apart, with zero real work in between).
//
// So: respawn, like any other agent that is not coming back on its own. Hive has
// no signal that a login was restored, and trying IS the signal — a respawn
// either revives the task or hits the same wall and says so. Rate-limited per
// task (HIVE_AUTH_RESPAWN_MS, 15m) so a still-broken login costs four spawns an
// hour instead of one a minute — the cooldown counts ATTEMPTS, not successes,
// so a spawn path that is itself broken cannot turn this into a retry storm.
// Never requeues: a fresh TASK would lose the
// worktree and its context for a problem that has nothing to do with the work.
const AUTH_RESPAWN_MS = Number(process.env.HIVE_AUTH_RESPAWN_MS || 15 * 60_000);

async function recoverAuthLost(db: DB, h: Herdr, task: any, excerpt: string, tail: string, deps: ReconcilerDeps = {}): Promise<void> {
  const nowMs = (deps.nowMs ?? (() => Date.now()))();
  const lastTry = db
    .query(
      `SELECT ts FROM events WHERE task_id = ? AND type = 'recovery'
         AND json_extract(payload, '$.decision') = 'auth-lost'
         AND json_extract(payload, '$.respawned') IS NOT NULL
       ORDER BY ts DESC LIMIT 1`
    )
    .get(task.id) as { ts: string } | undefined;
  // The `respawned` key is written ONLY on a lap that actually tried — it is the
  // cooldown's clock, and stamping it every lap would push the next attempt out
  // of reach forever.
  const due = !lastTry || nowMs - Date.parse(lastTry.ts) >= AUTH_RESPAWN_MS;
  const respawned = due ? (await spawnAgent(db, h, task.id, { supervise: deps.supervise })).ok : null;
  writeEvent(db, {
    task_id: task.id,
    source: "reconciler",
    type: "recovery",
    payload: { decision: "auth-lost", excerpt: excerpt.slice(0, 300), ...(due ? { respawned } : {}) },
  });
  const recent = db
    .query("SELECT 1 FROM notifications WHERE kind = 'auth_lost' AND ts > datetime('now', '-60 minutes') LIMIT 1")
    .get();
  if (recent) return;
  attachLog(db, task.id, tail, "agent pane tail: worker auth lost");
  enqueue(db, {
    kind: "auth_lost",
    task_id: task.id,
    title: "Agent authentication expired: workers cannot continue",
    body: "An agent pane shows 'Not logged in'. Restore the selected worker's login (`/login` for Claude Code or `codex login` for ChatGPT/Codex); hive retries each affected agent every 15 minutes, so the fleet comes back on its own once you do.",
    urgency: "urgent",
  });
  recordSystemLearning(db, task.project_id, "agent authentication expired mid-fleet", "Agents stall when their CLI login expires. Fix auth once; do not requeue (a fresh agent hits the same wall).", task.id);
}

// Context window exhausted: the ONE case where auto-requeue is exactly right —
// a fresh agent gets a fresh context. Capped by MAX_AUTO_REQUEUE like death.
async function recoverContextFull(db: DB, h: Herdr, task: any, tail: string): Promise<void> {
  attachLog(db, task.id, tail, "agent pane tail: context window exhausted");
  await reclaimDeadWorktree(db, h, task);
  const attempts = requeueDepth(db, task);
  writeEvent(db, { task_id: task.id, source: "reconciler", type: "recovery", payload: { decision: "context-full", attempts } });
  transition(db, task.id, "failed", { source: "reconciler", reason: "context window exhausted" });
  if (attempts >= MAX_AUTO_REQUEUE) {
    openRecoveryDecision(db, task, attempts);
    enqueue(db, { kind: "failed", task_id: task.id, title: `Context exhausted repeatedly — task may be too big: ${task.title}` });
    recordSystemLearning(db, task.project_id, "task repeatedly exhausts the context window (too big?)", `Task: ${task.title} — consider splitting it.`, task.id);
  } else {
    const fresh = requeueTask(db, task);
    writeEvent(db, { task_id: task.id, source: "reconciler", type: "requeued", payload: { new_task_id: fresh, attempt: attempts + 1, reason: "context-full" } });
    enqueue(db, { kind: "failed", task_id: task.id, title: `Context exhausted — requeued with fresh context: ${task.title}` });
  }
}

// Pane tail → an evidence row (kind=log) written to the evidence store.
function attachLog(db: DB, taskId: string, text: string, caption: string): void {
  const dir = join(evidenceDir(), taskId);
  mkdirSync(dir, { recursive: true });
  const name = `${Date.now()}_panetail.log`;
  const dest = join(dir, name);
  writeFileSync(dest, text ?? "");
  const ev = {
    id: newId("ev"),
    task_id: taskId,
    ts: now(),
    kind: "log",
    path: dest,
    url: `/evidence/${taskId}/${name}`,
    caption,
    meta: "{}",
  };
  db.query("INSERT INTO evidence (id, task_id, ts, kind, path, url, caption, meta) VALUES (?,?,?,?,?,?,?,?)")
    .run(ev.id, ev.task_id, ev.ts, ev.kind, ev.path, ev.url, ev.caption, ev.meta);
  broadcast({ type: "evidence", evidence: parseEvidence(ev) });
  writeEvent(db, { task_id: taskId, source: "reconciler", type: "evidence", payload: { evidence_id: ev.id, kind: "log", caption } });
}

// How many times this lineage has already been auto-requeued (walk the
// source='requeue' / parent_task_id chain back to the original task).
function requeueDepth(db: DB, task: any): number {
  let depth = 0;
  let cur: any = task;
  while (cur && cur.source === "requeue") {
    depth++;
    cur = cur.parent_task_id ? getTask(db, cur.parent_task_id) : null;
  }
  return depth;
}

// Consecutive recovery nudges since the last real activity (stale flags and the
// nudges themselves don't count as activity, so silence keeps accumulating).
// Only DELIVERED nudges count toward the escalation: failing a task for "3
// nudges ignored" when herdr never landed one is a lie. A permanently
// undeliverable agent is dead, and the dead branch (recoverDead) owns it — this
// one only ever runs on an agent that probed alive.
function nudgesSinceActivity(db: DB, taskId: string): number {
  const rows = db.query("SELECT type, payload FROM events WHERE task_id = ? ORDER BY ts DESC").all(taskId) as {
    type: string;
    payload: string;
  }[];
  let n = 0;
  for (const r of rows) {
    if (r.type === "recovery_nudge") {
      try {
        if (JSON.parse(r.payload).delivered === false) continue; // never landed; doesn't count
      } catch {}
      n++;
    } else if (r.type === "stale" || r.type === "agent_status") continue; // reconciler noise
    else break; // real activity resets the count
  }
  return n;
}

// Background loop. Started only from index.ts (never in tests).
export function startReconciler(db: DB, deps: ReconcilerDeps & { intervalMs?: number } = {}): () => void {
  return startLoop("reconciler", deps.intervalMs ?? 60_000, () => reconcileOnce(db, deps));
}
