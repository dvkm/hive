// The dispatcher: the piece that makes hive self-driving. A coarse loop (default
// every 30s, HIVE_DISPATCH_MS) that picks up `queued` tasks and spawns a herdr
// agent for each, subject to opt-in project policy and safety gates:
//
//   - per-project config `auto_dispatch: true` is REQUIRED (default off, so
//     intake drafts and setup tasks never auto-spawn).
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
import type { DB } from "./db.ts";
import { parseTask } from "./rows.ts";
import { isOffline } from "./db.ts";
import { Herdr, herdr as defaultHerdr } from "./runtime/herdr.ts";
import { authorize } from "./authority.ts";
import { spawnAgent } from "./api.ts";

// Chores included since 2026-07-12: the queue sat at 10 tasks / 1 live agent
// because 9 were agent-filed follow-up FIXES tagged chore — "chores are titled
// for a human" stopped being true once agents started fanning out work. The
// guards that matter stay: auto_dispatch opt-in, intake review, max_agents,
// authority. Exclude chores per project via config.dispatch_kinds if needed.
const DISPATCH_KINDS_DEFAULT = ["ship", "scout", "chore"];
const MAX_AGENTS_DEFAULT = 3;
const BACKOFF_BASE_MS = 30_000;
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
const REVIEW_OVERHANG = 2;

export interface DispatcherDeps {
  herdr?: Herdr;
  nowMs?: () => number; // injectable clock (tests + backoff)
  supervise?: boolean; // start the herdr wait loop after spawn (prod wiring)
  hiveUrl?: string;
}

// One dispatch pass. Isolated per task so one bad task never stops the rest.
export async function dispatchOnce(db: DB, deps: DispatcherDeps = {}): Promise<void> {
  if (isOffline(db)) return; // offline mode: drain — nothing new spawns
  const h = deps.herdr ?? defaultHerdr;
  const nowMs = (deps.nowMs ?? (() => Date.now()))();
  const queued = db
    .query("SELECT * FROM tasks WHERE state = 'queued' ORDER BY created_at ASC")
    .all()
    .map(parseTask);

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
        .query(`SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND agent_target IS NOT NULL AND state IN ${states}`)
        .get(pid);
      cache.set(pid, row.n as number);
    }
    return cache.get(pid)!;
  };
  const workingFor = (pid: string) => countFor(workingCount, WORKING_STATES, pid);
  const activeFor = (pid: string) => countFor(activeCount, ACTIVE_STATES, pid);

  for (const task of queued) {
    try {
      const proj = getProject(task.project_id);
      if (!proj?.repo_path) continue; // no repo -> can't spawn
      const cfg = proj.config ?? {};
      if (cfg.auto_dispatch !== true) continue; // opt-in only

      const kinds = Array.isArray(cfg.dispatch_kinds) ? cfg.dispatch_kinds : DISPATCH_KINDS_DEFAULT;
      // A requeue is recovery for work already dispatched once (auto-requeue on
      // context-full/death, or the director's recovery card) — excluding chores
      // here stranded every requeued braindump in 'queued' forever ("failed —
      // awaiting triage" with a successor nobody spawns, task #135).
      if (!kinds.includes(task.kind) && task.source !== "requeue") continue; // chore / human-titled tasks excluded

      if (task.source?.startsWith("intake_") && !isReviewed(db, task.id)) continue; // unreviewed intake
      if (task.source === "external") continue; // tracking-only: another agent's kanban entry, never spawned

      const cap = Number.isFinite(cfg.max_agents) ? Number(cfg.max_agents) : MAX_AGENTS_DEFAULT;
      if (workingFor(task.project_id) >= cap) continue; // working-concurrency cap
      if (activeFor(task.project_id) >= cap * REVIEW_OVERHANG) continue; // review overhang bound

      if (inBackoff(db, task.id, nowMs)) continue; // still cooling down after a spawn failure

      const authz = authorize(db, {
        project_id: task.project_id,
        action: "task.dispatch",
        target: task.title,
        task_id: task.id,
      });
      if (authz.effect !== "allow") continue; // deny or require_decision blocks the auto-spawn

      const r = await spawnAgent(db, h, task.id, { hiveUrl: deps.hiveUrl, supervise: deps.supervise });
      if (r.ok) {
        workingCount.set(task.project_id, workingFor(task.project_id) + 1);
        activeCount.set(task.project_id, activeFor(task.project_id) + 1);
      }
      // On failure spawnAgent already wrote a single spawn_error event; the
      // backoff above governs the next attempt (no immediate retry).
    } catch (e) {
      console.error(`[hive] dispatcher task ${task.id}:`, e);
    }
  }
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
// spawn errors dispatches immediately.
export function inBackoff(db: DB, taskId: string, nowMs: number): boolean {
  const rows = db
    .query("SELECT ts FROM events WHERE task_id = ? AND type = 'spawn_error' ORDER BY ts DESC")
    .all(taskId) as { ts: string }[];
  if (!rows.length) return false;
  const delay = Math.min(BACKOFF_BASE_MS * 2 ** (rows.length - 1), BACKOFF_CAP_MS);
  return nowMs - Date.parse(rows[0].ts) < delay;
}

// Background loop. Started only from index.ts (never in tests).
export function startDispatcher(db: DB, deps: DispatcherDeps & { intervalMs?: number } = {}): () => void {
  const intervalMs = deps.intervalMs ?? 30_000;
  const timer = setInterval(() => {
    dispatchOnce(db, deps).catch((e) => console.error("[hive] dispatch cycle crashed:", e));
  }, intervalMs);
  return () => clearInterval(timer);
}
