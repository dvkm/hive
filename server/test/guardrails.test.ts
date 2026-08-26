// Round-1 autonomy guardrails: per-task cost warn/cap, broadcast steer, policy
// auto-broadcast, decision-dismiss recovery, decision aging nags, intake noise.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "hive-guardrails-"));
process.env.HIVE_HOME = HOME;

const { openDb } = await import("../src/db.ts");
const { makeHandler } = await import("../src/api.ts");
const { nagOpenDecisions } = await import("../src/reconciler.ts");
const { isNonActionableIntake } = await import("../src/intake/gchat.ts");
const { Herdr } = await import("../src/runtime/herdr.ts");
import type { Exec, ExecResult } from "../src/exec.ts";

const OK = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const WT = join(HOME, "wt");
const has = (argv: string[], ...xs: string[]) => xs.every((x) => argv.includes(x));

const sends: string[] = [];
const exec: Exec = async (argv) => {
  if (has(argv, "worktree", "create"))
    return OK(`{"result":{"worktree":{"path":${JSON.stringify(WT)},"branch":"hive/x","open_workspace_id":"w1"}}}`);
  if (has(argv, "agent", "get")) return OK('{"result":{"agent":{"pane_id":"p1","agent_status":"working"}}}');
  if (has(argv, "workspace", "list")) return OK('{"result":{"workspaces":[{"workspace_id":"wF","label":"hive-fleet"}]}}');
  if (has(argv, "tab", "create")) return OK('{"result":{"tab":{"tab_id":"wF:t2"}}}');
  if (has(argv, "agent", "send")) {
    sends.push(argv[argv.indexOf("send") + 2]);
    return OK();
  }
  return OK();
};

let server: any;
let BASE = "";
let projectId = "";
const db = openDb(":memory:");
const herdr = new Herdr(exec, "herdr");

beforeAll(async () => {
  server = Bun.serve({ port: 0, fetch: makeHandler(db, { herdr }) });
  BASE = `http://127.0.0.1:${server.port}`;
  const p = await post("/api/projects", { name: "p", repo_path: "/repo" });
  projectId = p.json.id;
});
afterAll(() => server.stop(true));

async function post(path: string, body: unknown) {
  const res = await fetch(BASE + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() as any };
}
async function get(path: string) {
  const res = await fetch(BASE + path);
  return { status: res.status, json: await res.json() as any };
}
const newTask = async (title: string) => (await post("/api/tasks", { project_id: projectId, title })).json.id;
const events = async (id: string, type: string) =>
  (await get(`/api/tasks/${id}/events`)).json.filter((e: any) => e.type === type);
const usage = (id: string, cost: number) =>
  post(`/api/tasks/${id}/events`, { type: "usage", model: "claude-opus-4-8", cost_usd: cost });
const openDecisions = (taskId: string) =>
  db.query("SELECT * FROM decisions WHERE task_id = ? AND status = 'open' ORDER BY ts").all(taskId) as any[];

// ---- cost guardrails --------------------------------------------------------

// Guardrails are opt-in (defaults 0/off while historical rows stay inflated);
// these tests exercise a project that opted in.
let costProjectId = "";
async function newCostTask(title: string) {
  if (!costProjectId) {
    const p = await post("/api/projects", {
      name: "cost-p",
      repo_path: "/repo",
      config: { cost_warn_usd: 75, cost_cap_usd: 200 },
    });
    costProjectId = p.json.id;
  }
  return (await post("/api/tasks", { project_id: costProjectId, title })).json.id;
}

test("guardrails are off by default: no warn event without project config", async () => {
  const id = await newTask("default off");
  await usage(id, 500);
  expect(await events(id, "cost_warning")).toHaveLength(0);
});

test("crossing the warn threshold emits one cost_warning and one queued steer", async () => {
  const id = await newCostTask("cost warn");
  await usage(id, 80); // default warn $75
  expect(await events(id, "cost_warning")).toHaveLength(1);
  const steers = await events(id, "steer");
  expect(steers).toHaveLength(1);
  expect(steers[0].payload.message).toContain("$80.00");
  expect(steers[0].payload.delivery).toBe("queued");
  await usage(id, 10); // no re-warn
  expect(await events(id, "cost_warning")).toHaveLength(1);
});

test("crossing the cap opens a decision; continue doubles it; wrap_up steers", async () => {
  const id = await newCostTask("cost cap");
  await usage(id, 210); // default cap $200
  let cards = openDecisions(id);
  expect(cards).toHaveLength(1);
  expect(cards[0].title).toContain("$200");

  // continue → cap doubles, no new card until $400
  await post(`/api/decisions/${cards[0].id}/answer`, { answer_key: "continue" });
  await usage(id, 100); // total 310 < 400
  expect(openDecisions(id)).toHaveLength(0);
  await usage(id, 100); // total 410 >= 400
  cards = openDecisions(id);
  expect(cards).toHaveLength(1);
  expect(cards[0].title).toContain("$400");

  // wrap_up → a steer telling the agent to ship what it has
  await post(`/api/decisions/${cards[0].id}/answer`, { answer_key: "wrap_up" });
  const steers = await events(id, "steer");
  expect(steers.at(-1).payload.message).toContain("WRAP UP");
});

// Raw usage guardrails protect unpriced models. Tiny thresholds keep these
// tests readable; production defaults are 75M/200M processed tokens and
// 25/100 wait calls.
let rawProjectId = "";
async function newRawTask(title: string) {
  if (!rawProjectId) {
    const p = await post("/api/projects", {
      name: "raw-usage-p",
      repo_path: "/repo",
      config: {
        processed_token_warn: 100,
        processed_token_cap: 200,
        wait_call_warn: 2,
        wait_call_cap: 4,
      },
    });
    rawProjectId = p.json.id;
  }
  const id = (await post("/api/tasks", { project_id: rawProjectId, title })).json.id;
  await post(`/api/tasks/${id}/transition`, { to: "in_progress" });
  return id;
}

