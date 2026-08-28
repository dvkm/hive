import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "hive-playbook-"));
process.env.HIVE_HOME = HOME;

const { openDb } = await import("../src/db.ts");
const { makeHandler } = await import("../src/api.ts");
const { extractPlaybook } = await import("../src/playbook.ts");
const { writeEvent } = await import("../src/state.ts");
import type { PlannerExec } from "../src/planner.ts";

const db = openDb(":memory:");

const VALID = JSON.stringify({
  title: "Add an endpoint backed by a learnings row",
  when_to_use: "You need to persist a distilled artifact without adding a table.",
  steps: ["Reuse addReference in learn.ts", "Add the route in api.ts", "Add the CLI subcommand"],
  gotchas: ["addReference dedupes on title, so a rerun overwrites the body"],
  success_criteria: ["POST returns 201 and the row is readable via /api/learnings"],
});

// Records the argv it saw and returns canned stdout, so the test never shells
// out to a real model.
function stubExec(stdout: string): { exec: PlannerExec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: PlannerExec = async (argv) => {
    calls.push(argv);
    return { code: 0, stdout, stderr: "" };
  };
  return { exec, calls };
}

let server: any;
let BASE = "";
let projectId = "";

beforeAll(async () => {
  server = Bun.serve({ port: 0, fetch: makeHandler(db, { plannerExec: stubExec(VALID).exec }) });
  BASE = `http://127.0.0.1:${server.port}`;
  const p = await (await fetch(BASE + "/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "acme", repo_path: "/repo" }),
  })).json();
  projectId = p.id;
});
afterAll(() => server.stop(true));

async function mkTask(done: boolean) {
  const t = await (await fetch(BASE + "/api/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project_id: projectId, title: "Prune push subscriptions", brief: "Drop unauthenticated rows." }),
  })).json();
  if (done) db.query("UPDATE tasks SET state = 'done' WHERE id = ?").run(t.id);
  return t;
}

test("a done task distils into a well-formed [playbook] reference row", async () => {
  const t = await mkTask(true);
  writeEvent(db, { task_id: t.id, source: "agent", type: "status", payload: { note: "wrote the pruner" } });
  writeEvent(db, { task_id: t.id, source: "agent", type: "checkpoint", payload: { note: "kept it a single sweep" } });

  const res = await fetch(BASE + `/api/tasks/${t.id}/playbook`, { method: "POST", body: "{}" });
  expect(res.status).toBe(201);
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(body.playbook.title).toBe("Add an endpoint backed by a learnings row");

  const row: any = db.query("SELECT * FROM learnings WHERE id = ?").get(body.learning_id);
  expect(row.kind).toBe("reference");
  expect(row.project_id).toBe(projectId);
  expect(row.source_task_id).toBe(t.id);
  expect(row.title).toBe("Add an endpoint backed by a learnings row");
  expect(row.body.startsWith("[playbook] ")).toBe(true);
  // The JSON round-trips out of the fenced block, which is what makes the row
  // machine-readable and not just prose.
  const fenced = row.body.match(/```json\n([\s\S]*?)\n```/);
  expect(fenced).not.toBeNull();
  expect(JSON.parse(fenced![1]).steps).toEqual([
    "Reuse addReference in learn.ts",
    "Add the route in api.ts",
    "Add the CLI subcommand",
  ]);
});

test("the prompt carries the brief and the key events", async () => {
  const stub = stubExec(VALID);
  const s = Bun.serve({ port: 0, fetch: makeHandler(db, { plannerExec: stub.exec }) });
  try {
    const t = await mkTask(true);
    writeEvent(db, { task_id: t.id, source: "agent", type: "checkpoint", payload: { note: "reused the existing table" } });
    // An event type outside the key set must not reach the prompt.
    writeEvent(db, { task_id: t.id, source: "agent", type: "heartbeat", payload: { note: "still alive" } });
    const res = await fetch(`http://127.0.0.1:${s.port}/api/tasks/${t.id}/playbook`, { method: "POST", body: "{}" });
    expect(res.status).toBe(201);
    const prompt = stub.calls[0].find((a) => a.includes("Task #"))!;
    expect(prompt).toContain("Drop unauthenticated rows.");
    expect(prompt).toContain("reused the existing table");
    expect(prompt).not.toContain("still alive");
    expect(stub.calls[0]).toContain("sonnet");
  } finally {
    s.stop(true);
  }
});

