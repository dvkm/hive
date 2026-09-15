import { expect, test } from "bun:test";
import { DEFAULT_OPEN_QUESTION, answerHiveQuestion, answerOpenQuestion, isHiveQuestion, openQuestions, questionBullets, setIntentSection } from "../src/lib/intent";

const body = ["## Problem", "Something", "", "## Open questions", "- [ ] Is this the ask?", "- [x] Already answered", "- [ ] Which env?", ""].join("\n");

test("answering the nth open question ticks that bullet, keeps the answer on the line, and unlocks nothing else", () => {
  const next = answerOpenQuestion(body, 1, "staging first");
  expect(next).toContain("- [x] Which env? — staging first");
  expect(next).toContain("- [ ] Is this the ask?");
  expect(openQuestions(next)).toEqual(["Is this the ask?"]);
  expect(questionBullets(next).map((q) => q.done)).toEqual([false, true, true]);
  expect(answerOpenQuestion(body, 5)).toBe(body);
});

test("filling an empty section from the card replaces only that section, or appends it", () => {
  const draft = ["## Problem", "Something", "", "## Proposed outcome", "(not stated)", "", "## Constraints", "None", ""].join("\n");
  const filled = setIntentSection(draft, "Proposed outcome", "Comments after Done land on a task");
  expect(filled).toContain("## Proposed outcome\nComments after Done land on a task\n");
  expect(filled).toContain("## Constraints\nNone");
  expect(filled).not.toContain("(not stated)");
  expect(setIntentSection("## Problem\nX\n", "Constraints", "No model call")).toContain("## Constraints\nNo model call");
});

test("hive's own question is recognised, and Accept ticks it while leaving people's questions alone", () => {
  expect(isHiveQuestion(DEFAULT_OPEN_QUESTION)).toBe(true);
  expect(isHiveQuestion("Which env?")).toBe(false);
  const drafted = `## Open questions\n- [ ] Which env?\n- [ ] ${DEFAULT_OPEN_QUESTION}\n`;
  const ticked = answerHiveQuestion(drafted);
  expect(ticked).toContain(`- [x] ${DEFAULT_OPEN_QUESTION}`);
  expect(ticked).toContain("- [ ] Which env?");
  expect(answerHiveQuestion("## Open questions\n- [ ] Which env?\n")).toBe("## Open questions\n- [ ] Which env?\n");
});
