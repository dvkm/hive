import { test, expect } from "bun:test";
import { openDb, newId, now, type DB } from "../src/db.ts";
import { taskBranchCheckEndpoint } from "../src/api.ts";
import type { Exec, ExecResult } from "../src/exec.ts";

const OK = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const FAIL = (stderr = "boom"): ExecResult => ({ code: 1, stdout: "", stderr });

function seed(): { db: DB; projectId: string; taskId: string } {
  const db = openDb(":memory:");
  const projectId = newId("proj");
  db.query("INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)").run(
    projectId, "p", "/repo", "{}", now()
  );
  const taskId = newId();
  const t = now();
  db.query(
    "INSERT INTO tasks (id, project_id, title, state, kind, branch, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)"
  ).run(taskId, projectId, "task", "in_review", "ship", "feat", t, t);
  return { db, projectId, taskId };
}

test("reports an unmet dependency live, regardless of any stale claim elsewhere", async () => {
  const { db, projectId, taskId } = seed();
  const depId = newId();
  const t = now();
  db.query(
    "INSERT INTO tasks (id, project_id, title, state, kind, created_at, updated_at) VALUES (?,?,?,?,?,?,?)"
  ).run(depId, projectId, "consolidate the shared definition", "in_progress", "ship", t, t);
  db.query("UPDATE tasks SET depends_on = ? WHERE id = ?").run(JSON.stringify([depId]), taskId);

  const res = await taskBranchCheckEndpoint(db, taskId, { exec: async () => OK() });
  expect(res.status).toBe(200);
  const body: any = await res.json();
  expect(body.unmet_deps).toEqual([{ id: depId, number: expect.any(Number), title: "consolidate the shared definition", state: "in_progress" }]);
  expect(body.embedded_tasks).toEqual([]);
});

test("flags a branch that shares history with another open task's branch", async () => {
  const { db, projectId, taskId } = seed();
  db.query("UPDATE projects SET config = ? WHERE id = ?").run(JSON.stringify({ promote: { from: "staging", to: "main" } }), projectId);
  const otherId = newId();
  const t = now();
  db.query(
    "INSERT INTO tasks (id, project_id, title, state, kind, branch, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)"
  ).run(otherId, projectId, "other in-flight task", "in_progress", "ship", "other-branch", t, t);

  const exec: Exec = async (argv) => {
    if (argv[3] !== "merge-base") return OK();
    const [a, b] = [argv[4], argv[5]];
    if ([a, b].sort().join("|") === "feat|origin/staging") return OK("base-sha\n");
    if ([a, b].sort().join("|") === "feat|other-branch") return OK("shared-ancestor-sha\n"); // deeper than base
    return FAIL();
  };

  const res = await taskBranchCheckEndpoint(db, taskId, { exec });
  expect(res.status).toBe(200);
  const body: any = await res.json();
  expect(body.unmet_deps).toEqual([]);
  expect(body.embedded_tasks).toEqual([{ id: otherId, number: expect.any(Number), title: "other in-flight task" }]);
});

test("task not found → 404", async () => {
  const { db } = seed();
  const res = await taskBranchCheckEndpoint(db, "nope", { exec: async () => OK() });
  expect(res.status).toBe(404);
});

// task #1134: `failed` is terminal too — corebeat had 109 failed tasks whose
// dead branches made up most of a 103-row warning on a single review card.
test("a failed task's branch is not a stacked-branch candidate", async () => {
  const { db, projectId, taskId } = seed();
  const t = now();
  db.query(
    "INSERT INTO tasks (id, project_id, title, state, kind, branch, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)"
  ).run(newId(), projectId, "long-dead task", "failed", "ship", "dead-branch", t, t);

  // Every comparison says "shares deep history" — only the state filter can
  // keep this out of the result.
  const exec: Exec = async (argv) => {
    if (argv[3] !== "merge-base") return OK();
    if (argv[4] === "--is-ancestor") return FAIL();
    return OK([argv[4], argv[5]].sort().join("|") === "feat|origin/main" ? "base-sha\n" : "shared-sha\n");
  };

  const res = await taskBranchCheckEndpoint(db, taskId, { exec });
  const body: any = await res.json();
  expect(body.embedded_tasks).toEqual([]);
});
