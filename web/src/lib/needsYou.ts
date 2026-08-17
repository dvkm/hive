import type { Checkpoint, Decision, Task } from "./api";

export type NeedsYouItem =
  | { kind: "decision"; id: string; decision: Decision }
  | { kind: "checkpoint"; id: string; checkpoint: Checkpoint }
  | { kind: "review"; id: string; task: Task }
  | { kind: "attention"; id: string; task: Task };

export function taskNeedsAttention(task: Task): boolean {
  if (task.state === "in_review" || task.state === "needs_decision") return false;
  if (task.state === "failed") return !task.requeued_to;
  return !!task.health && (task.health.status === "dead" || task.health.status === "stuck");
}

export function getNeedsYouItems(decisions: Decision[], tasks: Task[], checkpoints: Checkpoint[]): NeedsYouItem[] {
  return [
    ...decisions.map((decision) => ({ kind: "decision" as const, id: decision.id, decision })),
    ...checkpoints.map((checkpoint) => ({ kind: "checkpoint" as const, id: checkpoint.id, checkpoint })),
    ...tasks.filter((task) => task.state === "in_review").map((task) => ({ kind: "review" as const, id: task.id, task })),
    ...tasks.filter(taskNeedsAttention).map((task) => ({ kind: "attention" as const, id: task.id, task })),
  ];
}
