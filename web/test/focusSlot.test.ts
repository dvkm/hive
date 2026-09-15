import { expect, test } from "bun:test";
import { focusSlot } from "../src/lib/needsYou";

test("the focus view follows the pinned card through a re-sort, and only falls back to the slot once it is gone", () => {
  // Answering a question bumped intent:b to the end; the director stays on it.
  expect(focusSlot(["intent:a", "intent:c", "intent:b"], "intent:b", 1)).toBe(2);
  // Accepted and gone: the slot it was in shows the next in line, clamped.
  expect(focusSlot(["intent:a", "intent:c"], "intent:b", 1)).toBe(1);
  expect(focusSlot(["intent:a"], "intent:b", 1)).toBe(0);
  expect(focusSlot([], "intent:b", 1)).toBe(-1);
});
