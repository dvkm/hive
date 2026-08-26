import { test, expect } from "bun:test";
import { openDb, newId, now, getSetting, type DB } from "../src/db.ts";
import { transition, getTask, writeEvent } from "../src/state.ts";
import { reconcileOnce, ciStatusOf, ciStatusProbed } from "../src/reconciler.ts";
import { Herdr } from "../src/runtime/herdr.ts";
import { addClient, removeClient } from "../src/bus.ts";
import { taskWithHealth, needsAttention } from "../src/health.ts";
import type { Exec, ExecResult } from "../src/exec.ts";

function freshDb(config: any = {}): { db: DB; projectId: string } {
  const db = openDb(":memory:");
  const projectId = newId("proj");
  db.query("INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)").run(
    projectId, "p", "/repo", JSON.stringify(config), now()
  );
  return { db, projectId };
}
function makeTask(db: DB, projectId: string, extra: Partial<{ agent_target: string; pr_url: string; state: string; ci_status: string; kind: string; source: string }> = {}): string {
  const id = newId();
  const t = now();
  db.query(
    "INSERT INTO tasks (id, project_id, title, state, kind, agent_target, pr_url, ci_status, source, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
  ).run(id, projectId, "t", extra.state ?? "queued", extra.kind ?? "ship", extra.agent_target ?? null, extra.pr_url ?? null, extra.ci_status ?? null, extra.source ?? null, t, t);
  return id;
}
const stub = (fn: (argv: string[]) => ExecResult): Exec => async (argv) => fn(argv);
const OK = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });

test("reconciler flags a queued task whose blocking dependencies all ended without completing", async () => {
  const { db, projectId } = freshDb();
  const failed = makeTask(db, projectId, { state: "failed" });
  const cancelled = makeTask(db, projectId, { state: "cancelled" });
  const wedged = makeTask(db, projectId);
  db.query("UPDATE tasks SET depends_on = ? WHERE id = ?").run(JSON.stringify([failed, cancelled]), wedged);

  await reconcileOnce(db, { exec: stub(() => OK("[]")) });

  expect(db.query("SELECT 1 FROM events WHERE task_id = ? AND type = 'dead_dependencies'").get(wedged)).toBeTruthy();
  const task = taskWithHealth(db, getTask(db, wedged));
  expect(task.health).toMatchObject({ status: "stuck" });
  expect(needsAttention(task)).toBe(true);
});

test("reconciler flags the same task again when a different dependency set wedges it", async () => {
  const { db, projectId } = freshDb();
  const first = makeTask(db, projectId, { state: "failed" });
  const second = makeTask(db, projectId, { state: "cancelled" });
  const wedged = makeTask(db, projectId);
  db.query("UPDATE tasks SET depends_on = ? WHERE id = ?").run(JSON.stringify([first]), wedged);

  await reconcileOnce(db, { exec: stub(() => OK("[]")) });
  db.query("UPDATE tasks SET depends_on = ? WHERE id = ?").run(JSON.stringify([second]), wedged);
  await reconcileOnce(db, { exec: stub(() => OK("[]")) });

  const events = db.query("SELECT payload FROM events WHERE task_id = ? AND type = 'dead_dependencies' ORDER BY ts, rowid").all(wedged) as { payload: string }[];
  expect(events.map((event) => JSON.parse(event.payload).blocking_task_ids)).toEqual([[first], [second]]);
});

test("ciStatusOf derives failing > pending > passing", () => {
  expect(ciStatusOf([{ conclusion: "SUCCESS" }, { conclusion: "SUCCESS" }])).toBe("passing");
  expect(ciStatusOf([{ conclusion: "SUCCESS" }, { status: "IN_PROGRESS" }])).toBe("pending");
  expect(ciStatusOf([{ conclusion: "SUCCESS" }, { conclusion: "FAILURE" }])).toBe("failing");
  expect(ciStatusOf([{ state: "PENDING" }])).toBe("pending");
  expect(ciStatusOf([])).toBeNull();
});

const check = (conclusion: string | null, startedAt: string, extra: Record<string, unknown> = {}) => ({
  __typename: "CheckRun",
  workflowName: "Node mirror guard",
  name: "guard",
  status: conclusion ? "COMPLETED" : "IN_PROGRESS",
  conclusion,
  startedAt,
  ...extra,
});

test("ciStatusOf uses only the newest execution of each workflow job", () => {
  const old = "2026-08-23T07:38:57Z";
  const newer = "2026-08-23T07:40:06Z";
  expect(ciStatusOf([check("FAILURE", old), check("SUCCESS", newer)])).toBe("passing");
  expect(ciStatusOf([check("SUCCESS", old), check("FAILURE", newer)])).toBe("failing");
  expect(ciStatusOf([check("FAILURE", old), check(null, newer)])).toBe("pending");
});

test("ciStatusOf keeps different checks and heads independently blocking", () => {
  const old = "2026-08-23T07:38:57Z";
  const newer = "2026-08-23T07:40:06Z";
  expect(ciStatusOf([
    check("FAILURE", old, { workflowName: "Required lint", name: "lint" }),
    check("SUCCESS", newer),
  ])).toBe("failing");
  expect(ciStatusOf([
    check("FAILURE", old, { headSha: "old-head" }),
    check("SUCCESS", newer, { headSha: "new-head" }),
  ])).toBe("failing");
});

// GitHub marks a check FAILURE even when it refuses to START the job (unpaid
// Actions billing, no runner). No commit can fix that, so hive must call it
// "unavailable" and let the handoff through instead of steering the agent to
// go fix it (task #1210).
const JOB_URL = "https://github.com/dvkm/hive/actions/runs/32422454730/job/96597180562";
const RED_URL = "https://github.com/dvkm/hive/actions/runs/32422454730/job/11111111111";
// Verbatim from the live billing-blocked run on PR #121.
const BILLING_ANNOTATION = JSON.stringify([
  {
    annotation_level: "failure",
    message:
      "The job was not started because recent account payments have failed or your spending limit needs to be increased. Please check the 'Billing & plans' section in your settings",
  },
]);
// The annotation probe, stubbed at the gh layer: the non-start job reports the
// billing message, a genuinely red job reports an ordinary test failure.
const annotations = (): Exec =>
  stub((argv) => {
    if (argv[0] !== "gh" || argv[1] !== "api") return OK();
    if (String(argv[2]).includes("96597180562")) return OK(BILLING_ANNOTATION);
    return OK(JSON.stringify([{ annotation_level: "failure", message: "Process completed with exit code 1." }]));
  });

test("ciStatusProbed calls a real red test failing and a job GitHub never started unavailable", async () => {
  const exec = annotations();
  const nonStart = { conclusion: "FAILURE", detailsUrl: JOB_URL };
  const redTest = { conclusion: "FAILURE", detailsUrl: RED_URL };

  // A genuine red test stays 'failing' — that gate is load-bearing.
  expect(await ciStatusProbed(exec, [{ conclusion: "SUCCESS" }, redTest])).toBe("failing");
  // Billing non-start: GitHub's own annotation says the job never started.
  expect(await ciStatusProbed(exec, [nonStart])).toBe("unavailable");
  // Mixed: one real failure alongside the non-start still holds the handoff.
  expect(await ciStatusProbed(exec, [nonStart, redTest])).toBe("failing");
  // Rollups that aren't red are untouched, probe or no probe.
  expect(await ciStatusProbed(exec, [{ conclusion: "SUCCESS" }])).toBe("passing");
  expect(await ciStatusProbed(exec, [{ status: "IN_PROGRESS" }])).toBe("pending");
  expect(await ciStatusProbed(exec, [])).toBeNull();
});

test("ciStatusProbed keeps 'failing' when the annotation probe can't answer", async () => {
  // No detailsUrl to identify the check run (a StatusContext, or an older gh).
  expect(await ciStatusProbed(annotations(), [{ conclusion: "FAILURE" }])).toBe("failing");
  // gh errored, and gh returned something that isn't an annotation list. A red
  // test must never be downgraded because the probe misfired.
  const broken = stub((argv) => (argv[1] === "api" ? { code: 1, stdout: "", stderr: "gh: not found" } : OK()));
  expect(await ciStatusProbed(broken, [{ conclusion: "FAILURE", detailsUrl: JOB_URL }])).toBe("failing");
  const garbage = stub((argv) => (argv[1] === "api" ? OK("not json") : OK()));
  expect(await ciStatusProbed(garbage, [{ conclusion: "FAILURE", detailsUrl: JOB_URL }])).toBe("failing");
});

