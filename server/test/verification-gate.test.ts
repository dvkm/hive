// HIVE-402: the verification contract enforced at the in_progress -> in_review
// handoff. Every route funnels through transition(), so the gate lives there.
import { test, expect, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "hive-verify-gate-"));
process.env.HIVE_HOME = HOME;

const { openDb } = await import("../src/db.ts");
const { makeHandler } = await import("../src/api.ts");
const { transition, writeEvent, getTask, TransitionError, missingVerifications } = await import("../src/state.ts");

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
  // No PR: the emit path's CI and explanation gates step aside. This task also
  // owes an understanding check and has filed none, so it trips both gates —
  // and the unmet contract is the one it must hear about (HIVE-580 stands
  // aside for it), not the quiz.
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

// HIVE-403: the same contract at the merge gate. A kind the project ships
// automatically is refused outright; any other kind is the director's call, but
// the response names what was never proven.
//
// mergeTask is called directly so the git side can be stubbed — the project's
// repo_path is a fixture, not a real checkout.
const { mergeTask } = await import("../src/api.ts");
const { Herdr } = await import("../src/runtime/herdr.ts");
const okExec = async (argv: string[]) => ({
  code: 0,
  stdout: argv.includes("rev-parse") ? (argv.at(-1) === "main" ? "base-sha\n" : "branch-sha\n") : argv.includes("symbolic-ref") ? "main\n" : "",
  stderr: "",
});
const herdr = new Herdr(okExec as any, "herdr");
const merge = (id: string) => mergeTask(db, herdr, id, {}, { exec: okExec as any });

async function inReviewTask(kind: string, projectConfig: unknown): Promise<string> {
  db.query("UPDATE projects SET config = ? WHERE id = ?").run(JSON.stringify(projectConfig), projectId);
  const title = `Merge ${++seq}`;
  const id = (await post("/api/tasks", { project_id: projectId, title, kind, verification_cmds: CMDS })).json.id;
  transition(db, id, "in_progress", { source: "director" });
  transition(db, id, "in_review", { source: "director", skipVerification: true });
  db.query("UPDATE tasks SET ci_status = 'passing', branch = 'hive/x' WHERE id = ?").run(id);
  // A kind outside auto_merge.kinds needs a passed understanding check before
  // merge, which is a separate gate — satisfy it so these tests observe the
  // verification contract alone.
  const review = writeEvent(db, {
    task_id: id,
    source: "agent",
    type: "review_summary",
    payload: {
      understanding: {
        check: { question: "Safe?", options: [{ key: "a", label: "Yes" }, { key: "b", label: "No" }], answer_key: "a" },
      },
    },
  });
  writeEvent(db, {
    task_id: id,
    source: "director",
    type: "understanding_quiz_passed",
    payload: { review_event_id: review.id, answer_key: "a" },
  });
  return id;
}

test("merging an auto-ship kind is refused while a declared verification has no evidence", async () => {
  const id = await inReviewTask("chore", { auto_merge: { kinds: ["chore"] } });
  attach(id, "unit"); // one of two

  const res = await merge(id);
  expect(res.status).toBe(409);
  expect((await res.json()).error).toContain("typecheck");
  expect(getTask(db, id).state).toBe("in_review");
});

test("a kind outside auto_merge.kinds still merges, and the response warns about the gap", async () => {
  const id = await inReviewTask("ship", { auto_merge: { kinds: ["chore"] } });
  attach(id, "unit"); // 'typecheck' never ran

  const res = await merge(id);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.warning).toContain("typecheck");
  expect(body.warning).not.toContain("unit,");
  expect(getTask(db, id).state).not.toBe("in_review"); // it landed
});

test("no warning once every declared verification has evidence", async () => {
  const id = await inReviewTask("ship", { auto_merge: { kinds: ["chore"] } });
  attach(id, "unit");
  attach(id, "typecheck");

  const res = await merge(id);
  expect(res.status).toBe(200);
  expect((await res.json()).warning).toBeUndefined();
});
