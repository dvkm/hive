import { expect, test } from "bun:test";
import { act, create } from "react-test-renderer";
import { MemoryRouter } from "react-router-dom";
import { Ctx, type Store } from "../src/lib/store";
import type { LandGraph, Task } from "../src/lib/api";
import { Card, LandChips } from "../src/views/Board";

const fakeStore = {
  projects: [],
  evidenceCount: {},
  spawnError: {},
  lastActivity: {},
  tasks: [],
} as unknown as Store;

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

function tree(t: Task) {
  return (
    <MemoryRouter>
      <Ctx.Provider value={fakeStore}>
        <Card task={t} />
      </Ctx.Provider>
    </MemoryRouter>
  );
}

const btn = (renderer: ReturnType<typeof create>, label: string) =>
  renderer.root.findAll((n) => n.type === "button" && n.children.includes(label));

// A never-dispatched external task (source=external, never spawned — see
// server/src/supervision.ts) has no agent to dispatch: the server rejects
// spawning it outright, so the board card shouldn't offer the button.
test("dispatch now is hidden for a never-dispatched external task", async () => {
  const t = task("ext-fresh", { source: "external", never_dispatched: true });
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(tree(t));
  });
  expect(btn(renderer, "dispatch now").length).toBe(0);
});

// Once a director has manually dispatched a tracking-only task (the one
// escape hatch — see supervision.ts's neverDispatched), it's real hive-driven
// work again: the control behaves normally.
test("dispatch now shows normally for an external task that WAS spawned before", async () => {
  const t = task("ext-recovered", { source: "external", never_dispatched: false });
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(tree(t));
  });
  expect(btn(renderer, "dispatch now").length).toBe(1);
});

test("dispatch now shows normally for an ordinary (non-external) queued task", async () => {
  const t = task("ordinary", { source: "agent" });
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(tree(t));
  });
  expect(btn(renderer, "dispatch now").length).toBe(1);
});

// The browse chip must come from the server-canonicalized jira_site, never
// from the raw project config: a config write naming another host would
// otherwise turn every card into a link to it.
function cardWith(t: Task, project: Record<string, unknown>) {
  const store = { ...fakeStore, projects: [project] } as unknown as Store;
  return (
    <MemoryRouter>
      <Ctx.Provider value={store}>
        <Card task={t} />
      </Ctx.Provider>
    </MemoryRouter>
  );
}

const links = async (t: Task, project: Record<string, unknown>) => {
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(cardWith(t, project));
  });
  return renderer.root.findAll((n) => n.type === "a").map((n) => String(n.props.href));
};

test("the Jira chip links to the server-canonicalized site", async () => {
  const hrefs = await links(task("j1", { jira_key: "WEB-123" }), {
    id: "project",
    name: "p",
    config: { jira: { site: "https://evil.atlassian.net" } },
    jira_site: "https://example.atlassian.net",
  });
  expect(hrefs).toContain("https://example.atlassian.net/browse/WEB-123");
  expect(hrefs.join(" ")).not.toContain("evil.atlassian.net");
});

test("no Jira chip is rendered when the server validated no site", async () => {
  const hrefs = await links(task("j2", { jira_key: "WEB-124" }), {
    id: "project",
    name: "p",
    config: { jira: { site: "https://evil.atlassian.net" } },
    jira_site: null,
  });
  expect(hrefs.join(" ")).not.toContain("browse/WEB-124");
  expect(hrefs.join(" ")).not.toContain("evil.atlassian.net");
});

// The board says WHY a review card will wait its turn — one line, and only
// when an edge actually exists (ADHD policy: no chip with nothing to say).
const chipText = (renderer: ReturnType<typeof create>) =>
  renderer.root
    .findAll((n) => typeof n.type === "string" && n.type === "span" && String(n.props.className ?? "").includes("chip"))
    .map((n) => n.children.join(""))
    .join(" | ");

const chips = async (t: Task, graph: LandGraph, tasks: Task[]) => {
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(<LandChips task={t} graph={graph} tasks={tasks} />);
  });
  return chipText(renderer);
};

test("land chips name the dependency and the conflicting PR", async () => {
  const a = task("a", { number: 11, state: "in_review" });
  const b = task("b", { number: 12, state: "in_review" });
  const c = task("c", { number: 13, state: "in_review", land_queued_at: "2026-01-01T00:00:00.000Z" });
  const graph: LandGraph = {
    nodes: [],
    edges: [
      { from: a.id, to: c.id, kind: "depends" },
      { from: b.id, to: c.id, kind: "conflict", files: ["src/autosave.ts"] },
    ],
  };
  const text = await chips(c, graph, [a, b, c]);
  expect(text).toContain("queued to land");
  expect(text).toContain("lands after #11");
  expect(text).toContain("conflicts with #12");
  expect(await chips(b, graph, [a, b, c])).toContain("conflicts with #13");
});

test("a review card with no edges and no mark shows no land line at all", async () => {
  const a = task("a", { number: 11, state: "in_review" });
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(<LandChips task={a} graph={{ nodes: [], edges: [] }} tasks={[a]} />);
  });
  expect(renderer.toJSON()).toBeNull();
});

// The background-check chip (task HIVE-405). Green when the agent's last commit
// passed hive's own tsc/lint pass, amber with a count when it didn't, and absent
// before the first check — a card with no chip must not read as "clean".
const checkChips = async (t: Task) => {
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(tree(t));
  });
  return renderer.root
    .findAll((n) => n.type === "span" && String(n.props.className ?? "").includes("chip-check"))
    .map((n) => ({ className: String(n.props.className), title: String(n.props.title), text: n.children.join("") }));
};

test("a clean sidecar report renders one green checks chip", async () => {
  const [chip, ...rest] = await checkChips(task("s-ok", { sidecar: { sha: "abc1234def", ok: true, findings: [] } }));
  expect(rest).toEqual([]);
  expect(chip.className).toContain("chip-check-ok");
  expect(chip.text).toContain("checks");
  expect(chip.title).toContain("abc1234");
});

test("a sidecar report with findings renders an amber chip counting them, and lists them on hover", async () => {
  const [chip] = await checkChips(
    task("s-bad", {
      sidecar: {
        sha: "abc1234def",
        ok: false,
        findings: [
          { tool: "tsc", summary: "src/a.ts(3,1): error TS2345" },
          { tool: "lint", summary: "src/b.ts:9 semi" },
        ],
      },
    })
  );
  expect(chip.className).toContain("chip-check-warn");
  expect(chip.text).toContain("2");
  expect(chip.title).toContain("tsc: src/a.ts(3,1): error TS2345");
  expect(chip.title).toContain("lint: src/b.ts:9 semi");
});

test("no chip at all before the first background check", async () => {
  expect(await checkChips(task("s-none"))).toEqual([]);
});
