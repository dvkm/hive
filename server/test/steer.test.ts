// Steer delivery receipts + queued redelivery (server/src/steer.ts).
// The bug: a steer to a task with no live agent vanished, so it got re-sent 3×.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "hive-steer-"));
process.env.HIVE_HOME = HOME;

const { openDb } = await import("../src/db.ts");
const { makeHandler } = await import("../src/api.ts");
const { reconcileOnce } = await import("../src/reconciler.ts");
const { Herdr, sendFailure } = await import("../src/runtime/herdr.ts");
import type { Exec, ExecResult } from "../src/exec.ts";

const OK = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const WT = join(HOME, "wt");
const has = (argv: string[], ...xs: string[]) => xs.every((x) => argv.includes(x));
const ALIVE = () => OK('{"result":{"agent":{"pane_id":"p1","agent_status":"working"}}}');
const DEAD = () => OK('{"error":{"code":"agent_not_found"}}');
// The reconciler shells out to `gh`; keep it off the network in these tests.
const NO_GH: Exec = async () => ({ code: 1, stdout: "", stderr: "no gh" });

// Records the brief every `agent start` received, and every `agent send` attempt.
// `getResult` drives `agent get`, which is both the aliveness probe and the pane
// lookup that submits a send.
function stubHerdr(sendResult: () => ExecResult = () => OK(), getResult: () => ExecResult = ALIVE) {
  const briefs: string[] = [];
  const sends: string[] = [];
  const exec: Exec = async (argv) => {
    if (has(argv, "worktree", "create"))
      return OK(`{"result":{"worktree":{"path":${JSON.stringify(WT)},"branch":"hive/x","open_workspace_id":"w1"}}}`);
    if (has(argv, "agent", "get")) return getResult();
    if (has(argv, "workspace", "list")) return OK('{"result":{"workspaces":[{"workspace_id":"wF","label":"hive-fleet"}]}}');
    if (has(argv, "tab", "create")) return OK('{"result":{"tab":{"tab_id":"wF:t2"}}}');
    if (has(argv, "agent", "start")) {
      briefs.push(argv[argv.indexOf("--") + 2]); // `-- claude <brief> …`
      return OK();
    }
    if (has(argv, "agent", "send")) {
      sends.push(argv[argv.indexOf("send") + 2]);
      return sendResult();
    }
    return OK();
  };
  return { herdr: new Herdr(exec, "herdr"), briefs, sends };
}

let server: any;
let BASE = "";
let projectId = "";
const db = openDb(":memory:");
const { herdr, briefs, sends } = stubHerdr();

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
const steerEvents = async (id: string) =>
  (await get(`/api/tasks/${id}/events`)).json.filter((e: any) => e.type === "steer");
// Since #996, spawnAgent itself rejects a never-dispatched external task's
// first spawn — so "manually spawned before" now has to be faked the same
// way #996's own tests do: write the permanent `spawned` event directly,
// which is all supervision.ts's neverDispatched actually checks. A real
// POST /spawn afterwards then succeeds normally, same as recovery would see.
let spawnEventSeq = 0;
const fakePriorSpawn = (taskId: string) =>
  db
    .query("INSERT INTO events (id, task_id, ts, source, type, payload) VALUES (?,?,?,?,?,?)")
    .run(`ev_prior_spawn_${++spawnEventSeq}`, taskId, new Date().toISOString(), "herdr", "spawned", JSON.stringify({ agent_target: "t-old" }));

// The headline fix: no live agent -> queued, then carried by the next spawn.
test("a steer to a task with no agent is queued and delivered on the next spawn", async () => {
  const id = await newTask("no agent yet");
  const r = await post(`/api/tasks/${id}/send`, { message: "use the OAuth creds in 1password", actor: "director-tab-b" });
  expect(r.json.delivery).toBe("queued");
  expect(r.json.delivered).toBe(false);
  expect((await steerEvents(id))[0].payload).toMatchObject({ delivery: "queued", actor: "director-tab-b" });

  const spawn = await post(`/api/tasks/${id}/spawn`, {});
  expect(spawn.json.ok).toBe(true);

  // It rode in on the brief, above the task heading...
  const brief = briefs.at(-1)!;
  expect(brief).toContain("## Steers waiting for you");
  expect(brief).toContain("1. use the OAuth creds in 1password");
  expect(brief.indexOf("Steers waiting")).toBeLessThan(brief.indexOf("# Task P-"));

  // ...and the receipt flipped, so the UI stops showing it as queued.
  const ev = (await steerEvents(id))[0];
  expect(ev.payload.delivery).toBe("delivered");
  expect(ev.payload.delivered_via).toBe("respawn");
});

