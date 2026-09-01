// Director chat backed by a PERSISTENT supervisor session (a herdr agent).
// The first director message spawns the session; later messages are delivered
// into the live session; the session replies asynchronously via
// POST /api/chat/threads/:id/reply. herdr is stubbed (injected exec) so the
// test never spawns a real agent.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "hive-chat-"));
process.env.HIVE_HOME = HOME;

const { openDb, newId, now } = await import("../src/db.ts");
const { makeHandler, notifyManagerOfEvent, keepSupervisorWarm, flushManagerUpdate, MANAGER_WAKEUP_DEBOUNCE_MS, sweepManagerInboxes, projectInboxCounts, threadIdle } = await import("../src/api.ts");
const { addClient, removeClient } = await import("../src/bus.ts");
const { Herdr } = await import("../src/runtime/herdr.ts");
const { composeSupervisorBrief, createThread, managingThreadForTask } = await import("../src/chat.ts");
const { composeBrief } = await import("../src/briefs.ts");
const { setEventHook, writeEvent } = await import("../src/state.ts");
import type { Exec, ExecResult } from "../src/exec.ts";

const db = openDb(":memory:");
const OK = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const WT = join(HOME, "wt");
const has = (argv: string[], ...xs: string[]) => xs.every((x) => argv.includes(x));

// Records every brief an `agent start` received and every `agent send`.
const briefs: string[] = [];
const sends: string[] = [];
let probeStatus = "working";
// Simulates a herdr registry wipe: `agent get`/`agent list` forget the name
// entirely (agent_not_found) while the pane itself is still running at `evictedCwd`,
// until `pane report-agent` re-registers it (readopt).
let evictedCwd: string | null = null;
let reregistered = false;
// Set to a promise to hold a spawn open (the real thing creates a worktree and
// sets up the project stack, which is what the non-blocking turn must not wait
// on); set to fail an `agent start` outright.
let spawnGate: Promise<void> | null = null;
let spawnFails = false;
const exec: Exec = async (argv) => {
  if (has(argv, "worktree", "create")) {
    if (spawnGate) await spawnGate;
    // A real worktree create/reclaim takes real time; without the per-thread
    // spawn lock this window is exactly where a concurrent double-send races
    // a second spawnAgent for the same task.
    await new Promise((r) => setTimeout(r, 15));
    return OK(`{"result":{"worktree":{"path":${JSON.stringify(WT)},"branch":"hive/x","open_workspace_id":"w1"}}}`);
  }
  if (has(argv, "agent", "get")) {
    if (evictedCwd && !reregistered) return OK('{"error":{"code":"agent_not_found"}}');
    return OK(`{"result":{"agent":{"pane_id":"p1","agent_status":"${probeStatus}"}}}`);
  }
  if (has(argv, "agent", "list")) return OK("{\"result\":{\"agents\":[]}}");
  if (has(argv, "pane", "list")) {
    if (!evictedCwd) return OK('{"result":{"panes":[]}}');
    if (evictedCwd === WT)
      // Matches the fleet tab created for the supervisor spawn (cwd + tab_id
      // "wF:t2"), so confirmGone sees it as still-live and readopt finds it.
      return OK('{"result":{"panes":[{"pane_id":"pE","tab_id":"wF:t2","cwd":' + JSON.stringify(WT) + ',"terminal_id":"term_E","label":null}]}}');
    // A real death: some unrelated pane exists, but none at this task's cwd/tab —
    // confirmGone has positive evidence (a live pane list) and finds no match.
    return OK('{"result":{"panes":[{"pane_id":"pZ","tab_id":"wZ:tZ","cwd":"/unrelated","terminal_id":"term_Z","label":null}]}}');
  }
  if (has(argv, "pane", "process-info"))
    return OK('{"result":{"process_info":{"shell_pid":1,"foreground_processes":[{"pid":1,"argv0":"claude"}]}}}');
  if (has(argv, "pane", "report-agent")) {
    reregistered = true;
    return OK();
  }
  if (has(argv, "agent", "rename")) return OK();
  if (has(argv, "workspace", "list")) return OK('{"result":{"workspaces":[{"workspace_id":"wF","label":"hive-fleet"}]}}');
  if (has(argv, "tab", "create")) return OK('{"result":{"tab":{"tab_id":"wF:t2"}}}');
  if (has(argv, "agent", "start")) {
    briefs.push(argv[argv.indexOf("--") + 2]); // `-- claude <brief> …`
    if (spawnFails) return { code: 1, stdout: "", stderr: "herdr: agent start refused" };
    return OK();
  }
  if (has(argv, "agent", "send")) {
    sends.push(argv[argv.indexOf("send") + 2]);
    return OK();
  }
  return OK();
};
const herdr = new Herdr(exec, "herdr");

