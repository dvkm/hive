import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

test("overlapping schedulers atomically create one weekly self-audit", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "hive-self-audit-")), "hive.db");
  const db = openDb(path);
  const hive = project(db, "hive");
  const now = Date.parse("2026-08-28T12:00:00.000Z");
  const timestamp = new Date(now).toISOString();
  db.exec("BEGIN IMMEDIATE");
  db.query(
    `INSERT INTO tasks (id, project_id, title, state, kind, source, created_at, updated_at)
     VALUES (?,?,?, 'queued', 'ship', 'self-audit', ?, ?)`
  ).run(newId("tsk"), hive, "first audit", timestamp, timestamp);

  const child = Bun.spawn([process.execPath, "-e", `
    const { openDb } = await import(process.env.AUDIT_DB_MODULE);
    const { selfAuditOnce } = await import(process.env.AUDIT_MODULE);
    const db = openDb(process.env.AUDIT_DB_PATH);
    db.exec("PRAGMA busy_timeout = 2000");
    console.log("ready");
    console.log(JSON.stringify(selfAuditOnce(db, Number(process.env.AUDIT_NOW))));
  `], {
    env: {
      ...process.env,
      AUDIT_DB_MODULE: resolve(import.meta.dir, "../src/db.ts"),
      AUDIT_MODULE: resolve(import.meta.dir, "../src/selfAudit.ts"),
      AUDIT_DB_PATH: path,
      AUDIT_NOW: String(now),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = child.stdout.getReader();
  const first = await reader.read();
  expect(new TextDecoder().decode(first.value)).toContain("ready");
  await Bun.sleep(100);
  db.exec("COMMIT");

  let output = new TextDecoder().decode(first.value);
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    output += new TextDecoder().decode(chunk.value);
  }
  expect(await child.exited).toBe(0);
  expect(output).toContain("null");
  expect(db.query("SELECT COUNT(*) AS n FROM tasks WHERE source = 'self-audit'").get()).toEqual({ n: 1 });
});
