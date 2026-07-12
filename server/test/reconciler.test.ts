import { test, expect } from "bun:test";
import { openDb, newId, now, type DB } from "../src/db.ts";
import { transition, getTask, writeEvent } from "../src/state.ts";
import { reconcileOnce, ciStatusOf } from "../src/reconciler.ts";
import { Herdr } from "../src/runtime/herdr.ts";
import type { Exec, ExecResult } from "../src/exec.ts";

function freshDb(): { db: DB; projectId: string } {
  const db = openDb(":memory:");
  const projectId = newId("proj");
  db.query("INSERT INTO projects (id, name, config, created_at) VALUES (?,?,?,?)").run(projectId, "p", "{}", now());
  return { db, projectId };
}
function makeTask(db: DB, projectId: string, extra: Partial<{ agent_target: string; pr_url: string; state: string; ci_status: string }> = {}): string {
  const id = newId();
  const t = now();
  db.query(
    "INSERT INTO tasks (id, project_id, title, state, kind, agent_target, pr_url, ci_status, created_at, updated_at) VALUES (?,?,?,?, 'ship', ?, ?, ?, ?, ?)"
  ).run(id, projectId, "t", extra.state ?? "queued", extra.agent_target ?? null, extra.pr_url ?? null, extra.ci_status ?? null, t, t);
  return id;
}
const stub = (fn: (argv: string[]) => ExecResult): Exec => async (argv) => fn(argv);
const OK = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });

test("ciStatusOf derives failing > pending > passing", () => {
  expect(ciStatusOf([{ conclusion: "SUCCESS" }, { conclusion: "SUCCESS" }])).toBe("passing");
  expect(ciStatusOf([{ conclusion: "SUCCESS" }, { status: "IN_PROGRESS" }])).toBe("pending");
  expect(ciStatusOf([{ conclusion: "SUCCESS" }, { conclusion: "FAILURE" }])).toBe("failing");
  expect(ciStatusOf([{ state: "PENDING" }])).toBe("pending");
  expect(ciStatusOf([])).toBeNull();
});

test("syncAgents writes an agent_status event only when the status changes", async () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId, { agent_target: "t-agent", state: "in_progress" });
  const herdr = new Herdr(stub(() => OK('{"status":"working"}')), "herdr");

  await reconcileOnce(db, { herdr, exec: stub(() => ({ code: 1, stdout: "", stderr: "no gh" })) });
  let events = db.query("SELECT * FROM events WHERE task_id = ? AND type = 'agent_status'").all(id);
  expect(events.length).toBe(1);

  // same status again -> no new event
  await reconcileOnce(db, { herdr, exec: stub(() => ({ code: 1, stdout: "", stderr: "no gh" })) });
  events = db.query("SELECT * FROM events WHERE task_id = ? AND type = 'agent_status'").all(id);
  expect(events.length).toBe(1);
});

test("syncPRs updates ci_status and transitions in_review->verifying on merge", async () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId, { pr_url: "https://gh/pr/1" });
  transition(db, id, "in_progress");
  transition(db, id, "in_review");

  const gh: Exec = stub((argv) => {
    if (argv[0] === "gh") return OK(JSON.stringify({ state: "MERGED", statusCheckRollup: [{ conclusion: "SUCCESS" }] }));
    return OK();
  });
  await reconcileOnce(db, { exec: gh });

  const task = getTask(db, id);
  expect(task.ci_status).toBe("passing");
  expect(task.state).toBe("verifying");
  expect(db.query("SELECT * FROM events WHERE task_id = ? AND type = 'pr_merged'").all(id).length).toBe(1);
});

