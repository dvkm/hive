// The dispatcher: the piece that makes hive self-driving. A coarse loop (default
// every 30s, HIVE_DISPATCH_MS) that picks up `queued` tasks and spawns a herdr
// agent for each, subject to opt-in project policy and safety gates:
//
//   - per-project config `auto_dispatch: true` is required for ordinary queued
//     work (default off, so intake drafts/setup tasks never auto-spawn). Tasks
//     explicitly delegated by an active chat manager bypass this one toggle.
//   - `dispatch_kinds` (default ["ship","scout"]) — chore tasks (usually titled
//     for a human) are excluded by default.
//   - source='intake_*' tasks (gchat messages, director braindumps) are skipped
//     until reviewed (a `reviewed` event or a `note` event containing the word
//     "reviewed"; the intake connector's own "UNREVIEWED ..." marker does NOT
//     count — see isReviewed()). Intake text is raw input, never a brief.
//   - `max_agents` (default 3) — concurrency cap per project.
//   - authority gate: authorize(action="task.dispatch") must resolve to `allow`;
//     a `deny` or `require_decision` rule blocks the auto-spawn.
//   - spawn failures back off exponentially per task (30s * 2^(n-1), capped at
//     30m) so a broken repo never retry-storms; the task stays queued with the
//     spawn_error event visible.
//
// The actual spawn (worktree + agent start + events + queued->in_progress) is
// the shared spawnAgent() core, so the auto path and the manual /spawn endpoint
// behave identically.
//
// Each cycle also runs a REATTACH pass first: a live task that has no agent but
// does have queued steers (feedback nobody could deliver) gets one respawned onto
// its existing branch/worktree, with the feedback in its brief. That is the other
// half of releasing review-parked agents (cleanup.releaseReviewAgent) — the
// release frees the slot, this brings the agent back when review talks back.
import type { DB } from "./db.ts";
import { parseTask } from "./rows.ts";
import { isOffline, setSetting, getSetting, now } from "./db.ts";
import { Herdr, herdr as defaultHerdr, isHerdrUnreachable } from "./runtime/herdr.ts";
import { authorize } from "./authority.ts";
import { spawnAgent } from "./api.ts";
import { unmetDeps, noteDependencyBlock } from "./state.ts";
import { isTrackingOnlyTask } from "./supervision.ts";
import { queuedSteers } from "./steer.ts";
import { managingThreadForTask } from "./chat.ts";
import { repoMismatchUnresolved } from "./repoTarget.ts";
import type { Exec } from "./exec.ts";

// Chores included since 2026-07-12: the queue sat at 10 tasks / 1 live agent
// because 9 were agent-filed follow-up FIXES tagged chore — "chores are titled
// for a human" stopped being true once agents started fanning out work. The
// guards that matter stay: manager delegation/auto_dispatch, intake review,
// max_agents, authority. Exclude chores per project via config.dispatch_kinds.
const DISPATCH_KINDS_DEFAULT = ["ship", "scout", "chore"];
const MAX_AGENTS_DEFAULT = 3;
const BACKOFF_BASE_MS = 30_000;
// Global herdr-daemon-down circuit breaker. When a spawn fails because the herdr
// control socket is unreachable (not a per-task fault), pause ALL dispatch for a
// cooldown that grows with consecutive outage cycles, capped low so recovery is
// detected within minutes. Collapses the 260× ConnectionRefused storm (every
// queued task pounding a dead daemon) to ~one probe per cooldown.
const HERDR_OUTAGE_BASE_MS = 30_000;
const HERDR_OUTAGE_CAP_MS = 5 * 60 * 1000;
const BACKOFF_CAP_MS = 30 * 60 * 1000;
// States that count as "working" for the max_agents cap. in_review/verifying
// agents are parked waiting on the DIRECTOR — counting them froze the whole
// pipeline whenever the review queue filled (seen live 2026-07-10: 3 PRs in
// review, 25 tasks queued, zero dispatch). They still bound total pipeline
// depth via REVIEW_OVERHANG below.
const WORKING_STATES = "('in_progress','needs_decision')";
const ACTIVE_STATES = "('in_progress','needs_decision','in_review','verifying')";
// ponytail: fixed 2× multiplier — total live agents (incl. review-parked) may
// reach max_agents*2 before dispatch pauses; make it config if it ever matters.
// Both counts key on agent_target, so a review agent RELEASED after handoff
// (cleanup.releaseReviewAgent) drops out of them: the overhang now bounds live
// agents rather than review depth, which is what it was always meant to bound —
// 10 idle review agents held corebeat at 3 running against 19 queued.
const REVIEW_OVERHANG = 2;

export interface DispatcherDeps {
  herdr?: Herdr;
  nowMs?: () => number; // injectable clock (tests + backoff)
  supervise?: boolean; // start the herdr wait loop after spawn (prod wiring)
  hiveUrl?: string;
  exec?: Exec; // injectable subprocess for the setup_argv spawn hook (tests pass a stub)
}

