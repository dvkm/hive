import { test, expect } from "bun:test";
import { openDb, newId, now, type DB } from "../src/db.ts";
import { landGraph, landOnce, markLand } from "../src/landQueue.ts";
import { transition, writeEvent } from "../src/state.ts";
import { apiAnswerDecision } from "../src/api.ts";
import { queueSteerEvent, queuedSteers, markSteersDelivered, resumeReviewForDeliveredSteers } from "../src/steer.ts";
import type { Herdr } from "../src/runtime/herdr.ts";
import type { Exec, ExecResult } from "../src/exec.ts";

const OK = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });

const stubHerdr = { send: async () => ({ ok: true }) } as unknown as Herdr;

// Backdate this task's land attempts so the next sweep is past its backoff
// window. Cheaper and more honest than injecting a clock: the backoff is read
// from the events themselves.
function ageLandAttempts(db: DB, taskId: string, byMs: number): void {
  const rows = db.query("SELECT id, ts FROM events WHERE task_id = ? AND type = 'land_attempted'").all(taskId) as any[];
  for (const r of rows)
    db.query("UPDATE events SET ts = ? WHERE id = ?").run(new Date(Date.parse(r.ts) - byMs).toISOString(), r.id);
}

function freshDb(): { db: DB; projectId: string } {
  const db = openDb(":memory:");
  const projectId = newId("proj");
  db.query("INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)").run(
    projectId, "p", "/repo", JSON.stringify({ default_branch: "main" }), now()
  );
  return { db, projectId };
}

function makeTask(
  db: DB,
  projectId: string,
  extra: { title?: string; branch?: string; state?: string; ci_status?: string; brief?: string; depends_on?: string[] } = {}
): string {
  const id = newId();
  const t = now();
  db.query(
    `INSERT INTO tasks (id, project_id, title, brief, state, kind, branch, ci_status, depends_on, created_at, updated_at)
     VALUES (?,?,?,?,?,'ship',?,?,?,?,?)`
  ).run(
    id, projectId, extra.title ?? "t", extra.brief ?? "", extra.state ?? "in_review", extra.branch ?? null,
    extra.ci_status ?? "passing", extra.depends_on ? JSON.stringify(extra.depends_on) : null, t, t
  );
  return id;
}

// `git diff --name-only main...<branch>` per branch — the only git the graph reads.
const filesExec = (byBranch: Record<string, string[]>): Exec => async (argv) => {
  const spec = argv[argv.length - 1];
  const branch = String(spec).split("...")[1] ?? "";
  return OK((byBranch[branch] ?? []).join("\n"));
};

// A merge stub that lands the task the way mergeTask would (in_review →
// verifying), so the sweep sees the state change. `red` never merges.
function mergeStub(db: DB, failing: Record<string, string> = {}) {
  const calls: string[] = [];
  const merge = async (id: string) => {
    calls.push(id);
    if (failing[id]) return { ok: false, reason: failing[id] };
    transition(db, id, "verifying", { source: "director", reason: "test merge" });
    return { ok: true };
  };
  return { calls, merge };
}

test("conflict edges come from overlapping files; independent branches get none", async () => {
  const { db, projectId } = freshDb();
  const a = makeTask(db, projectId, { branch: "a" });
  const b = makeTask(db, projectId, { branch: "b" });
  const c = makeTask(db, projectId, { branch: "c" });
  const exec = filesExec({ a: ["src/a.ts"], b: ["src/shared.ts"], c: ["src/shared.ts", "src/c.ts"] });

  const { edges } = await landGraph(db, projectId, exec);
  expect(edges).toEqual([{ from: b, to: c, kind: "conflict", files: ["src/shared.ts"] }]);
  expect(edges.some((e) => e.from === a || e.to === a)).toBe(false);
});

test("declared and brief-written dependencies both become 'depends' edges", async () => {
  const { db, projectId } = freshDb();
  const a = makeTask(db, projectId, { branch: "a" });
  const aNumber = (db.query("SELECT number FROM tasks WHERE id = ?").get(a) as any).number;
  const b = makeTask(db, projectId, { branch: "b", depends_on: [a] });
  const c = makeTask(db, projectId, { branch: "c", brief: `Do the thing. Lands after #${aNumber}.` });
  const { edges } = await landGraph(db, projectId, filesExec({}));
  expect(edges).toEqual([
    { from: a, to: b, kind: "depends" },
    { from: a, to: c, kind: "depends" },
  ]);
});