test("a message on a Jira-linked task becomes a Jira comment, not a dead steer", async () => {
  const id = await newTask("[WEB-7] Jira issue");
  db.query("UPDATE tasks SET source = 'external', source_ref = 'jira:WEB-7' WHERE id = ?").run(id);
  const before = sends.length;
  const r = await post(`/api/tasks/${id}/send`, { message: "please add a regression test" });
  expect(r.json).toMatchObject({ ok: true, delivered: false, delivery: "queued" });
  expect(sends).toHaveLength(before);
  expect(await steerEvents(id)).toHaveLength(0);
  const events = (await get(`/api/tasks/${id}/events`)).json.filter((e: any) => e.type === "jira_comment");
  expect(events).toHaveLength(1);
  expect(events[0].payload).toMatchObject({ direction: "outbound", text: "please add a regression test" });
});

test("a delivered steer is receipted and not replayed into a later spawn", async () => {
  const id = await newTask("live agent");
  await post(`/api/tasks/${id}/spawn`, {});
  const r = await post(`/api/tasks/${id}/send`, { message: "ship it" });
  expect(r.json).toMatchObject({ ok: true, delivered: true, delivery: "delivered" });
  expect(sends.at(-1)).toBe("ship it");
  expect((await steerEvents(id))[0].payload.delivered_at).toBeTruthy();

  await post(`/api/tasks/${id}/spawn`, {}); // respawn
  expect(briefs.at(-1)).not.toContain("Steers waiting for you");
});

test("a teammate message is attributed, replyable, and uses the durable steer path", async () => {
  const sender = await newTask("API worker");
  const recipient = await newTask("UI worker");
  await post(`/api/tasks/${recipient}/spawn`, {});

  const r = await post(`/api/tasks/${recipient}/send`, {
    message: "Can the response include session_expires_at?",
    from_task_id: sender,
  });
  expect(r.status).toBe(200);
  expect(r.json.delivery).toBe("delivered");
  expect(sends.at(-1)).toContain("[teammate #");
  expect(sends.at(-1)).toContain("API worker");
  expect(sends.at(-1)).toContain("session_expires_at");
  expect(sends.at(-1)).toContain(`task send ${sender}`);

  const event = (await steerEvents(recipient)).at(-1);
  expect(event.source).toBe("agent");
  expect(event.payload.from_task_id).toBe(sender);

  const bad = await post(`/api/tasks/${recipient}/send`, { message: "spoof", from_task_id: "missing" });
  expect(bad.status).toBe(400);
  expect(bad.json.error).toContain("unknown from_task_id");
});

// herdr exits 0 with an error body when the agent is gone — the silent drop.
test("an exit-0 agent_not_found body is a failure, not a delivery", () => {
  expect(sendFailure(OK('{"error":{"code":"agent_not_found"}}'))).toBe("agent_not_found");
  expect(sendFailure(OK('{"result":{"ok":true}}'))).toBeNull();
  expect(sendFailure({ code: 1, stdout: "", stderr: "boom" })).toBe("boom");
});

// Text parked in a composer was never received. A pane-less agent is herdr's own
// signal for "dead" (parseAgentProbe), so the Enter cannot land — never a receipt.
test("a send to a pane-less agent is a failure, not a silent delivery", async () => {
  const exec: Exec = async (argv) =>
    has(argv, "agent", "get") ? OK('{"result":{"agent":{"pane_id":null}}}') : OK();
  const r = await new Herdr(exec, "herdr").send("t1", "ship it");
  expect(r.code).not.toBe(0);
  expect(r.stderr).toContain("not active");
});

