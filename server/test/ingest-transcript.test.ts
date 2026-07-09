import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "hive-ingest-tx-test-"));
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

let taskId = "";
beforeAll(async () => {
  const p = await post("/api/projects", { name: "tx-proj", repo_path: "/tmp/x" });
  taskId = (await post("/api/tasks", { project_id: p.json.id, title: "tx task" })).json.id;
});

test("assistant_text is ingested with its payload preserved", async () => {
  const r = await post(`/api/tasks/${taskId}/events`, {
    type: "assistant_text",
    source: "hook",
    payload: { text: "hello from the agent" },
  });
  expect(r.status).toBe(201);
  expect(r.json.event.type).toBe("assistant_text");
  expect(r.json.event.payload.text).toBe("hello from the agent");
  expect(r.json.event.source).toBe("hook");
});

test("tool_use is ingested with tool + summary payload", async () => {
  const r = await post(`/api/tasks/${taskId}/events`, {
    type: "tool_use",
    source: "hook",
    payload: { tool: "Bash", summary: "git status" },
  });
  expect(r.status).toBe(201);
  expect(r.json.event.payload).toEqual({ tool: "Bash", summary: "git status" });
});

test("agent_turn_end is accepted as a quiet lifecycle heartbeat", async () => {
  const r = await post(`/api/tasks/${taskId}/events`, { type: "agent_turn_end", source: "hook" });
  expect(r.status).toBe(201);
  expect(r.json.event.type).toBe("agent_turn_end");
});

test("all three land on the task event stream", async () => {
  const r = await get(`/api/tasks/${taskId}/events`);
  const types = r.json.map((e: any) => e.type);
  expect(types).toContain("assistant_text");
  expect(types).toContain("tool_use");
  expect(types).toContain("agent_turn_end");
});