let server: any;
let BASE = "";
let projectId = "";
beforeAll(async () => {
  server = Bun.serve({ port: 0, fetch: makeHandler(db, { herdr }) });
  BASE = `http://127.0.0.1:${server.port}`;
  const p: any = await (await fetch(BASE + "/api/projects", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "acme", repo_path: WT }),
  })).json();
  projectId = p.id;
  // The Chief of Staff ships OFF (hive-1996). Every test below exercises a
  // running supervisor, so turn it on; the off-switch tests flip it back.
  await fetch(BASE + "/api/chat/supervisor", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ on: true }),
  });
});
afterAll(() => server.stop(true));

async function post(path: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(BASE + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
}
async function get(path: string): Promise<{ status: number; json: any }> {
  const res = await fetch(BASE + path);
  return { status: res.status, json: await res.json() };
}

// The turn is non-blocking, so the delivery outcome arrives on the SSE bus, not
// in the response. Subscribe like a browser tab does and wait for the thread's
// in-flight delivery to settle.
const deliveries: { thread_id: string; status: string; error?: string }[] = [];
const notices: { thread_id: string; role: string; text: string }[] = [];
addClient({
  id: "test",
  send: (data) => {
    const msg = JSON.parse(data);
    if (msg.type === "chat_delivery") deliveries.push(msg);
    if (msg.type === "chat_message") notices.push({ thread_id: msg.message.thread_id, role: msg.message.role, text: msg.message.text });
  },
});
function lastDelivery(threadId: string) {
  return [...deliveries].reverse().find((d) => d.thread_id === threadId);
}
async function turn(body: unknown): Promise<{ status: number; json: any; delivery?: string; error?: string }> {
  const r = await post("/api/chat/turn", body);
  if (!r.json?.thread_id) return r;
  await threadIdle(r.json.thread_id);
  const last = lastDelivery(r.json.thread_id);
  return { ...r, delivery: last?.status, error: last?.error };
}

let threadId = "";

test("first message spawns a persistent supervisor session (202, non-blocking)", async () => {
  const { status, json, delivery } = await turn({ project_id: projectId, text: "spin up the login work" });
  expect(status).toBe(202);
  expect(json.delivery).toBe("queued"); // returns before the spawn, not after it
  expect(delivery).toBe("spawned");
  expect(json.thread_id).toBeTruthy();
  threadId = json.thread_id;

  // A backing supervisor task exists, tagged so the dispatcher/board ignore it.
  const thread = (await get(`/api/chat/threads/${threadId}`)).json;
  expect(thread.task_id).toBeTruthy();
  const task = (await get(`/api/tasks/${thread.task_id}`)).json;
  expect(task.source).toBe("chat_supervisor");
  // The director message is persisted; the session's reply comes later via /reply.
  expect(thread.messages.map((m: any) => m.role)).toEqual(["director"]);

  // The spawn brief is the supervisor brief, carrying the thread id + reply verb.
  expect(briefs.length).toBe(1);
  expect(briefs[0]).toContain(threadId);
  expect(briefs[0]).toContain("chat reply");
  // The first director message rides along in the brief (queued steer).
  expect(briefs[0]).toContain("spin up the login work");
});

test("later message is delivered into the live session (not a respawn)", async () => {
  const before = briefs.length;
  const { status, delivery } = await turn({ thread_id: threadId, text: "what's the status?" });
  expect(status).toBe(202);
  expect(delivery).toBe("delivered");
  expect(briefs.length).toBe(before); // no new spawn
  expect(sends.at(-1)).toContain("what's the status?");
  expect(sends.at(-1)).toContain(threadId); // wire prefix tells the session where to reply
});

test("a leftover shell pane is respawned instead of receiving the director message", async () => {
  const before = briefs.length;
  probeStatus = "unknown";
  try {
    const { status, delivery } = await turn({ thread_id: threadId, text: "resume the sweep" });
    expect(status).toBe(202);
    expect(delivery).toBe("spawned");
    expect(briefs.length).toBe(before + 1);
    expect(briefs.at(-1)).toContain("resume the sweep");
  } finally {
    probeStatus = "working";
  }
});

test("a supervisor whose herdr registry entry was evicted receives the turn as a steer, not a respawn (hive-448)", async () => {
  const before = briefs.length;
  evictedCwd = WT; // the pane is still alive at the supervisor task's worktree cwd
  reregistered = false;
  try {
    const { status, delivery } = await turn({ thread_id: threadId, text: "still there?" });
    expect(status).toBe(202);
    expect(delivery).toBe("delivered"); // re-adopted and steered, not respawned
    expect(briefs.length).toBe(before); // no new spawn
    expect(sends.at(-1)).toContain("still there?");
  } finally {
    evictedCwd = null;
    reregistered = false;
  }
});

test("a genuinely dead supervisor (no matching pane) still respawns", async () => {
  const before = briefs.length;
  probeStatus = "unknown";
  evictedCwd = "/dead"; // no pane at the task's real worktree cwd -> confirmGone confirms death
  try {
    const { status, delivery } = await turn({ thread_id: threadId, text: "resume after real death" });
    expect(status).toBe(202);
    expect(delivery).toBe("spawned");
    expect(briefs.length).toBe(before + 1);
    expect(briefs.at(-1)).toContain("resume after real death");
  } finally {
    probeStatus = "working";
    evictedCwd = null;
  }
});

test("descendant worker events wake the manager once with a batched update", async () => {
  expect(MANAGER_WAKEUP_DEBOUNCE_MS).toBeGreaterThanOrEqual(30_000);
  expect(MANAGER_WAKEUP_DEBOUNCE_MS).toBeLessThanOrEqual(60_000);
  const thread = (await get(`/api/chat/threads/${threadId}`)).json;
  const worker = (await post("/api/tasks", {
    project_id: projectId,
    title: "implement login",
    source: "agent",
    parent_task_id: thread.task_id,
  })).json;
  const followup = (await post("/api/tasks", {
    project_id: projectId,
    title: "verify login edge cases",
    source: "agent",
    parent_task_id: worker.id,
  })).json;

  expect(managingThreadForTask(db, followup.id)?.id).toBe(threadId);
  expect(composeBrief(db, followup.id)).toContain(`supervisor task \`${thread.task_id}\``);
  expect(composeBrief(db, followup.id)).toContain("hive task send");

  const before = sends.length;
  setEventHook((hookDb, event) => notifyManagerOfEvent(hookDb, herdr, {}, event));
  try {
    writeEvent(db, { task_id: worker.id, source: "agent", type: "blocked", payload: { note: "need the session contract" } });
    writeEvent(db, { task_id: followup.id, source: "system", type: "smoke_failed", payload: { note: "expired session still accepted" } });
    writeEvent(db, { task_id: worker.id, source: "agent", type: "checkpoint", payload: { note: "kept the existing cookie format" } });
    await flushManagerUpdate(threadId);
  } finally {
    setEventHook(null);
  }

  expect(sends.length).toBe(before + 1);
  expect(sends.at(-1)).toContain("[hive manager wakeup]");
  expect(sends.at(-1)).toContain("implement login");
  expect(sends.at(-1)).toContain("verify login edge cases");
  expect(sends.at(-1)).toContain("checkpoint");
  expect(sends.at(-1)).not.toContain("need the session contract");
  expect(sends.at(-1)).toContain("Act on anything you can resolve");
});

test("unrelated project events do not wake a catch-all manager", async () => {
  const otherProject = (await post("/api/projects", {
    name: "other project",
    repo_path: WT,
  })).json;
  const unrelated = (await post("/api/tasks", {
    project_id: otherProject.id,
    title: "older project work",
  })).json;
  const before = sends.length;
  const checkpoint = writeEvent(db, {
    task_id: unrelated.id,
    source: "agent",
    type: "checkpoint",
    payload: { note: "used the established cache key" },
  });
  notifyManagerOfEvent(db, herdr, {}, checkpoint);
  await new Promise((r) => setTimeout(r, 20));

  expect(sends.length).toBe(before);
});

test("startup inbox sweep wakes one active manager per project with actionable counts", async () => {
  const before = sends.length;
  const notified = await sweepManagerInboxes(db, herdr, {});
  expect(notified).toBe(1);
  expect(sends.length).toBe(before + 1);
  expect(sends.at(-1)).toContain("Project inbox sweep:");
  expect(sends.at(-1)).toContain("across 2 projects");
  expect(sends.at(-1)).toContain("checkpoints");
  expect(sends.at(-1)).toContain(`\"source\":\"chat_supervisor\"`);
});

test("manager inbox review counts exclude tracking-only tasks", async () => {
  const project = (await post("/api/projects", { name: "review counts", repo_path: WT })).json;
  const owned = (await post("/api/tasks", { project_id: project.id, title: "Hive review" })).json;
  const tracked = (await post("/api/tasks", { project_id: project.id, title: "Jira review", source: "external" })).json;
  for (const task of [owned, tracked]) {
    await post(`/api/tasks/${task.id}/transition`, { to: "in_progress" });
    await post(`/api/tasks/${task.id}/transition`, { to: "in_review" });
  }

  const before = sends.length;
  await sweepManagerInboxes(db, herdr, {});
  const wakeups = sends.slice(before).join("\n");
  expect(wakeups).toContain(`review counts (${project.id}): 0 checkpoints, 0 decisions, 1 reviews`);

  await post(`/api/tasks/${owned.id}/transition`, { to: "cancelled" });
  await post(`/api/tasks/${tracked.id}/transition`, { to: "cancelled" });
});

// task #1693 follow-up: the inbox sweep iterated EVERY project including
// archived/test rows, so a stale scratch project's leftover checkpoints could
// still page a manager.
test("manager inbox sweep skips an archived project's actionable items", async () => {
  const archived = (await post("/api/projects", { name: "archived inbox", repo_path: "/nonexistent/repo", config: { archived: true } })).json;
  const owned = (await post("/api/tasks", { project_id: archived.id, title: "stale checkpoint task" })).json;
  await post(`/api/tasks/${owned.id}/transition`, { to: "in_progress" });
  writeEvent(db, { task_id: owned.id, source: "agent", type: "checkpoint", payload: { note: "left behind" } });

  const before = sends.length;
  await sweepManagerInboxes(db, herdr, {});
  const wakeups = sends.slice(before).join("\n");
  expect(wakeups).not.toContain("archived inbox");

  await post(`/api/tasks/${owned.id}/transition`, { to: "cancelled" });
});

test("external tracking tasks (source='external') are invisible to manager wakeups and inbox counts", async () => {
  const trackedProject = (await post("/api/projects", { name: "jira-mirrored project", repo_path: WT })).json;
  const tracked = (await post("/api/tasks", { project_id: trackedProject.id, title: "mirrored JIRA issue", source: "external" })).json;
  expect(tracked.source).toBe("external");
  const control = (await post("/api/tasks", { project_id: trackedProject.id, title: "hive-driven work", source: "agent" })).json;

  // notifyManagerOfEvent: an event on an external task must not wake anyone.
  const before = sends.length;
  const trackedCheckpoint = writeEvent(db, { task_id: tracked.id, source: "agent", type: "checkpoint", payload: { note: "upstream ticket edited" } });
  notifyManagerOfEvent(db, herdr, {}, trackedCheckpoint);
  await new Promise((r) => setTimeout(r, 20));
  expect(sends.length).toBe(before);

  // projectInboxCounts: put both tasks through the same trigger conditions
  // (unacked checkpoint, open decision, in_review, failed) so the counts can
  // only be non-zero via the control task — the external one must never add.
  writeEvent(db, { task_id: control.id, source: "agent", type: "checkpoint", payload: { note: "used the established cache key" } });
  db.query("INSERT INTO decisions (id, task_id, ts, title, status) VALUES (?,?,?,?,'open')").run(newId("dec"), tracked.id, now(), "should never surface");
  db.query("INSERT INTO decisions (id, task_id, ts, title, status) VALUES (?,?,?,?,'open')").run(newId("dec"), control.id, now(), "a real open decision");
  const failedExternal = newId();
  db.query(
    "INSERT INTO tasks (id, project_id, title, state, kind, source, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)"
  ).run(failedExternal, trackedProject.id, "failed mirrored issue", "failed", "chore", "external", now(), now());
  const failedControl = newId();
  db.query(
    "INSERT INTO tasks (id, project_id, title, state, kind, source, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)"
  ).run(failedControl, trackedProject.id, "failed hive work", "failed", "chore", "agent", now(), now());
  db.query("UPDATE tasks SET state = 'in_review' WHERE id = ?").run(tracked.id);
  db.query("UPDATE tasks SET state = 'in_review' WHERE id = ?").run(control.id);

  expect(projectInboxCounts(db, trackedProject.id)).toEqual({ checkpoints: 1, decisions: 1, reviews: 1, attention: 1 });
});

test("a manually-spawned external task (agent_target set) is real hive-driven work and stays visible", async () => {
  // Unlike the never-spawned case above, an external task a director chose to
  // dispatch has a live agent doing real work — supervisedSql/isSupervisedTask
  // must not hide it just because source='external'. createTask itself now
  // rejects source=external combined with a caller-supplied agent_target (see
  // supervision.ts's neverDispatched / the createTask guard in api.ts), so
  // simulate the already-dispatched state the way a legacy row carries it: a
  // direct agent_target write after creation, same as a real spawn would do.
  const project = (await post("/api/projects", { name: "manually-spawned external project", repo_path: WT })).json;
  const spawned = (await post("/api/tasks", { project_id: project.id, title: "manually dispatched mirrored issue", source: "external" })).json;
  expect(spawned.source).toBe("external");
  db.query("UPDATE tasks SET agent_target = ? WHERE id = ?").run("t-external-live", spawned.id);

  const before = sends.length;
  const spawnedCheckpoint = writeEvent(db, { task_id: spawned.id, source: "agent", type: "checkpoint", payload: { note: "real progress" } });
  notifyManagerOfEvent(db, herdr, {}, spawnedCheckpoint);
  await new Promise((r) => setTimeout(r, 20));
  expect(sends.length).toBe(before); // visible to inbox sweeps, but no unrelated immediate wakeup

  db.query("INSERT INTO decisions (id, task_id, ts, title, status) VALUES (?,?,?,?,'open')").run(newId("dec"), spawned.id, now(), "a real decision from real work");
  db.query("UPDATE tasks SET state = 'in_review' WHERE id = ?").run(spawned.id);

  expect(projectInboxCounts(db, project.id)).toEqual({ checkpoints: 1, decisions: 1, reviews: 1, attention: 0 });
});

test("a concurrent double-send on the same thread spawns only once", async () => {
  // A message sent right after the UI receives thread_id, before the first
  // spawn has landed: both requests reach deliverToSupervisor with
  // agent_target still null. Without per-thread serialization both would
  // call spawnAgent for the same task, racing worktree create.
  const thread = createThread(db, { project_id: projectId, title: "race" });
  const before = briefs.length;
  const [a, b] = await Promise.all([
    post("/api/chat/turn", { thread_id: thread.id, text: "message A" }),
    post("/api/chat/turn", { thread_id: thread.id, text: "message B" }),
  ]);
  expect(a.status).toBe(202);
  expect(b.status).toBe(202);
  await threadIdle(thread.id);
  expect(briefs.length).toBe(before + 1); // exactly one spawn, not two

  const outcomes = deliveries.filter((d) => d.thread_id === thread.id).map((d) => d.status).sort();
  expect(outcomes).toEqual(["delivered", "delivering", "queued", "queued", "spawned", "spawning"]); // winner spawns, waiter delivers into it

  const combined = briefs.at(-1)! + sends.join(" ");
  expect(combined).toContain("message A"); // whichever one won, neither message is dropped
  expect(combined).toContain("message B");
});

test("a concurrent double-send on a BRAND-NEW chat (no thread_id yet) creates only one thread", async () => {
  // A UI double-submit on a fresh chat: both requests race in with the same
  // project_id and no thread_id at all, since the client hasn't received one
  // back yet. Without dedupe, each independently calls createThread and gets
  // its own thread.id, so the per-thread spawn lock never sees them as the
  // same lock target — two threads, two tasks, two spawns for one message.
  const before = briefs.length;
  const [a, b] = await Promise.all([
    post("/api/chat/turn", { project_id: projectId, text: "brand new double-submit" }),
    post("/api/chat/turn", { project_id: projectId, text: "brand new double-submit" }),
  ]);
  expect(a.status).toBe(202);
  expect(b.status).toBe(202);
  expect(a.json.thread_id).toBe(b.json.thread_id); // same thread, not two
  await threadIdle(a.json.thread_id);
  expect(briefs.length).toBe(before + 1); // exactly one spawn, not two
  expect(lastDelivery(a.json.thread_id)?.status).toBe("spawned");

  const thread = (await get(`/api/chat/threads/${a.json.thread_id}`)).json;
  expect(thread.messages.length).toBe(1); // the duplicate submit did not double-post the message
});

test("supervisor posts a reply that lands on the thread + streams", async () => {
  const { status, json } = await post(`/api/chat/threads/${threadId}/reply`, { text: "Queued task #12 for the login work. Nothing blocking." });
  expect(status).toBe(200);
  expect(json.message.role).toBe("assistant");

  const thread = (await get(`/api/chat/threads/${threadId}`)).json;
  const last = thread.messages.at(-1);
  expect(last.role).toBe("assistant");
  expect(last.text).toContain("Queued task #12");
});

// A chat_messages row has no task_id and no project_id of its own: the scope
// lives on the parent chat_threads row. Both broadcast paths must therefore
// stamp the thread's project, or /api/stream?project= silently passes every
// chat message from every project.
test("chat_message frames carry the parent thread's project_id on both paths", async () => {
  const frames: any[] = [];
  const client = { id: "test-chat-scope", send: (d: string) => frames.push(JSON.parse(d)) };
  addClient(client);
  try {
    await post("/api/chat/turn", { thread_id: threadId, text: "does this frame carry a project?" });
    await post(`/api/chat/threads/${threadId}/reply`, { text: "it does now." });
  } finally {
    removeClient(client);
  }

  const chat = frames.filter((f) => f.type === "chat_message");
  expect(chat.map((f) => f.message.role)).toEqual(["director", "assistant"]);
  for (const f of chat) expect([f.message.role, f.project_id]).toEqual([f.message.role, projectId]);
});

test("reply to an unknown thread 404s; empty text 400s", async () => {
  expect((await post("/api/chat/threads/thr_nope/reply", { text: "hi" })).status).toBe(404);
  expect((await post(`/api/chat/threads/${threadId}/reply`, { text: "" })).status).toBe(400);
});

test("close ends the live session: backing task transitions to cancelled", async () => {
  const before = (await get(`/api/chat/threads/${threadId}`)).json;
  const { status, json } = await post(`/api/chat/threads/${threadId}/close`, {});
  expect(status).toBe(200);
  expect(json.thread_id).toBe(threadId);
  const task = (await get(`/api/tasks/${before.task_id}`)).json;
  expect(task.state).toBe("cancelled");
});

test("close is idempotent (closing an already-closed thread is a no-op)", async () => {
  const { status } = await post(`/api/chat/threads/${threadId}/close`, {});
  expect(status).toBe(200);
});

test("closing an unknown thread 404s", async () => {
  expect((await post("/api/chat/threads/thr_nope/close", {})).status).toBe(404);
});

test("a message to a closed thread spawns a fresh session, not a resurrection", async () => {
  const before = (await get(`/api/chat/threads/${threadId}`)).json;
  const briefsBefore = briefs.length;
  const { status, delivery } = await turn({ thread_id: threadId, text: "still there?" });
  expect(status).toBe(202);
  expect(delivery).toBe("spawned"); // fresh task, not "delivered" into the dead one
  expect(briefs.length).toBe(briefsBefore + 1);

  const after = (await get(`/api/chat/threads/${threadId}`)).json;
  expect(after.task_id).not.toBe(before.task_id); // new backing task; old one stays cancelled
  const oldTask = (await get(`/api/tasks/${before.task_id}`)).json;
  expect(oldTask.state).toBe("cancelled");
  const newTask = (await get(`/api/tasks/${after.task_id}`)).json;
  expect(newTask.state).toBe("in_progress");
});

test("an arbitrary body.task_id cannot hijack an unrelated task as the chat supervisor", async () => {
  // A caller passing an arbitrary/wrong task_id must not bind the new thread
  // to that task's real agent (deliverToSupervisor would otherwise treat it
  // as the supervisor session and could respawn it on a send failure,
  // clobbering that task's agent/worktree/brief). task_id is undocumented and
  // unused by the CLI, so chatTurn ignores it outright.
  const victim: any = await (await fetch(BASE + "/api/tasks", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project_id: projectId, title: "unrelated ship task" }),
  })).json();
  expect(victim.source).not.toBe("chat_supervisor");

  const { status, json } = await turn({
    project_id: projectId, text: "hijack attempt", task_id: victim.id,
  });
  expect(status).toBe(202);

  const thread = (await get(`/api/chat/threads/${json.thread_id}`)).json;
  expect(thread.task_id).not.toBe(victim.id); // got its own fresh supervisor task, not the victim's

  const victimAfter = (await get(`/api/tasks/${victim.id}`)).json;
  expect(victimAfter.state).toBe(victim.state); // untouched
});

