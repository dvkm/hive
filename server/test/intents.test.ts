import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// spawnAgent writes a brief file under HIVE_HOME; point it at a scratch dir.
const HOME = mkdtempSync(join(tmpdir(), "hive-intents-"));
process.env.HIVE_HOME = HOME;

const { openDb, newId, now } = await import("../src/db.ts");
import type { DB } from "../src/db.ts";
const { makeHandler } = await import("../src/api.ts");
const { dispatchOnce } = await import("../src/dispatcher.ts");
const { getTask } = await import("../src/state.ts");
const { intentFileFor, intentSlug, openQuestions, intentSection, intentBodyError, addOpenQuestion } = await import("../src/intents.ts");
const { briefFromIntent, extractSections, fallbackBody, renderIntentBody } = await import("../src/intentDraft.ts");
const { composeBrief } = await import("../src/briefs.ts");
const { Herdr } = await import("../src/runtime/herdr.ts");
import type { Exec, ExecResult } from "../src/exec.ts";

const BASE = "http://127.0.0.1";
const OK = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const WT = mkdtempSync(join(tmpdir(), "hive-intents-wt-"));
const has = (argv: string[], ...xs: string[]) => xs.every((x) => argv.includes(x));

// Records the worktree spawns a dispatch lap actually made.
function stubHerdr() {
  const spawns: string[] = [];
  const exec: Exec = async (argv) => {
    if (has(argv, "worktree", "create")) {
      spawns.push(argv[argv.indexOf("--cwd") + 1]);
      return OK(`{"result":{"worktree":{"path":${JSON.stringify(WT)},"branch":"hive/x","open_workspace_id":"w1"}}}`);
    }
    if (has(argv, "workspace", "list")) return OK('{"result":{"workspaces":[{"workspace_id":"wF","label":"hive-fleet"}]}}');
    if (has(argv, "tab", "create")) return OK('{"result":{"tab":{"tab_id":"wF:t2"}}}');
    return OK();
  };
  return { herdr: new Herdr(exec, "herdr"), spawns };
}

const BODY = `## Problem
Post-Done Jira comments land on nothing.

## Proposed outcome
Every ask has a durable record.

## Affected users and systems
The director, the Jira mirror, the dispatcher.

## Constraints
No model call: the record is rendered as written.

## Open questions
`;

function fresh(): { db: DB; handler: ReturnType<typeof makeHandler>; projectId: string } {
  const db = openDb(":memory:");
  const projectId = newId("proj");
  db.query("INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)")
    .run(projectId, "p", "/repo", JSON.stringify({ auto_dispatch: true }), now());
  return { db, handler: makeHandler(db, {}), projectId };
}

