import { test, expect } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { openDb, newId, now, type DB } from "../src/db.ts";
import { getTask, transition } from "../src/state.ts";
import { linkPrIfMarked } from "../src/api.ts";
import { reconcileOnce } from "../src/reconciler.ts";
import { prTitlePrefix, prBodyFooter, prMarker, taskIdFromBody, taskNumberFromTitle } from "../src/marker.ts";
import type { Exec, ExecResult } from "../src/exec.ts";

function freshDb(): { db: DB; projectId: string } {
  const db = openDb(":memory:");
  const projectId = newId("proj");
  db.query("INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)").run(
    projectId, "p", "/tmp/repo", "{}", now()
  );
  return { db, projectId };
}
function makeTask(db: DB, projectId: string, extra: Partial<{ created_at: string; pr_url: string }> = {}): string {
  const id = newId();
  const t = extra.created_at ?? now();
  db.query(
    "INSERT INTO tasks (id, project_id, title, state, kind, pr_url, created_at, updated_at) VALUES (?,?,?, 'queued','ship',?,?,?)"
  ).run(id, projectId, "t", extra.pr_url ?? null, t, t);
  return id;
}
const stub = (fn: (argv: string[]) => ExecResult): Exec => async (argv) => fn(argv);
const OK = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });

// ---- number assignment ----

test("number is assigned monotonically starting at 1", () => {
  const { db, projectId } = freshDb();
  const a = getTask(db, makeTask(db, projectId));
  const b = getTask(db, makeTask(db, projectId));
  const c = getTask(db, makeTask(db, projectId));
  expect(a.number).toBe(1);
  expect(b.number).toBe(2);
  expect(c.number).toBe(3);
});

test("number is unique — a duplicate explicit number is rejected", () => {
  const { db, projectId } = freshDb();
  makeTask(db, projectId); // number 1
  expect(() =>
    db.query(
      "INSERT INTO tasks (id, project_id, title, state, kind, number, created_at, updated_at) VALUES (?,?,?, 'queued','ship',1,?,?)"
    ).run(newId(), projectId, "dup", now(), now())
  ).toThrow();
});

