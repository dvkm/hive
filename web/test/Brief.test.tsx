import { beforeEach, expect, test } from "bun:test";
import { act, create } from "react-test-renderer";
import { MemoryRouter } from "react-router-dom";
import { api } from "../src/lib/api";
import type { Brief as BriefData, Decision, Evidence, Task, UnderstandingQuiz as UnderstandingQuizData } from "../src/lib/api";
import { LightboxProvider } from "../src/lib/lightbox";
import { Ctx, resetQuizStatesForTests, type Store } from "../src/lib/store";
import Brief from "../src/views/Brief";

// Quiz state lives in a module-level map shared across every bun test file.
beforeEach(resetQuizStatesForTests);
import { DecisionCard } from "../src/views/DecisionCard";
import { ReferenceText } from "../src/lib/references";
import { UnderstandingQuiz } from "../src/views/UnderstandingQuiz";

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
    projects: [{ id: task.project_id, name: "Project" }],
    needsYou: [{ kind: "checkpoint", id: checkpoint.id, checkpoint }],
    checkpoints: [checkpoint],
    rev: {},
    reloadCheckpoints: () => {},
    reloadQuizzes: () => {},
    decisionsLoaded: true,
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
    projects: [{ id: task.project_id, name: "Project" }],
    needsYou: [
      { kind: "decision", id: first.id, decision: first },
      { kind: "decision", id: second.id, decision: second },
    ],
    checkpoints: [],
    rev: {},
    reloadCheckpoints: () => {},
    reloadQuizzes: () => {},
    decisionsLoaded: true,
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

  expect(renderer.root.findByType("h2").findByType(ReferenceText).props.text).toBe("Second decision");
  expect(renderer.root.findByProps({ className: "btn btn-primary btn-submit" }).children).toContain("Submit decision");
  expect(renderer.root.findAll((node) => node.type === "img" && node.props.alt === "First evidence")).toHaveLength(0);
});

test("the project picker scopes Focus to the chosen project", async () => {
  values.set("hive.inbox.mode", "focus");
  values.set("hive.board.project", "project-2");
  const otherTask = { ...task, id: "task-3", number: 3, project_id: "project-2", title: "Other project task" };
  const mine = { id: "checkpoint-2", task_id: otherTask.id, ts: task.updated_at, task_number: 3, task_title: otherTask.title, task_state: otherTask.state, project_id: "project-2", note: "Mine" };
  api.evidence = (async () => ({ evidence: [] })) as typeof api.evidence;
  const store = {
    tasks: [task, otherTask],
    projects: [{ id: "project-1", name: "Project one" }, { id: "project-2", name: "Project two" }],
    needsYou: [
      { kind: "checkpoint", id: checkpoint.id, checkpoint },
      { kind: "checkpoint", id: mine.id, checkpoint: mine },
    ],
    checkpoints: [checkpoint, mine],
    rev: {},
    reloadCheckpoints: () => {},
    reloadQuizzes: () => {},
    decisionsLoaded: true,
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

  // Only the chosen project's checkpoint counts, so the queue reads "1 of 1".
  expect(renderer.root.findByProps({ className: "brief-focus-nav" }).children.filter((c) => typeof c === "string").join("")).toBe("1 of 1");
  // "Project two" is the selected chip; "All" is not.
  const chip = (name: string) => renderer.root.findAll((node) => node.type === "button" && node.children.includes(name))[0];
  expect(chip("Project two").props.className).toContain("board-chip-on");
  expect(chip("All").props.className).not.toContain("board-chip-on");
  values.delete("hive.board.project");
});

test("Focus shows every checkpoint for its current task on one page", async () => {
  values.set("hive.inbox.mode", "focus");
  values.delete("hive.board.project");
  const second = { ...checkpoint, id: "checkpoint-2", note: "Check this too" };
  const otherTask = { ...task, id: "task-2", number: 2, title: "Other task" };
  const other = { ...checkpoint, id: "checkpoint-3", task_id: otherTask.id, task_number: 2, task_title: otherTask.title, note: "Later" };
  api.evidence = (async () => ({ evidence: [] })) as typeof api.evidence;
  const checkpoints = [checkpoint, second, other];
  const store = {
    tasks: [task, otherTask],
    projects: [{ id: task.project_id, name: "Project" }],
    needsYou: checkpoints.map((item) => ({ kind: "checkpoint", id: item.id, checkpoint: item })),
    checkpoints,
    rev: {},
    reloadCheckpoints: () => {},
    reloadQuizzes: () => {},
    decisionsLoaded: true,
  } as unknown as Store;
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(
      <MemoryRouter initialEntries={["/inbox"]}>
        <Ctx.Provider value={store}>
          <LightboxProvider><Brief /></LightboxProvider>
        </Ctx.Provider>
      </MemoryRouter>
    );
  });

  expect(renderer.root.findAll((node) => String(node.props.className ?? "").startsWith("cp-row"))).toHaveLength(2);
  expect(renderer.root.findByProps({ className: "brief-focus-nav" }).children.filter((c) => typeof c === "string").join("")).toBe("1 of 2");
  expect(renderer.root.findAll((node) => node.props.className === "cp-note").map((node) => node.children.join(""))).toEqual(["Check this", "Check this too"]);
});

