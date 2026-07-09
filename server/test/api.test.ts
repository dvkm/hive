import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point evidence storage at a throwaway dir before importing anything that reads it.
const HOME = mkdtempSync(join(tmpdir(), "hive-test-"));
process.env.HIVE_HOME = HOME;

const { openDb } = await import("../src/db.ts");
const { makeHandler } = await import("../src/api.ts");

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

let projectId = "";
let taskId = "";

beforeAll(async () => {
  const p = await post("/api/projects", { name: "test-proj", repo_path: "/tmp/x" });
  projectId = p.json.id;
  const t = await post("/api/tasks", { project_id: projectId, title: "test task" });
  taskId = t.json.id;
});

test("health endpoint", async () => {
  const { json } = await get("/api/health");
  expect(json.ok).toBe(true);
});

test("task create + list + get", async () => {
  const list = await get("/api/tasks");
  expect(list.json.some((t: any) => t.id === taskId)).toBe(true);
  const one = await get(`/api/tasks/${taskId}`);
  expect(one.json.id).toBe(taskId);
  expect(Array.isArray(one.json.events)).toBe(true);
});

test("event ingestion: status event is recorded", async () => {
  const r = await post(`/api/tasks/${taskId}/events`, { type: "status", note: "working" });
  expect(r.status).toBe(201);
  const events = await get(`/api/tasks/${taskId}/events`);
  expect(events.json.some((e: any) => e.type === "status" && e.payload.note === "working")).toBe(true);
});

test("transition endpoint enforces the state machine", async () => {
  const bad = await post(`/api/tasks/${taskId}/events`, { type: "done" });
  expect(bad.status).toBe(409); // no evidence yet
  await post(`/api/tasks/${taskId}/transition`, { to: "in_progress" });
  const bad2 = await post(`/api/tasks/${taskId}/transition`, { to: "done" });
  expect(bad2.status).toBe(409);
});

test("evidence upload round-trips through /evidence", async () => {
  const form = new FormData();
  form.set("type", "evidence");
  form.set("kind", "screenshot");
  form.set("caption", "a shot");
  form.set("file", new File([new Uint8Array([1, 2, 3, 4])], "shot.png", { type: "image/png" }));
  const res = await fetch(`${BASE}/api/tasks/${taskId}/events`, { method: "POST", body: form });
  expect(res.status).toBe(201);
  const data = await res.json();
  expect(data.evidence.url).toStartWith(`/evidence/${taskId}/`);

  const fetched = await fetch(BASE + data.evidence.url);
  expect(fetched.status).toBe(200);
  const bytes = new Uint8Array(await fetched.arrayBuffer());
  expect(Array.from(bytes)).toEqual([1, 2, 3, 4]);
});

test("task reaches done once evidence exists", async () => {
  await post(`/api/tasks/${taskId}/transition`, { to: "in_review" });
  await post(`/api/tasks/${taskId}/transition`, { to: "verifying" });
  const done = await post(`/api/tasks/${taskId}/transition`, { to: "done" });
  expect(done.status).toBe(200);
  expect(done.json.state).toBe("done");
});

test("decision: create, draft autosave, answer flow", async () => {
  const t = await post("/api/tasks", { project_id: projectId, title: "decision task" });
  const dtask = t.json.id;
  await post(`/api/tasks/${dtask}/transition`, { to: "in_progress" });

  const d = await post("/api/decisions", {
    task_id: dtask,
    title: "Ship it?",
    context: "ctx",
    risk: "high",
    blast_radius: "prod: acme-db",
    options: [
      { key: "yes", label: "Yes", detail: "do it", recommended: true },
      { key: "no", label: "No", detail: "wait" },
    ],
  });
  expect(d.status).toBe(201);
  const decisionId = d.json.id;

  // creating a decision parks the task in needs_decision
  const parked = await get(`/api/tasks/${dtask}`);
  expect(parked.json.state).toBe("needs_decision");

  // it appears in the open list
  const open = await get("/api/decisions?status=open");
  expect(open.json.some((x: any) => x.id === decisionId)).toBe(true);

  // draft autosave
  const draft = await fetch(`${BASE}/api/decisions/${decisionId}/draft`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ draft_note: "leaning yes" }),
  });
  expect(draft.status).toBe(200);
  const afterDraft = await get(`/api/decisions/${decisionId}`);
  expect(afterDraft.json.draft_note).toBe("leaning yes");

  // answer / submit
  const ans = await post(`/api/decisions/${decisionId}/answer`, { answer_key: "yes", answer_note: "go" });
  expect(ans.status).toBe(200);
  expect(ans.json.status).toBe("answered");
  expect(ans.json.answer_key).toBe("yes");

  // archived: no longer in open list
  const open2 = await get("/api/decisions?status=open");
  expect(open2.json.some((x: any) => x.id === decisionId)).toBe(false);

  // task resumed and an event was recorded
  const resumed = await get(`/api/tasks/${dtask}`);
  expect(resumed.json.state).toBe("in_progress");
  expect(resumed.json.decisions.some((x: any) => x.status === "answered")).toBe(true);
});

test("rejecting an answer_key not in options", async () => {
  const t = await post("/api/tasks", { project_id: projectId, title: "d2" });
  const d = await post("/api/decisions", {
    task_id: t.json.id,
    title: "pick",
    options: [{ key: "a", label: "A" }],
  });
  const bad = await post(`/api/decisions/${d.json.id}/answer`, { answer_key: "zzz" });
  expect(bad.status).toBe(400);
});

test("policies CRUD", async () => {
  const p = await post("/api/policies", { title: "P1", body: "always test", scope: "global" });
  expect(p.status).toBe(201);
  const list = await get("/api/policies?scope=global");
  expect(list.json.some((x: any) => x.id === p.json.id)).toBe(true);

  const upd = await fetch(`${BASE}/api/policies/${p.json.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ active: false }),
  });
  expect((await upd.json()).active).toBe(false);

  const del = await fetch(`${BASE}/api/policies/${p.json.id}`, { method: "DELETE" });
  expect(del.status).toBe(200);
});

test("brief endpoint composes policies", async () => {
  await post("/api/policies", { title: "GlobalRule", body: "no em-dashes", scope: "global" });
  const b = await get(`/api/tasks/${taskId}/brief`);
  expect(b.json.brief).toContain("GlobalRule");
  expect(b.json.brief).toContain("hive emit");
});

test("SSE stream sends a hello headline", async () => {
  const res = await fetch(BASE + "/api/stream");
  const reader = res.body!.getReader();
  const { value } = await reader.read();
  const text = new TextDecoder().decode(value);
  expect(text).toContain('"type":"hello"');
  await reader.cancel();
});
