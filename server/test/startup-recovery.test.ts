// Requeue provenance repair (hive-305): a source='requeue' task row is only
// ever recovery lineage worth trusting if it carries the 'created' event that
// requeueTask() itself writes (api.ts). A row without one — hand-inserted,
// migrated from a legacy DB, or otherwise disconnected from its claimed
// parent — must be quarantined so nothing downstream follows it.
import { test, expect } from "bun:test";
import { openDb, newId, now } from "../src/db.ts";
import type { DB } from "../src/db.ts";
import { getTask, writeEvent, verifyRequeueProvenance, repairRequeueProvenance } from "../src/state.ts";

function freshDb(): { db: DB; projectId: string } {
  const db = openDb(":memory:");
  const projectId = newId("proj");
  db.query("INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)")
    .run(projectId, "p", "/repo", "{}", now());
  return { db, projectId };
}

function makeTask(
  db: DB,
  projectId: string,
  extra: Partial<{ source: string; parent: string; state: string }> = {}
): string {
  const id = newId();
  const t = now();
  db.query(
    "INSERT INTO tasks (id, project_id, title, brief, state, kind, source, parent_task_id, created_at, updated_at) VALUES (?,?,?,?,?, 'ship', ?, ?, ?, ?)"
  ).run(id, projectId, "t", "do it", extra.state ?? "queued", extra.source ?? null, extra.parent ?? null, t, t);
  return id;
}

// The one legitimate creation trail: what requeueTask() itself writes.
function trustedCreation(db: DB, taskId: string, parentId: string): void {
  writeEvent(db, { task_id: taskId, source: "reconciler", type: "created", payload: { title: "t", requeue_of: parentId } });
}

test("trusted: a requeue with its own creation event is verified, not quarantined", () => {
  const { db, projectId } = freshDb();
  const parent = makeTask(db, projectId, { state: "failed" });
  const child = makeTask(db, projectId, { source: "requeue", parent });
  trustedCreation(db, child, parent);

  const n = repairRequeueProvenance(db);

  expect(n).toBe(0);
  const task = getTask(db, child);
  expect(task.source).toBe("requeue");
  expect(task.parent_task_id).toBe(parent);
  expect(Boolean(task.requeue_provenance_verified)).toBe(true);
});

test("invalid: a requeue row without a trusted creation event is quarantined", () => {
  const { db, projectId } = freshDb();
  const parent = makeTask(db, projectId, { state: "failed" });
  // A row-only requeue: the DB row exists (as if inserted directly, or
  // carried over from a legacy DB) but never went through requeueTask().
  const child = makeTask(db, projectId, { source: "requeue", parent });

  const n = repairRequeueProvenance(db);

  expect(n).toBe(1);
  const task = getTask(db, child);
  expect(task.source).toBe("requeue_quarantined");
  expect(task.parent_task_id).toBeNull();
  expect(Boolean(task.requeue_provenance_verified)).toBe(true);
  const rejected = db.query("SELECT 1 FROM events WHERE task_id = ? AND type = 'requeue_provenance_rejected'").get(child);
  expect(rejected).toBeTruthy();
});

test("invalid: a requeue whose claimed parent belongs to a different project is quarantined", () => {
  const { db, projectId } = freshDb();
  const otherProjectId = newId("proj");
  db.query("INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)")
    .run(otherProjectId, "other", "/other", "{}", now());
  const foreignParent = makeTask(db, otherProjectId, { state: "failed" });
  const child = makeTask(db, projectId, { source: "requeue", parent: foreignParent });
  trustedCreation(db, child, foreignParent);

  repairRequeueProvenance(db);

  expect(getTask(db, child).source).toBe("requeue_quarantined");
});

test("interrupted: re-running repair after a partial pass never re-checks an already-verified row", () => {
  const { db, projectId } = freshDb();
  const parent = makeTask(db, projectId, { state: "failed" });
  const child = makeTask(db, projectId, { source: "requeue", parent });
  trustedCreation(db, child, parent);

  repairRequeueProvenance(db); // simulates the pass before an interrupting restart
  const rowsScannedAfterFirstPass = db
    .query("SELECT id FROM tasks INDEXED BY idx_tasks_unverified_requeue WHERE source = 'requeue' AND requeue_provenance_verified = 0")
    .all();
  expect(rowsScannedAfterFirstPass.length).toBe(0);

  const n = repairRequeueProvenance(db); // restart resumes; nothing left to check

  expect(n).toBe(0);
  expect(getTask(db, child).source).toBe("requeue");
});

test("repeated: running the startup sweep twice quarantines a bad row exactly once", () => {
  const { db, projectId } = freshDb();
  const parent = makeTask(db, projectId, { state: "failed" });
  const child = makeTask(db, projectId, { source: "requeue", parent });

  const first = repairRequeueProvenance(db);
  const second = repairRequeueProvenance(db);

  expect(first).toBe(1);
  expect(second).toBe(0); // already quarantined (source no longer 'requeue') — not rescanned
  const rejections = db.query("SELECT * FROM events WHERE task_id = ? AND type = 'requeue_provenance_rejected'").all(child);
  expect(rejections.length).toBe(1);
});

test("fails closed: a row whose provenance check throws is left unverified, not trusted", () => {
  const { db, projectId } = freshDb();
  const parent = makeTask(db, projectId, { state: "failed" });
  const child = makeTask(db, projectId, { source: "requeue", parent });
  trustedCreation(db, child, parent);

  // Simulate the creation-event lookup being unavailable (e.g. a locked/corrupt
  // DB) for exactly this task's provenance check.
  const realQuery = db.query.bind(db);
  db.query = ((sql: string) => {
    if (sql.includes("type = 'created'")) throw new Error("database is locked");
    return realQuery(sql);
  }) as typeof db.query;

  let threw = false;
  try {
    repairRequeueProvenance(db);
  } catch {
    threw = true;
  } finally {
    db.query = realQuery;
  }

  expect(threw).toBe(false); // one bad row must not crash the whole sweep
  const task = getTask(db, child);
  expect(task.source).toBe("requeue"); // neither verified nor quarantined — left pending
  expect(Boolean(task.requeue_provenance_verified)).toBe(false);

  // A later cycle, once discovery works again, still resolves it correctly.
  repairRequeueProvenance(db);
  expect(getTask(db, child).source).toBe("requeue");
  expect(Boolean(getTask(db, child).requeue_provenance_verified)).toBe(true);
});

test("verifyRequeueProvenance leaves non-requeue tasks untouched", () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId, { state: "queued" });
  const task = getTask(db, id);

  const result = verifyRequeueProvenance(db, task);

  expect(result).toEqual(task);
  expect(getTask(db, id).source).toBeNull();
});