// One dispatch pass. Isolated per task so one bad task never stops the rest.
export async function dispatchOnce(db: DB, deps: DispatcherDeps = {}): Promise<void> {
  const startedAt = Date.now();
  // Liveness heartbeat, written only once a cycle actually COMPLETES (every
  // return path below), so /api/health can tell "loop finished, nothing to do"
  // apart from "loop started but wedged mid-cycle" — a fresh setInterval tick
  // must not re-mark it fresh while the previous invocation is still hung.
  // (incident 2026-07-17: the dispatcher went silently dead for 3.5h with no
  // outward signal — the process kept serving API + reaper.) The isOffline
  // early return is a legitimate no-op completion, so it heartbeats too.
  if (isOffline(db)) {
    setSetting(db, "last_dispatch_at", now());
    console.log(`[hive] dispatcher run: duration_ms=${Date.now() - startedAt} steps=0 errors=0 outcome=offline`);
    return; // offline mode: drain — nothing new spawns
  }
  const h = deps.herdr ?? defaultHerdr;
  const nowMs = (deps.nowMs ?? (() => Date.now()))();

  // herdr-down circuit breaker: a prior cycle hit an unreachable daemon and set a
  // global cooldown. Skip dispatch entirely (don't pound the dead socket once per
  // queued task) but still heartbeat — the dispatcher IS alive, just cooling down,
  // and /api/health must not read this as a wedged loop.
  const backoffUntil = getSetting(db, "herdr_backoff_until");
  if (backoffUntil && nowMs < Date.parse(backoffUntil)) {
    setSetting(db, "last_dispatch_at", now());
    return;
  }

  const queued = db
    .query("SELECT * FROM tasks WHERE state = 'queued' ORDER BY created_at ASC")
    .all()
    .map(parseTask);

  // Reattach candidates: a live task with NO agent but feedback waiting for one.
  // Two ways in — the agent was released at review handoff
  // (cleanup.releaseReviewAgent), or it died — and one shape: the feedback sits
  // as QUEUED steers (the CI-red / closed-PR / conflict / merge-failure paths all
  // queue one when they can't deliver). Respawning here puts a fresh agent on the
  // SAME branch and worktree with that feedback at the top of its brief
  // (spawnAgent's steer preamble). Before this, such a task sat in_progress with
  // nobody on it until it aged into a stale notification.
  const reattach = db
    .query(`SELECT * FROM tasks WHERE agent_target IS NULL AND state IN ('in_progress','in_review','verifying') ORDER BY updated_at ASC`)
    .all()
    .map(parseTask)
    .filter((t: any) => !isTrackingOnlyTask(t) && t.source !== "chat_supervisor" && queuedSteers(db, t.id).length > 0);

  let errors = 0;
  const projectCache = new Map<string, { repo_path: string | null; config: any } | null>();
  const workingCount = new Map<string, number>(); // per-project working slots used
  const activeCount = new Map<string, number>(); // per-project live agents incl. review-parked

  const getProject = (pid: string) => {
    if (!projectCache.has(pid)) {
      const r: any = db.query("SELECT repo_path, config FROM projects WHERE id = ?").get(pid);
      projectCache.set(pid, r ? { repo_path: r.repo_path, config: JSON.parse(r.config ?? "{}") } : null);
    }
    return projectCache.get(pid)!;
  };
  const countFor = (cache: Map<string, number>, states: string, pid: string) => {
    if (!cache.has(pid)) {
      const row: any = db
        .query(`SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND agent_target IS NOT NULL AND COALESCE(source, '') != 'chat_supervisor' AND state IN ${states}`)
        .get(pid);
      cache.set(pid, row.n as number);
    }
    return cache.get(pid)!;
  };
  const workingFor = (pid: string) => countFor(workingCount, WORKING_STATES, pid);
  const activeFor = (pid: string) => countFor(activeCount, ACTIVE_STATES, pid);

  // One project's queued tasks, spawned serially. spawnAgent runs the project's
  // setup_argv hook inside the worktree-ready callback (api.ts), which can take
  // up to its 120s timeout (e.g. bringing up a docker stack). Kept serial WITHIN
  // a project because herdr serializes worktree-create globally with only a
  // single retry — firing a project's spawns concurrently would spawn_error on
  // the create step. Different projects run concurrently (see below), so a slow
  // setup on one project no longer stalls dispatch for the others.
  // Set true the moment any spawn reports the herdr daemon unreachable; every
  // concurrent project loop bails out so a dead daemon is probed once, not once
  // per queued task. Single-threaded async makes the check-then-set race-free.
  let herdrDown = false;
  // Shared spawn tail: cap bookkeeping + the herdr-outage circuit breaker.
  // Returns false when the daemon is down and the whole cycle must bail.
  const spawnFor = async (task: any): Promise<boolean> => {
    const r = await spawnAgent(db, h, task.id, { hiveUrl: deps.hiveUrl, supervise: deps.supervise, exec: deps.exec });
    if (r.ok) {
      workingCount.set(task.project_id, workingFor(task.project_id) + 1);
      activeCount.set(task.project_id, activeFor(task.project_id) + 1);
      clearHerdrOutage(db); // daemon answered — reset the outage streak
    } else if (isHerdrUnreachable(r.error) && !herdrDown) {
      herdrDown = true; // first hit sets the global cooldown; rest of the cycle bails
      noteHerdrOutage(db, nowMs);
      return false;
    }
    // On failure spawnAgent already wrote a single spawn_error event; the
    // backoff above governs the next attempt (no immediate retry).
    return true;
  };

  const dispatchProject = async (group: { reattach: typeof queued; queued: typeof queued }) => {
    // Feedback on work already in flight comes back BEFORE new work starts —
    // otherwise a bounce queues behind fresh dispatch for the same slot.
    // Deliberately NOT gated on auto_dispatch, dispatch_kinds, intake review or
    // authority: this is the SAME task resuming, already authorized when it first
    // dispatched, and the alternative is feedback nobody ever reads. Same
    // reasoning bounceForChanges (api.ts) respawns on. max_agents and the
    // per-task spawn backoff still apply.
    for (const task of group.reattach) {
      if (herdrDown) return;
      try {
        const proj = getProject(task.project_id);
        if (!proj?.repo_path) continue;
        const cfg = proj.config ?? {};
        const cap = Number.isFinite(cfg.max_agents) ? Number(cfg.max_agents) : MAX_AGENTS_DEFAULT;
        if (workingFor(task.project_id) >= cap) continue;
        if (inBackoff(db, task.id, nowMs)) continue;
        if (!(await spawnFor(task))) return;
      } catch (e) {
        errors++;
        console.error(`[hive] dispatcher reattach ${task.id}:`, e);
      }
    }

    for (const task of group.queued) {
      if (herdrDown) return; // daemon down this cycle — stop, cooldown already set
      try {
        const proj = getProject(task.project_id);
        if (!proj?.repo_path) continue; // no repo -> can't spawn
        const cfg = proj.config ?? {};
        // A manager-created task is an explicit delegation from the director's
        // live supervisor, not unreviewed ambient intake. It dispatches even
        // when the project's generic queue auto-dispatch toggle is off.
        const managed = managingThreadForTask(db, task.id);
        const manager = managed?.task_id ? db.query("SELECT state FROM tasks WHERE id = ?").get(managed.task_id) as { state: string } | undefined : null;
        const managerDelegated = !!manager && !["done", "failed", "cancelled"].includes(manager.state);
        if (cfg.auto_dispatch !== true && !managerDelegated) continue;

        const kinds = Array.isArray(cfg.dispatch_kinds) ? cfg.dispatch_kinds : DISPATCH_KINDS_DEFAULT;
        // A requeue is recovery for work already dispatched once (auto-requeue on
        // context-full/death, or the director's recovery card) — excluding chores
        // here stranded every requeued braindump in 'queued' forever ("failed —
        // awaiting triage" with a successor nobody spawns, task #135).
        if (!kinds.includes(task.kind) && task.source !== "requeue") continue; // chore / human-titled tasks excluded

        if (task.source?.startsWith("intake_") && !isReviewed(db, task.id)) continue; // unreviewed intake
        if (isTrackingOnlyTask(task)) continue; // tracking-only: never spawned

        const cap = Number.isFinite(cfg.max_agents) ? Number(cfg.max_agents) : MAX_AGENTS_DEFAULT;
        if (workingFor(task.project_id) >= cap) continue; // working-concurrency cap
        if (activeFor(task.project_id) >= cap * REVIEW_OVERHANG) continue; // review overhang bound

        if (inBackoff(db, task.id, nowMs)) continue; // still cooling down after a spawn failure

        // #989: the brief edits files that live in ANOTHER project's repo. The
        // open card is the visible reason; spawning here hands the agent a
        // worktree it cannot do the work in.
        if (repoMismatchUnresolved(db, task.id)) continue;

        const authz = authorize(db, {
          project_id: task.project_id,
          action: "task.dispatch",
          target: task.title,
          task_id: task.id,
        });
        if (authz.effect !== "allow") continue; // deny or require_decision blocks the auto-spawn

        // Dependency gate: don't spawn until every depends_on task is merged/done.
        // Same shape as the authz gate above — skip and surface a visible reason.
        const blocking = unmetDeps(db, task);
        if (blocking.length) {
          noteDependencyBlock(db, task.id, blocking, "dispatcher");
          continue;
        }

        if (!(await spawnFor(task))) return;
      } catch (e) {
        errors++;
        console.error(`[hive] dispatcher task ${task.id}:`, e);
      }
    }
  };

  // Group queued tasks by project (order within a project preserved from the
  // created_at sort) and dispatch the projects concurrently. The count-cache
  // Maps are only ever touched for a project's own key, so concurrent project
  // loops never race on shared state.
  const byProject = new Map<string, { reattach: typeof queued; queued: typeof queued }>();
  const groupFor = (pid: string) => {
    let g = byProject.get(pid);
    if (!g) byProject.set(pid, (g = { reattach: [], queued: [] }));
    return g;
  };
  for (const task of reattach) groupFor(task.project_id).reattach.push(task);
  for (const task of queued) groupFor(task.project_id).queued.push(task);
  await Promise.all([...byProject.values()].map(dispatchProject));
  setSetting(db, "last_dispatch_at", now()); // cycle completed — refresh heartbeat
  console.log(
    `[hive] dispatcher run: duration_ms=${Date.now() - startedAt} steps=${queued.length} reattach=${reattach.length} errors=${errors} outcome=${errors > 0 ? "error" : "ok"}`
  );
}

