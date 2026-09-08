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