// The brief's regression test: A is independent, B and C both touch a file A
// does not. A and the first of B/C land in this sweep; the second waits a sweep.
// HIVE-348 tightened the "land together" half: they land in the same sweep, but
// one merge at a time, because two merges racing on one base is what once ate a
// commit.
test("independent PRs land in one sweep, one at a time; conflicting ones wait", async () => {
  const { db, projectId } = freshDb();
  const a = makeTask(db, projectId, { branch: "a" });
  const b = makeTask(db, projectId, { branch: "b" });
  const c = makeTask(db, projectId, { branch: "c" });
  const exec = filesExec({ a: ["src/a.ts"], b: ["src/shared.ts"], c: ["src/shared.ts"] });
  markLand(db, [a, b, c], true);

  const calls: string[] = [];
  let inFlight = 0;
  let peak = 0;
  await landOnce(db, {
    exec,
    merge: async (id) => {
      calls.push(id);
      inFlight++;
      peak = Math.max(peak, inFlight);
      await Bun.sleep(1);
      inFlight--;
      transition(db, id, "verifying", { source: "director", reason: "test merge" });
      return { ok: true };
    },
  });
  expect(calls).toEqual([a, b]); // C conflicts with B, so it sits out this sweep
  expect(peak).toBe(1); // never two merges in flight at once

  // Next sweep: B has merged, so C is unblocked and lands on its own.
  const second = mergeStub(db);
  await landOnce(db, { exec, merge: second.merge });
  expect(second.calls).toEqual([c]);
  expect((db.query("SELECT land_queued_at FROM tasks WHERE id = ?").get(c) as any).land_queued_at).toBeNull();
});

test("a red CI on one PR never blocks the PR that conflicts with it", async () => {
  const { db, projectId } = freshDb();
  const a = makeTask(db, projectId, { branch: "a" });
  const b = makeTask(db, projectId, { branch: "b", ci_status: "failing" });
  const c = makeTask(db, projectId, { branch: "c" });
  const exec = filesExec({ a: ["src/a.ts"], b: ["src/shared.ts"], c: ["src/shared.ts"] });
  markLand(db, [a, b, c], true);

  const { calls, merge } = mergeStub(db);
  await landOnce(db, { exec, merge });
  expect(calls).toEqual([a, c]); // B held on red CI, C lands in its place
  // B keeps its mark: red CI is a hold, not a drop.
  expect((db.query("SELECT land_queued_at FROM tasks WHERE id = ?").get(b) as any).land_queued_at).toBeTruthy();
});

test("a declared dependency lands first, and holds its dependent until it has merged", async () => {
  const { db, projectId } = freshDb();
  const a = makeTask(db, projectId, { branch: "a", ci_status: "pending" });
  const b = makeTask(db, projectId, { branch: "b", depends_on: [a] });
  markLand(db, [a, b], true);
  const held = mergeStub(db);
  await landOnce(db, { exec: filesExec({}), merge: held.merge });
  expect(held.calls).toEqual([]); // A is not green yet, so B waits too

  db.query("UPDATE tasks SET ci_status = 'passing' WHERE id = ?").run(a);
  const go = mergeStub(db);
  await landOnce(db, { exec: filesExec({}), merge: go.merge });
  expect(go.calls).toEqual([a, b]);
});

test("a non-transient failure opens exactly one card and keeps the sticky mark", async () => {
  const { db, projectId } = freshDb();
  const a = makeTask(db, projectId, { branch: "a" });
  const b = makeTask(db, projectId, { branch: "b" });
  markLand(db, [a, b], true);
  const { calls, merge } = mergeStub(db, { [a]: "CI is red", [b]: "CI blocked" });
  await landOnce(db, { exec: filesExec({}), merge });
  expect(calls).toEqual([a, b]);
  // The approval survives the failure: no re-marking to land it later.
  for (const id of [a, b])
    expect((db.query("SELECT land_queued_at FROM tasks WHERE id = ?").get(id) as any).land_queued_at).toBeTruthy();
  // One card per task, not one card listing both.
  const open = db.query("SELECT task_id, title FROM decisions WHERE status = 'open' ORDER BY ts").all() as any[];
  expect(open.map((d) => d.task_id).sort()).toEqual([a, b].sort());

  // A second sweep must not stack a duplicate card, and must not re-attempt
  // while the director still owes an answer.
  const again = mergeStub(db, { [a]: "CI is red", [b]: "CI blocked" });
  await landOnce(db, { exec: filesExec({}), merge: again.merge });
  expect(again.calls).toEqual([]);
  expect((db.query("SELECT COUNT(*) AS n FROM decisions WHERE status = 'open'").get() as any).n).toBe(2);
});

