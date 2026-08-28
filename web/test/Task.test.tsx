import { expect, test } from "bun:test";
import { act, create } from "react-test-renderer";
import { MemoryRouter } from "react-router-dom";
import { Ctx, type Store } from "../src/lib/store";
import { LightboxProvider } from "../src/lib/lightbox";
import { api } from "../src/lib/api";
import type { Task, TaskDetail, UnderstandingQuiz } from "../src/lib/api";
import { TaskBody } from "../src/views/Task";

const fakeStore = { tasks: [], projects: [], rev: {}, quizzes: [], reloadQuizzes: () => {} } as unknown as Store;

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
  totals: {
    total_tokens: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    cost_usd: 0,
    unpriced: 0,
    calls: 0,
  },
})) as typeof api.taskUsage;

function tree(t: Task, store: Store = fakeStore, taskDetail: TaskDetail = detail(t)) {
  api.task = (async () => taskDetail) as typeof api.task;
  return (
    <MemoryRouter>
      <Ctx.Provider value={store}>
        <LightboxProvider>
          <TaskBody id={t.id} />
        </LightboxProvider>
      </Ctx.Provider>
    </MemoryRouter>
  );
}

const quiz = (taskId: string, extra: Partial<UnderstandingQuiz> = {}): UnderstandingQuiz => ({
  id: `quiz-${taskId}`,
  task_id: taskId,
  ts: "2026-01-01T00:00:00.000Z",
  task_number: 1,
  task_title: "task",
  task_state: "done",
  task_kind: "ship",
  project_id: "project",
  report: {},
  question: "Why does this matter?",
  options: [{ key: "a", label: "A" }, { key: "b", label: "B" }],
  version: `quiz-${taskId}:0`,
  status: "required",
  ...extra,
});

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

// The endpoint 409s on anything but a done task, so the board must not offer
// the button before then.
test("Promote to playbook shows only on a done task", async () => {
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(tree(task("still-going", { state: "in_progress" })));
  });
  expect(btn(renderer, "Promote to playbook").length).toBe(0);

  await act(async () => {
    renderer = create(tree(task("finished", { state: "done" })));
  });
  expect(btn(renderer, "Promote to playbook").length).toBe(1);
});

test("the task timeline renders director actors on actions and resolved decisions", async () => {
  const t = task("actors", { state: "in_progress" });
  const d = {
    id: "dec-actors",
    task_id: t.id,
    ts: "2026-01-01T00:00:00.000Z",
    title: "Ship now?",
    context: "Choose whether to ship.",
    risk: "low",
    blast_radius: null,
    options: [{ key: "yes", label: "Ship" }],
    status: "answered",
    answer_key: "yes",
    answer_note: null,
    draft_note: null,
    answered_at: "2026-01-01T00:00:02.000Z",
    answered_by: "director",
    answered_actor: "director-tab-a",
  } as const;
  const taskDetail = {
    ...detail(t),
    events: [
      { id: "evt-decision", task_id: t.id, ts: d.ts, source: "agent", type: "needs-decision", payload: { decision_id: d.id } },
      { id: "evt-merge", task_id: t.id, ts: "2026-01-01T00:00:03.000Z", source: "director", type: "merged", payload: { actor: "director-tab-b" } },
    ],
    decisions: [d],
  } as unknown as TaskDetail;
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(tree(t, fakeStore, taskDetail));
  });

  const text = JSON.stringify(renderer.toJSON());
  expect(text).toContain("director-tab-a");
  expect(text).toContain("director-tab-b");
});

// The server accepts understanding-quiz answers in in_review/verifying/done/failed
// (server/src/api.ts's UNDERSTANDING_QUIZ_ANSWERABLE_STATES), but the task page
// used to only render the quiz when state === "in_review" — a task moved to
// done/failed with a pending quiz showed no way to clear it (hive-1028).
for (const state of ["done", "failed", "verifying"] as const) {
  test(`a pending understanding quiz renders on the task page for a ${state} task`, async () => {
    const t = task(`${state}-task`, { state });
    const q = quiz(t.id, { task_state: state });
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(tree(t, { ...fakeStore, quizzes: [q] } as unknown as Store));
    });

    const questions = renderer.root.findAll((n) => n.type === "h4" && n.children.includes(q.question));
    expect(questions.length).toBe(1);

    const labels = renderer.root.findAll((n) => n.props.className === "understanding-quiz-label");
    expect(labels[0].children.join("")).toContain("Confirm you understood the change");
  });
}
