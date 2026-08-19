import { test, expect } from "bun:test";
import { openDb, newId, now, type DB } from "../src/db.ts";
import { transition } from "../src/state.ts";
import { enqueue, runDigest, ackNotifications, summarize } from "../src/notifications.ts";
import type { Exec, ExecResult } from "../src/exec.ts";

function freshDb(): { db: DB; projectId: string } {
  const db = openDb(":memory:");
  const projectId = newId("proj");
  db.query("INSERT INTO projects (id, name, created_at) VALUES (?,?,?)").run(projectId, "p", now());
  return { db, projectId };
}

// Records every argv it is called with; returns success.
function recordingExec(): { exec: Exec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: Exec = async (argv): Promise<ExecResult> => {
    calls.push(argv);
    return { code: 0, stdout: "", stderr: "" };
  };
  return { exec, calls };
}

test("summarize counts by kind in enqueue order", () => {
  const s = summarize([{ kind: "done" }, { kind: "done" }, { kind: "decision" }, { kind: "failed" }]);
  expect(s).toBe("2 done, 1 needs decision, 1 failed");
});

test("normal notifications batch into ONE digest, then never repeat", () => {
  const { db } = freshDb();
  const { exec, calls } = recordingExec();
  enqueue(db, { kind: "done", title: "a" });
  enqueue(db, { kind: "done", title: "b" });
  enqueue(db, { kind: "decision", title: "c" });

  // nothing delivered yet
  const undelivered = db.query("SELECT COUNT(*) AS n FROM notifications WHERE delivered_at IS NULL").get() as { n: number };
  expect(undelivered.n).toBe(3);

  const first = runDigest(db, { exec, now: () => "2026-07-09T00:00:00.000Z" });
  expect(first.delivered).toBe(true);
  expect(first.count).toBe(3);
  expect(first.summary).toBe("2 done, 1 needs decision");
  // ONE digest osascript call, not one per event
  expect(calls.length).toBe(1);
  expect(calls[0][0]).toBe("osascript");

  // all marked delivered; a second digest with nothing pending is a no-op
  const second = runDigest(db, { exec });
  expect(second.delivered).toBe(false);
  expect(calls.length).toBe(1);
});

test("urgent notification pushes immediately via injected exec and is pre-delivered", () => {
  const { db } = freshDb();
  const { exec, calls } = recordingExec();
  const row = enqueue(db, { kind: "incident", title: "Monitor down: api", body: "503", urgency: "urgent" }, { exec });

  expect(row.delivered_at).toBeTruthy(); // urgent is delivered on enqueue
  expect(calls.length).toBe(1);
  expect(calls[0][0]).toBe("osascript");
  expect(calls[0].join(" ")).toContain("Monitor down: api");

  // urgent is not pending for the digest
  const digest = runDigest(db, { exec });
  expect(digest.delivered).toBe(false);
});

test("transition to done/failed enqueues a normal notification", () => {
  const { db, projectId } = freshDb();
  const id = newId();
  const t = now();
  db.query(
    "INSERT INTO tasks (id, project_id, title, state, kind, created_at, updated_at) VALUES (?,?,?, 'verifying','ship', ?, ?)"
  ).run(id, projectId, "ship it", t, t);
  // done requires evidence
  db.query("INSERT INTO evidence (id, task_id, ts, kind) VALUES (?,?,?, 'log')").run(newId("ev"), id, now());

  transition(db, id, "done");
  const notif = db.query("SELECT * FROM notifications WHERE task_id = ? AND kind = 'done'").get(id) as any;
  expect(notif).toBeTruthy();
  expect(notif.urgency).toBe("normal");
  expect(notif.delivered_at).toBeNull(); // waits for the digest
});

test("a task under a test/ephemeral project never enqueues a notification, even urgent", () => {
  const { db } = freshDb();
  const testProjectId = newId("proj");
  db.query("INSERT INTO projects (id, name, config, created_at) VALUES (?,?,?,?)").run(
    testProjectId, "scratch", JSON.stringify({ test: true }), now()
  );
  const taskId = newId();
  const t = now();
  db.query("INSERT INTO tasks (id, project_id, title, state, kind, created_at, updated_at) VALUES (?,?,?, 'queued','ship', ?, ?)").run(
    taskId, testProjectId, "scratch task", t, t
  );
  const { exec, calls } = recordingExec();
  const row = enqueue(db, { kind: "decision", task_id: taskId, title: "scratch decision", urgency: "urgent" }, { exec });

  expect(row).toBeNull();
  expect(calls.length).toBe(0);
  const count = db.query("SELECT COUNT(*) AS n FROM notifications WHERE task_id = ?").get(taskId) as { n: number };
  expect(count.n).toBe(0);
});

test("ack marks all undelivered notifications as seen", () => {
  const { db } = freshDb();
  enqueue(db, { kind: "done", title: "a" });
  enqueue(db, { kind: "done", title: "b" });
  const acked = ackNotifications(db);
  expect(acked).toBe(2);
  const undelivered = db.query("SELECT COUNT(*) AS n FROM notifications WHERE delivered_at IS NULL").get() as { n: number };
  expect(undelivered.n).toBe(0);
});