test("Focus arrows step past an item you cannot act on", async () => {
  values.set("hive.inbox.mode", "focus");
  values.delete("hive.board.project");
  const otherTask = { ...task, id: "task-2", number: 2, title: "Other task" };
  const other = { ...checkpoint, id: "checkpoint-3", task_id: otherTask.id, task_number: 2, task_title: otherTask.title, note: "Later" };
  api.evidence = (async () => ({ evidence: [] })) as typeof api.evidence;
  const checkpoints = [checkpoint, other];
  const store = {
    tasks: [task, otherTask],
    projects: [{ id: task.project_id, name: "Project" }],
    needsYou: checkpoints.map((item) => ({ kind: "checkpoint", id: item.id, checkpoint: item })),
    checkpoints,
    rev: {},
    reloadCheckpoints: () => {},
    reloadQuizzes: () => {},
    decisionsLoaded: true,
  } as unknown as Store;
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(
      <MemoryRouter initialEntries={["/inbox"]}>
        <Ctx.Provider value={store}>
          <LightboxProvider><Brief /></LightboxProvider>
        </Ctx.Provider>
      </MemoryRouter>
    );
  });
  const counter = () => renderer.root.findByProps({ className: "brief-focus-nav" }).children.filter((c) => typeof c === "string").join("");
  const arrow = (label: string) => renderer.root.findByProps({ "aria-label": label });
  const notes = () => renderer.root.findAll((node) => node.props.className === "cp-note").map((node) => node.children.join(""));

  expect(counter()).toBe("1 of 2");
  expect(notes()).toEqual(["Check this"]);
  expect(arrow("Previous item").props.disabled).toBe(true);

  await act(async () => { arrow("Next item").props.onClick(); });
  expect(counter()).toBe("2 of 2");
  expect(notes()).toEqual(["Later"]);
  expect(arrow("Next item").props.disabled).toBe(true);

  await act(async () => { arrow("Previous item").props.onClick(); });
  expect(counter()).toBe("1 of 2");
  expect(notes()).toEqual(["Check this"]);
});

test("Backlog task links open against the backlog location for modal history", async () => {
  values.set("hive.inbox.mode", "backlogs");
  values.delete("hive.board.project");
  api.evidence = (async () => ({ evidence: [] })) as typeof api.evidence;
  const store = {
    tasks: [task],
    projects: [{ id: task.project_id, name: "Project" }],
    needsYou: [{ kind: "checkpoint", id: checkpoint.id, checkpoint }],
    checkpoints: [checkpoint],
    rev: {},
    reloadCheckpoints: () => {},
    reloadQuizzes: () => {},
    decisionsLoaded: true,
  } as unknown as Store;
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(
      <MemoryRouter initialEntries={["/inbox"]}>
        <Ctx.Provider value={store}>
          <LightboxProvider><Brief /></LightboxProvider>
        </Ctx.Provider>
      </MemoryRouter>
    );
  });

  const taskLink = renderer.root.findAll((node) => node.props.to === `/tasks/${task.id}`)[0];
  expect(taskLink.props.state.backgroundLocation.pathname).toBe("/inbox");
});