test("a transient failure opens no card and retries after the backoff", async () => {
  const { db, projectId } = freshDb();
  const a = makeTask(db, projectId, { branch: "a" });
  markLand(db, [a], true);

  const first = mergeStub(db, { [a]: "Base branch was modified. Review and try the merge again." });
  await landOnce(db, { exec: filesExec({}), merge: first.merge });
  expect(first.calls).toEqual([a]);
  expect((db.query("SELECT COUNT(*) AS n FROM decisions").get() as any).n).toBe(0);
  expect((db.query("SELECT land_queued_at FROM tasks WHERE id = ?").get(a) as any).land_queued_at).toBeTruthy();

  // Immediately after, the task is inside its backoff window: no second attempt.
  const tooSoon = mergeStub(db);
  await landOnce(db, { exec: filesExec({}), merge: tooSoon.merge });
  expect(tooSoon.calls).toEqual([]);

  // Age the attempt past the first backoff step; the retry lands with no
  // re-marking and no card in between.
  ageLandAttempts(db, a, 60_000);
  const retry = mergeStub(db);
  await landOnce(db, { exec: filesExec({}), merge: retry.merge });
  expect(retry.calls).toEqual([a]);
  expect((db.query("SELECT COUNT(*) AS n FROM decisions").get() as any).n).toBe(0);
  expect((db.query("SELECT state, land_queued_at FROM tasks WHERE id = ?").get(a) as any).state).toBe("verifying");
});

test("a transient cause that never clears becomes a card once the retries run out", async () => {
  const { db, projectId } = freshDb();
  const a = makeTask(db, projectId, { branch: "a" });
  markLand(db, [a], true);
  const reason = "Base branch was modified.";
  for (let i = 0; i < 6; i++) {
    const { merge } = mergeStub(db, { [a]: reason });
    await landOnce(db, { exec: filesExec({}), merge });
    ageLandAttempts(db, a, 3_600_000);
  }
  expect((db.query("SELECT COUNT(*) AS n FROM decisions WHERE status = 'open'").get() as any).n).toBe(1);
});

test("the mark is sticky across a rebase round-trip through in_progress", async () => {
  const { db, projectId } = freshDb();
  const a = makeTask(db, projectId, { branch: "a" });
  markLand(db, [a], true);

  // A conflict bounces the task to its agent, the way mergeTask does.
  const bounce = mergeStub(db, { [a]: "PR has merge conflicts" });
  await landOnce(db, {
    exec: filesExec({}),
    merge: async (id) => {
      const r = await bounce.merge(id);
      transition(db, id, "in_progress", { source: "director", reason: "merge conflict" });
      return r;
    },
  });
  // Hive already routed the fix to the agent, so no card asks the director.
  expect((db.query("SELECT COUNT(*) AS n FROM decisions").get() as any).n).toBe(0);
  expect((db.query("SELECT land_queued_at FROM tasks WHERE id = ?").get(a) as any).land_queued_at).toBeTruthy();

  // Agent rebases and hands back. The mark is still there: it lands untouched.
  transition(db, a, "in_review", { source: "agent", reason: "rebased" });
  ageLandAttempts(db, a, 3_600_000);
  const { calls, merge } = mergeStub(db);
  await landOnce(db, { exec: filesExec({}), merge });
  expect(calls).toEqual([a]);
  expect((db.query("SELECT land_queued_at FROM tasks WHERE id = ?").get(a) as any).land_queued_at).toBeNull();
});

