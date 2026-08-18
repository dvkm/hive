import { expect, test } from "bun:test";
import type { Checkpoint, Decision, Task, UnderstandingQuiz } from "../src/lib/api";
import { getNeedsYouItems } from "../src/lib/needsYou";

const task = (id: string, state: Task["state"], extra: Partial<Task> = {}) => ({ id, state, ...extra }) as Task;

test("needs-you queue includes every actionable item", () => {
  const decision = { id: "decision-1" } as Decision;
  const checkpoint = { id: "checkpoint-1" } as Checkpoint;
  const quiz = { id: "quiz-1", task_id: "quiz-task", task_state: "in_review" } as UnderstandingQuiz;
  const activeQuiz = { id: "quiz-active", task_id: "review-1", task_state: "done" } as UnderstandingQuiz;
  const cancelledQuiz = { id: "quiz-cancelled", task_id: "cancelled-1", task_state: "in_review" } as UnderstandingQuiz;
  const items = getNeedsYouItems(
    [decision],
    [
      task("review-1", "in_review", { health: { status: "dead", reason: null, since: "now" } }),
      task("failed-1", "failed"),
      task("requeued-1", "failed", { requeued_to: "successor" }),
      task("stuck-1", "in_progress", { health: { status: "stuck", reason: null, since: "now" } }),
      task("manager-1", "in_progress", { source: "chat_supervisor", health: { status: "stuck", reason: null, since: "now" } }),
      task("quiz-task", "done"),
      task("cancelled-1", "cancelled"),
    ],
    [checkpoint],
    [quiz, activeQuiz, cancelledQuiz]
  );

  expect(items.map((item) => item.kind)).toEqual(["decision", "checkpoint", "quiz", "review", "attention", "attention"]);
  expect(items.map((item) => item.id)).toEqual(["decision-1", "checkpoint-1", "quiz-1", "review-1", "failed-1", "stuck-1"]);
});

test("reviews with pending CI do not hide actionable reviews", () => {
  const items = getNeedsYouItems(
    [],
    [
      task("pending", "in_review", { kind: "ship", pr_url: "https://example.com/pending", ci_status: "pending" }),
      ...[1, 2, 3, 4].map((number) => task(`ready-${number}`, "in_review", {
        kind: "ship",
        pr_url: `https://example.com/ready-${number}`,
        ci_status: "passing",
      })),
    ],
    [],
    []
  );

  expect(items.map((item) => item.id)).toEqual(["ready-1", "ready-2", "ready-3", "ready-4", "pending"]);
});
