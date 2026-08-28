// HIVE-402: the verification contract enforced at the in_progress -> in_review
// handoff. Every route funnels through transition(), so the gate lives there.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "hive-verify-gate-"));
process.env.HIVE_HOME = HOME;

const { openDb } = await import("../src/db.ts");
const { makeHandler } = await import("../src/api.ts");
const { transition, writeEvent, getTask, TransitionError, missingVerifications } = await import("../src/state.ts");

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
  return { status: res.status, json: (await res.json()) as any };
}

const CMDS = [
  { name: "unit", cmd: "bun test" },
  { name: "typecheck", cmd: "bun run tsc --noEmit" },
];

let projectId = "";
beforeAll(async () => {
  projectId = (await post("/api/projects", { name: "gate-proj", repo_path: "/tmp/gp" })).json.id;
});

// A task sitting in in_progress with a PR, ready to be handed off.
let seq = 0;
async function workingTask(cmds: unknown = CMDS): Promise<string> {
  const title = `Gated ${++seq}`; // distinct titles: same-title tasks get deduped
  const id = (await post("/api/tasks", { project_id: projectId, title, verification_cmds: cmds })).json.id;
  await post(`/api/tasks/${id}/transition`, { to: "in_progress" });
  db.query("UPDATE tasks SET pr_url = ? WHERE id = ?").run("https://example.com/pr/1", id);
  return id;
}

let evSeq = 0;
function attach(taskId: string, verifyName: string | null) {
  const evId = `ev_${++evSeq}`;
  db.query("INSERT INTO evidence (id, task_id, ts, kind, caption) VALUES (?,?,?,?,?)")
    .run(evId, taskId, new Date().toISOString(), "log", verifyName ?? "note");
  writeEvent(db, {
    task_id: taskId,
    source: "agent",
    type: "evidence",
    payload: { evidence_id: evId, kind: "log", ...(verifyName ? { verify_name: verifyName } : {}) },
  });
}

test("handoff is blocked and the 409 names exactly the missing commands", async () => {
  const id = await workingTask();
  attach(id, "unit"); // one of two

  const res = await post(`/api/tasks/${id}/transition`, { to: "in_review" });
  expect(res.status).toBe(409);
  expect(res.json.error).toContain("typecheck");
  expect(res.json.error).not.toContain("unit,"); // 'unit' is satisfied, not listed
  expect(getTask(db, id).state).toBe("in_progress");

  // ...and the gap is on the event log for the agent's next steer.
  const events = db
    .query("SELECT payload FROM events WHERE task_id = ? AND type = 'verification_missing'")
    .all(id) as { payload: string }[];
  expect(events.length).toBe(1);
  expect(JSON.parse(events[0].payload).names).toEqual(["typecheck"]);
});

test("handoff passes once every named command has evidence", async () => {
  const id = await workingTask();
  attach(id, "unit");
  attach(id, "typecheck");

  const res = await post(`/api/tasks/${id}/transition`, { to: "in_review" });
  expect(res.status).toBe(200);
  expect(getTask(db, id).state).toBe("in_review");
});

test("a task with no contract is never gated", async () => {
  const id = await workingTask(null);
  expect((await post(`/api/tasks/${id}/transition`, { to: "in_review" })).status).toBe(200);
});

test("evidence from before the newest commit is stale and rejected", async () => {
  const id = await workingTask();
  attach(id, "unit");
  attach(id, "typecheck");
  // A new commit lands after that evidence: hive learns its sha from a
  // pr_synchronized event and stamps it on the task. The sleeps put real time
  // between the rows — timestamps are millisecond strings, and a same-tick tie
  // counts as fresh by design.
  await Bun.sleep(2);
  writeEvent(db, { task_id: id, source: "reconciler", type: "pr_synchronized", payload: { head_sha: "deadbee" } });
  db.query("UPDATE tasks SET head_sha = ? WHERE id = ?").run("deadbee", id);

  expect(missingVerifications(db, getTask(db, id))).toEqual(["unit", "typecheck"]);
  const stale = await post(`/api/tasks/${id}/transition`, { to: "in_review" });
  expect(stale.status).toBe(409);
  expect(stale.json.error).toContain("unit");
  expect(stale.json.error).toContain("typecheck");

  // Re-run both against the new commit and the handoff goes through.
  await Bun.sleep(2);
  attach(id, "unit");
  attach(id, "typecheck");
  expect((await post(`/api/tasks/${id}/transition`, { to: "in_review" })).status).toBe(200);
});

test("the agent's own `ready` emit is gated the same way", async () => {
  const id = await workingTask();
  // No PR: the emit path's CI and explanation gates step aside, so what is left
  // to hold the handoff is the verification contract alone.
  db.query("UPDATE tasks SET pr_url = NULL WHERE id = ?").run(id);
  attach(id, "unit");
  const res = await post(`/api/tasks/${id}/events`, { type: "ready", note: "handing off" });
  expect(res.status).toBe(409);
  expect(res.json.error).toContain("typecheck");
  expect(getTask(db, id).state).toBe("in_progress");
});

test("the missing-names event is written once per distinct gap, not per attempt", async () => {
  const id = await workingTask();
  for (let i = 0; i < 3; i++) await post(`/api/tasks/${id}/transition`, { to: "in_review" });
  const n = (db
    .query("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = 'verification_missing'")
    .get(id) as { n: number }).n;
  expect(n).toBe(1);

  // A different gap IS recorded.
  attach(id, "unit");
  await post(`/api/tasks/${id}/transition`, { to: "in_review" });
  const after = (db
    .query("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = 'verification_missing'")
    .get(id) as { n: number }).n;
  expect(after).toBe(2);
});

test("a merged-PR catch-up may skip the gate, since holding it would strand the task", async () => {
  const id = await workingTask();
  expect(() => transition(db, id, "in_review", { source: "reconciler" })).toThrow(TransitionError);
  transition(db, id, "in_review", { source: "reconciler", skipVerification: true });
  expect(getTask(db, id).state).toBe("in_review");
});