// An intake task is "reviewed" once the director signals it: either a dedicated
// `reviewed` event, or any `note` event containing the word "reviewed". The
// intake connector's own "UNREVIEWED ..." note must NOT count, so that token is
// stripped before the substring test.
export function isReviewed(db: DB, taskId: string): boolean {
  const rows = db
    .query("SELECT type, payload FROM events WHERE task_id = ? AND type IN ('note','reviewed')")
    .all(taskId) as { type: string; payload: string }[];
  for (const r of rows) {
    if (r.type === "reviewed") return true;
    try {
      const note = String(JSON.parse(r.payload).note ?? "").toLowerCase().replace(/unreviewed/g, "");
      if (note.includes("reviewed")) return true;
    } catch {
      /* ignore malformed payloads */
    }
  }
  return false;
}

// Exponential backoff keyed on the count of spawn_error events for the task:
// delay = min(30s * 2^(n-1), 30m) since the most recent failure. A task with no
// spawn errors dispatches immediately. Infra-tagged failures (herdr daemon down)
// are excluded — they aren't the task's fault, so they must neither escalate its
// exponential delay nor strand it in backoff once the daemon recovers; the global
// circuit breaker governs those instead.
export function inBackoff(db: DB, taskId: string, nowMs: number): boolean {
  const rows = db
    .query("SELECT ts, payload FROM events WHERE task_id = ? AND type = 'spawn_error' ORDER BY ts DESC")
    .all(taskId) as { ts: string; payload: string }[];
  const own = rows.filter((r) => {
    try {
      return !JSON.parse(r.payload).infra;
    } catch {
      return true; // unparseable payload counts as a real failure
    }
  });
  if (!own.length) return false;
  const delay = Math.min(BACKOFF_BASE_MS * 2 ** (own.length - 1), BACKOFF_CAP_MS);
  return nowMs - Date.parse(own[0].ts) < delay;
}

