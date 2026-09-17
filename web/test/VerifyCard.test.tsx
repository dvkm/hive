import { expect, test } from "bun:test";
import { act, create } from "react-test-renderer";
import { MemoryRouter } from "react-router-dom";
import { Ctx, type Store } from "../src/lib/store";
import { LightboxProvider } from "../src/lib/lightbox";
import { api } from "../src/lib/api";
import type { Evidence, Task, TaskDetail } from "../src/lib/api";
import { VerifyCard, orderEvidence } from "../src/views/ReviewCard";

const fakeStore = { projects: [{ id: "project", name: "Project" }], quizzes: [] } as unknown as Store;

const task: Task = {
  id: "task-1",
  number: 1,
  project_id: "project",
  title: "Refresh the card",
  brief: "",
  state: "verifying",
  kind: "ship",
  agent_target: null,
  worktree_path: null,
  branch: "task-branch",
  pr_url: "https://github.com/org/repo/pull/1",
  ci_status: "passing",
  head_sha: "f7627be",
  summary: null,
  source: "agent",
  source_ref: null,
  parent_task_id: null,
  duplicate_of: null,
  depends_on: [],
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

const shot = (id: string, caption: string, ts: string): Evidence => ({
  id,
  task_id: task.id,
  ts,
  kind: "screenshot",
  path: null,
  url: `/evidence/${id}.png`,
  caption,
  meta: {},
});

// The pair from the director's screenshot: same second, same commit, and the
// AFTER row emitted first.
const after = shot("after", "AFTER: card refreshed to the article as it reads now", "2026-01-01T00:00:00.000Z");
const before = shot("before", "BEFORE: card mails the draft-time headline", "2026-01-01T00:00:00.000Z");

test("a before/after pair reads before-then-after however it was emitted", () => {
  const later = shot("later", "Unrelated shot", "2026-01-01T00:05:00.000Z");
  const earlier = shot("earlier", "Unrelated earlier shot", "2025-12-31T00:00:00.000Z");
  expect(orderEvidence([after, before, later, earlier]).map((e) => e.id)).toEqual([
    "earlier",
    "before",
    "after",
    "later",
  ]);
});

test("two before/after pairs on one task stay two pairs", () => {
  const b1 = shot("b1", "BEFORE: first pair", "2026-01-01T00:00:00.000Z");
  const a1 = shot("a1", "AFTER: first pair", "2026-01-01T00:01:00.000Z");
  const b2 = shot("b2", "BEFORE: second pair", "2026-01-01T00:10:00.000Z");
  const a2 = shot("a2", "AFTER: second pair", "2026-01-01T00:11:00.000Z");
  expect(orderEvidence([a2, b2, a1, b1]).map((e) => e.id)).toEqual(["b1", "a1", "b2", "a2"]);
});

test("an AFTER captured before its BEFORE still reads second", () => {
  const earlyAfter = { ...after, ts: "2025-12-31T00:00:00.000Z" };
  expect(orderEvidence([before, earlyAfter]).map((e) => e.id)).toEqual(["before", "after"]);
});

test("the verify card names the task and captions every screenshot", async () => {
  const detail: TaskDetail = { ...task, events: [], evidence: [after, before], decisions: [] };
  api.task = (async () => detail) as typeof api.task;
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(
      <MemoryRouter>
        <Ctx.Provider value={fakeStore}>
          <LightboxProvider>
            <VerifyCard task={task} />
          </LightboxProvider>
        </Ctx.Provider>
      </MemoryRouter>
    );
  });
  const json = JSON.stringify(renderer.toJSON());
  expect(json).toContain("Refresh the card");
  // Both captions render, so the pair is no longer two identical rectangles.
  const captions = renderer.root.findAllByProps({ className: "rev-thumb-cap" }).map((n) => n.props.children);
  expect(captions).toEqual([before.caption, after.caption]);
  expect(renderer.root.findAll((n) => n.type === "button" && String(n.children).includes("Verified")).length).toBe(1);
});

// A Jira mirror carries no review of its own. Its card used to be the heading,
// "Check it, then close it" and a button: zero context. It now reads the
// finished work under it and leads with what was asked.
test("a Jira mirror's verify card reads the work under it and says what was asked and what to check", async () => {
  const mirror: Task = { ...task, id: "mirror-1", number: 2, title: "[WEB-165] sector badges", source: "external", source_ref: "jira:WEB-165", jira_key: "WEB-165", jira_link_kind: "mirror", pr_url: null };
  const work: Task = { ...task, id: "work-1", number: 3, title: "[WEB-165] sector badges", state: "done", jira_mirror_task_id: "mirror-1" };
  const intent = {
    id: "int_1",
    status: "accepted",
    task_id: "work-1",
    source_ref: "WEB-165",
    body_md: "## Problem\nNo sector on the rows.\n\n## Proposed outcome\nEvery row shows its sector badge.\n\n## Affected users and systems\n(not stated)\n\n## Constraints\n(not stated)\n\n## Open questions\n(none)\n",
  };
  const store = { ...fakeStore, tasks: [mirror, work], intents: [intent] } as unknown as Store;
  const fetched: string[] = [];
  api.task = (async (id: string) => {
    fetched.push(id);
    const review = {
      id: "ev-1", task_id: "work-1", ts: "2026-01-01T00:00:00.000Z", source: "agent", type: "review_summary",
      payload: {
        done: ["Grouped the rows by sector."],
        iffy: [{ what: "Multi-Family rows have no tab filter", why: "the map tabs only know four sectors" }],
        understanding: {
          essence: "The list is re-ordered so rows of the same sector sit together.",
          participate: "Open a player on the map search and check the list groups by sector.",
        },
      },
    };
    return { ...work, events: [review], evidence: [after], decisions: [] } as unknown as TaskDetail;
  }) as typeof api.task;
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(
      <MemoryRouter>
        <Ctx.Provider value={store}>
          <LightboxProvider>
            <VerifyCard task={mirror} />
          </LightboxProvider>
        </Ctx.Provider>
      </MemoryRouter>
    );
  });
  const json = JSON.stringify(renderer.toJSON());
  expect(fetched).toEqual(["work-1"]);
  expect(json).toContain("What was asked");
  expect(json).toContain("Every row shows its sector badge.");
  expect(json).toContain("What shipped");
  expect(json).toContain("The list is re-ordered so rows of the same sector sit together.");
  expect(json).toContain("Confirm WEB-165 is done, then close it");
  expect(json).toContain("Open a player on the map search and check the list groups by sector.");
  expect(json).toContain("Watch out for");
  expect(json).toContain("Multi-Family rows have no tab filter");
  expect(json).not.toContain("Nothing else moves it");
});