test("a failing herdr send retries once, then queues the steer", async () => {
  const fail = stubHerdr(() => OK('{"error":{"code":"agent_not_found"}}'));
  const db2 = openDb(":memory:");
  const srv = Bun.serve({ port: 0, fetch: makeHandler(db2, { herdr: fail.herdr }) });
  const b2 = `http://127.0.0.1:${srv.port}`;
  const p = await (await fetch(b2 + "/api/projects", { method: "POST", body: JSON.stringify({ name: "p", repo_path: "/r" }) })).json();
  const t = await (await fetch(b2 + "/api/tasks", { method: "POST", body: JSON.stringify({ project_id: p.id, title: "dead agent" }) })).json();
  await fetch(b2 + `/api/tasks/${t.id}/spawn`, { method: "POST", body: "{}" });

  const res = await (await fetch(b2 + `/api/tasks/${t.id}/send`, { method: "POST", body: JSON.stringify({ message: "retry me" }) })).json();
  expect(res.delivery).toBe("queued");
  expect(res.error).toBe("agent_not_found");
  expect(fail.sends).toEqual(["retry me", "retry me"]); // tried twice
  const events = await (await fetch(b2 + `/api/tasks/${t.id}/events`)).json();
  expect(events.some((e: any) => e.type === "steer_error")).toBe(true);

  // A respawn drains the queue.
  await fetch(b2 + `/api/tasks/${t.id}/spawn`, { method: "POST", body: "{}" });
  expect(fail.briefs.at(-1)).toContain("1. retry me");
  srv.stop(true);
});

// ---- reconciler drain (queued steer -> live agent, no respawn needed) ----
// Spins its own server+db: these tests need a herdr whose send/probe flip
// mid-test, which the module-level stub can't do.
async function drainFixture(sendResult: () => ExecResult, getResult: () => ExecResult) {
  const s = stubHerdr(sendResult, getResult);
  const db2 = openDb(":memory:");
  const srv = Bun.serve({ port: 0, fetch: makeHandler(db2, { herdr: s.herdr }) });
  const b = `http://127.0.0.1:${srv.port}`;
  const call = async (p: string, body?: unknown) =>
    (await fetch(b + p, body === undefined ? {} : { method: "POST", body: JSON.stringify(body) })).json();
  const proj = await call("/api/projects", { name: "p", repo_path: "/r" });
  const task = await call("/api/tasks", { project_id: proj.id, title: "live agent, blipping socket" });
  await call(`/api/tasks/${task.id}/spawn`, {}); // sets agent_target, -> in_progress
  const steer = async (id: string) => (await call(`/api/tasks/${id}/events`)).filter((e: any) => e.type === "steer")[0];
  return { ...s, db: db2, id: task.id, call, steer, stop: () => srv.stop(true) };
}

// The gap #80 left behind: herdr blips for a few seconds while the agent is
// alive and working. Both send attempts fail, the steer queues — and because the
// task is never respawned, it used to sit there undelivered until the task ended.
test("the reconciler drains a queued steer to an agent that is alive", async () => {
  let blip = true;
  const f = await drainFixture(() => (blip ? { code: 1, stdout: "", stderr: "connection refused" } : OK()), ALIVE);

  const r = await f.call(`/api/tasks/${f.id}/send`, { message: "use the staging DB, not prod" });
  expect(r.delivery).toBe("queued"); // queued despite a live agent — the bug
  expect(f.sends).toEqual(["use the staging DB, not prod", "use the staging DB, not prod"]);

  blip = false; // herdr comes back; no respawn happens, the agent never died
  await reconcileOnce(f.db, { herdr: f.herdr, exec: NO_GH });

  expect(f.sends.at(-1)).toBe("use the staging DB, not prod"); // re-sent, third attempt
  expect(f.sends.length).toBe(3);
  const ev = await f.steer(f.id);
  expect(ev.payload.delivery).toBe("delivered");
  expect(ev.payload.delivered_via).toBe("drain");
  expect(ev.payload.delivered_at).toBeTruthy();
  expect(ev.payload.error).toBeUndefined(); // the stale "why it queued" is dropped

  // Idempotent: a delivered steer is not re-sent on the next cycle.
  await reconcileOnce(f.db, { herdr: f.herdr, exec: NO_GH });
  expect(f.sends.length).toBe(3);
  f.stop();
});

