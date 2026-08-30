// Intake-triage funnel coverage (HIVE-411). HIVE-410 built the classifier and
// wired it; this pins down WHERE it runs, so a new intake path can't quietly
// skip the director's "which reading?" gate — and an existing one can't start
// asking twice about the same task.
//
// One classification per task, per funnel:
//   POST /api/tasks with an ambient source  → classified
//   Google Chat connector                   → classified
//   doc watcher                             → classified (see watch.test.ts too)
//   POST /api/intake (braindump)            → NOT classified, on purpose
//   any project without config.intake_triage → NOT classified
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "hive-funnels-"));
process.env.HIVE_HOME = HOME;

const { openDb, newId, now } = await import("../src/db.ts");
const { makeHandler } = await import("../src/api.ts");
const { pollGchatOnce, resetGchatState } = await import("../src/intake/gchat.ts");
import type { GchatSecrets, FetchLike } from "../src/intake/gchat.ts";
const { checkWatcher } = await import("../src/watch.ts");
const { triageHold } = await import("../src/intake/triage.ts");
const { isReviewed } = await import("../src/dispatcher.ts");
const { getTask } = await import("../src/state.ts");
import type { DB } from "../src/db.ts";

const AMBIGUOUS = {
  bucket: "decision_required",
  reasoning: "faster could mean the load time or the refresh rate",
  question: "Which slowness should we fix first?",
  interpretations: [
    { key: "first-load", label: "First page load", detail: "Cut the time before anything appears." },
    { key: "refresh", label: "Live refresh", detail: "Cut the delay between updates." },
  ],
  recommendation: "first-load",
};

// A counting classifier stub. `calls` is the whole point of these tests.
function counter(verdict: any = AMBIGUOUS) {
  const calls: string[] = [];
  const exec = async (argv: string[]) => {
    calls.push(argv.join(" "));
    return { code: 0, stdout: JSON.stringify({ result: JSON.stringify(verdict) }), stderr: "", timedOut: false };
  };
  return { calls, exec };
}

function project(db: DB, config: any): string {
  const id = newId("proj");
  db.query("INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)").run(
    id, "p", "/repo", JSON.stringify(config), now()
  );
  return id;
}

const triageEvents = (db: DB, taskId: string) =>
  db.query("SELECT 1 FROM events WHERE task_id = ? AND type = 'intake_triage'").all(taskId).length;
const openCards = (db: DB, taskId: string) =>
  db.query("SELECT * FROM decisions WHERE task_id = ? AND status = 'open'").all(taskId) as any[];

// The classifier is fired and not awaited at every funnel, so give its
// microtasks a tick to land before asserting.
const settle = () => new Promise((r) => setTimeout(r, 10));

const SECRETS: GchatSecrets = { clientId: "id", clientSecret: "sec", refreshToken: "rt", self: "users/me" };
const gchatFetch = (text: string): FetchLike =>
  (async (input: any) => {
    const u = String(input);
    if (u.includes("oauth2.googleapis.com/token"))
      return new Response(JSON.stringify({ access_token: "at", expires_in: 3600 }), { status: 200 });
    if (u.includes("/messages?"))
      return new Response(
        JSON.stringify({
          messages: [{
            name: "spaces/AAA/messages/M1.M1",
            text,
            sender: { name: "users/henry", displayName: "Henry", type: "HUMAN" },
            createTime: "2026-07-09T10:00:00Z",
          }],
        }),
        { status: 200 }
      );
    return new Response("{}", { status: 200 });
  }) as unknown as FetchLike;

const watchFetch = (body: string) =>
  (async () => new Response(body, { status: 200, headers: { "content-type": "text/plain" } })) as any;

