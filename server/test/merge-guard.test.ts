import { test, expect } from "bun:test";
import { openDb, newId, now, type DB } from "../src/db.ts";
import { writeEvent, getTask } from "../src/state.ts";
import { mergeTask } from "../src/api.ts";
import { Herdr } from "../src/runtime/herdr.ts";
import type { Exec, ExecResult } from "../src/exec.ts";

const OK = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const stub = (fn: (argv: string[]) => ExecResult): Exec => async (argv) => fn(argv);

function seed(): { db: DB; taskId: string } {
  const db = openDb(":memory:");
  const projectId = newId("proj");
  db.query("INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)").run(
    projectId, "p", "/repo", "{}", now()
  );
  const taskId = newId();
  const t = now();
  // in_review, PR-less so mergeTask takes the local-ff path; a branch + a
  // pre-rebase branch_scope snapshot are what the guard reads.
  db.query(
    "INSERT INTO tasks (id, project_id, title, state, kind, branch, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)"
  ).run(taskId, projectId, "task", "in_review", "ship", "feat", t, t);
  writeEvent(db, {
    task_id: taskId,
    source: "reconciler",
    type: "branch_scope",
    payload: { base_sha: "B1", files: ["src/task.ts"] },
  });
  const review = writeEvent(db, {
    task_id: taskId,
    source: "agent",
    type: "review_summary",
    payload: {
      understanding: {
        check: {
          question: "What protects this merge?",
          options: [{ key: "guard", label: "The destructive-change guard." }, { key: "none", label: "Nothing." }],
          answer_key: "guard",
        },
      },
    },
  });
  writeEvent(db, { task_id: taskId, source: "director", type: "understanding_quiz_passed", payload: { review_event_id: review.id, answer_key: "guard" } });
  return { db, taskId };
}

// git router: authored files = task.ts + a reverted health.ts; base advanced on
// health.ts since the snapshot → destructive. The local-ff plumbing (used only
// on the override path) is stubbed to succeed so a bypassed merge lands.
const destructiveExec: Exec = stub((argv) => {
  if (argv.includes("diff") && argv.includes("--name-only")) return OK("health.ts\nsrc/task.ts\n");
  if (argv[3] === "log") return OK(argv[argv.length - 1] === "health.ts" ? "abc base commit\n" : "");
  if (argv.includes("rev-parse")) return OK(argv.at(-1) === "main" ? "base-sha\n" : "branch-sha\n");
  if (argv.includes("symbolic-ref")) return OK("main\n"); // primary checkout is on base
  return OK(); // merge-base --is-ancestor / merge --ff-only succeed
});

const herdr = new Herdr(stub(() => OK("{}")), "herdr");

test("mergeTask BLOCKS a branch that reverts base work outside its scope (#314)", async () => {
  const { db, taskId } = seed();
  const res = await mergeTask(db, herdr, taskId, {}, { exec: destructiveExec });
  expect(res.status).toBe(409);
  const body: any = await res.json();
  expect(body.error).toContain("health.ts");
  // Bounced back to the agent, and the block is recorded for the director.
  expect(getTask(db, taskId).state).toBe("in_progress");
  const ev = db.query("SELECT 1 FROM events WHERE task_id = ? AND type = 'merge_blocked_destructive'").get(taskId);
  expect(ev).toBeTruthy();
});

test("override_destructive_check bypasses the guard", async () => {
  const { db, taskId } = seed();
  // No smoke deps needed: local-ff merge is stubbed to succeed, task advances.
  const res = await mergeTask(db, herdr, taskId, { override_destructive_check: true }, { exec: destructiveExec });
  expect(res.status).toBe(200);
  const ev = db.query("SELECT 1 FROM events WHERE task_id = ? AND type = 'merge_blocked_destructive'").get(taskId);
  expect(ev).toBeFalsy();
});
