import { test, expect } from "bun:test";
import { openDb, newId, now, type DB } from "../src/db.ts";
import { computeHealth, needsAttention } from "../src/health.ts";
import { getTask } from "../src/state.ts";

function freshDb(): { db: DB; projectId: string } {
  const db = openDb(":memory:");
  const projectId = newId("proj");
  db.query("INSERT INTO projects (id, name, config, created_at) VALUES (?,?,?,?)").run(projectId, "p", "{}", now());
  return { db, projectId };
}
function makeTask(db: DB, projectId: string, state = "in_progress", agent: string | null = "a1"): string {
  const id = newId();
  const t = now();
  db.query("INSERT INTO tasks (id, project_id, title, state, kind, agent_target, created_at, updated_at) VALUES (?,?,?,?, 'ship', ?, ?, ?)")
    .run(id, projectId, "t", state, agent, t, t);
  return id;
}
let seq = 0;
function putEvent(db: DB, taskId: string, type: string, payload: any = {}, agoMs = 0): void {
  const ts = new Date(Date.now() - agoMs + seq++).toISOString();
  db.query("INSERT INTO events (id, task_id, ts, source, type, payload) VALUES (?,?,?,?,?,?)")
    .run(newId("evt"), taskId, ts, "herdr", type, JSON.stringify(payload));
}
const STALE = 15 * 60 * 1000;

test("healthy: recent activity, agent alive", () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId);
  putEvent(db, id, "status", { note: "working" });
  const h = computeHealth(db, getTask(db, id));
  expect(h?.status).toBe("healthy");
});

test("silent: no activity past the stale threshold, no stale flag yet", () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId);
  putEvent(db, id, "status", { note: "working" }, 30 * 60 * 1000); // 30m old
  const h = computeHealth(db, getTask(db, id), Date.now());
  expect(h?.status).toBe("silent");
  expect(h?.reason).toBe("no activity");
});

test("stuck: herdr reports the agent blocked", () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId);
  putEvent(db, id, "status", { note: "working" });
  putEvent(db, id, "agent_status", { status: "blocked" });
  const h = computeHealth(db, getTask(db, id));
  expect(h?.status).toBe("stuck");
});

test("healthy: a successfully handled dialog clears the stale blocked probe", () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId);
  putEvent(db, id, "agent_status", { status: "blocked" });
  putEvent(db, id, "dialog_auto_approved", { delivered: true, kind: "workspace_trust" });
  const h = computeHealth(db, getTask(db, id));
  expect(h?.status).toBe("healthy");
});

test("stuck: a dialog that could not be handled does not clear the blocked probe", () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId);
  putEvent(db, id, "agent_status", { status: "blocked" });
  putEvent(db, id, "dialog_auto_approved", { delivered: false, kind: "workspace_trust" });
  const h = computeHealth(db, getTask(db, id));
  expect(h?.status).toBe("stuck");
});

test("stuck: stale-recovery escalation in progress", () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId);
  putEvent(db, id, "status", { note: "working" }, 30 * 60 * 1000);
  putEvent(db, id, "stale", { silent_ms: 999 });
  const h = computeHealth(db, getTask(db, id), Date.now());
  expect(h?.status).toBe("stuck");
});

test("dead: agent gone from herdr", () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId);
  putEvent(db, id, "agent_status", { status: "gone" });
  const h = computeHealth(db, getTask(db, id));
  expect(h?.status).toBe("dead");
  expect(h?.reason).toBe("agent gone from herdr");
});

test("stuck: agent finished (idle) with no PR and no recent activity -> visible in the tray", () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId); // in_progress, no pr_url
  putEvent(db, id, "status", { note: "did the work" }, 30 * 60 * 1000); // 30m old, no PR
  putEvent(db, id, "agent_status", { status: "idle" }, 30 * 60 * 1000);
  const h = computeHealth(db, getTask(db, id), Date.now());
  expect(h?.status).toBe("stuck");
  expect(needsAttention({ state: "in_progress", health: h })).toBe(true);
});

