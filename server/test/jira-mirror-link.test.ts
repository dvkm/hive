// HIVE-546: the stored link from a work task to the Jira mirror it implements,
// and the mirror advancing when that work is done.
// HIVE-562: the mirror also follows the work WHILE it is in flight, so a ticket
// says In Progress / In Review instead of To Do until the very end.
import { test, expect, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "hive-mirror-link-"));
process.env.HIVE_HOME = HOME;

const { openDb, now, newId } = await import("../src/db.ts");
const { makeHandler, requeueTask } = await import("../src/api.ts");
const { getTask, transition, advanceReadyJiraMirrors } = await import("../src/state.ts");

const db = openDb(":memory:");
// Call the handler directly instead of standing up a real HTTP server. Bun
// 1.3.14's global fetch pool keeps sockets alive past the server they belong
// to, and the OS hands those ephemeral ports straight back to the next
// `Bun.serve({ port: 0 })`, so a request can go out on a socket belonging to a
// dead server. No socket, no port, no pool, no flake.
const handler = makeHandler(db);

let projectId = "";

async function post(path: string, body: unknown) {
  const res = await handler(new Request("http://127.0.0.1" + path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }));
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

function mirrorStateChanges(id: string): number {
  return (db.query("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = 'state_change'").get(id) as { n: number }).n;
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

test("the mirror follows the work at every step, not just the end", async () => {
  const m = mirror("WEB-100");
  const { json } = await post("/api/tasks", { project_id: projectId, title: "[WEB-100] the work" });
  const id = json.id;
  expect(getTask(db, m).state).toBe("queued");

  transition(db, id, "in_progress", { source: "director" });
  expect(getTask(db, m).state).toBe("in_progress");

  db.query("INSERT INTO evidence (id, task_id, ts, kind, meta) VALUES (?,?,?,?, '{}')").run(newId(), id, now(), "log");
  transition(db, id, "in_review", { source: "director", skipVerification: true });
  expect(getTask(db, m).state).toBe("in_review");

  // in_review -> verifying is the same Jira column ("In Review"), so the mirror
  // must not move again and hand the sync a redundant transition to push.
  const before = mirrorStateChanges(m);
  transition(db, id, "verifying", { source: "director" });
  expect(getTask(db, m).state).toBe("in_review");
  expect(mirrorStateChanges(m)).toBe(before);

  // HIVE-604: the ticket stops at verifying too. A child reaching done means the
  // director accepted that child, not that they looked at the ticket.
  transition(db, id, "done", { source: "director" });
  expect(getTask(db, m).state).toBe("verifying");
});

test("a mirror with no live children is left where it is", async () => {
  // A ticket the director parked in In Review, whose only child was cancelled.
  const m = mirror("WEB-101", "in_review");
  const id = (await post("/api/tasks", { project_id: projectId, title: "[WEB-101] dropped" })).json.id;
  transition(db, id, "cancelled", { source: "director" });
  expect(getTask(db, m).state).toBe("in_review");
});

test("a new child never drags the ticket backwards", async () => {
  // The director moved WEB-102 to In Review by hand; a straggler child starting
  // must not pull the column back to In Progress.
  const m = mirror("WEB-102", "in_review");
  const id = (await post("/api/tasks", { project_id: projectId, title: "[WEB-102] straggler" })).json.id;
  transition(db, id, "in_progress", { source: "director" });
  expect(getTask(db, m).state).toBe("in_review");
});

test("a mirror with several work children waits for all of them", async () => {
  const m = mirror("WEB-23");
  const a = (await post("/api/tasks", { project_id: projectId, title: "[WEB-23] part one" })).json.id;
  const b = (await post("/api/tasks", { project_id: projectId, title: "[WEB-23] part two" })).json.id;
  const c = (await post("/api/tasks", { project_id: projectId, title: "[WEB-23] part three" })).json.id;
  finish(a);
  // One child done is not the ticket done — but the ticket has clearly been
  // worked, so it shows the furthest point the work reached.
  expect(getTask(db, m).state).toBe("in_review");
  // A cancelled sibling does not hold the ticket open.
  transition(db, c, "cancelled", { source: "director" });
  expect(getTask(db, m).state).toBe("in_review");
  finish(b);
  expect(getTask(db, m).state).toBe("verifying");
});

test("the link survives a requeue, and the failed attempt does not close the ticket", async () => {
  const m = mirror("WEB-110");
  const first = (await post("/api/tasks", { project_id: projectId, title: "[WEB-110] tracker arrows" })).json.id;
  transition(db, first, "in_progress", { source: "director" });
  expect(getTask(db, m).state).toBe("in_progress");
  transition(db, first, "failed", { source: "director", reason: "agent died" });
  // Still In Progress, not Done: the attempt died, the ticket did not finish.
  expect(getTask(db, m).state).toBe("in_progress");

  const second = requeueTask(db, getTask(db, first));
  expect(getTask(db, second).jira_mirror_task_id).toBe(m);
  finish(second);
  expect(getTask(db, m).state).toBe("verifying");
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
  expect(getTask(db, m).state).toBe("verifying");
  expect(advanceReadyJiraMirrors(db)).toBe(0); // idempotent
});

// HIVE-550: adding the missing '[KEY] ' prefix by hand is how a human repairs a
// work task filed unlinked, so the mirror is re-resolved on update too.
test("retitling a task with a [KEY] prefix forms the link", async () => {
  const m = mirror("WEB-119");
  const { json: created } = await post("/api/tasks", { project_id: projectId, title: "free-article reads ignore the cap" });
  expect(created.jira_mirror_task_id).toBe(null);

  const res = await handler(new Request("http://127.0.0.1" + `/api/tasks/${created.id}`, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "[WEB-119] free-article reads ignore the cap" }),
  }));
  const updated = await res.json();
  expect(updated.jira_mirror_task_id).toBe(m);
  expect(updated.jira_mirror_relinked).toEqual({ from: null, to: m });

  // Moving an existing link to another ticket is reported, not silent.
  const m2 = mirror("WEB-120");
  const moved = await (await handler(new Request("http://127.0.0.1" + `/api/tasks/${created.id}`, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "[WEB-120] free-article reads ignore the cap" }),
  }))).json();
  expect(moved.jira_mirror_task_id).toBe(m2);
  expect(moved.jira_mirror_relinked).toEqual({ from: m, to: m2 });

  // A retitle that drops the prefix keeps the link rather than clearing it.
  const stripped = await (await handler(new Request("http://127.0.0.1" + `/api/tasks/${created.id}`, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "free-article reads ignore the cap" }),
  }))).json();
  expect(stripped.jira_mirror_task_id).toBe(m2);
  expect(stripped.jira_mirror_relinked).toBeUndefined();
});

