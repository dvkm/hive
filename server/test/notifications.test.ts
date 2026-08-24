import { test, expect } from "bun:test";
import { openDb, newId, now, type DB } from "../src/db.ts";
import { transition } from "../src/state.ts";
import { enqueue, runDigest, ackNotifications, summarize, markShown, deeplinkPath } from "../src/notifications.ts";
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
  // ONE digest handoff to hive.app, not one per event
  expect(calls.length).toBe(1);
  expect(calls[0].slice(0, 4)).toEqual(["open", "-g", "-b", "dev.hive.app"]);
  const notification = new URL(calls[0][4]);
  expect(notification.protocol).toBe("hive:");
  expect(notification.hostname).toBe("notify");
  expect(notification.searchParams.get("title")).toBe("hive digest");
  expect(notification.searchParams.get("body")).toBe("2 done, 1 needs decision");
  expect(notification.searchParams.get("path")).toBe("/inbox");

  // all marked delivered; a second digest with nothing pending is a no-op
  const second = runDigest(db, { exec });
  expect(second.delivered).toBe(false);
  expect(calls.length).toBe(1);
});

test("urgent notification opens hive.app with its click destination", () => {
  const { db } = freshDb();
  const { exec, calls } = recordingExec();
  const row = enqueue(
    db,
    {
      kind: "decision",
      decision_id: "dec_123",
      title: "Decision needed: ship prod?",
      body: "Production DB acme-prod-db.",
      urgency: "urgent",
    },
    { exec }
  );

  // NOT pre-delivered: only the desktop app confirming it rendered counts.
  expect(row.delivered_at).toBeNull();
  expect(calls.length).toBe(1);
  expect(calls[0].slice(0, 4)).toEqual(["open", "-g", "-b", "dev.hive.app"]);
  const notification = new URL(calls[0][4]);
  expect(notification.searchParams.get("id")).toBe(row.id);
  expect(notification.searchParams.get("title")).toBe("Decision needed: ship prod?");
  expect(notification.searchParams.get("body")).toBe("Production DB acme-prod-db.");
  expect(notification.searchParams.get("path")).toBe("/decisions#dcard-dec_123");

  // the app reports back that macOS rendered it — that is what marks it seen
  expect(markShown(db, row.id)).toBe(true);
  expect(markShown(db, row.id)).toBe(false); // idempotent
  expect((db.query("SELECT delivered_at FROM notifications WHERE id = ?").get(row.id) as any).delivered_at).toBeTruthy();

  // urgent is not pending for the digest
  const digest = runDigest(db, { exec });
  expect(digest.delivered).toBe(false);
});

test("an urgent open decision pushes the question and inline answers", async () => {
  const { db, projectId } = freshDb();
  const taskId = newId();
  const decisionId = newId("dec");
  const t = now();
  db.query(
    "INSERT INTO tasks (id, project_id, title, state, kind, created_at, updated_at) VALUES (?,?,?, 'needs_decision','ship', ?, ?)"
  ).run(taskId, projectId, "ship it", t, t);
  db.query("INSERT INTO decisions (id, task_id, ts, title, options, status) VALUES (?,?,?,?,?,'open')").run(
    decisionId,
    taskId,
    t,
    "Ship it?",
    JSON.stringify([{ key: "approve", label: "Approve" }, { key: "deny", label: "Deny" }])
  );
  let pushed: any;

  enqueue(
    db,
    { kind: "decision", task_id: taskId, decision_id: decisionId, title: "Decision needed: Ship it?", urgency: "urgent" },
    { push: async (_db, payload) => { pushed = payload; } }
  );
  await Promise.resolve();

  expect(pushed).toEqual({
    title: "Ship it?",
    body: null,
    url: `/decisions#dcard-${decisionId}`,
    decisionId,
    actions: [{ action: "approve", title: "Approve" }, { action: "deny", title: "Deny" }],
  });
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

test("deeplink path: decision card beats task page beats the board", () => {
  expect(deeplinkPath({ decision_id: "dec_1", task_id: "t1" })).toBe("/decisions#dcard-dec_1");
  expect(deeplinkPath({ task_id: "t1" })).toBe("/tasks/t1");
  expect(deeplinkPath({})).toBe("/");
});

test("a task handed to review notifies urgently", () => {
  const { db, projectId } = freshDb();
  const id = newId();
  const t = now();
  db.query(
    "INSERT INTO tasks (id, project_id, title, state, kind, created_at, updated_at) VALUES (?,?,?, 'in_progress','ship', ?, ?)"
  ).run(id, projectId, "ship it", t, t);

  transition(db, id, "in_review");
  const notif = db.query("SELECT * FROM notifications WHERE task_id = ? AND kind = 'review'").get(id) as any;
  expect(notif).toBeTruthy();
  expect(notif.urgency).toBe("urgent");
});