// A genuinely dead agent must keep its steers queued for the next spawn's brief.
// hive-1097: an operator steer to a task whose agent was just killed (e.g. by a
// self-deploy restart) must never come back as a bare 200 — the caller needs
// the failure in the response body itself, not just in the event log.
test("the reconciler leaves a queued steer alone when the agent is dead", async () => {
  const f = await drainFixture(() => OK(), DEAD); // send lands, but the pane is gone

  const r = await f.call(`/api/tasks/${f.id}/send`, { message: "rebase onto main" });
  expect(r.ok).toBe(false);
  expect(r.delivered).toBe(false);
  expect(r.delivery).toBe("queued");
  expect(r.error).toContain("agent is not active");
  const errEvents = (await f.call(`/api/tasks/${f.id}/events`)).filter((e: any) => e.type === "steer_error");
  expect(errEvents.at(-1)?.payload.error).toBe("agent is not active; refusing to steer its shell pane");
  const before = f.sends.length;

  await reconcileOnce(f.db, { herdr: f.herdr, exec: NO_GH });

  expect(f.sends.length).toBe(before); // dead probe -> no send attempted at all
  expect((await f.steer(f.id)).payload.delivery).toBe("queued");

  // Still queued means the respawn path still carries it.
  await f.call(`/api/tasks/${f.id}/spawn`, {});
  expect(f.briefs.at(-1)).toContain("1. rebase onto main");
  expect((await f.steer(f.id)).payload.delivered_via).toBe("respawn");
  f.stop();
});

// Queuing a steer for a task nothing will ever respawn would be a lie.
test("a steer to a terminal task is recorded as failed, not queued", async () => {
  const id = await newTask("cancelled");
  await post(`/api/tasks/${id}/transition`, { to: "cancelled", reason: "obsolete" });
  const r = await post(`/api/tasks/${id}/send`, { message: "too late" });
  expect(r.json.delivery).toBe("failed");
  expect((await steerEvents(id))[0].payload.delivery).toBe("failed");
});

// source='external' (tracking-only) tasks are never dispatched (supervision.ts),
// so nothing will ever respawn them to carry a queued steer — /send used to
// report delivery:'queued' anyway, implying a delivery that would never happen.
// (A Jira-linked external task is the exception — see the Jira comment test
// above; it has a real delivery path, so it does NOT hit this rejection.)
test("a steer to a tracking-only (source=external) task is rejected, not queued", async () => {
  const t = await post("/api/tasks", { project_id: projectId, title: "mirrored JIRA issue", source: "external" });
  const r = await post(`/api/tasks/${t.json.id}/send`, { message: "never delivered" });
  expect(r.status).toBe(400);
  expect(r.json.error).toContain("external");
  expect(await steerEvents(t.json.id)).toEqual([]); // rejected before anything was recorded
});

// The same "queued" lie can happen off the /send path: a decision answered (or
// dismissed) on an external task falls back to queueSteerEvent to notify the
// agent. The shared helper (steer.ts) short-circuits it to 'failed' instead.
test("queueSteerEvent records failed, not queued, for a decision answered on an external task", async () => {
  const t = await post("/api/tasks", { project_id: projectId, title: "tracked", source: "external" });
  const d = await post("/api/decisions", {
    task_id: t.json.id,
    title: "external gate",
    context: "Test decision on a tracking-only task.",
    options: [{ key: "a", label: "A" }],
  });
  const ans = await post(`/api/decisions/${d.json.id}/answer`, { answer_key: "a" });
  expect(ans.status).toBe(200);
  const steer = (await steerEvents(t.json.id)).at(-1);
  expect(steer.payload.delivery).toBe("failed");
});

test("queueSteerEvent records failed, not queued, for a decision dismissed on an external task", async () => {
  const t = await post("/api/tasks", { project_id: projectId, title: "tracked2", source: "external" });
  const d = await post("/api/decisions", {
    task_id: t.json.id,
    title: "external gate 2",
    context: "Test dismiss on a tracking-only task.",
    options: [{ key: "a", label: "A" }],
  });
  const dis = await post(`/api/decisions/${d.json.id}/dismiss`, {});
  expect(dis.status).toBe(200);
  const steer = (await steerEvents(t.json.id)).at(-1);
  expect(steer.payload.delivery).toBe("failed");
});