test("needsAttention: failed or unhealthy active tasks, excluding separate action queues", () => {
  expect(needsAttention({ state: "failed" })).toBe(true);
  expect(needsAttention({ state: "in_progress", health: { status: "dead", reason: null, since: "" } })).toBe(true);
  expect(needsAttention({ state: "in_progress", health: { status: "stuck", reason: null, since: "" } })).toBe(true);
  expect(needsAttention({ state: "in_review", health: { status: "dead", reason: null, since: "" } })).toBe(false);
  expect(needsAttention({ state: "needs_decision", health: { status: "stuck", reason: null, since: "" } })).toBe(false);
  // silent is surfaced on the card, but not urgent enough for the tray
  expect(needsAttention({ state: "in_progress", health: { status: "silent", reason: null, since: "" } })).toBe(false);
  expect(needsAttention({ state: "in_progress", health: { status: "healthy", reason: null, since: "" } })).toBe(false);
  expect(needsAttention({ state: "queued", health: null })).toBe(false);
  expect(needsAttention({ state: "done", health: null })).toBe(false);
});

test("stuck: recent merge_failed reason survives the bounce back to in_progress", () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId, "in_progress");
  putEvent(db, id, "merge_failed", { reason: "not an ancestor of 'main'", conflict: true });
  const h = computeHealth(db, getTask(db, id), Date.now());
  expect(h?.status).toBe("stuck");
  expect(h?.reason).toBe("merge failed: not an ancestor of 'main'");
});

test("stuck: recent merge_failed reason shows on a still-in_review task (non-conflict failure)", () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId, "in_review");
  putEvent(db, id, "merge_failed", { reason: "unable to write new index file", conflict: false });
  const h = computeHealth(db, getTask(db, id), Date.now());
  expect(h?.status).toBe("stuck");
  expect(h?.reason).toBe("merge failed: unable to write new index file");
});

test("healthy: merge_failed reason ages out past the stale window", () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId, "in_progress");
  putEvent(db, id, "merge_failed", { reason: "conflict" }, STALE + 1000);
  const h = computeHealth(db, getTask(db, id), Date.now());
  expect(h?.status).not.toBe("stuck");
});

test("healthy: a re-handoff after the conflict clears the merge_failed reason once a new commit landed", () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId, "in_review");
  putEvent(db, id, "pr_synchronized", { head_sha: "cafe111" }, 90_000);
  putEvent(db, id, "merge_failed", { reason: "conflict", conflict: true }, 60_000);
  putEvent(db, id, "pr_synchronized", { head_sha: "deadbee" }, 30_000);
  putEvent(db, id, "ready_for_review", { via: "idle" }, 0);
  const h = computeHealth(db, getTask(db, id), Date.now());
  expect(h?.status).toBe("healthy");
  expect(h?.reason).toBeNull();
});

// advanceIfFinished re-hands-off on the next probe tick once the agent is idle,
// and a conflict-bounced task keeps the pr_url and evidence its gates check —
// so an agent that never acted on the conflict must not clear the reason.
test("stuck: a bare idle re-handoff (no new commit) does NOT clear the merge_failed reason", () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId, "in_review");
  putEvent(db, id, "merge_failed", { reason: "conflict", conflict: true }, 60_000);
  putEvent(db, id, "ready_for_review", { via: "idle" }, 0);
  const h = computeHealth(db, getTask(db, id), Date.now());
  expect(h?.status).toBe("stuck");
  expect(h?.reason).toBe("merge failed: conflict");
});

// The reconciler's PR poll is blind to a merge conflict: the conflict is against
// the BASE branch, so the PR stays OPEN with its own checks green and the poll
// bounces the task back to review ~60s later with nothing rebased. That bare
// transition must not pass as "resolved" or the reason vanishes a tick after the
// failure — the exact #322 symptom.
test("stuck: a bare reconciler re-handoff (no new commit) does NOT clear the merge_failed reason", () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId, "in_review");
  putEvent(db, id, "merge_failed", { reason: "conflict", conflict: true }, 60_000);
  putEvent(db, id, "state_change", { from: "in_progress", to: "in_review", reason: "PR open, awaiting review" }, 0);
  const h = computeHealth(db, getTask(db, id), Date.now());
  expect(h?.status).toBe("stuck");
  expect(h?.reason).toBe("merge failed: conflict");
});

test("healthy: the reconciler's PR-poll re-handoff clears the reason once a new commit landed", () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId, "in_review");
  putEvent(db, id, "pr_synchronized", { head_sha: "cafe111" }, 90_000);
  putEvent(db, id, "merge_failed", { reason: "conflict", conflict: true }, 60_000);
  putEvent(db, id, "pr_synchronized", { head_sha: "deadbee" }, 30_000);
  putEvent(db, id, "state_change", { from: "in_progress", to: "in_review", reason: "PR open, awaiting review" }, 0);
  const h = computeHealth(db, getTask(db, id), Date.now());
  expect(h?.status).toBe("healthy");
  expect(h?.reason).toBeNull();
});