test("Chief of Staff is one durable cross-project thread backed by the hive coordinator repo", async () => {
  const before = briefs.length;
  const [first, second] = await Promise.all([
    post("/api/chat/turn", { scope: "chief", text: "remember the portfolio and handle the details" }),
    post("/api/chat/turn", { scope: "chief", text: "also restore where I left off" }),
  ]);
  expect(first.status).toBe(202);
  expect(second.status).toBe(202);
  expect(first.json.thread_id).toBe(second.json.thread_id);
  await threadIdle(first.json.thread_id);
  expect(lastDelivery(first.json.thread_id)?.status).toBe("delivered");

  const thread = (await get(`/api/chat/threads/${first.json.thread_id}`)).json;
  expect(thread.project_id).toBeNull();
  const messages = thread.messages.map((message: any) => message.text);
  expect(messages).toHaveLength(2);
  expect(messages).toEqual(expect.arrayContaining([
    "remember the portfolio and handle the details",
    "also restore where I left off",
  ]));
  const task = (await get(`/api/tasks/${thread.task_id}`)).json;
  expect(task.project_id).toBe(projectId);
  expect(task.title).toContain("Chief of Staff");
  expect(briefs.length).toBe(before + 1);
  expect(briefs.at(-1)).toContain("Chief of Staff");
  expect(briefs.at(-1)).toContain("Memory and attention");
  expect(briefs.at(-1)).toContain("every project");
  expect(briefs.at(-1)).toContain("target project's current autonomy profile");
  expect(briefs.at(-1)).not.toContain("The autonomy profile is `balanced`");

  const followup = await turn({ scope: "chief", text: "where did I leave off?" });
  expect(followup.status).toBe(202);
  expect(followup.delivery).toBe("delivered");
  expect(followup.json.thread_id).toBe(thread.id);
  expect(sends.at(-1)).toContain("[chief reply policy]");
  expect(sends.at(-1)).toContain("--decision <id>");
  expect((await get("/api/chat/threads")).json.filter((candidate: any) => candidate.project_id === null)).toHaveLength(1);
});