test("POST /api/tasks: an ambient-source task is classified exactly once", async () => {
  const db = openDb(":memory:");
  const { calls, exec } = counter();
  const server = Bun.serve({ port: 0, fetch: makeHandler(db, { triageExec: exec }) });
  try {
    const pid = project(db, { intake_triage: true });
    const res = await fetch(`http://127.0.0.1:${server.port}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: pid, title: "make the dashboard faster", brief: "the dashboard feels slow", source: "intake_gchat" }),
    });
    const task = await res.json();
    await settle();

    expect(calls.length).toBe(1);
    expect(triageEvents(db, task.id)).toBe(1);
    expect(openCards(db, task.id).length).toBe(1);
    expect(triageHold(db, getTask(db, task.id))).toBe(true);
  } finally {
    server.stop(true);
  }
});

test("Google Chat: one message is classified exactly once", async () => {
  resetGchatState();
  const db = openDb(":memory:");
  const { calls, exec } = counter();
  project(db, { intake_triage: true, gchat_spaces: [{ space: "spaces/AAA" }] });

  const r = await pollGchatOnce(db, {
    fetch: gchatFetch("make the dashboard faster"),
    secrets: SECRETS,
    notify: false,
    triageExec: exec,
  });
  expect(r.created).toBe(1);
  await settle();

  const task = db.query("SELECT * FROM tasks WHERE source = 'intake_gchat'").get() as any;
  expect(calls.length).toBe(1);
  expect(triageEvents(db, task.id)).toBe(1);
  expect(triageHold(db, getTask(db, task.id))).toBe(true);
});

test("doc watcher: one changed doc is classified exactly once", async () => {
  const db = openDb(":memory:");
  const { calls, exec } = counter();
  const pid = project(db, { intake_triage: true });
  const w = { name: "spec", url: "https://example.com/spec" };

  await checkWatcher(db, pid, w, { triageExec: exec, fetchImpl: watchFetch("v1\n") }); // baseline: no task
  expect(calls.length).toBe(0);

  await checkWatcher(db, pid, w, { triageExec: exec, fetchImpl: watchFetch("v2\n") }); // changed: one task
  await settle();

  const task = db.query("SELECT * FROM tasks WHERE source = 'watch'").get() as any;
  expect(task).toBeTruthy();
  expect(calls.length).toBe(1);
  expect(triageEvents(db, task.id)).toBe(1);
});

// The director typed the braindump themselves and the planner already asks them
// to approve a breakdown. A triage card on top of that is a second question
// about one thought.
test("braindump: never classified, so the director is asked once, not twice", async () => {
  const db = openDb(":memory:");
  const { calls, exec } = counter();
  // The planner is a subprocess too; stub it so this test spawns nothing.
  const server = Bun.serve({
    port: 0,
    fetch: makeHandler(db, { triageExec: exec, plannerExec: async () => ({ code: 1, stdout: "", stderr: "stubbed", timedOut: false }) }),
  });
  try {
    const pid = project(db, { intake_triage: true });
    const res = await fetch(`http://127.0.0.1:${server.port}/api/intake`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: pid, text: "make the dashboard faster" }),
    });
    const { task } = await res.json();
    await settle();

    expect(task.source).toBe("intake_braindump");
    expect(calls.length).toBe(0);
    expect(triageEvents(db, task.id)).toBe(0);
    expect(openCards(db, task.id).length).toBe(0);
  } finally {
    server.stop(true);
  }
});

// Every other project — corebeat included — must be untouched until its config
// says otherwise. This is the switch that keeps the rollout to hive alone.
test("a project without intake_triage is never classified, on any funnel", async () => {
  resetGchatState();
  const db = openDb(":memory:");
  const { calls, exec } = counter();
  const pid = project(db, { gchat_spaces: [{ space: "spaces/AAA" }] }); // no intake_triage

  await pollGchatOnce(db, { fetch: gchatFetch("make the dashboard faster"), secrets: SECRETS, notify: false, triageExec: exec });
  const w = { name: "spec", url: "https://example.com/spec" };
  await checkWatcher(db, pid, w, { triageExec: exec, fetchImpl: watchFetch("v1\n") });
  await checkWatcher(db, pid, w, { triageExec: exec, fetchImpl: watchFetch("v2\n") });
  await settle();

  expect(calls.length).toBe(0);
  expect(db.query("SELECT 1 FROM events WHERE type = 'intake_triage'").all().length).toBe(0);
  expect(db.query("SELECT 1 FROM decisions").all().length).toBe(0);
});

// The point of the whole feature: the director's answer is what unblocks the
// work, and the agent builds the reading they picked.
test("answering the card releases the task and appends the chosen reading", async () => {
  const db = openDb(":memory:");
  const { exec } = counter();
  const { herdr } = await import("../src/runtime/herdr.ts");
  const { apiAnswerDecision } = await import("../src/api.ts");
  const server = Bun.serve({ port: 0, fetch: makeHandler(db, { triageExec: exec }) });
  try {
    const pid = project(db, { intake_triage: true, auto_dispatch: true });
    const res = await fetch(`http://127.0.0.1:${server.port}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: pid, title: "make the dashboard faster", brief: "the dashboard feels slow", source: "intake_gchat" }),
    });
    const { id } = await res.json();
    await settle();

    const card = openCards(db, id)[0];
    expect(triageHold(db, getTask(db, id))).toBe(true);
    expect(isReviewed(db, id)).toBe(false);

    const answered = apiAnswerDecision(db, herdr, card.id, { answer_key: "refresh", source: "director" });
    expect(answered.status).toBe(200);

    // Released: reviewed, no open card, nothing holding it back from the next
    // dispatcher cycle.
    expect(isReviewed(db, id)).toBe(true);
    expect(triageHold(db, getTask(db, id))).toBe(false);
    expect(openCards(db, id).length).toBe(0);
    // ...and the agent is told which reading won.
    const brief = getTask(db, id).brief;
    expect(brief).toContain("Director's answer");
    expect(brief).toContain("Which slowness should we fix first?");
    expect(brief).toContain("Live refresh");
    expect(brief).toContain("the dashboard feels slow"); // original brief kept
  } finally {
    server.stop(true);
  }
});
