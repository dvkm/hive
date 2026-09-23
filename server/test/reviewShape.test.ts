import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HIVE_HOME = mkdtempSync(join(tmpdir(), "hive-reviewshape-"));

const { openDb } = await import("../src/db.ts");
const { makeHandler } = await import("../src/api.ts");
const { REVIEW_SUMMARY_HELP, REVIEW_SUMMARY_EXAMPLE } = await import("../src/reviewShape.ts");

const db = openDb(":memory:");
const handler = makeHandler(db);

async function post(path: string, body: unknown) {
  const res = await handler(new Request("http://127.0.0.1" + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
  return { status: res.status, json: (await res.json()) as any };
}

async function newTask() {
  const p = await post("/api/projects", { name: "p", repo_path: "/repo" });
  const t = await post("/api/tasks", { project_id: p.json.id, title: "t", brief: "b" });
  return t.json.id as string;
}

// The whole failure mode was documentation drifting from behaviour, so the help
// and the endpoint are checked against ONE example (hive-1947).
test("the documented review_summary example is stored as written", async () => {
  const r = await post(`/api/tasks/${await newTask()}/events`, { type: "review_summary", ...REVIEW_SUMMARY_EXAMPLE });
  expect(r.status).toBe(201);
  expect(r.json.event.payload.understanding).toEqual(REVIEW_SUMMARY_EXAMPLE.understanding);
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

// Agents still on an older brief send understanding checks. Their review is
// accepted, the explanation fields are kept, and the checks are dropped.
test("a review that still carries check/checks is accepted and the checks are dropped", async () => {
  const r = await post(`/api/tasks/${await newTask()}/events`, {
    type: "review_summary",
    done: ["shipped"],
    understanding: {
      background: "Drafts were lost.",
      check: { question: "Which one?", options: ["yes", "no"], answer_key: "yes" },
      checks: [{ question: "What wins?", options: [{ key: "a", label: "The newest edit." }], answer_key: "a" }],
    },
  });
  expect(r.status).toBe(201);
  expect(r.json.event.payload.understanding).toEqual({ background: "Drafts were lost." });
});