test("processed-token guardrails warn and park an unpriced task, then double on continue", async () => {
  const id = await newRawTask("unpriced token cap");
  await post(`/api/tasks/${id}/events`, {
    type: "usage",
    model: "gpt-unpriced",
    input_tokens: 40,
    output_tokens: 10,
    cache_read_tokens: 70,
  });
  expect(await events(id, "processed_token_warning")).toHaveLength(1);

  await post(`/api/tasks/${id}/events`, { type: "usage", model: "gpt-unpriced", input_tokens: 100 });
  expect(await events(id, "processed_token_cap")).toHaveLength(1);
  expect((await get(`/api/tasks/${id}`)).json.state).toBe("needs_decision");
  let cards = openDecisions(id);
  expect(cards).toHaveLength(1);
  expect(cards[0].title).toContain("processed tokens cap");
  expect((await events(id, "steer")).at(-1).payload.message).toContain("End this turn now");

  await post(`/api/decisions/${cards[0].id}/answer`, { answer_key: "continue" });
  expect((await get(`/api/tasks/${id}`)).json.state).toBe("in_progress");
  await post(`/api/tasks/${id}/events`, { type: "usage", model: "gpt-unpriced", input_tokens: 170 });
  expect(openDecisions(id)).toHaveLength(0); // 390 < doubled cap 400
  await post(`/api/tasks/${id}/events`, { type: "usage", model: "gpt-unpriced", input_tokens: 20 });
  cards = openDecisions(id);
  expect(cards).toHaveLength(1);
  expect(cards[0].title).toContain("400");
});

test("wait-call guardrails ignore other tools, warn once, and park repeated polling", async () => {
  const id = await newRawTask("polling cap");
  const tool = (name: string) => post(`/api/tasks/${id}/events`, {
    type: "tool_use",
    source: "hook",
    payload: { tool: name, summary: "" },
  });
  await tool("wait");
  await tool("Bash");
  await tool("wait");
  expect(await events(id, "wait_call_warning")).toHaveLength(1);
  await tool("wait");
  await tool("wait");
  expect(await events(id, "wait_call_cap")).toHaveLength(1);
  expect((await get(`/api/tasks/${id}`)).json.state).toBe("needs_decision");
  expect(openDecisions(id)[0].title).toContain("wait calls cap");
  expect((await events(id, "steer")).at(-1).payload.message).toContain("Do not poll");
});

test("usage posts with a session_id upsert: cumulative Stops converge to one row", async () => {
  const id = await newTask("usage upsert");
  const send = (tokens: any) =>
    post(`/api/tasks/${id}/events`, { type: "usage", model: "claude-opus-4-8", session_id: "sess-1", ...tokens });
  await send({ input_tokens: 100, output_tokens: 50, cache_read_tokens: 1000, cache_write_tokens: 10 });
  await send({ input_tokens: 200, output_tokens: 90, cache_read_tokens: 3000, cache_write_tokens: 20 });
  let rows = db.query("SELECT * FROM usage WHERE task_id = ?").all(id) as any[];
  expect(rows).toHaveLength(1); // converged, not stacked
  expect(rows[0].input_tokens).toBe(200);
  // cache tokens priced: 200*5 + 90*25 + 3000*0.5 + 20*6.25 per MTok
  expect(rows[0].cost_usd).toBeCloseTo((200 * 5 + 90 * 25 + 3000 * 0.5 + 20 * 6.25) / 1e6, 10);
  // a respawn (new session) gets its own row
  await post(`/api/tasks/${id}/events`, { type: "usage", model: "claude-opus-4-8", session_id: "sess-2", input_tokens: 7 });
  rows = db.query("SELECT * FROM usage WHERE task_id = ?").all(id) as any[];
  expect(rows).toHaveLength(2);
});

// ---- broadcast steer + policy auto-broadcast --------------------------------

test("broadcast steer reaches every live agent, skips agentless tasks", async () => {
  const a = await newTask("live A");
  const b = await newTask("live B");
  await newTask("never spawned");
  await post(`/api/tasks/${a}/spawn`, {});
  await post(`/api/tasks/${b}/spawn`, {});
  sends.length = 0;
  const r = await post("/api/steer/broadcast", { message: "fleet: new rule", actor: "director-session-a" });
  expect(r.json.targets).toBe(2);
  expect(r.json.delivered).toBe(2);
  expect(sends.filter((s) => s.includes("fleet: new rule"))).toHaveLength(2);
  const events = db.query("SELECT payload FROM events WHERE task_id IN (?, ?) AND type = 'steer' ORDER BY rowid DESC LIMIT 2").all(a, b) as { payload: string }[];
  expect(events.every((event) => JSON.parse(event.payload).actor === "director-session-a")).toBe(true);
});

test("creating an active policy auto-broadcasts it to live agents", async () => {
  sends.length = 0;
  await post("/api/policies", { title: "no force push", body: "never force push" });
  await new Promise((r) => setTimeout(r, 100)); // fire-and-forget broadcast
  const hit = sends.filter((s) => s.includes("Protocol update") && s.includes("no force push"));
  expect(hit.length).toBeGreaterThanOrEqual(1);
});

// ---- external-task supervision hardening (#996) ------------------------------
// A tracking-only task (source='external', a mirrored JIRA issue or another
// agent's kanban entry — see supervision.ts) must never acquire an agent hive
// itself dispatched. These close the manual-dispatch paths #974's passive
// consolidation deliberately left open.

test("creating a task rejects a caller-supplied agent_target on a source=external task", async () => {
  const r = await post("/api/tasks", {
    project_id: projectId,
    title: "sneaky pre-dispatched mirror",
    source: "external",
    agent_target: "t-preset",
  });
  expect(r.status).toBe(400);
  expect(r.json.error).toContain("agent_target");
});

