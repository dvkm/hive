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

// A real, writable worktree path so the spawn's hook-settings write succeeds.
const WT = mkdtempSync(join(tmpdir(), "hive-dispatch-wt-"));
const has = (argv: string[], ...xs: string[]) => xs.every((x) => argv.includes(x));

// A herdr stub for the full visible-fleet spawn (worktree + fleet workspace +
// labelled tab + agent start); records only real worktree spawns.
function stubHerdr(fail = false) {
  const spawns: string[] = [];
  const exec: Exec = async (argv) => {
    if (has(argv, "worktree", "create")) {
      if (fail) return { code: 1, stdout: "", stderr: "worktree create boom" };
      spawns.push(argv[argv.indexOf("--cwd") + 1]);
      return OK(`{"result":{"worktree":{"path":${JSON.stringify(WT)},"branch":"hive/x","open_workspace_id":"w1"}}}`);
    }
    if (has(argv, "workspace", "list")) return OK('{"result":{"workspaces":[{"workspace_id":"wF","label":"hive-fleet"}]}}');
    if (has(argv, "tab", "create")) return OK('{"result":{"tab":{"tab_id":"wF:t2"}}}');
    return OK(); // agent start / rename etc.
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
function makeTask(db: DB, projectId: string, extra: Partial<{ kind: string; source: string; state: string; agent_target: string; depends_on: string[] }> = {}): string {
  const id = newId();
  const t = now();
  db.query(
    "INSERT INTO tasks (id, project_id, title, state, kind, source, agent_target, depends_on, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
  ).run(id, projectId, "t", extra.state ?? "queued", extra.kind ?? "ship", extra.source ?? null, extra.agent_target ?? null, extra.depends_on ? JSON.stringify(extra.depends_on) : null, t, t);
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

test("chores dispatch by default; config.dispatch_kinds can still exclude them", async () => {
  const { db, projectId } = freshDb({ auto_dispatch: true });
  const chore = makeTask(db, projectId, { kind: "chore" });
  const scout = makeTask(db, projectId, { kind: "scout" });
  const { herdr, spawns } = stubHerdr();
  await dispatchOnce(db, { herdr });
  expect(spawns.length).toBe(2);
  expect(getTask(db, chore).state).toBe("in_progress");
  expect(getTask(db, scout).state).toBe("in_progress");

  const excl = freshDb({ auto_dispatch: true, dispatch_kinds: ["ship", "scout"] });
  const excluded = makeTask(excl.db, excl.projectId, { kind: "chore" });
  const s2 = stubHerdr();
  await dispatchOnce(excl.db, { herdr: s2.herdr });
  expect(s2.spawns.length).toBe(0);
  expect(getTask(excl.db, excluded).state).toBe("queued");
});

test("a requeue bypasses dispatch_kinds exclusion (recovery of already-blessed work)", async () => {
  const { db, projectId } = freshDb({ auto_dispatch: true, dispatch_kinds: ["ship"] });
  const requeued = makeTask(db, projectId, { kind: "chore", source: "requeue" });
  const plainChore = makeTask(db, projectId, { kind: "chore" });
  const { herdr, spawns } = stubHerdr();
  await dispatchOnce(db, { herdr });
  expect(spawns.length).toBe(1); // only the requeue
  expect(getTask(db, requeued).state).toBe("in_progress");
  expect(getTask(db, plainChore).state).toBe("queued");
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

test("review-parked agents don't consume working slots, but bound overhang at 2x cap", async () => {
  const { db, projectId } = freshDb({ auto_dispatch: true, max_agents: 2 });
  // two agents parked in review -> 0 working slots used -> dispatch proceeds
  makeTask(db, projectId, { state: "in_review", agent_target: "a0" });
  makeTask(db, projectId, { state: "in_review", agent_target: "a1" });
  makeTask(db, projectId);
  makeTask(db, projectId);
  makeTask(db, projectId);
  const { herdr, spawns } = stubHerdr();
  await dispatchOnce(db, { herdr });
  // working cap 2 allows 2 spawns; total active would hit 2*2=4 -> third stays queued
  expect(spawns.length).toBe(2);
});

test("tracking-only (source=external) tasks are never auto-dispatched", async () => {
  const { db, projectId } = freshDb({ auto_dispatch: true });
  const id = makeTask(db, projectId, { source: "external" });
  const { herdr, spawns } = stubHerdr();
  await dispatchOnce(db, { herdr });
  expect(spawns.length).toBe(0);
  expect(getTask(db, id).state).toBe("queued");
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

test("unmet depends_on blocks spawn (visible 'blocked by'), met deps let it through", async () => {
  const { db, projectId } = freshDb({ auto_dispatch: true });
  const dep = makeTask(db, projectId, { state: "in_progress" }); // not merged/done
  const child = makeTask(db, projectId, { depends_on: [dep] });
  const { herdr, spawns } = stubHerdr();

  await dispatchOnce(db, { herdr });
  expect(spawns.length).toBe(0);
  expect(getTask(db, child).state).toBe("queued");
  expect(db.query("SELECT 1 FROM events WHERE task_id = ? AND type = 'dependency_blocked'").get(child)).toBeTruthy();

  // re-running while still blocked does NOT write a second identical event (dedup)
  await dispatchOnce(db, { herdr });
  const blocks = db.query("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = 'dependency_blocked'").get(child) as { n: number };
  expect(blocks.n).toBe(1);

  // once the dependency reaches a merged state, the child spawns
  db.query("UPDATE tasks SET state = 'done' WHERE id = ?").run(dep);
  await dispatchOnce(db, { herdr });
  expect(spawns.length).toBe(1);
  expect(getTask(db, child).state).toBe("in_progress");
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
