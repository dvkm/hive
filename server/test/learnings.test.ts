import { test, expect, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "hive-learn-"));
process.env.HIVE_HOME = HOME;

const { openDb } = await import("../src/db.ts");
const { makeHandler } = await import("../src/api.ts");
const { composeBrief } = await import("../src/briefs.ts");
const { recordSystemLearning } = await import("../src/learn.ts");

const db = openDb(":memory:");
// Call the handler directly instead of standing up a real HTTP server. Bun
// 1.3.14's global fetch pool keeps sockets alive past the server they belong
// to, and the OS hands those ephemeral ports straight back to the next
// `Bun.serve({ port: 0 })`, so a request can go out on a socket belonging to a
// dead server. No socket, no port, no pool, no flake.
const handler = makeHandler(db);

async function post(path: string, body: unknown) {
  const res = await handler(new Request("http://127.0.0.1" + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
  return { status: res.status, json: await res.json() };
}
async function get(path: string) {
  const res = await handler(new Request("http://127.0.0.1" + path));
  return { status: res.status, json: await res.json() };
}
async function put(path: string, body: unknown) {
  const res = await handler(new Request("http://127.0.0.1" + path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
  return { status: res.status, json: await res.json() };
}
async function del(path: string) {
  const res = await handler(new Request("http://127.0.0.1" + path, { method: "DELETE" }));
  return { status: res.status, json: await res.json() };
}

let projectId = "";
beforeAll(async () => {
  const p = await post("/api/projects", { name: "learn-proj", repo_path: "/tmp/x" });
  projectId = p.json.id;
});

test("learning CRUD + list filters", async () => {
  const c = await post("/api/learnings", { project_id: projectId, title: "flaky migration", body: "PRAGMA order", kind: "failure" });
  expect(c.status).toBe(201);
  expect(c.json.occurrences).toBe(1);
  expect(c.json.status).toBe("active");
  const id = c.json.id;

  const one = await get(`/api/learnings/${id}`);
  expect(one.json.title).toBe("flaky migration");

  const active = await get(`/api/learnings?project_id=${projectId}&status=active`);
  expect(active.json.some((l: any) => l.id === id)).toBe(true);

  // resolve
  const upd = await put(`/api/learnings/${id}`, { status: "resolved" });
  expect(upd.json.status).toBe("resolved");
  const resolved = await get(`/api/learnings?status=resolved`);
  expect(resolved.json.some((l: any) => l.id === id)).toBe(true);
  const stillActive = await get(`/api/learnings?status=active`);
  expect(stillActive.json.some((l: any) => l.id === id)).toBe(false);
});

test("recur bumps occurrences + last_seen and reactivates", async () => {
  const c = await post("/api/learnings", { project_id: projectId, title: "n+1 query", kind: "failure" });
  const id = c.json.id;
  const before = c.json.last_seen;

  await put(`/api/learnings/${id}`, { status: "resolved" }); // resolve then it recurs
  const r = await post(`/api/learnings/${id}/recur`, {});
  expect(r.json.occurrences).toBe(2);
  expect(r.json.status).toBe("active"); // recurrence reactivates
  expect(r.json.last_seen >= before).toBe(true);

  const bad = await post(`/api/learnings/nope/recur`, {});
  expect(bad.status).toBe(404);
});

test("create_root_cause_task auto-spawns a queued chore task and links it", async () => {
  const c = await post("/api/learnings", {
    project_id: projectId,
    title: "prod deploy skipped smoke",
    body: "smoke list was empty",
    kind: "failure",
    create_root_cause_task: true,
  });
  expect(c.json.root_cause_task_id).toBeTruthy();

  const task = await get(`/api/tasks/${c.json.root_cause_task_id}`);
  expect(task.json.kind).toBe("chore");
  expect(task.json.state).toBe("queued");
  expect(task.json.brief).toContain("prod deploy skipped smoke");
});

test("kind is required — no silent default to failure (task #904)", async () => {
  const noKind = await post("/api/learnings", { project_id: projectId, title: "some summary" });
  expect(noKind.status).toBe(400);

  const badKind = await post("/api/learnings", { project_id: projectId, title: "some summary", kind: "bogus" });
  expect(badKind.status).toBe(400);
});

test("create_root_cause_task is rejected for kind='reference' (a fact, not a regression)", async () => {
  const c = await post("/api/learnings", {
    project_id: projectId,
    title: "recurring watcher triage summary",
    kind: "reference",
    create_root_cause_task: true,
  });
  expect(c.status).toBe(400);
});

test("PUT can recategorize a misfiled kind after the fact", async () => {
  const c = await post("/api/learnings", { project_id: projectId, title: "misfiled as failure", kind: "failure" });
  const id = c.json.id;

  const upd = await put(`/api/learnings/${id}`, { kind: "reference" });
  expect(upd.status).toBe(200);
  expect(upd.json.kind).toBe("reference");

  const reread = await get(`/api/learnings/${id}`);
  expect(reread.json.kind).toBe("reference");

  const badKind = await put(`/api/learnings/${id}`, { kind: "nope" });
  expect(badKind.status).toBe(400);
  // 'decision' rows are written only by the decision path, never promoted via PUT
  const decisionKind = await put(`/api/learnings/${id}`, { kind: "decision" });
  expect(decisionKind.status).toBe(400);
});

test("recategorizing off 'failure' cancels the still-queued root-cause task", async () => {
  const c = await post("/api/learnings", {
    project_id: projectId,
    title: "bogus root cause from a routine summary",
    kind: "failure",
    create_root_cause_task: true,
  });
  const taskId = c.json.root_cause_task_id;
  expect(taskId).toBeTruthy();

  const upd = await put(`/api/learnings/${c.json.id}`, { kind: "reference" });
  expect(upd.status).toBe(200);
  expect(upd.json.root_cause_task_id).toBeNull();
  expect((await get(`/api/learnings/${c.json.id}`)).json.root_cause_task_id).toBeNull();
  expect((await get(`/api/tasks/${taskId}`)).json.state).toBe("cancelled");
});

test("PUT cannot demote a 'decision' ruling out of the decisions set", async () => {
  const t = Date.now();
  db.query(
    `INSERT INTO learnings (id, project_id, title, body, source_task_id, occurrences,
      first_seen, last_seen, status, root_cause_task_id, kind)
     VALUES ('lrn_dec_test', ?, 'ship behind a flag?', '**Answer:** yes', NULL, 1, ?, ?, 'active', NULL, 'decision')`
  ).run(projectId, t, t);

  const demote = await put(`/api/learnings/lrn_dec_test`, { kind: "failure" });
  expect(demote.status).toBe(400);
  expect((await get(`/api/learnings/lrn_dec_test`)).json.kind).toBe("decision");

  // non-kind edits on a decision row still work
  const retitle = await put(`/api/learnings/lrn_dec_test`, { status: "resolved" });
  expect(retitle.status).toBe(200);
  expect(retitle.json.kind).toBe("decision");

  // a read-modify-write client echoing the unchanged kind back is not a recategorization
  const echo = await put(`/api/learnings/lrn_dec_test`, { title: "ship behind a flag??", kind: "decision" });
  expect(echo.status).toBe(200);
  expect(echo.json.kind).toBe("decision");
});

test("deleting a learning cancels its still-queued root-cause task", async () => {
  const c = await post("/api/learnings", {
    project_id: projectId,
    title: "misfiled failure the director just deletes",
    kind: "failure",
    create_root_cause_task: true,
  });
  const taskId = c.json.root_cause_task_id;
  expect(taskId).toBeTruthy();

  expect((await del(`/api/learnings/${c.json.id}`)).status).toBe(200);
  expect((await get(`/api/learnings/${c.json.id}`)).status).toBe(404);
  expect((await get(`/api/tasks/${taskId}`)).json.state).toBe("cancelled");
});

test("deleting a learning leaves an already-dispatched root-cause task alone", async () => {
  const c = await post("/api/learnings", {
    project_id: projectId,
    title: "real regression deleted mid-flight",
    kind: "failure",
    create_root_cause_task: true,
  });
  const taskId = c.json.root_cause_task_id;
  await post(`/api/tasks/${taskId}/transition`, { to: "in_progress" });

  await del(`/api/learnings/${c.json.id}`);
  expect((await get(`/api/tasks/${taskId}`)).json.state).toBe("in_progress");
});

test("recategorizing leaves an already-dispatched root-cause task alone", async () => {
  const c = await post("/api/learnings", {
    project_id: projectId,
    title: "real regression, agent already on it",
    kind: "failure",
    create_root_cause_task: true,
  });
  const taskId = c.json.root_cause_task_id;
  await post(`/api/tasks/${taskId}/transition`, { to: "in_progress" });

  const upd = await put(`/api/learnings/${c.json.id}`, { kind: "reference" });
  expect(upd.json.root_cause_task_id).toBe(taskId);
  expect((await get(`/api/tasks/${taskId}`)).json.state).toBe("in_progress");
});

test("recategorizing never cancels a hand-linked root-cause task hive did not spawn", async () => {
  const t = await post("/api/tasks", { project_id: projectId, title: "director's own root-cause work" });
  const c = await post("/api/learnings", { project_id: projectId, title: "linked by hand", kind: "failure" });
  const linked = await put(`/api/learnings/${c.json.id}`, { root_cause_task_id: t.json.id });
  expect(linked.json.root_cause_task_id).toBe(t.json.id);

  const upd = await put(`/api/learnings/${c.json.id}`, { kind: "reference" });
  expect(upd.json.kind).toBe("reference");
  expect(upd.json.root_cause_task_id).toBe(t.json.id);
  expect((await get(`/api/tasks/${t.json.id}`)).json.state).toBe("queued");
});

test("a recurrence after recategorization re-files as a failure, not a bump of the reference", async () => {
  const title = "agent died mid-task (auto-requeued)";
  const c = await post("/api/learnings", { project_id: projectId, title, kind: "failure" });
  await put(`/api/learnings/${c.json.id}`, { kind: "reference" });

  recordSystemLearning(db, projectId, title, "it happened again", null);

  const rows: any[] = db
    .query("SELECT id, kind, occurrences FROM learnings WHERE project_id = ? AND title = ?")
    .all(projectId, title);
  expect(rows).toHaveLength(2);
  const ref = rows.find((r) => r.kind === "reference");
  expect(ref.id).toBe(c.json.id);
  expect(ref.occurrences).toBe(1); // the corrected row stays corrected
  expect(rows.find((r) => r.kind === "failure")).toBeTruthy();
});

test("active learnings are counted in briefs without replaying their bodies", async () => {
  // fresh project + task so we control the learning set
  const p = await post("/api/projects", { name: "brief-proj", repo_path: "/tmp/y" });
  const pid = p.json.id;
  const t = await post("/api/tasks", { project_id: pid, title: "do work" });

  for (let i = 0; i < 12; i++)
    await post("/api/learnings", { project_id: pid, title: `pattern ${i}`, body: `body ${i}`, kind: "failure" });
  // one resolved learning must NOT appear
  const resolvedL = await post("/api/learnings", { project_id: pid, title: "already fixed", kind: "failure" });
  await put(`/api/learnings/${resolvedL.json.id}`, { status: "resolved" });

  const brief = composeBrief(db, t.json.id);
  expect(brief).toContain("12 failure patterns");
  expect(brief).not.toContain("pattern 11");
  expect(brief).not.toContain("already fixed");
  expect(brief).not.toContain("body 11");
});