test("manual spawn rejects a never-dispatched external task", async () => {
  const t = await post("/api/tasks", { project_id: projectId, title: "mirrored issue, never touched", source: "external" });
  const r = await post(`/api/tasks/${t.json.id}/spawn`, {});
  expect(r.status).toBe(502);
  expect(r.json.error).toContain("never been spawned");
  const task = await get(`/api/tasks/${t.json.id}`);
  expect(task.json.agent_target).toBeNull();
  expect(task.json.state).toBe("queued");
});

test("manual spawn succeeds for an external task that WAS spawned before (recovery, not a first dispatch)", async () => {
  const t = await post("/api/tasks", { project_id: projectId, title: "mirrored issue, recovering", source: "external" });
  // Simulate the requeue-after-a-real-spawn case (supervision.ts's everSpawned):
  // agent_target nulled by a failed->queued requeue, but the permanent `spawned`
  // event from the earlier real dispatch stays.
  db.query("INSERT INTO events (id, task_id, ts, source, type, payload) VALUES (?,?,?,?,?,?)").run(
    "ev_prior_spawn_996", t.json.id, new Date().toISOString(), "herdr", "spawned", JSON.stringify({ agent_target: "t-old" })
  );
  const r = await post(`/api/tasks/${t.json.id}/spawn`, {});
  expect(r.status).toBe(200);
  expect(r.json.ok).toBe(true);
});

test("needs_decision unpark skips a never-dispatched external task", async () => {
  const { unparkAnswered } = await import("../src/reconciler.ts");
  const t = await post("/api/tasks", { project_id: projectId, title: "mirrored issue, parked", source: "external" });
  await post(`/api/tasks/${t.json.id}/transition`, { to: "in_progress" });
  await post(`/api/tasks/${t.json.id}/transition`, { to: "needs_decision" });
  unparkAnswered(db, Date.now() + 60 * 60 * 1000); // well past grace — must still not touch it
  const task = await get(`/api/tasks/${t.json.id}`);
  expect(task.json.state).toBe("needs_decision");
});

// ---- decision dismiss recovery ----------------------------------------------

test("dismissing an authority card denies the grant and steers the agent", async () => {
  const id = await newTask("dismiss recovery");
  const g1 = await post(`/api/tasks/${id}/guarded-action`, {
    action: "command.dangerous.process-kill",
    target: "pkill -f vite",
    detail: "command approval (dangerous): process kill",
    summary: "free the vite dev server port",
  });
  expect(g1.status).toBe(409);
  const d1 = g1.json.decision_id;

  await post(`/api/decisions/${d1}/dismiss`, {});
  // The steer says don't wait / don't retry.
  const steers = await events(id, "steer");
  expect(steers.at(-1).payload.message).toContain("dismissed");
  // A retry opens a FRESH card instead of pointing at the expired one forever.
  const g2 = await post(`/api/tasks/${id}/guarded-action`, {
    action: "command.dangerous.process-kill",
    target: "pkill -f vite",
    detail: "command approval (dangerous): process kill",
    summary: "free the vite dev server port",
  });
  expect(g2.status).toBe(409);
  expect(g2.json.decision_id).not.toBe(d1);
});

// ---- decision aging nags ------------------------------------------------------

test("open decisions nag urgently at 15m and again at 60m, once per tier", async () => {
  const id = await newTask("aging decision");
  const r = await post(`/api/tasks/${id}/guarded-action`, {
    action: "command.dangerous.recursive-forced-rm",
    target: "rm -rf /somewhere",
    detail: "command approval (dangerous): recursive/forced rm",
    summary: "clear a scratch directory",
  });
  const decisionId = r.json.decision_id;
  const t0 = Date.parse(
    (db.query("SELECT ts FROM decisions WHERE id = ?").get(decisionId) as any).ts
  );
  const nags = () =>
    (db.query("SELECT COUNT(*) AS n FROM notifications WHERE kind = 'decision_nag' AND decision_id = ?").get(decisionId) as any).n;

  nagOpenDecisions(db, t0 + 5 * 60 * 1000); // 5m: quiet
  expect(nags()).toBe(0);
  nagOpenDecisions(db, t0 + 20 * 60 * 1000); // 15m tier
  nagOpenDecisions(db, t0 + 25 * 60 * 1000); // same tier: no repeat
  expect(nags()).toBe(1);
  nagOpenDecisions(db, t0 + 90 * 60 * 1000); // 60m tier
  expect(nags()).toBe(2);
  await post(`/api/decisions/${decisionId}/dismiss`, {});
  nagOpenDecisions(db, t0 + 300 * 60 * 1000); // closed: silent
  expect(nags()).toBe(2);
});

// ---- usage-limit park + timed resume -------------------------------------------

test("parseResetClock: next local occurrence, same day or tomorrow", async () => {
  const { parseResetClock } = await import("../src/diagnose.ts");
  const base = new Date("2026-07-11T10:00:00").getTime(); // local 10:00
  const later = Date.parse(parseResetClock("… resets 4:20pm (America/Los_Angeles)", base)!);
  expect(later).toBeGreaterThan(base);
  expect(new Date(later).getHours()).toBe(16);
  expect(new Date(later).getMinutes()).toBe(20);
  const wrapped = Date.parse(parseResetClock("resets 9am", base)!); // 9am already past → tomorrow
  expect(wrapped).toBeGreaterThan(base);
  expect(new Date(wrapped).getHours()).toBe(9);
  expect(parseResetClock("no clock here", base)).toBeNull();
});

