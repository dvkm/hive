// Every path that fails a task and requeues it must reclaim a dirty worktree
// FIRST, so the rescued ghost branch is named in a `worktree_reclaimed` event
// (task #1230). recovery.test.ts already covers the dead-agent path
// (reconciler.ts recoverDead); this file covers the other two: context-window
// exhaustion (recoverContextFull) and the manual "fail + requeue" endpoint
// (POST /api/tasks/:id/requeue).
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "hive-reclaim-requeue-"));
process.env.HIVE_HOME = HOME;

const { openDb, newId, now } = await import("../src/db.ts");
import type { DB } from "../src/db.ts";
const { reconcileOnce } = await import("../src/reconciler.ts");
const { makeHandler } = await import("../src/api.ts");
const { Herdr } = await import("../src/runtime/herdr.ts");
const { getTask } = await import("../src/state.ts");
import type { Exec, ExecResult } from "../src/exec.ts";

const OK = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const has = (argv: string[], ...xs: string[]) => xs.every((x) => argv.includes(x));
const gh: Exec = async () => ({ code: 1, stdout: "", stderr: "no gh" }); // PR sync no-op

function freshDb(): { db: DB; projectId: string } {
  const db = openDb(":memory:");
  const projectId = newId("proj");
  db.query("INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)")
    .run(projectId, "p", "/repo", "{}", now());
  return { db, projectId };
}

function makeTask(db: DB, projectId: string, agentTarget: string): string {
  const id = newId();
  const t = now();
  db.query(
    `INSERT INTO tasks (id, project_id, title, brief, state, kind, agent_target, branch, worktree_path, created_at, updated_at)
     VALUES (?,?,?,?, 'in_progress', 'ship', ?, 'hive/x', '/wt/x', ?, ?)`
  ).run(id, projectId, "t", "do it", agentTarget, t, t);
  return id;
}

let seq = 0;
function putEvent(db: DB, taskId: string, type: string, payload: any = {}): void {
  const ts = new Date(Date.now() + seq++ * 1000).toISOString();
  db.query("INSERT INTO events (id, task_id, ts, source, type, payload) VALUES (?,?,?,?,?,?)")
    .run(newId("evt"), taskId, ts, "reconciler", type, JSON.stringify(payload));
}

const reclaimEvent = (db: DB, id: string, type: string) =>
  db.query("SELECT payload FROM events WHERE task_id = ? AND type = ?").get(id, type) as { payload: string } | undefined;

// A worktree at /wt/x on branch hive/x with real uncommitted state, plus
// configurable `agent get` / `agent read` responses — same fixture shape as
// recovery.test.ts's herdrDeadWithWorktree.
function herdrWithDirtyWorktree(agentGetBody: string, readTail: string) {
  const exec: Exec = async (argv) => {
    if (argv[0] === "git") {
      if (has(argv, "worktree", "list")) return OK("worktree /wt/x\nHEAD abc\nbranch refs/heads/hive/x\n");
      if (has(argv, "status", "--porcelain")) return OK("?? rescued.txt\n");
      if (has(argv, "rev-parse", "--verify")) return { code: 1, stdout: "", stderr: "" }; // ghost name free
      return OK();
    }
    if (argv.includes("pane") && argv.includes("list")) return OK('{"result":{"panes":[]}}');
    if (argv.includes("get")) return OK(agentGetBody);
    if (argv.includes("read")) return OK(readTail);
    return OK();
  };
  return new Herdr(exec, "herdr");
}

test("context-full auto-requeue reclaims a dirty worktree before requeuing (reconciler.ts recoverContextFull)", async () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId, "a1");
  putEvent(db, id, "spawned");
  putEvent(db, id, "stale", { silent_ms: 999 });
  const herdr = herdrWithDirtyWorktree(
    '{"result":{"agent":{"agent_status":"idle","pane_id":"w6:p9"}}}',
    "... Context full, use /clear to continue ..."
  );

  await reconcileOnce(db, { staleMs: 60 * 60 * 1000, nowMs: () => Date.now(), exec: gh, herdr });

  expect(getTask(db, id).state).toBe("failed");
  const ev = reclaimEvent(db, id, "worktree_reclaimed");
  expect(ev).toBeTruthy();
  expect(JSON.parse(ev!.payload).ghost_branch).toBe(`ghost-${id}`);

  const requeue: any = db.query("SELECT * FROM tasks WHERE source = 'requeue' AND parent_task_id = ?").get(id);
  expect(requeue).toBeTruthy();
  expect(requeue.state).toBe("queued");
});

test("manual POST /api/tasks/:id/requeue reclaims a dirty worktree before failing+requeuing", async () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId, "a2");
  const dependent = newId();
  const t = now();
  db.query("INSERT INTO tasks (id, project_id, title, state, kind, depends_on, created_at, updated_at) VALUES (?,?,?, 'queued', 'ship', ?, ?, ?)")
    .run(dependent, projectId, "dependent", JSON.stringify([id]), t, t);
  const herdr = herdrWithDirtyWorktree("{}", "");
  const handle = makeHandler(db, { herdr });

  const res = await handle(new Request(`http://x/api/tasks/${id}/requeue`, { method: "POST" }));
  expect(res.status).toBe(200);
  const body: any = await res.json();
  expect(body.ok).toBe(true);

  expect(getTask(db, id).state).toBe("failed");
  const ev = reclaimEvent(db, id, "worktree_reclaimed");
  expect(ev).toBeTruthy();
  expect(JSON.parse(ev!.payload).ghost_branch).toBe(`ghost-${id}`);

  const requeue: any = db.query("SELECT * FROM tasks WHERE id = ?").get(body.new_task_id);
  expect(requeue.state).toBe("queued");
  expect(requeue.parent_task_id).toBe(id);
  expect(getTask(db, dependent).depends_on).toEqual([body.new_task_id]);
});
