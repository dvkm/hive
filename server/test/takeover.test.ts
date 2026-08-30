import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, newId, now, type DB } from "../src/db.ts";
import { takeOver, handBack, TakeoverError, PARK_UNTIL } from "../src/takeover.ts";
import { getTask, writeEvent } from "../src/state.ts";
import { queuedSteers } from "../src/steer.ts";
import { dispatchOnce } from "../src/dispatcher.ts";
import { Herdr } from "../src/runtime/herdr.ts";
import { defaultExec, type Exec, type ExecResult } from "../src/exec.ts";

const OK = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });

// A herdr stub that records the closes takeover asks for.
function stubHerdr() {
  const calls: string[][] = [];
  const exec: Exec = async (argv) => {
    calls.push(argv);
    if (argv.includes("list")) return OK('{"result":{"panes":[]}}');
    return OK();
  };
  return { herdr: new Herdr(exec, "herdr"), calls };
}

// A real git worktree, because the whole point of the baseline is what git
// actually reports. Returns the checkout path.
async function gitRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "hive-takeover-"));
  const git = (...args: string[]) => defaultExec(["git", "-C", dir, ...args]);
  await git("init", "-q", "-b", "main");
  await git("config", "user.email", "t@t");
  await git("config", "user.name", "t");
  writeFileSync(join(dir, "app.ts"), "original\n");
  await git("add", "-A");
  await git("commit", "-qm", "base");
  return dir;
}

function seed(worktree: string, extra: Record<string, any> = {}): { db: DB; id: string } {
  const db = openDb(":memory:");
  const projectId = newId("proj");
  db.query("INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)").run(
    projectId, "p", "/repo", JSON.stringify({ auto_dispatch: true }), now()
  );
  const id = newId();
  const t = now();
  db.query(
    `INSERT INTO tasks (id, project_id, title, state, kind, agent_target, worktree_path, branch, created_at, updated_at)
     VALUES (?,?,?,?,'ship',?,?,?,?,?)`
  ).run(id, projectId, "t", extra.state ?? "in_progress", extra.agent_target ?? "agent-1", worktree, "hive/x", t, t);
  return { db, id };
}

test("take over parks the task, frees the agent slot, and records a baseline", async () => {
  const wt = await gitRepo();
  const { db, id } = seed(wt);
  writeEvent(db, { task_id: id, source: "herdr", type: "spawned", payload: { tab_id: "wF:t2", workspace_id: "w1" } });
  const { herdr, calls } = stubHerdr();

  const r = await takeOver(db, id, { herdr });
  expect(r.worktree_path).toBe(wt);
  expect(r.base).toMatch(/^[0-9a-f]{40}$/);

  const task = getTask(db, id);
  // agent_target NULL is what frees the slot: every dispatcher capacity count
  // keys on it.
  expect(task.agent_target).toBeNull();
  expect(task.parked_for_director).toBeTruthy();
  expect(task.deferred_until).toBe(PARK_UNTIL);
  expect(task.state).toBe("in_progress"); // no state hop
  expect(calls.some((c) => c.includes("close"))).toBe(true);
});

test("hand back summarises only what the director changed, not the agent's leftovers", async () => {
  const wt = await gitRepo();
  // The agent left this uncommitted when it was parked. It must NOT show up as
  // a director change — that is what the stash-create baseline buys.
  writeFileSync(join(wt, "agent-wip.ts"), "half-done\n");
  await defaultExec(["git", "-C", wt, "add", "-A"]);
  // And this one it never staged. `git stash create` cannot capture an untracked
  // file, so hand-back has to subtract the list recorded at take-over.
  writeFileSync(join(wt, "agent-scratch.ts"), "notes\n");

  const { db, id } = seed(wt);
  await takeOver(db, id, { herdr: stubHerdr().herdr });

  // Now the director edits: one existing file, one brand-new one.
  writeFileSync(join(wt, "app.ts"), "director rewrote this\n");
  writeFileSync(join(wt, "new.ts"), "director added this\n");

  const r = await handBack(db, id, { note: "use the new signature" });
  expect(r.summary).toContain("app.ts");
  expect(r.summary).toContain("new.ts");
  expect(r.summary).not.toContain("agent-wip.ts");
  expect(r.summary).not.toContain("agent-scratch.ts");

  const steers = queuedSteers(db, id);
  expect(steers.length).toBe(1);
  expect(steers[0].message).toContain("app.ts");
  expect(steers[0].message).toContain("use the new signature");

  const task = getTask(db, id);
  expect(task.parked_for_director).toBeNull();
  expect(task.takeover_base).toBeNull();
  expect(task.deferred_until).toBeNull();
});

test("hand back keeps a deferral the director set for their own reasons", async () => {
  const wt = await gitRepo();
  const { db, id } = seed(wt);
  const until = "2099-01-01T00:00:00.000Z";
  db.query("UPDATE tasks SET deferred_until = ? WHERE id = ?").run(until, id);

  await takeOver(db, id, { herdr: stubHerdr().herdr });
  // Take-over overwrote it with its own park sentinel, so hand-back must not
  // silently un-defer... it clears only the sentinel it recognises.
  db.query("UPDATE tasks SET deferred_until = ? WHERE id = ?").run(until, id);
  await handBack(db, id, {});
  expect(getTask(db, id).deferred_until).toBe(until);
});

test("a parked task is not reattached, and is once it is handed back", async () => {
  const wt = await gitRepo();
  const { db, id } = seed(wt);
  await takeOver(db, id, { herdr: stubHerdr().herdr });
  // Feedback arrives while the director holds the worktree.
  writeEvent(db, {
    task_id: id,
    source: "director",
    type: "steer",
    payload: { message: "CI is red", delivery: "queued" },
  });

  const spawns: string[][] = [];
  const spawnHerdr = new Herdr(async (argv) => {
    spawns.push(argv);
    return OK('{"result":{"panes":[]}}');
  }, "herdr");

  await dispatchOnce(db, { herdr: spawnHerdr });
  expect(spawns.some((c) => c.includes("worktree"))).toBe(false);
  expect(getTask(db, id).agent_target).toBeNull();

  await handBack(db, id, {});
  // Two queued steers now: the director's and hand-back's own summary.
  expect(queuedSteers(db, id).length).toBe(2);
  expect(getTask(db, id).parked_for_director).toBeNull();
});

test("take over refuses a task with no worktree and a second take-over", async () => {
  const wt = await gitRepo();
  const { db, id } = seed(wt);
  await takeOver(db, id, { herdr: stubHerdr().herdr });
  await expect(takeOver(db, id, { herdr: stubHerdr().herdr })).rejects.toBeInstanceOf(TakeoverError);

  const { db: db2, id: id2 } = seed(wt);
  db2.query("UPDATE tasks SET worktree_path = NULL WHERE id = ?").run(id2);
  await expect(takeOver(db2, id2, { herdr: stubHerdr().herdr })).rejects.toBeInstanceOf(TakeoverError);
});
