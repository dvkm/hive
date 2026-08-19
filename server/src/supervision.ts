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
