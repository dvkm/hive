// HIVE-638: the understanding quiz is minted ONCE from the accepted intent, and
// a new review head never re-asks it.
//
// The bug this locks down: #2190 answered the same three questions three times
// and #1971 took seven attempts across eleven heads, because the quiz was keyed
// on the review event and every re-emitted review made a new one.
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "hive-intent-checks-"));
process.env.HIVE_HOME = HOME;

const { openDb } = await import("../src/db.ts");
const { makeHandler } = await import("../src/api.ts");
const { getIntent, intentChecks } = await import("../src/intents.ts");
const { buildChecksPrompt, extractChecks } = await import("../src/intentDraft.ts");

const BASE = "http://127.0.0.1";

const BODY = `## Problem
Post-Done Jira comments land on nothing.

## Proposed outcome
Every ask has a durable record the director accepts before work starts.

## Affected users and systems
The director, the Jira mirror, the dispatcher.

## Constraints
Never change a task that already shipped.

## Open questions
`;

// One quiz, three questions, straight from the accepted ask.
const MINTED = {
  checks: [
    {
      question: "What changes for the director once this is done?",
      options: [
        { key: "a", label: "Every ask is recorded and they accept it before work starts" },
        { key: "b", label: "Jira tickets close themselves" },
      ],
      answer_key: "a",
      explanation: "That is the proposed outcome.",
    },
    {
      question: "Which limit must the change respect?",
      options: [
        { key: "a", label: "It must not change a task that already shipped" },
        { key: "b", label: "It must not use SQLite" },
      ],
      answer_key: "a",
    },
    {
      question: "What is explicitly out of scope?",
      options: [
        { key: "a", label: "Touching work that already shipped" },
        { key: "b", label: "Recording the ask" },
      ],
      answer_key: "a",
    },
  ],
};

// One injected model double for BOTH intent calls: drafting maps prose into the
// five headings, minting writes the quiz. The prompt says which is which.
function intentExec(calls: string[]) {
  return async (argv: string[]) => {
    const prompt = argv.join("\n");
    calls.push(prompt.includes("understanding check") ? "mint" : "draft");
    return {
      code: 0,
      stdout: prompt.includes("understanding check")
        ? JSON.stringify(MINTED)
        : JSON.stringify({ problem: "p", proposed_outcome: "o", affected: "a", constraints: "c", open_questions: [] }),
      stderr: "",
    };
  };
}

function fresh() {
  const db = openDb(":memory:");
  const calls: string[] = [];
  return { db, calls, handler: makeHandler(db, { intentExec: intentExec(calls) as any }) };
}

