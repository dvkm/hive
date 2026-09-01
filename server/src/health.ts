// Task HEALTH — a first-class, server-computed dimension separate from lifecycle
// state. Lifecycle alone is dishonest ("a stuck task still shows In Progress");
// health is the visible symptom the board surfaces so a ghost never looks like
// healthy work. This is the SINGLE source of truth: the web app must render
// health, never re-derive it.
//
// Health is a PURE function of DB rows (events + task) — no live herdr call in
// the request path. The reconciler is what turns live herdr probes into
// `agent_status` events (including `gone`), so health reads that recorded truth.
import type { DB } from "./db.ts";
import { getSetting, setSetting } from "./db.ts";
import { broadcast } from "./bus.ts";
import { isSupervisedTask, neverDispatched } from "./supervision.ts";
import { isDeferred, unmetDeps, lastAgentActivity, SKIP_REASONS, TERMINAL, type State } from "./state.ts";
import { taskIdentifier } from "./taskIdentifier.ts";
import { latestSidecar, latestSidecarBatch, type SidecarReport } from "./sidecar.ts";
import { reviewActionable, reviewActionableBatch } from "./reviewer.ts";
import { isReviewed } from "./dispatcher.ts";

export type HealthStatus = "healthy" | "deferred" | "silent" | "stuck" | "dead";

// Permanent skip reasons that are this TASK's problem, not a project setting —
// the ones worth an attention item rather than just a label.
const ATTENTION_SKIPS = new Set(["no_repo_path", "kind_excluded", "authority_denied"]);

const HEALTH_EVENT_TYPES = [
  "agent_status",
  "dialog_auto_approved",
  "dialog_auto_declined",
  "merge_failed",
  "merge_blocked_destructive",
  "merged",
  "pr_merged",
  "pr_synchronized",
  "ready_for_review",
  "state_change",
  "recovery_nudge",
  "stale",
  "hung",
];
export interface Health {
  status: HealthStatus;
  reason: string | null;
  since: string; // ISO ts the current condition began
}

// Tasks that hold (or should hold) a live agent get a health verdict. Queued
// tasks also get one after the reconciler identifies dead dependencies.
const HEALTH_STATES = new Set(["in_progress", "needs_decision", "in_review", "verifying"]);

// Did anything after the merge_failed at `sinceTs` actually resolve it?
// A landed merge (merged/pr_merged) is unambiguous. A re-handoff into review is
// NOT: neither path that writes one can see a merge conflict, because the
// conflict is against the BASE branch while the PR stays OPEN with its own
// checks green. The reconciler's PR poll (handOffToReview → a bare
// state_change{to:"in_review"}) bounces the task back ~60s later on green CI
// alone; advanceIfFinished (→ ready_for_review) fires on the next probe tick
// once the agent is idle, and a conflict-bounced task keeps the pr_url and
// evidence those gates check — so an agent that never got the rebase steer
// (a best-effort send, api.ts) still looks "finished". Both therefore need
// a pushed commit as evidence the agent pushed a fix, mirroring the guard
// changesRequestUnaddressed applies to the changes_requested bounce. The
// baseline is the head SHA as of the failure; the reconciler's FIRST-ever
// observation of a PR writes a pr_synchronized on an unchanged head, so only a
// LATER, DIFFERENT head counts as new work.
function headShaOf(e: { payload: string }): string | null {
  try {
    return JSON.parse(e.payload).head_sha ?? null;
  } catch {
    return null;
  }
}
function pushedSince(events: { type: string; ts: string; payload: string }[], sinceTs: string): boolean {
  const prior = events.find((e) => e.type === "pr_synchronized" && e.ts <= sinceTs); // DESC → newest at-or-before
  let baseline = prior ? headShaOf(prior) : null;
  for (const e of events.filter((x) => x.type === "pr_synchronized" && x.ts > sinceTs).reverse()) {
    const sha = headShaOf(e);
    if (baseline === null) {
      baseline = sha; // head at failure time was unknown → first observation is the baseline
      continue;
    }
    if (sha !== null && sha !== baseline) return true;
  }
  return false;
}
function mergeFailureResolved(events: { type: string; ts: string; payload: string }[], sinceTs: string): boolean {
  const after = events.filter((e) => e.ts > sinceTs);
  if (after.some((e) => e.type === "merged" || e.type === "pr_merged")) return true;
  if (!pushedSince(events, sinceTs)) return false;
  return after.some((e) => {
    if (e.type === "ready_for_review") return true;
    if (e.type !== "state_change") return false;
    try {
      return JSON.parse(e.payload).to === "in_review";
    } catch {
      return false;
    }
  });
}

