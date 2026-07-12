// Watchers: poll a doc/page, queue an act-on-change task on content change.
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "hive-watch-"));
process.env.HIVE_HOME = HOME;

const { openDb, newId, now } = await import("../src/db.ts");
const { checkWatcher, watchOnce, fetchableUrl } = await import("../src/watch.ts");
import type { DB } from "../src/db.ts";

function freshDb(watchers?: any[]): { db: DB; projectId: string } {
  const db = openDb(":memory:");
  const projectId = newId("proj");
  db.query("INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)").run(
    projectId, "p", "/repo", JSON.stringify(watchers ? { watchers } : {}), now()
  );
  return { db, projectId };
}

const fetchBody = (body: string) => (async () => new Response(body, { status: 200 })) as typeof fetch;
const watchTasks = (db: DB) => db.query("SELECT * FROM tasks WHERE source = 'watch'").all() as any[];
const W = { name: "spec", url: "https://example.com/spec", prompt: "sync the roadmap page" };

test("first poll is a baseline; a change queues one task with the diff and prompt", async () => {
  const { db, projectId } = freshDb();
  await checkWatcher(db, projectId, W, { fetchImpl: fetchBody("v1 line\nshared\n") });
  expect(watchTasks(db)).toHaveLength(0); // baseline, no task

  await checkWatcher(db, projectId, W, { fetchImpl: fetchBody("v1 line\nshared\n") });
  expect(watchTasks(db)).toHaveLength(0); // unchanged

  await checkWatcher(db, projectId, W, { fetchImpl: fetchBody("v2 line\nshared\n") });
  const tasks = watchTasks(db);
  expect(tasks).toHaveLength(1);
  expect(tasks[0].state).toBe("queued");
  expect(tasks[0].kind).toBe("chore");
  expect(tasks[0].brief).toContain("sync the roadmap page");
  expect(tasks[0].brief).toContain("-v1 line");
  expect(tasks[0].brief).toContain("+v2 line");
});

test("no stacking: while a watch task is active, further changes wait (cursor holds)", async () => {
  const { db, projectId } = freshDb();
  await checkWatcher(db, projectId, W, { fetchImpl: fetchBody("a\n") });
  await checkWatcher(db, projectId, W, { fetchImpl: fetchBody("b\n") });
  expect(watchTasks(db)).toHaveLength(1);

  await checkWatcher(db, projectId, W, { fetchImpl: fetchBody("c\n") });
  expect(watchTasks(db)).toHaveLength(1); // active task → no new one

  db.query("UPDATE tasks SET state = 'done' WHERE source = 'watch'").run();
  await checkWatcher(db, projectId, W, { fetchImpl: fetchBody("c\n") });
  const tasks = watchTasks(db);
  expect(tasks).toHaveLength(2); // accumulated change lands once, after the first finishes
  expect(tasks[1].brief).toContain("+c");
});

test("watchOnce respects per-watcher cadence and offline mode", async () => {
  const { db, projectId } = freshDb([{ ...W, interval_minutes: 5 }]);
  let calls = 0;
  const f = (async () => (calls++, new Response(`v${calls}`, { status: 200 }))) as typeof fetch;
  const t0 = Date.now();
  await watchOnce(db, { fetchImpl: f, nowMs: () => t0 });
  await watchOnce(db, { fetchImpl: f, nowMs: () => t0 + 60_000 }); // 1m: not due
  expect(calls).toBe(1);
  await watchOnce(db, { fetchImpl: f, nowMs: () => t0 + 6 * 60_000 }); // due → change → task
  expect(calls).toBe(2);
  expect(watchTasks(db)).toHaveLength(1);

  db.query("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('offline','1',?)").run(now());
  await watchOnce(db, { fetchImpl: f, nowMs: () => t0 + 20 * 60_000 });
  expect(calls).toBe(2); // offline: no polling
});

test("google docs/sheets edit links rewrite to export endpoints", () => {
  expect(fetchableUrl("https://docs.google.com/document/d/ABC123/edit?tab=t.0")).toBe(
    "https://docs.google.com/document/d/ABC123/export?format=txt"
  );
  expect(fetchableUrl("https://docs.google.com/spreadsheets/d/XYZ/edit#gid=0")).toBe(
    "https://docs.google.com/spreadsheets/d/XYZ/export?format=csv"
  );
  expect(fetchableUrl("https://example.com/page")).toBe("https://example.com/page");
});