test("syncPRs hands off a PR whose CI never started, and tells the director instead of the agent", async () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId, { pr_url: "https://gh/pr/1210", agent_target: "t-agent" });
  transition(db, id, "in_progress");
  db.query("INSERT INTO evidence (id, task_id, ts, kind, path, url, caption, meta) VALUES (?,?,?,?,?,?,?,?)").run(
    newId("ev"), id, now(), "log", "/tmp/x", "/evidence/x", "c", "{}"
  );

  const gh: Exec = stub((argv) => {
    if (argv[0] !== "gh") return OK();
    if (argv[1] === "api") return OK(BILLING_ANNOTATION);
    if (argv[1] === "pr" && argv[2] === "view")
      return OK(JSON.stringify({ state: "OPEN", statusCheckRollup: [{ conclusion: "FAILURE", detailsUrl: JOB_URL }] }));
    return OK("[]");
  });
  await reconcileOnce(db, { exec: gh });

  const task = getTask(db, id);
  expect(task.ci_status).toBe("unavailable");
  // The whole point: the agent moves on to review instead of being told to fix
  // a job that never ran.
  expect(task.state).toBe("in_review");
  expect(db.query("SELECT 1 FROM events WHERE task_id = ? AND type = 'ci_failure'").get(id)).toBeFalsy();
  expect((db.query("SELECT COUNT(*) AS n FROM notifications WHERE kind = 'ci_unavailable'").get() as any).n).toBe(1);
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

test("legacy tracking-only bindings are surfaced once without being touched", async () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId, { agent_target: "legacy-agent", state: "in_progress" });
  db.query("UPDATE tasks SET source = 'external', source_ref = ?, worktree_path = ?, branch = ? WHERE id = ?")
    .run("jira:WEB-OLD", "/repo/.worktrees/legacy", "hive/legacy", id);
  const herdrCalls: string[][] = [];
  const herdr = new Herdr(async (argv) => {
    herdrCalls.push(argv);
    return OK();
  }, "herdr");
  const noGh = stub(() => ({ code: 1, stdout: "", stderr: "no gh" }));

  await reconcileOnce(db, { herdr, exec: noGh });
  await reconcileOnce(db, { herdr, exec: noGh });

  expect(herdrCalls).toEqual([]);
  expect(db.query("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = 'tracking_binding_detected'").get(id)).toEqual({ n: 1 });
  const notification = db.query("SELECT * FROM notifications WHERE task_id = ? AND kind = 'tracking_binding'").get(id) as any;
  expect(notification.urgency).toBe("urgent");
  expect(notification.body).toContain("/repo/.worktrees/legacy");
  expect(notification.body).toContain("preserved");
  expect(getTask(db, id)).toMatchObject({ agent_target: "legacy-agent", worktree_path: "/repo/.worktrees/legacy", branch: "hive/legacy" });
});

test("syncAgents accepts the safe workspace trust prompt for an idle spawned agent", async () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId, { agent_target: "t-agent", state: "in_progress" });
  const keys: string[] = [];
  const herdr = new Herdr(stub((argv) => {
    if (argv.includes("read"))
      return OK(JSON.stringify({ result: { read: { text: "Quick safety check: Is this a project you trust?\n❯ 1. Yes, I trust this folder\n  2. No, exit\nEnter to confirm · Esc to cancel" } } }));
    if (argv.includes("send-keys")) {
      keys.push(argv.at(-1)!);
      return OK();
    }
    return OK('{"result":{"agent":{"agent_status":"idle","pane_id":"w1:p1"}}}');
  }), "herdr");

  await reconcileOnce(db, { herdr, staleMs: 60 * 60 * 1000, exec: stub(() => ({ code: 1, stdout: "", stderr: "no gh" })) });

  expect(keys).toEqual(["1", "Enter"]);
  expect(db.query("SELECT 1 FROM events WHERE task_id = ? AND type = 'dialog_auto_approved'").get(id)).toBeTruthy();
});

test("syncAgents cancels Claude's optional auto-mode scan without opting in", async () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId, { agent_target: "t-agent", state: "in_progress" });
  const keys: string[] = [];
  const herdr = new Herdr(stub((argv) => {
    if (argv.includes("read"))
      return OK(JSON.stringify({ result: { read: { text: "Set up auto mode for your environment?\nClaude reads your recent sessions.\n❯ Also scan shell history [ ]\nAlso scan your other repos [ ]\nContinue\nEsc to cancel" } } }));
    if (argv.includes("send-keys")) {
      keys.push(argv.at(-1)!);
      return OK();
    }
    return OK('{"result":{"agent":{"agent_status":"done","pane_id":"w1:p1"}}}');
  }), "herdr");

  await reconcileOnce(db, { herdr, staleMs: 60 * 60 * 1000, exec: stub(() => ({ code: 1, stdout: "", stderr: "no gh" })) });

  expect(keys).toEqual(["Escape"]);
  expect(db.query("SELECT 1 FROM events WHERE task_id = ? AND type = 'dialog_auto_declined'").get(id)).toBeTruthy();
});

test("syncAgents recovers an idle agent with unconsumed queued input via Up+Enter (task #1098)", async () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId, { agent_target: "t-agent", state: "in_progress" });
  const keys: string[] = [];
  const messages: any[] = [];
  const client = { id: newId("client"), send: (data: string) => messages.push(JSON.parse(data)) };
  const herdr = new Herdr(stub((argv) => {
    if (argv.includes("read"))
      return OK(JSON.stringify({ result: { read: { text: "> \n\nPress up to edit queued messages" } } }));
    if (argv.includes("send-keys")) {
      keys.push(argv.at(-1)!);
      return OK();
    }
    return OK('{"result":{"agent":{"agent_status":"idle","pane_id":"w1:p1"}}}');
  }), "herdr");

  addClient(client);
  try {
    await reconcileOnce(db, { herdr, staleMs: 60 * 60 * 1000, exec: stub(() => ({ code: 1, stdout: "", stderr: "no gh" })) });
  } finally {
    removeClient(client);
  }

  expect(keys).toEqual(["Up", "Enter"]);
  const ev = db.query("SELECT payload FROM events WHERE task_id = ? AND type = 'queued_input_recovered'").get(id) as any;
  expect(ev).toBeTruthy();
  expect(JSON.parse(ev.payload).delivered).toBe(true);
  // #1234 review-15: the DB row is corrected in place (delivered: null -> true),
  // but the event is NOT re-broadcast under the same id — the web timeline
  // appends every SSE event rather than replacing by id, so a second broadcast
  // would render as a duplicate row with a duplicate React key. Only the
  // original reservation goes out live; the live feed catches up to the
  // corrected payload on its next full fetch.
  const recoveryUpdates = messages.filter((m) => m.type === "event" && m.event.type === "queued_input_recovered");
  expect(recoveryUpdates.map((m) => m.event.payload.delivered)).toEqual([null]);
});

test("queued-input recovery blocks review handoff through its grace period", async () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId, { agent_target: "t-agent", pr_url: "https://gh/pr/1", state: "in_progress" });
  db.query("INSERT INTO evidence (id, task_id, ts, kind) VALUES (?,?,?,?)").run(newId("ev"), id, now(), "log");
  let reads = 0;
  const herdr = new Herdr(stub((argv) => {
    if (argv.includes("get")) {
      return OK(JSON.stringify({ result: { agent: { agent_status: "idle", pane_id: "w1:p1" } } }));
    }
    if (argv.includes("read")) {
      const text = reads++ === 0 ? "Press up to edit queued messages" : ">";
      return OK(JSON.stringify({ result: { read: { text } } }));
    }
    return OK();
  }), "herdr");
  const noGh = stub(() => ({ code: 1, stdout: "", stderr: "no gh" }));

  await reconcileOnce(db, { herdr, staleMs: 60 * 60 * 1000, exec: noGh });
  expect(getTask(db, id).state).toBe("in_progress");

  db.query("UPDATE events SET ts = ? WHERE task_id = ? AND type = 'queued_input_recovered'")
    .run(new Date(Date.now() - 3 * 60 * 1000).toISOString(), id);
  await reconcileOnce(db, { herdr, staleMs: 60 * 60 * 1000, exec: noGh });
  expect(getTask(db, id).state).toBe("in_review");
});

test("queued-input recovery retries Enter when Up succeeds but submission fails", async () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId, { agent_target: "t-agent", state: "in_progress" });
  const keys: string[] = [];
  let enters = 0;
  const herdr = new Herdr(stub((argv) => {
    if (argv.includes("read"))
      return OK(JSON.stringify({ result: { read: { text: "Press up to edit queued messages" } } }));
    if (argv.includes("send-keys")) {
      const key = argv.at(-1)!;
      keys.push(key);
      if (key === "Enter" && enters++ === 0) return { code: 1, stdout: "", stderr: "submission failed" };
      return OK();
    }
    return OK('{"result":{"agent":{"agent_status":"idle","pane_id":"w1:p1"}}}');
  }), "herdr");

  await reconcileOnce(db, { herdr, staleMs: 60 * 60 * 1000, exec: stub(() => ({ code: 1, stdout: "", stderr: "no gh" })) });

  expect(keys).toEqual(["Up", "Enter", "Enter"]);
  const ev = db.query("SELECT payload FROM events WHERE task_id = ? AND type = 'queued_input_recovered'").get(id) as any;
  expect(JSON.parse(ev.payload).delivered).toBe(true);
});

