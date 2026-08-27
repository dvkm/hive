// Review-parked agents must not hold a dispatch slot forever (#1132): once a
// task is in review its agent is idle by definition, so it is released (pane
// closed, worktree/branch PRESERVED) and stops counting — and feedback brings a
// fresh agent back onto the SAME branch with that feedback in its brief.
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// spawnAgent writes a brief file under HIVE_HOME; point it at a scratch dir.
const HOME = mkdtempSync(join(tmpdir(), "hive-release-"));
process.env.HIVE_HOME = HOME;

const { openDb, newId, now } = await import("../src/db.ts");
import type { DB } from "../src/db.ts";
const { releaseReviewAgent, releaseReviewAgents } = await import("../src/cleanup.ts");
const { dispatchOnce } = await import("../src/dispatcher.ts");
const { writeEvent, getTask } = await import("../src/state.ts");
const { queueSteerEvent, queuedSteers } = await import("../src/steer.ts");
const { Herdr } = await import("../src/runtime/herdr.ts");
import type { Exec, ExecResult } from "../src/exec.ts";

const OK = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const has = (argv: string[], ...xs: string[]) => xs.every((x) => argv.includes(x));

// A real, writable worktree path so a spawn's hook-settings write succeeds.
const WT = mkdtempSync(join(tmpdir(), "hive-release-wt-"));

function freshDb(config: any = {}): { db: DB; projectId: string } {
  const db = openDb(":memory:");
  const projectId = newId("proj");
  db.query("INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)")
    .run(projectId, "p", "/repo", JSON.stringify(config), now());
  return { db, projectId };
}

function seedTask(
  db: DB,
  projectId: string,
  extra: Partial<{ state: string; agent_target: string | null; source: string; branch: string }> = {}
): string {
  const id = newId();
  const t = now();
  db.query(
    `INSERT INTO tasks (id, project_id, title, state, kind, source, agent_target, worktree_path, branch, pr_url, created_at, updated_at)
     VALUES (?,?,?,?, 'ship', ?,?,?,?,?,?,?)`
  ).run(
    id,
    projectId,
    "t",
    extra.state ?? "in_review",
    extra.source ?? null,
    extra.agent_target === undefined ? id : extra.agent_target,
    `/wt/hive-${id}`,
    extra.branch ?? `hive/${id}`,
    "https://gh/pr/1",
    t,
    t
  );
  // The spawned event is where cleanup finds the tab/workspace to close.
  writeEvent(db, {
    task_id: id,
    source: "herdr",
    type: "spawned",
    payload: { agent_target: id, tab_id: "wF:t9", workspace_id: "w9" },
  });
  return id;
}

// herdr whose `agent get` reports one fixed status for a live, paned agent.
function herdrWithStatus(status: string, calls: string[][] = []) {
  const exec: Exec = async (argv) => {
    calls.push(argv);
    if (has(argv, "agent", "get")) return OK(`{"result":{"agent":{"agent_status":"${status}","pane_id":"w9:p1"}}}`);
    return OK();
  };
  return new Herdr(exec, "herdr");
}

// The full visible-fleet spawn stub (worktree + fleet workspace + tab + start).
function stubSpawnHerdr(calls: string[][] = [], probeStatus = "idle") {
  const exec: Exec = async (argv) => {
    calls.push(argv);
    if (has(argv, "worktree", "create"))
      return OK(`{"result":{"worktree":{"path":${JSON.stringify(WT)},"branch":"hive/reattached","open_workspace_id":"w1"}}}`);
    if (has(argv, "workspace", "list")) return OK('{"result":{"workspaces":[{"workspace_id":"wF","label":"hive-fleet"}]}}');
    if (has(argv, "tab", "create")) return OK('{"result":{"tab":{"tab_id":"wF:t2"}}}');
    if (has(argv, "agent", "get")) return OK(`{"result":{"agent":{"agent_status":"${probeStatus}","pane_id":"w9:p1"}}}`);
    return OK();
  };
  return new Herdr(exec, "herdr");
}

