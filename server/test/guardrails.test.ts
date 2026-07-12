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
  return { status: res.status, json: await res.json() };
}
async function get(path: string) {
  const res = await fetch(BASE + path);
  return { status: res.status, json: await res.json() };
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
  const r = await post("/api/steer/broadcast", { message: "fleet: new rule" });
  expect(r.json.targets).toBe(2);
  expect(r.json.delivered).toBe(2);
  expect(sends.filter((s) => s.includes("fleet: new rule"))).toHaveLength(2);
});

test("creating an active policy auto-broadcasts it to live agents", async () => {
  sends.length = 0;
  await post("/api/policies", { title: "no force push", body: "never force push" });
  await new Promise((r) => setTimeout(r, 100)); // fire-and-forget broadcast
  const hit = sends.filter((s) => s.includes("Protocol update") && s.includes("no force push"));
  expect(hit.length).toBeGreaterThanOrEqual(1);
});

// ---- decision dismiss recovery ----------------------------------------------

test("dismissing an authority card denies the grant and steers the agent", async () => {
  const id = await newTask("dismiss recovery");
  const g1 = await post(`/api/tasks/${id}/guarded-action`, {
    action: "command.dangerous.process-kill",
    target: "pkill -f vite",
    detail: "command approval (dangerous): process kill",
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

// ---- intake noise -------------------------------------------------------------

test("emoji-only and bare-ack intake text is non-actionable; real asks are not", () => {
  for (const s of ["👍", "네!", "ㅋㅋㅋ", "ok", "Thanks!!", "  ", "😄😄"]) {
    expect(isNonActionableIntake(s)).toBe(true);
  }
  for (const s of ["네, 그런데 배포는 언제 하나요?", "fix the login bug", "ok but the build is red"]) {
    expect(isNonActionableIntake(s)).toBe(false);
  }
});
