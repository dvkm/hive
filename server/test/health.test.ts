import { test, expect } from "bun:test";
import { openDb, newId, now, type DB } from "../src/db.ts";
import { computeHealth, needsAttention } from "../src/health.ts";
import { getTask } from "../src/state.ts";

function freshDb(): { db: DB; projectId: string } {
  const db = openDb(":memory:");
  const projectId = newId("proj");
  db.query("INSERT INTO projects (id, name, config, created_at) VALUES (?,?,?,?)").run(projectId, "p", "{}", now());
  return { db, projectId };
}
function makeTask(db: DB, projectId: string, state = "in_progress", agent: string | null = "a1"): string {
  const id = newId();
  const t = now();
  db.query("INSERT INTO tasks (id, project_id, title, state, kind, agent_target, created_at, updated_at) VALUES (?,?,?,?, 'ship', ?, ?, ?)")
    .run(id, projectId, "t", state, agent, t, t);
  return id;
}
let seq = 0;
function putEvent(db: DB, taskId: string, type: string, payload: any = {}, agoMs = 0): void {
  const ts = new Date(Date.now() - agoMs + seq++).toISOString();
  db.query("INSERT INTO events (id, task_id, ts, source, type, payload) VALUES (?,?,?,?,?,?)")
    .run(newId("evt"), taskId, ts, "herdr", type, JSON.stringify(payload));
}
const STALE = 15 * 60 * 1000;

test("healthy: recent activity, agent alive", () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId);
  putEvent(db, id, "status", { note: "working" });
  const h = computeHealth(db, getTask(db, id));
  expect(h?.status).toBe("healthy");
});

test("silent: no activity past the stale threshold, no stale flag yet", () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId);
  putEvent(db, id, "status", { note: "working" }, 30 * 60 * 1000); // 30m old
  const h = computeHealth(db, getTask(db, id), Date.now());
  expect(h?.status).toBe("silent");
  expect(h?.reason).toBe("no activity");
});

test("stuck: herdr reports the agent blocked", () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId);
  putEvent(db, id, "status", { note: "working" });
  putEvent(db, id, "agent_status", { status: "blocked" });
  const h = computeHealth(db, getTask(db, id));
  expect(h?.status).toBe("stuck");
});

test("stuck: stale-recovery escalation in progress", () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId);
  putEvent(db, id, "status", { note: "working" }, 30 * 60 * 1000);
  putEvent(db, id, "stale", { silent_ms: 999 });
  const h = computeHealth(db, getTask(db, id), Date.now());
  expect(h?.status).toBe("stuck");
});

test("dead: agent gone from herdr", () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId);
  putEvent(db, id, "agent_status", { status: "gone" });
  const h = computeHealth(db, getTask(db, id));
  expect(h?.status).toBe("dead");
  expect(h?.reason).toBe("agent gone from herdr");
});

test("stuck: agent finished (idle) with no PR and no recent activity -> visible in the tray", () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId); // in_progress, no pr_url
  putEvent(db, id, "status", { note: "did the work" }, 30 * 60 * 1000); // 30m old, no PR
  putEvent(db, id, "agent_status", { status: "idle" }, 30 * 60 * 1000);
  const h = computeHealth(db, getTask(db, id), Date.now());
  expect(h?.status).toBe("stuck");
  expect(needsAttention({ state: "in_progress", health: h })).toBe(true);
});

test("needsAttention: failed tasks, or dead/stuck in-progress; not healthy/silent/queued", () => {
  expect(needsAttention({ state: "failed" })).toBe(true);
  expect(needsAttention({ state: "in_progress", health: { status: "dead", reason: null, since: "" } })).toBe(true);
  expect(needsAttention({ state: "in_progress", health: { status: "stuck", reason: null, since: "" } })).toBe(true);
  // silent is surfaced on the card, but not urgent enough for the tray
  expect(needsAttention({ state: "in_progress", health: { status: "silent", reason: null, since: "" } })).toBe(false);
  expect(needsAttention({ state: "in_progress", health: { status: "healthy", reason: null, since: "" } })).toBe(false);
  expect(needsAttention({ state: "queued", health: null })).toBe(false);
  expect(needsAttention({ state: "done", health: null })).toBe(false);
});

test("null health for queued and terminal tasks, and for agentless tasks", () => {
  const { db, projectId } = freshDb();
  expect(computeHealth(db, getTask(db, makeTask(db, projectId, "queued")))).toBeNull();
  expect(computeHealth(db, getTask(db, makeTask(db, projectId, "done")))).toBeNull();
  expect(computeHealth(db, getTask(db, makeTask(db, projectId, "in_progress", null)))).toBeNull();
});

test("needs_decision / in_review are waiting on the director — never silent/stuck by age", () => {
  const { db, projectId } = freshDb();
  for (const state of ["needs_decision", "in_review"]) {
    const id = makeTask(db, projectId, state);
    putEvent(db, id, "status", { note: "handed off" }, 3 * 60 * 60 * 1000); // 3h silent
    putEvent(db, id, "stale", {}, 60 * 60 * 1000);
    const h = computeHealth(db, getTask(db, id), Date.now());
    expect(h?.status).toBe("healthy");
  }
  // but a dead agent still shows dead even while parked
  const id = makeTask(db, projectId, "in_review");
  putEvent(db, id, "agent_status", { status: "gone" });
  expect(computeHealth(db, getTask(db, id), Date.now())?.status).toBe("dead");
});
