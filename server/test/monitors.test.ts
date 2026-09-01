import { test, expect } from "bun:test";
import { openDb, newId, now, type DB } from "../src/db.ts";
import { transition, getTask } from "../src/state.ts";
import { checkProjectMonitors, runCheck, runSmoke, defaultFetcher, type Fetcher } from "../src/monitors.ts";

function freshDb(config: any): { db: DB; projectId: string } {
  const db = openDb(":memory:");
  const projectId = newId("proj");
  db.query("INSERT INTO projects (id, name, config, created_at) VALUES (?,?,?,?)").run(
    projectId, "p", JSON.stringify(config), now()
  );
  return { db, projectId };
}

function makeTask(db: DB, projectId: string): string {
  const id = newId();
  const t = now();
  db.query(
    "INSERT INTO tasks (id, project_id, title, state, kind, created_at, updated_at) VALUES (?,?,?, 'queued','ship', ?, ?)"
  ).run(id, projectId, "t", t, t);
  return id;
}

const noNotify = { notify: false };

test("runCheck validates status and substring", async () => {
  const ok: Fetcher = async () => ({ status: 200, body: "welcome home" });
  expect((await runCheck({ name: "h", url: "u", expect_status: 200, expect_substring: "welcome" }, ok)).ok).toBe(true);
  expect((await runCheck({ name: "h", url: "u", expect_status: 200, expect_substring: "missing" }, ok)).ok).toBe(false);
  const bad: Fetcher = async () => ({ status: 500, body: "" });
  expect((await runCheck({ name: "h", url: "u" }, bad)).ok).toBe(false);
});

// A stalled or unreachable smoke/monitor URL used to hang this fetch forever —
// for smoke checks that wedges the merge request itself, since POST /merge
// awaits smokeThenAdvance synchronously before responding (task #641). This
// asserts the bound actually fires instead of waiting out the request.
test("defaultFetcher bounds a hung request with a timeout (task #641)", async () => {
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {}, open() {} }, // accepts the connection, never responds
  });
  try {
    const start = Date.now();
    await expect(defaultFetcher(`http://127.0.0.1:${server.port}/`, 100)).rejects.toThrow();
    expect(Date.now() - start).toBeLessThan(2000);
  } finally {
    server.stop(true);
  }
});

test("monitor failure opens an incident, recovery resolves it", async () => {
  const monitors = [{ name: "homepage", url: "https://x", expect_status: 200, interval_s: 60 }];
  const { db, projectId } = freshDb({ monitors });
  const project = { id: projectId, config: { monitors } };

  let up = false;
  const fetcher: Fetcher = async () => ({ status: up ? 200 : 503, body: "" });

  // first cycle: down -> incident opens
  await checkProjectMonitors(db, project, { fetch: fetcher, ...noNotify });
  let open = db.query("SELECT * FROM incidents WHERE project_id = ? AND status = 'open'").all(projectId);
  expect(open.length).toBe(1);

  // second cycle still down -> no duplicate incident
  await checkProjectMonitors(db, project, { fetch: fetcher, ...noNotify });
  open = db.query("SELECT * FROM incidents WHERE project_id = ? AND status = 'open'").all(projectId);
  expect(open.length).toBe(1);

  // recovery -> incident resolved
  up = true;
  const resolved = await checkProjectMonitors(db, project, { fetch: fetcher, ...noNotify });
  expect(resolved.some((i) => i.status === "resolved")).toBe(true);
  open = db.query("SELECT * FROM incidents WHERE project_id = ? AND status = 'open'").all(projectId);
  expect(open.length).toBe(0);
});

test("monitors_auto_task creates a chore task on failure", async () => {
  const project = { id: "", config: { monitors_auto_task: true, monitors: [{ name: "api", url: "https://x" }] } };
  const { db, projectId } = freshDb(project.config);
  project.id = projectId;
  const fetcher: Fetcher = async () => ({ status: 500, body: "" });
  await checkProjectMonitors(db, project, { fetch: fetcher, ...noNotify });
  const tasks = db.query("SELECT * FROM tasks WHERE project_id = ?").all(projectId) as any[];
  expect(tasks.length).toBe(1);
  expect(tasks[0].kind).toBe("chore");
  expect(tasks[0].title).toContain("api");
});