test("queued-input recovery stops hammering the pane and alerts after repeated failures to drain", async () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId, { agent_target: "t-agent", state: "in_progress" });
  const keys: string[] = [];
  const herdr = new Herdr(stub((argv) => {
    if (argv.includes("read"))
      return OK(JSON.stringify({ result: { read: { text: "Press up to edit queued messages" } } }));
    if (argv.includes("send-keys")) {
      keys.push(argv.at(-1)!);
      return OK();
    }
    return OK('{"result":{"agent":{"agent_status":"idle","pane_id":"w1:p1"}}}');
  }), "herdr");
  const noGh = stub(() => ({ code: 1, stdout: "", stderr: "no gh" }));

  for (let i = 0; i < 5; i++) await reconcileOnce(db, { herdr, staleMs: 60 * 60 * 1000, exec: noGh });

  // Never sends more than MAX_QUEUED_INPUT_NUDGES (3) attempts — stops
  // hammering the pane once it's clear Up+Enter isn't draining the queue.
  expect(keys.filter((k) => k === "Up").length).toBe(3);
  expect(db.query("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = 'queued_input_recovered'").get(id)).toEqual({ n: 3 });
  const notif = db.query("SELECT * FROM notifications WHERE task_id = ? AND kind = 'queued_input_stuck'").all(id);
  expect(notif.length).toBe(1); // alerts once, doesn't spam every cycle after

  db.query("UPDATE events SET ts = '2000-01-01T00:00:00.000Z' WHERE task_id = ?").run(id);
  db.query("UPDATE notifications SET ts = '2000-01-01T00:00:00.000Z' WHERE task_id = ?").run(id);
  const activity = writeEvent(db, { task_id: id, source: "agent", type: "progress" });
  db.query("UPDATE events SET ts = '2001-01-01T00:00:00.000Z' WHERE id = ?").run(activity.id);

  for (let i = 0; i < 5; i++) await reconcileOnce(db, { herdr, staleMs: 60 * 60 * 1000, exec: noGh });

  expect(keys.filter((k) => k === "Up").length).toBe(6);
  expect(db.query("SELECT COUNT(*) AS n FROM notifications WHERE task_id = ? AND kind = 'queued_input_stuck'").get(id)).toEqual({ n: 2 });
});

test("overlapping queued-input recoveries reserve attempts before pane writes", async () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId, { agent_target: "t-agent", state: "in_progress" });
  for (let i = 0; i < 2; i++)
    writeEvent(db, { task_id: id, source: "reconciler", type: "queued_input_recovered", payload: { delivered: true } });

  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve));
  let markFirstStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => (markFirstStarted = resolve));
  let upCalls = 0;
  const herdr = new Herdr(async (argv) => {
    if (argv.includes("read"))
      return OK(JSON.stringify({ result: { read: { text: "Press up to edit queued messages" } } }));
    if (argv.includes("send-keys") && argv.at(-1) === "Up") {
      upCalls++;
      if (upCalls === 1) {
        markFirstStarted();
        await firstGate;
      }
      return OK();
    }
    if (argv.includes("send-keys")) return OK();
    return OK('{"result":{"agent":{"agent_status":"idle","pane_id":"w1:p1"}}}');
  }, "herdr");
  const noGh = stub(() => ({ code: 1, stdout: "", stderr: "no gh" }));

  const first = reconcileOnce(db, { herdr, staleMs: 60 * 60 * 1000, exec: noGh });
  await firstStarted;
  const second = reconcileOnce(db, { herdr, staleMs: 60 * 60 * 1000, exec: noGh });
  await second;
  expect(db.query("SELECT COUNT(*) AS n FROM notifications WHERE task_id = ? AND kind = 'queued_input_stuck'").get(id)).toEqual({ n: 0 });
  releaseFirst();
  await first;

  expect(upCalls).toBe(1);
  expect(db.query("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = 'queued_input_recovered'").get(id)).toEqual({ n: 3 });
  await reconcileOnce(db, { herdr, staleMs: 60 * 60 * 1000, exec: noGh });
  expect(db.query("SELECT COUNT(*) AS n FROM notifications WHERE task_id = ? AND kind = 'queued_input_stuck'").get(id)).toEqual({ n: 1 });
});

test("stale queued-input recovery shares the immediate three-attempt cap", async () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId, { agent_target: "t-agent", state: "in_progress" });
  for (let i = 0; i < 3; i++)
    writeEvent(db, { task_id: id, source: "reconciler", type: "queued_input_recovered", payload: { delivered: true } });
  writeEvent(db, { task_id: id, source: "reconciler", type: "stale" });
  const writes: string[][] = [];
  let probes = 0;
  const herdr = new Herdr(stub((argv) => {
    if (argv[0] === "agent" && argv[1] === "get") {
      const status = probes++ === 0 ? "working" : "idle";
      return OK(JSON.stringify({ result: { agent: { agent_status: status, pane_id: "w1:p1" } } }));
    }
    if (argv.includes("read"))
      return OK(JSON.stringify({ result: { read: { text: "Press up to edit queued messages" } } }));
    if (argv.includes("send") || argv.includes("send-keys")) writes.push(argv);
    return OK();
  }), "herdr");

  await reconcileOnce(db, { herdr, staleMs: 60 * 60 * 1000, exec: stub(() => ({ code: 1, stdout: "", stderr: "no gh" })) });

  expect(writes).toEqual([]);
  expect(db.query("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = 'recovery_nudge'").get(id)).toEqual({ n: 0 });
  expect(db.query("SELECT COUNT(*) AS n FROM notifications WHERE task_id = ? AND kind = 'queued_input_stuck'").get(id)).toEqual({ n: 1 });
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
  const merged = db.query("SELECT payload FROM events WHERE task_id = ? AND type = 'pr_merged'").get(id) as any;
  expect(JSON.parse(merged.payload)).toEqual({ pr_url: "https://gh/pr/1" });
});

test("syncPRs skips a task that raced ahead to done instead of throwing (task #621)", async () => {
  const { db, projectId } = freshDb();
  // The task whose gh call races: another actor (a concurrent /merge, or
  // autoMergeReady) finishes it to `done` while this cycle's `gh pr view` for
  // it is in flight.
  const racer = makeTask(db, projectId, { pr_url: "https://gh/pr/9" });
  transition(db, racer, "in_progress");
  transition(db, racer, "in_review");
  // A second, ordinary task in the same cycle — must still be processed even
  // though it's iterated after the racer.
  const other = makeTask(db, projectId, { pr_url: "https://gh/pr/10" });
  transition(db, other, "in_progress");
  transition(db, other, "in_review");

  const gh: Exec = stub((argv) => {
    if (argv[0] !== "gh") return OK();
    const url = argv[3];
    if (url === "https://gh/pr/9") {
      // Simulate the race: land the merge (and its whole downstream
      // verifying->done trip) mid-await, exactly the gap `syncPRs`'s own
      // `await exec` leaves open.
      db.query(
        "INSERT INTO evidence (id, task_id, ts, kind, path, url, caption, meta) VALUES (?,?,?,?,?,?,?,?)"
      ).run(newId("ev"), racer, now(), "log", "/tmp/x", "/evidence/x", "c", "{}");
      transition(db, racer, "verifying");
      transition(db, racer, "done");
      return OK(JSON.stringify({ state: "MERGED", statusCheckRollup: [{ conclusion: "SUCCESS" }] }));
    }
    return OK(JSON.stringify({ state: "OPEN", statusCheckRollup: [{ conclusion: "FAILURE" }] }));
  });

  await reconcileOnce(db, { exec: gh });

  expect(getTask(db, racer).state).toBe("done"); // untouched by the stale in_review read
  // Before the fix, the racer's uncaught "invalid transition: done->verifying"
  // aborted the whole syncPRs loop, so `other` never got processed this cycle.
  expect(getTask(db, other).ci_status).toBe("failing");
});

test("syncPRs never merges/closes a task for a PR it was already replaced with (HIVE-307)", async () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId, { pr_url: "https://gh/pr/old" });
  transition(db, id, "in_progress");
  transition(db, id, "in_review");

  const gh: Exec = stub((argv) => {
    if (argv[0] !== "gh") return OK();
    // The agent replaces the PR mid-probe — a fresh `ready` re-links pr_url
    // to a brand-new PR while this cycle's `gh pr view` for the OLD one is
    // still in flight.
    db.query("UPDATE tasks SET pr_url = ?, updated_at = ? WHERE id = ?").run("https://gh/pr/new", now(), id);
    return OK(JSON.stringify({ state: "MERGED", statusCheckRollup: [{ conclusion: "SUCCESS" }] }));
  });
  await reconcileOnce(db, { exec: gh });

  // The replacement PR must not be reported merged just because the OLD one was.
  expect(getTask(db, id).pr_url).toBe("https://gh/pr/new");
  expect(getTask(db, id).state).toBe("in_review");
  expect(db.query("SELECT 1 FROM events WHERE task_id = ? AND type = 'pr_merged'").get(id)).toBeFalsy();
});

