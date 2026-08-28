import { test, expect } from "bun:test";
import { openDb, newId, now, type DB } from "../src/db.ts";
import { archiveOrphanedDialogCards } from "../src/reconciler.ts";
import { createDecision } from "../src/api.ts";

function freshDb(): { db: DB; projectId: string } {
  const db = openDb(":memory:");
  const projectId = newId("proj");
  db.query("INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)").run(
    projectId, "p", "/repo", "{}", now()
  );
  return { db, projectId };
}
function makeTask(db: DB, projectId: string, extra: Record<string, any> = {}): string {
  const id = newId();
  const t = now();
  db.query(
    "INSERT INTO tasks (id, project_id, title, state, kind, agent_target, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)"
  ).run(id, projectId, "t", extra.state ?? "needs_decision", "ship", extra.agent_target ?? "agent-1", t, t);
  return id;
}
function writeEventAt(db: DB, taskId: string, type: string, ts: string) {
  db.query("INSERT INTO events (id, task_id, ts, source, type, payload) VALUES (?,?,?,?,?,?)").run(
    newId("ev"), taskId, ts, "reconciler", type, "{}"
  );
}

test("a dialog card whose agent is confirmed dead auto-archives", () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId);
  const d = createDecision(db, { task_id: id, title: "Agent blocked on a dialog: overwrite file?", context: "c", options: [] });
  writeEventAt(db, id, "agent_status", now()); // stale event; overwritten below
  db.query("UPDATE events SET payload = ? WHERE task_id = ? AND type = 'agent_status'").run(
    JSON.stringify({ status: "gone" }), id
  );

  expect(archiveOrphanedDialogCards(db)).toBe(1);
  expect((db.query("SELECT status FROM decisions WHERE id = ?").get(d.id) as any).status).toBe("expired");
});

test("a dialog card whose agent is alive stays open", () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId);
  const d = createDecision(db, { task_id: id, title: "Agent blocked on a dialog: run tests?", context: "c", options: [] });

  expect(archiveOrphanedDialogCards(db)).toBe(0);
  expect((db.query("SELECT status FROM decisions WHERE id = ?").get(d.id) as any).status).toBe("open");
});

test("a dialog card whose agent was respawned since the card opened auto-archives", () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId);
  const d = createDecision(db, { task_id: id, title: "Agent blocked on a dialog: delete branch?", context: "c", options: [] });
  const later = new Date(Date.parse(now()) + 1000).toISOString();
  writeEventAt(db, id, "spawned", later);

  expect(archiveOrphanedDialogCards(db)).toBe(1);
  expect((db.query("SELECT status FROM decisions WHERE id = ?").get(d.id) as any).status).toBe("expired");
});

test("a product decision card is never touched by dialog archiving", () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId, { agent_target: null }); // no agent at all
  const d = createDecision(db, { task_id: id, title: "Ship v2 with the new pricing page?", context: "c", options: [] });

  expect(archiveOrphanedDialogCards(db)).toBe(0);
  expect((db.query("SELECT status FROM decisions WHERE id = ?").get(d.id) as any).status).toBe("open");
});
