import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "hive-search-test-"));
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
let taskExact = "";
let taskPrefix = "";
let taskBody = "";

beforeAll(async () => {
  projectId = (await post("/api/projects", { name: "widget", repo_path: "/tmp/x" })).json.id;

  // Three tasks that all match "widget" but at different ranks.
  taskExact = (await post("/api/tasks", { project_id: projectId, title: "widget" })).json.id;
  taskPrefix = (await post("/api/tasks", { project_id: projectId, title: "widget resizer", brief: "b" })).json.id;
  taskBody = (await post("/api/tasks", { project_id: projectId, title: "unrelated title", brief: "mentions widget deep in the brief text" })).json.id;

  // One of every other entity type, all mentioning "widget".
  await post("/api/decisions", { task_id: taskExact, title: "ship the widget?", context: "context here", options: [{ key: "yes", label: "Yes" }] });
  await post("/api/learnings", { project_id: projectId, title: "widget flakiness", body: "root cause", kind: "failure" });
  await post("/api/policies", { title: "widget policy", body: "always test widgets" });
});

test("returns typed hits across all five entity types", async () => {
  const { json } = await get("/api/search?q=widget");
  const types = new Set(json.hits.map((h: any) => h.type));
  for (const t of ["task", "decision", "learning", "policy", "project"]) {
    expect(types.has(t)).toBe(true);
  }
});

test("tasks carry task_state and project_id", async () => {
  const { json } = await get("/api/search?q=widget");
  const hit = json.hits.find((h: any) => h.type === "task" && h.id === taskExact);
  expect(hit.task_state).toBe("queued");
  expect(hit.project_id).toBe(projectId);
});

test("ranking: exact title beats prefix beats body-only", async () => {
  const { json } = await get("/api/search?q=widget");
  const tasks = json.hits.filter((h: any) => h.type === "task").map((h: any) => h.id);
  expect(tasks.indexOf(taskExact)).toBeLessThan(tasks.indexOf(taskPrefix));
  expect(tasks.indexOf(taskPrefix)).toBeLessThan(tasks.indexOf(taskBody));
});

test("body-only match produces a snippet around the term", async () => {
  const { json } = await get("/api/search?q=widget");
  const hit = json.hits.find((h: any) => h.id === taskBody);
  expect(hit.snippet.toLowerCase()).toContain("widget");
});

test("empty query returns no hits", async () => {
  const { json } = await get("/api/search?q=");
  expect(json.hits).toEqual([]);
});

test("limit caps results and is itself capped at 50", async () => {
  const one = await get("/api/search?q=widget&limit=1");
  expect(one.json.hits.length).toBe(1);
  const big = await get("/api/search?q=widget&limit=99999");
  expect(big.json.hits.length).toBeLessThanOrEqual(50);
});

test("LIKE wildcards in the query are treated literally", async () => {
  const { json } = await get("/api/search?q=%25");
  // '%' must not act as a wildcard matching everything.
  expect(json.hits.length).toBe(0);
});
