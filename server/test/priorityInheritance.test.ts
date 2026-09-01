// Task priority, part 2 (HIVE-429): where a priority comes from when nobody
// states one, and who is allowed to state 'now'.
//
// Three things are under test:
//   1. Inheritance — a requeue keeps the failed original's priority, a
//      follow-up defaults to its parent's, and the root-cause scout filed on a
//      repeatedly failing lineage keeps that lineage's.
//   2. Source defaults — a monitor auto-task starts at 'next', so does a
//      security-shaped brief; watcher and Jira-imported tasks stay 'normal'.
//   3. Authority — only the director may set 'now'.
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HIVE_HOME = mkdtempSync(join(tmpdir(), "hive-priority-inherit-"));

const { openDb, newId, now } = await import("../src/db.ts");
import type { DB } from "../src/db.ts";
const { makeHandler, requeueTask, openRecoveryDecision } = await import("../src/api.ts");
const { getTask } = await import("../src/state.ts");
const { checkProjectMonitors } = await import("../src/monitors.ts");

function freshDb(config: any = {}): { db: DB; projectId: string } {
  const db = openDb(":memory:");
  const projectId = newId("proj");
  db.query("INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)")
    .run(projectId, "p", "/repo", JSON.stringify(config), now());
  return { db, projectId };
}

function makeTask(
  db: DB,
  projectId: string,
  extra: { title?: string; priority?: string; state?: string; source?: string; parent?: string } = {}
): string {
  const id = newId();
  const t = now();
  db.query(
    `INSERT INTO tasks (id, project_id, title, brief, state, kind, source, parent_task_id, priority, created_at, updated_at)
     VALUES (?,?,?,?,?,'ship',?,?,?,?,?)`
  ).run(
    id, projectId, extra.title ?? "t", "", extra.state ?? "failed",
    extra.source ?? null, extra.parent ?? null, extra.priority ?? "normal", t, t
  );
  return id;
}

const priorityOf = (db: DB, id: string) =>
  (db.query("SELECT priority FROM tasks WHERE id = ?").get(id) as any).priority;

// Call the handler directly instead of standing up a real HTTP server (see
// thinBriefVsMirror.test.ts for why: a live socket can outlive its server).
function makeApi(db: DB) {
  const handler = makeHandler(db);
  return {
    post: (path: string, body: unknown) =>
      handler(new Request("http://127.0.0.1" + path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })),
    put: (path: string, body: unknown) =>
      handler(new Request("http://127.0.0.1" + path, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })),
  };
}

// ------------------------------------------------------- inheritance

test("a requeue carries the failed original's priority to its successor", () => {
  const { db, projectId } = freshDb();
  const original = makeTask(db, projectId, { priority: "now" });
  const successor = requeueTask(db, getTask(db, original));
  expect(priorityOf(db, successor)).toBe("now");
});

test("a requeue of a plain task stays 'normal'", () => {
  const { db, projectId } = freshDb();
  const original = makeTask(db, projectId);
  expect(priorityOf(db, requeueTask(db, getTask(db, original)))).toBe("normal");
});

test("the root-cause scout inherits the failing lineage's priority", () => {
  const { db, projectId } = freshDb();
  // Two failures in one lineage: the original, then its requeued successor.
  // The second park is what earns a scout.
  const original = makeTask(db, projectId, { priority: "next" });
  const successor = requeueTask(db, getTask(db, original));
  openRecoveryDecision(db, getTask(db, successor), 2);

  const scout = db
    .query("SELECT id, priority, kind FROM tasks WHERE kind = 'scout'")
    .all() as { id: string; priority: string }[];
  expect(scout).toHaveLength(1);
  expect(scout[0].priority).toBe("next");
});

test("a follow-up task defaults to its parent's priority, and an explicit value still wins", async () => {
  const { db, projectId } = freshDb();
  const parent = makeTask(db, projectId, { priority: "next", state: "in_progress" });
  const { post } = makeApi(db);
  const child = (await (await post("/api/tasks", {
    project_id: projectId, title: "follow-up", parent_task_id: parent,
  })).json()) as any;
  expect(child.priority).toBe("next");

  // Explicit beats inherited — including downwards.
  const pinned = (await (await post("/api/tasks", {
    project_id: projectId, title: "follow-up 2", parent_task_id: parent, priority: "later",
  })).json()) as any;
  expect(pinned.priority).toBe("later");
});

// ------------------------------------------------------- source defaults

