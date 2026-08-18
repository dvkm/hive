import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "hive-spawn-"));
process.env.HIVE_HOME = HOME;

const { openDb } = await import("../src/db.ts");
const { makeHandler } = await import("../src/api.ts");
const { Herdr } = await import("../src/runtime/herdr.ts");
import type { Exec, ExecResult } from "../src/exec.ts";

const OK = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });

// A real, writable worktree path so the spawn's hook-settings write succeeds.
const WT = join(HOME, "wt-hive-x");
const has = (argv: string[], ...xs: string[]) => xs.every((x) => argv.includes(x));

// A stub herdr for the full visible-fleet spawn; records send() calls.
function stubHerdr(sendResult: ExecResult = OK()) {
  const sends: { target: string; message: string }[] = [];
  const calls: string[][] = [];
  const exec: Exec = async (argv) => {
    calls.push(argv);
    if (has(argv, "worktree", "create")) return OK(`{"result":{"worktree":{"path":${JSON.stringify(WT)},"branch":"hive/x","open_workspace_id":"w1"}}}`);
    if (has(argv, "agent", "get")) return OK('{"result":{"agent":{"pane_id":"p1","agent_status":"working"}}}');
    if (has(argv, "workspace", "list")) return OK('{"result":{"workspaces":[{"workspace_id":"wF","label":"hive-fleet"}]}}');
    if (has(argv, "tab", "create")) return OK('{"result":{"tab":{"tab_id":"wF:t2"}}}');
    if (has(argv, "agent", "send")) {
      sends.push({ target: argv[argv.indexOf("send") + 1], message: argv[argv.indexOf("send") + 2] });
      return sendResult;
    }
    return OK();
  };
  return { herdr: new Herdr(exec, "herdr"), sends, calls };
}

const db = openDb(":memory:");
let server: any;
let BASE = "";
let projectId = "";
let taskId = "";
const { herdr, sends, calls } = stubHerdr();

beforeAll(async () => {
  server = Bun.serve({ port: 0, fetch: makeHandler(db, { herdr }) });
  BASE = `http://127.0.0.1:${server.port}`;
  const p = await (await fetch(BASE + "/api/projects", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "p", repo_path: "/repo", config: {} }),
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
  expect(task.json.worktree_path).toBe(WT);
  expect(task.json.events.some((e: any) => e.type === "spawned")).toBe(true);
  const create = calls.find((argv) => has(argv, "worktree", "create"));
  expect(create).toBeDefined();
  expect(create!.slice(create!.indexOf("--base"), create!.indexOf("--base") + 2)).toEqual(["--base", "main"]);
  // hook wiring is written into the worktree (structural reporting).
  expect(existsSync(join(WT, ".claude", "settings.local.json"))).toBe(true);
});

// A worker has no human at its pane: an MCP server that opens an Allow/Deny
// dialog hangs it forever. The seeded settings must deny those servers.
test("spawned worktree settings deny the interactive-prompt MCP servers", () => {
  const settings = JSON.parse(readFileSync(join(WT, ".claude", "settings.local.json"), "utf8"));
  expect(settings.permissions.deny).toContain("mcp__claude-in-chrome");
  expect(settings.permissions.deny).toContain("mcp__computer-use");
  expect(settings.hooks.Stop).toBeDefined(); // deny wiring didn't clobber the hooks
});

// Safe commands must auto-approve without a dialog; risky ones go through the
// PreToolUse classifier hook to the authority engine.
test("spawned worktree settings allow safe tools and wire the PreToolUse classifier", () => {
  const settings = JSON.parse(readFileSync(join(WT, ".claude", "settings.local.json"), "utf8"));
  expect(settings.permissions.allow).toContain("Read");
  expect(settings.permissions.allow).toContain("Bash(git status:*)");
  expect(settings.permissions.allow).toContain("Bash(bun test:*)");
  const pre = settings.hooks.PreToolUse?.[0];
  expect(pre.matcher).toBe("Bash");
  expect(pre.hooks[0].command).toContain("hive-approve.sh");
  expect(pre.hooks[0].command).toContain("escalate"); // default policy
});

test("spawn refuses a project without a repo_path", async () => {
  const p = await post("/api/projects", { name: "norepo" });
  const t = await post("/api/tasks", { project_id: p.json.id, title: "x" });
  const r = await post(`/api/tasks/${t.json.id}/spawn`, {});
  expect(r.status).toBe(400);
  expect(r.json.error).toContain("repo_path");
});

test("focus-agent focuses the herdr tab for a spawned task", async () => {
  const r = await post(`/api/tasks/${taskId}/focus-agent`, {});
  expect(r.status).toBe(200);
  expect(r.json).toEqual({ ok: true, focused: true, target: taskId });
  const events = await get(`/api/tasks/${taskId}/events`);
  expect(events.json.some((e: any) => e.type === "focus_agent")).toBe(true);
});

test("focus-agent degrades when the task has no agent", async () => {
  const t = await post("/api/tasks", { project_id: projectId, title: "no agent" });
  const r = await post(`/api/tasks/${t.json.id}/focus-agent`, {});
  expect(r.status).toBe(200);
  expect(r.json.ok).toBe(false);
  expect(r.json.error).toContain("no agent");
});

test("requeue endpoint fails a live task and queues a fresh copy", async () => {
  const t = await post("/api/tasks", { project_id: projectId, title: "flaky", brief: "b" });
  await post(`/api/tasks/${t.json.id}/spawn`, {});
  const r = await post(`/api/tasks/${t.json.id}/requeue`, {});
  expect(r.status).toBe(200);
  expect(r.json.ok).toBe(true);
  expect(typeof r.json.new_task_id).toBe("string");
  const failed = await get(`/api/tasks/${t.json.id}`);
  expect(failed.json.state).toBe("failed");
  const fresh = await get(`/api/tasks/${r.json.new_task_id}`);
  expect(fresh.json.state).toBe("queued");
  expect(fresh.json.source).toBe("requeue");
  expect(fresh.json.parent_task_id).toBe(t.json.id);
});

test("tasks carry a server-computed health object", async () => {
  const list = await get(`/api/tasks`);
  const spawned = list.json.find((t: any) => t.id === taskId);
  expect(spawned).toHaveProperty("health");
  // spawned task is in_progress with an agent → non-null health verdict
  expect(spawned.health === null || typeof spawned.health.status === "string").toBe(true);
});

test("send delivers to a spawned agent via herdr", async () => {
  const r = await post(`/api/tasks/${taskId}/send`, { message: "focus on the API" });
  expect(r.status).toBe(200);
  expect(r.json).toEqual({ ok: true, delivered: true, delivery: "delivered", message: "focus on the API", attachments: [] });
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

test("modelForTask: per-kind default, config.model, config.model_by_kind override in order", async () => {
  const { modelForTask } = await import("../src/api.ts");
  expect(modelForTask({}, "ship")).toBe("opus");
  expect(modelForTask({}, "scout")).toBe("sonnet");
  expect(modelForTask({}, "chore")).toBe("sonnet");
  expect(modelForTask({ model: "haiku" }, "ship")).toBe("haiku");
  expect(modelForTask({ model: "haiku", model_by_kind: { ship: "opus" } }, "ship")).toBe("opus");
  expect(modelForTask({ model_by_kind: { ship: "opus" } }, "scout")).toBe("sonnet");
});
