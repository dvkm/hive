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