test("Chief suppresses routine wakeup chatter after it has already replied", async () => {
  const chief = (await get("/api/chat/threads")).json.find((candidate: any) => candidate.project_id === null);
  const first = await post(`/api/chat/threads/${chief.id}/reply`, { text: "I am handling the portfolio." });
  expect(first.status).toBe(200);
  const before = (await get(`/api/chat/threads/${chief.id}`)).json.messages.length;

  const { status, json } = await post(`/api/chat/threads/${chief.id}/reply`, { text: "Another routine progress update." });
  expect(status).toBe(200);
  expect(json.suppressed).toBe(true);
  expect((await get(`/api/chat/threads/${chief.id}`)).json.messages).toHaveLength(before);
});

test("Chief bundles real decisions into actionable message data and does not resend them", async () => {
  const chief = (await get("/api/chat/threads")).json.find((candidate: any) => candidate.project_id === null);
  const worker = (await post("/api/tasks", { project_id: projectId, title: "Choose launch mode" })).json;
  const decision = (await post("/api/decisions", {
    task_id: worker.id,
    title: "Which launch mode should we use?",
    context: "Choose the launch mode for this worker task.",
    options: [
      { key: "safe", label: "Safe rollout", recommended: true },
      { key: "fast", label: "Fast rollout" },
    ],
  })).json;
  await turn({ thread_id: chief.id, text: "Anything you actually need from me?" });

  const reply = await post(`/api/chat/threads/${chief.id}/reply`, {
    text: "I need one call from you.",
    decision_ids: [decision.id],
  });
  expect(reply.status).toBe(200);
  expect(reply.json.message.actions).toEqual([
    { type: "decision", decision_id: decision.id, label: "Which launch mode should we use?" },
  ]);

  await turn({ thread_id: chief.id, text: "Do you still need anything from me?" });
  const before = (await get(`/api/chat/threads/${chief.id}`)).json.messages.length;

  const duplicate = await post(`/api/chat/threads/${chief.id}/reply`, {
    text: "Reminder about that same decision.",
    decision_ids: [decision.id],
  });
  expect(duplicate.json.suppressed).toBe(true);
  expect((await get(`/api/chat/threads/${chief.id}`)).json.messages).toHaveLength(before);
});

