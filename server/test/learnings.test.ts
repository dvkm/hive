import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "hive-learn-"));
process.env.HIVE_HOME = HOME;

const { openDb } = await import("../src/db.ts");
const { makeHandler } = await import("../src/api.ts");
const { composeBrief } = await import("../src/briefs.ts");

const db = openDb(":memory:");
const server = Bun.serve({ port: 0, fetch: makeHandler(db) });
const BASE = `http://127.0.0.1:${server.port}`;
afterAll(() => server.stop(true));

async function post(path: string, body: unknown) {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}
async function get(path: string) {
  const res = await fetch(BASE + path);
  return { status: res.status, json: await res.json() };
}
async function put(path: string, body: unknown) {
  const res = await fetch(BASE + path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

let projectId = "";
beforeAll(async () => {
  const p = await post("/api/projects", { name: "learn-proj", repo_path: "/tmp/x" });
  projectId = p.json.id;
});

test("learning CRUD + list filters", async () => {
  const c = await post("/api/learnings", { project_id: projectId, title: "flaky migration", body: "PRAGMA order" });
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
  const c = await post("/api/learnings", { project_id: projectId, title: "n+1 query" });
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
    create_root_cause_task: true,
  });
  expect(c.json.root_cause_task_id).toBeTruthy();

  const task = await get(`/api/tasks/${c.json.root_cause_task_id}`);
  expect(task.json.kind).toBe("chore");
  expect(task.json.state).toBe("queued");
  expect(task.json.brief).toContain("prod deploy skipped smoke");
});

test("active learnings are injected into composed briefs, capped at 10", async () => {
  // fresh project + task so we control the learning set
  const p = await post("/api/projects", { name: "brief-proj", repo_path: "/tmp/y" });
  const pid = p.json.id;
  const t = await post("/api/tasks", { project_id: pid, title: "do work" });

  for (let i = 0; i < 12; i++)
    await post("/api/learnings", { project_id: pid, title: `pattern ${i}`, body: `body ${i}` });
  // one resolved learning must NOT appear
  const resolvedL = await post("/api/learnings", { project_id: pid, title: "already fixed" });
  await put(`/api/learnings/${resolvedL.json.id}`, { status: "resolved" });

  const brief = composeBrief(db, t.json.id);
  expect(brief).toContain("Known failure patterns");
  expect(brief).toContain("pattern 11");
  expect(brief).not.toContain("already fixed");
  // cap at 10: only the 10 most recent by last_seen; pattern 0/1 are oldest.
  expect(brief).not.toContain("pattern 0\n");
  const shown = [...brief.matchAll(/### pattern \d+/g)].length;
  expect(shown).toBe(10);
});