// The reconciler's first-ever look at a PR writes a pr_synchronized on an
// UNCHANGED head (reconciler.ts: lastSha is null, so headSha !== lastSha is
// trivially true). That baseline write is not evidence the agent rebased.
test("stuck: the reconciler's first-ever pr_synchronized is a baseline, not a new commit", () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId, "in_review");
  putEvent(db, id, "merge_failed", { reason: "conflict", conflict: true }, 60_000);
  putEvent(db, id, "pr_synchronized", { head_sha: "deadbee" }, 30_000);
  putEvent(db, id, "ready_for_review", { via: "idle" }, 0);
  const h = computeHealth(db, getTask(db, id), Date.now());
  expect(h?.status).toBe("stuck");
  expect(h?.reason).toBe("merge failed: conflict");
});

test("stuck: a pr_synchronized re-observing the SAME head is not a new commit", () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId, "in_review");
  putEvent(db, id, "pr_synchronized", { head_sha: "cafe111" }, 90_000);
  putEvent(db, id, "merge_failed", { reason: "conflict", conflict: true }, 60_000);
  putEvent(db, id, "pr_synchronized", { head_sha: "cafe111" }, 30_000);
  putEvent(db, id, "ready_for_review", { via: "idle" }, 0);
  const h = computeHealth(db, getTask(db, id), Date.now());
  expect(h?.status).toBe("stuck");
  expect(h?.reason).toBe("merge failed: conflict");
});

// A push that predates the failure is not evidence the failure was addressed.
test("stuck: a pr_synchronized OLDER than the merge_failed does not clear the reason", () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId, "in_review");
  putEvent(db, id, "pr_synchronized", { head_sha: "deadbee" }, 120_000);
  putEvent(db, id, "merge_failed", { reason: "conflict", conflict: true }, 60_000);
  putEvent(db, id, "state_change", { from: "in_progress", to: "in_review", reason: "PR open, awaiting review" }, 0);
  const h = computeHealth(db, getTask(db, id), Date.now());
  expect(h?.status).toBe("stuck");
  expect(h?.reason).toBe("merge failed: conflict");
});

test("healthy: a later pr_merged hides the old merge_failed reason", () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId, "in_progress");
  putEvent(db, id, "merge_failed", { reason: "conflict" }, 60_000);
  putEvent(db, id, "pr_merged", { pr_url: "https://example.test/pr/1" }, 0);
  const h = computeHealth(db, getTask(db, id), Date.now());
  expect(h?.status).toBe("healthy");
});

test("healthy: a later successful merge hides the old merge_failed reason", () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId, "in_progress");
  putEvent(db, id, "merge_failed", { reason: "conflict" }, 60_000);
  putEvent(db, id, "merged", {}, 0);
  const h = computeHealth(db, getTask(db, id), Date.now());
  expect(h?.status).toBe("healthy");
});

test("null health for queued and terminal tasks, and for agentless tasks", () => {
  const { db, projectId } = freshDb();
  expect(computeHealth(db, getTask(db, makeTask(db, projectId, "queued")))).toBeNull();
  expect(computeHealth(db, getTask(db, makeTask(db, projectId, "done")))).toBeNull();
  expect(computeHealth(db, getTask(db, makeTask(db, projectId, "in_progress", null)))).toBeNull();
});

test("needs_decision / in_review are waiting on the director — never silent/stuck by age", () => {
  const { db, projectId } = freshDb();
  for (const state of ["needs_decision", "in_review"]) {
    const id = makeTask(db, projectId, state);
    putEvent(db, id, "status", { note: "handed off" }, 3 * 60 * 60 * 1000); // 3h silent
    putEvent(db, id, "stale", {}, 60 * 60 * 1000);
    const h = computeHealth(db, getTask(db, id), Date.now());
    expect(h?.status).toBe("healthy");
  }
  // but a dead agent still shows dead even while parked
  const id = makeTask(db, projectId, "in_review");
  putEvent(db, id, "agent_status", { status: "gone" });
  expect(computeHealth(db, getTask(db, id), Date.now())?.status).toBe("dead");
});
