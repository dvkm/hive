import type { Checkpoint, Decision, Task, UnderstandingQuiz } from "./api";

export interface BlockingTaskRef {
  id: string;
  number: number;
  display_id?: string;
  title: string;
  state: string;
  pr_url: string | null;
}

export type NeedsYouItem =
  | { kind: "decision"; id: string; decision: Decision }
  | { kind: "checkpoint"; id: string; checkpoint: Checkpoint }
  | { kind: "quiz_digest"; id: string; quizzes: UnderstandingQuiz[] }
  | { kind: "review"; id: string; task: Task }
  | { kind: "attention"; id: string; task: Task }
  | { kind: "waiting"; id: string; task: Task; blockedBy: BlockingTaskRef[] };

const DAY_MS = 24 * 60 * 60 * 1000;
const PRIORITY_HEAD_START: Record<NonNullable<Task["priority"]>, number> = {
  now: 3 * DAY_MS,
  next: 2 * DAY_MS,
  normal: DAY_MS,
  later: 0,
};

function focusItemKey(item: NeedsYouItem, tasks: Map<string, Task>): number {
  const candidates = item.kind === "quiz_digest"
    ? item.quizzes.map((quiz) => ({ ts: quiz.ts, task: tasks.get(quiz.task_id) }))
    : item.kind === "decision"
      ? [{ ts: item.decision.ts, task: tasks.get(item.decision.task_id) }]
      : item.kind === "checkpoint"
        ? [{ ts: item.checkpoint.ts, task: tasks.get(item.checkpoint.task_id) }]
        : [{ ts: item.task.updated_at, task: item.task }];

  return Math.min(...candidates.map(({ ts, task }) => {
    const time = Date.parse(ts);
    return Number.isNaN(time) ? Number.POSITIVE_INFINITY : time - PRIORITY_HEAD_START[task?.priority ?? "normal"];
  }));
}

// Priority is a head start, not a permanent lane: one day per level means an
// old lower-priority item eventually outranks a steady stream of new urgent work.
export function orderFocusItems(items: NeedsYouItem[], tasks: Task[]): NeedsYouItem[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  return [...items].sort((a, b) => focusItemKey(a, byId) - focusItemKey(b, byId));
}

// Mirrors server/src/health.ts's needsAttention — keep both excluding the
// same unsupervised tasks (see server/src/supervision.ts's isSupervisedTask).
// A never-spawned external task (tracking-only, no agent_target) is excluded;
// a manually-spawned one is real hive-driven work and stays visible.
export function taskNeedsAttention(task: Task): boolean {
  if (task.source === "chat_supervisor") return false;
  if (task.source === "external" && !task.agent_target) return false;
  if (task.state === "in_review" || task.state === "needs_decision") return false;
  if (task.state === "failed") return !task.requeued_to;
  return !!task.health && (task.health.status === "dead" || task.health.status === "stuck");
}

// Auto-review exclusion is owned by #974/PR #87; keep this browser-side guard here so the changes merge independently.
// A mirror of someone else's Jira ticket: hive never runs an agent on it, ever.
export function isJiraMirror(task: Pick<Task, "source_ref">): boolean {
  return String(task.source_ref ?? "").startsWith("jira:");
}

// Tracking-only: hive records it but does no work of its own on it. Broader than
// isJiraMirror, and the two are NOT interchangeable. Gate HIVE-OWNED-WORK UI
// (PR/CI panels, code review) on this; gate AGENT controls on isJiraMirror plus
// never_dispatched, because a source='external' task a director actually
// spawned has a live agent those controls should still reach.
export function isTrackingOnly(task: Pick<Task, "source" | "source_ref">): boolean {
  return task.source === "external" || isJiraMirror(task);
}

// Tracking cards are containers, not execution owners. Plain tracked cards use
// their direct children; Jira cards also group Hive work carrying the same
// stable issue-key prefix (e.g. [WEB-7]). Retry chains stay owned by their
// original supervisor, so collapse each one to its newest attempt instead of
// rewriting parent_task_id or showing every failed attempt as another subtask.
export function trackedSubtasks(task: Task, tasks: Task[]): Task[] {
  if (!isTrackingOnly(task)) return [];
  const direct = tasks.filter((candidate) => candidate.parent_task_id === task.id);
  const jiraKey = isJiraMirror(task) ? String(task.source_ref).slice("jira:".length) : "";
  const keyed = jiraKey
    ? tasks.filter((candidate) =>
        candidate.project_id === task.project_id &&
        !isTrackingOnly(candidate) &&
        candidate.source !== "requeue" &&
        candidate.title.startsWith(`[${jiraKey}]`)
      )
    : [];
  const roots = [...new Map([...direct, ...keyed].map((candidate) => [candidate.id, candidate])).values()];

  return roots.map((root) => {
    let latest = root;
    const seen = new Set([root.id]);
    while (true) {
      const retry = tasks
        .filter((candidate) => candidate.parent_task_id === latest.id && candidate.source === "requeue" && !seen.has(candidate.id))
        .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))[0];
      if (!retry) return latest;
      seen.add(retry.id);
      latest = retry;
    }
  }).sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
}

