import { test, expect } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, newId, now, type DB } from "../src/db.ts";
import { transition, canTransition, TransitionError, getTask, expireOpenDecisions, expireOrphanedDecisions, isDeferred, deferTask, undeferTask, advanceIfFinished, writeEvent, extractPrUrl, backfillStuckPrUrls } from "../src/state.ts";

// Gives a project a real git repo with an `origin` remote, so projectRepoSlug()
// (which shells out to `git remote get-url origin`) resolves "owner/repo".
function setProjectRepo(db: DB, projectId: string, slug: string): void {
  const repoPath = mkdtempSync(join(tmpdir(), "hive-state-test-"));
  execSync("git init -q", { cwd: repoPath });
  execSync(`git remote add origin https://github.com/${slug}.git`, { cwd: repoPath });
  db.query("UPDATE projects SET repo_path = ? WHERE id = ?").run(repoPath, projectId);
}

function freshDb(): { db: DB; projectId: string } {
  const db = openDb(":memory:");
  const projectId = newId("proj");
  db.query("INSERT INTO projects (id, name, created_at) VALUES (?,?,?)").run(projectId, "p", now());
  return { db, projectId };
}

function makeTask(db: DB, projectId: string, kind = "ship"): string {
  const id = newId();
  const t = now();
  db.query(
    "INSERT INTO tasks (id, project_id, title, state, kind, created_at, updated_at) VALUES (?,?,?, 'queued', ?, ?, ?)"
  ).run(id, projectId, "t", kind, t, t);
  return id;
}

function addEvidence(db: DB, taskId: string, kind = "screenshot") {
  db.query(
    "INSERT INTO evidence (id, task_id, ts, kind) VALUES (?,?,?,?)"
  ).run(newId("ev"), taskId, now(), kind);
}

function addDecision(db: DB, taskId: string, status = "open"): string {
  const id = newId("dec");
  db.query(
    "INSERT INTO decisions (id, task_id, ts, title, options, status) VALUES (?,?,?,?,?,?)"
  ).run(id, taskId, now(), "d", '[{"key":"proceed","label":"Proceed"}]', status);
  return id;
}

test("valid forward transition writes a state_change event", () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId);
  transition(db, id, "in_progress");
  expect(getTask(db, id).state).toBe("in_progress");
  const events = db.query("SELECT * FROM events WHERE task_id = ? AND type = 'state_change'").all(id);
  expect(events.length).toBe(1);
});

test("transition rolls back the state when its event cannot commit", () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId);
  db.exec(`CREATE TRIGGER reject_state_event BEFORE INSERT ON events
    WHEN NEW.type = 'state_change' BEGIN SELECT RAISE(ABORT, 'event rejected'); END`);

  expect(() => transition(db, id, "in_progress")).toThrow(/event rejected/);
  expect(getTask(db, id).state).toBe("queued");
  expect(db.query("SELECT COUNT(*) AS n FROM events WHERE task_id = ?").get(id)).toEqual({ n: 0 });
});

test("invalid transition is rejected with a clear error", () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId);
  expect(() => transition(db, id, "done")).toThrow(TransitionError);
  expect(() => transition(db, id, "verifying")).toThrow(/invalid transition/);
});

test("extractPrUrl pulls a github PR URL out of free text", () => {
  expect(extractPrUrl("PR https://github.com/corebeatcokr/monorepo/pull/1032")).toBe(
    "https://github.com/corebeatcokr/monorepo/pull/1032"
  );
  expect(extractPrUrl("no url here")).toBeNull();
  expect(extractPrUrl(null)).toBeNull();
  expect(extractPrUrl(undefined)).toBeNull();
});