test("starting a chat with no project is rejected (session needs a repo)", async () => {
  const { status, json } = await turn({ text: "hello" });
  expect(status).toBe(400);
  expect(json.error).toContain("a new chat needs a project");
  expect(json.error).toContain("hive chat send --project");
});

test("composeSupervisorBrief bakes in the thread id, reply verb, and hard limits", () => {
  const thread = createThread(db, { project_id: projectId, title: "t" });
  const brief = composeSupervisorBrief(db, thread);
  expect(brief).toContain(thread.id);
  expect(brief).toContain(`chat reply ${thread.id}`);
  expect(brief).toContain("CANNOT merge"); // destructive/guarded excluded
  expect(brief).toContain("task create"); // coordination via worker tasks
  expect(brief).toContain("automatic manager loop");
  expect(brief).toContain("bounded meeting");
  expect(brief).toContain("independently check the integrated result");
  expect(brief).toContain("Acknowledge a safe checkpoint");
  expect(brief).toContain("whole current-project inbox");
  expect(brief).toContain("--context \"current state, why it matters, uncertainty, and recommendation\"");
  expect(brief).not.toContain("merge_strategy");
});

test("autopilot supervisor brief includes the guarded merge action", () => {
  db.query("UPDATE projects SET config = ? WHERE id = ?").run(JSON.stringify({ autonomy_profile: "autopilot" }), projectId);
  const thread = createThread(db, { project_id: projectId, title: "autopilot" });
  const brief = composeSupervisorBrief(db, thread);
  expect(brief).toContain("POST $HIVE_URL/api/tasks/<id>/merge");
  expect(brief).toContain('"merge_strategy":"local_ff"');
});

