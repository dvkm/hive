import { test, expect } from "bun:test";
import { openDb, newId, now, type DB } from "../src/db.ts";
import { landGraph, landOnce, markLand, CONFIRMED_RISK_CODE } from "../src/landQueue.ts";
import { transition, writeEvent } from "../src/state.ts";
import { apiAnswerDecision } from "../src/api.ts";
import { confirmedRisks } from "../src/reviewer.ts";
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

// Point the task at a commit the auto reviewer has already cleared. The land
// queue waits for a verdict on the current head before it attempts anything
// (HIVE-581), so a test that sets head_sha has to give it one — a real refusal
// (a confirmed risk, a scope failure) can only happen after the review ran.
function setHead(db: DB, taskId: string, sha: string, verdict = "looks_good"): void {
  db.query("UPDATE tasks SET head_sha = ? WHERE id = ?").run(sha, taskId);
  writeEvent(db, {
    task_id: taskId,
    source: "system",
    type: "auto_review",
    payload: { verdict, files: ["src/a.ts"], risks: [], questions: [], reviewed_head_sha: sha },
  });
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
type Failure = string | { reason: string; code?: string };

function mergeStub(db: DB, failing: Record<string, Failure> = {}) {
  const calls: string[] = [];
  const merge = async (id: string) => {
    calls.push(id);
    if (failing[id]) {
      const f = failing[id];
      return typeof f === "string" ? { ok: false, reason: f } : { ok: false, reason: f.reason, code: f.code };
    }
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

  // HIVE-570: taking the PR out of the queue is the RIGHT answer to a permanent
  // failure, and it must not be how the explanation disappears. The closed card
  // says what ended the pause and repeats why the merge had stopped.
  const closed = db.query("SELECT status, answer_key, answer_note FROM decisions").get() as any;
  expect(closed.status).toBe("expired");
  expect(closed.answer_key).toBeNull();
  expect(closed.answer_note).toContain("you took it out of the land queue");
  expect(closed.answer_note).toContain("CI is red");
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
    setHead(db, a, `sha${i}`);
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

// HIVE-569: a timeout is transient, but retrying it spends the same busy route
// that caused it. It must wait minutes, not 30 seconds, and give up after three.
test("a capacity failure waits out the congestion instead of retrying into it", async () => {
  const { db, projectId } = freshDb();
  const a = makeTask(db, projectId, { branch: "a" });
  markLand(db, [a], true);
  const reason = "merge blocked — the risk check did not finish on this head: 2 of 2 findings got no verdict (timed out after 180000ms).";

  const first = mergeStub(db, { [a]: reason });
  await landOnce(db, { exec: filesExec({}), merge: first.merge });
  expect(first.calls).toEqual([a]);

  // 60s later a "base moved" would already be retrying. A timeout is not.
  ageLandAttempts(db, a, 60_000);
  const tooSoon = mergeStub(db, { [a]: reason });
  await landOnce(db, { exec: filesExec({}), merge: tooSoon.merge });
  expect(tooSoon.calls).toEqual([]);
  expect((db.query("SELECT COUNT(*) AS n FROM decisions").get() as any).n).toBe(0);

  // Past the 5 minute step it tries again, and burns its budget the same way.
  for (let i = 0; i < 3; i++) {
    ageLandAttempts(db, a, 3_600_000);
    const { merge } = mergeStub(db, { [a]: reason });
    await landOnce(db, { exec: filesExec({}), merge });
  }
  // Three capacity failures is the whole budget: attempt 4 stops being treated
  // as transient and becomes one card, instead of a fourth 180s timeout.
  const attempts = (db.query("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = 'land_attempted'").get(a) as any).n;
  expect(attempts).toBe(4);
  const card = db.query("SELECT context FROM decisions WHERE status = 'open'").get() as any;
  expect(card).toBeTruthy();
  expect(card.context).toContain("busy shared route");

  // And a further sweep adds nothing: no fifth attempt, no second card.
  ageLandAttempts(db, a, 3_600_000);
  const after = mergeStub(db, { [a]: reason });
  await landOnce(db, { exec: filesExec({}), merge: after.merge });
  expect(after.calls).toEqual([]);
  expect((db.query("SELECT COUNT(*) AS n FROM decisions WHERE status = 'open'").get() as any).n).toBe(1);
});

// A base that keeps moving costs nothing shared, so it keeps the fast cadence.
test("a non-capacity transient failure still retries on the short backoff", async () => {
  const { db, projectId } = freshDb();
  const a = makeTask(db, projectId, { branch: "a" });
  markLand(db, [a], true);
  const first = mergeStub(db, { [a]: "Base branch was modified. Review and try the merge again." });
  await landOnce(db, { exec: filesExec({}), merge: first.merge });
  ageLandAttempts(db, a, 60_000);
  const retry = mergeStub(db);
  await landOnce(db, { exec: filesExec({}), merge: retry.merge });
  expect(retry.calls).toEqual([a]);
});

// HIVE-555: a permanent blocker gave the same answer every 30s sweep forever.
// One PR alone produced 52 of 116 land failures on one machine.
test("a non-transient failure retries once, then holds instead of re-failing forever", async () => {
  const { db, projectId } = freshDb();
  const a = makeTask(db, projectId, { branch: "a" });
  setHead(db, a, "sha1");
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
  setHead(db, a, "sha2");
  const rearmed = mergeStub(db);
  await landOnce(db, { exec: filesExec({}), merge: rearmed.merge });
  expect(rearmed.calls).toEqual([a]);
  expect((db.query("SELECT state FROM tasks WHERE id = ?").get(a) as any).state).toBe("verifying");
});

test("a new head_sha closes the stale land-queue pause card", async () => {
  const { db, projectId } = freshDb();
  const a = makeTask(db, projectId, { branch: "a" });
  setHead(db, a, "sha1");
  markLand(db, [a], true);

  const { merge } = mergeStub(db, { [a]: "the branch drops work that is already on main" });
  await landOnce(db, { exec: filesExec({}), merge });
  expect((db.query("SELECT COUNT(*) AS n FROM decisions WHERE status = 'open'").get() as any).n).toBe(1);

  setHead(db, a, "sha2");
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
// The refusal as mergeTask actually builds it: prose for the human, `code` for
// the routing. merge-guard.test.ts asserts the gate really emits this pair.
const RISK_FAILURE = { reason: RISK_REASON, code: CONFIRMED_RISK_CODE };

test("a confirmed risk goes to the agent as a steer, opens no card, and holds the land", async () => {
  const { db, projectId } = freshDb();
  const a = makeTask(db, projectId, { branch: "a" });
  setHead(db, a, "sha1");
  markLand(db, [a], true);

  const { calls, merge } = mergeStub(db, { [a]: RISK_FAILURE });
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
  setHead(db, a, "sha2");
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
  setHead(db, a, "sha1");
  markLand(db, [a], true);

  const first = mergeStub(db, { [a]: RISK_FAILURE });
  await landOnce(db, { exec: filesExec({}), merge: first.merge });
  expect((db.query("SELECT COUNT(*) AS n FROM decisions").get() as any).n).toBe(0);

  // The agent reads it and argues the finding is wrong instead of pushing.
  markSteersDelivered(db, queuedSteers(db, a).map((s) => s.id), "drain");
  writeEvent(db, { task_id: a, source: "agent", type: "risk_dispute", payload: { note: "The last page is written by flush(); the finding read an older file." } });

  ageLandAttempts(db, a, 3_600_000);
  const second = mergeStub(db, { [a]: RISK_FAILURE });
  await landOnce(db, { exec: filesExec({}), merge: second.merge });
  const open = db.query("SELECT task_id, context FROM decisions WHERE status = 'open'").all() as any[];
  expect(open).toHaveLength(1);
  expect(open[0].task_id).toBe(a);
  expect(open[0].context).toContain("The last page is written by flush()");
  // One card, not one per sweep, and no second relay to the arguing agent.
  await landOnce(db, { exec: filesExec({}), merge: mergeStub(db, { [a]: RISK_FAILURE }).merge });
  expect((db.query("SELECT COUNT(*) AS n FROM decisions").get() as any).n).toBe(1);
  expect((db.query("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = 'risk_routed_to_agent'").get(a) as any).n).toBe(1);
});

// The bug the risk check caught on this very PR: `answer` is the generic reply
// channel for every steer and change-request question, so reading it as "the
// agent disputes the risk" turned "on it, fixing now" — or a reply about
// something else entirely — into a director card. That is the interruption this
// feature exists to remove, so only `risk_dispute` counts.
test("an ordinary answer after the relay is not a dispute and opens no card", async () => {
  const { db, projectId } = freshDb();
  const a = makeTask(db, projectId, { branch: "a" });
  setHead(db, a, "sha1");
  markLand(db, [a], true);
  await landOnce(db, { exec: filesExec({}), merge: mergeStub(db, { [a]: RISK_FAILURE }).merge });
  expect((db.query("SELECT COUNT(*) AS n FROM decisions").get() as any).n).toBe(0);

  // The agent replies on the generic channel about something unrelated.
  markSteersDelivered(db, queuedSteers(db, a).map((s) => s.id), "drain");
  writeEvent(db, { task_id: a, source: "agent", type: "answer", payload: { note: "Yes, the export flag is behind the same env var you asked about." } });

  // The relay is spent and the same commit still fails, so the director does
  // hear about it — but as the ordinary "came back unfixed" hold, never as an
  // argument the agent never made. That unrelated answer is nowhere near it.
  ageLandAttempts(db, a, 3_600_000);
  await landOnce(db, { exec: filesExec({}), merge: mergeStub(db, { [a]: RISK_FAILURE }).merge });
  expect((db.query("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = 'risk_routed_to_agent'").get(a) as any).n).toBe(1);
  const open = db.query("SELECT context FROM decisions WHERE status = 'open'").all() as any[];
  expect(open).toHaveLength(1);
  expect(open[0].context).not.toContain("the same env var");
  expect(open[0].context).not.toContain("disputes it");
  expect(open[0].context).toContain("came back unfixed");
});

// The realistic dispute: delivering the steer bounces the task back to the
// agent, so when it returns to review it is HELD by the unaddressed change
// request and never reaches another merge attempt. The escalation still fires.
test("a dispute escalates even while the task is held and never re-attempted", async () => {
  const { db, projectId } = freshDb();
  const a = makeTask(db, projectId, { branch: "a" });
  setHead(db, a, "sha1");
  markLand(db, [a], true);
  await landOnce(db, { exec: filesExec({}), merge: mergeStub(db, { [a]: RISK_FAILURE }).merge });

  const steers = queuedSteers(db, a);
  markSteersDelivered(db, steers.map((s) => s.id), "drain");
  resumeReviewForDeliveredSteers(db, a, steers, "drain"); // → in_progress + changes_requested
  writeEvent(db, { task_id: a, source: "agent", type: "risk_dispute", payload: { note: "the finding misread the flush path" } });
  transition(db, a, "in_review", { source: "agent", reason: "handed back without a new commit" });

  ageLandAttempts(db, a, 3_600_000);
  const held = mergeStub(db, { [a]: RISK_FAILURE });
  await landOnce(db, { exec: filesExec({}), merge: held.merge });
  expect(held.calls).toEqual([]); // still held: no merge attempt at all
  const open = db.query("SELECT task_id, context FROM decisions WHERE status = 'open'").all() as any[];
  expect(open).toHaveLength(1);
  expect(open[0].context).toContain("misread the flush path");
});

// The desync this design exists to prevent, made loud. If the merge gate stops
// setting the code but the message still reads like a confirmed risk, hive keeps
// routing to the agent (no silent revert to the director) AND records that the
// two files have drifted apart, so a human finds out.
test("a confirmed-risk refusal with no code still routes, and says loudly that it desynced", async () => {
  const { db, projectId } = freshDb();
  const a = makeTask(db, projectId, { branch: "a" });
  setHead(db, a, "sha1");
  markLand(db, [a], true);

  // Code stripped: only the prose survives, exactly as a reworded gate would look.
  await landOnce(db, { exec: filesExec({}), merge: mergeStub(db, { [a]: RISK_REASON }).merge });

  // Behaviour did NOT revert: the agent still gets the finding, no card opens.
  expect(queuedSteers(db, a)).toHaveLength(1);
  expect((db.query("SELECT COUNT(*) AS n FROM decisions").get() as any).n).toBe(0);
  // And the broken contract is on the record, not swallowed.
  const desync = db.query("SELECT payload FROM events WHERE task_id = ? AND type = 'risk_code_desync'").all(a) as any[];
  expect(desync).toHaveLength(1);
  expect(JSON.parse(desync[0].payload).expected_code).toBe(CONFIRMED_RISK_CODE);
  const notes = db.query("SELECT title FROM notifications WHERE task_id = ?").all(a) as any[];
  expect(notes.some((n) => n.title.includes(CONFIRMED_RISK_CODE))).toBe(true);
});

test("a queued task waits for the auto review, then lands on the next sweep (HIVE-581)", async () => {
  const { db, projectId } = freshDb();
  const a = makeTask(db, projectId, { branch: "a" });
  db.query("UPDATE tasks SET head_sha = ? WHERE id = ?").run("headsha1", a);
  markLand(db, [a], true);

  // The reviewer has not written anything for this head yet: no attempt, no
  // failed land_attempted, no card.
  const early = mergeStub(db);
  await landOnce(db, { exec: filesExec({}), merge: early.merge });
  expect(early.calls).toEqual([]);
  expect((db.query("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = 'land_attempted'").get(a) as any).n).toBe(0);
  expect((db.query("SELECT COUNT(*) AS n FROM decisions").get() as any).n).toBe(0);

  // The verdict arrives; the same task lands on the next sweep, no human input.
  writeEvent(db, {
    task_id: a,
    source: "system",
    type: "auto_review",
    payload: { verdict: "looks_good", files: ["src/a.ts"], risks: [], questions: [], reviewed_head_sha: "headsha1" },
  });
  const after = mergeStub(db);
  await landOnce(db, { exec: filesExec({}), merge: after.merge });
  expect(after.calls).toEqual([a]);
  expect((db.query("SELECT state FROM tasks WHERE id = ?").get(a) as any).state).toBe("verifying");
});

test("a project with auto review disabled lands without waiting for a verdict", async () => {
  const { db, projectId } = freshDb();
  db.query("UPDATE projects SET config = ? WHERE id = ?").run(
    JSON.stringify({ default_branch: "main", auto_review: false }), projectId
  );
  const a = makeTask(db, projectId, { branch: "a" });
  db.query("UPDATE tasks SET head_sha = ? WHERE id = ?").run("headsha1", a);
  markLand(db, [a], true);

  const { calls, merge } = mergeStub(db);
  await landOnce(db, { exec: filesExec({}), merge });
  expect(calls).toEqual([a]);
});

test("an erroring reviewer cannot hold the land queue forever (HIVE-581)", async () => {
  const { db, projectId } = freshDb();
  const a = makeTask(db, projectId, { branch: "a" });
  db.query("UPDATE tasks SET head_sha = ? WHERE id = ?").run("headsha1", a);
  markLand(db, [a], true);

  // No verdict ever arrives. The first sweep holds and records the wait.
  const early = mergeStub(db);
  await landOnce(db, { exec: filesExec({}), merge: early.merge });
  expect(early.calls).toEqual([]);
  const wait = db.query("SELECT id FROM events WHERE task_id = ? AND type = 'land_review_wait'").all(a) as any[];
  expect(wait).toHaveLength(1);

  // Still inside the ceiling: still holding, and no second wait event.
  const again = mergeStub(db);
  await landOnce(db, { exec: filesExec({}), merge: again.merge });
  expect(again.calls).toEqual([]);
  expect((db.query("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = 'land_review_wait'").get(a) as any).n).toBe(1);

  // Past the ceiling the hold expires and the merge is attempted as before.
  db.query("UPDATE events SET ts = ? WHERE id = ?").run(new Date(Date.now() - 3_600_000).toISOString(), wait[0].id);
  const late = mergeStub(db);
  await landOnce(db, { exec: filesExec({}), merge: late.merge });
  expect(late.calls).toEqual([a]);
});

// HIVE-588: a confirmed risk is a verdict stored against ONE commit, and the
// queue re-read it on every sweep. So "try landing it again" looked like an
// option and behaved like a no-op: the same stored row, the same refusal. On a
// risk card that option is replaced by one that changes something — the
// director says why the finding is wrong, hive sets the verdict aside and runs
// the check again. Not an override: a re-run that confirms still blocks.
test("a confirmed-risk card offers a re-check, and answering it sets the stored verdict aside", async () => {
  const { db, projectId } = freshDb();
  const a = makeTask(db, projectId, { branch: "a" });
  setHead(db, a, "sha1");
  // The verdict the merge gate reads, exactly as the risk check writes it.
  writeEvent(db, {
    task_id: a,
    source: "system",
    type: "risk_verdicts",
    payload: { reviewed_head_sha: "sha1", verdicts: [{ risk: "export drops rows", why: "the CSV writer skips the last page", verdict: "confirmed" }] },
  });
  expect(confirmedRisks(db, a, "sha1")).toHaveLength(1);
  markLand(db, [a], true);

  // Relayed to the agent first; it hands the branch back unchanged, so the
  // second sweep opens the director's card.
  await landOnce(db, { exec: filesExec({}), merge: mergeStub(db, { [a]: RISK_FAILURE }).merge });
  markSteersDelivered(db, queuedSteers(db, a).map((s) => s.id), "drain");
  ageLandAttempts(db, a, 3_600_000);
  await landOnce(db, { exec: filesExec({}), merge: mergeStub(db, { [a]: RISK_FAILURE }).merge });

  const card = db.query("SELECT id, options FROM decisions WHERE status = 'open'").get() as any;
  expect(card).toBeTruthy();
  const keys = JSON.parse(card.options).map((o: any) => o.key);
  expect(keys).toContain("recheck");
  expect(keys).not.toContain("retry");

  const res = apiAnswerDecision(db, stubHerdr, card.id, {
    answer_key: "recheck",
    answer_note: "The finding cites a commit from before PR #101 landed the flush fix.",
    source: "director",
  });
  expect(res.status).toBe(200);
  // The verdict is set aside, so nothing quotes it any more and the check
  // re-runs from scratch on this same commit.
  expect(confirmedRisks(db, a, "sha1")).toHaveLength(0);
  const recheck = db.query("SELECT payload FROM events WHERE task_id = ? AND type = 'risk_recheck'").all(a) as any[];
  expect(recheck).toHaveLength(1);
  // The reasoning is recorded, which is the part that had nowhere to go before.
  expect(JSON.parse(recheck[0].payload).why).toContain("PR #101");
  // Re-armed: still queued, still in review, and the failed-attempt run that
  // held it after two failures on this commit is ended.
  const task = db.query("SELECT state, land_queued_at FROM tasks WHERE id = ?").get(a) as any;
  expect(task.state).toBe("in_review");
  expect(task.land_queued_at).toBeTruthy();

  // A second card on the same commit no longer offers it: the check already
  // re-ran with the argument, so asking again would be the no-op this replaced.
  ageLandAttempts(db, a, 3_600_000);
  await landOnce(db, { exec: filesExec({}), merge: mergeStub(db, { [a]: RISK_FAILURE }).merge });
  const second = db.query("SELECT options FROM decisions WHERE status = 'open'").get() as any;
  expect(JSON.parse(second.options).map((o: any) => o.key)).toContain("retry");
});

// HIVE-588: a card can sit open for hours, and the agent can push while it
// sits. The ruling is about the commit the card was built on, so answering it
// must never set aside verdicts about the commit that replaced it.
test("a re-check answered after the branch moved sets nothing aside on the new commit", async () => {
  const { db, projectId } = freshDb();
  const a = makeTask(db, projectId, { branch: "a" });
  setHead(db, a, "sha1");
  writeEvent(db, {
    task_id: a,
    source: "system",
    type: "risk_verdicts",
    payload: { reviewed_head_sha: "sha1", verdicts: [{ risk: "export drops rows", why: "the CSV writer skips the last page", verdict: "confirmed" }] },
  });
  markLand(db, [a], true);
  await landOnce(db, { exec: filesExec({}), merge: mergeStub(db, { [a]: RISK_FAILURE }).merge });
  markSteersDelivered(db, queuedSteers(db, a).map((s) => s.id), "drain");
  ageLandAttempts(db, a, 3_600_000);
  await landOnce(db, { exec: filesExec({}), merge: mergeStub(db, { [a]: RISK_FAILURE }).merge });
  const card = db.query("SELECT id FROM decisions WHERE status = 'open'").get() as any;

  // The agent pushes while the card is open, and the new commit gets its own
  // confirmed finding — one the director has never read.
  setHead(db, a, "sha2");
  writeEvent(db, {
    task_id: a,
    source: "system",
    type: "risk_verdicts",
    payload: { reviewed_head_sha: "sha2", verdicts: [{ risk: "new code deletes the audit row", why: "brand new", verdict: "confirmed" }] },
  });

  const res = apiAnswerDecision(db, stubHerdr, card.id, {
    answer_key: "recheck",
    answer_note: "The finding cites a commit from before PR #101 landed the flush fix.",
    source: "director",
  });
  expect(res.status).toBe(200);
  // Nothing was set aside: the ruling was about sha1, and sha2's finding still
  // blocks the merge until the check itself clears it.
  expect(confirmedRisks(db, a, "sha2")).toHaveLength(1);
  expect(db.query("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = 'risk_recheck'").get(a) as any).toMatchObject({ n: 0 });
  // Still re-armed, so the sweep re-evaluates the new head cleanly.
  const task = db.query("SELECT state, land_queued_at FROM tasks WHERE id = ?").get(a) as any;
  expect(task.state).toBe("in_review");
  expect(task.land_queued_at).toBeTruthy();
});

// A finding about a commit the branch has already moved past is stale by
// construction. The merge gate says so instead of quoting it, and the queue
// reads that as something to retry — no card, no relay, no director.
test("a stale risk finding retries instead of opening a card", async () => {
  const { db, projectId } = freshDb();
  const a = makeTask(db, projectId, { branch: "a" });
  setHead(db, a, "sha2");
  markLand(db, [a], true);
  const reason =
    "merge blocked — the risk finding is stale: it was recorded on commit sha1abc, and the branch has moved on to sha2def. " +
    "Nothing is confirmed on the new commit yet. The risk check re-runs on it and the merge is re-attempted.";

  const first = mergeStub(db, { [a]: { reason, code: CONFIRMED_RISK_CODE } });
  await landOnce(db, { exec: filesExec({}), merge: first.merge });
  expect(first.calls).toEqual([a]);
  expect((db.query("SELECT COUNT(*) AS n FROM decisions").get() as any).n).toBe(0);
  expect((db.query("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = 'risk_routed_to_agent'").get(a) as any).n).toBe(0);
  expect(JSON.parse((db.query("SELECT payload FROM events WHERE task_id = ? AND type = 'land_attempted' ORDER BY rowid DESC LIMIT 1").get(a) as any).payload).transient).toBe(true);

  // And it lands on the next sweep once the check has cleared the new commit.
  ageLandAttempts(db, a, 3_600_000);
  const second = mergeStub(db);
  await landOnce(db, { exec: filesExec({}), merge: second.merge });
  expect(second.calls).toEqual([a]);
  expect((db.query("SELECT state FROM tasks WHERE id = ?").get(a) as any).state).toBe("verifying");
});