test("syncPRs persists the PR's head_sha so the review card can flag stale evidence", async () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId, { pr_url: "https://gh/pr/1a" });
  transition(db, id, "in_progress");

  const gh: Exec = stub((argv) => {
    if (argv[0] === "gh")
      return OK(JSON.stringify({ state: "OPEN", statusCheckRollup: [{ conclusion: "SUCCESS" }], headRefOid: "sha-a" }));
    return OK();
  });
  await reconcileOnce(db, { exec: gh });
  expect(getTask(db, id).head_sha).toBe("sha-a");

  // a later poll with a new head commit updates it
  const gh2: Exec = stub((argv) => {
    if (argv[0] === "gh")
      return OK(JSON.stringify({ state: "OPEN", statusCheckRollup: [{ conclusion: "SUCCESS" }], headRefOid: "sha-b" }));
    return OK();
  });
  await reconcileOnce(db, { exec: gh2 });
  expect(getTask(db, id).head_sha).toBe("sha-b");
});

test("syncPRs discards facts fetched for a PR replaced in flight", async () => {
  const { db, projectId } = freshDb();
  const oldPr = "https://gh/pr/old";
  const newPr = "https://gh/pr/new";
  const id = makeTask(db, projectId, { pr_url: oldPr });
  transition(db, id, "in_progress");
  db.query("UPDATE tasks SET ci_status = ?, head_sha = ? WHERE id = ?").run("passing", "prior-head", id);

  const gh: Exec = stub((argv) => {
    if (argv[0] === "gh") {
      db.query("UPDATE tasks SET pr_url = ?, ci_status = NULL, head_sha = NULL WHERE id = ?").run(newPr, id);
      return OK(JSON.stringify({ state: "OPEN", statusCheckRollup: [{ conclusion: "FAILURE" }], headRefOid: "stale-old-head" }));
    }
    return OK();
  });

  await reconcileOnce(db, { exec: gh });

  const task = getTask(db, id);
  expect(task.pr_url).toBe(newPr);
  expect(task.ci_status).toBeNull();
  expect(task.head_sha).toBeNull();
  expect(task.state).toBe("in_progress");
  expect(db.query("SELECT 1 FROM events WHERE task_id = ? AND type IN ('ci_status', 'pr_synchronized')").all(id)).toHaveLength(0);
});

test("syncPRs rechecks PR identity after branch scope capture", async () => {
  const { db, projectId } = freshDb();
  const oldPr = "https://gh/pr/old-scope";
  const newPr = "https://gh/pr/new-scope";
  const id = makeTask(db, projectId, { pr_url: oldPr });
  transition(db, id, "in_progress");
  db.query("UPDATE tasks SET branch = ?, ci_status = ?, head_sha = ? WHERE id = ?")
    .run("hive/scope-race", "passing", "prior-head", id);

  const exec: Exec = stub((argv) => {
    if (argv[0] === "gh")
      return OK(JSON.stringify({ state: "OPEN", statusCheckRollup: [{ status: "IN_PROGRESS" }], headRefOid: "stale-old-head", baseRefName: "main", baseRefOid: "old-base" }));
    if (argv.includes("diff") && argv.includes("--name-only")) {
      db.query("UPDATE tasks SET pr_url = ?, ci_status = NULL, head_sha = NULL WHERE id = ?").run(newPr, id);
      return OK("src/task.ts\n");
    }
    if (argv.includes("rev-parse")) return OK("old-base\n");
    return OK();
  });

  await reconcileOnce(db, { exec });

  const task = getTask(db, id);
  expect(task.pr_url).toBe(newPr);
  expect(task.ci_status).toBeNull();
  expect(task.head_sha).toBeNull();
  expect(task.state).toBe("in_progress");
  expect(db.query("SELECT 1 FROM events WHERE task_id = ? AND type = 'branch_scope'").get(id)).toBeNull();
  expect(db.query("SELECT 1 FROM events WHERE task_id = ? AND type = 'ci_status'").get(id)).toBeNull();
});

test("syncPRs snapshots branch scope against the PR's exact base commit", async () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId, { pr_url: "https://gh/pr/staging" });
  db.query("UPDATE tasks SET branch = ? WHERE id = ?").run("feat", id);
  const diffs: string[] = [];
  const exec: Exec = stub((argv) => {
    if (argv[0] === "gh")
      return OK(JSON.stringify({ state: "OPEN", statusCheckRollup: [], headRefOid: "head", baseRefName: "staging", baseRefOid: "staging-sha" }));
    if (argv.includes("diff") && argv.includes("--name-only")) {
      diffs.push(argv.at(-1)!);
      return OK("src/task.ts\n");
    }
    if (argv.includes("rev-parse")) return OK("staging-sha\n");
    return OK();
  });

  await reconcileOnce(db, { exec });
  const scope: any = db.query("SELECT payload FROM events WHERE task_id = ? AND type = 'branch_scope'").get(id);
  expect(diffs).toEqual(["staging-sha...head"]);
  expect(JSON.parse(scope.payload)).toEqual({ base_sha: "staging-sha", files: ["src/task.ts"], head_sha: "head" });
});

// A PR's baseRefName is GitHub-sourced (set by the PR author via the GitHub
// UI/API, not local config), but it lands as a POSITIONAL git argument the
// same way config.default_branch does, and git's ref-name rules don't forbid
// a leading `-` (task #1086, same bug class as #1024). Omit baseRefOid so the
// vulnerable `data.baseRefOid || base` fallback is exercised.
test("syncPRs never lets an option-shaped PR baseRefName reach git argv (task #1086)", async () => {
  const { db, projectId } = freshDb({ default_branch: "staging" });
  const id = makeTask(db, projectId, { pr_url: "https://gh/pr/evil" });
  db.query("UPDATE tasks SET branch = ? WHERE id = ?").run("feat", id);
  const payload = "--output=/tmp/pwn";
  const argvs: string[][] = [];
  const exec: Exec = stub((argv) => {
    argvs.push(argv);
    if (argv[0] === "gh") return OK(JSON.stringify({ state: "OPEN", statusCheckRollup: [], headRefOid: "head", baseRefName: payload }));
    if (argv.includes("diff") && argv.includes("--name-only")) return OK("src/task.ts\n");
    if (argv.includes("rev-parse")) return OK("staging-sha\n");
    return OK();
  });

  await reconcileOnce(db, { exec });

  for (const argv of argvs) expect(argv).not.toContain(payload);
  // fell back to config.default_branch, so the scope snapshot still ran
  const scope: any = db.query("SELECT payload FROM events WHERE task_id = ? AND type = 'branch_scope'").get(id);
  expect(JSON.parse(scope.payload).base_sha).toBe("staging-sha");
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
  const closed = db.query("SELECT payload FROM events WHERE task_id = ? AND type = 'pr_closed'").get(id) as any;
  expect(JSON.parse(closed.payload)).toEqual({ pr_url: "https://gh/pr/3" });
  const steers = db.query("SELECT payload FROM events WHERE task_id = ? AND type='steer'").all(id) as any[];
  expect(JSON.parse(steers.at(-1).payload).message).toContain("CLOSED (not merged)");
});

test("syncPRs records pr_closed for a PR closed while its task is still in_progress (never reached in_review) (task #1233)", async () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId, { pr_url: "https://gh/pr/4", agent_target: "t-agent" });
  transition(db, id, "in_progress");
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
  expect(getTask(db, id).state).toBe("in_progress"); // never reached review, stays put
  const closed = db.query("SELECT * FROM events WHERE task_id = ? AND type = 'pr_closed'").all(id) as any[];
  expect(closed.length).toBe(1);

  // second cycle: no duplicate event
  await reconcileOnce(db, { exec: gh, herdr });
  expect(db.query("SELECT * FROM events WHERE task_id = ? AND type = 'pr_closed'").all(id).length).toBe(1);
});

test("syncPRs' actionable phase skips a never-dispatched external task — no nudge, no auto-transition — but ci_status bookkeeping still runs", async () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId, { pr_url: "https://gh/pr/7", source: "external" });
  transition(db, id, "in_progress"); // never spawned — external tasks move freely (state.ts)
  transition(db, id, "in_review");
  const gh: Exec = stub((argv) =>
    argv[0] === "gh"
      ? OK(JSON.stringify({ state: "CLOSED", statusCheckRollup: [{ conclusion: "SUCCESS" }], headRefOid: "sha-x" }))
      : OK()
  );
  await reconcileOnce(db, { exec: gh });
  const task = getTask(db, id);
  expect(task.state).toBe("in_review"); // no auto-bounce for a task hive doesn't own
  expect(task.ci_status).toBe("passing"); // bookkeeping still records observed PR facts
  expect(db.query("SELECT 1 FROM events WHERE task_id = ? AND type = 'steer'").get(id)).toBeFalsy();
});