test("a pending understanding check holds the queue instead of opening a card", async () => {
  const { db, projectId } = freshDb();
  const a = makeTask(db, projectId, { branch: "a" });
  markLand(db, [a], true);
  const quizPending = "Pass the understanding check before merging, or choose 'Continue now, quiz me later'.";

  for (let i = 0; i < 3; i++) {
    const { merge } = mergeStub(db, { [a]: quizPending });
    await landOnce(db, { exec: filesExec({}), merge });
  }
  // No card, no retry budget burned, no timeline noise, and the mark stands.
  expect((db.query("SELECT COUNT(*) AS n FROM decisions").get() as any).n).toBe(0);
  expect((db.query("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = 'land_attempted'").get(a) as any).n).toBe(0);
  expect((db.query("SELECT land_queued_at FROM tasks WHERE id = ?").get(a) as any).land_queued_at).toBeTruthy();

  // The director answers the new quiz; the very next sweep lands it.
  const { calls, merge } = mergeStub(db);
  await landOnce(db, { exec: filesExec({}), merge });
  expect(calls).toEqual([a]);
});

test("a quiz passed after the land mark holds the merge until the director taps Land now (HIVE-421)", async () => {
  const { db, projectId } = freshDb();
  const a = makeTask(db, projectId, { branch: "a" });
  markLand(db, [a], true);
  // The director marks it approved to land, and only THEN takes the check.
  const review = writeEvent(db, { task_id: a, source: "agent", type: "review_summary", payload: { done: ["x"] } });
  writeEvent(db, {
    task_id: a,
    source: "director",
    type: "understanding_quiz_passed",
    payload: { review_event_id: review.id, answer_key: "safe" },
  });

  const held = mergeStub(db);
  await landOnce(db, { exec: filesExec({}), merge: held.merge });
  expect(held.calls).toEqual([]); // no merge, no card, mark still standing
  expect((db.query("SELECT COUNT(*) AS n FROM decisions").get() as any).n).toBe(0);
  expect((db.query("SELECT land_queued_at FROM tasks WHERE id = ?").get(a) as any).land_queued_at).toBeTruthy();

  // "Land now" is the same mark call, so the approval now postdates the quiz.
  markLand(db, [a], true);
  const tapped = mergeStub(db);
  await landOnce(db, { exec: filesExec({}), merge: tapped.merge });
  expect(tapped.calls).toEqual([a]);
});

test("unmarking a quiz-held task takes it out of the queue for good", async () => {
  const { db, projectId } = freshDb();
  const a = makeTask(db, projectId, { branch: "a" });
  markLand(db, [a], true);
  const review = writeEvent(db, { task_id: a, source: "agent", type: "review_summary", payload: { done: ["x"] } });
  writeEvent(db, { task_id: a, source: "director", type: "understanding_quiz_passed", payload: { review_event_id: review.id } });
  markLand(db, [a], false);

  const { calls, merge } = mergeStub(db);
  await landOnce(db, { exec: filesExec({}), merge });
  expect(calls).toEqual([]);
  expect((db.query("SELECT land_queued_at FROM tasks WHERE id = ?").get(a) as any).land_queued_at).toBeNull();
});

test("answering the pause card administratively never bounces the agent", async () => {
  const { db, projectId } = freshDb();
  const a = makeTask(db, projectId, { branch: "a" });
  markLand(db, [a], true);
  const { merge } = mergeStub(db, { [a]: "CI is red" });
  await landOnce(db, { exec: filesExec({}), merge });
  const card = db.query("SELECT id FROM decisions WHERE task_id = ? AND status = 'open'").get(a) as any;
  expect(card).toBeTruthy();

  const res = apiAnswerDecision(db, stubHerdr, card.id, { answer_key: "retry", source: "director" });
  expect(res.status).toBe(200);
  // The PR is finished work. It must stay in review with its mark intact, and
  // nothing may be queued that would land as a changes_requested.
  const task = db.query("SELECT state, land_queued_at FROM tasks WHERE id = ?").get(a) as any;
  expect(task.state).toBe("in_review");
  expect(task.land_queued_at).toBeTruthy();
  expect((db.query("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = 'steer'").get(a) as any).n).toBe(0);
  expect((db.query("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = 'changes_requested'").get(a) as any).n).toBe(0);

  // With the card answered, the next sweep re-attempts with no re-marking.
  const retry = mergeStub(db);
  await landOnce(db, { exec: filesExec({}), merge: retry.merge });
  expect(retry.calls).toEqual([a]);
});

