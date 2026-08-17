import { expect, test } from "bun:test";
import type { Checkpoint, Decision, Task } from "../src/lib/api";
import { getNeedsYouItems } from "../src/lib/needsYou";

const task = (id: string, state: Task["state"], extra: Partial<Task> = {}) => ({ id, state, ...extra }) as Task;

test("needs-you queue includes every actionable item", () => {
  const decision = { id: "decision-1" } as Decision;
  const checkpoint = { id: "checkpoint-1" } as Checkpoint;
  const items = getNeedsYouItems(
    [decision],
    [
      task("review-1", "in_review"),
      task("failed-1", "failed"),
      task("requeued-1", "failed", { requeued_to: "successor" }),
      task("stuck-1", "in_progress", { health: { status: "stuck", reason: null, since: "now" } }),
    ],
    [checkpoint]
  );

  expect(items.map((item) => item.kind)).toEqual(["decision", "checkpoint", "review", "attention", "attention"]);
  expect(items.map((item) => item.id)).toEqual(["decision-1", "checkpoint-1", "review-1", "failed-1", "stuck-1"]);
});