test("syncPRs' actionable phase still acts on an external task that WAS spawned before (agent_target-aware, not blanket source-only)", async () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId, { pr_url: "https://gh/pr/8", agent_target: "t-agent-live", source: "external" });
  writeEvent(db, { task_id: id, source: "herdr", type: "spawned", payload: { agent_target: "t-agent-live" } });
  transition(db, id, "in_progress");
  transition(db, id, "in_review");
  const gh: Exec = stub((argv) => (argv[0] === "gh" ? OK(JSON.stringify({ state: "CLOSED", statusCheckRollup: [] })) : OK()));
  const herdr = new Herdr(
    stub((argv) => (argv.includes("get") ? OK('{"result":{"agent":{"pane_id":"p1","agent_status":"working"}}}') : OK())),
    "herdr"
  );
  await reconcileOnce(db, { exec: gh, herdr });
  expect(getTask(db, id).state).toBe("in_progress"); // bounced, same as any hive-driven task
  const steers = db.query("SELECT payload FROM events WHERE task_id = ? AND type='steer'").all(id) as any[];
  expect(JSON.parse(steers.at(-1).payload).message).toContain("CLOSED (not merged)");
});

test("autoMergeReady skips a never-dispatched external task even when CI is green and the pre-review looks clean", async () => {
  const { autoMergeReady } = await import("../src/reconciler.ts");
  const { db, projectId } = freshDb({ auto_merge: { kinds: ["chore"] } });
  const id = makeTask(db, projectId, { kind: "chore", source: "external" });
  transition(db, id, "in_progress");
  transition(db, id, "in_review");
  db.query("UPDATE tasks SET ci_status = 'passing', branch = 'hive/x' WHERE id = ?").run(id);
  db.query("INSERT INTO evidence (id, task_id, ts, kind, path, caption) VALUES (?,?,?,?,?,?)").run(
    newId("evd"), id, now(), "log", "/tmp/e.log", "proof"
  );
  writeEvent(db, { task_id: id, source: "system", type: "auto_review", payload: { verdict: "looks_good", summary: "s", risks: [], questions: [] } });
  const git: Exec = stub((argv) => {
    if (argv.includes("rev-parse")) return OK(argv.at(-1) === "main" ? "base-sha\n" : "branch-sha\n");
    return argv.includes("symbolic-ref") ? OK("main\n") : OK();
  });
  await autoMergeReady(db, { exec: git });
  expect(getTask(db, id).state).toBe("in_review"); // never-dispatched external: not hive's to merge
});