test("an idle in_review agent is released: session closed, worktree preserved, slot freed", async () => {
  const { db, projectId } = freshDb();
  const id = seedTask(db, projectId);
  const calls: string[][] = [];

  const r = await releaseReviewAgent(db, herdrWithStatus("idle", calls), id);

  expect(r.released).toBe(true);
  const task = getTask(db, id);
  expect(task.agent_target).toBeNull(); // no longer counts toward max_agents
  expect(task.worktree_path).toBe(`/wt/hive-${id}`); // branch checkout survives
  expect(task.branch).toBe(`hive/${id}`);
  expect(task.state).toBe("in_review"); // lifecycle untouched
  // The pane really was closed (tab close, plus the worktree's own workspace).
  expect(calls.some((c) => has(c, "tab", "close", "wF:t9"))).toBe(true);
  expect(calls.some((c) => has(c, "workspace", "close", "w9"))).toBe(true);
  const released = db.query("SELECT payload FROM events WHERE task_id = ? AND type = 'agent_released'").all(id);
  expect(released.length).toBe(1);
});

test("a working in_review agent is left alone", async () => {
  const { db, projectId } = freshDb();
  const id = seedTask(db, projectId);
  const calls: string[][] = [];

  const r = await releaseReviewAgent(db, herdrWithStatus("working", calls), id);

  expect(r.released).toBe(false);
  expect(getTask(db, id).agent_target).toBe(id);
  expect(calls.some((c) => has(c, "tab", "close"))).toBe(false);
});

test("an unconfirmed-gone agent is NOT released (a herdr registry wipe must not close live panes)", async () => {
  const { db, projectId } = freshDb();
  const id = seedTask(db, projectId);
  const calls: string[][] = [];
  // agent_not_found, but the pane list still shows the task's own tab: alive,
  // just unregistered — the 2026-08-19 false-death shape.
  const herdr = new Herdr(async (argv) => {
    calls.push(argv);
    if (has(argv, "agent", "get")) return OK('{"error":{"code":"agent_not_found"}}');
    if (has(argv, "pane", "list")) return OK('{"result":{"panes":[{"pane_id":"p1","tab_id":"wF:t9","workspace_id":"wF","cwd":"/x"}]}}');
    return OK();
  }, "herdr");

  expect((await releaseReviewAgent(db, herdr, id)).released).toBe(false);
  expect(getTask(db, id).agent_target).toBe(id);
  expect(calls.some((c) => has(c, "tab", "close"))).toBe(false);
});

test("a genuinely gone agent (pane list has no trace) IS released", async () => {
  const { db, projectId } = freshDb();
  const id = seedTask(db, projectId);
  const herdr = new Herdr(async (argv) => {
    if (has(argv, "agent", "get")) return OK('{"error":{"code":"agent_not_found"}}');
    if (has(argv, "pane", "list")) return OK('{"result":{"panes":[{"pane_id":"p1","tab_id":"other:t1","workspace_id":"wF","cwd":"/elsewhere"}]}}');
    return OK();
  }, "herdr");

  expect((await releaseReviewAgent(db, herdr, id)).released).toBe(true);
  expect(getTask(db, id).agent_target).toBeNull();
});

test("a queued-input recovery in flight holds the release (#1234 review-12)", async () => {
  const { db, projectId } = freshDb();
  const id = seedTask(db, projectId);
  // Up+Enter was just sent to unstick the pane — the redelivered turn may be
  // about to run. Closing the session now would kill it mid-air.
  writeEvent(db, { task_id: id, source: "reconciler", type: "queued_input_recovered", payload: { delivered: true } });

  const r = await releaseReviewAgent(db, herdrWithStatus("idle"), id);

  expect(r.released).toBe(false);
  expect(r.reason).toBe("queued-input recovery pending");
  expect(getTask(db, id).agent_target).toBe(id);
});

test("undelivered feedback holds the release (drainSteers gets first go at a live agent)", async () => {
  const { db, projectId } = freshDb();
  const id = seedTask(db, projectId);
  queueSteerEvent(db, id, "fix the conflict", "test");

  expect((await releaseReviewAgent(db, herdrWithStatus("idle"), id)).released).toBe(false);
});

