// Watchers: poll a doc/page, queue an act-on-change task on content change.
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "hive-watch-"));
process.env.HIVE_HOME = HOME;

const { openDb, newId, now } = await import("../src/db.ts");
const { checkWatcher, watchOnce, startWatchers, fetchableUrl } = await import("../src/watch.ts");
import type { DB } from "../src/db.ts";

function freshDb(watchers?: any[]): { db: DB; projectId: string } {
  const db = openDb(":memory:");
  const projectId = newId("proj");
  db.query("INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)").run(
    projectId, "p", "/repo", JSON.stringify(watchers ? { watchers } : {}), now()
  );
  return { db, projectId };
}

const fetchBody = (body: string) => (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
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
  const f = (async () => (calls++, new Response(`v${calls}`, { status: 200 }))) as unknown as typeof fetch;
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

test("startWatchers skips a tick while a cycle is already running", async () => {
  const { db } = freshDb([{ ...W, interval_minutes: 0.0001 }]);
  let active = 0;
  let maxActive = 0;
  let cycles = 0;
  let tick: () => void = () => {};
  let releaseFetch!: () => void;
  let fetchStarted!: () => void;
  let fetchFinished!: () => void;
  const blocked = new Promise<void>((resolve) => (releaseFetch = resolve));
  const started = new Promise<void>((resolve) => (fetchStarted = resolve));
  const finished = new Promise<void>((resolve) => (fetchFinished = resolve));
  const slowFetch = (async () => {
    cycles++;
    active++;
    maxActive = Math.max(maxActive, active);
    fetchStarted();
    await blocked;
    active--;
    fetchFinished();
    return new Response(`v${cycles}`, { status: 200 });
  }) as unknown as typeof fetch;

  const origWarn = console.warn;
  const origSetInterval = globalThis.setInterval;
  const origClearInterval = globalThis.clearInterval;
  const logs: string[] = [];
  console.warn = ((...args: any[]) => logs.push(String(args[0]))) as typeof console.warn;
  globalThis.setInterval = ((callback: () => void) => {
    tick = callback;
    return 1;
  }) as typeof setInterval;
  globalThis.clearInterval = (() => {}) as typeof clearInterval;
  let stop: () => void;
  try {
    stop = startWatchers(db, { fetchImpl: slowFetch, intervalMs: 15 });
    tick();
    await started;
    tick();
    releaseFetch();
    await finished;
    await new Promise(setImmediate);
    stop();
  } finally {
    console.warn = origWarn;
    globalThis.setInterval = origSetInterval;
    globalThis.clearInterval = origClearInterval;
  }

  expect(maxActive).toBe(1);
  expect(cycles).toBe(1);
  expect(logs.some((m) => m.includes("skipping this tick"))).toBe(true);
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

// The classifier is allowed up to 60s. Awaiting it inside the poll loop would
// mean one ambiguous doc change stalls every other watcher behind it, so the
// call is fired and forgotten — while still holding its own task from dispatch.
test("a slow triage does not delay the next watcher's tick", async () => {
  const { db, projectId } = freshDb();
  db.query("UPDATE projects SET config = ? WHERE id = ?").run(JSON.stringify({ intake_triage: true }), projectId);
  const { triageHold } = await import("../src/intake/triage.ts");
  const { getTask } = await import("../src/state.ts");

  // A classifier that never answers until we let it.
  let release!: () => void;
  const blocked = new Promise<void>((r) => (release = r));
  let started = 0;
  const hang = async () => {
    started++;
    await blocked;
    return { code: 0, stdout: '{"bucket":"mechanical"}', stderr: "", timedOut: false };
  };

  const A = { name: "spec-a", url: "https://example.com/a" };
  const B = { name: "spec-b", url: "https://example.com/b" };
  const deps = { triageExec: hang };
  await checkWatcher(db, projectId, A, { ...deps, fetchImpl: fetchBody("a1\n") }); // baselines
  await checkWatcher(db, projectId, B, { ...deps, fetchImpl: fetchBody("b1\n") });

  // Watcher A changes: its classifier hangs. This call must still return.
  await checkWatcher(db, projectId, A, { ...deps, fetchImpl: fetchBody("a2\n") });
  expect(started).toBe(1);

  // ...and watcher B's tick runs right behind it, classifier still hanging.
  await checkWatcher(db, projectId, B, { ...deps, fetchImpl: fetchBody("b2\n") });
  expect(watchTasks(db)).toHaveLength(2);
  expect(started).toBe(2);

  // Neither task escaped while its classification was in flight.
  for (const t of watchTasks(db)) expect(triageHold(db, getTask(db, t.id))).toBe(true);

  release();
  await new Promise((r) => setTimeout(r, 10));
  for (const t of watchTasks(db)) expect(triageHold(db, getTask(db, t.id))).toBe(false); // mechanical: released
});
