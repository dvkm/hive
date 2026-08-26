import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "hive-proj-test-"));
process.env.HIVE_HOME = HOME;

const { openDb, setSetting } = await import("../src/db.ts");
const { makeHandler } = await import("../src/api.ts");

const TOKEN = "test-token";
const db = openDb(":memory:");
setSetting(db, "api_token", TOKEN); // PUT /api/projects/:id is write-gated
const server = Bun.serve({ port: 0, fetch: makeHandler(db) });
const BASE = `http://127.0.0.1:${server.port}`;
afterAll(() => server.stop(true));

async function post(path: string, body: unknown) {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() as any };
}
async function put(path: string, body: unknown) {
  const res = await fetch(BASE + path, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() as any };
}
async function get(path: string) {
  const res = await fetch(BASE + path);
  return { status: res.status, json: await res.json() as any };
}

let projectId = "";
beforeAll(async () => {
  const p = await post("/api/projects", { name: "proj-a", repo_path: "/tmp/a" });
  projectId = p.json.id;
});

test("GET /api/projects/:id returns the project", async () => {
  const one = await get(`/api/projects/${projectId}`);
  expect(one.status).toBe(200);
  expect(one.json.name).toBe("proj-a");
  expect(one.json.repo_path).toBe("/tmp/a");
  const missing = await get("/api/projects/nope");
  expect(missing.status).toBe(404);
});

test("PUT updates name, repo_path, and config", async () => {
  const upd = await put(`/api/projects/${projectId}`, {
    name: "proj-a-renamed",
    repo_path: "/tmp/a2",
    config: { auto_dispatch: true, max_agents: 5, dispatch_kinds: ["ship"] },
  });
  expect(upd.status).toBe(200);
  expect(upd.json.name).toBe("proj-a-renamed");
  expect(upd.json.repo_path).toBe("/tmp/a2");
  expect(upd.json.config.auto_dispatch).toBe(true);
  expect(upd.json.config.max_agents).toBe(5);
  expect(upd.json.config.dispatch_kinds).toEqual(["ship"]);

  // partial update leaves other fields intact
  const partial = await put(`/api/projects/${projectId}`, { name: "proj-a-again" });
  expect(partial.json.name).toBe("proj-a-again");
  expect(partial.json.repo_path).toBe("/tmp/a2");
  expect(partial.json.config.auto_dispatch).toBe(true);
});

test("archived projects are hidden from the default list, shown with ?archived=all", async () => {
  const b = await post("/api/projects", { name: "proj-b", repo_path: "/tmp/b" });
  const bId = b.json.id;

  // archive it via config
  await put(`/api/projects/${bId}`, { config: { archived: true } });

  const def = await get("/api/projects");
  expect(def.json.some((p: any) => p.id === bId)).toBe(false);
  expect(def.json.some((p: any) => p.id === projectId)).toBe(true);

  const all = await get("/api/projects?archived=all");
  expect(all.json.some((p: any) => p.id === bId)).toBe(true);

  // un-archive brings it back
  await put(`/api/projects/${bId}`, { config: { archived: false } });
  const def2 = await get("/api/projects");
  expect(def2.json.some((p: any) => p.id === bId)).toBe(true);
});
