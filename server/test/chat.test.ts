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
const { makeHandler, notifyManagerOfEvent, sweepManagerInboxes } = await import("../src/api.ts");
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
const exec: Exec = async (argv) => {
  if (has(argv, "worktree", "create")) {
    // A real worktree create/reclaim takes real time; without the per-thread
    // spawn lock this window is exactly where a concurrent double-send races
    // a second spawnAgent for the same task.
    await new Promise((r) => setTimeout(r, 15));
    return OK(`{"result":{"worktree":{"path":${JSON.stringify(WT)},"branch":"hive/x","open_workspace_id":"w1"}}}`);
  }
  if (has(argv, "agent", "get"))
    return OK(`{"result":{"agent":{"pane_id":"p1","agent_status":"${probeStatus}"}}}`);
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
  const p: any = await (await fetch(BASE + "/api/projects", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "acme", repo_path: WT }),
  })).json();
  projectId = p.id;
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

test("a leftover shell pane is respawned instead of receiving the director message", async () => {
  const before = briefs.length;
  probeStatus = "unknown";
  try {
    const { status, json } = await post("/api/chat/turn", { thread_id: threadId, text: "resume the sweep" });
    expect(status).toBe(202);
    expect(json.delivery).toBe("spawned");
    expect(briefs.length).toBe(before + 1);
    expect(briefs.at(-1)).toContain("resume the sweep");
  } finally {
    probeStatus = "working";
  }
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
    writeEvent(db, { task_id: worker.id, source: "agent", type: "checkpoint", payload: { note: "kept the existing cookie format" } });
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    setEventHook(null);
  }

  expect(sends.length).toBe(before + 1);
  expect(sends.at(-1)).toContain("[hive manager wakeup]");
  expect(sends.at(-1)).toContain("implement login");
  expect(sends.at(-1)).toContain("verify login edge cases");
  expect(sends.at(-1)).toContain("checkpoint");
  expect(sends.at(-1)).toContain("Act on anything you can resolve");
});

test("project inbox events fall back to the active manager when that project has no manager", async () => {
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

  expect(sends.length).toBe(before + 1);
  expect(sends.at(-1)).toContain("older project work");
  expect(sends.at(-1)).toContain(`/api/checkpoints?project_id=${otherProject.id}`);
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
  const victim: any = await (await fetch(BASE + "/api/tasks", {
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

test("Chief of Staff is one durable cross-project thread backed by the hive coordinator repo", async () => {
  const before = briefs.length;
  const [first, second] = await Promise.all([
    post("/api/chat/turn", { scope: "chief", text: "remember the portfolio and handle the details" }),
    post("/api/chat/turn", { scope: "chief", text: "also restore where I left off" }),
  ]);
  expect(first.status).toBe(202);
  expect(second.status).toBe(202);
  expect(first.json.thread_id).toBe(second.json.thread_id);
  expect([first.json.delivery, second.json.delivery].sort()).toEqual(["delivered", "spawned"]);

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

  const followup = await post("/api/chat/turn", { scope: "chief", text: "where did I leave off?" });
  expect(followup.status).toBe(202);
  expect(followup.json.delivery).toBe("delivered");
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
    options: [
      { key: "safe", label: "Safe rollout", recommended: true },
      { key: "fast", label: "Fast rollout" },
    ],
  })).json;
  await post("/api/chat/turn", { thread_id: chief.id, text: "Anything you actually need from me?" });

  const reply = await post(`/api/chat/threads/${chief.id}/reply`, {
    text: "I need one call from you.",
    decision_ids: [decision.id],
  });
  expect(reply.status).toBe(200);
  expect(reply.json.message.actions).toEqual([
    { type: "decision", decision_id: decision.id, label: "Which launch mode should we use?" },
  ]);

  await post("/api/chat/turn", { thread_id: chief.id, text: "Do you still need anything from me?" });
  const before = (await get(`/api/chat/threads/${chief.id}`)).json.messages.length;

  const duplicate = await post(`/api/chat/threads/${chief.id}/reply`, {
    text: "Reminder about that same decision.",
    decision_ids: [decision.id],
  });
  expect(duplicate.json.suppressed).toBe(true);
  expect((await get(`/api/chat/threads/${chief.id}`)).json.messages).toHaveLength(before);
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
  expect(brief).toContain("Acknowledge a safe checkpoint");
  expect(brief).toContain("whole current-project inbox");
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
