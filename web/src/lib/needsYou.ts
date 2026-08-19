import type { Checkpoint, Decision, Task, UnderstandingQuiz } from "./api";

export type NeedsYouItem =
  | { kind: "decision"; id: string; decision: Decision }
  | { kind: "checkpoint"; id: string; checkpoint: Checkpoint }
  | { kind: "quiz"; id: string; quiz: UnderstandingQuiz }
  | { kind: "review"; id: string; task: Task }
  | { kind: "attention"; id: string; task: Task };

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

function reviewIsActionable(task: Task): boolean {
  return task.kind === "scout" || (!!(task.pr_url || task.branch) && task.ci_status !== "pending" && task.ci_status !== "failing");
}

export function getNeedsYouItems(decisions: Decision[], tasks: Task[], checkpoints: Checkpoint[], quizzes: UnderstandingQuiz[]): NeedsYouItem[] {
  return [
    ...decisions.map((decision) => ({ kind: "decision" as const, id: decision.id, decision })),
    ...checkpoints.map((checkpoint) => ({ kind: "checkpoint" as const, id: checkpoint.id, checkpoint })),
    ...quizzes
      .filter((quiz) => {
        const state = tasks.find((task) => task.id === quiz.task_id)?.state ?? quiz.task_state;
        return ["verifying", "done", "failed"].includes(state);
      })
      .map((quiz) => ({ kind: "quiz" as const, id: quiz.id, quiz })),
    ...tasks
      .filter((task) => task.state === "in_review")
      .sort((a, b) => Number(reviewIsActionable(b)) - Number(reviewIsActionable(a)))
      .map((task) => ({ kind: "review" as const, id: task.id, task })),
    ...tasks.filter(taskNeedsAttention).map((task) => ({ kind: "attention" as const, id: task.id, task })),
  ];
}
