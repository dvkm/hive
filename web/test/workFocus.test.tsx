// The attention-first /work view (HIVE-356): needs-you rows first, everything
// agents are handling collapsed to one line each.
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create } from "react-test-renderer";
import { MemoryRouter } from "react-router-dom";
import { StaticRouter } from "react-router-dom/server";
import { Ctx, type Store } from "../src/lib/store";
import type { Decision, Task } from "../src/lib/api";
import { getNeedsYouItems } from "../src/lib/needsYou";
import { WorkFocus, heldLine } from "../src/views/Board";

(globalThis as unknown as { window: typeof globalThis }).window = globalThis;
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: { getItem: () => null, setItem: () => {} },
});

const task = (id: string, extra: Partial<Task> = {}): Task => ({
  id,
  number: Number(id.replace(/\D/g, "")) || 1,
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

const decision = (id: string, taskId: string, title: string) =>
  ({ id, task_id: taskId, ts: "2026-01-01T00:00:00.000Z", title, status: "open", options: [] }) as unknown as Decision;

// The Link props of every needs-you row, so a test can see where a click goes
// AND whether it asks for the modal route.
function links(tasks: Task[], decisions: Decision[] = []): { to: string; state: unknown }[] {
  let renderer: ReturnType<typeof create>;
  act(() => {
    renderer = create(
      <MemoryRouter>
        <Ctx.Provider value={storeFor(tasks, decisions)}>
          <WorkFocus visible={tasks} />
        </Ctx.Provider>
      </MemoryRouter>
    );
  });
  return renderer!.root
    .findAll((node) => typeof node.type !== "string" && node.props.className === "focus-row")
    .map((node) => ({ to: node.props.to as string, state: node.props.state }));
}

const storeFor = (tasks: Task[], decisions: Decision[]) =>
  ({
    projects: [],
    evidenceCount: {},
    spawnError: {},
    lastActivity: {},
    tasks,
    decisions,
    needsYou: getNeedsYouItems(decisions, tasks, [], []),
  }) as unknown as Store;

function render(tasks: Task[], decisions: Decision[] = []) {
  return renderToStaticMarkup(
    <StaticRouter location="/work">
      <Ctx.Provider value={storeFor(tasks, decisions)}>
        <WorkFocus visible={tasks} />
      </Ctx.Provider>
    </StaticRouter>
  );
}

test("the lane leads with the things that need the director", () => {
  const blocked = task("t1", { state: "needs_decision" });
  const ready = task("t2", { state: "in_review", review_actionable: true, ci_status: "passing" });
  const html = render([blocked, ready], [decision("d1", "t1", "Which database?")]);

  expect(html).toContain("Needs you");
  expect(html).toContain("Which database?");
  expect(html).toContain("Tests green");
  // The count is the actionable set, not every card on the board.
  expect(html).toContain('class="focus-lane-count">2<');
});

test("a review that is not yours yet is a status row, never part of the count", () => {
  // review_actionable is false: CI is still running, the review pass has not
  // finished. Visible, but it must not inflate "needs you".
  const pending = task("t3", { state: "in_review", review_actionable: false, ci_status: "pending" });
  const html = render([pending]);

  expect(html).toContain('class="focus-lane-count">0<');
  expect(html).toContain("Nothing needs you.");
  expect(html).toContain("status-row");
  expect(html).toContain("Task t3");
});

test("work in flight is one line each; queued work is only a count", () => {
  const working = task("t4", { state: "in_progress" });
  const queuedOne = task("t5", { state: "queued" });
  const queuedTwo = task("t6", { state: "queued" });
  const html = render([working, queuedOne, queuedTwo]);

  expect(html).toContain("Hive is handling");
  expect(html).toContain("2 queued · 1 in flight · 0 done today");
  expect(html).toContain("Task t4");
  // Queued cards are not being handled by anyone, so they get no row.
  expect(html).not.toContain("Task t5");
});

test("a decision row navigates for real: no modal state on a non-task link", () => {
  // /tasks/:id is the only modal route. Handing backgroundLocation to any other
  // path leaves the board rendered with nothing on top, so the click looks dead.
  const blocked = task("t7", { state: "needs_decision" });
  const review = task("t8", { state: "in_review", review_actionable: true });
  const rows = links([blocked, review], [decision("d2", "t7", "Which database?")]);

  expect(rows.find((row) => row.to === "/decisions#dcard-d2")?.state).toBeUndefined();
  expect(rows.find((row) => row.to === "/tasks/t8")?.state).toBeDefined();
});

test("the held line survives a server that answers without a held field", () => {
  // An older server answers /api/attention with no `held`. Reading through it
  // threw and blanked the whole board, which is the opposite of the point.
  expect(heldLine(undefined)).toBe("Nothing is being held yet.");
  expect(heldLine({ scouts: 0, watchers: 0 })).toBe("Nothing is being held yet.");
  expect(heldLine({ scouts: 1, watchers: 0 })).toContain("Holding 1 scout —");
  expect(heldLine({ scouts: 2, watchers: 1 })).toContain("Holding 2 scouts and 1 watched change");
});

// HIVE-604: hive never closes a task, so everything that merges stops in
// `verifying` and that column becomes the director's queue. The row has to be
// worth acting on from the phone: what landed, and one button to accept it.
test("a merged task waiting to be verified is a needs-you row with an Accept button", () => {
  const merged = task("t9", {
    state: "verifying",
    ci_status: "passing",
    pr_url: "https://github.com/example/repo/pull/123",
  });
  const html = render([merged]);

  expect(html).toContain('class="focus-lane-count">1<');
  expect(html).toContain("Verify");
  expect(html).toContain("Merged #123, tests green — check it, then accept");
  expect(html).toContain("Accept");
  // It is the director's, not something hive is still handling.
  expect(html).not.toContain("status-row");
});