test("usage-limited task parks once, then gets a resume steer after the reset", async () => {
  const { diagnosePane } = await import("../src/diagnose.ts");
  const { resumeUsageLimited } = await import("../src/reconciler.ts");
  const id = await newTask("limited");
  // The pane tail the reconciler would read:
  const diag = diagnosePane("some output\nYou've hit your session limit · resets 4:20pm (America/Los_Angeles)\n");
  expect(diag?.kind).toBe("usage_limit");

  // Park (recoverUsageLimit is internal; emulate via its event contract):
  db.query("INSERT INTO events (id, task_id, ts, source, type, payload) VALUES (?,?,?,?,?,?)").run(
    "ev_ul_test", id, new Date().toISOString(), "reconciler", "usage_limit",
    JSON.stringify({ resume_at: new Date(Date.now() + 1000).toISOString(), excerpt: "limit" })
  );
  db.query("UPDATE tasks SET state = 'in_progress' WHERE id = ?").run(id);

  resumeUsageLimited(db, Date.now()); // before resume_at: nothing
  expect(await events(id, "usage_limit_resumed")).toHaveLength(0);

  resumeUsageLimited(db, Date.now() + 5000); // after: steer queued + resumed
  expect(await events(id, "usage_limit_resumed")).toHaveLength(1);
  const steers = await events(id, "steer");
  expect(steers.at(-1).payload.message).toContain("usage-limit window has reset");
  expect(steers.at(-1).payload.delivery).toBe("queued");

  resumeUsageLimited(db, Date.now() + 9000); // idempotent
  expect(await events(id, "usage_limit_resumed")).toHaveLength(1);
});

test("newer session-limit park wording (HIVE-451 fixture) parks and resumes, and never reads as a blocked dialog", async () => {
  const { diagnosePane } = await import("../src/diagnose.ts");
  const { resumeUsageLimited } = await import("../src/reconciler.ts");
  const id = await newTask("limited (new wording)");
  const tail =
    "You have hit your session limit - resets 8:30pm (America/Los_Angeles)\n" +
    "Continuing automatically at 8:30pm - esc to cancel";
  const diag = diagnosePane(tail);
  expect(diag?.kind).toBe("usage_limit"); // not "blocked_dialog" — the "esc to cancel" echo must not win

  db.query("INSERT INTO events (id, task_id, ts, source, type, payload) VALUES (?,?,?,?,?,?)").run(
    "ev_ul_test2", id, new Date().toISOString(), "reconciler", "usage_limit",
    JSON.stringify({ resume_at: new Date(Date.now() + 1000).toISOString(), excerpt: diag && "excerpt" in diag ? diag.excerpt : "" })
  );
  db.query("UPDATE tasks SET state = 'in_progress' WHERE id = ?").run(id);

  resumeUsageLimited(db, Date.now() + 5000);
  expect(await events(id, "usage_limit_resumed")).toHaveLength(1);
  const steers = await events(id, "steer");
  expect(steers.at(-1).payload.message).toContain("usage-limit window has reset");
});

// ---- needs_decision unpark ------------------------------------------------------

test("needs_decision with no open card unparks after the grace period", async () => {
  const { unparkAnswered } = await import("../src/reconciler.ts");
  const id = await newTask("phantom decision");
  await post(`/api/tasks/${id}/transition`, { to: "in_progress" });
  await post(`/api/tasks/${id}/transition`, { to: "needs_decision" }); // no card opened
  const state = () => (db.query("SELECT state FROM tasks WHERE id = ?").get(id) as any).state;

  unparkAnswered(db, Date.now()); // inside grace: the card may still be coming
  expect(state()).toBe("needs_decision");
  unparkAnswered(db, Date.now() + 4 * 60 * 1000);
  expect(state()).toBe("in_progress");
  const steers = await events(id, "steer");
  expect(steers.at(-1).payload.message).toContain("NO open decision card");

  // With a real open card it stays parked no matter how old.
  const g = await post(`/api/tasks/${id}/guarded-action`, {
    action: "command.dangerous.recursive-forced-rm",
    target: "rm -rf /x",
    detail: "command approval (dangerous): recursive/forced rm",
    summary: "clear a scratch directory",
  });
  expect(g.status).toBe(409);
  await post(`/api/tasks/${id}/transition`, { to: "needs_decision" });
  unparkAnswered(db, Date.now() + 60 * 60 * 1000);
  expect(state()).toBe("needs_decision");
});

// ---- per-project stack teardown ------------------------------------------------------

test("cleanup runs config.cleanup_argv with {worktree} substituted, exactly once", async () => {
  const { cleanupTask } = await import("../src/cleanup.ts");
  const { Herdr } = await import("../src/runtime/herdr.ts");
  const p = await post("/api/projects", {
    name: "teardown-p",
    repo_path: "/repo",
    config: { cleanup_argv: ["infra/worktree/wt.sh", "down", "{worktree}"] },
  });
  const t = await post("/api/tasks", { project_id: p.json.id, title: "with stack" });
  db.query("UPDATE tasks SET state = 'cancelled', worktree_path = '/wts/hive-x', branch = 'hive/x' WHERE id = ?").run(t.json.id);

  const calls: string[][] = [];
  const exec = async (argv: string[]) => (calls.push(argv), { code: 0, stdout: "", stderr: "" });
  const stubHerdr = new Herdr(async () => ({ code: 0, stdout: "", stderr: "" }), "herdr");
  await cleanupTask(db, stubHerdr, t.json.id, { exec });
  expect(calls).toHaveLength(1);
  expect(calls[0]).toEqual(["/repo/infra/worktree/wt.sh", "down", "/wts/hive-x"]);
  const ev = db.query("SELECT payload FROM events WHERE task_id = ? AND type = 'stack_teardown'").all(t.json.id);
  expect(ev).toHaveLength(1);

  // re-running cleanup (reaper backstop) must not re-fire the teardown
  db.query("UPDATE tasks SET worktree_path = '/wts/hive-x' WHERE id = ?").run(t.json.id);
  await cleanupTask(db, stubHerdr, t.json.id, { exec, force: true });
  expect(calls).toHaveLength(1);
});

// ---- empty-review gates -------------------------------------------------------------

