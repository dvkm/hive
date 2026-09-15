import { expect, test } from "bun:test";
import { act, create } from "react-test-renderer";
import { api } from "../src/lib/api";
import type { Intent } from "../src/lib/api";
import { INTENT_SECTIONS } from "../src/lib/domain";
import { IntentCard } from "../src/views/IntentCard";
import { getNeedsYouItems, orderFocusItems } from "../src/lib/needsYou";
import type { Task } from "../src/lib/api";

const BODY = `## Problem
Post-Done Jira comments land on nothing.

## Proposed outcome
Every ask gets a durable record.

## Affected users and systems
The director, the Jira mirror, the dispatcher.

## Constraints
No model call.

## Open questions
`;

const intent: Intent = {
  id: "int_1",
  project_id: "project",
  task_id: "task-1",
  source: "director",
  source_ref: null,
  status: "draft",
  body_md: BODY,
  author: null,
  accepted_by: null,
  accepted_at: null,
  created_at: "2026-09-07T00:00:00.000Z",
  updated_at: "2026-09-07T00:00:00.000Z",
};

function texts(tree: any): string[] {
  return tree.root
    .findAll((n: any) => (n.children ?? []).some((c: any) => typeof c === "string"))
    .map((n: any) => n.children.filter((c: any) => typeof c === "string").join(""));
}
function button(tree: any, label: string) {
  return tree.root.findAll((n: any) => n.type === "button").find((n: any) => n.children?.[0] === label);
}

test("the card renders all five playbook sections with their text", () => {
  const tree = create(<IntentCard intent={intent} />);
  const shown = texts(tree);
  for (const heading of INTENT_SECTIONS) expect(shown).toContain(heading);
  expect(shown).toContain("Post-Done Jira comments land on nothing.");
  expect(shown).toContain("No model call.");
  // A section with nothing under it says so rather than collapsing away.
  expect(shown).toContain("(none)");
});

test("Accept posts the acceptance and hands back the accepted intent", async () => {
  let calledWith = "";
  const accepted: Intent = { ...intent, status: "accepted", accepted_by: "director", accepted_at: "2026-09-07T01:00:00.000Z" };
  const original = api.acceptIntent;
  api.acceptIntent = async (id: string) => { calledWith = id; return accepted; };
  let got: Intent | null = null;
  const tree = create(<IntentCard intent={intent} onChange={(next) => { got = next; }} />);
  await act(async () => { button(tree, "Accept").props.onClick(); });
  api.acceptIntent = original;
  expect(calledWith).toBe("int_1");
  expect(got!.status).toBe("accepted");
});

test("Accept is held while an open question is unanswered", () => {
  const asked = { ...intent, body_md: BODY + "- [ ] which environment ships first?\n" };
  const tree = create(<IntentCard intent={asked} />);
  expect(button(tree, "Accept").props.disabled).toBe(true);
  expect(texts(tree).join("")).toContain("open question");
  // Answered, and the gate lifts.
  const ticked = { ...intent, body_md: BODY + "- [x] which environment ships first? staging\n" };
  expect(button(create(<IntentCard intent={ticked} />), "Accept").props.disabled).toBe(false);
});

test("hive's own question does not hold Accept: accepting is the answer to it", () => {
  const drafted = { ...intent, body_md: BODY + "- [ ] Is this the ask, and what does done look like? Tick this once you have read the draft.\n" };
  const tree = create(<IntentCard intent={drafted} />);
  expect(button(tree, "Accept").props.disabled).toBe(false);
  const shown = texts(tree).join("");
  expect(shown).not.toContain("Tick this once");
  expect(shown).toContain("Accept means: this is the ask.");
});

test("an accepted intent shows no Accept, Edit or Ask buttons", () => {
  const tree = create(<IntentCard intent={{ ...intent, status: "accepted", accepted_by: "director" }} />);
  for (const label of ["Accept", "Edit", "Ask the originator"]) expect(button(tree, label)).toBeUndefined();
});

test("draft intents sit above reviews in the needs-you queue, grouped per project", () => {
  const task = (id: string, project_id: string): Task => ({
    id, number: 1, project_id, title: id, state: "in_review", kind: "ship",
    agent_target: null, worktree_path: null, branch: null, pr_url: null, ci_status: null,
    head_sha: null, summary: null, source: null, source_ref: null, jira_key: null,
    jira_link_kind: null, parent_task_id: null, duplicate_of: null, depends_on: [],
    review_actionable: true, created_at: "2026-09-01T00:00:00.000Z", updated_at: "2026-09-08T00:00:00.000Z",
  });
  const tasks = [task("review-1", "beta")];
  // Both drafts are OLDER than the review, and would sort after it on time alone.
  const drafts: Intent[] = [
    { ...intent, id: "int_beta", project_id: "beta", task_id: null },
    { ...intent, id: "int_alpha", project_id: "alpha", task_id: null },
  ];
  const ordered = orderFocusItems(getNeedsYouItems([], tasks, [], [], drafts), tasks);
  expect(ordered.map((item) => item.id)).toEqual(["int_alpha", "int_beta", "review-1"]);
});