test("five deferred quizzes are one catch-up row, and finishing the flow clears all five", async () => {
  values.delete("hive.board.project");
  api.evidence = (async () => ({ evidence: [] })) as typeof api.evidence;
  const quizzes = [1, 2, 3, 4, 5].map((n) => ({
    id: `quiz-${n}`,
    task_id: `shipped-${n}`,
    ts: task.updated_at,
    task_number: n,
    task_title: `Shipped change ${n}`,
    task_state: "done",
    task_kind: "ship",
    project_id: task.project_id,
    report: { done: [], iffy: [], decisions: [], testing: [], followups: [] },
    question: `Question ${n}?`,
    options: [{ key: "a", label: "A" }, { key: "b", label: "B" }],
    version: `v${n}`,
    status: "deferred",
  })) as unknown as UnderstandingQuizData[];
  const store = {
    tasks: quizzes.map((quiz, i) => ({ ...task, id: quiz.task_id, number: i + 1, title: quiz.task_title, state: "done" })),
    projects: [{ id: task.project_id, name: "Project" }],
    needsYou: [{ kind: "quiz_digest", id: `quiz-digest:${task.project_id}`, quizzes }],
    checkpoints: [],
    quizzes,
    rev: {},
    reloadCheckpoints: () => {},
    reloadQuizzes: () => {},
    decisionsLoaded: true,
  } as unknown as Store;

  values.set("hive.inbox.mode", "backlogs");
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
  // One row for all five, not five rows, and the Backlogs count agrees.
  const rows = renderer.root.findAll((node) => node.type === "li" && node.props.className === undefined);
  expect(rows).toHaveLength(1);
  expect(renderer.root.findAll((node) => node.type === "button" && String(node.children[0]).startsWith("Catch up on"))[0].children.join(""))
    .toBe("Catch up on 5 shipped changes");
  expect(renderer.root.findByProps({ className: "brief-count" }).children).toEqual(["1"]);

  // The row opens the single sequential flow: one question at a time, in order.
  await act(async () => {
    renderer.root.findAll((node) => node.type === "button" && String(node.children[0]).startsWith("Catch up on"))[0].props.onClick();
  });
  for (let n = 1; n <= 5; n += 1) {
    expect(renderer.root.findByType(UnderstandingQuiz).props.quiz.question).toBe(`Question ${n}?`);
    await act(async () => {
      renderer.root.findByType(UnderstandingQuiz).props.onPassed(null);
    });
  }
  // All five cleared by the one flow — nothing left in the queue.
  expect(renderer.root.findAll((node) => node.type === UnderstandingQuiz)).toHaveLength(0);
  expect(renderer.root.findByProps({ className: "empty-big" }).children).toContain("All quiet.");
});

test("two projects with pending quizzes get separate digest rows whose counts sum to the total", async () => {
  values.delete("hive.board.project");
  api.evidence = (async () => ({ evidence: [] })) as typeof api.evidence;
  const projectA = "project-a";
  const projectB = "project-b";
  const quizzesA = [1, 2].map((n) => ({
    id: `quiz-a${n}`,
    task_id: `shipped-a${n}`,
    ts: task.updated_at,
    task_number: n,
    task_title: `A change ${n}`,
    task_state: "done",
    task_kind: "ship",
    project_id: projectA,
    report: { done: [], iffy: [], decisions: [], testing: [], followups: [] },
    question: `A question ${n}?`,
    options: [{ key: "a", label: "A" }, { key: "b", label: "B" }],
    version: `va${n}`,
    status: "deferred",
  })) as unknown as UnderstandingQuizData[];
  const quizzesB = [1, 2, 3].map((n) => ({
    id: `quiz-b${n}`,
    task_id: `shipped-b${n}`,
    ts: task.updated_at,
    task_number: n,
    task_title: `B change ${n}`,
    task_state: "done",
    task_kind: "ship",
    project_id: projectB,
    report: { done: [], iffy: [], decisions: [], testing: [], followups: [] },
    question: `B question ${n}?`,
    options: [{ key: "a", label: "A" }, { key: "b", label: "B" }],
    version: `vb${n}`,
    status: "deferred",
  })) as unknown as UnderstandingQuizData[];
  const allQuizzes = [...quizzesA, ...quizzesB];
  const store = {
    tasks: allQuizzes.map((quiz, i) => ({ ...task, id: quiz.task_id, project_id: quiz.project_id, number: i + 1, title: quiz.task_title, state: "done" })),
    projects: [{ id: projectA, name: "Project A" }, { id: projectB, name: "Project B" }],
    needsYou: [
      { kind: "quiz_digest", id: `quiz-digest:${projectA}`, quizzes: quizzesA },
      { kind: "quiz_digest", id: `quiz-digest:${projectB}`, quizzes: quizzesB },
    ],
    checkpoints: [],
    quizzes: allQuizzes,
    rev: {},
    reloadCheckpoints: () => {},
    reloadQuizzes: () => {},
    decisionsLoaded: true,
  } as unknown as Store;

  values.set("hive.inbox.mode", "backlogs");
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

  // Two projects with pending quizzes: two catch-up rows, and the "Catch up"
  // section badge (a count of digest ITEMS, matching the topbar's own item-based
  // badge) reflects both — the per-row totals underneath sum to all 5 quizzes.
  const catchUpButtons = renderer.root.findAll((node) => node.type === "button" && String(node.children[0]).startsWith("Catch up on"));
  expect(catchUpButtons).toHaveLength(2);
  const rowTotals = catchUpButtons.map((btn) => Number(btn.children.join("").match(/Catch up on (\d+)/)![1]));
  expect(rowTotals.sort()).toEqual([2, 3]);
  expect(rowTotals.reduce((sum, n) => sum + n, 0)).toBe(allQuizzes.length);
  expect(renderer.root.findByProps({ className: "brief-count" }).children).toEqual(["2"]);

  // Filtering to one project narrows to just that project's row and count.
  await act(async () => {
    window.dispatchEvent(new CustomEvent("hive:project-filter", { detail: projectA }));
  });
  const filteredButtons = renderer.root.findAll((node) => node.type === "button" && String(node.children[0]).startsWith("Catch up on"));
  expect(filteredButtons).toHaveLength(1);
  expect(filteredButtons[0].children.join("")).toBe("Catch up on 2 shipped changes");
});