test("a task that is not done is refused with 409", async () => {
  const t = await mkTask(false);
  const res = await fetch(BASE + `/api/tasks/${t.id}/playbook`, { method: "POST", body: "{}" });
  expect(res.status).toBe(409);
  const body = await res.json();
  expect(body.ok).toBe(false);
  expect(body.error).toContain("only a done task");
  expect(db.query("SELECT COUNT(*) c FROM learnings WHERE source_task_id = ?").get(t.id)).toEqual({ c: 0 });
});

test("an unknown task is a 404", async () => {
  const res = await fetch(BASE + "/api/tasks/nope/playbook", { method: "POST", body: "{}" });
  expect(res.status).toBe(404);
});

test("unusable model output is rejected rather than stored", async () => {
  const cases: [string, string][] = [
    ["prose with no JSON at all", "sorry, I could not do that"],
    ["missing title", JSON.stringify({ when_to_use: "x", steps: ["a"] })],
    ["empty steps", JSON.stringify({ title: "t", when_to_use: "x", steps: [] })],
  ];
  for (const [why, stdout] of cases) {
    const s = Bun.serve({ port: 0, fetch: makeHandler(db, { plannerExec: stubExec(stdout).exec }) });
    try {
      const t = await mkTask(true);
      const res = await fetch(`http://127.0.0.1:${s.port}/api/tasks/${t.id}/playbook`, { method: "POST", body: "{}" });
      expect([why, res.status]).toEqual([why, 502]);
      expect(db.query("SELECT COUNT(*) c FROM learnings WHERE source_task_id = ?").get(t.id)).toEqual({ c: 0 });
    } finally {
      s.stop(true);
    }
  }
});

test("extractPlaybook unwraps the --output-format json envelope", () => {
  const pb = extractPlaybook(JSON.stringify({ result: "Here you go:\n" + VALID }));
  expect(pb?.title).toBe("Add an endpoint backed by a learnings row");
  expect(pb?.gotchas.length).toBe(1);
  // Absent optional arrays normalize to empty, never undefined.
  const bare = extractPlaybook(JSON.stringify({ title: "t", when_to_use: "w", steps: ["s"] }));
  expect(bare?.gotchas).toEqual([]);
  expect(bare?.success_criteria).toEqual([]);
});

test("two tasks with the same model-generated title both survive, each keeping its own source task", async () => {
  const COLLIDE = JSON.stringify({
    title: "Prune a table safely",
    when_to_use: "You are deleting rows nothing else reads.",
    steps: ["Write the sweep", "Test it"],
  });
  const s = Bun.serve({ port: 0, fetch: makeHandler(db, { plannerExec: stubExec(COLLIDE).exec }) });
  try {
    const a = await mkTask(true);
    const b = await mkTask(true);
    const ra = await (await fetch(`http://127.0.0.1:${s.port}/api/tasks/${a.id}/playbook`, { method: "POST", body: "{}" })).json();
    const rb = await (await fetch(`http://127.0.0.1:${s.port}/api/tasks/${b.id}/playbook`, { method: "POST", body: "{}" })).json();

    expect(rb.learning_id).not.toBe(ra.learning_id);
    const rowA: any = db.query("SELECT * FROM learnings WHERE id = ?").get(ra.learning_id);
    const rowB: any = db.query("SELECT * FROM learnings WHERE id = ?").get(rb.learning_id);
    expect(rowA.source_task_id).toBe(a.id);
    expect(rowB.source_task_id).toBe(b.id);
    expect(rowA.title).toBe("Prune a table safely");
    expect(rowB.title).toBe(`Prune a table safely (task #${b.number})`);
    expect(rowA.body).toContain(`task #${a.number}`);
    expect(rowB.body).toContain(`task #${b.number}`);

    // Re-promoting the same task rewrites its own row instead of adding one.
    const again = await (await fetch(`http://127.0.0.1:${s.port}/api/tasks/${a.id}/playbook`, { method: "POST", body: "{}" })).json();
    expect(again.learning_id).toBe(ra.learning_id);
    expect(db.query("SELECT COUNT(*) c FROM learnings WHERE title LIKE 'Prune a table safely%'").get()).toEqual({ c: 2 });
  } finally {
    s.stop(true);
  }
});
