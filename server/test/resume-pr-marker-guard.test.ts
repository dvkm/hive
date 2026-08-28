// hive-487: a requeued task's resume_pr_url points at a predecessor's PR the
// director may want a fresh agent to adopt. Before this guard, spawnAgent
// trusted that URL as long as nothing had recorded it closed/merged — exactly
// how stale pre-migration pr_urls kept looking "open" forever. This checks
// that dispatch is refused when the live PR's marker no longer names the task
// (or its parent), and allowed when it does.
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, newId, now } from "../src/db.ts";
import { spawnAgent } from "../src/api.ts";
import { Herdr } from "../src/runtime/herdr.ts";
import type { Exec, ExecResult } from "../src/exec.ts";

const OK = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const has = (argv: string[], ...xs: string[]) => xs.every((x) => argv.includes(x));

function freshProjectAndTask(resumePrUrl: string) {
  const db = openDb(":memory:");
  const projectId = newId("proj");
  const HOME = mkdtempSync(join(tmpdir(), "hive-resume-guard-"));
  db.query("INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)").run(
    projectId, "p", HOME, "{}", now()
  );
  const taskId = newId();
  const t = now();
  db.query(
    `INSERT INTO tasks (id, project_id, title, brief, state, kind, source, resume_branch, resume_pr_url, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    taskId, projectId, "requeued task", `RESUME — adopt PR ${resumePrUrl}`, "queued", "ship", "requeue",
    "hive/predecessor", resumePrUrl, t, t
  );
  return { db, projectId, taskId };
}

function herdrExec(prView: ExecResult): Exec {
  return async (argv) => {
    if (has(argv, "pr", "view")) return prView;
    if (has(argv, "worktree", "create")) return OK(`{"result":{"worktree":{"path":"/tmp/wt","branch":"hive/x","open_workspace_id":"w1"}}}`);
    if (has(argv, "agent", "get")) return OK('{"result":{"agent":{"pane_id":"p1","agent_status":"working"}}}');
    return OK();
  };
}

test("dispatch is refused when the resume PR's marker names a different (or no) task", async () => {
  const { db, taskId } = freshProjectAndTask("https://github.com/dvkm/hive/pull/6");
  const exec = herdrExec(OK(JSON.stringify({ title: "some unrelated PR", body: "no marker here" })));
  const herdr = new Herdr(exec, "herdr");
  const r = await spawnAgent(db, herdr, taskId, { exec });
  expect(r.ok).toBe(false);
  expect((r as any).error).toMatch(/no longer carries a hive-task marker/);
});

test("dispatch proceeds when the resume PR's marker names this task", async () => {
  const { db, taskId } = freshProjectAndTask("https://github.com/dvkm/hive/pull/9");
  const exec = herdrExec(OK(JSON.stringify({ title: "fix", body: `hive-task: ${taskId}` })));
  const herdr = new Herdr(exec, "herdr");
  const r = await spawnAgent(db, herdr, taskId, { exec });
  expect(r.ok).toBe(true);
});