test("transitioning to in_review backfills pr_url from the reason text when only free text carries it", () => {
  const { db, projectId } = freshDb();
  setProjectRepo(db, projectId, "corebeatcokr/monorepo");
  const id = makeTask(db, projectId);
  transition(db, id, "in_progress");
  transition(db, id, "in_review", { reason: "PR https://github.com/corebeatcokr/monorepo/pull/1032" });
  expect(getTask(db, id).pr_url).toBe("https://github.com/corebeatcokr/monorepo/pull/1032");
  const linked = db.query("SELECT * FROM events WHERE task_id = ? AND type = 'pr_linked'").all(id) as any[];
  expect(linked.length).toBe(1);
  expect(JSON.parse(linked[0].payload).via).toBe("reason_backfill");
});

test("in_review backfill does not clobber an already-linked pr_url", () => {
  const { db, projectId } = freshDb();
  setProjectRepo(db, projectId, "corebeatcokr/monorepo");
  const id = makeTask(db, projectId);
  db.query("UPDATE tasks SET pr_url = ? WHERE id = ?").run("https://github.com/corebeatcokr/monorepo/pull/1", id);
  transition(db, id, "in_progress");
  transition(db, id, "in_review", { reason: "PR https://github.com/corebeatcokr/monorepo/pull/1032" });
  expect(getTask(db, id).pr_url).toBe("https://github.com/corebeatcokr/monorepo/pull/1");
});

test("in_review backfill skips a PR named in the reason that belongs to a different repo", () => {
  const { db, projectId } = freshDb();
  setProjectRepo(db, projectId, "corebeatcokr/monorepo");
  const id = makeTask(db, projectId);
  transition(db, id, "in_progress");
  // Prose an agent wrote can legitimately reference someone else's PR ("same
  // fix as <url>") — that must never get adopted as this task's pr_url.
  transition(db, id, "in_review", { reason: "same fix as https://github.com/dvkm/hive-private/pull/42" });
  expect(getTask(db, id).pr_url).toBeNull();
});

test("backfillStuckPrUrls links pr_url for a task already sitting in in_review from before the fix existed", () => {
  const { db, projectId } = freshDb();
  setProjectRepo(db, projectId, "corebeatcokr/monorepo");
  const id = makeTask(db, projectId);
  // Simulate a legacy stuck task: state_change reason carried the PR URL as
  // free text, but pr_url was never set because this predates the in-transition
  // backfill (transition() only fires on entry to in_review).
  db.query("UPDATE tasks SET state = 'in_review' WHERE id = ?").run(id);
  writeEvent(db, {
    task_id: id,
    source: "director",
    type: "state_change",
    payload: { from: "in_progress", to: "in_review", reason: "PR https://github.com/corebeatcokr/monorepo/pull/1024" },
  });

  const count = backfillStuckPrUrls(db);
  expect(count).toBe(1);
  expect(getTask(db, id).pr_url).toBe("https://github.com/corebeatcokr/monorepo/pull/1024");
  const linked = db.query("SELECT * FROM events WHERE task_id = ? AND type = 'pr_linked'").all(id) as any[];
  expect(linked.length).toBe(1);
  expect(JSON.parse(linked[0].payload).via).toBe("stuck_reason_backfill");
});

test("backfillStuckPrUrls is a no-op when pr_url is already set or the reason has no URL", () => {
  const { db, projectId } = freshDb();
  setProjectRepo(db, projectId, "corebeatcokr/monorepo");
  const linked = makeTask(db, projectId);
  db.query("UPDATE tasks SET state = 'in_review', pr_url = ? WHERE id = ?").run(
    "https://github.com/corebeatcokr/monorepo/pull/1",
    linked
  );

  const noUrl = makeTask(db, projectId);
  db.query("UPDATE tasks SET state = 'in_review' WHERE id = ?").run(noUrl);
  writeEvent(db, {
    task_id: noUrl,
    source: "director",
    type: "state_change",
    payload: { from: "in_progress", to: "in_review", reason: "picked up: some work" },
  });

  expect(backfillStuckPrUrls(db)).toBe(0);
  expect(getTask(db, linked).pr_url).toBe("https://github.com/corebeatcokr/monorepo/pull/1");
  expect(getTask(db, noUrl).pr_url).toBeNull();
});

