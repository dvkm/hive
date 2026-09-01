// hive-1992: two agents that both wrote the shared /tmp/review.json published
// each other's reviews. A --json payload read from outside the emitting agent's
// own worktree or session scratchpad is refused, not warned about.
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HIVE_HOME = mkdtempSync(join(tmpdir(), "hive-payloadpath-"));

const { openDb } = await import("../src/db.ts");
const { makeHandler } = await import("../src/api.ts");

const db = openDb(":memory:");
// Call the handler directly instead of standing up a real HTTP server.
// HIVE-591: bun 1.3.14's global fetch pool keeps sockets alive past the server
// that owned them, and the OS hands freed ephemeral ports straight back to the
// next `Bun.serve({ port: 0 })`, so a request can go out on a dead socket and
// get an empty/null/never-arriving response. No port, no socket, no pool, no
// flake.
const handler = makeHandler(db);

async function post(path: string, body: unknown) {
  const res = await handler(
    new Request("http://127.0.0.1" + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
  return { status: res.status, json: (await res.json()) as any };
}

const project = (await post("/api/projects", { name: "hive", repo_path: "/repo" })).json.id;

async function agentTask(worktree: string) {
  const t = (await post("/api/tasks", { project_id: project, title: "t", brief: "b" })).json;
  db.query("UPDATE tasks SET worktree_path = ? WHERE id = ?").run(worktree, t.id);
  return t;
}

const review = (what: string) => ({ type: "review_summary", done: [what] });

test("two agents sharing /tmp/review.json: the second emit is refused, not published", async () => {
  const a = await agentTask("/Users/d/.herdr/worktrees/hive/aaa");
  const b = await agentTask("/Users/d/.herdr/worktrees/hive/bbb");

  const first = await post(`/api/tasks/${a.id}/events`, { ...review("adfToText emits inlineCard URLs"), payload_path: "/tmp/review.json" });
  const second = await post(`/api/tasks/${b.id}/events`, { ...review("quota fix"), payload_path: "/tmp/review.json" });

  expect(first.status).toBe(400);
  expect(second.status).toBe(400);
  expect(second.json.error).toContain("/tmp/review.json");
  // Nothing was stored under either task, so no review can describe the other's change.
  for (const t of [a, b]) {
    const rows = db.query("SELECT * FROM events WHERE task_id = ? AND type = 'review_summary'").all(t.id);
    expect(rows).toHaveLength(0);
  }
});

test("the shared /tmp/claude-501 root is refused too", async () => {
  const t = await agentTask("/Users/d/.herdr/worktrees/hive/ccc");
  const r = await post(`/api/tasks/${t.id}/events`, { ...review("x"), payload_path: "/tmp/claude-501/review.json" });
  expect(r.status).toBe(400);
});

test("an emit from the agent's own worktree or session scratchpad still works", async () => {
  const worktree = "/Users/d/.herdr/worktrees/hive/ddd";
  const t = await agentTask(worktree);

  const fromWorktree = await post(`/api/tasks/${t.id}/events`, { ...review("from worktree"), payload_path: `${worktree}/review.json` });
  expect(fromWorktree.status).toBe(201);

  const slug = worktree.replace(/[^A-Za-z0-9]/g, "-");
  const fromScratchpad = await post(`/api/tasks/${t.id}/events`, {
    ...review("from scratchpad"),
    payload_path: `/private/tmp/claude-501/${slug}/15073c3e-f2be/scratchpad/review.json`,
  });
  expect(fromScratchpad.status).toBe(201);
});

test("a payload stamped with another task's id is refused", async () => {
  const mine = await agentTask("/Users/d/.herdr/worktrees/hive/eee");
  const other = await agentTask("/Users/d/.herdr/worktrees/hive/fff");

  const wrong = await post(`/api/tasks/${mine.id}/events`, { ...review("x"), task_id: other.id });
  expect(wrong.status).toBe(400);
  expect(wrong.json.error).toContain(other.id);

  const right = await post(`/api/tasks/${mine.id}/events`, { ...review("x"), task_id: mine.id });
  expect(right.status).toBe(201);
});

test("a direct API caller with no path is unaffected", async () => {
  const t = await agentTask("/Users/d/.herdr/worktrees/hive/ggg");
  expect((await post(`/api/tasks/${t.id}/events`, review("no path"))).status).toBe(201);
});