test("only the send-back answer steers the agent, and it clears the mark", async () => {
  const { db, projectId } = freshDb();
  const a = makeTask(db, projectId, { branch: "a" });
  markLand(db, [a], true);
  const { merge } = mergeStub(db, { [a]: "CI is red" });
  await landOnce(db, { exec: filesExec({}), merge });
  const card = db.query("SELECT id FROM decisions WHERE task_id = ? AND status = 'open'").get(a) as any;

  expect(apiAnswerDecision(db, stubHerdr, card.id, { answer_key: "send_back", source: "director" }).status).toBe(200);
  expect((db.query("SELECT land_queued_at FROM tasks WHERE id = ?").get(a) as any).land_queued_at).toBeNull();
  const steer = db.query("SELECT payload FROM events WHERE task_id = ? AND type = 'steer'").get(a) as any;
  expect(JSON.parse(steer.payload).message).toContain("sent this PR back from the land queue");
});

test("a stale pause card closes itself once the PR leaves the queue", async () => {
  const { db, projectId } = freshDb();
  const a = makeTask(db, projectId, { branch: "a" });
  markLand(db, [a], true);
  const { merge } = mergeStub(db, { [a]: "CI is red" });
  await landOnce(db, { exec: filesExec({}), merge });
  expect((db.query("SELECT COUNT(*) AS n FROM decisions WHERE status = 'open'").get() as any).n).toBe(1);

  markLand(db, [a], false); // director unmarks it
  await landOnce(db, { exec: filesExec({}), merge: mergeStub(db).merge });
  expect((db.query("SELECT COUNT(*) AS n FROM decisions WHERE status = 'open'").get() as any).n).toBe(0);
});

test("a queued corrective steer holds the retry; delivery + a new head resumes it (HIVE-444)", async () => {
  const { db, projectId } = freshDb();
  const a = makeTask(db, projectId, { branch: "a" });
  markLand(db, [a], true);
  writeEvent(db, { task_id: a, source: "reconciler", type: "pr_synchronized", payload: { head_sha: "broken-sha" } });
  queueSteerEvent(db, a, "REQUESTS-CHANGES: migration table is mangled", "test steer");

  // The steer sits undelivered (agent between turns): no attempt against the
  // known-broken branch, and the hold is logged.
  const held = mergeStub(db);
  await landOnce(db, { exec: filesExec({}), merge: held.merge });
  expect(held.calls).toEqual([]);
  const heldEvent = db.query("SELECT payload FROM events WHERE task_id = ? AND type = 'land_retry_held'").get(a) as any;
  expect(JSON.parse(heldEvent.payload).reason).toBe("pending steer");

  // Steer delivers, the agent pushes a fix, and the task comes back to review —
  // but still on the same head that was known broken: still held.
  const steers = queuedSteers(db, a);
  markSteersDelivered(db, steers.map((s) => s.id), "drain");
  resumeReviewForDeliveredSteers(db, a, steers, "drain");
  transition(db, a, "in_review", { source: "agent", reason: "fixed the migration" });
  const stillHeld = mergeStub(db);
  await landOnce(db, { exec: filesExec({}), merge: stillHeld.merge });
  expect(stillHeld.calls).toEqual([]);

  // A new head_sha lands: the retry resumes. Bumped a tick later since the
  // changes_requested/pr_synchronized pair can otherwise land in the same ms.
  const sync = writeEvent(db, { task_id: a, source: "reconciler", type: "pr_synchronized", payload: { head_sha: "fixed-sha" } });
  db.query("UPDATE events SET ts = ? WHERE id = ?").run(new Date(Date.parse(sync.ts) + 1000).toISOString(), sync.id);
  const resumed = mergeStub(db);
  await landOnce(db, { exec: filesExec({}), merge: resumed.merge });
  expect(resumed.calls).toEqual([a]);
});

test("a held retry logs land_retry_held once per episode, not once per sweep", async () => {
  const { db, projectId } = freshDb();
  const a = makeTask(db, projectId, { branch: "a" });
  markLand(db, [a], true);
  queueSteerEvent(db, a, "REQUESTS-CHANGES: still mangled", "test steer");

  // Same undelivered steer, three sweeps in a row: only the first sweep should
  // write the hold event (HIVE-444 follow-up — an agent slow between turns must
  // not write this event every 30s indefinitely).
  for (let i = 0; i < 3; i++) await landOnce(db, { exec: filesExec({}), merge: mergeStub(db).merge });
  const held = db.query("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = 'land_retry_held'").get(a) as any;
  expect(held.n).toBe(1);
});