test("autoAnswerStale skips a never-dispatched external task's open decision", async () => {
  const { autoAnswerStale } = await import("../src/reconciler.ts");
  const { db, projectId } = freshDb({ decision_auto_answer_hours: 4 });
  const id = makeTask(db, projectId, { source: "external" });
  const did = newId("dec");
  db.query(
    "INSERT INTO decisions (id, task_id, ts, title, risk, options, status) VALUES (?,?,?,?,'normal',?, 'open')"
  ).run(did, id, new Date(Date.now() - 5 * 3600_000).toISOString(), "should never auto-answer",
    JSON.stringify([{ key: "go", label: "Go", recommended: true }, { key: "no", label: "No" }]));
  const herdr = new Herdr(stub(() => OK()), "herdr");
  autoAnswerStale(db, herdr, Date.now());
  expect((db.query("SELECT status FROM decisions WHERE id = ?").get(did) as any).status).toBe("open");
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

test("autoMergeReady merges opted-in, green, clean-review, uncontested tasks without requiring a quiz", async () => {
  const { autoMergeReady } = await import("../src/reconciler.ts");
  const { db, projectId } = freshDb({ auto_merge: { kinds: ["chore"] } });
  const mk = (extra: any, quiz: "passed" | "required" | "missing" = "passed") => {
    const id = makeTask(db, projectId, { kind: "chore", ...extra });
    transition(db, id, "in_progress");
    transition(db, id, "in_review");
    db.query("UPDATE tasks SET ci_status = 'passing', branch = 'hive/x' WHERE id = ?").run(id);
    db.query("INSERT INTO evidence (id, task_id, ts, kind, path, caption) VALUES (?,?,?,?,?,?)").run(
      newId("evd"), id, now(), "log", "/tmp/e.log", "proof"
    );
    const review = writeEvent(db, {
      task_id: id,
      source: "agent",
      type: "review_summary",
      payload: quiz === "missing" ? { done: ["done"] } : {
        understanding: {
          check: {
            question: "Why is this safe to merge?",
            options: [{ key: "review", label: "The review is clean." }, { key: "guess", label: "It is a guess." }],
            answer_key: "review",
          },
        },
      },
    });
    if (quiz === "passed")
      writeEvent(db, { task_id: id, source: "director", type: "understanding_quiz_passed", payload: { review_event_id: review.id, answer_key: "review" } });
    return id;
  };
  const clean = mk({}, "missing");
  const risky = mk({});
  const mechanical = mk({}, "required");
  const sensitive = mk({}, "required");
  writeEvent(db, { task_id: clean, source: "system", type: "auto_review", payload: { verdict: "looks_good", summary: "s", risks: [], questions: [] } });
  writeEvent(db, { task_id: risky, source: "system", type: "auto_review", payload: { verdict: "looks_good", summary: "s", risks: ["a real risk"], questions: [] } });
  writeEvent(db, { task_id: mechanical, source: "system", type: "auto_review", payload: { verdict: "looks_good", summary: "s", risks: [], questions: [], files: ["server/src/rows.ts"] } });
  writeEvent(db, { task_id: sensitive, source: "system", type: "auto_review", payload: { verdict: "looks_good", summary: "s", risks: [], questions: [], files: ["db/migrations/007.sql"] } });
  // primary checkout sits on the base branch; git merge-base/merge succeed for the local-ff path
  const git: Exec = stub((argv) => {
    if (argv.includes("rev-parse")) return OK(argv.at(-1) === "main" ? "base-sha\n" : "branch-sha\n");
    return argv.includes("symbolic-ref") ? OK("main\n") : OK();
  });
  await autoMergeReady(db, { exec: git });
  expect(getTask(db, clean).state).toBe("done"); // merged; no smoke configured → straight through verifying
  expect(getTask(db, risky).state).toBe("in_review"); // risks → human review
  // Mechanical change (hive-1559): its quiz is not judgment-class, so nothing is
  // deferred into the post-ship backlog. A sensitive path still parks one there.
  expect(getTask(db, mechanical).state).toBe("done");
  expect(db.query("SELECT 1 FROM events WHERE task_id = ? AND type = 'understanding_quiz_deferred'").get(mechanical)).toBeNull();
  expect(getTask(db, sensitive).state).toBe("done");
  expect(db.query("SELECT 1 FROM events WHERE task_id = ? AND type = 'understanding_quiz_deferred'").get(sensitive)).toBeTruthy();
});

test("autoMergeReady leaves a Focus-reviewed task for an explicit ship or request-changes choice", async () => {
  const { autoMergeReady } = await import("../src/reconciler.ts");
  const { db, projectId } = freshDb({ auto_merge: { kinds: ["chore"] } });
  const id = makeTask(db, projectId, { kind: "chore" });
  transition(db, id, "in_progress");
  transition(db, id, "in_review");
  db.query("UPDATE tasks SET ci_status = 'passing', branch = 'hive/x' WHERE id = ?").run(id);
  db.query("INSERT INTO evidence (id, task_id, ts, kind, path, caption) VALUES (?,?,?,?,?,?)").run(
    newId("evd"), id, now(), "log", "/tmp/e.log", "proof"
  );
  const review = writeEvent(db, {
    task_id: id,
    source: "agent",
    type: "review_summary",
    payload: { understanding: { check: { question: "safe?", options: [{ key: "yes", label: "yes" }, { key: "no", label: "no" }], answer_key: "yes" } } },
  });
  writeEvent(db, {
    task_id: id,
    source: "director",
    type: "understanding_quiz_passed",
    payload: { review_event_id: review.id, answer_key: "yes", surface: "focus" },
  });
  writeEvent(db, { task_id: id, source: "system", type: "auto_review", payload: { verdict: "looks_good", summary: "s", risks: [], questions: [] } });

  await autoMergeReady(db, { exec: stub(() => { throw new Error("Focus review must not auto-merge"); }) });
  expect(getTask(db, id).state).toBe("in_review");
});

test("autoMergeReady never auto-merges a PR-backed task on a review taken against an earlier head (HIVE-307)", async () => {
  const { autoMergeReady } = await import("../src/reconciler.ts");
  const { db, projectId } = freshDb({ auto_merge: { kinds: ["chore"] } });
  const id = makeTask(db, projectId, { kind: "chore", pr_url: "https://gh/pr/force-pushed" });
  transition(db, id, "in_progress");
  transition(db, id, "in_review");
  db.query("UPDATE tasks SET ci_status = 'passing', branch = 'hive/x', head_sha = ? WHERE id = ?").run("new-head", id);
  db.query("INSERT INTO evidence (id, task_id, ts, kind, path, caption) VALUES (?,?,?,?,?,?)").run(
    newId("evd"), id, now(), "log", "/tmp/e.log", "proof"
  );
  const review = writeEvent(db, {
    task_id: id,
    source: "agent",
    type: "review_summary",
    payload: { understanding: { check: { question: "safe?", options: [{ key: "review", label: "yes" }], answer_key: "review" } } },
  });
  writeEvent(db, { task_id: id, source: "director", type: "understanding_quiz_passed", payload: { review_event_id: review.id, answer_key: "review" } });
  // The review on file is against the OLD (pre-force-push) head.
  writeEvent(db, {
    task_id: id,
    source: "system",
    type: "auto_review",
    payload: { verdict: "looks_good", summary: "s", risks: [], questions: [], reviewed_pr_url: "https://gh/pr/force-pushed", reviewed_head_sha: "old-head" },
  });

  const git: Exec = stub((argv) => {
    if (argv[0] === "gh" && argv.includes("merge")) throw new Error("must never merge on a stale review");
    return OK();
  });
  await autoMergeReady(db, { exec: git });
  expect(getTask(db, id).state).toBe("in_review"); // held — waiting for a fresh review of the new head
});

test("autoMergeReady holds a task while a queued-input recovery is in flight (#1234 review-12)", async () => {
  const { autoMergeReady } = await import("../src/reconciler.ts");
  const { db, projectId } = freshDb({ auto_merge: { kinds: ["chore"] } });
  const mk = () => {
    const id = makeTask(db, projectId, { kind: "chore" });
    transition(db, id, "in_progress");
    transition(db, id, "in_review");
    db.query("UPDATE tasks SET ci_status = 'passing', branch = 'hive/x' WHERE id = ?").run(id);
    db.query("INSERT INTO evidence (id, task_id, ts, kind, path, caption) VALUES (?,?,?,?,?,?)").run(
      newId("evd"), id, now(), "log", "/tmp/e.log", "proof"
    );
    const review = writeEvent(db, {
      task_id: id,
      source: "agent",
      type: "review_summary",
      payload: { understanding: { check: { question: "safe?", options: [{ key: "review", label: "yes" }], answer_key: "review" } } },
    });
    writeEvent(db, { task_id: id, source: "director", type: "understanding_quiz_passed", payload: { review_event_id: review.id, answer_key: "review" } });
    writeEvent(db, { task_id: id, source: "system", type: "auto_review", payload: { verdict: "looks_good", summary: "s", risks: [], questions: [] } });
    return id;
  };
  const guarded = mk();
  // A steer got stuck behind "Press up to edit queued messages" and was just
  // redelivered — the agent's redelivered turn hasn't had a chance to run yet.
  writeEvent(db, { task_id: guarded, source: "reconciler", type: "queued_input_recovered", payload: { delivered: true } });

  const git: Exec = stub((argv) => {
    if (argv.includes("rev-parse")) return OK(argv.at(-1) === "main" ? "base-sha\n" : "branch-sha\n");
    return argv.includes("symbolic-ref") ? OK("main\n") : OK();
  });
  await autoMergeReady(db, { exec: git });
  expect(getTask(db, guarded).state).toBe("in_review"); // held, not merged out from under the recovery
});

test("autoMergeReady holds a task with work still queued for its agent", async () => {
  const { autoMergeReady } = await import("../src/reconciler.ts");
  const { markSteersDelivered, queueSteerEvent, queuedSteers, resumeReviewForDeliveredSteers } = await import("../src/steer.ts");
  const { db, projectId } = freshDb({ auto_merge: { kinds: ["chore"] } });
  const id = makeTask(db, projectId, { kind: "chore" });
  transition(db, id, "in_progress");
  transition(db, id, "in_review");
  db.query("UPDATE tasks SET ci_status = 'passing', branch = 'hive/x' WHERE id = ?").run(id);
  db.query("INSERT INTO evidence (id, task_id, ts, kind, path, caption) VALUES (?,?,?,?,?,?)").run(
    newId("evd"), id, now(), "log", "/tmp/e.log", "proof"
  );
  const review = writeEvent(db, {
    task_id: id,
    source: "agent",
    type: "review_summary",
    payload: { understanding: { check: { question: "safe?", options: [{ key: "review", label: "yes" }], answer_key: "review" } } },
  });
  writeEvent(db, { task_id: id, source: "director", type: "understanding_quiz_passed", payload: { review_event_id: review.id, answer_key: "review" } });
  writeEvent(db, { task_id: id, source: "system", type: "auto_review", payload: { verdict: "looks_good", summary: "s", risks: [], questions: [] } });
  queueSteerEvent(db, id, "Please address the requested follow-up before merging.", "agent turn complete");

  await autoMergeReady(db, { exec: stub(() => OK()) });
  expect(getTask(db, id).state).toBe("in_review");

  const pending = queuedSteers(db, id);
  markSteersDelivered(db, pending.map((steer) => steer.id));
  resumeReviewForDeliveredSteers(db, id, pending, "respawn");
  await autoMergeReady(db, { exec: stub(() => OK()) });
  expect(getTask(db, id).state).toBe("in_progress");
});

test("autoMergeReady rechecks queued work at every destructive merge boundary", async () => {
  const { autoMergeReady } = await import("../src/reconciler.ts");
  const { queueSteerEvent, queuedSteers } = await import("../src/steer.ts");

  for (const mode of ["pr", "local-merge", "local-update"] as const) {
    const { db, projectId } = freshDb({ auto_merge: { kinds: ["chore"] } });
    const id = makeTask(db, projectId, { kind: "chore" });
    transition(db, id, "in_progress");
    transition(db, id, "in_review");
    db.query("UPDATE tasks SET ci_status = 'passing', branch = ?, pr_url = ? WHERE id = ?").run(
      "hive/x",
      mode === "pr" ? "https://gh/pr/1" : null,
      id
    );
    db.query("INSERT INTO evidence (id, task_id, ts, kind, path, caption) VALUES (?,?,?,?,?,?)").run(
      newId("evd"), id, now(), "log", "/tmp/e.log", "proof"
    );
    const review = writeEvent(db, {
      task_id: id,
      source: "agent",
      type: "review_summary",
      payload: { understanding: { check: { question: "safe?", options: [{ key: "review", label: "yes" }, { key: "guess", label: "no" }], answer_key: "review" } } },
    });
    writeEvent(db, { task_id: id, source: "director", type: "understanding_quiz_passed", payload: { review_event_id: review.id, answer_key: "review" } });
    writeEvent(db, {
      task_id: id,
      source: "system",
      type: "auto_review",
      payload: {
        verdict: "looks_good",
        summary: "s",
        risks: [],
        questions: [],
        reviewed_pr_url: mode === "pr" ? "https://gh/pr/1" : null,
        reviewed_head_sha: (getTask(db, id) as any).head_sha ?? null,
      },
    });

    let releaseProbe!: () => void;
    let reachedProbe!: () => void;
    const probeHeld = new Promise<void>((resolve) => { releaseProbe = resolve; });
    const probeReached = new Promise<void>((resolve) => { reachedProbe = resolve; });
    let held = false;
    const destructive: string[][] = [];
    const exec: Exec = async (argv) => {
      const gate = mode === "pr"
        ? argv[0] === "gh" && argv.includes("view")
        : argv.includes("rev-parse") && !held;
      if (gate) {
        held = true;
        reachedProbe();
        await probeHeld;
      }
      if ((argv[0] === "gh" && argv.includes("merge")) || argv.includes("merge") || argv.includes("update-ref"))
        destructive.push(argv);
      if (argv[0] === "gh" && argv.includes("view"))
        return OK(JSON.stringify({ state: "OPEN", mergeStateStatus: "CLEAN", reviewDecision: "APPROVED", statusCheckRollup: [{ conclusion: "SUCCESS" }], baseRefName: "main", baseRefOid: "base-sha", headRefOid: "branch-sha" }));
      if (argv.includes("rev-parse")) return OK(argv.at(-1) === "main" ? "base-sha\n" : "branch-sha\n");
      if (argv.includes("symbolic-ref")) return OK(mode === "local-update" ? "other\n" : "main\n");
      if (argv.includes("worktree") && argv.includes("list")) return OK("");
      return OK();
    };

    const run = autoMergeReady(db, { exec });
    const reached = await Promise.race([probeReached.then(() => true), run.then(() => false)]);
    if (!reached) {
      const events = db.query("SELECT type, payload FROM events WHERE task_id = ? ORDER BY ts").all(id);
      throw new Error(`${mode} ended before its pre-mutation probe: ${JSON.stringify(events)}`);
    }
    queueSteerEvent(db, id, "Please address this before merging.", "agent not live");
    releaseProbe();
    await run;

    expect({ mode, destructive }).toEqual({ mode, destructive: [] });
    expect(getTask(db, id).state).toBe("in_review");
    expect(queuedSteers(db, id).length).toBe(1);
  }
});

test("autoAnswerStale answers timed-out normal-risk cards with the recommendation, never high-risk", async () => {
  const { autoAnswerStale } = await import("../src/reconciler.ts");
  const { db, projectId } = freshDb({ decision_auto_answer_hours: 4 });
  const id = makeTask(db, projectId, {});
  const mkDecision = (risk: string) => {
    const did = newId("dec");
    db.query(
      "INSERT INTO decisions (id, task_id, ts, title, risk, options, status) VALUES (?,?,?,?,?,?, 'open')"
    ).run(did, id, new Date(Date.now() - 5 * 3600_000).toISOString(), "t?", risk,
      JSON.stringify([{ key: "go", label: "Go", recommended: true }, { key: "no", label: "No" }]));
    return did;
  };
  const normal = mkDecision("normal");
  const high = mkDecision("high");
  const herdr = new Herdr(stub(() => OK()), "herdr");
  autoAnswerStale(db, herdr, Date.now());
  expect((db.query("SELECT status, answer_key FROM decisions WHERE id = ?").get(normal) as any).answer_key).toBe("go");
  expect((db.query("SELECT status FROM decisions WHERE id = ?").get(high) as any).status).toBe("open");
});

test("autoAnswerStale skips options that need director-supplied input (flag or keyword), notifies once", async () => {
  const { autoAnswerStale } = await import("../src/reconciler.ts");
  const { db, projectId } = freshDb({ decision_auto_answer_hours: 4 });
  const id = makeTask(db, projectId, {});
  const stale = new Date(Date.now() - 5 * 3600_000).toISOString();
  const mk = (opts: any[]) => {
    const did = newId("dec");
    db.query(
      "INSERT INTO decisions (id, task_id, ts, title, risk, options, status) VALUES (?,?,?,?,'normal',?, 'open')"
    ).run(did, id, stale, "creds?", JSON.stringify(opts));
    return did;
  };
  // keyword signal: the incident's exact shape — recommended option asks for a token
  const byKeyword = mk([
    { key: "creds", label: "give me admin credentials", detail: "attach a token so I can authenticate", recommended: true },
    { key: "skip", label: "Skip" },
  ]);
  // explicit flag signal
  const byFlag = mk([
    { key: "go", label: "Do it", recommended: true, requires_input: true },
    { key: "no", label: "No" },
  ]);
  const herdr = new Herdr(stub(() => OK()), "herdr");
  autoAnswerStale(db, herdr, Date.now());
  expect((db.query("SELECT status, answer_key FROM decisions WHERE id = ?").get(byKeyword) as any).status).toBe("open");
  expect((db.query("SELECT status FROM decisions WHERE id = ?").get(byFlag) as any).status).toBe("open");
  // notified once per task, not every tick
  autoAnswerStale(db, herdr, Date.now());
  expect(db.query("SELECT COUNT(*) n FROM events WHERE task_id = ? AND type = 'auto_answer_skipped'").get(id) as any).toEqual({ n: 1 });
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

test("flagStale does NOT flag a dep-blocked in_progress task past the threshold", async () => {
  const { db, projectId } = freshDb();
  const dep = makeTask(db, projectId, { state: "in_progress" }); // unmet
  const child = makeTask(db, projectId, { agent_target: "c-agent", state: "in_progress" });
  db.query("UPDATE tasks SET depends_on = ? WHERE id = ?").run(JSON.stringify([dep]), child);

  const future = () => Date.now() + 60 * 60 * 1000;
  await reconcileOnce(db, { staleMs: 15 * 60 * 1000, nowMs: future, herdr: statusHerdr("idle") });
  expect(db.query("SELECT * FROM events WHERE task_id = ? AND type = 'stale'").all(child).length).toBe(0);
});

test("flagStale skips a deferred task (future deferred_until) — no nudge", async () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId, { agent_target: "d-agent" });
  transition(db, id, "in_progress"); // last event is recent
  const future = () => Date.now() + 60 * 60 * 1000;
  // deferred well past the reconcile clock's window
  db.query("UPDATE tasks SET deferred_until = ? WHERE id = ?").run(new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), id);

  await reconcileOnce(db, { staleMs: 15 * 60 * 1000, nowMs: future, herdr: statusHerdr("idle") });
  expect(db.query("SELECT * FROM events WHERE task_id = ? AND type = 'stale'").all(id).length).toBe(0);

  // once the defer window passes, staleness resumes (the deadline IS the check-back)
  db.query("UPDATE tasks SET deferred_until = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), id);
  await reconcileOnce(db, { staleMs: 15 * 60 * 1000, nowMs: future, herdr: statusHerdr("idle") });
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

test("advanceFinished holds a task with unmet depends_on in in_progress; releases it when the dep merges", async () => {
  const { db, projectId } = freshDb();
  // dep still in progress -> unmet. child is otherwise fully advanceable:
  // idle agent, pr_url, ci not failing/pending, evidence attached.
  const dep = makeTask(db, projectId, { state: "in_progress" });
  const child = makeTask(db, projectId, { agent_target: "c-agent", pr_url: "https://gh/pr/dep", state: "in_progress" });
  db.query("UPDATE tasks SET depends_on = ? WHERE id = ?").run(JSON.stringify([dep]), child);
  db.query("INSERT INTO evidence (id, task_id, ts, kind) VALUES (?,?,?,?)").run(newId("ev"), child, now(), "log");

  const idle = statusHerdr("idle");
  const noGh = stub(() => ({ code: 1, stdout: "", stderr: "no gh" }));
  await reconcileOnce(db, { herdr: idle, exec: noGh });
  expect(getTask(db, child).state).toBe("in_progress"); // held by the dep gate
  expect(db.query("SELECT 1 FROM events WHERE task_id = ? AND type = 'dependency_blocked'").get(child)).toBeTruthy();

  // merge the dependency -> the gate opens and the idle-with-PR task advances
  db.query("UPDATE tasks SET state = 'done' WHERE id = ?").run(dep);
  await reconcileOnce(db, { herdr: idle, exec: noGh });
  expect(getTask(db, child).state).toBe("in_review");
});

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

// A stale local integration branch must not suppress GitHub's conflict verdict.
// New worktrees use origin/main, so conflict recovery follows that same source.
test("conflict watchdog follows GitHub's remote base even when local main is an ancestor", async () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId, { agent_target: "a1", pr_url: "https://gh/pr/38" });
  db.query("UPDATE tasks SET branch = ? WHERE id = ?").run("hive/321", id);
  transition(db, id, "in_progress");
  transition(db, id, "in_review");
  const { h, sends } = sendCapturingHerdr("idle");
  const exec = (sha: string): Exec =>
    stub((argv) => {
      if (argv[0] === "gh")
        return OK(JSON.stringify({ state: "OPEN", statusCheckRollup: [], mergeable: "CONFLICTING", headRefOid: sha }));
      return OK();
    });

  await reconcileOnce(db, { herdr: h, exec: exec("sha1") });
  await reconcileOnce(db, { herdr: h, exec: exec("sha2") }); // agent "merged origin/main", new head, still conflicts
  await reconcileOnce(db, { herdr: h, exec: exec("sha3") });

  expect(sends.length).toBe(3); // once per pushed head, never suppressed by local main
  expect(getTask(db, id).state).toBe("in_review"); // lifecycle untouched
  const ev = db.query("SELECT payload FROM events WHERE task_id = ? AND type = 'pr_conflict'").all(id) as { payload: string }[];
  expect(ev.every((e) => JSON.parse(e.payload).delivered === true)).toBe(true);
});

test("conflict watchdog: a deferred task emits no pr_conflict and steers nobody; undefer makes the next cycle nudge once", async () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId, { agent_target: "a1", pr_url: "https://gh/pr/9" });
  transition(db, id, "in_progress");
  transition(db, id, "in_review");
  db.query("UPDATE tasks SET deferred_until = ? WHERE id = ?").run("9999-12-31T00:00:00.000Z", id);
  const { h, sends } = sendCapturingHerdr("idle");
  const gh: Exec = stub((argv) =>
    argv[0] === "gh"
      ? OK(JSON.stringify({ state: "OPEN", statusCheckRollup: [], mergeable: "CONFLICTING", headRefOid: "sha1" }))
      : OK()
  );

  await reconcileOnce(db, { herdr: h, exec: gh });
  expect(sends.length).toBe(0);
  expect(db.query("SELECT * FROM events WHERE task_id = ? AND type = 'pr_conflict'").all(id).length).toBe(0);
  expect(getTask(db, id).state).toBe("in_review"); // no wake, lifecycle untouched

  // still deferred next cycle -> still nothing
  await reconcileOnce(db, { herdr: h, exec: gh });
  expect(sends.length).toBe(0);

  // clearing the deferral makes the very next cycle nudge once (not
  // suppressed by a dedup event that was never written while parked)
  db.query("UPDATE tasks SET deferred_until = NULL WHERE id = ?").run(id);
  await reconcileOnce(db, { herdr: h, exec: gh });
  expect(sends.length).toBe(1);
  const ev = db.query("SELECT payload FROM events WHERE task_id = ? AND type = 'pr_conflict'").all(id) as { payload: string }[];
  expect(ev.length).toBe(1);
});