test("a monitor auto-task arrives at 'next'", async () => {
  const { db, projectId } = freshDb();
  const project = { id: projectId, config: { monitors: [{ name: "api", url: "http://x/health" }], monitors_auto_task: true } };
  await checkProjectMonitors(db, project, { fetch: async () => ({ status: 500, body: "" }), notify: false });

  const rows = db.query("SELECT title, priority FROM tasks").all() as { title: string; priority: string }[];
  expect(rows).toHaveLength(1);
  expect(rows[0].title).toBe("Monitor down: api");
  expect(rows[0].priority).toBe("next");
});

test("a security-shaped brief starts at 'next', ordinary wording stays 'normal'", async () => {
  const { db, projectId } = freshDb();
  const { post } = makeApi(db);
  const priorityFor = async (title: string, brief?: string) =>
    ((await (await post("/api/tasks", { project_id: projectId, title, brief })).json()) as any).priority;
  expect(await priorityFor("Rotate the deploy token")).toBe("next");
  expect(await priorityFor("Tidy the header", "The password reset link expires too early")).toBe("next");
  // Whole words only: "author" and "authority" are not "auth".
  expect(await priorityFor("Show the commit author in the sidebar")).toBe("normal");
  expect(await priorityFor("Rename the standing authority panel")).toBe("normal");
  // Nothing here ever reaches 'now'.
  expect(await priorityFor("Fix the billing page auth redirect")).toBe("next");
});

test("watcher and Jira-imported tasks stay at the default 'normal'", () => {
  // Both write their rows directly and name no priority, so the schema default
  // is the whole contract. This asserts it stays that way.
  const { db, projectId } = freshDb();
  const watch = newId();
  const mirror = newId();
  const t = now();
  db.query(
    `INSERT INTO tasks (id, project_id, title, brief, state, kind, source, source_ref, created_at, updated_at)
     VALUES (?,?,?,?, 'queued', 'ship', 'watch', ?, ?, ?)`
  ).run(watch, projectId, 'watch: "docs" changed', "", `watch:${projectId}:docs:1`, t, t);
  db.query(
    `INSERT INTO tasks (id, project_id, title, brief, state, kind, source, source_ref, jira_key, jira_link_kind, created_at, updated_at)
     VALUES (?,?,?,?, 'queued', 'ship', 'external', ?, ?, 'mirror', ?, ?)`
  ).run(mirror, projectId, "WEB-1 something", "", "jira:WEB-1", "WEB-1", t, t);

  expect(priorityOf(db, watch)).toBe("normal");
  expect(priorityOf(db, mirror)).toBe("normal");
});

// ------------------------------------------------------- authority

test("only the director may set 'now'", async () => {
  const { db, projectId } = freshDb();
  const { post, put } = makeApi(db);
  // The web UI and the CLI send no source at all.
  expect((await post("/api/tasks", { project_id: projectId, title: "director now", priority: "now" })).status).toBe(201);
  // ...and "director" spelled out is the same thing.
  expect((await post("/api/tasks", { project_id: projectId, title: "d2", priority: "now", source: "director" })).status).toBe(201);

  for (const source of ["agent", "chat_supervisor"]) {
    const denied = await post("/api/tasks", { project_id: projectId, title: `${source} now`, priority: "now", source });
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as any).error).toMatch(/only the director may set priority 'now'/);
    // Nothing was created.
    expect(db.query("SELECT COUNT(*) c FROM tasks WHERE title = ?").get(`${source} now`) as any).toMatchObject({ c: 0 });

    // 'next' and below are open to everyone.
    const allowed = await post("/api/tasks", { project_id: projectId, title: `${source} next`, priority: "next", source });
    expect(allowed.status).toBe(201);
    expect(((await allowed.json()) as any).priority).toBe("next");
  }

  // The same rule on the update path, and a refused update changes nothing.
  const task = (await (await post("/api/tasks", { project_id: projectId, title: "later on" , priority: "later" })).json()) as any;
  const deniedPut = await put(`/api/tasks/${task.id}`, { priority: "now", source: "agent" });
  expect(deniedPut.status).toBe(403);
  expect(priorityOf(db, task.id)).toBe("later");
  expect((await put(`/api/tasks/${task.id}`, { priority: "now" })).status).toBe(200);
  expect(priorityOf(db, task.id)).toBe("now");
});

test("an agent's follow-up inherits a 'now' parent without being blocked", async () => {
  // Inheritance is not the agent "setting" the priority: the director already
  // set it on the parent, so the follow-up may keep it.
  const { db, projectId } = freshDb();
  const parent = makeTask(db, projectId, { priority: "now", state: "in_progress" });
  const { post } = makeApi(db);
  const res = await post("/api/tasks", { project_id: projectId, title: "follow-up", parent_task_id: parent, source: "agent" });
  expect(res.status).toBe(201);
  expect(((await res.json()) as any).priority).toBe("now");
});