function staleMs(): number {
  return Number(process.env.HIVE_STALE_MS || 15 * 60 * 1000);
}

// Derivation (precedence dead > stuck > silent > healthy):
//   dead   — agent_target set but herdr reports the agent gone (latest
//            agent_status = "gone", written by the reconciler's probe).
//   stuck  — herdr reports `blocked` and no later automatic dialog recovery
//            succeeded, OR a stale-recovery escalation is in flight (the
//            newest event is `stale`/`recovery_nudge`).
//   silent — no activity events past the stale threshold, agent still alive.
//   healthy — otherwise.
export function computeHealth(db: DB, task: any, nowMs = Date.now()): Health | null {
  if (task.state === "queued") {
    const blocking = unmetDeps(db, task);
    const marker = blocking.length && blocking.every((dep) => TERMINAL.includes(dep.state as State))
      ? db.query("SELECT ts FROM events WHERE task_id = ? AND type = 'dead_dependencies' ORDER BY ts DESC LIMIT 1").get(task.id) as { ts: string } | undefined
      : undefined;
    if (marker) return { status: "stuck", reason: "all blocking dependencies ended without completing", since: marker.ts };
    // A dispatcher skip the task itself can never grow out of (HIVE-525): no
    // repo, an excluded kind, an authority deny. Project-wide switches
    // (auto_dispatch off, gardener off, tracking-only) are deliberate and shared
    // by every queued task there, so they stay a visible label on the card and
    // do NOT each raise an attention item.
    if (task.skip_reason && ATTENTION_SKIPS.has(task.skip_reason))
      return { status: "stuck", reason: SKIP_REASONS[task.skip_reason].label, since: task.skip_reason_at ?? task.updated_at };
  }
  if (!HEALTH_STATES.has(task.state)) return null;
  // Health is agent-derived, so it needs a bound agent — with one exception: a
  // task in review whose agent was RELEASED (cleanup.releaseReviewAgent) is
  // parked on the director, and its merge-failure symptom must stay visible.
  // The liveness branches below stay gated on agent_target so a leftover
  // `gone`/`blocked` status event can't read as a dead agent that no longer exists.
  if (!task.agent_target && task.state !== "in_review") return null;

  // Deferred pending an OFFLINE human action (state.ts's deferTask/isDeferred):
  // the agent exits normally right after emitting `deferred`, herdr reports it
  // gone, and the dead/stuck branches below would otherwise re-surface exactly
  // the "gone quiet" nag `deferred` exists to suppress (task #1078).
  // Reported as its own status, not as "healthy": a consumer that only reads
  // health.status would otherwise see parked work as ordinary working work, and
  // one that treats "not healthy" as trouble would nag about it. `deferred` says
  // exactly what is true — unfinished, deliberately quiet, waiting on a human
  // (HIVE-547). It is NOT an attention status (needsAttention below).
  if (isDeferred(task, nowMs)) {
    return { status: "deferred", reason: "parked pending a human action", since: task.updated_at as string };
  }

  const events = db
    .query(`SELECT type, ts, payload FROM events
      WHERE task_id = ? AND type IN (${HEALTH_EVENT_TYPES.map(() => "?").join(",")})
      ORDER BY ts DESC`)
    .all(task.id, ...HEALTH_EVENT_TYPES) as { type: string; ts: string; payload: string }[];

  // Latest recorded liveness from the reconciler's probe.
  let lastStatus: string | null = null;
  let lastStatusTs = task.updated_at as string;
  for (const e of events) {
    if (e.type === "agent_status") {
      try {
        lastStatus = JSON.parse(e.payload).status ?? null;
      } catch {
        /* ignore */
      }
      lastStatusTs = e.ts;
      break;
    }
  }

  if (task.agent_target && lastStatus === "gone")
    return { status: "dead", reason: "agent gone from herdr", since: lastStatusTs };
  const dialogRecovered = events.find((e) => {
    if (e.ts <= lastStatusTs || (e.type !== "dialog_auto_approved" && e.type !== "dialog_auto_declined")) return false;
    try {
      return JSON.parse(e.payload).delivered === true;
    } catch {
      return false;
    }
  });
  if (task.agent_target && lastStatus === "blocked" && !dialogRecovered)
    return { status: "stuck", reason: "agent blocked (waiting on you)", since: lastStatusTs };

  // A merge failure's reason must stay visible past the moment the task
  // bounces back to in_progress (or stays in_review on a non-conflict
  // failure) — otherwise it reads as generic recent activity and the reason
  // vanishes within moments (task #322). It stays until something newer
  // actually resolves it: a landed merge, or a re-handoff carrying evidence
  // the agent pushed a fix.
  if (task.state === "in_progress" || task.state === "in_review") {
    const mergeFailedEvent = events.find((e) => e.type === "merge_failed" || e.type === "merge_blocked_destructive");
    if (mergeFailedEvent && !mergeFailureResolved(events, mergeFailedEvent.ts)) {
      let reason = "merge failed";
      try {
        const payload = JSON.parse(mergeFailedEvent.payload);
        if (mergeFailedEvent.type === "merge_blocked_destructive") {
          const regressed = Array.isArray(payload.regressed) ? payload.regressed : [];
          const files = regressed.length
            ? regressed.slice(0, 10).join(", ") + (regressed.length > 10 ? `, …(+${regressed.length - 10})` : "")
            : "unknown files";
          reason = `merge blocked: ${payload.reason || `branch '${payload.branch}' reverts base work outside this task's scope (${files})`}`;
        } else {
          reason = `merge failed: ${payload.reason || "unknown error"}`;
        }
      } catch {
        /* ignore */
      }
      return { status: "stuck", reason, since: mergeFailedEvent.ts };
    }
  }

  // Parked waiting on the DIRECTOR (a decision card or a review), not the
  // agent: silence is expected, so age-based silent/stuck must not apply
  // ("stale recovery in progress" on a needs_decision task, 2026-07-10).
  // dead/blocked above still surface honestly.
  if (task.state === "needs_decision" || task.state === "in_review")
    return { status: "healthy", reason: null, since: task.updated_at as string };

  // "Activity" means the AGENT did something. Only its own rows count (see
  // lastAgentActivity): every row hive writes ABOUT a task, and every human
  // poke, would otherwise reset this clock and make a frozen task read healthy.
  // Two ways that already bit us: hive re-diagnosed an auth-lost pane every lap
  // and each `recovery` row reset the clock, so a frozen pane read HEALTHY lap
  // after lap with a byte-identical tail (#1149/#1156, 2026-08-20); and a
  // refused respawn wrote spawn_error + authority_logged, dropping a task
  // frozen for 2.5h off the stall list (hive-1951, 2026-08-31).
  const activityTs = lastAgentActivity(db, task.id) ?? (task.updated_at as string);
  const age = nowMs - Date.parse(activityTs);

  // Recovery is underway if hive nudged AFTER the last real activity. Keyed off
  // activityTs rather than "is it the newest event", which any trailing
  // bookkeeping row would silently defeat.
  const nudge = events.find((e) => e.type === "recovery_nudge" && e.ts > activityTs);
  if (nudge) return { status: "stuck", reason: "stale recovery in progress", since: nudge.ts };
  // Finished-without-a-PR (or genuinely stuck): an idle agent (it stopped working)
  // on an in_progress task that opened no PR and has gone quiet is either done but
  // never handed off, or wedged. Surface it in the attention tray instead of the
  // quiet "silent" that hides forever. A PR-bearing idle task is auto-advanced to
  // in_review by the reconciler, so it never reaches here; scouts hand off via a
  // report and are advanced too.
  if (task.state === "in_progress" && task.kind !== "scout" && (lastStatus === "idle" || lastStatus === "done") && !task.pr_url && age > staleMs()) {
    return { status: "stuck", reason: `finished or stuck: agent ${lastStatus}, no PR`, since: activityTs };
  }
  if (age > staleMs()) {
    // Flagged hung: the agent still holds the task but the WORK stopped. Say so
    // in the reason, because it needs a human look, not another respawn.
    const hung = events.find((e) => e.type === "hung" && e.ts > activityTs);
    if (hung) {
      const mins = Math.round(age / 60000);
      return { status: "stuck", reason: `no progress for ${mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`} (agent still alive)`, since: activityTs };
    }
    const escalating = events.some((e) => e.type === "stale" && e.ts > activityTs);
    return {
      status: escalating ? "stuck" : "silent",
      reason: escalating ? "stale recovery in progress" : "no activity",
      since: activityTs,
    };
  }
  return { status: "healthy", reason: null, since: activityTs };
}

// Server-global herdr-outage signal for /api/health. The dispatcher's circuit
// breaker (hive-682) writes herdr_backoff_until/herdr_outage_streak while the
// herdr daemon is down and keeps refreshing last_dispatch_at, so the plain
// dispatcher-liveness check reads "healthy" even though nothing spawns for the
// whole cooldown. This makes a sustained outage observable: non-null ONLY while
// the backoff window is still in the future (settings keys absent → null).
export function herdrOutage(db: DB, nowMs = Date.now()): { paused_until: string; streak: number } | null {
  const pausedUntil = getSetting(db, "herdr_backoff_until");
  if (!pausedUntil || nowMs >= Date.parse(pausedUntil)) return null;
  return { paused_until: pausedUntil, streak: Number(getSetting(db, "herdr_outage_streak") ?? "0") };
}

// PTY / herdr-session utilization for /api/health. The pty pool is a hard, low
// OS cap (macOS kern.tty.ptmx_max=511) and its exhaustion is SILENT — it hit
// 511/511 twice on 2026-07-25 with no signal, and no new agent could spawn.
// This makes the number visible before it hits the wall. The reaper records the
// live pane count each cycle (herdr_pane_count); a leak shows up as this
// climbing past the working set of ~45-60. null until the first sweep has run.
// ponytail: cap from env, default the macOS kern.tty.ptmx_max=511; warn at 80%.
export function sessionUtilization(
  db: DB
): { panes: number; max: number; pct: number; warn: boolean; at: string | null } | null {
  const raw = getSetting(db, "herdr_pane_count");
  if (raw === null) return null;
  const panes = Number(raw);
  const max = Number(process.env.HIVE_PTY_MAX || 511);
  const warnPct = Number(process.env.HIVE_PTY_WARN_PCT || 0.8);
  const pct = max > 0 ? panes / max : 0;
  return { panes, max, pct: Math.round(pct * 100) / 100, warn: pct >= warnPct, at: getSetting(db, "herdr_pane_at") };
}

// A task row enriched with its computed health, for API responses + SSE.
// Failed tasks also carry `requeued_to` (their auto-requeue successor's id, if
// any) so the attention rule can tell "awaiting triage" from "already retried".
export function taskWithHealth(db: DB, task: any, sidecar?: SidecarReport | null, actionable?: Set<string>): any {
  const requeued_to =
    task.state === "failed"
      ? ((db.query("SELECT id FROM tasks WHERE parent_task_id = ? AND source = 'requeue' LIMIT 1").get(task.id) as any)?.id ?? null)
      : null;
  const needs_you_since = ["in_review", "failed"].includes(task.state)
    ? task.needs_you_since ?? (db.query(
        "SELECT MAX(ts) AS ts FROM events WHERE task_id = ? AND type = 'state_change' AND json_extract(payload, '$.to') = ?"
      ).get(task.id, task.state) as { ts: string | null }).ts ?? task.updated_at
    : null;
  // Server-computed so the web app never has to re-derive "was this ever
  // spawned" from raw event history — see supervision.ts's neverDispatched.
  // `sidecar` is the latest background check on this task's own commits, so the
  // board card and the review card can show it without fetching every event.
  // Pass a preloaded `sidecar` when enriching a list (see tasksWithHealth) so
  // this doesn't run one sidecar query per task.
  // `review_actionable` (HIVE-500) is server-computed for the same reason health
  // is: it reads events the browser never sees. Only in-review tasks carry it;
  // everywhere else it is false and means nothing.
  //
  // Intake tasks are held until reviewed (dispatcher.ts's isReviewed), and
  // intake triage can mark one reviewed on its own — so the board needs the
  // flag to know whether to say "unreviewed". Only intake tasks pay the query.
  const reviewed = task.source?.startsWith("intake_") ? isReviewed(db, task.id) : undefined;
  // Why the dispatcher last skipped this task, resolved to something a human can
  // read (HIVE-525). `permanent` is the distinction that matters on the board:
  // "not yet" (capacity, backoff, a blocker) versus "not ever until someone
  // changes something". Only queued tasks can carry one.
  const skip = task.skip_reason && SKIP_REASONS[task.skip_reason]
    ? { reason: task.skip_reason, ...SKIP_REASONS[task.skip_reason], since: task.skip_reason_at ?? null }
    : null;
  return { ...task, display_id: taskIdentifier(db, task), health: computeHealth(db, task), requeued_to, needs_you_since, never_dispatched: neverDispatched(db, task), review_actionable: actionable ? actionable.has(task.id) : reviewActionable(db, task), reviewed, skip, sidecar: sidecar !== undefined ? sidecar : latestSidecar(db, task.id) };
}

// Batched form of taskWithHealth for list endpoints (task HIVE-447): looks up
// every task's sidecar report in one grouped query instead of one per task, and
// the same for `review_actionable` (HIVE-500), whose per-task rule reads up to
// five tables.
export function tasksWithHealth(db: DB, tasks: any[]): any[] {
  const sidecars = latestSidecarBatch(db, tasks.map((t) => t.id));
  const actionable = reviewActionableBatch(db, tasks);
  return tasks.map((task) => taskWithHealth(db, task, sidecars.get(task.id) ?? null, actionable));
}

// "Needs attention" tray eligibility (the single rule; the web mirrors it):
// a `failed` task awaiting human triage, OR a live task whose agent is dead or
// stuck and is not already waiting for a decision or review. Requires a task
// already carrying its computed `health` field.
// Unsupervised tasks (chat_supervisor sessions, never-spawned source='external'
// tracking entries) are not director action items.
// A failed task with a requeue successor was already triaged by the recovery
// loop — its successor is the live card; showing both read as "stuck forever".
export function needsAttention(task: { state: string; source?: string | null; agent_target?: string | null; health?: Health | null; requeued_to?: string | null }): boolean {
  if (!isSupervisedTask(task)) return false;
  if (task.state === "in_review" || task.state === "needs_decision") return false;
  if (task.state === "failed") return !task.requeued_to;
  return !!task.health && (task.health.status === "dead" || task.health.status === "stuck");
}

// Broadcast a task-changed SSE message carrying fresh health. Use this instead
// of a raw `broadcast({type:"task"})` so every board update reflects health.
export function broadcastTask(db: DB, task: any): void {
  broadcast({ type: "task", task: taskWithHealth(db, task) });
}

// A tool that cannot start is skipped and retried forever by design, so once it
// stops throwing it also stops counting toward reconciler_error_streak and
// would go completely silent. That is the #1096 failure mode again: PR linking
// quietly off, /api/health saying ok. Three consecutive cycles of start
// failures log once and mark health degraded; the first good cycle clears it.
const TOOL_DEGRADED_AFTER = 3;
export function noteToolStart(db: DB, tool: string, failure: string | null): void {
  const streakKey = `tool_start_failures_${tool}`;
  const degradedKey = `tool_degraded_${tool}`;
  if (!failure) {
    if (getSetting(db, streakKey)) setSetting(db, streakKey, "0");
    if (getSetting(db, degradedKey)) setSetting(db, degradedKey, "");
    return;
  }
  const streak = Number(getSetting(db, streakKey) ?? "0") + 1;
  setSetting(db, streakKey, String(streak));
  if (streak < TOOL_DEGRADED_AFTER) return;
  if (!getSetting(db, degradedKey)) console.error(`[hive] ${tool} failed to start on ${streak} cycles in a row; marking health degraded: ${failure}`);
  setSetting(db, degradedKey, failure);
}