test("backfillStuckPrUrls skips a PR belonging to a different repo, and leaves pr_url null when the reason names more than one PR", () => {
  const { db, projectId } = freshDb();
  setProjectRepo(db, projectId, "corebeatcokr/monorepo");

  const foreign = makeTask(db, projectId);
  db.query("UPDATE tasks SET state = 'in_review' WHERE id = ?").run(foreign);
  writeEvent(db, {
    task_id: foreign,
    source: "director",
    type: "state_change",
    payload: { from: "in_progress", to: "in_review", reason: "blocked on https://github.com/dvkm/hive-private/pull/42" },
  });

  const ambiguous = makeTask(db, projectId);
  db.query("UPDATE tasks SET state = 'in_review' WHERE id = ?").run(ambiguous);
  writeEvent(db, {
    task_id: ambiguous,
    source: "director",
    type: "state_change",
    payload: {
      from: "in_progress",
      to: "in_review",
      reason:
        "PR https://github.com/corebeatcokr/monorepo/pull/1024, same fix as https://github.com/corebeatcokr/monorepo/pull/999",
    },
  });

  expect(backfillStuckPrUrls(db)).toBe(0);
  expect(getTask(db, foreign).pr_url).toBeNull();
  expect(getTask(db, ambiguous).pr_url).toBeNull();
});

test("an invalid in_progress -> queued transition hints at /requeue", () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId);
  transition(db, id, "in_progress");
  expect(() => transition(db, id, "queued")).toThrow(new RegExp(`/api/tasks/${id}/requeue`));
});

test("done is rejected without evidence", () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId);
  transition(db, id, "in_progress");
  transition(db, id, "in_review");
  transition(db, id, "verifying");
  expect(() => transition(db, id, "done")).toThrow(/no evidence/);
});

test("done succeeds once evidence exists", () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId);
  transition(db, id, "in_progress");
  transition(db, id, "in_review");
  transition(db, id, "verifying");
  addEvidence(db, id);
  transition(db, id, "done");
  expect(getTask(db, id).state).toBe("done");
});

test("advanceIfFinished waits for queued-input recovery to settle", () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId);
  transition(db, id, "in_progress");
  db.query("UPDATE tasks SET pr_url = ? WHERE id = ?").run("https://gh/pr/1", id);
  addEvidence(db, id);
  const recovery = writeEvent(db, {
    task_id: id,
    source: "reconciler",
    type: "queued_input_recovered",
    payload: { delivered: null },
  });

  expect(advanceIfFinished(db, id, "idle", "herdr")).toBe(false);
  db.query("UPDATE events SET payload = ? WHERE id = ?").run(JSON.stringify({ delivered: true }), recovery.id);
  expect(advanceIfFinished(db, id, "idle", "reconciler")).toBe(false);

  db.query("UPDATE events SET ts = ? WHERE id = ?").run(new Date(Date.now() - 3 * 60 * 1000).toISOString(), recovery.id);
  expect(advanceIfFinished(db, id, "idle", "herdr")).toBe(true);
  expect(getTask(db, id).state).toBe("in_review");
});

test("advanceIfFinished does not promote a task whose linked PR is CLOSED (#1256)", () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId);
  transition(db, id, "in_progress");
  db.query("UPDATE tasks SET pr_url = ?, pr_state = 'CLOSED' WHERE id = ?").run("https://gh/pr/1", id);
  addEvidence(db, id);

  expect(advanceIfFinished(db, id, "idle", "herdr")).toBe(false);
  expect(getTask(db, id).state).toBe("in_progress");
});

test("a crash-orphaned delivered:null reservation ages out instead of blocking forever (#1234 review-14)", () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId);
  transition(db, id, "in_progress");
  db.query("UPDATE tasks SET pr_url = ? WHERE id = ?").run("https://gh/pr/1", id);
  addEvidence(db, id);
  const recovery = writeEvent(db, {
    task_id: id,
    source: "reconciler",
    type: "queued_input_recovered",
    payload: { delivered: null }, // server crashed between the reservation write and the pane I/O resolving it
  });

  expect(advanceIfFinished(db, id, "idle", "herdr")).toBe(false); // still within the grace window

  db.query("UPDATE events SET ts = ? WHERE id = ?").run(new Date(Date.now() - 3 * 60 * 1000).toISOString(), recovery.id);
  expect(advanceIfFinished(db, id, "idle", "herdr")).toBe(true); // the orphaned null no longer blocks forever
  expect(getTask(db, id).state).toBe("in_review");
});

