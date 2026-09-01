import { expect, test } from "bun:test";
import { oneLine, stateChanges, whyItWasNeeded, withoutPromoted } from "../src/lib/reviewFocus";

// The real HIVE-554 review, the card this redesign was written against.
const done = [
  "Diagnosed why 7 hive-project rows were still stranded despite v39 already running: source is settable directly through the task-create API body, not gated on the retired --track CLI flag alone, so rows created after v39's one-time run were never touched.",
  "Verified on a full copy of the live DB: stranded-row count 7 -> 0, idempotent on re-run, Jira mirror population byte-identical before/after (113 rows, 97 done).",
  "Full test suite passes: 1691 pass, 0 fail.",
];

test("the state table reads the before/after pair out of the agent's own line", () => {
  const rows = stateChanges(done);
  expect(rows).toHaveLength(1);
  expect(rows[0].label).toBe("stranded-row count");
  expect(rows[0].before).toBe("7");
  expect(rows[0].after).toBe("0");
});

test("a sentence with no numeric pair is not a state change", () => {
  expect(stateChanges(["Refactored the queue -> the dispatcher, no behaviour change."])).toHaveLength(0);
});

test("the why falls back to the Completed line that explains the cause", () => {
  expect(whyItWasNeeded(undefined, done).source).toBe(done[0]);
  expect(whyItWasNeeded("Rows were stranded.", done)).toEqual({ text: "Rows were stranded.", source: "" });
});

test("one line is capped, never a paragraph", () => {
  const long = "a".repeat(200);
  expect(oneLine(long).length).toBeLessThanOrEqual(141);
  expect(oneLine("Short sentence. A second one that would not fit anyway.")).toBe("Short sentence.");
});

test("a promoted sentence is dropped from the collapsed list", () => {
  const promoted = [done[0]];
  expect(withoutPromoted(done, promoted, (d) => d)).toEqual([done[1], done[2]]);
});
