// HIVE-530: a refusal states the cause AND the next action. These lock in the
// wording for the refusals a person actually meets from a `hive <verb>` run, so
// changing one is a deliberate edit here rather than a surprise in CI.
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HIVE_HOME = mkdtempSync(join(tmpdir(), "hive-refusals-"));
const { openDb } = await import("../src/db.ts");
const { makeHandler } = await import("../src/api.ts");

const db = openDb(":memory:");
const server = Bun.serve({ port: 0, fetch: makeHandler(db) });
const BASE = `http://127.0.0.1:${server.port}`;
afterAll(() => server.stop(true));

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, error: String((await res.json()).error ?? "") };
}

test("a missing task is named, and the refusal says how to list tasks", async () => {
  const r = await call("POST", "/api/tasks/tsk_nope/events", { type: "status", note: "hi" });
  expect(r.status).toBe(404);
  expect(r.error).toBe("task tsk_nope not found. List them: hive task list --project <project-id>");
});

test("a missing project is named, and the refusal says how to list projects", async () => {
  const r = await call("POST", "/api/tasks", { project_id: "proj_nope", title: "x" });
  expect(r.status).toBe(400);
  expect(r.error).toBe("project proj_nope not found. List them: curl -s $HIVE_URL/api/projects");
});

test("the router's fallthrough names the route it could not find", async () => {
  const r = await call("GET", "/api/tasks/abc/nonsense");
  expect(r.status).toBe(404);
  expect(r.error).toContain("no API route for GET /api/tasks/abc/nonsense");
});

// One assertion per CLI verb whose refusal has to hand back a command.
const NEXT_COMMAND: [string, string, string, unknown, string][] = [
  ["hive task move", "POST", "/api/tasks/abc/transition", {}, "hive task move"],
  ["hive land", "POST", "/api/tasks/land-queue", { task_ids: [] }, "hive land"],
  ["hive decision ask", "POST", "/api/decisions", { task_id: "t", title: "x" }, "hive decision ask"],
  ["hive learning add", "POST", "/api/learnings", { title: "t" }, "hive learning add"],
  ["hive policy add", "POST", "/api/policies", { title: "t" }, "--body"],
  ["hive authority add", "POST", "/api/authority/rules", {}, "hive authority add"],
  ["hive steer-all", "POST", "/api/steer/broadcast", {}, "hive steer-all"],
  ["hive recall", "GET", "/api/knowledge", undefined, "hive recall"],
];
for (const [verb, method, path, body, expected] of NEXT_COMMAND) {
  test(`${verb} refusal names the next command`, async () => {
    const r = await call(method, path, body);
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.error).toContain(expected);
  });
}