test("advanceIfFinished stays blocked past the grace window while a queued_input_stuck alert is still open (#1234 review-13)", () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId);
  // Direct SQL, not transition() — a state_change event would get "now" as its
  // ts and, once the recovery/alert below are backdated under it, would look
  // like real activity AFTER the alert.
  db.query("UPDATE tasks SET state = 'in_progress', pr_url = ? WHERE id = ?").run("https://gh/pr/1", id);
  addEvidence(db, id);
  const old = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const recovery = writeEvent(db, { task_id: id, source: "reconciler", type: "queued_input_recovered", payload: { delivered: false } });
  db.query("UPDATE events SET ts = ? WHERE id = ?").run(old, recovery.id);
  const stuck = db.query("INSERT INTO notifications (id, ts, kind, task_id, title, urgency) VALUES (?,?,?,?,?,?)");
  stuck.run("ntf_stuck", old, "queued_input_stuck", id, "still stuck", "urgent");

  // Well past the flat grace window, but nothing real has happened since the
  // alert — the old design would have let this advance at t=4min regardless.
  expect(advanceIfFinished(db, id, "idle", "herdr")).toBe(false);

  writeEvent(db, { task_id: id, source: "agent", type: "progress" }); // real activity after the alert
  expect(advanceIfFinished(db, id, "idle", "herdr")).toBe(true);
  expect(getTask(db, id).state).toBe("in_review");
});

test("scout requires a report evidence for done", () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId, "scout");
  transition(db, id, "in_progress");
  transition(db, id, "in_review");
  transition(db, id, "verifying");
  addEvidence(db, id, "screenshot"); // not a report
  expect(() => transition(db, id, "done")).toThrow(/scout task requires a report/);
  addEvidence(db, id, "report");
  transition(db, id, "done");
  expect(getTask(db, id).state).toBe("done");
});

test("any non-terminal state can go to failed/cancelled; terminals cannot", () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId);
  expect(canTransition("queued", "failed")).toBe(true);
  expect(canTransition("in_progress", "cancelled")).toBe(true);
  expect(canTransition("done", "failed")).toBe(false);
  transition(db, id, "cancelled", { reason: "nope" });
  expect(getTask(db, id).state).toBe("cancelled");
});

test("force bypasses the FORWARD graph (HIVE-314: unmergeable PR, work landed elsewhere) but still requires evidence for done", () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId);
  transition(db, id, "in_progress");
  // Normal path refuses in_progress -> done outright.
  expect(canTransition("in_progress", "done")).toBe(false);
  expect(() => transition(db, id, "done")).toThrow(/invalid transition/);
  // force still enforces the done evidence gate.
  expect(() => transition(db, id, "done", { force: true })).toThrow(/no evidence/);
  addEvidence(db, id);
  const t = transition(db, id, "done", { source: "agent", reason: "unmergeable: landed via abc123", force: true });
  expect(t.state).toBe("done");
  const ev = db.query("SELECT payload FROM events WHERE task_id = ? AND type = 'state_change' ORDER BY ts DESC LIMIT 1").get(id) as { payload: string };
  expect(JSON.parse(ev.payload)).toMatchObject({ from: "in_progress", to: "done" });
});

test("force still refuses a task that is already terminal", () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId);
  transition(db, id, "cancelled");
  expect(() => transition(db, id, "done", { force: true })).toThrow(/already terminal/);
});