// queueSteerEvent deliberately does NOT special-case a Jira-linked task the
// way sendSteer's own jiraLinked branch does: every queueSteerEvent caller
// writes hive-internal automation text ("proceed on this basis"), and
// posting that verbatim as a live comment on a real Jira issue would leak
// jargon nobody watching that ticket should see. A never-dispatched
// Jira-linked task gets the same honest 'failed' as any other.
test("queueSteerEvent does not post to Jira for a decision answered on a never-dispatched Jira-linked task", async () => {
  const id = await newTask("[WEB-9] Jira issue");
  db.query("UPDATE tasks SET source = 'external', source_ref = 'jira:WEB-9' WHERE id = ?").run(id);
  const d = await post("/api/decisions", {
    task_id: id,
    title: "jira gate",
    context: "Test decision on a Jira-linked task.",
    options: [{ key: "a", label: "A" }],
  });
  const ans = await post(`/api/decisions/${d.json.id}/answer`, { answer_key: "a" });
  expect(ans.status).toBe(200);
  const steer = (await steerEvents(id)).at(-1);
  expect(steer.payload.delivery).toBe("failed");
  const comments = (await get(`/api/tasks/${id}/events`)).json.filter((e: any) => e.type === "jira_comment");
  expect(comments).toHaveLength(0);
});

// requestChanges now rejects a never-dispatched external task outright (#996,
// server/src/api.ts requestChanges) before ever calling bounceForChanges, so
// this never reaches queueSteerEvent — confirm no spawn and no stray steer
// or changes_requested event either.
test("request-changes on a source=external task is rejected and does not spawn an agent", async () => {
  const t = await post("/api/tasks", { project_id: projectId, title: "tracked, in review", source: "external" });
  await post(`/api/tasks/${t.json.id}/transition`, { to: "in_progress" });
  await post(`/api/tasks/${t.json.id}/transition`, { to: "in_review" });
  const briefsBefore = briefs.length;
  const r = await post(`/api/tasks/${t.json.id}/request-changes`, { notes: "fix the thing" });
  expect(r.status).toBe(409);
  expect(r.json.error).toContain("never been spawned");
  expect(briefs.length).toBe(briefsBefore); // no agent was spawned
  expect(await steerEvents(t.json.id)).toEqual([]); // rejected before anything was recorded
});

// A Jira-linked task in this same never-dispatched state is rejected too. It
// now trips the JIRA-MIRROR gate rather than the neverDispatched one, because
// two rules apply and the mirror rule is the permanent one: "never spawned" can
// stop being true the moment someone dispatches, while "this mirrors someone
// else's ticket" never does. The rejection is what the test pins; which of the
// two reasons is reported is deliberately not over-specified beyond it naming
// the mirror.
test("request-changes on a never-dispatched Jira-linked external task is also rejected, not routed to Jira", async () => {
  const id = await newTask("[WEB-12] Jira issue, in review");
  db.query("UPDATE tasks SET source = 'external', source_ref = 'jira:WEB-12' WHERE id = ?").run(id);
  await post(`/api/tasks/${id}/transition`, { to: "in_progress" });
  await post(`/api/tasks/${id}/transition`, { to: "in_review" });
  const briefsBefore = briefs.length;
  const r = await post(`/api/tasks/${id}/request-changes`, { notes: "fix the thing" });
  expect(r.status).toBe(409);
  expect(r.json.error).toContain("mirrors a Jira issue");
  expect(briefs.length).toBe(briefsBefore);
  expect(await steerEvents(id)).toEqual([]);
  const comments = (await get(`/api/tasks/${id}/events`)).json.filter((e: any) => e.type === "jira_comment");
  expect(comments).toHaveLength(0);
});