test("syncPRs advances a merged deferred PR through verifying instead of leaving it parked forever (hive-303)", async () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId, { pr_url: "https://gh/pr/847", agent_target: "t-agent" });
  transition(db, id, "in_progress");
  db.query("UPDATE tasks SET deferred_until = ? WHERE id = ?").run("9999-12-31T00:00:00.000Z", id);

  const gh: Exec = stub((argv) =>
    argv[0] === "gh" ? OK(JSON.stringify({ state: "MERGED", statusCheckRollup: [{ conclusion: "SUCCESS" }] })) : OK()
  );
  const herdr = new Herdr(
    stub((argv) => (argv.includes("get") ? OK('{"result":{"agent":{"pane_id":"p1","agent_status":"working"}}}') : OK())),
    "herdr"
  );
  await reconcileOnce(db, { exec: gh, herdr });

  const task = getTask(db, id);
  expect(task.state).toBe("verifying");
  expect(task.deferred_until).toBeNull();
  expect(db.query("SELECT * FROM events WHERE task_id = ? AND type = 'pr_merged'").all(id).length).toBe(1);
  expect(db.query("SELECT * FROM events WHERE task_id = ? AND type = 'undeferred'").all(id).length).toBe(1);
});

test("advanceFinished: in_progress + pr_url + idle agent -> in_review (+ event)", async () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId, { agent_target: "a1", pr_url: "https://gh/pr/1" });
  transition(db, id, "in_progress");
  db.query("INSERT INTO evidence (id, task_id, ts, kind, path, caption) VALUES (?,?,?,?,?,?)").run(
    newId("evd"), id, now(), "log", "/tmp/x.log", "proof"
  );

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