test("emit ready without evidence is held with instructions; passes once evidence exists", async () => {
  const id = await newTask("no empty reviews");
  await post(`/api/tasks/${id}/spawn`, {});
  const held = await post(`/api/tasks/${id}/events`, { type: "ready" });
  expect(held.json.held).toBe(true);
  expect(held.json.reason).toBe("no_evidence");
  expect((db.query("SELECT state FROM tasks WHERE id = ?").get(id) as any).state).toBe("in_progress");

  db.query("INSERT INTO evidence (id, task_id, ts, kind, path, caption) VALUES (?,?,?,?,?,?)").run(
    "evd_gate_t", id, new Date().toISOString(), "log", "/tmp/p.log", "proof"
  );
  await post(`/api/tasks/${id}/events`, { type: "ready" });
  expect((db.query("SELECT state FROM tasks WHERE id = ?").get(id) as any).state).toBe("in_review");
});

test("idle backstop never re-reviews after changes_requested until new evidence arrives", async () => {
  const { advanceIfFinished, writeEvent, transition } = await import("../src/state.ts");
  const id = await newTask("acknowledged is not addressed");
  db.query("UPDATE tasks SET state = 'in_progress', pr_url = 'https://gh/pr/9', ci_status = 'passing' WHERE id = ?").run(id);
  db.query("INSERT INTO evidence (id, task_id, ts, kind, path, caption) VALUES (?,?,?,?,?,?)").run(
    "evd_cr_1", id, new Date(Date.now() - 60_000).toISOString(), "log", "/tmp/a.log", "old proof"
  );
  writeEvent(db, { task_id: id, source: "director", type: "changes_requested", payload: { notes: "there are no evidences" } });
  expect(advanceIfFinished(db, id, "idle", "test")).toBe(false); // acked+idle ≠ addressed
  db.query("INSERT INTO evidence (id, task_id, ts, kind, path, caption) VALUES (?,?,?,?,?,?)").run(
    "evd_cr_2", id, new Date(Date.now() + 1000).toISOString(), "log", "/tmp/b.log", "new proof"
  );
  expect(advanceIfFinished(db, id, "idle", "test")).toBe(true); // visible new work → review
});

test("tracking-only tasks never enter automatic review handoffs", async () => {
  const { advanceIfFinished } = await import("../src/state.ts");
  const { handOffToReview } = await import("../src/api.ts");
  const id = await newTask("externally tracked");
  db.query("UPDATE tasks SET state = 'in_progress', source = 'external', source_ref = 'jira:WEB-1', pr_url = 'https://gh/pr/9' WHERE id = ?").run(id);
  db.query("INSERT INTO evidence (id, task_id, ts, kind, path, caption) VALUES (?,?,?,?,?,?)").run(
    "evd_tracking_handoff", id, new Date().toISOString(), "log", "/tmp/proof.log", "proof"
  );
  expect(advanceIfFinished(db, id, "idle", "reconciler")).toBe(false);
  expect(handOffToReview(db, id, "reconciler")).toBe(false);
  expect((db.query("SELECT state FROM tasks WHERE id = ?").get(id) as any).state).toBe("in_progress");
});

test("handOffToReview holds while a queued-input recovery is in flight (#1234 review-12)", async () => {
  const { writeEvent } = await import("../src/state.ts");
  const { handOffToReview } = await import("../src/api.ts");
  const id = await newTask("queued input mid-flight");
  db.query("UPDATE tasks SET state = 'in_progress', pr_url = 'https://gh/pr/9' WHERE id = ?").run(id);
  writeEvent(db, { task_id: id, source: "reconciler", type: "queued_input_recovered", payload: { delivered: true } });

  expect(handOffToReview(db, id, "reconciler")).toBe(false);
  expect((db.query("SELECT state FROM tasks WHERE id = ?").get(id) as any).state).toBe("in_progress");

  db.query("UPDATE events SET ts = ? WHERE task_id = ? AND type = 'queued_input_recovered'")
    .run(new Date(Date.now() - 3 * 60 * 1000).toISOString(), id);
  expect(handOffToReview(db, id, "reconciler")).toBe(true);
});

test("a director answer keeps an old report and quiz out of review until regenerated", async () => {
  const { decisionAnswerUnaddressed, writeEvent } = await import("../src/state.ts");
  const id = await newTask("refresh after my answer");
  await post(`/api/tasks/${id}/spawn`, {});
  const review = () => post(`/api/tasks/${id}/events`, {
    type: "review_summary",
    done: ["investigated the integration"],
    understanding: {
      background: "Authentication was initially blocked.",
      check: {
        question: "What changed?",
        options: [{ key: "input", label: "The director supplied new input." }, { key: "nothing", label: "Nothing changed." }],
        answer_key: "input",
      },
    },
  });
  await review();
  db.query("INSERT INTO evidence (id, task_id, ts, kind, path, caption) VALUES (?,?,?,?,?,?)").run(
    "evd_answer_freshness", id, new Date().toISOString(), "report", "/tmp/report.md", "report"
  );
  writeEvent(db, { task_id: id, source: "director", type: "decision_answered", payload: { answer_key: "provided" } });

  expect(decisionAnswerUnaddressed(db, id)).toBe(true);
  const held = await post(`/api/tasks/${id}/events`, { type: "ready" });
  expect(held.json.reason).toBe("stale_review");
  expect((await get(`/api/tasks/${id}`)).json.state).toBe("in_progress");

  await review();
  expect(decisionAnswerUnaddressed(db, id)).toBe(false);
  await post(`/api/tasks/${id}/events`, { type: "ready" });
  expect((await get(`/api/tasks/${id}`)).json.state).toBe("in_review");
});

