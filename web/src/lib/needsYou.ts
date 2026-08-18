import type { Checkpoint, Decision, Task, UnderstandingQuiz } from "./api";

export type NeedsYouItem =
  | { kind: "decision"; id: string; decision: Decision }
  | { kind: "checkpoint"; id: string; checkpoint: Checkpoint }
  | { kind: "quiz"; id: string; quiz: UnderstandingQuiz }
  | { kind: "review"; id: string; task: Task }
  | { kind: "attention"; id: string; task: Task };

export function taskNeedsAttention(task: Task): boolean {
  if (task.state === "in_review" || task.state === "needs_decision") return false;
  if (task.state === "failed") return !task.requeued_to;
  return !!task.health && (task.health.status === "dead" || task.health.status === "stuck");
}

export function getNeedsYouItems(decisions: Decision[], tasks: Task[], checkpoints: Checkpoint[], quizzes: UnderstandingQuiz[]): NeedsYouItem[] {
  return [
    ...decisions.map((decision) => ({ kind: "decision" as const, id: decision.id, decision })),
    ...checkpoints.map((checkpoint) => ({ kind: "checkpoint" as const, id: checkpoint.id, checkpoint })),
    ...quizzes
      .filter((quiz) => {
        const state = tasks.find((task) => task.id === quiz.task_id)?.state ?? quiz.task_state;
        return !["in_progress", "in_review", "needs_decision"].includes(state);
      })
      .map((quiz) => ({ kind: "quiz" as const, id: quiz.id, quiz })),
    ...tasks.filter((task) => task.state === "in_review").map((task) => ({ kind: "review" as const, id: task.id, task })),
    ...tasks.filter(taskNeedsAttention).map((task) => ({ kind: "attention" as const, id: task.id, task })),
  ];
}
