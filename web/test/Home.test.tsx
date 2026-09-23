import { expect, test } from "bun:test";
import { act, create } from "react-test-renderer";
import { MemoryRouter } from "react-router-dom";
import { api } from "../src/lib/api";
import type { Decision, Digest, Intent, Task } from "../src/lib/api";
import { getNeedsYouItems } from "../src/lib/needsYou";
import { Ctx, type Store } from "../src/lib/store";
import Home from "../src/views/Home";

(globalThis as unknown as { window: typeof globalThis }).window = globalThis;
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: { getItem: () => null, setItem: () => {} },
});

const task = (id: string, extra: Partial<Task> = {}): Task => ({
  id,
  number: 1,
  project_id: "p1",
  title: `Task ${id}`,
  brief: "",
  state: "in_progress",
  kind: "ship",
  agent_target: null,
  worktree_path: null,
  branch: null,
  pr_url: null,
  ci_status: null,
  head_sha: null,
  summary: null,
  source: "agent",
  source_ref: null,
  parent_task_id: null,
  duplicate_of: null,
  depends_on: [],
  created_at: "2026-09-20T00:00:00.000Z",
  updated_at: "2026-09-20T00:00:00.000Z",
  ...extra,
});

const decision = (id: string, taskId: string, extra: Partial<Decision> = {}): Decision =>
  ({
    id,
    task_id: taskId,
    ts: "2026-09-21T00:00:00.000Z",
    title: `Question ${id}?`,
    context: null,
    risk: null,
    blast_radius: null,
    options: [{ key: "yes", label: "Yes", recommended: true }],
    status: "open",
    answer_key: null,
    answer_note: null,
    draft_note: null,
    answered_at: null,
    answered_by: null,
    answered_actor: null,
    decision_class: null,
    ...extra,
  }) as Decision;

const DIGEST: Digest = {
  since: "2026-09-22T10:00:00.000Z",
  until: "2026-09-23T10:00:00.000Z",
  projects: [
    {
      id: "p1",
      name: "acme",
      shipped: [
        { title: "fix(web): sector badges", url: "https://github.com/o/r/pull/1", merged_at: "2026-09-23T01:00:00.000Z", task_id: "s1" },
        { title: "feat: autosave", url: "https://github.com/o/r/pull/2", merged_at: "2026-09-23T02:00:00.000Z", task_id: null },
      ],
      shipped_total: 5,
      reports: [{ task_id: "r1", title: "Why the export is slow", url: null, at: "2026-09-23T03:00:00.000Z" }],
      decided: [{ decision_id: "dh1", task_id: "t9", question: "Retry the flaky job?", answer: "Retry once", why: "Hive decided: it passed on the last three runs.", at: "2026-09-23T04:00:00.000Z" }],
      stuck: [{ task_id: "st1", title: "Migrate the cache", reason: "CI has been red for two hours", since: null }],
      working: [{ task_id: "w1", title: "Working on it" }],
      working_total: 4,
      queued: 2,
      waiting_on_others: [{ task_id: "wo1", title: "Fix the sector badge", key: "ABC-12", asked_at: "2026-09-23T05:00:00.000Z" }],
      new_requests: [{ task_id: "n1", key: "ABC-13", title: "Add a dark mode toggle", at: "2026-09-23T06:00:00.000Z" }],
    },
    // Nothing to say: no section at all.
    { id: "p2", name: "quiet", shipped: [], shipped_total: 0, reports: [], decided: [], stuck: [], working: [], working_total: 0, queued: 0, waiting_on_others: [], new_requests: [] },
  ],
};

function storeFor(decisions: Decision[], tasks: Task[], intents: Intent[]): Store {
  return {
    tasks,
    decisions,
    intents,
    needsYou: getNeedsYouItems(decisions, tasks, intents),
    projects: [{ id: "p1", name: "acme" }, { id: "p2", name: "quiet" }],
    projectsLoaded: true,
    decisionsLoaded: true,
    feedEvents: [],
    reloadIntents: () => {},
    away: { on: false, active: false, held: 0 },
  } as unknown as Store;
}

// The strings a reader actually sees, flattened across JSX text children.
function flatten(node: any): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(flatten).join("");
  return flatten(node.children);
}

async function render(store: Store) {
  const calls: unknown[][] = [];
  const original = api.digest;
  api.digest = (async (...args: unknown[]) => {
    calls.push(args);
    return DIGEST;
  }) as typeof api.digest;
  let renderer!: ReturnType<typeof create>;
  try {
    await act(async () => {
      renderer = create(
        <MemoryRouter>
          <Ctx.Provider value={store}>
            <Home />
          </Ctx.Provider>
        </MemoryRouter>
      );
    });
  } finally {
    api.digest = original;
  }
  return { renderer, calls, text: flatten(renderer.toJSON()) };
}

