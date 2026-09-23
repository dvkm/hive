// HIVE-643: the intent drafter used to ask questions the ticket had already
// answered. WEB-163 spelled out the matching rule, where the add/remove happens,
// the scope, the empty-state copy and the sort order, and the draft still listed
// all six as open questions and left Constraints as "(not stated)". The work
// task then sat at the intent gate with nobody to ask.
//
// The fixture has WEB-163's shape: a description that answers every question
// it raises. What is locked down here is the contract with the drafter: the
// prompt tells it to answer from the text and to ask only what the text never
// says, and a draft that comes back with nothing to ask is recorded as having
// nothing to ask.
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "hive-intent-web163-"));
process.env.HIVE_HOME = HOME;

const { openDb } = await import("../src/db.ts");
const { intentSection, openQuestions } = await import("../src/intents.ts");
const { DEFAULT_OPEN_QUESTION, buildDraftPrompt, draftIntentBody, sourceText } = await import("../src/intentDraft.ts");

// A description in WEB-163's shape: six answers and a mockup.
const WEB_163 = `Please add one more "Sale" tab to the product list screen.

- Matching rule: use the sale tag from the product editor as is. There is no other rule.
- Sale tags must be addable and removable in the admin.
- It only needs to show inside the admin. The storefront is out of scope this time.
- Scope: every product in both the Shoes and Bags categories.
- Sort newest first, and let a dropdown change it.
- Copy when no product has the tag: "No sale products yet."

Mockup: image 3`;

const MOCKUP = join(HOME, "briefs", "attachments", "WEB-163", "image-3.png");

const SRC = {
  title: "[WEB-163] Add a Sale tab to the product list",
  description: `${WEB_163}\n[attachment: image-3.png -> ${MOCKUP}]`,
  comments: [],
  attachments: [MOCKUP],
};

test("the drafter is told to answer from the ticket, not to ask it back", () => {
  const prompt = buildDraftPrompt(SRC);
  // The whole ticket reaches the model, images included.
  expect(prompt).toContain("the sale tag from the product editor");
  expect(prompt).toContain("No sale products yet.");
  expect(prompt).toContain(MOCKUP);
  expect(sourceText(SRC)).toContain("already downloaded and readable at these paths");
  // And the three instructions that were missing.
  expect(prompt).toContain("READ ALL OF IT FIRST");
  expect(prompt).toContain("ANSWER IT YOURSELF");
  expect(prompt).toContain("Return an empty\n  array when the request settles everything");
  expect(prompt).toContain('name that file\'s local path in "constraints"');
  // The old rule forced a question even when the ticket answered everything.
  expect(prompt).not.toContain("open_questions: at least one");
});

// The draft WEB-163 should have produced: every answer as a constraint, nothing
// left to ask.
const DRAFTED = JSON.stringify({
  problem: "The product list screen has no Sale tab.",
  proposed_outcome: "The admin product list gets a Sale tab, showing sale-tagged products newest first.",
  affected: "The admin product list screen, and the sale tag in the product editor.",
  constraints: [
    "Matching uses the sale tag from the product editor as is.",
    "Sale tags can be added and removed in the admin.",
    "Scope is every product in both the Shoes and Bags categories, shown only inside the admin.",
    "Sort is newest first, switchable with a dropdown.",
    'Copy when no product has the tag: "No sale products yet."',
    `Mockup: ${MOCKUP}`,
  ].join("\n"),
  open_questions: [],
});

const stubModel = (stdout: string) => async () => ({ code: 0, stdout, stderr: "" });

test("a ticket that answers everything drafts with no open questions and real constraints", async () => {
  const db = openDb(":memory:");
  const draft = await draftIntentBody(db, SRC, { model: stubModel(DRAFTED) as any });
  expect(draft.drafted).toBe(true);

  expect(openQuestions(draft.body_md)).toEqual([]);
  const constraints = intentSection(draft.body_md, "Constraints").split("\n").filter(Boolean);
  expect(constraints.length).toBeGreaterThanOrEqual(4);
  expect(intentSection(draft.body_md, "Constraints")).toContain("the sale tag from the product editor");
  expect(intentSection(draft.body_md, "Constraints")).toContain("added and removed");
  expect(intentSection(draft.body_md, "Constraints")).toContain("Shoes");
  expect(intentSection(draft.body_md, "Constraints")).toContain("newest first");
  // The mockup is named where the builder will look for it.
  expect(intentSection(draft.body_md, "Constraints")).toContain(MOCKUP);
});

test("a draft that never answered the question still carries the default one", async () => {
  const db = openDb(":memory:");
  const draft = await draftIntentBody(db, SRC, {
    model: stubModel(JSON.stringify({ problem: "p", proposed_outcome: "o" })) as any,
  });
  expect(openQuestions(draft.body_md)).toEqual([DEFAULT_OPEN_QUESTION]);
});