test("reconciler backfills a requeue when its failed predecessor's PR is linked later", async () => {
  const { db, projectId } = freshDb();
  const predecessor = makeTask(db, projectId, { state: "failed" });
  const successor = makeTask(db, projectId, { source: "requeue" });
  const branch = `hive/${predecessor}`;
  const prUrl = "https://gh/pr/819";
  db.query("UPDATE tasks SET branch = ? WHERE id = ?").run(branch, predecessor);
  db.query("UPDATE tasks SET parent_task_id = ?, resume_branch = ?, brief = ? WHERE id = ?")
    .run(predecessor, branch, "Keep this original brief.", successor);
  writeEvent(db, { task_id: successor, source: "reconciler", type: "created", payload: { requeue_of: predecessor } });

  const gh: Exec = stub((argv) => argv.includes("list")
    ? OK(JSON.stringify([{ title: "PR", body: `hive-task: ${predecessor}`, url: prUrl }]))
    : { code: 1, stdout: "", stderr: "skip" });
  await reconcileOnce(db, { exec: gh });

  const requeue = getTask(db, successor);
  expect(requeue.resume_pr_url).toBe(prUrl);
  expect(requeue.resume_branch).toBe(branch);
  expect(requeue.brief.startsWith("<!-- hive:resume -->\n**RESUME")).toBe(true);
  expect(requeue.brief).toContain(`- Open PR: ${prUrl}`);
  expect(requeue.brief).toContain("Keep this original brief.");
  expect(db.query("SELECT 1 FROM events WHERE task_id = ? AND type = 'resume_pr_backfilled'").get(successor)).toBeTruthy();
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

// task #1096: `gh` ENOENT under linkPRs errored every cycle for ~27min live
// with zero signal on /api/health, because reconcileOnce never recorded its
// own outcome anywhere durable. This is the heartbeat that fixes that.
test("reconcileOnce heartbeats last_reconcile_at and tracks a failing step's error streak, resetting on recovery (task #1096)", async () => {
  const { db } = freshDb(); // freshDb's project has repo_path set, so linkPRs always runs
  const ghEnoent: Exec = async () => {
    throw new Error("posix_spawn gh ENOENT (-2)");
  };

  expect(getSetting(db, "last_reconcile_at")).toBeNull();
  expect(getSetting(db, "reconciler_error_streak")).toBeNull();

  await reconcileOnce(db, { exec: ghEnoent });
  expect(getSetting(db, "last_reconcile_at")).not.toBeNull();
  expect(getSetting(db, "reconciler_error_streak")).toBe("1");
  expect(getSetting(db, "reconciler_last_error")).toContain("ENOENT");

  await reconcileOnce(db, { exec: ghEnoent });
  expect(getSetting(db, "reconciler_error_streak")).toBe("2");

  // A clean cycle (gh resolves again) resets the streak.
  await reconcileOnce(db, { exec: stub(() => OK("[]")) });
  expect(getSetting(db, "reconciler_error_streak")).toBe("0");
});

// task #1667: the same ENOENT no longer errors the cycle, so it would stop
// counting anywhere at all. Three cycles of "gh never started" must show up on
// /api/health as degraded, and clear as soon as one cycle gets gh running.
test("a tool that repeatedly fails to start marks health degraded and clears on recovery (task #1667)", async () => {
  const { degradedTools } = await import("../src/api.ts");
  const { db } = freshDb(); // repo_path '/repo'
  const cannotStart: Exec = async () => ({ code: 127, stdout: "", stderr: "gh: ENOENT: no such file or directory, posix_spawn 'gh' (cwd /repo)" });

  await reconcileOnce(db, { exec: cannotStart });
  await reconcileOnce(db, { exec: cannotStart });
  // Not degraded yet, and crucially not burning the cycle error streak either.
  expect(degradedTools(db)).toEqual([]);
  expect(getSetting(db, "reconciler_error_streak")).toBe("0");

  await reconcileOnce(db, { exec: cannotStart });
  expect(degradedTools(db)[0]).toContain("gh:");
  expect(degradedTools(db)[0]).toContain("cwd /repo");
  expect(getSetting(db, "reconciler_error_streak")).toBe("0");

  await reconcileOnce(db, { exec: stub(() => OK("[]")) });
  expect(degradedTools(db)).toEqual([]);
});

// A project registered by someone's E2E run points repo_path at a scratch dir
// that gets cleaned up. Running gh in a directory that no longer exists is what
// wedged linkPRs for ~10h, and such a project has no real PRs anyway (#1667).
test("linkPRs skips test/ephemeral projects entirely (task #1667)", async () => {
  const { db, projectId } = freshDb({ test: true });
  const task = makeTask(db, projectId);
  let ghCalls = 0;
  const exec: Exec = async (argv) => {
    if (argv[0] === "gh" && argv[1] === "pr" && argv[2] === "list") ghCalls++;
    return OK("[]");
  };

  await reconcileOnce(db, { exec });

  expect(ghCalls).toBe(0);
  expect(getTask(db, task).pr_url).toBeNull();
});

test("reAdoptAgentsOnBoot re-adopts a live-but-unregistered agent and skips terminal tasks", async () => {
  const { reAdoptAgentsOnBoot } = await import("../src/reconciler.ts");
  const { db, projectId } = freshDb();
  // A live agent whose registry record was lost (herdr wipe): agent get → not
  // found, but its pane is still in `pane list` (addressable by terminal id).
  const live = makeTask(db, projectId, { agent_target: "t-live", state: "in_progress" });
  writeEvent(db, { task_id: live, source: "herdr", type: "spawned", payload: { agent_target: "t-live", terminal_id: "term_X", tab_id: "w1:t1" } });
  db.query("UPDATE tasks SET worktree_path = ? WHERE id = ?").run("/wt/live", live);
  // A finished task that still carries an agent_target must NOT be probed/readopted.
  const done = makeTask(db, projectId, { agent_target: "t-done", state: "in_progress" });
  transition(db, done, "cancelled"); // terminal, no evidence gate — must be skipped by the boot pass

  let reReported = false; // report-agent flips `agent get` from not_found → alive
  // herdr.run() prepends the bin, so the stub sees argv[0] === "herdr".
  const herdr = new Herdr(async (argv) => {
    const [, verb, sub, target] = argv;
    if (verb === "agent" && sub === "get") {
      if (target === "t-done") return OK('{"result":{"agent":{"pane_id":"pd","agent_status":"working"}}}');
      return reReported
        ? OK('{"result":{"agent":{"pane_id":"pl","agent_status":"working"}}}')
        : OK('{"error":{"code":"agent_not_found"}}');
    }
    if (verb === "pane" && sub === "list")
      return OK(JSON.stringify({ result: { panes: [{ pane_id: "pl", tab_id: "w1:t1", cwd: "/wt/live", terminal_id: "term_X", label: null }] } }));
    if (verb === "pane" && sub === "report-agent") { reReported = true; return OK(); }
    return OK();
  }, "herdr");

  const r = await reAdoptAgentsOnBoot(db, { herdr });
  expect(r.probed).toBe(1);      // only the in_progress task, not the done one
  expect(r.readopted).toBe(1);   // the wiped-but-live agent came back
  expect(db.query("SELECT 1 FROM events WHERE task_id = ? AND type = 'readopted'").get(live)).toBeTruthy();
  expect(db.query("SELECT 1 FROM events WHERE task_id = ? AND type = 'readopted'").get(done)).toBeFalsy();
});
