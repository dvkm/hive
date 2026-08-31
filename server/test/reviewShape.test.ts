import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HIVE_HOME = mkdtempSync(join(tmpdir(), "hive-reviewshape-"));

const { openDb } = await import("../src/db.ts");
const { makeHandler } = await import("../src/api.ts");
const { REVIEW_SUMMARY_HELP, REVIEW_SUMMARY_EXAMPLE } = await import("../src/reviewShape.ts");

const db = openDb(":memory:");
const server = Bun.serve({ port: 0, fetch: makeHandler(db) });
const BASE = `http://127.0.0.1:${server.port}`;

async function post(path: string, body: unknown) {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any };
}

async function newTask() {
  const p = await post("/api/projects", { name: "p", repo_path: "/repo" });
  const t = await post("/api/tasks", { project_id: p.json.id, title: "t", brief: "b" });
  return t.json.id as string;
}

// The whole failure mode was documentation drifting from behaviour, so the help
// and the endpoint are checked against ONE example (hive-1947).
test("the documented review_summary example mints a quiz", async () => {
  const r = await post(`/api/tasks/${await newTask()}/events`, { type: "review_summary", ...REVIEW_SUMMARY_EXAMPLE });
  expect(r.status).toBe(201);
  const checks = r.json.event.payload.understanding.checks;
  expect(checks).toHaveLength(REVIEW_SUMMARY_EXAMPLE.understanding.checks.length);
  expect(checks[0].options[0]).toEqual({ key: "a", label: expect.any(String) });
  expect(checks[0].answer_key).toBe("a");
});

test("hive --help names every key the example uses", () => {
  const keys = new Set<string>();
  const walk = (value: unknown) => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (value && typeof value === "object")
      for (const [k, v] of Object.entries(value)) {
        keys.add(k);
        walk(v);
      }
  };
  walk(REVIEW_SUMMARY_EXAMPLE);
  for (const key of keys) expect(REVIEW_SUMMARY_HELP).toContain(key);
});

test("an understanding block with unusable checks is rejected, naming the shape", async () => {
  const taskId = await newTask();
  // Exactly the shape the old help documented: bare-string options.
  const r = await post(`/api/tasks/${taskId}/events`, {
    type: "review_summary",
    done: ["shipped"],
    understanding: { background: "b", check: { question: "Which one?", options: ["yes", "no"], answer_key: "yes" } },
  });
  expect(r.status).toBe(400);
  expect(r.json.error).toContain("options entries must be {key,label} objects");
});

test("a singular check object is stored as checks[]", async () => {
  const r = await post(`/api/tasks/${await newTask()}/events`, {
    type: "review_summary",
    understanding: { check: REVIEW_SUMMARY_EXAMPLE.understanding.checks[0] },
  });
  expect(r.status).toBe(201);
  expect(r.json.event.payload.understanding.checks).toHaveLength(1);
  expect(r.json.event.payload.understanding.check).toBeUndefined();
});

test("an understanding block with no checks at all is still accepted", async () => {
  const r = await post(`/api/tasks/${await newTask()}/events`, {
    type: "review_summary",
    done: ["shipped"],
    understanding: { background: "Drafts were lost.", essence: "The newest edit wins." },
  });
  expect(r.status).toBe(201);
  expect(r.json.event.payload.understanding.checks).toBeUndefined();
});

test.afterAll?.(() => server.stop(true));