test("a failed task can be re-queued (attention tray), resetting its runtime binding", () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId);
  transition(db, id, "in_progress");
  // bind a runtime agent, then fail it
  db.query("UPDATE tasks SET agent_target = 'a1', worktree_path = '/wt', branch = 'hive/x' WHERE id = ?").run(id);
  transition(db, id, "failed", { reason: "agent vanished" });
  expect(canTransition("failed", "queued")).toBe(true);

  transition(db, id, "queued", { source: "director", reason: "requeued" });
  const t = getTask(db, id);
  expect(t.state).toBe("queued");
  // runtime binding cleared so the next spawn is clean
  expect(t.agent_target).toBeNull();
  expect(t.worktree_path).toBeNull();
  expect(t.branch).toBeNull();
  const ev = db.query("SELECT payload FROM events WHERE task_id = ? AND type = 'state_change' ORDER BY ts DESC LIMIT 1").get(id) as { payload: string };
  expect(JSON.parse(ev.payload)).toMatchObject({ from: "failed", to: "queued", reason: "requeued" });
});

test("needs_decision <-> in_progress round trip", () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId);
  transition(db, id, "in_progress");
  transition(db, id, "needs_decision");
  transition(db, id, "in_progress");
  expect(getTask(db, id).state).toBe("in_progress");
});

test("queued <-> needs_decision round trip (hive-1264 gap A: director parks a task born ambiguous)", () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId);
  expect(getTask(db, id).state).toBe("queued");
  transition(db, id, "needs_decision", { reason: "irreversible action needs a policy call" });
  expect(getTask(db, id).state).toBe("needs_decision");
  transition(db, id, "queued", { reason: "director resolved it" });
  expect(getTask(db, id).state).toBe("queued");
});

test("cancelling a task expires its open decisions + writes decision_expired events", () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId);
  const d1 = addDecision(db, id);
  const d2 = addDecision(db, id);
  transition(db, id, "cancelled", { reason: "abandon" });
  expect((db.query("SELECT status FROM decisions WHERE id = ?").get(d1) as any).status).toBe("expired");
  expect((db.query("SELECT status FROM decisions WHERE id = ?").get(d2) as any).status).toBe("expired");
  const evts = db.query("SELECT * FROM events WHERE task_id = ? AND type = 'decision_expired'").all(id);
  expect(evts.length).toBe(2);
});

test("cancelling a task with dependents opens one decision naming every affected task", () => {
  const { db, projectId } = freshDb();
  const dependency = makeTask(db, projectId);
  const first = makeTask(db, projectId);
  const second = makeTask(db, projectId);
  db.query("UPDATE tasks SET title = ?, depends_on = ? WHERE id = ?").run("first dependent", JSON.stringify([dependency]), first);
  db.query("UPDATE tasks SET title = ?, depends_on = ? WHERE id = ?").run("second dependent", JSON.stringify([dependency]), second);

  transition(db, dependency, "cancelled", { source: "director", reason: "no longer needed" });

  const decision = db.query("SELECT * FROM decisions WHERE status = 'open'").get() as any;
  expect(decision).toBeTruthy();
  expect(decision.context).toContain(first);
  expect(decision.context).toContain(second);
  expect(JSON.parse(decision.options).map((option: any) => option.key)).toEqual(["repoint", "cancel"]);
});

test("cancelling a task also surfaces an active dependent", () => {
  const { db, projectId } = freshDb();
  const dependency = makeTask(db, projectId);
  const dependent = makeTask(db, projectId);
  transition(db, dependent, "in_progress");
  db.query("UPDATE tasks SET depends_on = ? WHERE id = ?").run(JSON.stringify([dependency]), dependent);

  transition(db, dependency, "cancelled", { source: "director", reason: "no longer needed" });

  const decision = db.query("SELECT * FROM decisions WHERE status = 'open'").get() as any;
  expect(decision.context).toContain(dependent);
});

