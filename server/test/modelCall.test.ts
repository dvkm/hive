// hive-1800: `claude -p --output-format json` reports an auth failure on STDOUT
// with an empty stderr. The recorded error must carry the real reason, and the
// fleet-wide auth outage must raise exactly one notification, not one per task.
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "hive-modelcall-"));
process.env.HIVE_HOME = HOME;

const { openDb, newId, now, getSetting } = await import("../src/db.ts");
const { autoReviewOnce } = await import("../src/reviewer.ts");
const { modelErrorText, isAuthFailure } = await import("../src/modelCall.ts");
const { transition } = await import("../src/state.ts");
import type { DB } from "../src/db.ts";
import type { Exec } from "../src/exec.ts";

// The exact envelope the real CLI printed while the review column was stuck.
const NOT_LOGGED_IN = JSON.stringify({
  type: "result",
  subtype: "success", // stays "success" even on failure — is_error is the signal
  is_error: true,
  result: "Not logged in - Please run /login",
});

const ghDiff: Exec = async (argv) =>
  argv.includes("diff")
    ? { code: 0, stdout: "--- a/x.ts\n+++ b/x.ts\n+const y = 1;", stderr: "" }
    : { code: 0, stdout: JSON.stringify({ headRefOid: "review-head" }), stderr: "" };

function setup(): DB {
  const db = openDb(":memory:");
  const pid = newId("proj");
  db.query("INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)").run(pid, "p", "/repo", "{}", now());
  return db;
}

function addTask(db: DB): string {
  const pid = (db.query("SELECT id FROM projects LIMIT 1").get() as any).id;
  const id = newId();
  const t = now();
  db.query(
    "INSERT INTO tasks (id, project_id, title, brief, state, kind, branch, pr_url, created_at, updated_at) VALUES (?,?,?,?, 'queued','ship',?,?,?,?)"
  ).run(id, pid, "add feature", "make it work", "feat", "https://gh/pr/5", t, t);
  transition(db, id, "in_progress");
  transition(db, id, "in_review");
  return id;
}

test("prefers the stdout envelope over an empty stderr", () => {
  expect(modelErrorText({ code: 1, stdout: NOT_LOGGED_IN, stderr: "" })).toBe("exited 1: Not logged in - Please run /login");
  // stderr still wins when stdout carries no error envelope.
  expect(modelErrorText({ code: 2, stdout: "", stderr: "boom\n" })).toBe("exited 2: boom");
  // Nothing anywhere is still better than a bare empty reason.
  expect(modelErrorText({ code: 1, stdout: "", stderr: "" })).toBe("exited 1 with no output");
  expect(modelErrorText({ code: 143, stdout: "", stderr: "", timedOut: true }, { timeoutMs: 50 })).toBe("timed out after 50ms");
  // A successful envelope is not an error, so its text must not be harvested.
  expect(modelErrorText({ code: 1, stdout: JSON.stringify({ is_error: false, result: "fine" }), stderr: "" })).toBe("exited 1: " + JSON.stringify({ is_error: false, result: "fine" }));
});

test("recognizes the auth shapes and nothing else", () => {
  expect(isAuthFailure("Not logged in - Please run /login")).toBe(true);
  expect(isAuthFailure("API error: 401 Unauthorized")).toBe(true);
  expect(isAuthFailure("Invalid API key")).toBe(true);
  expect(isAuthFailure("SyntaxError: Unexpected token")).toBe(false);
});

test("auth failure lands in auto_review_error and raises exactly one notification", async () => {
  const db = setup();
  const claude = async () => ({ code: 1, stdout: NOT_LOGGED_IN, stderr: "" });

  const errors: string[] = [];
  for (let i = 0; i < 4; i++) {
    const id = addTask(db);
    await autoReviewOnce(db, { exec: claude as any, shellExec: ghDiff });
    const row: any = db.query("SELECT payload FROM events WHERE task_id = ? AND type = 'auto_review_error'").get(id);
    errors.push(JSON.parse(row.payload).error);
  }

  expect(errors).toEqual(Array(4).fill("exited 1: Not logged in - Please run /login"));

  const notifs = db.query("SELECT title FROM notifications WHERE kind = 'incident'").all() as any[];
  expect(notifs.length).toBe(1);
  expect(notifs[0].title).toContain("not logged in");

  // Four failures across four different tasks is well past the threshold.
  expect(getSetting(db, "tool_degraded_model")).toContain("Not logged in");
});

test("a good review clears the degraded flag and re-arms the alert", async () => {
  const db = setup();
  const failing = async () => ({ code: 1, stdout: NOT_LOGGED_IN, stderr: "" });
  const ok = async () => ({
    code: 0,
    stdout: JSON.stringify({ result: '{"verdict":"looks_good","summary":"fine","risks":[],"questions":[]}' }),
    stderr: "",
  });

  for (let i = 0; i < 3; i++) {
    addTask(db);
    await autoReviewOnce(db, { exec: failing as any, shellExec: ghDiff });
  }
  expect(getSetting(db, "tool_degraded_model")).toBeTruthy();

  addTask(db);
  await autoReviewOnce(db, { exec: ok as any, shellExec: ghDiff });
  expect(getSetting(db, "tool_degraded_model")).toBe("");

  // Alert re-arms: the next outage is allowed to notify again.
  addTask(db);
  await autoReviewOnce(db, { exec: failing as any, shellExec: ghDiff });
  expect((db.query("SELECT id FROM notifications WHERE kind = 'incident'").all() as any[]).length).toBe(2);
});

test("verifyRisks records why a check could not run", async () => {
  const { verifyRisks } = await import("../src/reviewer.ts");
  const db = setup();
  const id = addTask(db);
  const task: any = db.query("SELECT * FROM tasks WHERE id = ?").get(id);
  await verifyRisks(
    db,
    task,
    { risks: ["x.ts: y is dead code"], head: "review-head", diff: "diff" },
    { exec: (async () => ({ code: 1, stdout: NOT_LOGGED_IN, stderr: "" })) as any }
  );
  const row: any = db.query("SELECT payload FROM events WHERE task_id = ? AND type = 'risk_verdicts'").get(id);
  const payload = JSON.parse(row.payload);
  expect(payload.unverified).toBe(1);
  expect(payload.unverified_reason).toBe("exited 1: Not logged in - Please run /login");
});

// hive-1844: both live projects route hive's own `claude -p` calls through the
// TeamClaude proxy, where `claude /login` on the host fixes nothing.
test("the auth alert names the fix for the active route", async () => {
  const { authAlertBody } = await import("../src/modelCall.ts");
  const failure = "exited 1: Not logged in - Please run /login";

  const proxied = authAlertBody(failure, "http://127.0.0.1:3456");
  expect(proxied).toContain("teamclaude status");
  expect(proxied).toContain("http://127.0.0.1:3456");
  expect(proxied).not.toContain("Run `claude /login` on the hive host");

  const direct = authAlertBody(failure, null);
  expect(direct).toContain("Run `claude /login` on the hive host");
  expect(direct).not.toContain("teamclaude");

  // Both keep the truncated failure snippet.
  for (const body of [proxied, direct]) expect(body).toContain(failure);
});