test("backfill assigns numbers to legacy rows in created_at order", () => {
  const path = join(tmpdir(), `hive-backfill-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  try {
    // 1) Fully-migrated DB; seed a project.
    const db1 = openDb(path);
    const projectId = newId("proj");
    db1.query("INSERT INTO projects (id, name, config, created_at) VALUES (?,?,?,?)").run(projectId, "p", "{}", now());
    // 2) Rewind to the pre-number (v10) schema: drop the number column, its index
    //    and the auto-assign trigger, so re-opening re-runs the real v11 backfill.
    //    (v10 is duplicate_of, already applied — rewinding past it would re-add an
    //    existing column, so target v10, not v9.)
    db1.exec("DROP TRIGGER tasks_assign_number");
    db1.exec("DROP INDEX idx_tasks_number");
    db1.exec("ALTER TABLE tasks DROP COLUMN number");
    db1.exec("PRAGMA user_version = 10");
    // 3) Insert legacy rows OUT of created_at order.
    const mk = (id: string, created_at: string) =>
      db1.query("INSERT INTO tasks (id, project_id, title, state, kind, created_at, updated_at) VALUES (?,?,?, 'queued','ship',?,?)")
        .run(id, projectId, id, created_at, created_at);
    mk("mid", "2026-02-02T00:00:00Z");
    mk("old", "2026-01-01T00:00:00Z");
    mk("new", "2026-03-03T00:00:00Z");
    db1.close();

    // 4) Reopen → v11 migration runs the real backfill.
    const db2 = openDb(path);
    expect(getTask(db2, "old").number).toBe(1);
    expect(getTask(db2, "mid").number).toBe(2);
    expect(getTask(db2, "new").number).toBe(3);
    // 5) A new insert continues the monotonic sequence.
    const id4 = newId();
    db2.query("INSERT INTO tasks (id, project_id, title, state, kind, created_at, updated_at) VALUES (?,?,?, 'queued','ship',?,?)")
      .run(id4, projectId, "t", now(), now());
    expect(getTask(db2, id4).number).toBe(4);
    db2.close();
  } finally {
    rmSync(path, { force: true });
    rmSync(path + "-wal", { force: true });
    rmSync(path + "-shm", { force: true });
  }
});

// ---- marker format helper ----

test("marker helpers produce the documented format", () => {
  expect(prTitlePrefix(42)).toBe("[hive-42] ");
  expect(prBodyFooter("9da7c5527580")).toBe("hive-task: 9da7c5527580");
  expect(prMarker(7, "abc123")).toEqual({ titlePrefix: "[hive-7] ", bodyFooter: "hive-task: abc123" });
});

test("marker parsers extract id from body and number from title", () => {
  expect(taskIdFromBody("Some PR desc\n\nhive-task: 9da7c5527580\n")).toBe("9da7c5527580");
  expect(taskIdFromBody("no marker here")).toBeNull();
  expect(taskNumberFromTitle("[hive-42] Add dark mode toggle")).toBe(42);
  expect(taskNumberFromTitle("plain title")).toBeNull();
});

// ---- PR → task matching ----

test("linkPrIfMarked matches by the hive-task id footer", () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId);
  const res = linkPrIfMarked(db, { title: "whatever", body: `x\nhive-task: ${id}\n`, url: "https://gh/pr/9" });
  expect(res).toEqual({ task_id: id, number: 1, linked: true });
  expect(getTask(db, id).pr_url).toBe("https://gh/pr/9");
  // Idempotent: re-linking the already-linked task is a no-op.
  const again = linkPrIfMarked(db, { title: "whatever", body: `hive-task: ${id}`, url: "https://gh/pr/9" });
  expect(again).toEqual({ task_id: id, number: 1, linked: false });
});

test("linkPrIfMarked falls back to the [hive-<number>] title when the footer is absent", () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId); // number 1
  const res = linkPrIfMarked(db, { title: "[hive-1] Add toggle", body: "no footer", url: "https://gh/pr/5" });
  expect(res).toEqual({ task_id: id, number: 1, linked: true });
  expect(getTask(db, id).pr_url).toBe("https://gh/pr/5");
});

test("linkPrIfMarked returns null when the PR carries no marker", () => {
  const { db, projectId } = freshDb();
  makeTask(db, projectId);
  expect(linkPrIfMarked(db, { title: "plain", body: "plain", url: "https://gh/pr/1" })).toBeNull();
});

// ---- PR open → in_review hand-off (makes Approve & merge reachable) ----

test("linking a PR to an in-progress task hands it to the director's Review lane", () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId);
  transition(db, id, "in_progress", { source: "director" });
  linkPrIfMarked(db, { title: "t", body: `hive-task: ${id}`, url: "https://gh/pr/9" });
  expect(getTask(db, id).state).toBe("in_review"); // the only state POST /merge accepts
});

test("linking a PR does not transition a task that isn't in_progress", () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId); // queued
  linkPrIfMarked(db, { title: "t", body: `hive-task: ${id}`, url: "https://gh/pr/9" });
  expect(getTask(db, id).state).toBe("queued");
});

test("reconciler backfills in_progress tasks whose PR is already open", async () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId, { pr_url: "https://gh/pr/6" }); // linked before the hand-off existed
  transition(db, id, "in_progress", { source: "director" });
  const gh: Exec = stub((argv) => {
    if (argv.includes("view")) return OK(JSON.stringify({ state: "OPEN", statusCheckRollup: [] }));
    return { code: 1, stdout: "", stderr: "skip" };
  });
  await reconcileOnce(db, { exec: gh });
  expect(getTask(db, id).state).toBe("in_review");
});

// ---- reconciler linking with injected gh output ----

test("reconciler linkPRs links an open PR to its task by marker", async () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId);
  const prList = JSON.stringify([
    { number: 12, title: "unrelated", body: "nothing", url: "https://gh/pr/12" },
    { number: 13, title: "[hive-99] wrong", body: `hive-task: ${id}`, url: "https://gh/pr/13" },
  ]);
  const gh: Exec = stub((argv) => {
    if (argv.includes("list")) return OK(prList);
    return { code: 1, stdout: "", stderr: "skip" };
  });
  await reconcileOnce(db, { exec: gh });
  const task = getTask(db, id);
  expect(task.pr_url).toBe("https://gh/pr/13"); // matched by the id footer, not the bogus title number
  expect(db.query("SELECT * FROM events WHERE task_id = ? AND type = 'pr_linked'").all(id).length).toBe(1);
});
