import { test, expect } from "bun:test";
import { openDb, newId, now, setSetting, isOffline, type DB } from "../src/db.ts";
import { dispatchOnce } from "../src/dispatcher.ts";
import { promoteOnce } from "../src/promoter.ts";
import { makeHandler } from "../src/api.ts";

function freshDb(): { db: DB; projectId: string } {
  const db = openDb(":memory:");
  const projectId = newId("proj");
  db.query("INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)").run(
    projectId, "p", "/repo", JSON.stringify({ auto_dispatch: true, promote: { from: "s", to: "m" } }), now()
  );
  return { db, projectId };
}

test("offline gates: dispatcher and promoter no-op; queued tasks stay queued", async () => {
  const { db, projectId } = freshDb();
  const id = newId();
  const t = now();
  db.query("INSERT INTO tasks (id, project_id, title, state, kind, created_at, updated_at) VALUES (?,?,?,?,?,?,?)")
    .run(id, projectId, "t", "queued", "ship", t, t);
  setSetting(db, "offline", "1");
  expect(isOffline(db)).toBe(true);

  let execCalls = 0;
  const exec = async () => { execCalls++; return { code: 0, stdout: "", stderr: "" }; };
  const herdrStub = { } as any; // dispatcher must return before touching herdr
  await dispatchOnce(db, { herdr: herdrStub });
  await promoteOnce(db, { exec });
  expect(execCalls).toBe(0);
  expect((db.query("SELECT state FROM tasks WHERE id = ?").get(id) as any).state).toBe("queued");

  setSetting(db, "offline", "0");
  expect(isOffline(db)).toBe(false);
});

test("offline endpoint: toggles, broadcasts, steers working agents with prep/resume", async () => {
  const { db, projectId } = freshDb();
  // one working agent-bearing task
  const id = newId();
  const t = now();
  db.query("INSERT INTO tasks (id, project_id, title, state, kind, agent_target, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(id, projectId, "busy", "in_progress", "ship", id, t, t);

  const sent: string[] = [];
  const herdr = {
    send: async (_target: string, message: string) => { sent.push(message); return { code: 0, stdout: "{}", stderr: "" }; },
    run: async () => ({ code: 0, stdout: "{}", stderr: "" }),
  } as any;

  const handler = makeHandler(db, { herdr });
  let r = await (await handler(new Request("http://127.0.0.1/api/offline", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ on: true }) }))).json();
  expect(r.on).toBe(true);
  expect(isOffline(db)).toBe(true);

  // idempotent re-set steers nothing extra
  r = await (await handler(new Request("http://127.0.0.1/api/offline", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ on: true }) }))).json();
  expect(r.steered).toBe(0);

  r = await (await handler(new Request("http://127.0.0.1/api/offline", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ on: false }) }))).json();
  expect(r.on).toBe(false);
  expect(isOffline(db)).toBe(false);

  const g = await (await handler(new Request("http://127.0.0.1/api/offline"))).json();
  expect(g.on).toBe(false);
  // herdr send may be wrapped by the steer path; assert the prep + resume texts went out
  expect(sent.some((m) => m.includes("OFFLINE PREP"))).toBe(true);
  expect(sent.some((m) => m.includes("Back ONLINE"))).toBe(true);
});
