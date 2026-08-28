import { test, expect } from "bun:test";
import { openDb, newId, now, type DB } from "../src/db.ts";
import { makeHandler, sseStream } from "../src/api.ts";
import { broadcast } from "../src/bus.ts";

// Read whatever frames a stream produced, without holding the connection open.
// Every frame arrives as one `data: {...}\n\n` chunk.
async function drain(res: Response): Promise<any[]> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const chunk = await Promise.race([reader.read(), new Promise<null>((r) => setTimeout(() => r(null), 20))]);
    if (!chunk || chunk.done) break;
    buf += dec.decode(chunk.value);
  }
  void reader.cancel();
  return buf.split("\n\n").filter((s) => s.startsWith("data: ")).map((s) => JSON.parse(s.slice(6)));
}

function seed(): { db: DB; a: string; b: string; taskA: string; taskB: string } {
  const db = openDb(":memory:");
  const t = now();
  const a = newId("proj"), b = newId("proj");
  for (const p of [a, b])
    db.query("INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)").run(p, p, "/repo", "{}", t);
  const taskA = newId(), taskB = newId();
  db.query("INSERT INTO tasks (id, project_id, title, state, kind, created_at, updated_at) VALUES (?,?,?,?,?,?,?)")
    .run(taskA, a, "a", "queued", "ship", t, t);
  db.query("INSERT INTO tasks (id, project_id, title, state, kind, created_at, updated_at) VALUES (?,?,?,?,?,?,?)")
    .run(taskB, b, "b", "queued", "ship", t, t);
  // Installs the task -> project resolver bus.ts uses to stamp frames.
  makeHandler(db);
  return { db, a, b, taskA, taskB };
}

test("?project= keeps hello and its own project's decision, drops the other project's", async () => {
  const { a, taskA, taskB } = seed();
  const res = sseStream(new URLSearchParams({ project: a }));
  broadcast({ type: "decision", decision: { id: "d1", task_id: taskA, title: "mine" } });
  broadcast({ type: "decision", decision: { id: "d2", task_id: taskB, title: "theirs" } });
  broadcast({ type: "offline", on: true });
  const frames = await drain(res);

  expect(frames[0].type).toBe("hello");
  const decisions = frames.filter((f) => f.type === "decision");
  expect(decisions.length).toBe(1);
  expect(decisions[0].decision.title).toBe("mine");
  expect(decisions[0].project_id).toBe(a);
  // Scopeless frames are fleet-wide news and always pass.
  expect(frames.some((f) => f.type === "offline")).toBe(true);
});

test("?classes= drops frame types that were not asked for", async () => {
  const { a, taskA } = seed();
  const res = sseStream(new URLSearchParams({ classes: "decision" }));
  broadcast({ type: "decision", decision: { id: "d1", task_id: taskA } });
  broadcast({ type: "task", task: { id: taskA, project_id: a } });
  const frames = await drain(res);

  expect(frames.map((f) => f.type)).toEqual(["hello", "decision"]);
});

test("no params: unchanged fan-out, and frames carry project_id where derivable", async () => {
  const { a, taskA, taskB } = seed();
  const res = sseStream();
  broadcast({ type: "decision", decision: { id: "d1", task_id: taskB } });
  broadcast({ type: "task", task: { id: taskA, project_id: a } });
  broadcast({ type: "event", event: { id: "e1", task_id: taskA, type: "status" } });
  broadcast({ type: "offline", on: false });
  const frames = await drain(res);

  expect(frames.map((f) => f.type)).toEqual(["hello", "decision", "task", "event", "offline"]);
  expect(frames.find((f) => f.type === "task").project_id).toBe(a);
  expect(frames.find((f) => f.type === "event").project_id).toBe(a);
  expect(frames.find((f) => f.type === "offline").project_id).toBeUndefined();
});