// HIVE-413: a blocking plan checkpoint is approved from the card itself, so the
// card must carry the plan and the critic's concerns without a task-page visit.
test("Focus shows a blocking plan's fields and the critic's concerns on the card", async () => {
  values.set("hive.inbox.mode", "focus");
  values.delete("hive.board.project");
  api.evidence = (async () => ({ evidence: [] })) as typeof api.evidence;
  const planCheckpoint = {
    ...checkpoint,
    id: "checkpoint-plan",
    note: "add the release steer",
    blocking: true,
    plan: {
      goal: "add the release steer",
      approach: "steer the agent from the ack endpoint",
      files_expected: ["server/src/api.ts"],
      verification_planned: "bun test server/test/plan-critic.test.ts",
    },
    concerns: [{ severity: "veto" as const, text: "The plan never says how auto-ack is scheduled." }],
  };
  const store = {
    tasks: [task],
    projects: [{ id: task.project_id, name: "Project" }],
    needsYou: [{ kind: "checkpoint", id: planCheckpoint.id, checkpoint: planCheckpoint }],
    checkpoints: [planCheckpoint],
    rev: {},
    reloadCheckpoints: () => {},
    reloadQuizzes: () => {},
    decisionsLoaded: true,
  } as unknown as Store;
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(
      <MemoryRouter initialEntries={["/inbox"]}>
        <Ctx.Provider value={store}>
          <LightboxProvider><Brief /></LightboxProvider>
        </Ctx.Provider>
      </MemoryRouter>
    );
  });

  const text = JSON.stringify(renderer.toJSON());
  expect(text).toContain("steer the agent from the ack endpoint");
  expect(text).toContain("server/src/api.ts");
  expect(text).toContain("bun test server/test/plan-critic.test.ts");
  expect(text).toContain("The plan never says how auto-ack is scheduled.");
  expect(text).toContain("VETO");
  // The agent is parked, and the card says so.
  expect(renderer.root.findAll((node) => String(node.props.className ?? "").includes("cp-waiting"))).toHaveLength(1);
});

// HIVE-611: the verify queue used to render a title-less strip of thumbnails,
// with the pager saying "1 of 3" and a line under it saying "2 more waiting".
test("Focus gives a verify item a real card and states the queue size once", async () => {
  values.set("hive.inbox.mode", "focus");
  values.delete("hive.board.project");
  const verifying: Task = { ...task, id: "task-v", number: 9, title: "Verify me", state: "verifying" };
  api.evidence = (async () => ({ evidence: [] })) as typeof api.evidence;
  api.task = (async () => ({ ...verifying, events: [], evidence: [], decisions: [] })) as typeof api.task;
  const store = {
    tasks: [verifying],
    projects: [{ id: task.project_id, name: "Project" }],
    needsYou: [{ kind: "verify", id: verifying.id, task: verifying }],
    checkpoints: [],
    rev: {},
    reloadCheckpoints: () => {},
    reloadQuizzes: () => {},
    decisionsLoaded: true,
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
  expect(renderer.root.findAllByProps({ className: "review-card verify-card" })).toHaveLength(1);
  expect(JSON.stringify(renderer.toJSON())).not.toContain("more waiting");
});