test("Chief brief requires quiet bundled decision cards", () => {
  const thread = createThread(db, { project_id: null, title: "quiet chief" });
  const brief = composeSupervisorBrief(db, thread);
  expect(brief).toContain("Silence is the default");
  expect(brief).toContain("--decision <decision-id>");
  expect(brief).toContain("Do not send the director a progress message or task list");
  expect(brief).toContain("core intuition");
  expect(brief).toContain("shared mental model");
});

// ---------------------------------------------------------- non-blocking turn
test("the turn returns before the spawn completes (director is never blocked)", async () => {
  const thread = createThread(db, { project_id: projectId, title: "slow spawn" });
  let release = () => {};
  spawnGate = new Promise<void>((r) => (release = () => r()));
  try {
    const before = briefs.length;
    const { status, json } = await post("/api/chat/turn", { thread_id: thread.id, text: "start the long thing" });
    expect(status).toBe(202);
    expect(json.delivery).toBe("queued");
    expect(briefs.length).toBe(before); // the response landed while the spawn is still held
    // The director's message is already durable and visible.
    expect((await get(`/api/chat/threads/${thread.id}`)).json.messages.at(-1).text).toBe("start the long thing");
    expect(lastDelivery(thread.id)?.status).toBe("spawning");

    release();
    await threadIdle(thread.id);
    expect(briefs.length).toBe(before + 1);
    expect(lastDelivery(thread.id)?.status).toBe("spawned");
  } finally {
    spawnGate = null;
  }
});

