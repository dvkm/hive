import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "hive-spawn-"));
process.env.HIVE_HOME = HOME;

const { openDb } = await import("../src/db.ts");
const { makeHandler } = await import("../src/api.ts");
const { Herdr } = await import("../src/runtime/herdr.ts");
import type { Exec, ExecResult } from "../src/exec.ts";

const OK = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });

// A stub herdr that records send() calls and returns a canned spawn.
function stubHerdr(sendResult: ExecResult = OK()) {
  const sends: { target: string; message: string }[] = [];
  const exec: Exec = async (argv) => {
    if (argv.includes("create")) return OK('{"path":"/wt/hive-x","branch":"hive/x","workspace":"w1"}');
    if (argv.includes("send")) {
      sends.push({ target: argv[argv.indexOf("send") + 1], message: argv[argv.indexOf("send") + 2] });
      return sendResult;
    }
    return OK();
  };
  return { herdr: new Herdr(exec, "herdr"), sends };
}

const db = openDb(":memory:");
let server: any;
let BASE = "";
let projectId = "";
let taskId = "";
const { herdr, sends } = stubHerdr();

beforeAll(async () => {
  server = Bun.serve({ port: 0, fetch: makeHandler(db, { herdr }) });
  BASE = `http://127.0.0.1:${server.port}`;
  const p = await (await fetch(BASE + "/api/projects", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "p", repo_path: "/repo", config: { default_branch: "main" } }),
  })).json();
  projectId = p.id;
  const t = await (await fetch(BASE + "/api/tasks", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project_id: projectId, title: "spawn me" }),
  })).json();
  taskId = t.id;
});
afterAll(() => server.stop(true));

async function post(path: string, body: unknown) {
  const res = await fetch(BASE + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
}
async function get(path: string) {
  const res = await fetch(BASE + path);
  return { status: res.status, json: await res.json() };
}

test("spawn endpoint starts the agent and moves the task to in_progress", async () => {
  const r = await post(`/api/tasks/${taskId}/spawn`, {});
  expect(r.status).toBe(200);
  expect(r.json.ok).toBe(true);
  expect(r.json.agent_target).toBe(taskId);

  const task = await get(`/api/tasks/${taskId}`);
  expect(task.json.state).toBe("in_progress");
  expect(task.json.agent_target).toBe(taskId);
  expect(task.json.branch).toBe("hive/x");
  expect(task.json.worktree_path).toBe("/wt/hive-x");
  expect(task.json.events.some((e: any) => e.type === "spawned")).toBe(true);
});

test("spawn refuses a project without a repo_path", async () => {
  const p = await post("/api/projects", { name: "norepo" });
  const t = await post("/api/tasks", { project_id: p.json.id, title: "x" });
  const r = await post(`/api/tasks/${t.json.id}/spawn`, {});
  expect(r.status).toBe(400);
  expect(r.json.error).toContain("repo_path");
});

test("send delivers to a spawned agent via herdr", async () => {
  const r = await post(`/api/tasks/${taskId}/send`, { message: "focus on the API" });
  expect(r.status).toBe(200);
  expect(r.json).toEqual({ ok: true, delivered: true, message: "focus on the API" });
  expect(sends.at(-1)).toEqual({ target: taskId, message: "focus on the API" });
});

test("send degrades gracefully when the task has no agent (records event, surfaces error)", async () => {
  const t = await post("/api/tasks", { project_id: projectId, title: "unspawned" });
  const r = await post(`/api/tasks/${t.json.id}/send`, { message: "hi" });
  expect(r.status).toBe(200);
  expect(r.json.ok).toBe(false);
  expect(r.json.delivered).toBe(false);
  expect(r.json.error).toContain("no agent_target");
  // the steer event is still recorded
  const events = await get(`/api/tasks/${t.json.id}/events`);
  expect(events.json.some((e: any) => e.type === "steer")).toBe(true);
});

test("send surfaces a herdr failure without throwing", async () => {
  const { herdr: failHerdr } = stubHerdr({ code: 1, stdout: "", stderr: "agent not found" });
  const db2 = openDb(":memory:");
  const srv = Bun.serve({ port: 0, fetch: makeHandler(db2, { herdr: failHerdr }) });
  const base2 = `http://127.0.0.1:${srv.port}`;
  const p = await (await fetch(base2 + "/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "p2", repo_path: "/r" }) })).json();
  const t = await (await fetch(base2 + "/api/tasks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project_id: p.id, title: "t" }) })).json();
  await fetch(base2 + `/api/tasks/${t.id}/spawn`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  const res = await fetch(base2 + `/api/tasks/${t.id}/send`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "go" }) });
  const jsonBody = await res.json();
  expect(jsonBody.ok).toBe(false);
  expect(jsonBody.error).toContain("agent not found");
  srv.stop(true);
});

test("incidents endpoint returns the documented shape", async () => {
  // seed an incident directly
  db.query("INSERT INTO incidents (id, project_id, monitor, ts, status, detail) VALUES (?,?,?,?,?,?)")
    .run("inc_test", projectId, "homepage", new Date().toISOString(), "open", "503");
  const r = await get("/api/incidents?status=open");
  expect(Array.isArray(r.json.incidents)).toBe(true);
  const inc = r.json.incidents.find((i: any) => i.id === "inc_test");
  expect(inc).toMatchObject({ id: "inc_test", project_id: projectId, monitor: "homepage", status: "open", detail: "503" });
  expect(typeof inc.ts).toBe("string");
});

test("secrets API stores names/metadata only (no values)", async () => {
  const r = await post(`/api/projects/${projectId}/secrets`, { name: "API_KEY", provider: "keychain", ref: `hive/${projectId}/API_KEY` });
  expect(r.status).toBe(201);
  expect(r.json).not.toHaveProperty("ref");
  expect(r.json).not.toHaveProperty("value");
  const list = await get(`/api/projects/${projectId}/secrets`);
  expect(list.json.secrets.some((s: any) => s.name === "API_KEY" && s.provider === "keychain")).toBe(true);
  // no value/ref leaks in the list
  expect(JSON.stringify(list.json)).not.toContain("value");

  const del = await fetch(BASE + `/api/projects/${projectId}/secrets/API_KEY`, { method: "DELETE" });
  expect(del.status).toBe(200);
});
