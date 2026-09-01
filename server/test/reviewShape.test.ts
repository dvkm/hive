import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HIVE_HOME = mkdtempSync(join(tmpdir(), "hive-reviewshape-"));

const { openDb } = await import("../src/db.ts");
const { makeHandler } = await import("../src/api.ts");
const { REVIEW_SUMMARY_HELP, REVIEW_SUMMARY_EXAMPLE } = await import("../src/reviewShape.ts");

const db = openDb(":memory:");
const handler = makeHandler(db);

async function post(path: string, body: unknown) {
  const res = await handler(new Request("http://127.0.0.1" + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
  return { status: res.status, json: (await res.json()) as any };
}

async function newTask() {
  const p = await post("/api/projects", { name: "p", repo_path: "/repo" });
  const t = await post("/api/tasks", { project_id: p.json.id, title: "t", brief: "b" });
  return t.json.id as string;
}

// The whole failure mode was documentation drifting from behaviour, so the help
// and the endpoint are checked against ONE example (hive-1947).
test("the documented review_summary example mints a quiz", async () => {
  const r = await post(`/api/tasks/${await newTask()}/events`, { type: "review_summary", ...REVIEW_SUMMARY_EXAMPLE });
  expect(r.status).toBe(201);
  const checks = r.json.event.payload.understanding.checks;
  expect(checks).toHaveLength(REVIEW_SUMMARY_EXAMPLE.understanding.checks.length);
  expect(checks[0].options[0]).toEqual({ key: "a", label: expect.any(String) });
  expect(checks[0].answer_key).toBe("a");
});

test("hive --help names every key the example uses", () => {
  const keys = new Set<string>();
  const walk = (value: unknown) => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (value && typeof value === "object")
      for (const [k, v] of Object.entries(value)) {
        keys.add(k);
        walk(v);
      }
  };
  walk(REVIEW_SUMMARY_EXAMPLE);
  for (const key of keys) expect(REVIEW_SUMMARY_HELP).toContain(key);
});

test("an understanding block with unusable checks is rejected, naming the shape", async () => {
  const taskId = await newTask();
  // Exactly the shape the old help documented: bare-string options.
  const r = await post(`/api/tasks/${taskId}/events`, {
    type: "review_summary",
    done: ["shipped"],
    understanding: { background: "b", check: { question: "Which one?", options: ["yes", "no"], answer_key: "yes" } },
  });
  expect(r.status).toBe(400);
  expect(r.json.error).toContain("options entries must be {key,label} objects");
});

test("a singular check object is stored as checks[]", async () => {
  const r = await post(`/api/tasks/${await newTask()}/events`, {
    type: "review_summary",
    understanding: { check: REVIEW_SUMMARY_EXAMPLE.understanding.checks[0] },
  });
  expect(r.status).toBe(201);
  expect(r.json.event.payload.understanding.checks).toHaveLength(1);
  expect(r.json.event.payload.understanding.check).toBeUndefined();
});

test("an understanding block with no checks at all is still accepted", async () => {
  const r = await post(`/api/tasks/${await newTask()}/events`, {
    type: "review_summary",
    done: ["shipped"],
    understanding: { background: "Drafts were lost.", essence: "The newest edit wins." },
  });
  expect(r.status).toBe(201);
  expect(r.json.event.payload.understanding.checks).toBeUndefined();
});

// HIVE-545: re-emitting a review (after a rebase, a risk finding, red CI) used
// to wipe the checks and un-land an approved PR.
test("a re-emitted review with no understanding block keeps the existing checks", async () => {
  const taskId = await newTask();
  await post(`/api/tasks/${taskId}/events`, { type: "review_summary", ...REVIEW_SUMMARY_EXAMPLE });
  const again = await post(`/api/tasks/${taskId}/events`, { type: "review_summary", done: ["rebased onto main"] });
  expect(again.status).toBe(201);
  expect(again.json.event.payload.understanding.checks).toHaveLength(1);
});

test("an explicit empty checks array clears them, and stays cleared", async () => {
  const taskId = await newTask();
  await post(`/api/tasks/${taskId}/events`, { type: "review_summary", ...REVIEW_SUMMARY_EXAMPLE });
  const cleared = await post(`/api/tasks/${taskId}/events`, {
    type: "review_summary",
    done: ["dropped the quiz"],
    understanding: { background: "b", checks: [] },
  });
  expect(cleared.status).toBe(201);
  expect(cleared.json.event.payload.understanding.checks).toEqual([]);
  const after = await post(`/api/tasks/${taskId}/events`, { type: "review_summary", done: ["rebased"] });
  expect(after.json.event.payload.understanding?.checks).toBeUndefined();
});

test("a passed quiz survives a re-emitted review", async () => {
  const taskId = await newTask();
  for (const to of ["in_progress", "in_review", "verifying"])
    await post(`/api/tasks/${taskId}/transition`, { to });
  await post(`/api/tasks/${taskId}/events`, { type: "review_summary", ...REVIEW_SUMMARY_EXAMPLE });
  const quizzes = await (await handler(new Request("http://127.0.0.1/api/understanding-quizzes"))).json();
  const quiz = quizzes.quizzes.find((q: any) => q.task_id === taskId);
  const answered = await post(`/api/tasks/${taskId}/understanding-quiz/answer`, {
    source: "director",
    answer_key: REVIEW_SUMMARY_EXAMPLE.understanding.checks[0].answer_key,
    version: quiz.version,
  });
  expect(answered.json.passed).toBe(true);
  await post(`/api/tasks/${taskId}/events`, { type: "review_summary", done: ["rebased onto main"] });
  // The quiz still exists (so the land gate can see it) and still reads passed.
  const after = await post(`/api/tasks/${taskId}/understanding-quiz/answer`, { source: "director" });
  expect(after.status).toBe(200);
  expect(after.json.passed).toBe(true);
});

// HIVE-545 (second pass): an agent that RE-LISTS the same checks with drifted
// wording used to wipe the answers just as thoroughly as one that omitted them.
// Answer whichever check is currently being asked, until the whole quiz passes.
async function passQuiz(taskId: string, checks: { question: string; answer_key: string }[]) {
  for (let i = 0; i < checks.length; i++) {
    const quizzes = await (await handler(new Request("http://127.0.0.1/api/understanding-quizzes"))).json();
    const quiz = quizzes.quizzes.find((q: any) => q.task_id === taskId);
    const answered = await post(`/api/tasks/${taskId}/understanding-quiz/answer`, {
      source: "director",
      answer_key: checks.find((check) => check.question === quiz.question)!.answer_key,
      version: quiz.version,
    });
    expect(answered.status).toBe(200);
  }
  const done = await post(`/api/tasks/${taskId}/understanding-quiz/answer`, { source: "director" });
  expect(done.json.passed).toBe(true);
}

async function readyTaskWithQuiz() {
  const taskId = await newTask();
  for (const to of ["in_progress", "in_review", "verifying"])
    await post(`/api/tasks/${taskId}/transition`, { to });
  await post(`/api/tasks/${taskId}/events`, { type: "review_summary", ...REVIEW_SUMMARY_EXAMPLE });
  await passQuiz(taskId, REVIEW_SUMMARY_EXAMPLE.understanding.checks as any);
  return taskId;
}

const EXAMPLE_CHECK = REVIEW_SUMMARY_EXAMPLE.understanding.checks[0] as any;
const reword = (text: string) => `  ${text.replace(/ /g, "  ")}\n`;

test("a passed quiz survives a review that re-lists the same checks, reworded", async () => {
  const taskId = await readyTaskWithQuiz();
  const again = await post(`/api/tasks/${taskId}/events`, {
    type: "review_summary",
    done: ["rebased onto main"],
    understanding: {
      background: "b",
      checks: [{ ...EXAMPLE_CHECK, question: reword(EXAMPLE_CHECK.question) }],
    },
  });
  expect(again.status).toBe(201);
  const after = await post(`/api/tasks/${taskId}/understanding-quiz/answer`, { source: "director" });
  expect(after.json.passed).toBe(true);
});

test("a passed quiz survives the same checks listed in a different order", async () => {
  const taskId = await newTask();
  for (const to of ["in_progress", "in_review", "verifying"])
    await post(`/api/tasks/${taskId}/transition`, { to });
  const two = [
    { question: "What breaks if this ships?", options: [{ key: "a", label: "Nothing" }, { key: "b", label: "Landing" }], answer_key: "a" },
    { question: "Where does the fix live?", options: [{ key: "a", label: "The CLI" }, { key: "b", label: "The server" }], answer_key: "b" },
  ];
  await post(`/api/tasks/${taskId}/events`, { type: "review_summary", done: ["shipped"], understanding: { background: "b", checks: two } });
  // Answer both, so the whole quiz is passed rather than half of it.
  await passQuiz(taskId, two);
  const again = await post(`/api/tasks/${taskId}/events`, {
    type: "review_summary",
    done: ["rebased"],
    understanding: { background: "b", checks: [two[1], two[0]] },
  });
  expect(again.status).toBe(201);
  const after = await post(`/api/tasks/${taskId}/understanding-quiz/answer`, { source: "director" });
  expect(after.json.passed).toBe(true);
});

// Trap: the question is untouched but the ANSWERS on offer changed. That is a
// different check, and carrying the pass would credit the director with an
// answer to something they never saw.
test("changed options re-ask the quiz even when the question is identical", async () => {
  const taskId = await readyTaskWithQuiz();
  const changed = await post(`/api/tasks/${taskId}/events`, {
    type: "review_summary",
    done: ["reworked the options"],
    understanding: {
      background: "b",
      checks: [{ ...EXAMPLE_CHECK, options: [{ key: "a", label: "A brand new answer" }, { key: "b", label: "Another new answer" }] }],
    },
  });
  expect(changed.status).toBe(201);
  const after = await post(`/api/tasks/${taskId}/understanding-quiz/answer`, { source: "director" });
  expect(after.json.passed).not.toBe(true);
});

test("a changed correct answer re-asks the quiz", async () => {
  const taskId = await readyTaskWithQuiz();
  const otherKey = EXAMPLE_CHECK.options.find((o: any) => o.key !== EXAMPLE_CHECK.answer_key).key;
  await post(`/api/tasks/${taskId}/events`, {
    type: "review_summary",
    done: ["fixed the answer key"],
    understanding: { background: "b", checks: [{ ...EXAMPLE_CHECK, answer_key: otherKey }] },
  });
  const after = await post(`/api/tasks/${taskId}/understanding-quiz/answer`, { source: "director" });
  expect(after.json.passed).not.toBe(true);
});