test("unmarking drops the retry even mid-backoff — zero attempts after (HIVE-444 addendum)", async () => {
  const { db, projectId } = freshDb();
  const a = makeTask(db, projectId, { branch: "a" });
  markLand(db, [a], true);

  const first = mergeStub(db, { [a]: "Base branch was modified. Review and try the merge again." });
  await landOnce(db, { exec: filesExec({}), merge: first.merge });
  expect(first.calls).toEqual([a]);

  markLand(db, [a], false); // director unqueues it while it's still backing off
  ageLandAttempts(db, a, 3_600_000); // well past any backoff window
  const after = mergeStub(db);
  await landOnce(db, { exec: filesExec({}), merge: after.merge });
  expect(after.calls).toEqual([]);
});

// HIVE-539: a failure that BOUNCES the task out of review opens no pause card,
// and the mark is sticky, so the same doomed merge was re-attempted every sweep
// for ever (b5f437266360 tried it 52 times). Attempts are capped now.
test("repeated failures that never open a card take the task out of the queue", async () => {
  const { db, projectId } = freshDb();
  const a = makeTask(db, projectId, { branch: "a" });
  markLand(db, [a], true);
  const reason = "merge blocked — branch 'hive/a' reverts base work outside this task's scope";
  const calls: string[] = [];
  const bounceThenReturn = async (id: string) => {
    calls.push(id);
    // What the destructive-rebase guard does: send it back to the agent, who
    // pushes and lands back in review before the next sweep.
    transition(db, id, "in_progress", { source: "director", reason: "merge blocked" });
    return { ok: false, reason };
  };
  for (let i = 0; i < 15; i++) {
    await landOnce(db, { exec: filesExec({}), merge: bounceThenReturn });
    // The agent pushes again and hands off, so the sticky mark puts it straight
    // back in the queue — that is the loop.
    if ((db.query("SELECT state FROM tasks WHERE id = ?").get(a) as any).state !== "in_review")
      transition(db, a, "in_review", { source: "agent", reason: "pushed again" });
    // Each push is a new commit, which re-arms the queue (HIVE-555). The
    // attempt ceiling is what stops this loop.
    db.query("UPDATE tasks SET head_sha = ? WHERE id = ?").run(`sha${i}`, a);
    ageLandAttempts(db, a, 3_600_000);
  }
  expect(calls).toHaveLength(10); // MAX_LAND_ATTEMPTS
  expect((db.query("SELECT land_queued_at FROM tasks WHERE id = ?").get(a) as any).land_queued_at).toBeNull();
  expect((db.query("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = 'land_retry_exhausted'").get(a) as any).n).toBe(1);
  expect((db.query("SELECT COUNT(*) AS n FROM notifications WHERE task_id = ? AND kind = 'stale'").get(a) as any).n).toBe(1);
});

// The queue must read "the risk check timed out" as something to retry, not as
// a director question — nothing was confirmed.
test("an unfinished risk check retries on the backoff instead of opening a card", async () => {
  const { db, projectId } = freshDb();
  const a = makeTask(db, projectId, { branch: "a" });
  markLand(db, [a], true);
  const reason = "merge blocked — the risk check did not finish on this head: 2 of 4 findings got no verdict (timed out after 180000ms). Nothing was confirmed.";
  const { merge, calls } = mergeStub(db, { [a]: reason });
  await landOnce(db, { exec: filesExec({}), merge });
  expect(calls).toEqual([a]);
  expect((db.query("SELECT COUNT(*) AS n FROM decisions").get() as any).n).toBe(0);
  const attempt: any = db.query("SELECT payload FROM events WHERE task_id = ? AND type = 'land_attempted'").get(a);
  expect(JSON.parse(attempt.payload).transient).toBe(true);
});