function reviewIsActionable(task: Task): boolean {
  return task.kind === "scout" || (!!(task.pr_url || task.branch) && task.ci_status !== "pending" && task.ci_status !== "failing");
}

// Browser-safe mirror of server/src/state.ts's dependency gate. Exported so
// BlockedBy and the needs-you queue use the same threshold.
export const DEP_MET_STATES = new Set(["verifying", "done"]);
const DEAD_DEP_STATES = new Set(["failed", "cancelled"]);
export function unmetDeps(task: Task, tasks: Task[]): BlockingTaskRef[] {
  return (task.depends_on ?? []).flatMap((id) => {
    const dep = tasks.find((t) => t.id === id);
    if (dep && DEP_MET_STATES.has(dep.state)) return [];
    return [dep
      ? { id: dep.id, number: dep.number, display_id: dep.display_id, title: dep.title, state: dep.state, pr_url: dep.pr_url }
      : { id, number: 0, title: "(unknown task)", state: "missing", pr_url: null }];
  });
}

// A task needing attention is either genuinely stuck/dead (needs routing) or
// purely blocked on another task's pull request landing (needs nothing from the
// director but time). Failed tasks always need routing regardless of
// declared deps — the human chooses requeue/edit/cancel.
export function isWaiting(task: Task, tasks: Task[]): boolean {
  const blocking = unmetDeps(task, tasks);
  return task.state !== "failed" && blocking.length > 0 && !blocking.every((dep) => DEAD_DEP_STATES.has(dep.state));
}

// A quiz on a shipped task is a catch-up, not a gate. Five of them are still
// one thing to sit down and do, so they collapse into ONE digest the director
// works through in order. Grouped by project so the project filter (and the
// digest's own heading) still names exactly one project. Quizzes on tasks still
// in review are NOT here — those block the review card itself.
export function quizDigests(tasks: Task[], quizzes: UnderstandingQuiz[]): NeedsYouItem[] {
  const byProject = new Map<string, UnderstandingQuiz[]>();
  for (const quiz of quizzes) {
    const state = tasks.find((task) => task.id === quiz.task_id)?.state ?? quiz.task_state;
    if (!["verifying", "done", "failed"].includes(state)) continue;
    const group = byProject.get(quiz.project_id);
    if (group) group.push(quiz);
    else byProject.set(quiz.project_id, [quiz]);
  }
  return [...byProject].map(([projectId, group]) => ({
    kind: "quiz_digest" as const,
    id: `quiz-digest:${projectId}`,
    quizzes: group,
  }));
}

export function getNeedsYouItems(decisions: Decision[], tasks: Task[], checkpoints: Checkpoint[], quizzes: UnderstandingQuiz[]): NeedsYouItem[] {
  return [
    ...decisions.map((decision) => ({ kind: "decision" as const, id: decision.id, decision })),
    ...checkpoints.map((checkpoint) => ({ kind: "checkpoint" as const, id: checkpoint.id, checkpoint })),
    ...quizDigests(tasks, quizzes),
    ...tasks
      .filter((task) => task.state === "in_review" && !isTrackingOnly(task))
      .sort((a, b) => Number(reviewIsActionable(b)) - Number(reviewIsActionable(a)))
      .map((task) => ({ kind: "review" as const, id: task.id, task })),
    ...tasks.filter(taskNeedsAttention).map((task): NeedsYouItem => {
      const blockedBy = task.state === "failed" ? [] : unmetDeps(task, tasks);
      return blockedBy.length && !blockedBy.every((dep) => DEAD_DEP_STATES.has(dep.state))
        ? { kind: "waiting", id: task.id, task, blockedBy }
        : { kind: "attention", id: task.id, task };
    }),
  ];
}

// Which project does a needs-you item belong to? Checkpoints and quizzes carry
// their project; a decision only knows its task, so look that up. Used by the
// focus/backlogs views to honour the shared project filter.
export function itemProject(item: NeedsYouItem, tasks: Task[]): string | undefined {
  if (item.kind === "decision") return tasks.find((task) => task.id === item.decision.task_id)?.project_id;
  if (item.kind === "checkpoint") return item.checkpoint.project_id;
  if (item.kind === "quiz_digest") return item.quizzes[0]?.project_id;
  return item.task.project_id;
}