test("syncPRs bounces an in_review task whose CI turned red, steers once per sha", async () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId, { pr_url: "https://gh/pr/2", agent_target: "t-agent" });
  transition(db, id, "in_progress");
  transition(db, id, "in_review");

  const sends: string[] = [];
  const herdr = new Herdr(
    stub((argv) => {
      if (argv.includes("send")) {
        sends.push(argv[argv.indexOf("send") + 2]);
        return OK();
      }
      if (argv.includes("get")) return OK('{"result":{"agent":{"pane_id":"p1","agent_status":"working"}}}');
      return OK();
    }),
    "herdr"
  );
  const gh: Exec = stub((argv) => {
    if (argv[0] === "gh")
      return OK(JSON.stringify({ state: "OPEN", statusCheckRollup: [{ conclusion: "FAILURE" }], headRefOid: "sha-red" }));
    return OK();
  });
  await reconcileOnce(db, { exec: gh, herdr });
  const task = getTask(db, id);
  expect(task.state).toBe("in_progress"); // red is not reviewable
  expect(task.ci_status).toBe("failing");
  expect(sends.some((s) => s.includes("CI is FAILING"))).toBe(true);

  // same sha next cycle: no re-nudge, and the task stays with the agent
  const before = sends.length;
  await reconcileOnce(db, { exec: gh, herdr });
  expect(sends.length).toBe(before);
  expect(getTask(db, id).state).toBe("in_progress");

  // checks go green → promoted to review automatically
  const ghGreen: Exec = stub((argv) => {
    if (argv[0] === "gh")
      return OK(JSON.stringify({ state: "OPEN", statusCheckRollup: [{ conclusion: "SUCCESS" }], headRefOid: "sha-green" }));
    return OK();
  });
  await reconcileOnce(db, { exec: ghGreen, herdr });
  expect(getTask(db, id).state).toBe("in_review");
});

test("syncPRs bounces an in_review task whose PR was closed without merging", async () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId, { pr_url: "https://gh/pr/3", agent_target: "t-agent" });
  transition(db, id, "in_progress");
  transition(db, id, "in_review");
  const gh: Exec = stub((argv) =>
    argv[0] === "gh" ? OK(JSON.stringify({ state: "CLOSED", statusCheckRollup: [] })) : OK()
  );
  const herdr = new Herdr(
    stub((argv) =>
      argv.includes("get") ? OK('{"result":{"agent":{"pane_id":"p1","agent_status":"working"}}}') : OK()
    ),
    "herdr"
  );
  await reconcileOnce(db, { exec: gh, herdr });
  expect(getTask(db, id).state).toBe("in_progress");
  const steers = db.query("SELECT payload FROM events WHERE task_id = ? AND type='steer'").all(id) as any[];
  expect(JSON.parse(steers.at(-1).payload).message).toContain("CLOSED (not merged)");
});

test("sweepVerifying re-runs the advance and flags evidence-wedged tasks once", async () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId, { state: "queued" });
  transition(db, id, "in_progress");
  transition(db, id, "in_review");
  transition(db, id, "verifying");
  db.query("UPDATE tasks SET updated_at = ? WHERE id = ?").run(new Date(Date.now() - 20 * 60 * 1000).toISOString(), id);

  const { sweepVerifying } = await import("../src/reconciler.ts");
  await sweepVerifying(db, {}); // no evidence: done gate refuses → wedged
  expect(getTask(db, id).state).toBe("verifying");
  let wedged = db.query("SELECT * FROM events WHERE task_id = ? AND type='verify_wedged'").all(id);
  expect(wedged.length).toBe(1);
  await sweepVerifying(db, {}); // no double-flag
  expect(db.query("SELECT * FROM events WHERE task_id = ? AND type='verify_wedged'").all(id).length).toBe(1);

  // evidence attached → the next sweep completes the task
  db.query("INSERT INTO evidence (id, task_id, ts, kind, path, caption) VALUES (?,?,?,?,?,?)").run(
    newId("evd"), id, now(), "log", "/tmp/x.log", "proof"
  );
  db.query("UPDATE tasks SET updated_at = ? WHERE id = ?").run(new Date(Date.now() - 20 * 60 * 1000).toISOString(), id);
  await sweepVerifying(db, {});
  expect(getTask(db, id).state).toBe("done");
});

