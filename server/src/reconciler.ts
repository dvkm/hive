// Coarse time-based reconciler: the fallback to the event-driven paths (herdr
// waits + Claude Code hooks). Every cycle it (1) syncs herdr agent status for
// tasks with an agent_target, (2) syncs CI/merge state via `gh pr view` for
// tasks with a pr_url, (3) flags tasks silent beyond a threshold as `stale`.
//
// Guard: a reconciler failure must never crash the server. Each sub-step is
// isolated; the whole cycle is wrapped, and at most one `reconciler_error`
// signal is broadcast per cycle.
import type { DB } from "./db.ts";
import { now } from "./db.ts";
import { broadcast } from "./bus.ts";
import { writeEvent, transition, getTask } from "./state.ts";
import { Herdr, herdr as defaultHerdr } from "./runtime/herdr.ts";
import { runSmoke, type MonitorDeps } from "./monitors.ts";
import type { Exec } from "./exec.ts";
import { defaultExec } from "./exec.ts";

const NON_TERMINAL = "('queued','in_progress','needs_decision','in_review','verifying')";

export interface ReconcilerDeps {
  herdr?: Herdr;
  exec?: Exec; // for `gh`
  staleMs?: number; // default 15m
  smoke?: MonitorDeps; // deps for runSmoke on merge->verifying
  nowMs?: () => number; // injectable clock (tests)
}

const DEFAULT_STALE_MS = 15 * 60 * 1000;

export async function reconcileOnce(db: DB, deps: ReconcilerDeps = {}): Promise<void> {
  let errored = false;
  const fail = (where: string, e: unknown) => {
    if (!errored) {
      errored = true;
      console.error(`[hive] reconciler ${where}:`, e);
      broadcast({ type: "reconciler_error", error: String((e as any)?.message ?? e), where });
    }
  };
  try {
    await syncAgents(db, deps);
  } catch (e) {
    fail("syncAgents", e);
  }
  try {
    await syncPRs(db, deps);
  } catch (e) {
    fail("syncPRs", e);
  }
  try {
    flagStale(db, deps);
  } catch (e) {
    fail("flagStale", e);
  }
}

// ---- agent status sync ----
async function syncAgents(db: DB, deps: ReconcilerDeps): Promise<void> {
  const h = deps.herdr ?? defaultHerdr;
  const tasks = db
    .query(`SELECT id, agent_target FROM tasks WHERE agent_target IS NOT NULL AND state IN ${NON_TERMINAL}`)
    .all() as { id: string; agent_target: string }[];
  for (const t of tasks) {
    const status = await h.status(t.agent_target);
    if (status === "unknown") continue;
    if (status !== lastAgentStatus(db, t.id)) {
      writeEvent(db, { task_id: t.id, source: "herdr", type: "agent_status", payload: { status } });
    }
  }
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

// ---- PR / CI sync via gh ----
async function syncPRs(db: DB, deps: ReconcilerDeps): Promise<void> {
  const exec = deps.exec ?? defaultExec;
  const tasks = db
    .query(`SELECT id, state, pr_url, ci_status FROM tasks WHERE pr_url IS NOT NULL AND state IN ${NON_TERMINAL}`)
    .all() as { id: string; state: string; pr_url: string; ci_status: string | null }[];

  for (const t of tasks) {
    const r = await exec(["gh", "pr", "view", t.pr_url, "--json", "state,statusCheckRollup"]);
    if (r.code !== 0) continue; // gh unavailable / auth: skip, try next cycle
    let data: any;
    try {
      data = JSON.parse(r.stdout);
    } catch {
      continue;
    }
    const ci = ciStatusOf(data.statusCheckRollup);
    if (ci && ci !== t.ci_status) {
      db.query("UPDATE tasks SET ci_status = ?, updated_at = ? WHERE id = ?").run(ci, now(), t.id);
      writeEvent(db, { task_id: t.id, source: "reconciler", type: "ci_status", payload: { ci_status: ci } });
      broadcast({ type: "task", task: getTask(db, t.id) });
    }
    if (String(data.state).toUpperCase() === "MERGED" && t.state === "in_review") {
      writeEvent(db, { task_id: t.id, source: "reconciler", type: "pr_merged", payload: { pr_url: t.pr_url } });
      transition(db, t.id, "verifying", { source: "reconciler", reason: "PR merged" });
      // Post-merge smoke runs once on entering verifying.
      try {
        await runSmoke(db, t.id, deps.smoke ?? {});
      } catch (e) {
        console.error(`[hive] smoke run failed for ${t.id}:`, e);
      }
    }
  }
}

// Derive a coarse ci_status from gh's statusCheckRollup (a mix of CheckRun and
// StatusContext objects). failing > pending > passing.
export function ciStatusOf(rollup: any): string | null {
  if (!Array.isArray(rollup) || rollup.length === 0) return null;
  let anyPending = false;
  for (const c of rollup) {
    const conclusion = String(c.conclusion ?? "").toUpperCase();
    const status = String(c.status ?? "").toUpperCase();
    const state = String(c.state ?? "").toUpperCase(); // StatusContext
    if (conclusion === "FAILURE" || conclusion === "ERROR" || conclusion === "CANCELLED" || conclusion === "TIMED_OUT" || state === "FAILURE" || state === "ERROR")
      return "failing";
    if (status === "QUEUED" || status === "IN_PROGRESS" || status === "PENDING" || state === "PENDING")
      anyPending = true;
  }
  return anyPending ? "pending" : "passing";
}

// ---- stale detection ----
function flagStale(db: DB, deps: ReconcilerDeps): void {
  const staleMs = deps.staleMs ?? DEFAULT_STALE_MS;
  const nowMs = (deps.nowMs ?? (() => Date.now()))();
  // Only tasks that are actively worked (an agent could go silent).
  const tasks = db
    .query(`SELECT id FROM tasks WHERE state IN ('in_progress','needs_decision','in_review','verifying')`)
    .all() as { id: string }[];
  for (const t of tasks) {
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
    }
  }
}

// Background loop. Started only from index.ts (never in tests).
export function startReconciler(db: DB, deps: ReconcilerDeps & { intervalMs?: number } = {}): () => void {
  const intervalMs = deps.intervalMs ?? 60_000;
  const timer = setInterval(() => {
    reconcileOnce(db, deps).catch((e) => console.error("[hive] reconciler cycle crashed:", e));
  }, intervalMs);
  return () => clearInterval(timer);
}