async function call(handler: any, method: string, path: string, body?: unknown) {
  const res = await handler(
    new Request(BASE + path, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  );
  return { status: res.status, json: await res.json() };
}

// A project, a task, an accepted intent, and the task in review with a PR.
async function taskOnAcceptedIntent(s: ReturnType<typeof fresh>, body = BODY) {
  const p = await call(s.handler, "POST", "/api/projects", {
    name: "p",
    repo_path: "/repo",
    config: { default_branch: "main" },
  });
  const intent = await call(s.handler, "POST", "/api/intents", {
    project_id: p.json.id,
    source: "director",
    body_md: body,
  });
  const t = await call(s.handler, "POST", "/api/tasks", {
    project_id: p.json.id,
    title: "record the ask",
    intent_id: intent.json.id,
  });
  await call(s.handler, "POST", `/api/tasks/${t.json.id}/transition`, { to: "in_progress" });
  const accepted = await call(s.handler, "POST", `/api/intents/${intent.json.id}/accept`, { source: "director" });
  return { projectId: p.json.id, taskId: t.json.id, intentId: intent.json.id, accepted };
}

// An agent's own review, with diff-based checks of its own.
async function emitReview(s: ReturnType<typeof fresh>, taskId: string, note: string) {
  return call(s.handler, "POST", `/api/tasks/${taskId}/events`, {
    type: "review_summary",
    done: [note],
    understanding: {
      background: "This task changes behavior.",
      check: {
        question: `Which file did the agent touch for ${note}?`,
        options: [
          { key: "a", label: "server/src/api.ts" },
          { key: "b", label: "web/src/App.tsx" },
        ],
        answer_key: "a",
      },
    },
  });
}

const quizOf = async (s: ReturnType<typeof fresh>, taskId: string) =>
  (await call(s.handler, "GET", "/api/understanding-quizzes?scope=all")).json.quizzes.find(
    (q: any) => q.task_id === taskId
  );

test("the prompt is built from the accepted ask, and the three checks parse", () => {
  const prompt = buildChecksPrompt({ body_md: BODY } as any);
  expect(prompt).toContain("Every ask has a durable record");
  expect(prompt).toContain("Never change a task that already shipped");
  expect(prompt).toContain("EXACTLY three questions");
  const checks = extractChecks(JSON.stringify(MINTED));
  expect(checks).toHaveLength(3);
  expect(checks![1].answer_key).toBe("a");
  // A check with no right answer among its options is not a check.
  expect(extractChecks(JSON.stringify({ checks: [{ question: "q", options: [{ key: "a", label: "x" }], answer_key: "z" }] }))).toBeNull();
});

test("accepting an intent mints three checks once, and a second head does not re-ask", async () => {
  const s = fresh();
  const { taskId, intentId } = await taskOnAcceptedIntent(s);

  // Minted at acceptance, by the same model path that drafts.
  expect(s.calls.filter((c) => c === "mint")).toHaveLength(1);
  expect(intentChecks(getIntent(s.db, intentId))).toHaveLength(3);

  await emitReview(s, taskId, "first head");
  await call(s.handler, "POST", `/api/tasks/${taskId}/transition`, { to: "in_review" });

  // The quiz on the card is the intent's, not the agent's diff question.
  const first = await quizOf(s, taskId);
  expect(first.total).toBe(3);
  expect(first.quiz_key).toBe(intentId);
  expect(first.intent_id).toBe(intentId);
  expect(first.intent_slug).toBeTruthy();
  // Which of the three comes first is keyed on the quiz id, so assert the set.
  expect(MINTED.checks.map((c) => c.question)).toContain(first.question);
  // The agent's own checks are kept for the Report view, and never asked.
  expect(first.report.understanding.checks).toBeUndefined();
  expect(first.report.understanding.agent_checks).toHaveLength(1);

  for (let i = 0; i < 3; i++)
    expect((await call(s.handler, "POST", `/api/tasks/${taskId}/understanding-quiz/answer`, { answer_key: "a", source: "director" })).json.correct).toBe(true);

  expect(await quizOf(s, taskId)).toBeUndefined();
  const passes = s.db
    .query("SELECT payload FROM events WHERE task_id = ? AND type = 'understanding_quiz_passed'")
    .all(taskId) as { payload: string }[];
  expect(passes).toHaveLength(1);
  expect(JSON.parse(passes[0].payload).review_event_id).toBe(intentId);

  // A second review head: a new review event, the same accepted ask. Nothing
  // is asked again, and the checks were not re-minted.
  await emitReview(s, taskId, "second head after a rebase");
  expect(await quizOf(s, taskId)).toBeUndefined();
  const branch = await call(s.handler, "GET", `/api/tasks/${taskId}/branch-check`);
  expect(branch.json.understanding_quiz_key).toBe(intentId);
  expect(s.calls.filter((c) => c === "mint")).toHaveLength(1);
});

test("superseding the intent asks again, with the new ask's checks", async () => {
  const s = fresh();
  const { taskId, intentId, projectId } = await taskOnAcceptedIntent(s);
  await emitReview(s, taskId, "first head");
  await call(s.handler, "POST", `/api/tasks/${taskId}/transition`, { to: "in_review" });
  for (let i = 0; i < 3; i++)
    await call(s.handler, "POST", `/api/tasks/${taskId}/understanding-quiz/answer`, { answer_key: "a", source: "director" });
  expect(await quizOf(s, taskId)).toBeUndefined();

  // The ask changed. A new intent row replaces the old one and takes its task.
  const replacement = await call(s.handler, "POST", "/api/intents", {
    project_id: projectId,
    source: "director",
    body_md: BODY.replace("Never change a task that already shipped.", "Never touch the Jira mirror."),
  });
  await call(s.handler, "POST", `/api/intents/${intentId}/supersede`, { by: replacement.json.id, source: "director" });
  await call(s.handler, "POST", `/api/intents/${replacement.json.id}/accept`, { source: "director" });

  const again = await quizOf(s, taskId);
  expect(again.status).toBe("required");
  expect(again.quiz_key).toBe(replacement.json.id);
  expect(again.completed).toBe(0);
  expect(again.total).toBe(3);
});

// The #2190 sequence: three review heads on one task (the agent re-emitted
// after a conflict merge and again after a CI fix). Before this change the
// director answered nine questions; with an intent they answer exactly three.
test("replaying the #2190 head sequence asks exactly three questions in total", async () => {
  const s = fresh();
  const { taskId } = await taskOnAcceptedIntent(s);
  await emitReview(s, taskId, "head 1");
  await call(s.handler, "POST", `/api/tasks/${taskId}/transition`, { to: "in_review" });

  let asked = 0;
  for (const head of ["head 2 (merged main)", "head 3 (CI fix)"]) {
    const quiz = await quizOf(s, taskId);
    if (quiz) {
      for (let i = 0; i < quiz.total; i++) {
        asked++;
        await call(s.handler, "POST", `/api/tasks/${taskId}/understanding-quiz/answer`, { answer_key: "a", source: "director" });
      }
    }
    await emitReview(s, taskId, head);
  }
  expect(asked).toBe(3);
  expect(await quizOf(s, taskId)).toBeUndefined();
});

test("a task with no intent keeps the agent's own diff-based checks", async () => {
  const s = fresh();
  const p = await call(s.handler, "POST", "/api/projects", { name: "p", repo_path: "/repo", config: { default_branch: "main" } });
  const t = await call(s.handler, "POST", "/api/tasks", { project_id: p.json.id, title: "no intent here" });
  await call(s.handler, "POST", `/api/tasks/${t.json.id}/transition`, { to: "in_progress" });
  const review = await emitReview(s, t.json.id, "only head");
  await call(s.handler, "POST", `/api/tasks/${t.json.id}/transition`, { to: "in_review" });

  const quiz = await quizOf(s, t.json.id);
  expect(quiz.quiz_key).toBe(review.json.event.id);
  expect(quiz.intent_id).toBeUndefined();
  expect(quiz.total).toBe(1);
  expect(quiz.question).toContain("Which file did the agent touch");
});
