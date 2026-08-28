// Task priority (HIVE-428): four ordinal levels — now > next > normal > later.
// Ordering ONLY. It changes which queued task is picked up first and which
// approved PR lands first. It never preempts: no running agent is ever stopped
// to make room, and the one relaxation of the per-project cap (the borrowed
// slot) is capped at a single extra agent per project.
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// spawnAgent writes a brief file under HIVE_HOME; point it at a scratch dir.
process.env.HIVE_HOME = mkdtempSync(join(tmpdir(), "hive-priority-"));

const { openDb, newId, now } = await import("../src/db.ts");
import type { DB } from "../src/db.ts";
const { dispatchOnce } = await import("../src/dispatcher.ts");
const { landOnce, markLand } = await import("../src/landQueue.ts");
const { transition } = await import("../src/state.ts");
const { Herdr } = await import("../src/runtime/herdr.ts");
const { makeHandler } = await import("../src/api.ts");
import type { Exec, ExecResult } from "../src/exec.ts";

const OK = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const WT = mkdtempSync(join(tmpdir(), "hive-priority-wt-"));
const has = (argv: string[], ...xs: string[]) => xs.every((x) => argv.includes(x));

// Records the order tasks were spawned in. The worktree branch is `hive/<taskId>`,
// which is the only place the spawn argv names the task.
function stubHerdr() {
  const spawns: string[] = [];
  const exec: Exec = async (argv) => {
    if (has(argv, "worktree", "create")) {
      spawns.push((argv[argv.indexOf("--branch") + 1] ?? "").replace(/^hive\//, ""));
      return OK(`{"result":{"worktree":{"path":${JSON.stringify(WT)},"branch":"hive/x","open_workspace_id":"w1"}}}`);
    }
    if (has(argv, "workspace", "list")) return OK('{"result":{"workspaces":[{"workspace_id":"wF","label":"hive-fleet"}]}}');
    if (has(argv, "tab", "create")) return OK('{"result":{"tab":{"tab_id":"wF:t2"}}}');
    return OK();
  };
  return { herdr: new Herdr(exec, "herdr"), spawns };
}

function freshDb(config: any = { auto_dispatch: true }): { db: DB; projectId: string } {
  const db = openDb(":memory:");
  const projectId = newId("proj");
  db.query("INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)")
    .run(projectId, "p", "/repo", JSON.stringify(config), now());
  return { db, projectId };
}

// createdAt lets a test make the priority-loser the OLDER task, so a pass can
// only come from priority and never from the created_at tiebreak.
function makeTask(
  db: DB,
  projectId: string,
  extra: { title?: string; priority?: string; state?: string; agent_target?: string; branch?: string; createdAt?: string } = {}
): string {
  const id = newId();
  const t = extra.createdAt ?? now();
  db.query(
    `INSERT INTO tasks (id, project_id, title, brief, state, kind, agent_target, branch, ci_status, priority, created_at, updated_at)
     VALUES (?,?,?,?,?,'ship',?,?,'passing',?,?,?)`
  ).run(id, projectId, extra.title ?? "t", "", extra.state ?? "queued", extra.agent_target ?? null, extra.branch ?? null, extra.priority ?? "normal", t, t);
  return id;
}

const titlesOf = (db: DB, ids: string[]) =>
  ids.map((id) => (db.query("SELECT title FROM tasks WHERE id = ?").get(id) as any).title);

// ------------------------------------------------------- schema default

test("existing rows and plain inserts default to 'normal'", () => {
  const { db, projectId } = freshDb();
  const id = newId();
  const t = now();
  db.query("INSERT INTO tasks (id, project_id, title, state, kind, created_at, updated_at) VALUES (?,?,?,?,?,?,?)")
    .run(id, projectId, "t", "queued", "ship", t, t);
  expect((db.query("SELECT priority FROM tasks WHERE id = ?").get(id) as any).priority).toBe("normal");
});

// ------------------------------------------------------- dispatch order

test("dispatch order is now > next > normal > later, regardless of age", async () => {
  // max_agents 4 so all four spawn in one cycle and the spawn order is the
  // queue order. Ages run BACKWARDS from the priority order: the lowest
  // priority is the oldest task, so created_at alone would give the reverse.
  const { db, projectId } = freshDb({ auto_dispatch: true, max_agents: 4 });
  makeTask(db, projectId, { title: "later", priority: "later", createdAt: "2020-01-01T00:00:00.000Z" });
  makeTask(db, projectId, { title: "normal", priority: "normal", createdAt: "2021-01-01T00:00:00.000Z" });
  makeTask(db, projectId, { title: "next", priority: "next", createdAt: "2022-01-01T00:00:00.000Z" });
  makeTask(db, projectId, { title: "now", priority: "now", createdAt: "2023-01-01T00:00:00.000Z" });

  const { herdr, spawns } = stubHerdr();
  await dispatchOnce(db, { herdr });
  expect(titlesOf(db, spawns)).toEqual(["now", "next", "normal", "later"]);
});

test("'later' never beats 'normal' for the last free slot", async () => {
  // One slot, and the 'later' task is far older — age would win it.
  const { db, projectId } = freshDb({ auto_dispatch: true, max_agents: 1 });
  makeTask(db, projectId, { title: "later", priority: "later", createdAt: "2020-01-01T00:00:00.000Z" });
  makeTask(db, projectId, { title: "normal", priority: "normal" });

  const { herdr, spawns } = stubHerdr();
  await dispatchOnce(db, { herdr });
  expect(titlesOf(db, spawns)).toEqual(["normal"]);
});

test("created_at still breaks ties inside one priority level", async () => {
  const { db, projectId } = freshDb({ auto_dispatch: true, max_agents: 1 });
  makeTask(db, projectId, { title: "younger", createdAt: "2024-01-01T00:00:00.000Z" });
  makeTask(db, projectId, { title: "older", createdAt: "2020-01-01T00:00:00.000Z" });

  const { herdr, spawns } = stubHerdr();
  await dispatchOnce(db, { herdr });
  expect(titlesOf(db, spawns)).toEqual(["older"]);
});

// ------------------------------------------------------- borrowed slot

test("a 'now' task borrows ONE slot past a full cap, and only one", async () => {
  // Cap of 2, already full. Two 'now' tasks are waiting: the first borrows the
  // extra slot (3 agents on a cap of 2), the second must wait — the ceiling is
  // cap+1, not cap+N. The review overhang (cap * 2 = 4) is deliberately slack
  // here so the only thing that can hold now-2 back is the borrowed-slot rule.
  const { db, projectId } = freshDb({ auto_dispatch: true, max_agents: 2 });
  makeTask(db, projectId, { title: "running-1", state: "in_progress", agent_target: "a1" });
  makeTask(db, projectId, { title: "running-2", state: "in_progress", agent_target: "a2" });
  makeTask(db, projectId, { title: "now-1", priority: "now", createdAt: "2020-01-01T00:00:00.000Z" });
  makeTask(db, projectId, { title: "now-2", priority: "now", createdAt: "2021-01-01T00:00:00.000Z" });

  const { herdr, spawns } = stubHerdr();
  await dispatchOnce(db, { herdr });
  expect(titlesOf(db, spawns)).toEqual(["now-1"]);
  // Never preemption: both agents that were already running are untouched.
  const running = db.query("SELECT state, agent_target FROM tasks WHERE title LIKE 'running-%' ORDER BY title").all() as any[];
  expect(running.map((r) => [r.state, r.agent_target])).toEqual([["in_progress", "a1"], ["in_progress", "a2"]]);
});

test("a non-'now' task never borrows a slot past a full cap", async () => {
  const { db, projectId } = freshDb({ auto_dispatch: true, max_agents: 2 });
  makeTask(db, projectId, { title: "running-1", state: "in_progress", agent_target: "a1" });
  makeTask(db, projectId, { title: "running-2", state: "in_progress", agent_target: "a2" });
  makeTask(db, projectId, { title: "next", priority: "next" });

  const { herdr, spawns } = stubHerdr();
  await dispatchOnce(db, { herdr });
  expect(spawns).toEqual([]);
});

test("the borrowed slot frees up once the borrowing now-task is no longer in flight", async () => {
  const { db, projectId } = freshDb({ auto_dispatch: true, max_agents: 2 });
  makeTask(db, projectId, { title: "running-1", state: "in_progress", agent_target: "a1" });
  makeTask(db, projectId, { title: "running-2", state: "in_progress", agent_target: "a2" });
  const first = makeTask(db, projectId, { title: "now-1", priority: "now", createdAt: "2020-01-01T00:00:00.000Z" });
  makeTask(db, projectId, { title: "now-2", priority: "now", createdAt: "2021-01-01T00:00:00.000Z" });

  const { herdr, spawns } = stubHerdr();
  await dispatchOnce(db, { herdr });
  expect(titlesOf(db, spawns)).toEqual(["now-1"]);

  // The borrower hands off to review, so it stops counting as working — the one
  // borrowed slot is free again for the next now-task.
  transition(db, first, "in_review", { source: "agent", reason: "test handoff" });
  await dispatchOnce(db, { herdr });
  expect(titlesOf(db, spawns)).toEqual(["now-1", "now-2"]);
});

test("a project's borrowed slot does not spend another project's", async () => {
  const cfg = { auto_dispatch: true, max_agents: 2 };
  const { db, projectId } = freshDb(cfg);
  const other = newId("proj");
  db.query("INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)")
    .run(other, "p2", "/repo2", JSON.stringify(cfg), now());
  for (const [pid, tag] of [[projectId, "a"], [other, "b"]] as const) {
    makeTask(db, pid, { title: `running-${tag}1`, state: "in_progress", agent_target: `${tag}1` });
    makeTask(db, pid, { title: `running-${tag}2`, state: "in_progress", agent_target: `${tag}2` });
    makeTask(db, pid, { title: `now-${tag}`, priority: "now" });
  }

  const { herdr, spawns } = stubHerdr();
  await dispatchOnce(db, { herdr });
  expect(titlesOf(db, spawns).sort()).toEqual(["now-a", "now-b"]);
});

// ------------------------------------------------------- land queue

test("land order: priority breaks the tie, dependencies still win", async () => {
  // b depends on a, so a lands first no matter what priority says. c is
  // independent and 'now', so it goes into the first batch too.
  const { db, projectId } = freshDb();
  const a = makeTask(db, projectId, { title: "a", state: "in_review", branch: "a", priority: "later" });
  const bId = newId();
  const t = now();
  db.query(
    `INSERT INTO tasks (id, project_id, title, brief, state, kind, branch, ci_status, depends_on, priority, created_at, updated_at)
     VALUES (?,?,?,'', 'in_review','ship',?, 'passing', ?, ?, ?, ?)`
  ).run(bId, projectId, "b", "b", JSON.stringify([a]), "now", t, t);
  markLand(db, [a, bId], true);

  const calls: string[] = [];
  const merge = async (id: string) => {
    calls.push(id);
    transition(db, id, "verifying", { source: "director", reason: "test merge" });
    return { ok: true };
  };
  await landOnce(db, { exec: async () => OK(""), merge });
  expect(titlesOf(db, calls)).toEqual(["a", "b"]); // depends beats priority
});

test("land order: a 'now' PR goes first among ready, unconflicting PRs", async () => {
  const { db, projectId } = freshDb();
  const first = makeTask(db, projectId, { title: "old-normal", state: "in_review", branch: "a" });
  const second = makeTask(db, projectId, { title: "new-now", state: "in_review", branch: "b", priority: "now" });
  markLand(db, [first, second], true);

  const calls: string[] = [];
  const merge = async (id: string) => {
    calls.push(id);
    transition(db, id, "verifying", { source: "director", reason: "test merge" });
    return { ok: true };
  };
  // No shared files, so both land in the same batch — but the 'now' PR is the
  // one hive reaches for first.
  await landOnce(db, { exec: async () => OK(""), merge });
  expect(titlesOf(db, calls)).toEqual(["new-now", "old-normal"]);
});

test("land order: priority picks the winner of a conflicting pair, and only one lands per sweep", async () => {
  // Both branches touch src/shared.ts, so exactly one may land per sweep. The
  // lower task number would normally win; 'now' flips it — and the loser must
  // still be held back, not landed alongside.
  const { db, projectId } = freshDb();
  const lowNumber = makeTask(db, projectId, { title: "low-normal", state: "in_review", branch: "a" });
  const highNow = makeTask(db, projectId, { title: "high-now", state: "in_review", branch: "b", priority: "now" });
  markLand(db, [lowNumber, highNow], true);

  const exec: Exec = async (argv) => {
    const branch = String(argv[argv.length - 1]).split("...")[1] ?? "";
    return OK(branch ? "src/shared.ts" : "");
  };
  const calls: string[] = [];
  const merge = async (id: string) => {
    calls.push(id);
    transition(db, id, "verifying", { source: "director", reason: "test merge" });
    return { ok: true };
  };
  await landOnce(db, { exec, merge });
  expect(titlesOf(db, calls)).toEqual(["high-now"]);

  // Next sweep, the conflict is gone (the winner has left review) and the other
  // one lands.
  await landOnce(db, { exec, merge });
  expect(titlesOf(db, calls)).toEqual(["high-now", "low-normal"]);
});

// ------------------------------------------------------- API validation

test("create/update accept a valid priority and reject anything else", async () => {
  const { db, projectId } = freshDb();
  const server = Bun.serve({ port: 0, fetch: makeHandler(db) });
  const BASE = `http://127.0.0.1:${server.port}`;
  const post = (path: string, body: unknown) =>
    fetch(BASE + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const put = (path: string, body: unknown) =>
    fetch(BASE + path, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  try {
    const created = await post("/api/tasks", { project_id: projectId, title: "t", priority: "now" });
    expect(created.status).toBe(201);
    expect(((await created.json()) as any).priority).toBe("now");

    // Omitted on create means 'normal', and the value rides on GET.
    const plain = (await (await post("/api/tasks", { project_id: projectId, title: "t2" })).json()) as any;
    expect(plain.priority).toBe("normal");
    expect(((await (await fetch(`${BASE}/api/tasks/${plain.id}`)).json()) as any).priority).toBe("normal");

    const bad = await post("/api/tasks", { project_id: projectId, title: "t3", priority: "urgent" });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as any).error).toMatch(/invalid priority/);

    const bumped = (await (await put(`/api/tasks/${plain.id}`, { priority: "later" })).json()) as any;
    expect(bumped.priority).toBe("later");

    const badUpdate = await put(`/api/tasks/${plain.id}`, { priority: "" });
    expect(badUpdate.status).toBe(400);
    // A rejected update leaves the stored value alone.
    expect((db.query("SELECT priority FROM tasks WHERE id = ?").get(plain.id) as any).priority).toBe("later");

    // Omitting priority on an update leaves it alone.
    const renamed = (await (await put(`/api/tasks/${plain.id}`, { title: "renamed" })).json()) as any;
    expect(renamed.priority).toBe("later");
  } finally {
    server.stop(true);
  }
});
