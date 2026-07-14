// The herdr push channel for "agent is done": superviseAgent must hand a task
// off to in_review from herdr's own idle signal (no agent emit involved), and
// must survive a wait timeout while the agent is still alive.
import { test, expect } from "bun:test";
import { openDb, newId, now, type DB } from "../src/db.ts";
import { transition, getTask } from "../src/state.ts";
import { superviseAgent } from "../src/api.ts";
import { Herdr } from "../src/runtime/herdr.ts";
import type { Exec, ExecResult } from "../src/exec.ts";

const OK = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const IDLE_AGENT = '{"result":{"agent":{"agent_status":"idle","pane_id":"w1:p1"}}}';

function seedTask(db: DB, extra: Partial<{ pr_url: string }> = {}): string {
  const projectId = newId("proj");
  db.query("INSERT INTO projects (id, name, config, created_at) VALUES (?,?,?,?)").run(projectId, "p", "{}", now());
  const id = newId();
  const t = now();
  db.query(
    "INSERT INTO tasks (id, project_id, title, state, kind, agent_target, pr_url, created_at, updated_at) VALUES (?,?,?,?, 'ship', 'a1', ?, ?, ?)"
  ).run(id, projectId, "t", "queued", extra.pr_url ?? null, t, t);
  transition(db, id, "in_progress");
  // The idle backstop now refuses evidence-less reviews; these tests exercise
  // the herdr-signal plumbing, so satisfy the gate.
  db.query("INSERT INTO evidence (id, task_id, ts, kind, path, caption) VALUES (?,?,?,?,?,?)").run(
    newId("evd"), id, t, "log", "/tmp/x.log", "proof"
  );
  return id;
}

test("supervise: herdr idle signal advances a PR-bearing task to in_review (no agent emit)", async () => {
  const db = openDb(":memory:");
  const id = seedTask(db, { pr_url: "https://gh/pr/1" });
  let waits = 0;
  const exec: Exec = async (argv) => {
    if (argv.includes("wait")) {
      waits++;
      // first wait times out (agent still working) → loop must re-arm, not quit
      return waits === 1 ? { code: 1, stdout: "", stderr: "timeout" } : OK("{}");
    }
    return OK(IDLE_AGENT); // probe (alive) + status (idle)
  };
  await superviseAgent(db, new Herdr(exec, "herdr"), id, "a1");

  expect(waits).toBe(2); // re-armed after the timeout
  expect(getTask(db, id).state).toBe("in_review");
  const ev = db.query("SELECT source, payload FROM events WHERE task_id = ? AND type = 'ready_for_review'").all(id) as any[];
  expect(ev.length).toBe(1);
  expect(ev[0].source).toBe("herdr");
  expect(JSON.parse(ev[0].payload).via).toBe("idle");
});

test("supervise: a dead agent ends the loop without touching the task (recovery owns it)", async () => {
  const db = openDb(":memory:");
  const id = seedTask(db, { pr_url: "https://gh/pr/1" });
  const exec: Exec = async (argv) => {
    if (argv.includes("wait")) return { code: 1, stdout: "", stderr: "agent_not_found" };
    return { code: 1, stdout: "", stderr: '"agent_not_found"' }; // probe → dead
  };
  await superviseAgent(db, new Herdr(exec, "herdr"), id, "a1");
  expect(getTask(db, id).state).toBe("in_progress"); // untouched; reconciler recovery handles death
});
