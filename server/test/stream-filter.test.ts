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
