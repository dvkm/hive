import type { DB } from "./db.ts";

// What "hive supervises" means, in one place. Tracking-only tasks
// (source='external': a mirrored JIRA issue, another agent's kanban entry —
// see intake/jira.ts) sit outside hive's own loop: never auto-dispatched and
// exempt from evidence gates, always, regardless of agent_target — but once
// one is manually spawned (agent_target set) it's real hive-driven work, so
// staleness flags / manager wakeups / inbox counts stop excluding it (see
// isSupervisedTask below). The chat_supervisor task is the supervisor
// session itself, excluded from those same wakeup/inbox/staleness paths
// unconditionally for the same reason (it can't wake itself, watch itself
// for staleness, or be its own inbox item) — but unlike 'external' it still
// gates on evidence, so keep that one check ('external' only) separate from
// the broader "supervised" set.
export function isExternalTask(source: string | null | undefined): boolean {
  return source === "external";
}

// Tasks hive actively supervises: watched for staleness, wake the manager on
// their events, and count toward a project's inbox totals. A chat_supervisor
// task is always excluded (it's the infrastructure session, not director
// work). A source='external' task is excluded only while nobody has ever
// spawned it (agent_target still null, tracking-only, never dispatched) —
// once a director manually spawns one it's doing real hive-driven work
// (real decisions, real review, a real agent that can go stale) and should
// be supervised like anything else, not hidden by source alone.
export function isSupervisedTask(task: { source?: string | null; agent_target?: string | null }): boolean {
  if (task.source === "chat_supervisor") return false;
  if (isExternalTask(task.source) && !task.agent_target) return false;
  return true;
}

// SQL fragment form of isSupervisedTask, for COUNT/JOIN queries where
// pulling rows into JS first isn't worth it. `sourceColumn`/`agentColumn`
// are the (optionally table-qualified) columns, e.g. "source"/"agent_target"
// or "t.source"/"t.agent_target".
export function supervisedSql(sourceColumn = "source", agentColumn = "agent_target"): string {
  return `NOT (COALESCE(${sourceColumn}, '') = 'chat_supervisor' OR (COALESCE(${sourceColumn}, '') = 'external' AND ${agentColumn} IS NULL))`;
}

// Was this task EVER spawned, at any point in its history? task.agent_target
// alone can't answer that: cleanup.ts nulls it on terminal-task teardown and
// state.ts nulls it (unconditionally) on a failed->queued requeue, so a task
// that genuinely ran once looks identical to one that never has right after
// either event. The `spawned` event spawnAgent writes is permanent (the
// events table is the log of record, nothing deletes from it), so it's the
// only reliable signal.
export function everSpawned(db: DB, taskId: string): boolean {
  return !!db.query("SELECT 1 FROM events WHERE task_id = ? AND type = 'spawned' LIMIT 1").get(taskId);
}

// A source=external task nobody has ever dispatched, manually or otherwise —
// no live agent exists for it and none automatically ever will. The gate for
// automation that would otherwise reach for an agent that was never there: a
// first spawn attempt, a request-changes bounce, a reconciler nudge. Once a
// task HAS been spawned at least once it's real hive-driven work (same
// history-based test isSupervisedTask's agent_target check approximates from
// current state alone), so those paths behave normally again — recovery and
// manual respawn are not blocked forever by one requeue nulling agent_target.
export function neverDispatched(db: DB, task: { id: string; source?: string | null }): boolean {
  return isExternalTask(task.source) && !everSpawned(db, task.id);
}