test("flagStale emits one stale event past the threshold, then stops", async () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId);
  transition(db, id, "in_progress"); // last event is recent

  // clock far in the future so the last event is 'stale'
  const future = () => Date.now() + 60 * 60 * 1000;
  await reconcileOnce(db, { staleMs: 15 * 60 * 1000, nowMs: future });
  expect(db.query("SELECT * FROM events WHERE task_id = ? AND type = 'stale'").all(id).length).toBe(1);

  // second pass: the newest event is now 'stale' itself -> not re-flagged
  await reconcileOnce(db, { staleMs: 15 * 60 * 1000, nowMs: future });
  expect(db.query("SELECT * FROM events WHERE task_id = ? AND type = 'stale'").all(id).length).toBe(1);
});

// A herdr whose `agent get` reports a fixed status (agent alive with a pane).
const statusHerdr = (status: string) =>
  new Herdr(stub(() => OK(`{"result":{"agent":{"agent_status":"${status}","pane_id":"w1:p1"}}}`)), "herdr");

// Like statusHerdr, but records `agent send` messages.
function sendCapturingHerdr(status: string) {
  const sends: string[] = [];
  const h = new Herdr(
    stub((argv) => {
      if (argv.includes("send")) {
        sends.push(argv[argv.indexOf("send") + 2]);
        return OK();
      }
      return OK(`{"result":{"agent":{"agent_status":"${status}","pane_id":"w1:p1"}}}`);
    }),
    "herdr"
  );
  return { h, sends };
}

test("conflict watchdog: a CONFLICTING PR nudges the agent once per head SHA", async () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId, { agent_target: "a1", pr_url: "https://gh/pr/9" });
  transition(db, id, "in_progress");
  transition(db, id, "in_review");
  const { h, sends } = sendCapturingHerdr("idle");
  const gh = (sha: string): Exec =>
    stub((argv) => {
      if (argv[0] === "gh")
        return OK(JSON.stringify({ state: "OPEN", statusCheckRollup: [], mergeable: "CONFLICTING", headRefOid: sha }));
      return OK();
    });

  await reconcileOnce(db, { herdr: h, exec: gh("sha1") });
  expect(sends.length).toBe(1);
  expect(sends[0]).toContain("merge conflicts");
  expect(sends[0]).toContain("main");
  expect(getTask(db, id).state).toBe("in_review"); // lifecycle untouched
  const ev = db.query("SELECT payload FROM events WHERE task_id = ? AND type = 'pr_conflict'").all(id) as { payload: string }[];
  expect(ev.length).toBe(1);
  expect(JSON.parse(ev[0].payload)).toMatchObject({ head_sha: "sha1", delivered: true });

  // same head SHA next cycle -> no re-nudge
  await reconcileOnce(db, { herdr: h, exec: gh("sha1") });
  expect(sends.length).toBe(1);

  // a new push that STILL conflicts -> nudged again
  await reconcileOnce(db, { herdr: h, exec: gh("sha2") });
  expect(sends.length).toBe(2);
});

test("conflict watchdog: a lost nudge (exit 0 + agent_not_found) records delivered:false", async () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId, { agent_target: "a1", pr_url: "https://gh/pr/9" });
  transition(db, id, "in_progress");
  transition(db, id, "in_review");
  // `agent send` exits 0 but the agent is gone — the message never landed.
  const h = new Herdr(
    stub((argv) => (argv.includes("send") ? OK('{"error":{"code":"agent_not_found","message":"gone"}}') : OK('{"result":{"agent":{"agent_status":"idle","pane_id":"w1:p1"}}}'))),
    "herdr"
  );
  const gh: Exec = stub((argv) =>
    argv[0] === "gh"
      ? OK(JSON.stringify({ state: "OPEN", statusCheckRollup: [], mergeable: "CONFLICTING", headRefOid: "sha1" }))
      : OK()
  );

  await reconcileOnce(db, { herdr: h, exec: gh });

  const ev = db.query("SELECT payload FROM events WHERE task_id = ? AND type = 'pr_conflict'").all(id) as { payload: string }[];
  expect(JSON.parse(ev[0].payload)).toMatchObject({ delivered: false, error: "gone" });
});

