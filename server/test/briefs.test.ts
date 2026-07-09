import { test, expect } from "bun:test";
import { openDb, newId, now, type DB } from "../src/db.ts";
import { composeBrief } from "../src/briefs.ts";

function setup(): { db: DB; projectId: string; taskId: string } {
  const db = openDb(":memory:");
  const projectId = newId("proj");
  db.query("INSERT INTO projects (id, name, created_at) VALUES (?,?,?)").run(projectId, "p", now());
  const taskId = newId();
  const t = now();
  db.query(
    "INSERT INTO tasks (id, project_id, title, brief, state, kind, created_at, updated_at) VALUES (?,?,?,?, 'queued', 'ship', ?, ?)"
  ).run(taskId, projectId, "Do the thing", "Detailed description here.", t, t);
  return { db, projectId, taskId };
}

function addPolicy(db: DB, scope: string, title: string, body: string, active = 1) {
  db.query(
    "INSERT INTO policies (id, scope, title, body, active, created_at, updated_at) VALUES (?,?,?,?,?,?,?)"
  ).run(newId("pol"), scope, title, body, active, now(), now());
}

test("brief includes task, DoD, emit protocol, and active policies", () => {
  const { db, projectId, taskId } = setup();
  addPolicy(db, "global", "No em-dashes", "Use commas.");
  addPolicy(db, `project:${projectId}`, "Deploy safety", "Prod needs a decision card.");
  addPolicy(db, "global", "Inactive one", "Should not appear.", 0);

  const brief = composeBrief(db, taskId);
  expect(brief).toContain("Do the thing");
  expect(brief).toContain("Detailed description here.");
  expect(brief).toContain("Definition of done");
  expect(brief).toContain("hive emit");
  expect(brief).toContain("No em-dashes");
  expect(brief).toContain("Deploy safety");
  expect(brief).not.toContain("Should not appear.");
});

test("scout brief has a report-based definition of done", () => {
  const { db, taskId } = setup();
  db.query("UPDATE tasks SET kind = 'scout' WHERE id = ?").run(taskId);
  expect(composeBrief(db, taskId)).toContain("report");
});