test("config.release_review_agents=false opts a project out of the sweep", async () => {
  const on = freshDb();
  const onId = seedTask(on.db, on.projectId);
  expect(await releaseReviewAgents(on.db, herdrWithStatus("idle"))).toBe(1);
  expect(getTask(on.db, onId).agent_target).toBeNull();

  const off = freshDb({ release_review_agents: false });
  const offId = seedTask(off.db, off.projectId);
  expect(await releaseReviewAgents(off.db, herdrWithStatus("idle"))).toBe(0);
  expect(getTask(off.db, offId).agent_target).toBe(offId);
});

test("releasing frees the slot so a queued task finally dispatches", async () => {
  // The 2026-08-19 consuming-project shape in miniature: room under the working cap, but
  // idle review agents push live agents past max_agents * REVIEW_OVERHANG, so
  // the queue freezes. max_agents 2, one worker + three review-parked = 4 live.
  const { db, projectId } = freshDb({ auto_dispatch: true, max_agents: 2 });
  seedTask(db, projectId, { state: "in_progress" });
  seedTask(db, projectId, { state: "in_review" });
  seedTask(db, projectId, { state: "in_review" });
  seedTask(db, projectId, { state: "in_review" });
  const queuedId = seedTask(db, projectId, { state: "queued", agent_target: null });

  const before: string[][] = [];
  await dispatchOnce(db, { herdr: stubSpawnHerdr(before), exec: async () => OK() });
  expect(before.some((c) => has(c, "worktree", "create"))).toBe(false); // starved
  expect(getTask(db, queuedId).state).toBe("queued");

  expect(await releaseReviewAgents(db, herdrWithStatus("idle"))).toBe(3);

  const after: string[][] = [];
  await dispatchOnce(db, { herdr: stubSpawnHerdr(after), exec: async () => OK() });
  expect(after.some((c) => has(c, "worktree", "create"))).toBe(true);
  expect(getTask(db, queuedId).state).toBe("in_progress");
});

test("feedback on a released task respawns an agent on the same branch, with the feedback in its brief", async () => {
  const { db, projectId } = freshDb({ auto_dispatch: true, max_agents: 3 });
  const id = seedTask(db, projectId);
  await releaseReviewAgent(db, herdrWithStatus("idle"), id);
  const branch = getTask(db, id).branch;

  // A review comment lands while nobody is on the task.
  queueSteerEvent(db, id, "reviewer: please rename the flag", "review comment; no live agent");

  const calls: string[][] = [];
  await dispatchOnce(db, { herdr: stubSpawnHerdr(calls), exec: async () => OK() });

  const create = calls.find((c) => has(c, "worktree", "create"));
  expect(create).toBeDefined();
  expect(create![create!.indexOf("--branch") + 1]).toBe(branch); // SAME branch, not a new one
  const start = calls.find((c) => has(c, "agent", "start"));
  expect(start!.join(" ")).toContain("reviewer: please rename the flag"); // feedback rides in the brief
  expect(getTask(db, id).agent_target).toBe(id);
  expect(queuedSteers(db, id).length).toBe(0); // receipted by the spawn
  expect(getTask(db, id).state).toBe("in_progress");
  expect(db.query("SELECT 1 FROM events WHERE task_id = ? AND type = 'changes_requested'").get(id)).toBeTruthy();
});

test("reattach ignores agentless tasks with nothing queued, and tracking-only tasks", async () => {
  const { db, projectId } = freshDb({ auto_dispatch: true });
  seedTask(db, projectId, { agent_target: null }); // released, no feedback
  const ext = seedTask(db, projectId, { agent_target: null, source: "external" });
  queueSteerEvent(db, ext, "ignored", "test");

  const calls: string[][] = [];
  await dispatchOnce(db, { herdr: stubSpawnHerdr(calls), exec: async () => OK() });
  expect(calls.some((c) => has(c, "worktree", "create"))).toBe(false);
});
