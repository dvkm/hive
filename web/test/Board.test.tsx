import { expect, test } from "bun:test";
import { act, create } from "react-test-renderer";
import { MemoryRouter } from "react-router-dom";
import { Ctx, type Store } from "../src/lib/store";
import type { LandGraph, Task } from "../src/lib/api";
import { Card, LandChips, queueOrder } from "../src/views/Board";

const fakeStore = {
  projects: [],
  evidenceCount: {},
  spawnError: {},
  lastActivity: {},
  tasks: [],
  decisions: [],
} as unknown as Store;

// Same store with a set of open decision cards, for the triage-chip tests.
const storeWith = (decisions: unknown[]) => ({ ...fakeStore, decisions }) as unknown as Store;

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

function tree(t: Task, store: Store = fakeStore) {
  return (
    <MemoryRouter>
      <Ctx.Provider value={store}>
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

// A board card links to ONE place: its own task page. The Jira link, the PR
// link and the rest moved there (HIVE-556) so the card stays scannable at
// column width. Nothing may leak a project-config URL back onto the board.
test("a board card links only to its own task page", async () => {
  const hrefs = await links(task("j1", { jira_key: "WEB-123" }), {
    id: "project",
    name: "p",
    config: { jira: { site: "https://evil.atlassian.net" } },
    jira_site: "https://example.atlassian.net",
  });
  expect(hrefs).toEqual(["/tasks/j1"]);
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

// The background-check chip (task HIVE-405). On the board card only a FAILING
// check earns space: amber with a count when the agent's last commit did not
// pass hive's own tsc/lint pass, and nothing at all otherwise (HIVE-556).
const checkChips = async (t: Task) => {
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(tree(t));
  });
  return renderer.root
    .findAll((n) => n.type === "span" && String(n.props.className ?? "").includes("chip-check"))
    .map((n) => ({ className: String(n.props.className), title: String(n.props.title), text: n.children.join("") }));
};

test("a clean sidecar report renders no chip on the board card", async () => {
  // Green changes nothing the director would do, so it costs the card nothing
  // (HIVE-556). The full report is still on the task page.
  expect(await checkChips(task("s-ok", { sidecar: { sha: "abc1234def", ok: true, findings: [] } }))).toEqual([]);
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

// Intake triage parks a task on one question. A plain "queued" card reads as
// "an agent will get to this", which is the opposite of the truth: nothing
// happens until the director picks a reading. See server/src/intake/triage.ts.
const triageCard = (task_id: string) => ({ id: "dec1", task_id, decision_class: "intake_triage" });

test("a task held by an open triage card says it is awaiting one answer", async () => {
  const t = task("held", { source: "watch" });
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(tree(t, storeWith([triageCard("held")])));
  });
  expect(chipText(renderer)).toContain("awaiting one answer");
});

test("the chip replaces the generic intake chip rather than stacking on it", async () => {
  const t = task("gchat-held", { source: "intake_gchat" });
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(tree(t, storeWith([triageCard("gchat-held")])));
  });
  const labels = chipText(renderer);
  expect(labels).toContain("awaiting one answer");
  expect(labels).not.toContain("intake · unreviewed");
});

test("no triage card: the card looks exactly as it did before", async () => {
  const t = task("free", { source: "intake_gchat" });
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    // An open card on a DIFFERENT task, and a non-triage card on this one.
    renderer = create(tree(t, storeWith([triageCard("someone-else"), { id: "d2", task_id: "free", decision_class: null }])));
  });
  const labels = chipText(renderer);
  expect(labels).not.toContain("awaiting one answer");
  expect(labels).toContain("intake · unreviewed");
});

// Intake triage can classify a mechanical request and mark it reviewed itself
// (server/src/intake/triage.ts). The server sends that as `reviewed` on the
// task, and a reviewed task dispatches like any other, so the card must not
// still claim it is waiting on the director. Task HIVE-513.
test("a triage-reviewed intake task drops the unreviewed chip", async () => {
  const t = task("gchat-reviewed", { source: "intake_gchat", reviewed: true });
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(tree(t));
  });
  expect(chipText(renderer)).not.toContain("intake · unreviewed");
});

test("an intake task nobody has reviewed still says unreviewed", async () => {
  const t = task("gchat-unreviewed", { source: "intake_gchat", reviewed: false });
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(tree(t));
  });
  expect(chipText(renderer)).toContain("intake · unreviewed");
});

// ---- priority (HIVE-430) ------------------------------------------------
// The chip IS the quick-set control (a <select> painted as a chip), so the
// class name is what says whether the card carries a visible priority: only
// `prio-normal` is styled away, and only until the card is hovered.
const prioChip = async (t: Task) => {
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(tree(t));
  });
  const [sel, ...rest] = renderer.root.findAll(
    (n) => n.type === "select" && String(n.props.className ?? "").includes("chip-prio")
  );
  expect(rest).toEqual([]);
  return sel;
};

test("a card shows its priority as a chip for now, next and later", async () => {
  for (const p of ["now", "next", "later"] as const) {
    const sel = await prioChip(task(`p-${p}`, { priority: p }));
    expect(sel.props.value).toBe(p);
    expect(sel.props.className).toContain(`prio-${p}`);
  }
});

test("normal is the quiet default: the chip renders in the no-noise class", async () => {
  const sel = await prioChip(task("p-normal", { priority: "normal" }));
  expect(sel.props.className).toContain("prio-normal");
  // A task the API answered before priority existed reads as normal too.
  expect((await prioChip(task("p-missing"))).props.className).toContain("prio-normal");
});

test("the queued column sorts by priority first, then by the longest wait", async () => {
  const at = (iso: string) => ({ created_at: iso });
  const queued = [
    task("normal-new", { priority: "normal", ...at("2026-01-04T00:00:00.000Z") }),
    task("later-old", { priority: "later", ...at("2026-01-01T00:00:00.000Z") }),
    task("now-new", { priority: "now", ...at("2026-01-05T00:00:00.000Z") }),
    task("normal-old", { priority: "normal", ...at("2026-01-02T00:00:00.000Z") }),
    task("next-newest", { priority: "next", ...at("2026-01-06T00:00:00.000Z") }),
  ];
  // Ages run backwards from the priority order, so passing on created_at alone
  // is impossible: the highest priority here is also the newest task.
  expect(queueOrder(queued).map((t) => t.id)).toEqual([
    "now-new",
    "next-newest",
    "normal-old",
    "normal-new",
    "later-old",
  ]);
  // An unrecognised value (only a hand-edited row) sorts last, with 'later'.
  const odd = [
    task("weird", { priority: "urgent" as never, ...at("2026-01-09T00:00:00.000Z") }),
    task("later", { priority: "later", ...at("2026-01-08T00:00:00.000Z") }),
  ];
  expect(queueOrder(odd).map((t) => t.id)).toEqual(["later", "weird"]);
});