async function call(handler: any, method: string, path: string, body?: unknown) {
  const res = await handler(new Request(BASE + path, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  return { status: res.status, json: await res.json() };
}

test("body_md must carry the five playbook headings in order", () => {
  expect(intentBodyError(BODY)).toBeNull();
  expect(intentBodyError("## Problem\n## Constraints")).toContain("five headings");
  // Right five, wrong order.
  const swapped = BODY.replace("## Constraints", "## TMP").replace("## Affected users and systems", "## Constraints").replace("## TMP", "## Affected users and systems");
  expect(intentBodyError(swapped)).toContain("five headings");
});

test("open questions: a plain bullet is unanswered, a ticked one is not", () => {
  const body = BODY + "- [x] which repo? corebeat\n- [ ] who signs off?\n- and the rollback path?\n";
  expect(openQuestions(body)).toEqual(["who signs off?", "and the rollback path?"]);
  expect(openQuestions(BODY)).toEqual([]);
  expect(intentSection(BODY, "Problem")).toBe("Post-Done Jira comments land on nothing.");
  expect(openQuestions(addOpenQuestion(BODY, "which environment?"))).toEqual(["which environment?"]);
});

test("intent file slug prefers the Jira key", () => {
  expect(intentSlug({ jira_key: "WEB-101", number: 7 })).toBe("WEB-101");
  expect(intentSlug({ jira_key: null, number: 7 })).toBe("hive-7");
});

test("a task on a draft intent stays queued; accepting it lets the dispatcher through", async () => {
  const { db, handler, projectId } = fresh();
  const draft = await call(handler, "POST", "/api/intents", { project_id: projectId, source: "director", body_md: BODY });
  expect(draft.status).toBe(201);
  expect(draft.json.status).toBe("draft");

  const task = await call(handler, "POST", "/api/tasks", { project_id: projectId, title: "do the thing", intent_id: draft.json.id });
  expect(task.status).toBe(201);
  expect(task.json.intent_id).toBe(draft.json.id);
  // The link reads both ways.
  expect((await call(handler, "GET", `/api/intents/${draft.json.id}`)).json.task_id).toBe(task.json.id);

  const first = stubHerdr();
  await dispatchOnce(db, { herdr: first.herdr });
  expect(first.spawns.length).toBe(0);
  expect(getTask(db, task.json.id).state).toBe("queued");
  expect(getTask(db, task.json.id).skip_reason).toBe("intent_not_accepted");

  const accepted = await call(handler, "POST", `/api/intents/${draft.json.id}/accept`, { source: "director" });
  expect(accepted.status).toBe(200);
  expect(accepted.json.status).toBe("accepted");
  expect(accepted.json.accepted_by).toBe("director");
  expect(accepted.json.accepted_at).toBeTruthy();

  const second = stubHerdr();
  await dispatchOnce(db, { herdr: second.herdr });
  expect(second.spawns.length).toBe(1);
  expect(getTask(db, task.json.id).state).toBe("in_progress");
});

test("accept refuses while an open question is unchecked", async () => {
  const { handler, projectId } = fresh();
  const draft = await call(handler, "POST", "/api/intents", {
    project_id: projectId,
    source: "jira",
    source_ref: "jira:WEB-101",
    body_md: BODY + "- [ ] which environment ships first?\n",
  });
  const refused = await call(handler, "POST", `/api/intents/${draft.json.id}/accept`, { source: "director" });
  expect(refused.status).toBe(409);
  expect(refused.json.error).toContain("which environment ships first?");

  // Tick it and the same call goes through.
  const ticked = await call(handler, "PUT", `/api/intents/${draft.json.id}`, {
    body_md: BODY + "- [x] which environment ships first? staging\n",
  });
  expect(ticked.status).toBe(200);
  expect((await call(handler, "POST", `/api/intents/${draft.json.id}/accept`, {})).status).toBe(200);
});

test("supersede marks the old row and re-points the task at the replacement", async () => {
  const { handler, projectId } = fresh();
  const first = await call(handler, "POST", "/api/intents", { project_id: projectId, source: "director", body_md: BODY });
  const task = await call(handler, "POST", "/api/tasks", { project_id: projectId, title: "do the thing", intent_id: first.json.id });
  const second = await call(handler, "POST", "/api/intents", { project_id: projectId, source: "director", body_md: BODY.replace("durable record", "durable, versioned record") });

  const done = await call(handler, "POST", `/api/intents/${first.json.id}/supersede`, { by: second.json.id });
  expect(done.status).toBe(200);
  expect(done.json.status).toBe("superseded");
  expect((await call(handler, "GET", `/api/tasks/${task.json.id}`)).json.intent_id).toBe(second.json.id);
  expect((await call(handler, "GET", `/api/intents/${second.json.id}`)).json.task_id).toBe(task.json.id);
  // Editing a superseded record would rewrite history.
  expect((await call(handler, "PUT", `/api/intents/${first.json.id}`, { body_md: BODY })).status).toBe(409);
});

test("tasks with no intent are unaffected", async () => {
  const { db, handler, projectId } = fresh();
  const task = await call(handler, "POST", "/api/tasks", { project_id: projectId, title: "plain work" });
  expect(task.json.intent_id).toBeNull();
  const { herdr, spawns } = stubHerdr();
  await dispatchOnce(db, { herdr });
  expect(spawns.length).toBe(1);
  expect(getTask(db, task.json.id).state).toBe("in_progress");
});

test("only an accepted intent is written into the worktree", async () => {
  const { db, handler, projectId } = fresh();
  const draft = await call(handler, "POST", "/api/intents", { project_id: projectId, source: "director", body_md: BODY });
  const task = await call(handler, "POST", "/api/tasks", { project_id: projectId, title: "do the thing", intent_id: draft.json.id });
  const row = () => getTask(db, task.json.id);
  expect(intentFileFor(db, row())).toBeNull(); // still a draft
  expect(intentFileFor(db, { intent_id: null, number: 1 })).toBeNull(); // no intent at all

  await call(handler, "POST", `/api/intents/${draft.json.id}/accept`, {});
  const file = intentFileFor(db, row())!;
  expect(file.path).toBe(`intent/hive-${row().number}.md`);
  expect(file.body).toBe(BODY);

  // A Jira-keyed task files under the key everyone else uses.
  db.query("UPDATE tasks SET jira_key = 'WEB-101' WHERE id = ?").run(task.json.id);
  expect(intentFileFor(db, getTask(db, task.json.id))!.path).toBe("intent/WEB-101.md");
});

// ============================================================================
// INTAKE AND BRIEF GENERATION (HIVE-637)
// ============================================================================

test("the director's own brief is recorded and accepted in one step, with no extra tap", async () => {
  const { db, handler, projectId } = fresh();
  const task = await call(handler, "POST", "/api/tasks", {
    project_id: projectId,
    title: "fix the search box",
    brief: "Search returns nothing for two-word queries. Make it match both words.",
  });
  expect(task.status).toBe(201);
  const intent = (await call(handler, "GET", `/api/intents/${task.json.intent_id}`)).json;
  expect(intent.source).toBe("director");
  expect(intent.status).toBe("accepted");
  expect(intent.task_id).toBe(task.json.id);
  // Their words, kept as written, and nothing left to answer.
  expect(intentSection(intent.body_md, "Problem")).toContain("two-word queries");
  expect(openQuestions(intent.body_md)).toEqual([]);
  expect(getTask(db, task.json.id).brief).toBe("Search returns nothing for two-word queries. Make it match both words.");

  // And it dispatches straight away: an accepted intent holds nothing.
  const { herdr, spawns } = stubHerdr();
  await dispatchOnce(db, { herdr });
  expect(spawns.length).toBe(1);
  expect(getTask(db, task.json.id).state).toBe("in_progress");
});

test("an agent's follow-up task is not recorded as the director's ask", async () => {
  const { handler, projectId } = fresh();
  const task = await call(handler, "POST", "/api/tasks", {
    project_id: projectId, title: "follow-up", brief: "the parent left this behind", source: "agent",
  });
  expect(task.json.intent_id).toBeNull();
});

test("hive intent new --text: five headings are kept verbatim, anything else is drafted", async () => {
  const { db, handler, projectId } = fresh();
  const verbatim = await call(handler, "POST", "/api/intents/draft", { project_id: projectId, text: BODY });
  expect(verbatim.status).toBe(201);
  expect(verbatim.json.body_md).toBe(BODY.trim());
  expect(verbatim.json.status).toBe("draft");
  expect(verbatim.json.task_id).toBeNull();

  // Text that is not already an intent goes through the drafter, stubbed here
  // so the test never spawns a model.
  const drafting = makeHandler(db, {
    intentExec: async () => ({
      code: 0,
      stdout: JSON.stringify({ problem: "p", proposed_outcome: "o", affected: "a", constraints: "c", open_questions: ["q?"] }),
      stderr: "",
    }),
  });
  const drafted = await call(drafting, "POST", "/api/intents/draft", { project_id: projectId, text: "the search box is broken" });
  expect(intentBodyError(drafted.json.body_md)).toBeNull();
  expect(intentSection(drafted.json.body_md, "Proposed outcome")).toBe("o");
  expect(openQuestions(drafted.json.body_md)).toEqual(["q?"]);

  // Neither form is allowed to be ambiguous about where the text came from.
  expect((await call(handler, "POST", "/api/intents/draft", { project_id: projectId })).status).toBe(400);
  expect(
    (await call(handler, "POST", "/api/intents/draft", { project_id: projectId, text: "x", from_jira: "WEB-1" })).status
  ).toBe(400);
});

test("the generated brief carries every section of the accepted record, plus its footer", () => {
  const intent: any = {
    id: "int_1", accepted_by: "david", accepted_at: "2026-09-09T10:00:00.000Z",
    body_md: renderIntentBody({
      problem: "Checkout fails for card payments.",
      proposed_outcome: "Card payments go through.",
      affected: "server/src/payments.ts",
      constraints: "Do not touch refunds.",
      open_questions: [],
    }),
  };
  const brief = briefFromIntent(intent);
  expect(brief).toContain("## Source\nCheckout fails for card payments.");
  expect(brief).toContain("## Deliverable\nCard payments go through.");
  expect(brief).toContain("## Constraints (hard limits)\nDo not touch refunds.");
  expect(brief).toContain("## Check that must pass\nShow this working for real: Card payments go through.");
  expect(brief).toContain("## Read these paths first\nserver/src/payments.ts");
  expect(brief.trim().endsWith("intent: int_1 accepted by david at 2026-09-09T10:00:00.000Z")).toBe(true);
});

test("the agent is told to read the accepted record first, and only once it exists", async () => {
  const { db, handler, projectId } = fresh();
  const draft = await call(handler, "POST", "/api/intents", { project_id: projectId, source: "director", body_md: BODY });
  const task = await call(handler, "POST", "/api/tasks", { project_id: projectId, title: "do the thing", intent_id: draft.json.id });
  expect(composeBrief(db, task.json.id)).not.toContain("The accepted ask");

  await call(handler, "POST", `/api/intents/${draft.json.id}/accept`, {});
  const prompt = composeBrief(db, task.json.id);
  expect(prompt).toContain(`intent/hive-${getTask(db, task.json.id).number}.md`);
  expect(prompt).toContain("`## Constraints` are HARD LIMITS");
});

test("a model that answers with nothing still yields a usable record", async () => {
  const empty = extractSections('{"problem":"","proposed_outcome":""}');
  expect(empty).toBeNull(); // nothing to map: the caller falls back to the raw text
  const noQuestions = extractSections('{"problem":"p","proposed_outcome":"o","open_questions":[]}')!;
  // A draft always asks something, so acceptance is always a deliberate act.
  expect(noQuestions.open_questions.length).toBe(1);
  expect(openQuestions(fallbackBody({ title: "t", description: "d", comments: [] })).length).toBe(1);
  expect(intentSection(fallbackBody({ title: "t", description: "d", comments: [] }), "Problem")).toContain("d");
});
