import { test, expect, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// spawnAgent writes a brief file under HIVE_HOME; point it at a scratch dir.
const HOME = mkdtempSync(join(tmpdir(), "hive-dispatch-"));
process.env.HIVE_HOME = HOME;

const { openDb, newId, now } = await import("../src/db.ts");
import type { DB } from "../src/db.ts";
const { dispatchOnce, isReviewed, inBackoff } = await import("../src/dispatcher.ts");
const { writeEvent, getTask } = await import("../src/state.ts");
const { Herdr } = await import("../src/runtime/herdr.ts");
import type { Exec, ExecResult } from "../src/exec.ts";

const OK = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });

// A herdr stub whose worktree-create returns a canned worktree; records spawns.
function stubHerdr(fail = false) {
  const spawns: string[] = [];
  const exec: Exec = async (argv) => {
    if (argv.includes("create")) {
      if (fail) return { code: 1, stdout: "", stderr: "worktree create boom" };
      spawns.push(argv[argv.indexOf("--cwd") + 1]);
      return OK('{"result":{"worktree":{"path":"/wt/x","branch":"hive/x","open_workspace_id":"w1"}}}');
    }
    return OK(); // agent start etc.
  };
  return { herdr: new Herdr(exec, "herdr"), spawns };
}

function freshDb(config: any = {}): { db: DB; projectId: string } {
  const db = openDb(":memory:");
  const projectId = newId("proj");
  db.query("INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)")
    .run(projectId, "p", "/repo", JSON.stringify(config), now());
  return { db, projectId };
}
function makeTask(db: DB, projectId: string, extra: Partial<{ kind: string; source: string; state: string; agent_target: string }> = {}): string {
  const id = newId();
  const t = now();
  db.query(
    "INSERT INTO tasks (id, project_id, title, state, kind, source, agent_target, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)"
  ).run(id, projectId, "t", extra.state ?? "queued", extra.kind ?? "ship", extra.source ?? null, extra.agent_target ?? null, t, t);
  return id;
}

test("auto_dispatch off: queued tasks are NOT spawned", async () => {
  const { db, projectId } = freshDb({}); // no auto_dispatch
  const id = makeTask(db, projectId);
  const { herdr, spawns } = stubHerdr();
  await dispatchOnce(db, { herdr });
  expect(spawns.length).toBe(0);
  expect(getTask(db, id).state).toBe("queued");
});

test("auto_dispatch on: a queued ship task is spawned and moves to in_progress", async () => {
  const { db, projectId } = freshDb({ auto_dispatch: true });
  const id = makeTask(db, projectId);
  const { herdr, spawns } = stubHerdr();
  await dispatchOnce(db, { herdr });
  expect(spawns.length).toBe(1);
  expect(getTask(db, id).state).toBe("in_progress");
});

test("dispatch_kinds default excludes chore tasks", async () => {
  const { db, projectId } = freshDb({ auto_dispatch: true });
  const chore = makeTask(db, projectId, { kind: "chore" });
  const scout = makeTask(db, projectId, { kind: "scout" });
  const { herdr, spawns } = stubHerdr();
  await dispatchOnce(db, { herdr });
  expect(spawns.length).toBe(1); // only the scout
  expect(getTask(db, chore).state).toBe("queued");
  expect(getTask(db, scout).state).toBe("in_progress");
});

test("intake_gchat tasks are skipped until reviewed", async () => {
  const { db, projectId } = freshDb({ auto_dispatch: true });
  const id = makeTask(db, projectId, { source: "intake_gchat" });
  // the intake connector's own UNREVIEWED marker must NOT count as reviewed
  writeEvent(db, { task_id: id, source: "system", type: "note", payload: { note: "UNREVIEWED external input. Review before acting." } });
  expect(isReviewed(db, id)).toBe(false);
  const { herdr, spawns } = stubHerdr();
  await dispatchOnce(db, { herdr });
  expect(spawns.length).toBe(0);
  expect(getTask(db, id).state).toBe("queued");

  // once a reviewed note lands, it dispatches
  writeEvent(db, { task_id: id, source: "director", type: "note", payload: { note: "reviewed, looks safe" } });
  expect(isReviewed(db, id)).toBe(true);
  await dispatchOnce(db, { herdr });
  expect(spawns.length).toBe(1);
});

test("concurrency cap (max_agents) limits new spawns per project", async () => {
  const { db, projectId } = freshDb({ auto_dispatch: true, max_agents: 2 });
  // one agent already running -> 1 slot used, cap 2 -> only 1 more may spawn
  makeTask(db, projectId, { state: "in_progress", agent_target: "a0" });
  makeTask(db, projectId);
  makeTask(db, projectId);
  const { herdr, spawns } = stubHerdr();
  await dispatchOnce(db, { herdr });
  expect(spawns.length).toBe(1);
});

test("authority deny blocks auto-dispatch", async () => {
  const { db, projectId } = freshDb({ auto_dispatch: true });
  const id = makeTask(db, projectId);
  db.query("INSERT INTO authority_rules (id, project_id, scope, action_pattern, effect, active, created_at) VALUES (?,?,?,?,?,1,?)")
    .run(newId("aur"), null, "global", "task.dispatch", "deny", now());
  const { herdr, spawns } = stubHerdr();
  await dispatchOnce(db, { herdr });
  expect(spawns.length).toBe(0);
  expect(getTask(db, id).state).toBe("queued");
  expect(db.query("SELECT 1 FROM events WHERE task_id = ? AND type = 'authority_denied'").get(id)).toBeTruthy();
});

test("spawn failure records one spawn_error and backs off (no retry storm)", async () => {
  const { db, projectId } = freshDb({ auto_dispatch: true });
  const id = makeTask(db, projectId);
  const { herdr } = stubHerdr(true); // worktree create fails
  // spawn_error events are stamped with the real now(), so anchor the fake clock
  // to wall time and advance it to cross the backoff window.
  let t = Date.now();
  const clock = () => t;

  await dispatchOnce(db, { herdr, nowMs: clock });
  expect(getTask(db, id).state).toBe("queued");
  let errs = db.query("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = 'spawn_error'").get(id) as { n: number };
  expect(errs.n).toBe(1);

  // immediately re-running does NOT retry (still in 30s backoff)
  expect(inBackoff(db, id, t)).toBe(true);
  await dispatchOnce(db, { herdr, nowMs: clock });
  errs = db.query("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = 'spawn_error'").get(id) as { n: number };
  expect(errs.n).toBe(1); // no new error -> no retry

  // after the backoff window elapses, it retries (a second error appears)
  t += 31_000;
  expect(inBackoff(db, id, t)).toBe(false);
  await dispatchOnce(db, { herdr, nowMs: clock });
  errs = db.query("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = 'spawn_error'").get(id) as { n: number };
  expect(errs.n).toBe(2);
});
