import { expect, test } from "bun:test";
import { answerOpenQuestion, openQuestions, questionBullets } from "../src/lib/intent";

const body = ["## Problem", "Something", "", "## Open questions", "- [ ] Is this the ask?", "- [x] Already answered", "- [ ] Which env?", ""].join("\n");

test("answering the nth open question ticks that bullet, keeps the answer on the line, and unlocks nothing else", () => {
  const next = answerOpenQuestion(body, 1, "staging first");
  expect(next).toContain("- [x] Which env? — staging first");
  expect(next).toContain("- [ ] Is this the ask?");
  expect(openQuestions(next)).toEqual(["Is this the ask?"]);
  expect(questionBullets(next).map((q) => q.done)).toEqual([false, true, true]);
  expect(answerOpenQuestion(body, 5)).toBe(body);
});