// HIVE-555: a permanent blocker gave the same answer every 30s sweep forever.
// One PR alone produced 52 of 116 land failures on one machine.
test("a non-transient failure retries once, then holds instead of re-failing forever", async () => {
  const { db, projectId } = freshDb();
  const a = makeTask(db, projectId, { branch: "a" });
  db.query("UPDATE tasks SET head_sha = 'sha1' WHERE id = ?").run(a);
  markLand(db, [a], true);
  const reason = "the branch drops work that is already on main";

  // First attempt: fails, opens the pause card.
  const first = mergeStub(db, { [a]: reason });
  await landOnce(db, { exec: filesExec({}), merge: first.merge });
  expect(first.calls).toEqual([a]);
  const card = db.query("SELECT id FROM decisions WHERE status = 'open'").get() as any;
  expect(card).toBeTruthy();

  // The director answers "retry". That buys exactly one more attempt.
  apiAnswerDecision(db, stubHerdr, card.id, { answer_key: "retry" });
  const second = mergeStub(db, { [a]: reason });
  await landOnce(db, { exec: filesExec({}), merge: second.merge });
  expect(second.calls).toEqual([a]);

  // From here every sweep is a no-op: no merge, no new card, no event spam.
  for (let i = 0; i < 5; i++) {
    const later = mergeStub(db, { [a]: reason });
    await landOnce(db, { exec: filesExec({}), merge: later.merge });
    expect(later.calls).toEqual([]);
  }
  expect((db.query("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = 'land_attempted'").get(a) as any).n).toBe(2);
  expect((db.query("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = 'land_blocked'").get(a) as any).n).toBe(1);
  // Still queued, just paused: the approval did not evaporate.
  expect((db.query("SELECT land_queued_at FROM tasks WHERE id = ?").get(a) as any).land_queued_at).toBeTruthy();

  // A new head_sha re-arms it: the agent pushed, so the verdict may differ.
  db.query("UPDATE tasks SET head_sha = 'sha2' WHERE id = ?").run(a);
  const rearmed = mergeStub(db);
  await landOnce(db, { exec: filesExec({}), merge: rearmed.merge });
  expect(rearmed.calls).toEqual([a]);
  expect((db.query("SELECT state FROM tasks WHERE id = ?").get(a) as any).state).toBe("verifying");
});

test("a new head_sha closes the stale land-queue pause card", async () => {
  const { db, projectId } = freshDb();
  const a = makeTask(db, projectId, { branch: "a" });
  db.query("UPDATE tasks SET head_sha = 'sha1' WHERE id = ?").run(a);
  markLand(db, [a], true);

  const { merge } = mergeStub(db, { [a]: "the branch drops work that is already on main" });
  await landOnce(db, { exec: filesExec({}), merge });
  expect((db.query("SELECT COUNT(*) AS n FROM decisions WHERE status = 'open'").get() as any).n).toBe(1);

  db.query("UPDATE tasks SET head_sha = 'sha2' WHERE id = ?").run(a);
  const next = mergeStub(db);
  await landOnce(db, { exec: filesExec({}), merge: next.merge });
  expect((db.query("SELECT COUNT(*) AS n FROM decisions WHERE status = 'open'").get() as any).n).toBe(0);

  // Closing the card queues its "nothing to reply to" note, which holds one
  // sweep. Once that drains, the new commit gets its attempt.
  const steers = queuedSteers(db, a);
  markSteersDelivered(db, steers.map((s) => s.id), "drain");
  const after = mergeStub(db);
  await landOnce(db, { exec: filesExec({}), merge: after.merge });
  expect(after.calls).toEqual([a]);
});

// HIVE-559: a CONFIRMED risk is agent work. Hive relays the finding to the agent
// that wrote the code and only asks the director when the agent argues back or
// the same risk survives the relay.
const RISK_REASON =
  'merge blocked — the risk check confirmed 1 risk on this head: “export drops rows” — the CSV writer skips the last page (evidence/export.md). Fix them, or merge with override_confirmed_risks=true.';