// Global herdr-outage cooldown, mirroring inBackoff's exponential shape but keyed
// on a settings streak counter instead of per-task events. Grows with consecutive
// outage cycles, capped low so recovery is picked up within minutes.
export function noteHerdrOutage(db: DB, nowMs: number): void {
  const streak = Number(getSetting(db, "herdr_outage_streak") ?? "0") + 1;
  const delay = Math.min(HERDR_OUTAGE_BASE_MS * 2 ** (streak - 1), HERDR_OUTAGE_CAP_MS);
  setSetting(db, "herdr_outage_streak", String(streak));
  setSetting(db, "herdr_backoff_until", new Date(nowMs + delay).toISOString());
}

// Daemon answered a spawn — clear the outage streak/cooldown so the next failure
// starts fresh. No-op (no writes) when there was no outage in flight.
export function clearHerdrOutage(db: DB): void {
  const streak = getSetting(db, "herdr_outage_streak") ?? "";
  const backoffUntil = getSetting(db, "herdr_backoff_until") ?? "";
  if ((streak !== "" && streak !== "0") || backoffUntil !== "") {
    setSetting(db, "herdr_outage_streak", "0");
    setSetting(db, "herdr_backoff_until", "");
  }
}

// Background loop. Started only from index.ts (never in tests).
export function startDispatcher(db: DB, deps: DispatcherDeps & { intervalMs?: number } = {}): () => void {
  const intervalMs = deps.intervalMs ?? 30_000;
  const timer = setInterval(() => {
    dispatchOnce(db, deps).catch((e) => console.error("[hive] dispatch cycle crashed:", e));
  }, intervalMs);
  return () => clearInterval(timer);
}