test("reaching done also expires open decisions; already-answered ones are untouched", () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId);
  const open = addDecision(db, id);
  const answered = addDecision(db, id, "answered");
  transition(db, id, "in_progress");
  transition(db, id, "in_review");
  transition(db, id, "verifying");
  addEvidence(db, id);
  transition(db, id, "done");
  expect((db.query("SELECT status FROM decisions WHERE id = ?").get(open) as any).status).toBe("expired");
  expect((db.query("SELECT status FROM decisions WHERE id = ?").get(answered) as any).status).toBe("answered");
});

test("expireOrphanedDecisions backfills open decisions whose task is already terminal (idempotent)", () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId);
  const d = addDecision(db, id);
  // Force the task terminal WITHOUT going through transition() (simulating a legacy row).
  db.query("UPDATE tasks SET state = 'cancelled' WHERE id = ?").run(id);
  expect(expireOrphanedDecisions(db)).toBe(1);
  expect((db.query("SELECT status FROM decisions WHERE id = ?").get(d) as any).status).toBe("expired");
  // Idempotent: a second pass finds nothing.
  expect(expireOrphanedDecisions(db)).toBe(0);
  // Direct helper is also idempotent on an already-expired card.
  expect(expireOpenDecisions(db, id, "again")).toBe(0);
});

test("defer/undefer parks a task in_progress and toggles isDeferred", () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId);
  transition(db, id, "in_progress");

  // indefinite defer (no until) sets a far-future sentinel -> isDeferred true, still in_progress
  deferTask(db, id, "9999-12-31T00:00:00.000Z", { source: "agent", note: "waiting on David's sudo" });
  expect(getTask(db, id).state).toBe("in_progress");
  expect(isDeferred(getTask(db, id))).toBe(true);
  expect(db.query("SELECT COUNT(*) n FROM events WHERE task_id = ? AND type = 'deferred'").get(id) as any).toEqual({ n: 1 });

  // a past deferred_until is NOT deferred (window elapsed)
  expect(isDeferred({ deferred_until: new Date(Date.now() - 1000).toISOString() })).toBe(false);
  expect(isDeferred({ deferred_until: null })).toBe(false);

  // undefer clears it
  undeferTask(db, id, { source: "director" });
  expect(getTask(db, id).deferred_until).toBeNull();
  expect(isDeferred(getTask(db, id))).toBe(false);
});

// hive-1952: a tracking-only task that reached in_review was trapped. `ready`
// is refused for it (there is no agent), and the forward graph refused
// in_review -> done while pointing back at `ready`. Its only exit was
// `cancelled`, which understates work that actually shipped.
test("a tracking-only task can close straight to done from in_review", () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId);
  db.query("UPDATE tasks SET source = 'external', state = 'in_review' WHERE id = ?").run(id);
  const t = transition(db, id, "done", { source: "director", reason: "shipped in PR #917" });
  expect(t.state).toBe("done");
  // No evidence was attached: the evidence gate is hive-owned work only.
  expect(db.query("SELECT COUNT(*) AS n FROM evidence WHERE task_id = ?").get(id)).toMatchObject({ n: 0 });
});

test("a jira mirror can close straight to done, but a hive-owned task still cannot", () => {
  const { db, projectId } = freshDb();
  const mirror = makeTask(db, projectId);
  db.query("UPDATE tasks SET source_ref = 'jira:WEB-7', state = 'in_progress' WHERE id = ?").run(mirror);
  expect(transition(db, mirror, "done").state).toBe("done");

  const owned = makeTask(db, projectId);
  transition(db, owned, "in_progress");
  expect(() => transition(db, owned, "done")).toThrow(/done is reached via review/);
});

test("a refused tracking-only transition names its own exits instead of `ready`", () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId);
  db.query("UPDATE tasks SET source = 'external', state = 'in_review' WHERE id = ?").run(id);
  // in_review -> queued is still invalid; the hint must not send a tracking-only
  // task to `ready` or `requeue`, which are both refused for it.
  expect(() => transition(db, id, "queued")).toThrow(/tracking-only/);
  try {
    transition(db, id, "queued");
  } catch (e) {
    expect(String(e)).not.toMatch(/ready --pr-url/);
    expect(String(e)).toMatch(/hive task move/);
  }
});
