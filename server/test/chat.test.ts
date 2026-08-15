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

const { openDb } = await import("../src/db.ts");
const { makeHandler, notifyManagerOfEvent } = await import("../src/api.ts");
const { Herdr } = await import("../src/runtime/herdr.ts");
const { composeSupervisorBrief, createThread, managingThreadForTask } = await import("../src/chat.ts");
const { composeBrief } = await import("../src/briefs.ts");
const { setEventHook, writeEvent } = await import("../src/state.ts");
import type { Exec, ExecResult } from "../src/exec.ts";

const db = openDb(":memory:");
const OK = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const WT = join(HOME, "wt");
const has = (argv: string[], ...xs: string[]) => xs.every((x) => argv.includes(x));
const ALIVE = () => OK('{"result":{"agent":{"pane_id":"p1","agent_status":"working"}}}');

// Records every brief an `agent start` received and every `agent send`.
const briefs: string[] = [];
const sends: string[] = [];
const exec: Exec = async (argv) => {
  if (has(argv, "worktree", "create")) {
    // A real worktree create/reclaim takes real time; without the per-thread
    // spawn lock this window is exactly where a concurrent double-send races
    // a second spawnAgent for the same task.
    await new Promise((r) => setTimeout(r, 15));
    return OK(`{"result":{"worktree":{"path":${JSON.stringify(WT)},"branch":"hive/x","open_workspace_id":"w1"}}}`);
  }
  if (has(argv, "agent", "get")) return ALIVE();
  if (has(argv, "workspace", "list")) return OK('{"result":{"workspaces":[{"workspace_id":"wF","label":"hive-fleet"}]}}');
  if (has(argv, "tab", "create")) return OK('{"result":{"tab":{"tab_id":"wF:t2"}}}');
  if (has(argv, "agent", "start")) {
    briefs.push(argv[argv.indexOf("--") + 2]); // `-- claude <brief> …`
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
  const p = await (await fetch(BASE + "/api/projects", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "acme", repo_path: WT }),
  })).json();
  projectId = p.id;
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

let threadId = "";

test("first message spawns a persistent supervisor session (202, non-blocking)", async () => {
  const { status, json } = await post("/api/chat/turn", { project_id: projectId, text: "spin up the login work" });
  expect(status).toBe(202);
  expect(json.delivery).toBe("spawned");
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
  const { status, json } = await post("/api/chat/turn", { thread_id: threadId, text: "what's the status?" });
  expect(status).toBe(202);
  expect(json.delivery).toBe("delivered");
  expect(briefs.length).toBe(before); // no new spawn
  expect(sends.at(-1)).toContain("what's the status?");
  expect(sends.at(-1)).toContain(threadId); // wire prefix tells the session where to reply
});

test("descendant worker events wake the manager once with a batched update", async () => {
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
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    setEventHook(null);
  }

  expect(sends.length).toBe(before + 1);
  expect(sends.at(-1)).toContain("[hive manager wakeup]");
  expect(sends.at(-1)).toContain("implement login");
  expect(sends.at(-1)).toContain("verify login edge cases");
  expect(sends.at(-1)).toContain("Act on anything you can resolve");
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
  expect(briefs.length).toBe(before + 1); // exactly one spawn, not two

  const deliveries = [a.json.delivery, b.json.delivery].sort();
  expect(deliveries).toEqual(["delivered", "spawned"]); // winner spawns, waiter delivers into it

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
  expect(briefs.length).toBe(before + 1); // exactly one spawn, not two

  // Both requests ride the SAME underlying call (not two lock-serialized
  // calls like the existing-thread race below), so both see its one result.
  expect(a.json.delivery).toBe("spawned");
  expect(b.json.delivery).toBe("spawned");

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
  const { status, json } = await post("/api/chat/turn", { thread_id: threadId, text: "still there?" });
  expect(status).toBe(202);
  expect(json.delivery).toBe("spawned"); // fresh task, not "delivered" into the dead one
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
  const victim = await (await fetch(BASE + "/api/tasks", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project_id: projectId, title: "unrelated ship task" }),
  })).json();
  expect(victim.source).not.toBe("chat_supervisor");

  const { status, json } = await post("/api/chat/turn", {
    project_id: projectId, text: "hijack attempt", task_id: victim.id,
  });
  expect(status).toBe(202);

  const thread = (await get(`/api/chat/threads/${json.thread_id}`)).json;
  expect(thread.task_id).not.toBe(victim.id); // got its own fresh supervisor task, not the victim's

  const victimAfter = (await get(`/api/tasks/${victim.id}`)).json;
  expect(victimAfter.state).toBe(victim.state); // untouched
});

test("starting a chat with no project is rejected (session needs a repo)", async () => {
  const { status, json } = await post("/api/chat/turn", { text: "hello" });
  expect(status).toBe(400);
  expect(json.error).toContain("project_id is required");
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
});