test("a failed spawn posts a visible message on the thread instead of hanging", async () => {
  const thread = createThread(db, { project_id: projectId, title: "doomed" });
  spawnFails = true;
  try {
    const { status } = await post("/api/chat/turn", { thread_id: thread.id, text: "this cannot start" });
    expect(status).toBe(202);
    await threadIdle(thread.id);
    expect(lastDelivery(thread.id)?.status).toBe("failed");
    const last = (await get(`/api/chat/threads/${thread.id}`)).json.messages.at(-1);
    expect(last.role).toBe("assistant");
    expect(last.text).toContain("could not start");
    expect(notices.at(-1)?.thread_id).toBe(thread.id); // streamed, not only stored
  } finally {
    spawnFails = false;
  }
});

// ------------------------------------------------------------------ keep-warm
test("keep-warm respawns an open thread's dead session without a director message", async () => {
  const start = await turn({ project_id: projectId, text: "keep this session warm" });
  const warmThread = start.json.thread_id;
  const task = (await get(`/api/chat/threads/${warmThread}`)).json.task_id;

  const before = briefs.length;
  probeStatus = "unknown";
  evictedCwd = "/dead"; // confirmGone has positive evidence: the session is really gone
  try {
    keepSupervisorWarm(db, herdr, {}, { task_id: task, type: "agent_status", payload: { status: "gone" } });
    await threadIdle(warmThread);
    expect(briefs.length).toBe(before + 1);
    expect(briefs.at(-1)).toContain("keep-warm");
  } finally {
    probeStatus = "working";
    evictedCwd = null;
  }
});

