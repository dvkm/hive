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
import { broadcast } from "./bus.ts";

export type HealthStatus = "healthy" | "silent" | "stuck" | "dead";
export interface Health {
  status: HealthStatus;
  reason: string | null;
  since: string; // ISO ts the current condition began
}

// Only tasks that hold (or should hold) a live agent get a health verdict.
// Queued / done / failed / cancelled tasks get `null`.
const HEALTH_STATES = new Set(["in_progress", "needs_decision", "in_review", "verifying"]);

function staleMs(): number {
  return Number(process.env.HIVE_STALE_MS || 15 * 60 * 1000);
}

// Derivation (precedence dead > stuck > silent > healthy):
//   dead   — agent_target set but herdr reports the agent gone (latest
//            agent_status = "gone", written by the reconciler's probe).
//   stuck  — herdr reports `blocked`, OR a stale-recovery escalation is in
//            flight (the newest event is `stale`/`recovery_nudge`).
//   silent — no activity events past the stale threshold, agent still alive.
//   healthy — otherwise.
export function computeHealth(db: DB, task: any, nowMs = Date.now()): Health | null {
  if (!HEALTH_STATES.has(task.state) || !task.agent_target) return null;

  const events = db
    .query("SELECT type, ts, payload FROM events WHERE task_id = ? ORDER BY ts DESC")
    .all(task.id) as { type: string; ts: string; payload: string }[];

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

  if (lastStatus === "gone") return { status: "dead", reason: "agent gone from herdr", since: lastStatusTs };
  if (lastStatus === "blocked")
    return { status: "stuck", reason: "agent blocked (waiting on you)", since: lastStatusTs };

  // Parked waiting on the DIRECTOR (a decision card or a review), not the
  // agent: silence is expected, so age-based silent/stuck must not apply
  // ("stale recovery in progress" on a needs_decision task, 2026-07-10).
  // dead/blocked above still surface honestly.
  if (task.state === "needs_decision" || task.state === "in_review")
    return { status: "healthy", reason: null, since: task.updated_at as string };

  const latest = events[0];
  if (latest && latest.type === "recovery_nudge")
    return { status: "stuck", reason: "stale recovery in progress", since: latest.ts };

  // "Activity" excludes reconciler noise (stale flags, recovery nudges) so a
  // genuinely quiet agent keeps aging toward silent instead of resetting.
  const activity = events.find((e) => e.type !== "stale" && e.type !== "recovery_nudge");
  const activityTs = activity ? activity.ts : (task.updated_at as string);
  const age = nowMs - Date.parse(activityTs);
  // Finished-without-a-PR (or genuinely stuck): an idle agent (it stopped working)
  // on an in_progress task that opened no PR and has gone quiet is either done but
  // never handed off, or wedged. Surface it in the attention tray instead of the
  // quiet "silent" that hides forever. A PR-bearing idle task is auto-advanced to
  // in_review by the reconciler, so it never reaches here; scouts hand off via a
  // report and are advanced too.
  if (task.state === "in_progress" && task.kind !== "scout" && lastStatus === "idle" && !task.pr_url && age > staleMs()) {
    return { status: "stuck", reason: "finished or stuck: agent idle, no PR", since: activityTs };
  }
  if (age > staleMs()) {
    const escalating = latest && latest.type === "stale";
    return {
      status: escalating ? "stuck" : "silent",
      reason: escalating ? "stale recovery in progress" : "no activity",
      since: activityTs,
    };
  }
  return { status: "healthy", reason: null, since: activityTs };
}

// A task row enriched with its computed health, for API responses + SSE.
export function taskWithHealth(db: DB, task: any): any {
  return { ...task, health: computeHealth(db, task) };
}

// "Needs attention" tray eligibility (the single rule; the web mirrors it):
// a `failed` task awaiting human triage, OR a live task whose agent is dead or
// stuck. Requires a task already carrying its computed `health` field.
export function needsAttention(task: { state: string; health?: Health | null }): boolean {
  if (task.state === "failed") return true;
  return !!task.health && (task.health.status === "dead" || task.health.status === "stuck");
}

// Broadcast a task-changed SSE message carrying fresh health. Use this instead
// of a raw `broadcast({type:"task"})` so every board update reflects health.
export function broadcastTask(db: DB, task: any): void {
  broadcast({ type: "task", task: taskWithHealth(db, task) });
}