test("reconciler handoff never re-queues after changes_requested until a new commit is pushed (#234)", async () => {
  const { handOffToReview } = await import("../src/api.ts");
  const { writeEvent } = await import("../src/state.ts");
  const id = await newTask("CI-green poll must not bounce a sent-back PR");
  db.query("UPDATE tasks SET state = 'in_progress', pr_url = 'https://gh/pr/242', ci_status = 'passing' WHERE id = ?").run(id);
  // baseline head known at request time (a pr_synchronized recorded before send-back).
  db.query("INSERT INTO events (id, task_id, ts, source, type, payload) VALUES (?,?,?,?,?,?)").run(
    "ev_sync_base", id, new Date(Date.now() - 5000).toISOString(), "reconciler", "pr_synchronized", JSON.stringify({ head_sha: "cafe0000" })
  );
  // director sends it back — CI is still green on the OLD head (baseline stamped in payload).
  writeEvent(db, { task_id: id, source: "director", type: "changes_requested", payload: { notes: "purple line on the right", head_sha: "cafe0000" } });
  expect(handOffToReview(db, id, "reconciler")).toBe(false); // green ≠ addressed
  expect((db.query("SELECT state FROM tasks WHERE id = ?").get(id) as any).state).toBe("in_progress");
  // reconciler polls again and re-records the SAME head — still not new work.
  db.query("INSERT INTO events (id, task_id, ts, source, type, payload) VALUES (?,?,?,?,?,?)").run(
    "ev_sync_same", id, new Date(Date.now() + 500).toISOString(), "reconciler", "pr_synchronized", JSON.stringify({ head_sha: "cafe0000" })
  );
  expect(handOffToReview(db, id, "reconciler")).toBe(false); // unchanged head ≠ addressed
  // agent pushes a fix → reconciler records the new head as pr_synchronized.
  db.query("INSERT INTO events (id, task_id, ts, source, type, payload) VALUES (?,?,?,?,?,?)").run(
    "ev_sync_242", id, new Date(Date.now() + 1000).toISOString(), "reconciler", "pr_synchronized", JSON.stringify({ head_sha: "deadbeef" })
  );
  expect(handOffToReview(db, id, "reconciler")).toBe(true); // new commit → review
  expect((db.query("SELECT state FROM tasks WHERE id = ?").get(id) as any).state).toBe("in_review");
});

test("reconciler handoff: post-request baseline pr_synchronized on unchanged head is not new work (#234 race)", async () => {
  const { handOffToReview } = await import("../src/api.ts");
  const { writeEvent } = await import("../src/state.ts");
  const id = await newTask("first pr_synchronized landing after send-back is a baseline");
  db.query("UPDATE tasks SET state = 'in_progress', pr_url = 'https://gh/pr/243', ci_status = 'passing' WHERE id = ?").run(id);
  // reached in_review via the ready-emit / linkPrIfMarked path — NO prior pr_synchronized,
  // so the head at request time is unknown (payload head_sha null).
  writeEvent(db, { task_id: id, source: "director", type: "changes_requested", payload: { notes: "no evidences", head_sha: null } });
  expect(handOffToReview(db, id, "reconciler")).toBe(false);
  // first syncPRs poll records the CURRENT (unchanged) head — this is the baseline, not new work.
  db.query("INSERT INTO events (id, task_id, ts, source, type, payload) VALUES (?,?,?,?,?,?)").run(
    "ev_sync_base243", id, new Date(Date.now() + 500).toISOString(), "reconciler", "pr_synchronized", JSON.stringify({ head_sha: "0ldhead0" })
  );
  expect(handOffToReview(db, id, "reconciler")).toBe(false); // first observation ≠ addressed
  expect((db.query("SELECT state FROM tasks WHERE id = ?").get(id) as any).state).toBe("in_progress");
  // only a SECOND, DIFFERENT head is a real push.
  db.query("INSERT INTO events (id, task_id, ts, source, type, payload) VALUES (?,?,?,?,?,?)").run(
    "ev_sync_new243", id, new Date(Date.now() + 1000).toISOString(), "reconciler", "pr_synchronized", JSON.stringify({ head_sha: "n3whead0" })
  );
  expect(handOffToReview(db, id, "reconciler")).toBe(true); // real push → review
  expect((db.query("SELECT state FROM tasks WHERE id = ?").get(id) as any).state).toBe("in_review");
});

// ---- generic decision answer reaches the agent -----------------------------------

test("answering a plain question card steers the answer to the live agent", async () => {
  const id = await newTask("blocked on a question");
  await post(`/api/tasks/${id}/spawn`, {});
  // a plain decision (no specialized resolver claims it)
  const d = await post("/api/decisions", {
    task_id: id,
    title: "Flip the runner, or check infra first?",
    context: "Choose whether to change the runner now or validate infrastructure first.",
    options: [
      { key: "flip", label: "Flip the runner now" },
      { key: "cautious", label: "Check AWS prereqs first" },
    ],
  });
  await post(`/api/decisions/${d.json.id}/answer`, { answer_key: "cautious", answer_note: "infra doesn't exist yet; don't deploy" });
  const steers = db.query("SELECT payload FROM events WHERE task_id = ? AND type='steer'").all(id).map((e: any) => JSON.parse(e.payload).message);
  expect(steers.at(-1)).toContain("Check AWS prereqs first");
  expect(steers.at(-1)).toContain("infra doesn't exist yet");
});

// ---- deny reason + recurring-deny guardrail ---------------------------------------

