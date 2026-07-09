import { test, expect } from "bun:test";
import { openDb, newId, now, type DB } from "../src/db.ts";
import { transition, canTransition, TransitionError, getTask } from "../src/state.ts";

function freshDb(): { db: DB; projectId: string } {
  const db = openDb(":memory:");
  const projectId = newId("proj");
  db.query("INSERT INTO projects (id, name, created_at) VALUES (?,?,?)").run(projectId, "p", now());
  return { db, projectId };
}

function makeTask(db: DB, projectId: string, kind = "ship"): string {
  const id = newId();
  const t = now();
  db.query(
    "INSERT INTO tasks (id, project_id, title, state, kind, created_at, updated_at) VALUES (?,?,?, 'queued', ?, ?, ?)"
  ).run(id, projectId, "t", kind, t, t);
  return id;
}

function addEvidence(db: DB, taskId: string, kind = "screenshot") {
  db.query(
    "INSERT INTO evidence (id, task_id, ts, kind) VALUES (?,?,?,?)"
  ).run(newId("ev"), taskId, now(), kind);
}

test("valid forward transition writes a state_change event", () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId);
  transition(db, id, "in_progress");
  expect(getTask(db, id).state).toBe("in_progress");
  const events = db.query("SELECT * FROM events WHERE task_id = ? AND type = 'state_change'").all(id);
  expect(events.length).toBe(1);
});

test("invalid transition is rejected with a clear error", () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId);
  expect(() => transition(db, id, "done")).toThrow(TransitionError);
  expect(() => transition(db, id, "verifying")).toThrow(/invalid transition/);
});

test("done is rejected without evidence", () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId);
  transition(db, id, "in_progress");
  transition(db, id, "in_review");
  transition(db, id, "verifying");
  expect(() => transition(db, id, "done")).toThrow(/no evidence/);
});

test("done succeeds once evidence exists", () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId);
  transition(db, id, "in_progress");
  transition(db, id, "in_review");
  transition(db, id, "verifying");
  addEvidence(db, id);
  transition(db, id, "done");
  expect(getTask(db, id).state).toBe("done");
});

test("scout requires a report evidence for done", () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId, "scout");
  transition(db, id, "in_progress");
  transition(db, id, "in_review");
  transition(db, id, "verifying");
  addEvidence(db, id, "screenshot"); // not a report
  expect(() => transition(db, id, "done")).toThrow(/scout task requires a report/);
  addEvidence(db, id, "report");
  transition(db, id, "done");
  expect(getTask(db, id).state).toBe("done");
});

test("any non-terminal state can go to failed/cancelled; terminals cannot", () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId);
  expect(canTransition("queued", "failed")).toBe(true);
  expect(canTransition("in_progress", "cancelled")).toBe(true);
  expect(canTransition("done", "failed")).toBe(false);
  transition(db, id, "cancelled", { reason: "nope" });
  expect(getTask(db, id).state).toBe("cancelled");
});

test("a failed task can be re-queued (attention tray), resetting its runtime binding", () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId);
  transition(db, id, "in_progress");
  // bind a runtime agent, then fail it
  db.query("UPDATE tasks SET agent_target = 'a1', worktree_path = '/wt', branch = 'hive/x' WHERE id = ?").run(id);
  transition(db, id, "failed", { reason: "agent vanished" });
  expect(canTransition("failed", "queued")).toBe(true);

  transition(db, id, "queued", { source: "director", reason: "requeued" });
  const t = getTask(db, id);
  expect(t.state).toBe("queued");
  // runtime binding cleared so the next spawn is clean
  expect(t.agent_target).toBeNull();
  expect(t.worktree_path).toBeNull();
  expect(t.branch).toBeNull();
  const ev = db.query("SELECT payload FROM events WHERE task_id = ? AND type = 'state_change' ORDER BY ts DESC LIMIT 1").get(id) as { payload: string };
  expect(JSON.parse(ev.payload)).toMatchObject({ from: "failed", to: "queued", reason: "requeued" });
});

test("needs_decision <-> in_progress round trip", () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId);
  transition(db, id, "in_progress");
  transition(db, id, "needs_decision");
  transition(db, id, "in_progress");
  expect(getTask(db, id).state).toBe("in_progress");
});
