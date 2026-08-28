import { expect, test } from "bun:test";
import { openDb, newId } from "../src/db.ts";
import { SELF_AUDIT_CADENCE_MS, selfAuditOnce } from "../src/selfAudit.ts";

function project(db: ReturnType<typeof openDb>, name: string, archived = false): string {
  const id = newId("proj");
  db.query("INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)").run(
    id,
    name,
    "/repo",
    JSON.stringify({ archived }),
    "2026-01-01T00:00:00.000Z"
  );
  return id;
}

test("weekly self-audit creates one bounded ship task for Hive", () => {
  const db = openDb(":memory:");
  project(db, "other");
  const hive = project(db, "Hive");
  const now = Date.parse("2026-08-28T12:00:00.000Z");

  const id = selfAuditOnce(db, now)!;
  const task = db.query("SELECT * FROM tasks WHERE id = ?").get(id) as any;
  expect(task.project_id).toBe(hive);
  expect(task.state).toBe("queued");
  expect(task.kind).toBe("ship");
  expect(task.source).toBe("self-audit");
  expect(task.priority).toBe("next");
  expect(task.brief).toContain("last 7 days");
  expect(task.brief).toContain("at most one measured improvement");
  expect(task.brief).toContain("normal PR, review, CI, and merge controls");
  expect(selfAuditOnce(db, now + SELF_AUDIT_CADENCE_MS * 2)).toBeNull();
});

test("weekly self-audit waits seven days after the latest finished audit", () => {
  const db = openDb(":memory:");
  project(db, "hive");
  const now = Date.parse("2026-08-28T12:00:00.000Z");
  const first = selfAuditOnce(db, now)!;
  db.query("UPDATE tasks SET state = 'done' WHERE id = ?").run(first);

  expect(selfAuditOnce(db, now + SELF_AUDIT_CADENCE_MS - 1)).toBeNull();
  expect(selfAuditOnce(db, now + SELF_AUDIT_CADENCE_MS)).not.toBeNull();
});