test("keep-warm backs off after repeated failures and says so on the thread", async () => {
  const start = await turn({ project_id: projectId, text: "session that keeps dying" });
  const warmThread = start.json.thread_id;
  const before = briefs.length;
  probeStatus = "unknown";
  evictedCwd = "/dead";
  spawnFails = true;
  try {
    for (let i = 0; i < 5; i++) {
      const task = (await get(`/api/chat/threads/${warmThread}`)).json.task_id;
      keepSupervisorWarm(db, herdr, {}, { task_id: task, type: "agent_status", payload: { status: "gone" } });
      await threadIdle(warmThread);
    }
    expect(briefs.length).toBe(before + 3); // capped, not one respawn per death forever
    const last = (await get(`/api/chat/threads/${warmThread}`)).json.messages.at(-1);
    expect(last.text).toContain("could not be restarted");
  } finally {
    probeStatus = "working";
    evictedCwd = null;
    spawnFails = false;
  }
});

test("keep-warm never respawns a closed thread", async () => {
  const start = await turn({ project_id: projectId, text: "closing this one" });
  const closedThread = start.json.thread_id;
  const task = (await get(`/api/chat/threads/${closedThread}`)).json.task_id;
  await post(`/api/chat/threads/${closedThread}/close`, {});

  const before = briefs.length;
  keepSupervisorWarm(db, herdr, {}, { task_id: task, type: "agent_status", payload: { status: "gone" } });
  await threadIdle(closedThread);
  expect(briefs.length).toBe(before);
});

// ---- the off switch (hive-1996) ----
// Two standing sessions processed ~150M tokens in a week for one answered
// decision. These tests must run last: turning the switch off cancels every
// live supervisor session.

test("a supervisor that crosses its processed-token warning stops instead of running on", async () => {
  const { checkUsageGuardrails } = await import("../src/costs.ts");
  const start = await turn({ project_id: projectId, text: "the session that never ends" });
  const taskId = (await get(`/api/chat/threads/${start.json.thread_id}`)).json.task_id;
  db.query("INSERT INTO usage (id, task_id, ts, model, input_tokens, output_tokens, cost_usd) VALUES (?,?,?,?,?,?,?)")
    .run(newId(), taskId, now(), "claude-opus-5", 80_000_000, 0, 0);

  checkUsageGuardrails(db, taskId);

  expect((await get(`/api/tasks/${taskId}`)).json.state).toBe("cancelled");
  const messages = (await get(`/api/chat/threads/${start.json.thread_id}`)).json.messages;
  expect(messages.at(-1).text).toContain("was stopped after processing");
  // Terminal, so keep-warm cannot bring it back.
  const before = briefs.length;
  keepSupervisorWarm(db, herdr, {}, { task_id: taskId, type: "agent_status", payload: { status: "gone" } });
  await threadIdle(start.json.thread_id);
  expect(briefs.length).toBe(before);
});

test("turning the switch off ends the live sessions", async () => {
  const start = await turn({ project_id: projectId, text: "running right up until the switch flips" });
  const taskId = (await get(`/api/chat/threads/${start.json.thread_id}`)).json.task_id;
  const r = await post("/api/chat/supervisor", { on: false });
  expect(r.json.on).toBe(false);
  expect(r.json.stopped).toBeGreaterThan(0);
  expect((await get(`/api/tasks/${taskId}`)).json.state).toBe("cancelled");
  expect((await get("/api/chat/supervisor")).json.on).toBe(false);
});

test("with the switch off a message starts nothing and says so in the thread", async () => {
  const before = briefs.length;
  const r = await turn({ project_id: projectId, text: "anybody there?" });
  expect(r.status).toBe(202);
  expect(r.delivery).toBe("disabled");
  expect(briefs.length).toBe(before); // no agent spawned

  const thread = (await get(`/api/chat/threads/${r.json.thread_id}`)).json;
  expect(thread.task_id).toBeFalsy(); // no backing task created
  expect(thread.messages.map((m: any) => m.role)).toEqual(["director", "assistant"]);
  expect(thread.messages.at(-1).text).toContain("Chief of Staff is off");
});

test("the switch is off by default", async () => {
  const { openDb, supervisorEnabled } = await import("../src/db.ts");
  const fresh = openDb(":memory:");
  expect(supervisorEnabled(fresh)).toBe(false);
});