test("a confirmed risk goes to the agent as a steer, opens no card, and holds the land", async () => {
  const { db, projectId } = freshDb();
  const a = makeTask(db, projectId, { branch: "a" });
  db.query("UPDATE tasks SET head_sha = 'sha1' WHERE id = ?").run(a);
  markLand(db, [a], true);

  const { calls, merge } = mergeStub(db, { [a]: RISK_REASON });
  await landOnce(db, { exec: filesExec({}), merge });
  expect(calls).toEqual([a]);
  // No director card: the agent hears about it first.
  expect((db.query("SELECT COUNT(*) AS n FROM decisions").get() as any).n).toBe(0);
  // The finding reaches the agent verbatim, evidence path included.
  const steers = queuedSteers(db, a);
  expect(steers).toHaveLength(1);
  expect(steers[0].message).toContain(RISK_REASON);
  expect(steers[0].message).toContain("evidence/export.md");
  // Audited as a machine relay, not a director ruling.
  const routed = db.query("SELECT payload FROM events WHERE task_id = ? AND type = 'risk_routed_to_agent'").all(a) as any[];
  expect(routed).toHaveLength(1);
  expect(JSON.parse(routed[0].payload).head_sha).toBe("sha1");
  // The land is held, and still approved: no merge, no unmark.
  expect((db.query("SELECT state, land_queued_at FROM tasks WHERE id = ?").get(a) as any).state).toBe("in_review");
  expect((db.query("SELECT land_queued_at FROM tasks WHERE id = ?").get(a) as any).land_queued_at).toBeTruthy();

  // A new head re-arms the merge with no card in between.
  markSteersDelivered(db, steers.map((s) => s.id), "drain");
  db.query("UPDATE tasks SET head_sha = 'sha2' WHERE id = ?").run(a);
  ageLandAttempts(db, a, 3_600_000);
  const after = mergeStub(db);
  await landOnce(db, { exec: filesExec({}), merge: after.merge });
  expect(after.calls).toEqual([a]);
  expect((db.query("SELECT COUNT(*) AS n FROM decisions").get() as any).n).toBe(0);
  expect((db.query("SELECT state FROM tasks WHERE id = ?").get(a) as any).state).toBe("verifying");
});

test("an agent that disputes a confirmed risk gets a card carrying the argument", async () => {
  const { db, projectId } = freshDb();
  const a = makeTask(db, projectId, { branch: "a" });
  db.query("UPDATE tasks SET head_sha = 'sha1' WHERE id = ?").run(a);
  markLand(db, [a], true);

  const first = mergeStub(db, { [a]: RISK_REASON });
  await landOnce(db, { exec: filesExec({}), merge: first.merge });
  expect((db.query("SELECT COUNT(*) AS n FROM decisions").get() as any).n).toBe(0);

  // The agent reads it and argues the finding is wrong instead of pushing.
  markSteersDelivered(db, queuedSteers(db, a).map((s) => s.id), "drain");
  writeEvent(db, { task_id: a, source: "agent", type: "answer", payload: { note: "The last page is written by flush(); the finding read an older file." } });

  ageLandAttempts(db, a, 3_600_000);
  const second = mergeStub(db, { [a]: RISK_REASON });
  await landOnce(db, { exec: filesExec({}), merge: second.merge });
  const open = db.query("SELECT task_id, context FROM decisions WHERE status = 'open'").all() as any[];
  expect(open).toHaveLength(1);
  expect(open[0].task_id).toBe(a);
  expect(open[0].context).toContain("The last page is written by flush()");
  // One card, not one per sweep, and no second relay to the arguing agent.
  await landOnce(db, { exec: filesExec({}), merge: mergeStub(db, { [a]: RISK_REASON }).merge });
  expect((db.query("SELECT COUNT(*) AS n FROM decisions").get() as any).n).toBe(1);
  expect((db.query("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = 'risk_routed_to_agent'").get(a) as any).n).toBe(1);
});

// The realistic dispute: delivering the steer bounces the task back to the
// agent, so when it returns to review it is HELD by the unaddressed change
// request and never reaches another merge attempt. The escalation still fires.
test("a dispute escalates even while the task is held and never re-attempted", async () => {
  const { db, projectId } = freshDb();
  const a = makeTask(db, projectId, { branch: "a" });
  db.query("UPDATE tasks SET head_sha = 'sha1' WHERE id = ?").run(a);
  markLand(db, [a], true);
  await landOnce(db, { exec: filesExec({}), merge: mergeStub(db, { [a]: RISK_REASON }).merge });

  const steers = queuedSteers(db, a);
  markSteersDelivered(db, steers.map((s) => s.id), "drain");
  resumeReviewForDeliveredSteers(db, a, steers, "drain"); // → in_progress + changes_requested
  writeEvent(db, { task_id: a, source: "agent", type: "answer", payload: { note: "the finding misread the flush path" } });
  transition(db, a, "in_review", { source: "agent", reason: "handed back without a new commit" });

  ageLandAttempts(db, a, 3_600_000);
  const held = mergeStub(db, { [a]: RISK_REASON });
  await landOnce(db, { exec: filesExec({}), merge: held.merge });
  expect(held.calls).toEqual([]); // still held: no merge attempt at all
  const open = db.query("SELECT task_id, context FROM decisions WHERE status = 'open'").all() as any[];
  expect(open).toHaveLength(1);
  expect(open[0].context).toContain("misread the flush path");
});