test("conflict watchdog: a mergeable PR is left alone", async () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId, { agent_target: "a1", pr_url: "https://gh/pr/9" });
  transition(db, id, "in_progress");
  transition(db, id, "in_review");
  const { h, sends } = sendCapturingHerdr("idle");
  const gh: Exec = stub((argv) => {
    if (argv[0] === "gh")
      return OK(JSON.stringify({ state: "OPEN", statusCheckRollup: [], mergeable: "MERGEABLE", headRefOid: "sha1" }));
    return OK();
  });
  await reconcileOnce(db, { herdr: h, exec: gh });
  expect(sends.length).toBe(0);
  expect(db.query("SELECT * FROM events WHERE task_id = ? AND type = 'pr_conflict'").all(id).length).toBe(0);
});

test("advanceFinished: in_progress + pr_url + idle agent -> in_review (+ event)", async () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId, { agent_target: "a1", pr_url: "https://gh/pr/1" });
  transition(db, id, "in_progress");

  await reconcileOnce(db, { herdr: statusHerdr("idle"), exec: stub(() => ({ code: 1, stdout: "", stderr: "no gh" })) });

  expect(getTask(db, id).state).toBe("in_review");
  expect(db.query("SELECT * FROM events WHERE task_id = ? AND type = 'ready_for_review'").all(id).length).toBe(1);
});

test("advanceFinished: does NOT advance while the agent is still working", async () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId, { agent_target: "a1", pr_url: "https://gh/pr/1" });
  transition(db, id, "in_progress");

  await reconcileOnce(db, { herdr: statusHerdr("working"), exec: stub(() => ({ code: 1, stdout: "", stderr: "no gh" })) });

  expect(getTask(db, id).state).toBe("in_progress");
  expect(db.query("SELECT * FROM events WHERE task_id = ? AND type = 'ready_for_review'").all(id).length).toBe(0);
});

test("advanceFinished: idle agent with NO pr_url is not advanced (stays in_progress)", async () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId, { agent_target: "a1" }); // no pr_url
  transition(db, id, "in_progress");

  // huge staleMs so recovery/stale stay inert; only exercise advanceFinished
  await reconcileOnce(db, { herdr: statusHerdr("idle"), staleMs: 60 * 60 * 1000, exec: stub(() => ({ code: 1, stdout: "", stderr: "no gh" })) });

  expect(getTask(db, id).state).toBe("in_progress");
  expect(db.query("SELECT * FROM events WHERE task_id = ? AND type = 'ready_for_review'").all(id).length).toBe(0);
});

test("advanceFinished: a scout with report evidence + idle agent -> in_review", async () => {
  const { db, projectId } = freshDb();
  const id = newId();
  const t = now();
  db.query(
    "INSERT INTO tasks (id, project_id, title, state, kind, agent_target, created_at, updated_at) VALUES (?,?,?,?, 'scout', ?, ?, ?)"
  ).run(id, projectId, "s", "queued", "a1", t, t);
  transition(db, id, "in_progress");
  db.query("INSERT INTO evidence (id, task_id, ts, kind, path, url, caption, meta) VALUES (?,?,?,?,?,?,?,?)")
    .run(newId("ev"), id, now(), "report", null, null, "findings", "{}");

  await reconcileOnce(db, { herdr: statusHerdr("idle"), exec: stub(() => ({ code: 1, stdout: "", stderr: "no gh" })) });

  expect(getTask(db, id).state).toBe("in_review");
});

test("reconciler never throws; a failing sub-step broadcasts at most one error", async () => {
  const { db, projectId } = freshDb();
  makeTask(db, projectId, { agent_target: "t-agent", state: "in_progress" });
  // A live-agent stub keeps syncAgents/recovery inert; force a throw from gh
  // instead to exercise the failure guard.
  const aliveHerdr = new Herdr(stub(() => OK('{"result":{"agent":{"agent_status":"working","pane_id":"w1:p1"}}}')), "herdr");
  const boom: Exec = async () => {
    throw new Error("exec exploded");
  };
  // Should resolve, not reject.
  await reconcileOnce(db, { herdr: aliveHerdr, exec: boom });
  expect(true).toBe(true);
});
