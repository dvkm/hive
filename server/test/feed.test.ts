import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "hive-feed-test-"));
process.env.HIVE_HOME = HOME;

const { openDb } = await import("../src/db.ts");
const { makeHandler } = await import("../src/api.ts");

const db = openDb(":memory:");
const server = Bun.serve({ port: 0, fetch: makeHandler(db) });
const BASE = `http://127.0.0.1:${server.port}`;
afterAll(() => server.stop(true));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function post(path: string, body: unknown) {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() as any };
}
async function get(path: string) {
  const res = await fetch(BASE + path);
  return { status: res.status, json: await res.json() as any };
}

let projectId = "";
let otherProjectId = "";
let taskId = "";
let tsBeforeEvidence = "";

beforeAll(async () => {
  projectId = (await post("/api/projects", { name: "feed-proj", repo_path: "/tmp/x" })).json.id;
  otherProjectId = (await post("/api/projects", { name: "other-proj", repo_path: "/tmp/y" })).json.id;

  // A scout task so we can check kind enrichment too.
  taskId = (await post("/api/tasks", { project_id: projectId, title: "Feed source task", kind: "scout" })).json.id;
  await sleep(5);
  await post(`/api/tasks/${taskId}/events`, { type: "status", note: "digging in" }); // lifecycle
  await sleep(5);
  await post(`/api/tasks/${taskId}/transition`, { to: "in_progress" }); // state_change
  await sleep(5);
  tsBeforeEvidence = new Date().toISOString();
  await sleep(5);

  // evidence (screenshot) via multipart upload
  const form = new FormData();
  form.set("type", "evidence");
  form.set("kind", "screenshot");
  form.set("caption", "board screenshot");
  form.set("file", new File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" }));
  await fetch(`${BASE}/api/tasks/${taskId}/events`, { method: "POST", body: form });

  // an unrelated task in a different project (project-filter check)
  const t2 = (await post("/api/tasks", { project_id: otherProjectId, title: "Other task" })).json.id;
  await post(`/api/tasks/${t2}/events`, { type: "status", note: "elsewhere" });
});

test("feed enriches each event with task title, kind, and project name", async () => {
  const { json } = await get("/api/feed");
  const row = json.events.find((e: any) => e.task_id === taskId && e.type === "status");
  expect(row).toBeTruthy();
  expect(row.task_title).toBe("Feed source task");
  expect(row.task_kind).toBe("scout");
  expect(row.project_name).toBe("feed-proj");
  expect(row.project_id).toBe(projectId);
});

test("feed is reverse-chronological (newest first)", async () => {
  const { json } = await get("/api/feed");
  const ts = json.events.map((e: any) => e.ts);
  const sorted = [...ts].sort().reverse();
  expect(ts).toEqual(sorted);
});

test("evidence events carry the evidence url for inline thumbnails", async () => {
  const { json } = await get("/api/feed?types=evidence");
  const ev = json.events.find((e: any) => e.type === "evidence");
  expect(ev).toBeTruthy();
  expect(ev.evidence_url).toStartWith(`/evidence/${taskId}/`);
  expect(ev.evidence_kind).toBe("screenshot");
  // non-evidence categories excluded
  expect(json.events.every((e: any) => e.type === "evidence" || e.type === "smoke_passed")).toBe(true);
});

test("types filter narrows to a category", async () => {
  const state = await get("/api/feed?types=state");
  expect(state.json.events.length).toBeGreaterThan(0);
  expect(state.json.events.every((e: any) => e.type === "state_change")).toBe(true);

  const life = await get("/api/feed?types=lifecycle");
  expect(life.json.events.some((e: any) => e.type === "status")).toBe(true);
  expect(life.json.events.some((e: any) => e.type === "state_change")).toBe(false);

  // an unknown category yields nothing
  const none = await get("/api/feed?types=nonsense");
  expect(none.json.events).toEqual([]);
});

test("since filter returns only newer events", async () => {
  const { json } = await get(`/api/feed?since=${encodeURIComponent(tsBeforeEvidence)}`);
  expect(json.events.length).toBeGreaterThan(0);
  expect(json.events.every((e: any) => e.ts > tsBeforeEvidence)).toBe(true);
  // the evidence event (created after the cutoff) is present
  expect(json.events.some((e: any) => e.type === "evidence")).toBe(true);
  // the earlier status event is gone
  expect(json.events.some((e: any) => e.type === "status" && e.task_id === taskId)).toBe(false);
});

test("project filter scopes to one project", async () => {
  const { json } = await get(`/api/feed?project=${projectId}`);
  expect(json.events.length).toBeGreaterThan(0);
  expect(json.events.every((e: any) => e.project_id === projectId)).toBe(true);
});

test("limit caps the number of rows and is itself capped at 500", async () => {
  const two = await get("/api/feed?limit=2");
  expect(two.json.events.length).toBe(2);

  // an over-cap limit is accepted (clamped) and still returns rows
  const big = await get("/api/feed?limit=99999");
  expect(big.json.events.length).toBeGreaterThan(0);
  expect(big.json.events.length).toBeLessThanOrEqual(500);
});

// ---- standalone monitor incidents folded into the feed ----
let incidentTs = "";
test("standalone monitor incidents appear in the feed with a type tag", async () => {
  incidentTs = new Date().toISOString();
  db.query("INSERT INTO incidents (id, project_id, monitor, ts, status, detail) VALUES (?,?,?,?,?,?)").run(
    "inc_open1", projectId, "homepage", incidentTs, "open", "expected status 200, got 503"
  );
  db.query("INSERT INTO incidents (id, project_id, monitor, ts, status, detail) VALUES (?,?,?,?,?,?)").run(
    "inc_other", otherProjectId, "otherme", new Date().toISOString(), "open", "down"
  );

  const { json } = await get("/api/feed");
  const inc = json.events.find((e: any) => e.id === "inc_open1");
  expect(inc).toBeTruthy();
  expect(inc.type).toBe("incident");
  expect(inc.task_id).toBeNull();
  expect(inc.source).toBe("monitor");
  expect(inc.project_name).toBe("feed-proj");
  expect(inc.payload.monitor).toBe("homepage");
  expect(inc.payload.status).toBe("open");
  expect(inc.payload.detail).toContain("503");
});

test("feed stays reverse-chronological with incidents merged in", async () => {
  const { json } = await get("/api/feed");
  const ts = json.events.map((e: any) => e.ts);
  expect(ts).toEqual([...ts].sort().reverse());
});

test("incident category includes standalone incidents; other categories exclude them", async () => {
  const inc = await get("/api/feed?types=incident");
  expect(inc.json.events.some((e: any) => e.id === "inc_open1")).toBe(true);

  const state = await get("/api/feed?types=state");
  expect(state.json.events.some((e: any) => e.type === "incident")).toBe(false);
});

test("project filter scopes incidents too", async () => {
  const { json } = await get(`/api/feed?project=${projectId}`);
  expect(json.events.some((e: any) => e.id === "inc_open1")).toBe(true);
  expect(json.events.some((e: any) => e.id === "inc_other")).toBe(false);
  expect(json.events.every((e: any) => e.project_id === projectId)).toBe(true);
});

test("since filter respects incident timestamps", async () => {
  const cutoff = new Date(Date.parse(incidentTs) - 1000).toISOString();
  const { json } = await get(`/api/feed?since=${encodeURIComponent(cutoff)}`);
  expect(json.events.some((e: any) => e.id === "inc_open1")).toBe(true);

  const future = new Date(Date.now() + 60000).toISOString();
  const later = await get(`/api/feed?since=${encodeURIComponent(future)}`);
  expect(later.json.events.some((e: any) => e.id === "inc_open1")).toBe(false);
});
