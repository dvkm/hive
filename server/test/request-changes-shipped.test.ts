// Request changes on shipped work (HIVE-505). The director read what landed and
// wants it different. The original task is done and STAYS done; the ask becomes
// its own queued task carrying what the original built.
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HIVE_HOME = mkdtempSync(join(tmpdir(), "hive-rework-"));

const { openDb, newId, now } = await import("../src/db.ts");
const { makeHandler } = await import("../src/api.ts");
const { writeEvent, getTask } = await import("../src/state.ts");
const { Herdr } = await import("../src/runtime/herdr.ts");
import type { Exec } from "../src/exec.ts";

const exec: Exec = async () => ({ code: 0, stdout: "", stderr: "" });

function fixture(task: Record<string, any>) {
  const db = openDb(":memory:");
  const projectId = newId("proj");
  db.query("INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)")
    .run(projectId, "Hive", "/repo", "{}", now());
  const id = newId();
  const t = now();
  db.query(
    `INSERT INTO tasks (id, project_id, title, brief, state, kind, pr_url, head_sha, created_at, updated_at)
     VALUES (?,?,?,?, 'done', ?, ?, ?, ?, ?)`
  ).run(id, projectId, task.title, task.brief ?? null, task.kind ?? "ship", task.pr_url ?? null, task.head_sha ?? null, t, t);
  const server = Bun.serve({ port: 0, fetch: makeHandler(db, { herdr: new Herdr(exec, "herdr"), exec }) });
  return { db, id, projectId, server, base: `http://127.0.0.1:${server.port}` };
}

const post = async (base: string, path: string, body: unknown) => {
  const res = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as any };
};

test("a note on a shipped task files one queued follow-up carrying the PR, and leaves the original done", async () => {
  const { db, id, projectId, server, base } = fixture({
    title: "Add the away switch",
    brief: "Original brief text",
    pr_url: "https://github.com/acme/hive/pull/34",
    head_sha: "abc1234",
  });
  writeEvent(db, {
    task_id: id,
    source: "director",
    type: "merged",
    payload: { method: "local ff-only", base: "main", merged_files: ["server/src/away.ts", "web/src/views/Brief.tsx"] },
  });

  const r = await post(base, `/api/tasks/${id}/request-changes`, { notes: "The switch should hold pushes for 4 hours, not 1." });
  expect(r.status).toBe(200);
  expect(r.json.followup_task_id).toBeTruthy();
  expect(r.json.followup_label).toBe("HIVE-2");

  const followup = getTask(db, r.json.followup_task_id);
  expect(followup.state).toBe("queued");
  expect(followup.kind).toBe("ship");
  expect(followup.source).toBe("director_rework");
  expect(followup.parent_task_id).toBe(id);
  expect(followup.project_id).toBe(projectId);
  // The brief must stand alone: what was asked, and what already shipped.
  expect(followup.brief).toContain("HIVE-1");
  expect(followup.brief).toContain("Add the away switch");
  expect(followup.brief).toContain("https://github.com/acme/hive/pull/34");
  expect(followup.brief).toContain("abc1234");
  expect(followup.brief).toContain("server/src/away.ts");
  expect(followup.brief).toContain("Original brief text");
  expect(followup.brief).toContain("The switch should hold pushes for 4 hours, not 1.");

  // Exactly one task was filed, and the original is untouched.
  const queued = db.query("SELECT COUNT(*) AS n FROM tasks WHERE state = 'queued'").get() as any;
  expect(queued.n).toBe(1);
  expect(getTask(db, id).state).toBe("done");
  server.stop(true);
});

test("a report-only task with no PR still produces a usable brief", async () => {
  const { db, id, server, base } = fixture({ title: "Survey the flake rate", kind: "scout" });

  const r = await post(base, `/api/tasks/${id}/request-changes`, { note: "Break the numbers down per project." });
  expect(r.status).toBe(200);

  const followup = getTask(db, r.json.followup_task_id);
  expect(followup.kind).toBe("scout"); // kind is inherited from the original
  expect(followup.brief).toContain("Survey the flake rate");
  expect(followup.brief).toContain("none — this task shipped no PR");
  expect(followup.brief).toContain("Break the numbers down per project.");
  expect(getTask(db, id).state).toBe("done");
  server.stop(true);
});

test("an empty note is refused and files nothing", async () => {
  const { db, id, server, base } = fixture({ title: "Add the away switch" });
  const r = await post(base, `/api/tasks/${id}/request-changes`, { note: "   " });
  expect(r.status).toBe(400);
  expect((db.query("SELECT COUNT(*) AS n FROM tasks").get() as any).n).toBe(1);
  server.stop(true);
});
