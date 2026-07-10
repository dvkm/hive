import { test, expect } from "bun:test";
import { openDb, newId, now, type DB } from "../src/db.ts";
import { recordSystemLearning, signature } from "../src/learn.ts";

function freshDb(): { db: DB; projectId: string } {
  const db = openDb(":memory:");
  const projectId = newId("proj");
  db.query("INSERT INTO projects (id, name, config, created_at) VALUES (?,?,?,?)").run(
    projectId, "p", "{}", now()
  );
  return { db, projectId };
}

test("signature normalizes ids, paths, and numbers into a stable key", () => {
  const a = signature('agent start failed: No viable candidates found in PATH "/Users/david/projects/hive-live/bin"');
  const b = signature('agent start failed: No viable candidates found in PATH "/opt/other/place/bin"');
  expect(a).toBe(b);
  expect(signature("worktree create failed for task a1b2c3d4e5f6 attempt 3")).toBe(
    signature("worktree create failed for task f6e5d4c3b2a1 attempt 7")
  );
});

test("recordSystemLearning upserts: same title bumps occurrences, new title inserts", () => {
  const { db, projectId } = freshDb();
  recordSystemLearning(db, projectId, "spawn failure: X", "detail 1", null);
  recordSystemLearning(db, projectId, "spawn failure: X", "detail 2", null);
  recordSystemLearning(db, projectId, "merge failure: Y", "detail", null);
  const rows = db
    .query("SELECT title, occurrences, status FROM learnings WHERE project_id = ? ORDER BY title")
    .all(projectId) as any[];
  expect(rows.length).toBe(2);
  expect(rows.find((r) => r.title.startsWith("spawn")).occurrences).toBe(2);
  expect(rows.find((r) => r.title.startsWith("merge")).occurrences).toBe(1);
  // a resolved learning re-activates on recurrence
  db.query("UPDATE learnings SET status = 'resolved' WHERE title = 'spawn failure: X'").run();
  recordSystemLearning(db, projectId, "spawn failure: X", null, null);
  const again: any = db.query("SELECT occurrences, status FROM learnings WHERE title = 'spawn failure: X'").get();
  expect(again.occurrences).toBe(3);
  expect(again.status).toBe("active");
});
