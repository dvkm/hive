import { expect, test } from "bun:test";
import { act, create } from "react-test-renderer";
import { MemoryRouter } from "react-router-dom";
import { Ctx, type Store } from "../src/lib/store";
import { LightboxProvider } from "../src/lib/lightbox";
import { api } from "../src/lib/api";
import type { Task, TaskDetail } from "../src/lib/api";
import { TaskBody } from "../src/views/Task";

const fakeStore = { tasks: [], projects: [], rev: {} } as unknown as Store;

const task = (id: string, extra: Partial<Task> = {}): Task => ({
  id,
  number: 1,
  project_id: "project",
  title: `Task ${id}`,
  brief: "",
  state: "queued",
  kind: "ship",
  agent_target: null,
  worktree_path: null,
  branch: null,
  pr_url: null,
  ci_status: null,
  head_sha: null,
  summary: null,
  source: null,
  source_ref: null,
  parent_task_id: null,
  duplicate_of: null,
  depends_on: [],
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  ...extra,
});

const detail = (t: Task): TaskDetail => ({ ...t, events: [], evidence: [], decisions: [] });

api.taskUsage = (async (id: string) => ({
  task_id: id,
  usage: [],
  totals: { total_tokens: 0, cost_usd: 0, unpriced: 0, calls: 0 },
})) as typeof api.taskUsage;

function tree(t: Task) {
  api.task = (async () => detail(t)) as typeof api.task;
  return (
    <MemoryRouter>
      <Ctx.Provider value={fakeStore}>
        <LightboxProvider>
          <TaskBody id={t.id} />
        </LightboxProvider>
      </Ctx.Provider>
    </MemoryRouter>
  );
}

const btn = (renderer: ReturnType<typeof create>, label: string) =>
  renderer.root.findAll((n) => n.type === "button" && n.children.includes(label));

// A never-dispatched external task (source=external, never spawned — see
// server/src/supervision.ts) has no agent to steer or dispatch: the server
// rejects both outright, so the board shouldn't offer them.
test("Dispatch now and Send steer are hidden for a never-dispatched external task", async () => {
  const t = task("ext-fresh", { source: "external", never_dispatched: true });
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(tree(t));
  });

  expect(btn(renderer, "Dispatch now").length).toBe(0);
  expect(btn(renderer, "Send steer").length).toBe(0);
});

// Once a director has manually dispatched a tracking-only task (the one
// escape hatch — see supervision.ts's neverDispatched), it's real hive-driven
// work again: both controls behave normally.
test("Dispatch now and Send steer show normally for an external task that WAS spawned before", async () => {
  const t = task("ext-recovered", { source: "external", never_dispatched: false });
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(tree(t));
  });

  expect(btn(renderer, "Dispatch now").length).toBe(1);
  expect(btn(renderer, "Send steer").length).toBe(1);
});

test("Dispatch now and Send steer show normally for an ordinary (non-external) queued task", async () => {
  const t = task("ordinary", { source: "agent" });
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(tree(t));
  });

  expect(btn(renderer, "Dispatch now").length).toBe(1);
  expect(btn(renderer, "Send steer").length).toBe(1);
});