test("Home shows the first three calls, says how many more, and names why each needs you", async () => {
  const review = task("rev", { state: "in_review", review_gate: "needs_you", review_actionable: true, review_hold: "It changes billing, so it waits for your Ship.", pr_url: "https://github.com/o/r/pull/9" });
  const decisions = [
    decision("d1", "t1", { advice: "Only you know which customer this is for." }),
    decision("d2", "t2"),
    decision("hive-only", "t3", { for_director: false }),
  ];
  const draft = { id: "i1", project_id: "p1", task_id: null, status: "draft", source: "director", source_ref: null, body_md: "## Problem\nExports time out.\n", updated_at: "2026-09-21T00:00:00.000Z" } as unknown as Intent;
  const { renderer, text } = await render(storeFor(decisions, [review], [draft]));

  expect(renderer.root.findByProps({ className: "home-headline" }).children.join("")).toBe("4 things need you.");
  // A draft ask comes first, then the oldest calls; the fourth waits its turn.
  expect(text).toContain("Exports time out.");
  expect(text).toContain("It changes billing, so it waits for your Ship.");
  expect(text).toContain("Question d1?");
  expect(text).toContain("Only you know which customer this is for.");
  expect(text).not.toContain("Question d2?");
  expect(text).toContain("1 more after these.");
  // The advisor kept this one for hive, so it is nowhere on Home.
  expect(text).not.toContain("Question hive-only?");
});

test("an ask on Home shows its problem and questions; the rest of the draft folds away", async () => {
  const body_md = "## Problem\nExports time out.\n\n## Constraints\nKeep the CSV format.\n\n## Open questions\n- [ ] Which exports?\n";
  const draft = { id: "i1", project_id: "p1", task_id: null, status: "draft", source: "director", source_ref: null, body_md, updated_at: "2026-09-21T00:00:00.000Z" } as unknown as Intent;
  const { renderer } = await render(storeFor([], [], [draft]));

  const [folded] = renderer.root.findAll((n) => n.type === "details" && n.props.className === "review-details");
  expect(flatten(folded)).toContain("Keep the CSV format.");
  expect(flatten(folded)).not.toContain("Exports time out.");
  expect(flatten(folded)).not.toContain("Which exports?");
});

test("a review call carries its reason, its PR and a Ship button", async () => {
  const review = task("rev", { state: "in_review", review_gate: "needs_you", review_actionable: true, review_hold: "It changes billing, so it waits for your Ship.", pr_url: "https://github.com/o/r/pull/9" });
  const { renderer, text } = await render(storeFor([], [review], []));

  expect(renderer.root.findByProps({ className: "home-headline" }).children.join("")).toBe("1 thing needs you.");
  expect(text).toContain("It changes billing, so it waits for your Ship.");
  expect(text).toContain("PR #9");
  expect(renderer.root.findAll((n) => n.type === "button" && n.children.includes("Ship"))).toHaveLength(1);
  expect(renderer.root.findAll((n) => n.type === "button" && n.children.includes("Request changes"))).toHaveLength(1);
});

test("Home marks the look once and renders the digest per project", async () => {
  const { renderer, calls, text } = await render(storeFor([], [], []));

  expect(renderer.root.findByProps({ className: "home-headline" }).children.join("")).toBe("Nothing needs you.");
  expect(calls).toEqual([[true, undefined]]);

  expect(text).toContain("Since you last looked");
  expect(text).toContain("acme");
  expect(text).not.toContain("quiet");
  const links = renderer.root.findAll((n) => n.type === "a").map((n) => String(n.props.href));
  expect(links).toContain("https://github.com/o/r/pull/1");
  expect(text).toContain("fix(web): sector badges");
  expect(text).toContain("+3 more");
  expect(text).toContain("Why the export is slow");
  expect(text).toContain("Retry the flaky job?");
  expect(text).toContain("Retry once");
  // The section already says hive decided; the reason does not repeat it.
  expect(text).toContain("it passed on the last three runs.");
  expect(text).not.toContain("Hive decided: it passed");
  expect(text).toContain("CI has been red for two hours");
  expect(text).toContain("Asked the reporter about");
  expect(text).toContain("ABC-12");
  expect(text).toContain("ABC-13: Add a dark mode toggle");
  expect(text).toContain("4 in progress, 2 queued");
});

test("a fresh install gets the add-a-project step instead of an empty Home", async () => {
  const store = { ...storeFor([], [], []), projects: [] } as unknown as Store;
  const { text } = await render(store);
  expect(text).toContain("Connect your first project.");
  expect(text).not.toContain("Nothing needs you.");
});
