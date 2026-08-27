import { expect, test } from "bun:test";
import { act, create } from "react-test-renderer";
import { MemoryRouter } from "react-router-dom";
import { Ctx, type Store } from "../src/lib/store";
import { api } from "../src/lib/api";
import type { Task } from "../src/lib/api";
import Palette from "../src/views/Palette";
import { Bell } from "../src/App";

// Bun's test environment has no DOM: globalThis already implements
// addEventListener/dispatchEvent, but the bare `window`/`document` globals
// Palette relies on don't exist. Alias/stub just enough for it to mount.
(globalThis as unknown as { window: typeof globalThis }).window = globalThis;
(globalThis as unknown as { document: { body: { style: Record<string, string> }; activeElement: null } }).document = {
  body: { style: {} },
  activeElement: null,
};

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

api.search = (async () => ({ hits: [] })) as typeof api.search;

async function openWithQuery(tasks: Task[], query: string) {
  const store = { tasks, projects: [] } as unknown as Store;
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(
      <MemoryRouter>
        <Ctx.Provider value={store}>
          <Palette />
        </Ctx.Provider>
      </MemoryRouter>
    );
  });
  await act(async () => {
    window.dispatchEvent(new Event("hive:palette"));
  });
  const input = renderer.root.findByProps({ className: "palette-input" });
  await act(async () => {
    input.props.onChange({ target: { value: query } });
  });
  return renderer;
}

const dispatchLabels = (renderer: ReturnType<typeof create>) =>
  renderer.root
    .findAll((n) => n.props.className === "palette-label")
    .map((n) => n.children.join(""))
    .filter((l) => l.startsWith("Dispatch "));

// A never-dispatched external task (source=external, never spawned — see
// server/src/supervision.ts) has no agent to dispatch: the server rejects
// spawning it outright, so the palette shouldn't offer a working-looking
// "Dispatch <title>" command for it.
test("Dispatch command is hidden for a never-dispatched external task", async () => {
  const t = task("ext-fresh", { title: "Fresh External", source: "external", never_dispatched: true });
  const renderer = await openWithQuery([t], "dispatch");
  expect(dispatchLabels(renderer)).not.toContain("Dispatch Fresh External");
});

// Once a director has manually dispatched a tracking-only task (the escape
// hatch — see supervision.ts's neverDispatched), it's real hive-driven work
// again: the command behaves normally.
test("Dispatch command shows for an external task that WAS spawned before", async () => {
  const t = task("ext-recovered", { title: "Recovered External", source: "external", never_dispatched: false });
  const renderer = await openWithQuery([t], "dispatch");
  expect(dispatchLabels(renderer)).toContain("Dispatch Recovered External");
});

test("Dispatch command shows for an ordinary (non-external) queued task", async () => {
  const t = task("ordinary", { title: "Ordinary Task", source: "agent" });
  const renderer = await openWithQuery([t], "dispatch");
  expect(dispatchLabels(renderer)).toContain("Dispatch Ordinary Task");
});

test("topbar popovers close the palette", async () => {
  const renderer = await openWithQuery([], "");
  expect(renderer.root.findAll((node) => node.props.className?.includes("palette-backdrop"))).toHaveLength(1);

  await act(async () => {
    window.dispatchEvent(new Event("hive:notifications"));
  });

  expect(renderer.root.findAll((node) => node.props.className?.includes("palette-backdrop"))).toHaveLength(0);
});

test("opening the palette closes notifications", async () => {
  const store = { notifications: [], ackNotifications: () => {} } as unknown as Store;
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(
      <Ctx.Provider value={store}>
        <Bell />
      </Ctx.Provider>
    );
  });
  await act(async () => renderer.root.findByProps({ className: "bell" }).props.onClick());
  expect(renderer.root.findAllByProps({ className: "bell-drop" })).toHaveLength(1);

  await act(async () => window.dispatchEvent(new Event("hive:palette")));

  expect(renderer.root.findAllByProps({ className: "bell-drop" })).toHaveLength(0);
});
