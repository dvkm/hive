// Director chat: a message routed to a supervisor subprocess that persists
// conversation history and executes scoped actions against the existing
// task/decision/steer handlers. The subprocess is stubbed (deps.plannerExec,
// which chat reuses) so the test never spawns `claude`.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "hive-chat-"));
process.env.HIVE_HOME = HOME;

const { openDb } = await import("../src/db.ts");
const { makeHandler } = await import("../src/api.ts");
const { extractChatResponse, composeChatPrompt, createThread, appendMessage } = await import("../src/chat.ts");
import type { PlannerExec } from "../src/planner.ts";

const db = openDb(":memory:");

// The exec stub returns whatever `next` is set to, wrapped in the
// `claude -p --output-format json` envelope ({result: "..."}).
let next = "";
const exec: PlannerExec = async () => ({ code: 0, stdout: JSON.stringify({ result: next }), stderr: "" });

let server: any;
let BASE = "";
let projectId = "";
beforeAll(async () => {
  server = Bun.serve({ port: 0, fetch: makeHandler(db, { plannerExec: exec }) });
  BASE = `http://127.0.0.1:${server.port}`;
  const p = await (await fetch(BASE + "/api/projects", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "acme", repo_path: "/repo" }),
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

test("extractChatResponse: plain, envelope, prose-wrapped, and invalid", () => {
  expect(extractChatResponse(`{"reply":"hi","actions":[]}`)).toEqual({ reply: "hi", actions: [] });
  expect(extractChatResponse(JSON.stringify({ result: `{"reply":"yo","actions":[]}` }))).toEqual({ reply: "yo", actions: [] });
  expect(extractChatResponse('here you go: {"reply":"x","actions":[]} thanks')).toEqual({ reply: "x", actions: [] });
  expect(extractChatResponse("not json at all")).toBeNull();
  // Unknown / malformed actions are dropped by the allow-list, never executed.
  const r = extractChatResponse(`{"reply":"r","actions":[{"type":"merge_pr","pr":"1"},{"type":"create_task"}]}`);
  expect(r).toEqual({ reply: "r", actions: [] });
});

test("read-only status turn: reply persisted, no action, new thread created", async () => {
  next = `{"reply":"You have no open tasks yet.","actions":[]}`;
  const { status, json } = await post("/api/chat/turn", { project_id: projectId, text: "what's the status?" });
  expect(status).toBe(200);
  expect(json.reply).toContain("no open tasks");
  expect(json.actions).toEqual([]);
  expect(json.thread_id).toBeTruthy();

  // History persisted: director msg + assistant reply, oldest→newest.
  const thread = await get(`/api/chat/threads/${json.thread_id}`);
  expect(thread.json.messages.map((m: any) => m.role)).toEqual(["director", "assistant"]);
  expect(thread.json.messages[0].text).toBe("what's the status?");
});

test("create_task action runs through the real handler", async () => {
  next = `{"reply":"Filing that now.","actions":[{"type":"create_task","title":"Add retry to fetch","brief":"wrap fetch in retry","kind":"ship"}]}`;
  const { json } = await post("/api/chat/turn", { project_id: projectId, text: "make a task to add retries" });
  expect(json.actions).toHaveLength(1);
  expect(json.actions[0]).toMatchObject({ type: "create_task", ok: true });
  expect(json.actions[0].number).toBeGreaterThan(0);
  // The task really exists on the board with source=chat.
  const tasks = await get(`/api/tasks?project_id=${projectId}`);
  const t = tasks.json.find((x: any) => x.title === "Add retry to fetch");
  expect(t).toBeTruthy();
  expect(t.source).toBe("chat");
});

test("create_task without project scope fails cleanly", async () => {
  next = `{"reply":"ok","actions":[{"type":"create_task","title":"orphan"}]}`;
  const { json } = await post("/api/chat/turn", { text: "make a task" }); // no project_id
  expect(json.actions[0]).toMatchObject({ type: "create_task", ok: false });
  expect(json.actions[0].error).toContain("project scope");
});

test("answer_decision action resolves a real open decision", async () => {
  // Create a task + an open decision on it.
  const task = (await post("/api/tasks", { project_id: projectId, title: "decide me" })).json;
  const dec = (await post("/api/decisions", {
    task_id: task.id, title: "pick one",
    options: [{ key: "a", label: "Option A" }, { key: "b", label: "Option B" }],
  })).json;

  next = `{"reply":"Answering A.","actions":[{"type":"answer_decision","decision_id":"${dec.id}","answer_key":"a","note":"go"}]}`;
  const { json } = await post("/api/chat/turn", { project_id: projectId, text: "answer the decision with A" });
  expect(json.actions[0]).toMatchObject({ type: "answer_decision", ok: true });

  const decs = await get("/api/decisions?status=all");
  const answered = decs.json.find((d: any) => d.id === dec.id);
  expect(answered.status).toBe("answered");
  expect(answered.answer_key).toBe("a");
});

test("thread continues across turns and replays history into the prompt", async () => {
  next = `{"reply":"first","actions":[]}`;
  const first = (await post("/api/chat/turn", { project_id: projectId, text: "hello" })).json;
  const threadId = first.thread_id;
  next = `{"reply":"second","actions":[]}`;
  const second = (await post("/api/chat/turn", { thread_id: threadId, text: "again" })).json;
  expect(second.thread_id).toBe(threadId);
  const thread = await get(`/api/chat/threads/${threadId}`);
  expect(thread.json.messages).toHaveLength(4); // 2 director + 2 assistant

  // composeChatPrompt replays prior messages.
  const t2 = createThread(db, { project_id: projectId });
  appendMessage(db, t2.id, "director", "earlier question");
  const prompt = composeChatPrompt(db, { projectId, history: [{ id: "x", thread_id: t2.id, ts: "", role: "director", text: "earlier question", actions: [] }], text: "now this" });
  expect(prompt).toContain("earlier question");
  expect(prompt).toContain("now this");
});

test("subprocess failure returns a graceful error message, still persisted", async () => {
  // A non-JSON stdout → runChatTurn throws → 502 with an assistant error message.
  next = "totally not json";
  const { status, json } = await post("/api/chat/turn", { project_id: projectId, text: "boom" });
  expect(status).toBe(502);
  expect(json.error).toContain("couldn't process");
  expect(json.thread_id).toBeTruthy();
});
