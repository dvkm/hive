import { expect, test } from "bun:test";
import { act, create } from "react-test-renderer";
import { MemoryRouter } from "react-router-dom";
import { Ctx, type Store } from "../src/lib/store";
import { LightboxProvider } from "../src/lib/lightbox";
import { api } from "../src/lib/api";
import type { Task, TaskDetail } from "../src/lib/api";
import { ReviewCard } from "../src/views/ReviewCard";

const fakeStore = { projects: [], quizzes: [] } as unknown as Store;

const task = (id: string, source: string | null = "agent"): Task => ({
  id,
  number: 1,
  project_id: "project",
  title: `Task ${id}`,
  brief: "",
  state: "in_review",
  kind: "ship",
  agent_target: null,
  worktree_path: null,
  branch: "task-branch",
  pr_url: "https://github.com/org/repo/pull/1",
  ci_status: "passing",
  head_sha: null,
  summary: null,
  source,
  source_ref: null,
  parent_task_id: null,
  duplicate_of: null,
  depends_on: [],
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
});

const detail = (id: string, source: string | null): TaskDetail => ({
  ...task(id, source),
  events: [],
  evidence: [],
  decisions: [],
});

// api.diff/api.task hit real fetch() otherwise; ReviewCard's own effect is
// the only thing that calls them, so stubbing these two is enough.
api.diff = (async () => ({ files: [], truncated: false })) as typeof api.diff;
api.task = (async (id: string) => detail(id, "agent")) as typeof api.task;

function tree(t: Task) {
  return (
    <MemoryRouter>
      <Ctx.Provider value={fakeStore}>
        <LightboxProvider>
          <ReviewCard task={t} />
        </LightboxProvider>
      </Ctx.Provider>
    </MemoryRouter>
  );
}

test("re-rendering ReviewCard in place with a different task resets mode/notes", async () => {
  const taskA = task("task-a");
  const taskB = task("task-b", "external");

  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(tree(taskA));
  });

  const requestChangesBtn = renderer.root.findAll(
    (n) => n.type === "button" && n.children.includes("Request changes")
  )[0];
  await act(async () => {
    requestChangesBtn.props.onClick();
  });
  const textarea = renderer.root.findAllByType("textarea")[0];
  await act(async () => {
    textarea.props.onChange({ target: { value: "please fix the thing" } });
  });
  expect(renderer.root.findAllByType("textarea")[0].props.value).toBe("please fix the thing");

  // Same-route navigation: React re-renders the same instance in place,
  // it does not unmount/remount ReviewCard.
  await act(async () => {
    renderer.update(tree(taskB));
  });

  expect(renderer.root.findAllByType("textarea").length).toBe(0);

  // Reopening "Request changes" on the new task must start from empty notes,
  // not whatever was typed for the previous task.
  const requestChangesBtnB = renderer.root.findAll(
    (n) => n.type === "button" && n.children.includes("Request changes")
  )[0];
  await act(async () => {
    requestChangesBtnB.props.onClick();
  });
  expect(renderer.root.findAllByType("textarea")[0].props.value).toBe("");
});