test("smoke pass writes a test_run evidence row", async () => {
  const smoke = [{ name: "root", url: "https://x", expect_status: 200 }];
  const { db, projectId } = freshDb({ smoke });
  const id = makeTask(db, projectId);
  transition(db, id, "in_progress");
  transition(db, id, "in_review");
  transition(db, id, "verifying");

  const fetcher: Fetcher = async () => ({ status: 200, body: "ok" });
  const r = await runSmoke(db, id, { fetch: fetcher });
  expect(r).toEqual({ ran: true, passed: true });
  const ev = db.query("SELECT * FROM evidence WHERE task_id = ? AND kind = 'test_run'").all(id) as any[];
  expect(ev.length).toBe(1);
  expect(JSON.parse(ev[0].meta).results[0].name).toBe("root");
  // still in verifying, eligible for done
  expect(getTask(db, id).state).toBe("verifying");
});

test("smoke fail bounces the task back to in_progress", async () => {
  const smoke = [{ name: "root", url: "https://x", expect_status: 200 }];
  const { db, projectId } = freshDb({ smoke });
  const id = makeTask(db, projectId);
  transition(db, id, "in_progress");
  transition(db, id, "in_review");
  transition(db, id, "verifying");

  const fetcher: Fetcher = async () => ({ status: 500, body: "" });
  const r = await runSmoke(db, id, { fetch: fetcher });
  expect(r.passed).toBe(false);
  expect(getTask(db, id).state).toBe("in_progress");
  const events = db.query("SELECT * FROM events WHERE task_id = ? AND type = 'smoke_failed'").all(id);
  expect(events.length).toBe(1);
});

test("no smoke config is a no-op", async () => {
  const { db, projectId } = freshDb({});
  const id = makeTask(db, projectId);
  const r = await runSmoke(db, id);
  expect(r).toEqual({ ran: false, passed: false });
});

test("runSmokeAfterMerge runs the checks and never closes the task: it waits for the director (HIVE-604)", async () => {
  const { runSmokeAfterMerge } = await import("../src/monitors.ts");
  const evFor = (db: DB, id: string) =>
    db.query("INSERT INTO evidence (id, task_id, ts, kind, caption, meta) VALUES (?,?,?,?,?,'{}')")
      .run(newId("ev"), id, now(), "log", "proof");

  // no smoke configured + evidence present -> still verifying, waiting on a person
  {
    const { db, projectId } = freshDb({});
    const id = makeTask(db, projectId);
    transition(db, id, "in_progress"); transition(db, id, "in_review"); transition(db, id, "verifying");
    evFor(db, id);
    await runSmokeAfterMerge(db, id);
    expect(getTask(db, id).state).toBe("verifying");
  }
  // passing smoke + evidence -> still verifying, waiting on a person
  {
    const smoke = [{ name: "h", url: "u", expect_status: 200 }];
    const { db, projectId } = freshDb({ smoke });
    const id = makeTask(db, projectId);
    transition(db, id, "in_progress"); transition(db, id, "in_review"); transition(db, id, "verifying");
    evFor(db, id);
    await runSmokeAfterMerge(db, id, { fetch: async () => ({ status: 200, body: "" }) });
    expect(getTask(db, id).state).toBe("verifying");
    // the pass is still recorded as evidence, which is what the director reads
    expect(db.query("SELECT COUNT(*) AS n FROM evidence WHERE task_id = ? AND kind = 'test_run'").get(id)).toEqual({ n: 1 });
  }
  // failing smoke -> bounced to in_progress (unchanged behavior)
  {
    const smoke = [{ name: "h", url: "u", expect_status: 200 }];
    const { db, projectId } = freshDb({ smoke });
    const id = makeTask(db, projectId);
    transition(db, id, "in_progress"); transition(db, id, "in_review"); transition(db, id, "verifying");
    evFor(db, id);
    await runSmokeAfterMerge(db, id, { fetch: async () => ({ status: 500, body: "" }) });
    expect(getTask(db, id).state).toBe("in_progress");
  }
  {
    const smoke = [{ name: "h", url: "u", expect_status: 200 }];
    const { db, projectId } = freshDb({ smoke });
    const id = makeTask(db, projectId);
    db.query("UPDATE tasks SET source = 'external', source_ref = 'jira:WEB-1' WHERE id = ?").run(id);
    transition(db, id, "in_progress"); transition(db, id, "in_review"); transition(db, id, "verifying");
    evFor(db, id);
    let fetches = 0;
    const result = await runSmokeAfterMerge(db, id, { fetch: async () => { fetches++; return { status: 200, body: "" }; } });
    expect(result).toEqual({ ran: false, passed: false });
    expect(fetches).toBe(0);
    expect(getTask(db, id).state).toBe("verifying");
  }
  // no evidence -> stays verifying (nothing here closes a task anyway)
  {
    const { db, projectId } = freshDb({});
    const id = makeTask(db, projectId);
    transition(db, id, "in_progress"); transition(db, id, "in_review"); transition(db, id, "verifying");
    await runSmokeAfterMerge(db, id);
    expect(getTask(db, id).state).toBe("verifying");
  }
});
