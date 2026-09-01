// HIVE-551/553: a work task filed from a Jira issue's TITLE while the real spec
// sits unread in the linked mirror task's brief must warn, not silently create
// with a thin brief (root cause of WEB-118) — but must not refuse, since a
// title-only mirror (WEB-2) is a legitimate case.
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HIVE_HOME = mkdtempSync(join(tmpdir(), "hive-thin-brief-"));

const { openDb, newId, now } = await import("../src/db.ts");
import type { DB } from "../src/db.ts";
const { makeHandler } = await import("../src/api.ts");

function freshDb(): { db: DB; projectId: string } {
  const db = openDb(":memory:");
  const projectId = newId("proj");
  db.query("INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)")
    .run(projectId, "p", "/repo", "{}", now());
  return { db, projectId };
}

function makeMirror(db: DB, projectId: string, key: string, brief: string): string {
  const id = newId();
  const t = now();
  db.query(
    `INSERT INTO tasks (id, project_id, title, brief, state, kind, source, priority, jira_key, jira_link_kind, created_at, updated_at)
     VALUES (?,?,?,?,'queued','chore',NULL,'normal',?,'mirror',?,?)`
  ).run(id, projectId, `[${key}] some title`, brief, key, t, t);
  return id;
}

function serve(db: DB) {
  const server = Bun.serve({ port: 0, fetch: makeHandler(db) });
  const BASE = `http://127.0.0.1:${server.port}`;
  return {
    server,
    post: (path: string, body: unknown) =>
      fetch(BASE + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  };
}

test("warns, but still creates, a title-only brief when the linked mirror has a substantial spec", async () => {
  const { db, projectId } = freshDb();
  const spec = "x".repeat(300);
  const m = makeMirror(db, projectId, "WEB-118", spec);
  const { server, post } = serve(db);
  try {
    const res = await post("/api/tasks", {
      project_id: projectId,
      title: "[WEB-118] fix the thing",
      kind: "chore",
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(String(body.warning)).toContain("mirror task");
    const event = db.query("SELECT payload FROM events WHERE task_id = ? AND type = 'brief_mirror_mismatch'").get(body.id) as { payload: string };
    expect(JSON.parse(event.payload)).toEqual({ mirror_task_id: m, mirror_brief_len: spec.length, work_brief_len: 0 });
  } finally {
    server.stop();
  }
});

test("allows creation when the new brief already carries the spec", async () => {
  const { db, projectId } = freshDb();
  const spec = "x".repeat(300);
  makeMirror(db, projectId, "WEB-119", spec);
  const { server, post } = serve(db);
  try {
    const res = await post("/api/tasks", {
      project_id: projectId,
      title: "[WEB-119] fix the thing",
      kind: "chore",
      brief: spec,
    });
    expect(res.status).toBe(201);
  } finally {
    server.stop();
  }
});

test("allows creation when no mirror is linked", async () => {
  const { db, projectId } = freshDb();
  const { server, post } = serve(db);
  try {
    const res = await post("/api/tasks", {
      project_id: projectId,
      title: "just a normal task",
      kind: "chore",
    });
    expect(res.status).toBe(201);
  } finally {
    server.stop();
  }
});