test("denying a command card steers the agent the reason; 3rd deny proposes a block-always rule", async () => {
  const id = await newTask("deny me");
  await post(`/api/tasks/${id}/spawn`, {});
  const gate = async () =>
    (await post(`/api/tasks/${id}/guarded-action`, {
      action: "command.dangerous.privilege-escalation",
      target: "sudo rm -rf /etc/x",
      detail: "command approval (dangerous): privilege escalation",
      summary: "reset permissions on the config dir",
    })).json.decision_id;

  // deny #1 with a reason → agent gets a steer carrying it
  const d1 = await gate();
  await post(`/api/decisions/${d1}/answer`, { answer_key: "deny", answer_note: "never sudo, ask me to do host changes" });
  const steers = () => db.query("SELECT payload FROM events WHERE task_id = ? AND type='steer'").all(id).map((e: any) => JSON.parse(e.payload).message);
  expect(steers().at(-1)).toContain("never sudo");
  expect(steers().at(-1)).toContain("DENIED");

  // deny #2, #3 → after the 3rd a block-always proposal opens
  const d2 = await gate();
  await post(`/api/decisions/${d2}/answer`, { answer_key: "deny" });
  const d3 = await gate();
  await post(`/api/decisions/${d3}/answer`, { answer_key: "deny" });
  const proposal: any = db
    .query("SELECT * FROM decisions WHERE title LIKE 'Always block%privilege-escalation%' AND status='open'")
    .get();
  expect(proposal).toBeTruthy();

  // approving it mints a project deny rule → the category now denies with no card
  await post(`/api/decisions/${proposal.id}/answer`, { answer_key: "block" });
  const rule = db.query("SELECT effect FROM authority_rules WHERE action_pattern = 'command.dangerous.privilege-escalation' AND active=1").get() as any;
  expect(rule.effect).toBe("deny");
  const blocked = await post(`/api/tasks/${id}/guarded-action`, {
    action: "command.dangerous.privilege-escalation",
    target: "sudo whoami",
    detail: "command approval (dangerous): privilege escalation",
  });
  expect(blocked.status).toBe(403); // standing deny, no new card
});

// task 1022: denials of decisions the explainer already called zero-risk
// must not count toward the "always block?" tally — otherwise a repeated
// classifier false positive mints a standing deny rule off its own noise.
test("denials on zero-risk-verdict decisions don't count toward the always-block tally", async () => {
  const id = await newTask("false-positive denies");
  await post(`/api/tasks/${id}/spawn`, {});
  const gate = async () =>
    (await post(`/api/tasks/${id}/guarded-action`, {
      action: "command.dangerous.sql-update-without-where",
      target: 'grep -rn "UPDATE tasks SET" server/src | grep -i source',
      detail: "command approval (dangerous): SQL UPDATE without WHERE",
      summary: "search for the SQL update site",
    })).json.decision_id;

  // 3 denials, each already marked zero-risk by the explainer (as if it ran
  // before the director answered) → no block-always proposal.
  for (let i = 0; i < 3; i++) {
    const did = await gate();
    db.query("UPDATE decisions SET explainer_verdict = 'zero-risk' WHERE id = ?").run(did);
    await post(`/api/decisions/${did}/answer`, { answer_key: "deny" });
  }
  expect(
    db.query("SELECT 1 FROM decisions WHERE title LIKE 'Always block%sql-update-without-where%' AND status='open'").get()
  ).toBeFalsy();

  // a 4th, unexplained (real) denial pushes the real tally to 1 — still no
  // proposal until a 3rd REAL denial is reached.
  const d4 = await gate();
  await post(`/api/decisions/${d4}/answer`, { answer_key: "deny" });
  expect(
    db.query("SELECT 1 FROM decisions WHERE title LIKE 'Always block%sql-update-without-where%' AND status='open'").get()
  ).toBeFalsy();
  const d5 = await gate();
  await post(`/api/decisions/${d5}/answer`, { answer_key: "deny" });
  const d6 = await gate();
  await post(`/api/decisions/${d6}/answer`, { answer_key: "deny" });
  expect(
    db.query("SELECT 1 FROM decisions WHERE title LIKE 'Always block%sql-update-without-where%' AND status='open'").get()
  ).toBeTruthy();
});

// ---- command-card context ----------------------------------------------------------

test("command cards carry intent, the literal command, category explanation, and answer semantics", async () => {
  const id = await newTask("context rich");
  const g = await post(`/api/tasks/${id}/guarded-action`, {
    action: "command.dangerous.recursive-forced-rm",
    target: "rm -rf /some/path",
    detail: "command approval (dangerous): recursive/forced rm",
    summary: "Clean the build output directory",
  });
  expect(g.status).toBe(409);
  const d: any = db.query("SELECT context FROM decisions WHERE id = ?").get(g.json.decision_id);
  expect(d.context).toContain("Clean the build output directory"); // intent
  expect(d.context).toContain("rm -rf /some/path"); // literal command
  expect(d.context).toContain("no trash, no undo"); // category explanation
  expect(d.context).toContain("Approve & always allow"); // answer semantics
});

test("explainCommandDecision appends the haiku explanation to an OPEN card only", async () => {
  const { explainCommandDecision } = await import("../src/explain.ts");
  const id = await newTask("explain me");
  const g = await post(`/api/tasks/${id}/guarded-action`, {
    action: "command.dangerous.process-kill",
    target: "pkill -f something",
    detail: "command approval (dangerous): process kill",
    summary: "kill the stray test server",
  });
  const did = g.json.decision_id;
  const stubExec = async () => ({ code: 0, stdout: JSON.stringify({ result: "- kills processes matching 'something'" }), stderr: "" });
  await explainCommandDecision(db, did, "pkill -f something", { exec: stubExec });
  const d: any = db.query("SELECT context FROM decisions WHERE id = ?").get(did);
  expect(d.context).toContain("auto-explained");
  expect(d.context).toContain("kills processes matching");

  // answered card: enrichment must not rewrite history
  await post(`/api/decisions/${did}/answer`, { answer_key: "deny" });
  await explainCommandDecision(db, did, "pkill -f something", { exec: stubExec });
  const after: any = db.query("SELECT context FROM decisions WHERE id = ?").get(did);
  expect(after.context).toBe(d.context);
});

