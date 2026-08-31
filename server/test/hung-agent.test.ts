import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HIVE_HOME = mkdtempSync(join(tmpdir(), "hive-hung-"));

const { openDb, newId, now } = await import("../src/db.ts");
import type { DB } from "../src/db.ts";
const { reconcileOnce } = await import("../src/reconciler.ts");
const { Herdr } = await import("../src/runtime/herdr.ts");
import type { Exec, ExecResult } from "../src/exec.ts";

const OK = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const gh: Exec = async () => ({ code: 1, stdout: "", stderr: "no gh" });

// An agent that is alive and reports "working" — exactly what a wedged
// `pnpm install` looks like, and the case recovery deliberately walks past.
const aliveWorking = new Herdr(async (argv) => {
  if (argv.includes("pane") && argv.includes("list")) return OK('{"result":{"panes":[]}}');
  if (argv.includes("get")) return OK('{"result":{"agent":{"agent_status":"working","pane_id":"w6:p9"}}}');
  return OK();
}, "herdr");

const STALE_MS = 15 * 60 * 1000;
const deps = { staleMs: STALE_MS, nowMs: () => Date.now(), exec: gh, herdr: aliveWorking };

function freshDb(): { db: DB; projectId: string } {
  const db = openDb(":memory:");
  const projectId = newId("proj");
  db.query("INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)")
    .run(projectId, "p", "/repo", JSON.stringify({}), now());
  return { db, projectId };
}

function makeTask(db: DB, projectId: string, extra: { deferred?: string } = {}): string {
  const id = newId();
  const t = now();
  db.query(
    "INSERT INTO tasks (id, project_id, title, brief, state, kind, agent_target, worktree_path, deferred_until, created_at, updated_at) VALUES (?,?,?,?, 'in_progress', 'ship', ?, ?, ?, ?, ?)"
  ).run(id, projectId, "wedged task", "do it", "a" + id.slice(0, 4), `/wt/${id}`, extra.deferred ?? null, t, t);
  return id;
}

function putEvent(db: DB, taskId: string, type: string, payload: any = {}, agoMs = 0, source = "reconciler"): void {
  db.query("INSERT INTO events (id, task_id, ts, source, type, payload) VALUES (?,?,?,?,?,?)")
    .run(newId("evt"), taskId, new Date(Date.now() - agoMs).toISOString(), source, type, JSON.stringify(payload));
}

// The live shape of abf2750ddf67: the agent says what it is doing, hive flags it
// stale once, and then nothing — for hours.
function wedged(db: DB, id: string, quietMs: number): void {
  putEvent(db, id, "assistant_text", { text: "Dependencies aren't installed in this worktree. Installing (cms pins pnpm 9.1.0)." }, quietMs, "hook");
  putEvent(db, id, "stale", { silent_ms: STALE_MS + 1, threshold_ms: STALE_MS }, quietMs - STALE_MS);
}

test("silent past 4x the stale threshold → one hung event naming what the agent last said", async () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId);
  wedged(db, id, 3 * 60 * 60 * 1000);

  await reconcileOnce(db, deps);
  await reconcileOnce(db, deps); // a second lap must NOT re-report it

  const rows = db.query("SELECT payload FROM events WHERE task_id = ? AND type = 'hung'").all(id) as { payload: string }[];
  expect(rows.length).toBe(1);
  const p = JSON.parse(rows[0].payload);
  expect(p.threshold_ms).toBe(4 * STALE_MS);
  expect(p.silent_ms).toBeGreaterThan(4 * STALE_MS);
  expect(p.last_said).toContain("pnpm 9.1.0");

  const notif: any = db.query("SELECT title, body, urgency FROM notifications WHERE kind = 'hung_agent' AND task_id = ?").get(id);
  expect(notif.urgency).toBe("urgent");
  expect(notif.title).toContain("No progress for 3h");
  expect(notif.body).toContain("pnpm 9.1.0");
});

test("quiet but under the threshold → no hung signal", async () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId);
  wedged(db, id, 40 * 60 * 1000); // past stale, under 4x

  await reconcileOnce(db, deps);

  expect(db.query("SELECT 1 FROM events WHERE task_id = ? AND type = 'hung'").get(id)).toBeFalsy();
});

test("a parked (deferred) task is never reported hung, however long it is quiet", async () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId, { deferred: "9999-12-31T00:00:00.000Z" });
  wedged(db, id, 20 * 60 * 60 * 1000);

  await reconcileOnce(db, deps);

  expect(db.query("SELECT 1 FROM events WHERE task_id = ? AND type = 'hung'").get(id)).toBeFalsy();
});

test("hive's own rows about the task do not count as progress", async () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId);
  wedged(db, id, 5 * 60 * 60 * 1000);
  // CI polls, a status sync and a failed respawn all landed after the agent went
  // quiet. None of them is the agent doing anything.
  putEvent(db, id, "ci_status", { ci_status: "passing" }, 60 * 1000);
  putEvent(db, id, "agent_status", { status: "done" }, 50 * 1000, "herdr");
  putEvent(db, id, "spawn_error", { error: "already has an agent holding its name" }, 40 * 1000, "herdr");

  await reconcileOnce(db, deps);

  expect(db.query("SELECT 1 FROM events WHERE task_id = ? AND type = 'hung'").get(id)).toBeTruthy();
});

// The trap a human walked into on 2026-08-31: attempting a respawn on a frozen
// task wrote spawn_error + authority_logged, and steering it wrote a steer row.
// Checking on a stuck task must not make it look busy, and the quoted "last
// said" must be the AGENT, not the person who steered it.
test("a human poking the task does not hide it", async () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId);
  wedged(db, id, 5 * 60 * 60 * 1000);
  putEvent(db, id, "authority_logged", { action: "spawn" }, 30 * 1000, "system");
  putEvent(db, id, "steer", { message: "are you alive?" }, 20 * 1000, "director");
  putEvent(db, id, "note", { note: "poked it" }, 10 * 1000, "director");

  await reconcileOnce(db, deps);

  const row = db.query("SELECT payload FROM events WHERE task_id = ? AND type = 'hung'").get(id) as { payload: string } | undefined;
  expect(row).toBeTruthy();
  const p = JSON.parse(row!.payload);
  expect(p.silent_ms).toBeGreaterThan(4 * STALE_MS);
  expect(p.last_said).toContain("pnpm 9.1.0");
});

test("the agent speaking again re-arms the signal", async () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId);
  wedged(db, id, 3 * 60 * 60 * 1000);
  await reconcileOnce(db, deps);
  // It wakes up, says something, then goes quiet again for hours.
  putEvent(db, id, "assistant_text", { text: "back, running the tests" }, 3 * 60 * 60 * 1000 - 1000, "hook");

  await reconcileOnce(db, deps);

  const rows = db.query("SELECT payload FROM events WHERE task_id = ? AND type = 'hung' ORDER BY ts").all(id) as { payload: string }[];
  expect(rows.length).toBe(2);
  expect(JSON.parse(rows[1].payload).last_said).toContain("back, running the tests");
});
