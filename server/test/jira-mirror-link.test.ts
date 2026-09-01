// HIVE-546: the stored link from a work task to the Jira mirror it implements,
// and the mirror advancing when that work is done.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "hive-mirror-link-"));
process.env.HIVE_HOME = HOME;

const { openDb, now, newId } = await import("../src/db.ts");
const { makeHandler, requeueTask } = await import("../src/api.ts");
const { getTask, transition, advanceReadyJiraMirrors } = await import("../src/state.ts");

const db = openDb(":memory:");
const server = Bun.serve({ port: 0, fetch: makeHandler(db) });
const BASE = `http://127.0.0.1:${server.port}`;
afterAll(() => server.stop(true));

let projectId = "";

async function post(path: string, body: unknown) {
  const res = await fetch(BASE + path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any };
}

function mirror(key: string, state = "queued"): string {
  const id = newId();
  db.query(
    `INSERT INTO tasks (id, project_id, title, brief, state, kind, source, source_ref, jira_key, jira_link_kind, created_at, updated_at)
     VALUES (?,?,?,?,?, 'ship', 'external', ?, ?, 'mirror', ?, ?)`
  ).run(id, projectId, `[${key}] ticket`, null, state, `jira:${key}`, key, now(), now());
  return id;
}

// Straight to done, past the evidence gate the real path enforces elsewhere.
function finish(id: string): void {
  db.query("INSERT INTO evidence (id, task_id, ts, kind, meta) VALUES (?,?,?,?, '{}')").run(newId(), id, now(), "log");
  transition(db, id, "in_progress", { source: "director" });
  transition(db, id, "in_review", { source: "director", skipVerification: true });
  transition(db, id, "verifying", { source: "director" });
  transition(db, id, "done", { source: "director" });
}

beforeAll(async () => {
  const p = await post("/api/projects", { name: "mirror-proj", repo_path: "/tmp/x" });
  projectId = p.json.id;
});

test("a work task titled [KEY] stores its mirror at creation", async () => {
  const m = mirror("WEB-99");
  const { json } = await post("/api/tasks", { project_id: projectId, title: "[WEB-99] pricing page" });
  expect(json.jira_mirror_task_id).toBe(m);

  // No mirror for the key, and no prefix at all: both stay unlinked.
  const orphan = await post("/api/tasks", { project_id: projectId, title: "[WEB-404] no mirror" });
  expect(orphan.json.jira_mirror_task_id).toBe(null);
  const plain = await post("/api/tasks", { project_id: projectId, title: "unrelated work" });
  expect(plain.json.jira_mirror_task_id).toBe(null);
});

test("finishing the only work task advances its mirror", async () => {
  const m = mirror("WEB-100");
  const { json } = await post("/api/tasks", { project_id: projectId, title: "[WEB-100] the work" });
  expect(getTask(db, m).state).toBe("queued");
  finish(json.id);
  expect(getTask(db, m).state).toBe("done");
});

test("a mirror with several work children waits for all of them", async () => {
  const m = mirror("WEB-23");
  const a = (await post("/api/tasks", { project_id: projectId, title: "[WEB-23] part one" })).json.id;
  const b = (await post("/api/tasks", { project_id: projectId, title: "[WEB-23] part two" })).json.id;
  const c = (await post("/api/tasks", { project_id: projectId, title: "[WEB-23] part three" })).json.id;
  finish(a);
  expect(getTask(db, m).state).toBe("queued");
  // A cancelled sibling does not hold the ticket open.
  transition(db, c, "cancelled", { source: "director" });
  expect(getTask(db, m).state).toBe("queued");
  finish(b);
  expect(getTask(db, m).state).toBe("done");
});

test("the link survives a requeue, and the failed attempt does not close the ticket", async () => {
  const m = mirror("WEB-110");
  const first = (await post("/api/tasks", { project_id: projectId, title: "[WEB-110] tracker arrows" })).json.id;
  transition(db, first, "in_progress", { source: "director" });
  transition(db, first, "failed", { source: "director", reason: "agent died" });
  expect(getTask(db, m).state).toBe("queued");

  const second = requeueTask(db, getTask(db, first));
  expect(getTask(db, second).jira_mirror_task_id).toBe(m);
  finish(second);
  expect(getTask(db, m).state).toBe("done");
});

test("the catch-up sweep advances mirrors whose work finished unlinked", async () => {
  const m = mirror("WEB-111", "in_review");
  // A row from before the link existed: linked by the migration's backfill rule.
  const id = newId();
  db.query(
    `INSERT INTO tasks (id, project_id, title, state, kind, created_at, updated_at)
     VALUES (?,?,?, 'done', 'ship', ?, ?)`
  ).run(id, projectId, "[WEB-111] allow '-' in numeric fields", now(), now());
  expect(advanceReadyJiraMirrors(db)).toBe(0); // nothing linked yet

  db.query("UPDATE tasks SET jira_mirror_task_id = ? WHERE id = ?").run(m, id);
  expect(advanceReadyJiraMirrors(db)).toBe(1);
  expect(getTask(db, m).state).toBe("done");
  expect(advanceReadyJiraMirrors(db)).toBe(0); // idempotent
});