// The live corebeat shape: the title already carries the prefix but the row is
// unlinked (it was retitled before this fix), so any edit heals it.
test("an unlinked task that already carries the prefix heals on the next edit", async () => {
  const m = mirror("WEB-121");
  const id = newId();
  db.query(
    `INSERT INTO tasks (id, project_id, title, state, kind, created_at, updated_at)
     VALUES (?,?,?, 'queued', 'ship', ?, ?)`
  ).run(id, projectId, "[WEB-121] reads ignore the cap", now(), now());

  const healed = await (await handler(new Request("http://127.0.0.1" + `/api/tasks/${id}`, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ brief: "unchanged title, brief edit only" }),
  }))).json();
  expect(healed.jira_mirror_task_id).toBe(m);
  expect(healed.jira_mirror_relinked).toEqual({ from: null, to: m });
});

// HIVE-604: hive never closes a Jira mirror on its own either. The mirror is
// routed through transition(), so the director-only rule on `done` covers it.
test("hive cannot close a mirror; the director can", async () => {
  const m = mirror("WEB-130");
  const id = (await post("/api/tasks", { project_id: projectId, title: "[WEB-130] the only child" })).json.id;
  finish(id);
  expect(getTask(db, m).state).toBe("verifying");

  expect(() => transition(db, m, "done", { source: "reconciler" })).toThrow(/only the director/);
  expect(() => transition(db, m, "done", { source: "agent", force: true })).toThrow(/only the director/);
  expect(getTask(db, m).state).toBe("verifying");

  transition(db, m, "done", { source: "director" });
  expect(getTask(db, m).state).toBe("done");
});