// The core gap the third review pass found: source=external only means
// "never AUTO-dispatched" — a task that was spawned once before (recovery,
// or here, a legacy row that predates #996's first-spawn gate) CAN still
// have a real, live agent. Once that's true, /send and queueSteerEvent must
// both treat it like any other live task, not reject or dead-letter a
// message that could actually reach someone.
test("a steer to a manually-spawned (source=external, has agent_target) task is delivered normally, not rejected", async () => {
  const t = await post("/api/tasks", { project_id: projectId, title: "tracked, manually dispatched", source: "external" });
  fakePriorSpawn(t.json.id); // was spawned before — #996's neverDispatched gate no longer applies
  const spawn = await post(`/api/tasks/${t.json.id}/spawn`, {});
  expect(spawn.json.ok).toBe(true);

  const r = await post(`/api/tasks/${t.json.id}/send`, { message: "ship it" });
  expect(r.status).toBe(200);
  expect(r.json.delivery).toBe("delivered"); // not the 400 a never-spawned external task gets
});

test("queueSteerEvent records queued, not failed, for a manually-spawned (source=external) task", async () => {
  const t = await post("/api/tasks", { project_id: projectId, title: "tracked, manually dispatched 2", source: "external" });
  fakePriorSpawn(t.json.id);
  await post(`/api/tasks/${t.json.id}/spawn`, {});
  const d = await post("/api/decisions", {
    task_id: t.json.id,
    title: "gate on a live external task",
    context: "Test decision on a manually-dispatched tracking-only task.",
    options: [{ key: "a", label: "A" }],
  });
  const ans = await post(`/api/decisions/${d.json.id}/answer`, { answer_key: "a" });
  expect(ans.status).toBe(200);
  const steer = (await steerEvents(t.json.id)).at(-1);
  expect(steer.payload.delivery).toBe("queued"); // a live agent (or a future manual respawn) may still carry it
});

// The fourth review pass caught this: task.agent_target is NOT a permanent
// "was this ever spawned" marker. cleanup.ts nulls it on terminal cleanup,
// and a failed->queued requeue (state.ts) nulls it unconditionally too — so
// a task that genuinely ran once would otherwise look identical to one that
// never has, right after either event. neverDispatched must survive that.
test("a requeue nulling agent_target does not make an already-spawned external task look never-dispatched", async () => {
  const t = await post("/api/tasks", { project_id: projectId, title: "tracked, spawned then requeued", source: "external" });
  fakePriorSpawn(t.json.id); // was spawned before — #996's neverDispatched gate no longer applies
  await post(`/api/tasks/${t.json.id}/spawn`, {}); // writes the permanent 'spawned' event
  await post(`/api/tasks/${t.json.id}/transition`, { to: "failed", reason: "test" });
  await post(`/api/tasks/${t.json.id}/transition`, { to: "queued" }); // nulls agent_target (state.ts)
  const after = await get(`/api/tasks/${t.json.id}`);
  expect(after.json.agent_target).toBeNull(); // confirm the precondition really holds

  const r = await post(`/api/tasks/${t.json.id}/send`, { message: "still not permanently undeliverable" });
  expect(r.status).toBe(200); // not the 400 a truly never-spawned task gets
  expect(r.json.delivery).toBe("queued"); // no live agent_target right now, but not a lie either
});

// The merge seam: attachment paths live in the stored message (text + block), so
// a queued steer with a file carries that file's path into the respawn brief.
test("a queued steer's attachment path rides along into the respawn brief", async () => {
  const id = await newTask("no agent, has file");
  const fd = new FormData();
  fd.append("message", "review this trace");
  fd.append("files", new File([new Uint8Array([1, 2, 3, 4])], "trace.log", { type: "text/plain" }));
  const res = await (await fetch(BASE + `/api/tasks/${id}/send`, { method: "POST", body: fd })).json();
  expect(res.delivery).toBe("queued");
  expect(res.attachments?.[0]).toMatch(/trace\.log$/);

  await post(`/api/tasks/${id}/spawn`, {});
  const brief = briefs.at(-1)!;
  expect(brief).toContain("## Steers waiting for you");
  expect(brief).toContain("## Attachments"); // main's block survived the queue
  expect(brief).toContain(res.attachments[0]); // the exact on-disk path reached the agent
});
