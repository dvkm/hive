import { expect, test } from "bun:test";
import { act, create } from "react-test-renderer";
import { MemoryRouter } from "react-router-dom";
import { api } from "../src/lib/api";
import type { Brief as BriefData, Decision, Evidence, Task } from "../src/lib/api";
import { LightboxProvider } from "../src/lib/lightbox";
import { Ctx, type Store } from "../src/lib/store";
import Brief from "../src/views/Brief";
import { DecisionCard } from "../src/views/DecisionCard";

(globalThis as unknown as { window: typeof globalThis }).window = globalThis;
const values = new Map([["hive.inbox.mode", "backlogs"]]);
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  },
});

const task: Task = {
  id: "task-1",
  number: 1,
  project_id: "project-1",
  title: "Evidence task",
  brief: "",
  state: "in_progress",
  kind: "ship",
  agent_target: "agent-1",
  worktree_path: null,
  branch: null,
  pr_url: null,
  ci_status: null,
  head_sha: "abc123",
  summary: null,
  source: "agent",
  source_ref: null,
  parent_task_id: null,
  duplicate_of: null,
  depends_on: [],
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

const evidence: Evidence[] = [
  { id: "shot", task_id: task.id, ts: task.updated_at, kind: "screenshot", path: null, url: "/evidence/shot.png", caption: "Finished screen", meta: {} },
  { id: "tests", task_id: task.id, ts: task.updated_at, kind: "test_run", path: null, url: "/evidence/tests.txt", caption: "Tests pass", meta: {} },
];
const checkpoint = { id: "checkpoint-1", task_id: task.id, ts: task.updated_at, task_number: 1, task_title: task.title, task_state: task.state, project_id: task.project_id, note: "Check this" };

api.morningBrief = (async () => ({
  since: null,
  done: [],
  director_required_task_ids: [],
  failed_or_attention: [],
  decisions: [],
  fleet: [],
  incidents: [],
  intake: [],
  to_review: [],
  spend: { totals: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, total_tokens: 0, cost_usd: 0, unpriced: 0, calls: 0 }, by_model: [] },
  learnings_new: [],
}) satisfies BriefData) as typeof api.morningBrief;
api.evidence = (async () => ({ evidence: evidence.map((item) => ({ ...item, task_title: task.title, task_kind: task.kind, project_id: task.project_id, project_name: "Project" })) })) as typeof api.evidence;

test("Focus and Backlogs show task evidence inline", async () => {
  const store = {
    tasks: [task],
    needsYou: [{ kind: "checkpoint", id: checkpoint.id, checkpoint }],
    checkpoints: [checkpoint],
    rev: {},
    reloadCheckpoints: () => {},
    reloadQuizzes: () => {},
  } as unknown as Store;
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(
      <MemoryRouter>
        <Ctx.Provider value={store}>
          <LightboxProvider><Brief /></LightboxProvider>
        </Ctx.Provider>
      </MemoryRouter>
    );
  });

  expect(renderer.root.findAll((node) => node.type === "img" && node.props.alt === "Finished screen")).toHaveLength(1);
  expect(renderer.root.findByProps({ className: "rev-ev-cap" }).children).toContain("Tests pass");

  await act(async () => {
    renderer.root.findAll((node) => node.type === "button" && node.children.includes("Focus"))[0].props.onClick();
  });
  expect(renderer.root.findAll((node) => node.type === "img" && node.props.alt === "Finished screen")).toHaveLength(1);
  expect(renderer.root.findByProps({ className: "rev-ev-cap" }).children).toContain("Tests pass");
});

test("Focus resets local card state and evidence when advancing to the next item", async () => {
  values.set("hive.inbox.mode", "focus");
  const secondTask = { ...task, id: "task-2", number: 2, title: "Second task" };
  const decision = (id: string, taskId: string, title: string): Decision => ({
    id,
    task_id: taskId,
    ts: task.updated_at,
    title,
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
  });
  const first = decision("decision-1", task.id, "First decision");
  const second = decision("decision-2", secondTask.id, "Second decision");
  api.answerDecision = (() => new Promise(() => {})) as typeof api.answerDecision;
  api.evidence = ((query) => query.task === task.id
    ? Promise.resolve({ evidence: [{ ...evidence[0], caption: "First evidence", task_title: task.title, task_kind: task.kind, project_id: task.project_id, project_name: "Project" }] })
    : new Promise(() => {})) as typeof api.evidence;
  const store = {
    tasks: [task, secondTask],
    needsYou: [
      { kind: "decision", id: first.id, decision: first },
      { kind: "decision", id: second.id, decision: second },
    ],
    checkpoints: [],
    rev: {},
    reloadCheckpoints: () => {},
    reloadQuizzes: () => {},
  } as unknown as Store;
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(
      <MemoryRouter>
        <Ctx.Provider value={store}>
          <LightboxProvider><Brief /></LightboxProvider>
        </Ctx.Provider>
      </MemoryRouter>
    );
  });
  expect(renderer.root.findAll((node) => node.type === "img" && node.props.alt === "First evidence")).toHaveLength(1);

  act(() => {
    renderer.root.findByProps({ className: "btn btn-primary btn-submit" }).props.onClick();
  });
  expect(renderer.root.findByProps({ className: "btn btn-primary btn-submit" }).children).toContain("Submitting…");
  act(() => {
    renderer.root.findByType(DecisionCard).props.onDone(first.id);
  });

  expect(renderer.root.findByType("h2").children).toContain("Second decision");
  expect(renderer.root.findByProps({ className: "btn btn-primary btn-submit" }).children).toContain("Submit decision");
  expect(renderer.root.findAll((node) => node.type === "img" && node.props.alt === "First evidence")).toHaveLength(0);
});
