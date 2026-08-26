import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "hive-evidence-test-"));
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
let otherTaskId = "";

beforeAll(async () => {
  projectId = (await post("/api/projects", { name: "ev-proj", repo_path: "/tmp/x" })).json.id;
  otherProjectId = (await post("/api/projects", { name: "ev-other", repo_path: "/tmp/y" })).json.id;
  taskId = (await post("/api/tasks", { project_id: projectId, title: "Evidence task", kind: "ship" })).json.id;
  otherTaskId = (await post("/api/tasks", { project_id: otherProjectId, title: "Other task" })).json.id;

  // screenshot evidence (image)
  const shot = new FormData();
  shot.set("type", "evidence");
  shot.set("kind", "screenshot");
  shot.set("caption", "the board");
  shot.set("file", new File([new Uint8Array([1, 2, 3])], "board.png", { type: "image/png" }));
  await fetch(`${BASE}/api/tasks/${taskId}/events`, { method: "POST", body: shot });
  await sleep(5);

  // test_run evidence (multi-line text → inline preview)
  const run = new FormData();
  run.set("type", "evidence");
  run.set("kind", "test_run");
  run.set("caption", "42 passing");
  run.set(
    "file",
    new File(
      ["Test Suites: 8 passed\nTests: 42 passed, 0 failed\nTime: 3.1 s\nRan all suites.\n"],
      "tests.txt",
      { type: "text/plain" }
    )
  );
  await fetch(`${BASE}/api/tasks/${taskId}/events`, { method: "POST", body: run });
  await sleep(5);

  // evidence on the other project/task (filter checks)
  const other = new FormData();
  other.set("type", "evidence");
  other.set("kind", "screenshot");
  other.set("caption", "elsewhere");
  other.set("file", new File([new Uint8Array([9])], "x.png", { type: "image/png" }));
  await fetch(`${BASE}/api/tasks/${otherTaskId}/events`, { method: "POST", body: other });
});

test("lists all evidence newest-first, joined to task + project", async () => {
  const { json } = await get("/api/evidence");
  expect(json.evidence.length).toBe(3);
  const ts = json.evidence.map((e: any) => e.ts);
  expect(ts).toEqual([...ts].sort().reverse());
  const row = json.evidence.find((e: any) => e.caption === "the board");
  expect(row.task_id).toBe(taskId);
  expect(row.task_title).toBe("Evidence task");
  expect(row.task_kind).toBe("ship");
  expect(row.project_id).toBe(projectId);
  expect(row.project_name).toBe("ev-proj");
});

test("test_run evidence carries a first-lines preview; images do not", async () => {
  const { json } = await get("/api/evidence?kind=test_run");
  const run = json.evidence.find((e: any) => e.kind === "test_run");
  expect(run.preview).toContain("Tests: 42 passed");
  expect(run.preview.split("\n").length).toBeLessThanOrEqual(3);

  const shots = await get("/api/evidence?kind=screenshot");
  expect(shots.json.evidence.every((e: any) => e.preview == null)).toBe(true);
});

test("kind filter narrows results", async () => {
  const { json } = await get("/api/evidence?kind=screenshot");
  expect(json.evidence.length).toBe(2);
  expect(json.evidence.every((e: any) => e.kind === "screenshot")).toBe(true);
});

test("project filter scopes to one project", async () => {
  const { json } = await get(`/api/evidence?project=${projectId}`);
  expect(json.evidence.length).toBe(2);
  expect(json.evidence.every((e: any) => e.project_id === projectId)).toBe(true);
});

test("task filter scopes to one task", async () => {
  const { json } = await get(`/api/evidence?task=${otherTaskId}`);
  expect(json.evidence.length).toBe(1);
  expect(json.evidence[0].task_id).toBe(otherTaskId);
});

test("limit is capped at 100", async () => {
  const { json } = await get("/api/evidence?limit=99999");
  expect(json.evidence.length).toBeLessThanOrEqual(100);
  expect(json.evidence.length).toBeGreaterThan(0);
});

// Regression: a malformed multipart part (name field, no `filename=`) parses in
// Bun as a File whose `.name` is undefined and `.size` is 0, which used to crash
// saveUpload with `undefined is not an object (evaluating 'file.name.replace')`.
test("empty nameless file part is dropped, event still ingests (no 500)", async () => {
  const form = new FormData();
  form.set("type", "evidence");
  form.set("note", "note-only with a malformed empty file part");
  form.set("file", new Blob([])); // no filename, zero bytes → File w/ name undefined
  const res = await fetch(`${BASE}/api/tasks/${taskId}/events`, { method: "POST", body: form });
  expect(res.status).toBe(201);
  const body = await res.json() as any;
  expect(body.evidence.path).toBeNull(); // junk part skipped, ingested as a log
});

test("nameless file WITH content is saved under a fallback name", async () => {
  const form = new FormData();
  form.set("type", "evidence");
  form.set("kind", "log");
  form.set("caption", "nameless log");
  form.set("file", new File(["real log content"], "")); // empty name → parses as undefined
  const res = await fetch(`${BASE}/api/tasks/${taskId}/events`, { method: "POST", body: form });
  expect(res.status).toBe(201);
  const body = await res.json() as any;
  expect(body.evidence.path).toContain("_file"); // stamped with the fallback name
});