// task 1022: the explainer's structured verdict flips the recommended
// answer (never auto-decides — the gate is server-enforced, not LLM-enforced)
// and is stored so the deny-guardrail tally can exclude false-positive denials.
test("a zero-risk explainer verdict flips the recommended option away from Deny; real-risk leaves it", async () => {
  const { explainCommandDecision } = await import("../src/explain.ts");
  const optionsOf = (did: string) => JSON.parse((db.query("SELECT options FROM decisions WHERE id = ?").get(did) as any).options);
  const recommended = (opts: any[]) => opts.find((o) => o.recommended)?.key;
  const id = await newTask("explainer verdict");

  const zeroRisk = await post(`/api/tasks/${id}/guarded-action`, {
    action: "command.dangerous.sql-update-without-where",
    target: 'grep -rn "UPDATE tasks SET" server/src | grep -i source',
    detail: "command approval (dangerous): SQL UPDATE without WHERE",
    summary: "search for the SQL update site",
  });
  const zeroExec = async () => ({
    code: 0,
    stdout: JSON.stringify({ result: "VERDICT: zero-risk\n- greps two files for text, no database access, zero risk" }),
    stderr: "",
  });
  await explainCommandDecision(db, zeroRisk.json.decision_id, "grep …", { exec: zeroExec });
  expect((db.query("SELECT explainer_verdict FROM decisions WHERE id = ?").get(zeroRisk.json.decision_id) as any).explainer_verdict).toBe(
    "zero-risk"
  );
  expect(recommended(optionsOf(zeroRisk.json.decision_id))).toBe("approve");

  const realRisk = await post(`/api/tasks/${id}/guarded-action`, {
    action: "command.dangerous.sql-update-without-where",
    target: 'mysql -e "UPDATE tasks SET status=1"',
    detail: "command approval (dangerous): SQL UPDATE without WHERE",
    summary: "run the update",
  });
  const realExec = async () => ({
    code: 0,
    stdout: JSON.stringify({ result: "VERDICT: real-risk\n- mutates every row in tasks, no WHERE clause" }),
    stderr: "",
  });
  await explainCommandDecision(db, realRisk.json.decision_id, "mysql …", { exec: realExec });
  expect(recommended(optionsOf(realRisk.json.decision_id))).toBe("deny");
});

// ---- pane view --------------------------------------------------------------------

test("GET /pane returns the agent's pane text with ANSI stripped; 404 when agentless", async () => {
  const id = await newTask("watch me work");
  const bare = await fetch(`${BASE}/api/tasks/${id}/pane`);
  expect(bare.status).toBe(404); // not spawned yet
  await post(`/api/tasks/${id}/spawn`, {});
  // stub herdr serves agent read via the generic OK(); patch exec path: our stub returns "" for reads,
  // so exercise the strip logic through a direct fetch and shape-check the response.
  const r = await fetch(`${BASE}/api/tasks/${id}/pane?lines=50`);
  expect(r.status).toBe(200);
  const body: any = await r.json() as any;
  expect(body.agent_target).toBe(id);
  expect(typeof body.text).toBe("string");
  expect(body.lines).toBe(50);
});

// ---- answer channel -------------------------------------------------------------

test("emit answer writes the event and pushes an urgent notification", async () => {
  const id = await newTask("answer me");
  const r = await post(`/api/tasks/${id}/events`, { type: "answer", note: "AES encrypts only the business registration number" });
  expect(r.status).toBe(201);
  const n: any = db
    .query("SELECT * FROM notifications WHERE kind = 'answer' AND task_id = ?")
    .get(id);
  expect(n.urgency).toBe("urgent");
  expect(n.body).toContain("business registration");
  const bad = await post(`/api/tasks/${id}/events`, { type: "answer" });
  expect(bad.status).toBe(400); // an empty answer is a bug, not a reply
});

// ---- remote token gate ----------------------------------------------------------

test("remote requests need the API token; loopback never does", async () => {
  const { remoteAuthOk } = await import("../src/api.ts");
  const { decisionAnswerToken } = await import("../src/push.ts");
  const { setSetting } = await import("../src/db.ts");
  const u = new URL("http://x/api/tasks");
  const r = (auth?: string) => new Request("http://x/api/tasks", auth ? { headers: { authorization: auth } } : {});
  expect(remoteAuthOk(db, r(), u, "127.0.0.1")).toBe(true);
  expect(remoteAuthOk(db, r(), u, "::1")).toBe(true);
  expect(remoteAuthOk(db, r(), u, null)).toBe(true); // no ip info: local test/serve path
  expect(remoteAuthOk(db, r(), u, "192.168.1.20")).toBe(false); // no token minted → locked
  setSetting(db, "api_token", "sekrit");
  expect(remoteAuthOk(db, r("Bearer sekrit"), u, "192.168.1.20")).toBe(true);
  expect(remoteAuthOk(db, r("Bearer wrong"), u, "192.168.1.20")).toBe(false);
  expect(remoteAuthOk(db, r(), u, "192.168.1.20")).toBe(false);
  // EventSource can't set headers → query-param form
  expect(remoteAuthOk(db, r(), new URL("http://x/api/stream?token=sekrit"), "10.0.0.9")).toBe(true);
  const answerToken = decisionAnswerToken(db, "dec_1")!;
  const answerRequest = new Request("http://x/api/decisions/dec_1/answer", {
    method: "POST",
    headers: { authorization: `Bearer ${answerToken}` },
  });
  expect(remoteAuthOk(db, answerRequest, new URL(answerRequest.url), "192.168.1.20")).toBe(true);
  expect(remoteAuthOk(db, answerRequest, new URL("http://x/api/decisions/dec_2/answer"), "192.168.1.20")).toBe(false);
  expect(remoteAuthOk(db, answerRequest, u, "192.168.1.20")).toBe(false);
});

// ---- intake noise -------------------------------------------------------------

test("emoji-only and bare-ack intake text is non-actionable; real asks are not", () => {
  for (const s of ["👍", "네!", "ㅋㅋㅋ", "ok", "Thanks!!", "  ", "😄😄"]) {
    expect(isNonActionableIntake(s)).toBe(true);
  }
  for (const s of ["네, 그런데 배포는 언제 하나요?", "fix the login bug", "ok but the build is red"]) {
    expect(isNonActionableIntake(s)).toBe(false);
  }
});
