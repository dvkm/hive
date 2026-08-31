// Board-vs-reality audit (HIVE-528): one synthetic divergence of each kind is
// reported exactly once, a clean board says nothing, and the whole pass is
// read-only against tasks/decisions.
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "hive-boardaudit-"));
process.env.HIVE_HOME = HOME;

const { openDb, newId, now } = await import("../src/db.ts");
const { auditBoard, reportBoardAudit } = await import("../src/boardAudit.ts");
import type { DB } from "../src/db.ts";
import type { Exec } from "../src/exec.ts";

// A stub `gh pr view`: every PR reports the given state. `down` stands in for
// gh being missing or failing to run at all.
const gh = (state: string): Exec => async () => ({ code: 0, stdout: JSON.stringify({ state }), stderr: "" });
const ghDown: Exec = async () => ({ code: 127, stdout: "", stderr: "posix_spawn 'gh'" });

function setup(repoPath: string | null = "/repo"): { db: DB; pid: string } {
  const db = openDb(":memory:");
  const pid = newId("proj");
  db.query("INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)").run(
    pid, "p", repoPath, "{}", now()
  );
  return { db, pid };
}

// One task row. `at` lets a test order creation without sleeping.
function task(db: DB, pid: string, fields: Record<string, any> = {}, at = now()): string {
  const id = newId();
  const row = { id, project_id: pid, title: "t", state: "queued", kind: "ship", created_at: at, updated_at: at, ...fields };
  const cols = Object.keys(row);
  db.query(`INSERT INTO tasks (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).run(...cols.map((c) => (row as any)[c]));
  return id;
}

function event(db: DB, taskId: string, type: string, payload: any = {}): void {
  db.query("INSERT INTO events (id, task_id, ts, source, type, payload) VALUES (?,?,?,?,?,?)").run(
    newId("evt"), taskId, now(), "test", type, JSON.stringify(payload)
  );
}

const kinds = (db: DB) => auditBoard(db).map((f) => f.kind).sort();

test("a clean board reports nothing, and reporting it says nothing", async () => {
  const { db, pid } = setup();
  const done = task(db, pid, { state: "done", pr_url: "https://x/1" });
  event(db, done, "merged", {});
  task(db, pid, { state: "queued", title: "ordinary pending work" });

  expect(auditBoard(db)).toEqual([]);
  expect(await reportBoardAudit(db, { exec: gh("MERGED") })).toEqual([]);
  expect(db.query("SELECT COUNT(*) AS n FROM notifications").get()).toEqual({ n: 0 } as any);
  expect(db.query("SELECT COUNT(*) AS n FROM events WHERE type = 'board_audit'").get()).toEqual({ n: 0 } as any);
});

test("merged but not closed: a live mirror over shipped hive work", () => {
  const { db, pid } = setup();
  task(db, pid, { state: "in_progress", title: "[WEB-89] search is broken", jira_key: "WEB-89", jira_link_kind: "mirror", source: "external" });
  task(db, pid, { state: "done", title: "[WEB-89] fix the paid/free sort" });

  expect(kinds(db)).toEqual(["merged_not_closed"]);
});

test("merged but not closed: a bracketed key does not match a longer one", () => {
  const { db, pid } = setup();
  task(db, pid, { state: "in_progress", title: "[WEB-9] a", jira_key: "WEB-9", jira_link_kind: "mirror", source: "external" });
  task(db, pid, { state: "done", title: "[WEB-91] different issue entirely" });

  expect(auditBoard(db)).toEqual([]);
});

test("closed but not merged: GitHub, not hive's own events, gives the verdict", async () => {
  const { db, pid } = setup();
  task(db, pid, { state: "done", pr_url: "https://x/7" });

  // No local merge record, but GitHub says it landed — a human merged it
  // outside hive. Settled, not a finding, and never probed again.
  expect(await reportBoardAudit(db, { exec: gh("MERGED") })).toEqual([]);
  expect(db.query("SELECT COUNT(*) AS n FROM events WHERE type = 'board_audit'").get()).toEqual({ n: 1 } as any);
});

test("closed but not merged: an open PR on a done task is the finding", async () => {
  const { db, pid } = setup();
  task(db, pid, { state: "done", pr_url: "https://x/7" });

  const found = await reportBoardAudit(db, { exec: gh("OPEN") });
  expect(found.map((f) => f.kind)).toEqual(["closed_not_merged"]);
  expect(found[0].note).toContain("OPEN");
});

test("closed but not merged: a broken gh reports nothing and stays retryable", async () => {
  const { db, pid } = setup();
  task(db, pid, { state: "done", pr_url: "https://x/7" });

  expect(await reportBoardAudit(db, { exec: ghDown })).toEqual([]);
  expect(db.query("SELECT COUNT(*) AS n FROM events WHERE type = 'board_audit'").get()).toEqual({ n: 0 } as any);
  // gh comes back: the same candidate is still there to be judged.
  expect((await reportBoardAudit(db, { exec: gh("CLOSED") })).map((f) => f.kind)).toEqual(["closed_not_merged"]);
});

test("closed but not merged: a landing on record is never probed at all", async () => {
  const { db, pid } = setup();
  const id = task(db, pid, { state: "done", pr_url: "https://x/7" });
  event(db, id, "unmergeable", { landing_commit: "abc" });

  expect(await reportBoardAudit(db, { exec: gh("OPEN") })).toEqual([]);
});

test("queued but unrunnable: a tracking-only row nothing will ever dispatch", () => {
  const { db, pid } = setup();
  task(db, pid, { state: "queued", source: "external", source_ref: "jira:WEB-1" });

  expect(kinds(db)).toEqual(["queued_unrunnable"]);
});

test("queued but unrunnable: a project with no repo checked out", () => {
  const { db, pid } = setup(null);
  task(db, pid, { state: "queued" });

  expect(kinds(db)).toEqual(["queued_unrunnable"]);
});

test("orphaned external identity: the key stays on the finished predecessor", () => {
  const { db, pid } = setup();
  const prev = task(db, pid, { state: "failed", jira_key: "CORE-1", jira_link_kind: "subtask" });
  task(db, pid, { state: "in_progress", parent_task_id: prev, source: "requeue" });

  expect(kinds(db)).toEqual(["orphaned_external_key"]);
});

test("orphaned external identity: a successor carrying the key is fine", () => {
  const { db, pid } = setup();
  const prev = task(db, pid, { state: "failed", jira_link_kind: "subtask" });
  task(db, pid, { state: "in_progress", parent_task_id: prev, source: "requeue", jira_key: "CORE-1", jira_link_kind: "subtask" });

  expect(auditBoard(db)).toEqual([]);
});

test("provenance break: failed with no successor, but the same work shipped later", () => {
  const { db, pid } = setup();
  task(db, pid, { state: "failed", title: "port the seat writer" }, "2026-08-01T00:00:00.000Z");
  task(db, pid, { state: "done", title: "port the seat writer" }, "2026-08-02T00:00:00.000Z");

  expect(kinds(db)).toEqual(["provenance_break"]);
});

test("provenance break: a repeated title on unrelated work is not a break", () => {
  const { db, pid } = setup();
  // Same words, different work: a year apart, and a different kind of task.
  task(db, pid, { state: "failed", title: "update dependencies", kind: "ship" }, "2025-08-01T00:00:00.000Z");
  task(db, pid, { state: "done", title: "update dependencies", kind: "chore" }, "2026-08-02T00:00:00.000Z");
  expect(auditBoard(db)).toEqual([]);

  // Same title and kind, but far outside the window a replacement lands in.
  task(db, pid, { state: "failed", title: "tidy the log lines" }, "2026-01-01T00:00:00.000Z");
  task(db, pid, { state: "done", title: "tidy the log lines" }, "2026-06-01T00:00:00.000Z");
  expect(auditBoard(db)).toEqual([]);

  // A shared branch is proof on its own, whatever the titles say.
  task(db, pid, { state: "failed", title: "first attempt", branch: "hive/abc123" }, "2026-01-01T00:00:00.000Z");
  task(db, pid, { state: "done", title: "totally different words", branch: "hive/abc123" }, "2026-06-01T00:00:00.000Z");
  expect(kinds(db)).toEqual(["provenance_break"]);
});

test("provenance break: a failed task with a real successor is not a break", () => {
  const { db, pid } = setup();
  const failed = task(db, pid, { state: "failed", title: "port the seat writer" }, "2026-08-01T00:00:00.000Z");
  task(db, pid, { state: "done", title: "port the seat writer", parent_task_id: failed, source: "requeue" }, "2026-08-02T00:00:00.000Z");

  expect(auditBoard(db)).toEqual([]);
});

test("stuck spawns: past the retry ceiling, and infra failures do not count", () => {
  const { db, pid } = setup();
  const infra = task(db, pid, { state: "queued", title: "daemon was down" });
  for (let i = 0; i < 9; i++) event(db, infra, "spawn_error", { infra: true });
  expect(auditBoard(db)).toEqual([]);

  const stuck = task(db, pid, { state: "queued", title: "broken repo" });
  for (let i = 0; i < 7; i++) event(db, stuck, "spawn_error", { error: "boom" });
  expect(kinds(db)).toEqual(["stuck_spawns"]);
});

test("archived and test projects are out of scope", async () => {
  const { db } = setup();
  for (const config of ['{"archived":true}', '{"test":true}']) {
    const pid = newId("proj");
    db.query("INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)").run(pid, "p", "/repo", config, now());
    task(db, pid, { state: "queued", source: "external", source_ref: `jira:${pid}` });
    task(db, pid, { state: "done", pr_url: "https://x/9" });
  }
  expect(auditBoard(db)).toEqual([]);
  expect(await reportBoardAudit(db, { exec: gh("OPEN") })).toEqual([]);
});

test("every check reports exactly once, then goes quiet", async () => {
  const { db, pid } = setup();
  // One synthetic divergence of each kind, on its own task.
  task(db, pid, { state: "in_progress", title: "[WEB-89] x", jira_key: "WEB-89", jira_link_kind: "mirror", source: "external" });
  task(db, pid, { state: "done", title: "[WEB-89] shipped it" });
  task(db, pid, { state: "done", pr_url: "https://x/7" });
  task(db, pid, { state: "queued", source: "external", source_ref: "jira:WEB-1" });
  const prev = task(db, pid, { state: "failed", jira_key: "CORE-1", jira_link_kind: "subtask" });
  task(db, pid, { state: "in_progress", parent_task_id: prev, source: "requeue" });
  task(db, pid, { state: "failed", title: "abandoned" }, "2026-08-01T00:00:00.000Z");
  task(db, pid, { state: "done", title: "abandoned" }, "2026-08-02T00:00:00.000Z");
  const stuck = task(db, pid, { state: "queued", title: "broken repo" });
  for (let i = 0; i < 7; i++) event(db, stuck, "spawn_error", { error: "boom" });

  const first = await reportBoardAudit(db, { exec: gh("OPEN") });
  expect([...new Set(first.map((f) => f.kind))].sort()).toEqual([
    "closed_not_merged",
    "merged_not_closed",
    "orphaned_external_key",
    "provenance_break",
    "queued_unrunnable",
    "stuck_spawns",
  ]);
  // Exactly one finding per check, and exactly one digest notification.
  expect(first.length).toBe(6);
  expect(db.query("SELECT COUNT(*) AS n FROM notifications").get()).toEqual({ n: 1 } as any);

  // Nothing changed on the board, so a second pass says nothing at all.
  expect(await reportBoardAudit(db, { exec: gh("OPEN") })).toEqual([]);
  expect(db.query("SELECT COUNT(*) AS n FROM notifications").get()).toEqual({ n: 1 } as any);
  expect(db.query("SELECT COUNT(*) AS n FROM events WHERE type = 'board_audit'").get()).toEqual({ n: 6 } as any);
});

test("the audit never writes to tasks or decisions", async () => {
  const { db, pid } = setup();
  const done = task(db, pid, { state: "done", pr_url: "https://x/7" });
  task(db, pid, { state: "queued", source: "external", source_ref: "jira:WEB-1" });
  db.query("INSERT INTO decisions (id, task_id, ts, title, options, status) VALUES (?,?,?,?,?,?)").run(
    newId("dec"), done, now(), "an open question", "[]", "open"
  );

  const snapshot = () => ({
    tasks: db.query("SELECT * FROM tasks ORDER BY id").all(),
    decisions: db.query("SELECT * FROM decisions ORDER BY id").all(),
  });
  const before = snapshot();
  expect((await reportBoardAudit(db, { exec: gh("OPEN") })).length).toBeGreaterThan(0);
  expect(snapshot()).toEqual(before);
});