// Every frame type, one case each. A filter that silently passes everything is
// worse than no filter, so each frame is asserted on both sides of ?project=:
// scoped frames must be stamped and must be dropped for the other project,
// scopeless frames must always pass.
test("every frame type: scoped frames are stamped and filtered, scopeless ones always pass", async () => {
  const { db, a, b, taskA, taskB } = seed();
  const threadA = newId("thr"), threadChief = newId("thr");
  const t = now();
  for (const [id, proj] of [[threadA, a], [threadChief, null]] as const)
    db.query("INSERT INTO chat_threads (id, project_id, created_at, updated_at) VALUES (?,?,?,?)").run(id, proj, t, t);

  const res = sseStream(new URLSearchParams({ project: a }));

  // One frame per type for project a, then the same type for project b.
  broadcast({ type: "task", task: { id: taskA, project_id: a } });
  broadcast({ type: "task", task: { id: taskB, project_id: b } });
  broadcast({ type: "event", event: { id: "e1", task_id: taskA, type: "status" } });
  broadcast({ type: "event", event: { id: "e2", task_id: taskB, type: "status" } });
  broadcast({ type: "decision", decision: { id: "d1", task_id: taskA } });
  broadcast({ type: "decision", decision: { id: "d2", task_id: taskB } });
  broadcast({ type: "notification", notification: { id: "n1", task_id: taskA } });
  broadcast({ type: "notification", notification: { id: "n2", task_id: taskB } });
  broadcast({ type: "evidence", evidence: { id: "ev1", task_id: taskA } });
  broadcast({ type: "evidence", evidence: { id: "ev2", task_id: taskB } });
  broadcast({ type: "usage", usage: { id: "u1", task_id: taskA } });
  broadcast({ type: "usage", usage: { id: "u2", task_id: taskB } });
  // incident and learning are scoped by their own project_id, not a task.
  broadcast({ type: "incident", incident: { id: "inc1", project_id: a } });
  broadcast({ type: "incident", incident: { id: "inc2", project_id: b } });
  broadcast({ type: "learning", learning: { id: "l1", project_id: a } });
  broadcast({ type: "learning", learning: { id: "l2", project_id: b } });
  // chat_message rows carry no scope of their own; the caller stamps the
  // parent thread's project.
  broadcast({ type: "chat_message", project_id: a, message: { id: "m1", thread_id: threadA } });
  broadcast({ type: "chat_message", project_id: b, message: { id: "m2", thread_id: newId("thr") } });
  // Scopeless: the portfolio Chief thread, and fleet-wide frames.
  broadcast({ type: "chat_message", project_id: null, message: { id: "m3", thread_id: threadChief } });
  broadcast({ type: "chat_thread", thread: { id: threadA, project_id: a } });
  broadcast({ type: "offline", on: true });
  broadcast({ type: "reconciler_error", error: "boom" });

  const frames = await drain(res);
  const byType = (type: string) => frames.filter((f) => f.type === type);

  // Scoped types: exactly one frame survived per type, it is project a's row,
  // and it is stamped with project a. [frame type, payload key, expected id].
  const scoped: [string, string, string][] = [
    ["task", "task", taskA],
    ["event", "event", "e1"],
    ["decision", "decision", "d1"],
    ["notification", "notification", "n1"],
    ["evidence", "evidence", "ev1"],
    ["usage", "usage", "u1"],
    ["incident", "incident", "inc1"],
    ["learning", "learning", "l1"],
  ];
  for (const [type, key, expectedId] of scoped) {
    // Labelled with the type so a failure names the frame that regressed.
    const got = byType(type);
    expect([type, got.length]).toEqual([type, 1]);
    expect([type, got[0].project_id]).toEqual([type, a]);
    expect([type, got[0][key].id]).toEqual([type, expectedId]);
  }

  // chat_message: project a's passes, project b's is dropped, the Chief's
  // (scopeless) always passes.
  expect(byType("chat_message").map((f) => f.message.id)).toEqual(["m1", "m3"]);

  // Scopeless frames are fleet-wide news and are never filtered out.
  expect(byType("chat_thread").length).toBe(1);
  expect(byType("chat_thread")[0].project_id).toBeUndefined();
  expect(byType("offline").length).toBe(1);
  expect(byType("reconciler_error").length).toBe(1);
});

test("?classes= admits exactly the listed frame types, across every type", async () => {
  const { a, taskA } = seed();
  const res = sseStream(new URLSearchParams({ classes: "incident,chat_message,usage" }));
  broadcast({ type: "task", task: { id: taskA, project_id: a } });
  broadcast({ type: "event", event: { id: "e1", task_id: taskA } });
  broadcast({ type: "decision", decision: { id: "d1", task_id: taskA } });
  broadcast({ type: "notification", notification: { id: "n1", task_id: taskA } });
  broadcast({ type: "evidence", evidence: { id: "ev1", task_id: taskA } });
  broadcast({ type: "usage", usage: { id: "u1", task_id: taskA } });
  broadcast({ type: "incident", incident: { id: "inc1", project_id: a } });
  broadcast({ type: "learning", learning: { id: "l1", project_id: a } });
  broadcast({ type: "chat_message", project_id: a, message: { id: "m1" } });
  broadcast({ type: "offline", on: true });

  const frames = await drain(res);
  expect(frames.map((f) => f.type)).toEqual(["hello", "usage", "incident", "chat_message"]);
});
