import { test, expect } from "bun:test";
import { openDb, newId, type DB } from "../src/db.ts";
import { autonomyStats } from "../src/autonomyStats.ts";
import { apiAnswerDecision, createDecision } from "../src/api.ts";
import type { Exec, ExecResult } from "../src/exec.ts";

// Fixed clock: the window is [NOW - days, NOW).
const NOW = new Date("2026-08-20T12:00:00.000Z");
const clock = () => NOW;
const at = (daysAgo: number, hour = 0): string =>
  new Date(NOW.getTime() - daysAgo * 86_400_000 + hour * 3_600_000).toISOString();

function freshDb(): { db: DB; projectId: string } {
  const db = openDb(":memory:");
  const projectId = newId("proj");
  db.query("INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)").run(
    projectId, "p", "/repo", JSON.stringify({ default_branch: "main" }), at(60)
  );
  return { db, projectId };
}

let seq = 0;
function makeTask(db: DB, projectId: string, extra: { kind?: string; pr_url?: string | null; state?: string } = {}): string {
  const id = newId();
  db.query(
    `INSERT INTO tasks (id, project_id, title, brief, state, kind, number, pr_url, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(id, projectId, `t${++seq}`, "", extra.state ?? "done", extra.kind ?? "ship", seq, extra.pr_url ?? null, at(30), at(0));
  return id;
}

// Direct insert so tests own the timestamp (writeEvent stamps now()).
function ev(db: DB, taskId: string, type: string, ts: string, payload: unknown = {}): string {
  const id = newId("ev");
  db.query("INSERT INTO events (id, task_id, ts, source, type, payload) VALUES (?,?,?,?,?,?)").run(
    id, taskId, ts, "reconciler", type, JSON.stringify(payload)
  );
  return id;
}

// An auto-merge that landed `files`, `daysAgo` days back.
function autoMerge(db: DB, projectId: string, files: string[], daysAgo: number, pr_url: string | null = null): string {
  const id = makeTask(db, projectId, { pr_url });
  ev(db, id, "merged", at(daysAgo), { method: "pr squash", base: "main", merged_files: files });
  ev(db, id, "auto_merged", at(daysAgo, 0.01), { ok: true, status: 200 });
  return id;
}

test("auto-merge precision: a later branch re-touching half the files reads as a fix", async () => {
  const { db, projectId } = freshDb();
  const clean = autoMerge(db, projectId, ["a.ts", "b.ts"], 10);
  const regressed = autoMerge(db, projectId, ["x.ts", "y.ts", "z.ts"], 9);

  // Later task touches 2 of the 3 files (67% >= 50%) inside the 7-day window.
  const fixer = makeTask(db, projectId);
  ev(db, fixer, "branch_scope", at(6), { base_sha: "deadbeef", files: ["x.ts", "z.ts", "unrelated.ts"] });
  // A later task overlapping the CLEAN merge only 1-of-2 at 50%... make it 0.
  const other = makeTask(db, projectId);
  ev(db, other, "branch_scope", at(5), { base_sha: "deadbeef", files: ["totally-different.ts"] });

  const s = await autonomyStats(db, { days: 30, now: clock, exec: null });
  expect(s.auto_merge_precision.merges).toBe(2);
  expect(s.auto_merge_precision.fixed).toBe(1);
  expect(s.auto_merge_precision.precision).toBe(0.5);
  const fixedCase = s.auto_merge_precision.cases.find((c) => c.fix_signal);
  expect(fixedCase?.task_id).toBe(regressed);
  expect(fixedCase?.fix_signal).toMatchObject({ kind: "file_overlap", task_id: fixer });
  expect(s.auto_merge_precision.cases.find((c) => c.task_id === clean)?.fix_signal).toBeNull();
});

test("auto-merge precision: a fix landing after the 7-day window does not count", async () => {
  const { db, projectId } = freshDb();
  autoMerge(db, projectId, ["x.ts", "y.ts"], 20);
  const late = makeTask(db, projectId);
  ev(db, late, "branch_scope", at(5), { base_sha: "deadbeef", files: ["x.ts", "y.ts"] });

  const s = await autonomyStats(db, { days: 30, now: clock, exec: null });
  expect(s.auto_merge_precision.merges).toBe(1);
  expect(s.auto_merge_precision.precision).toBe(1);
});

test("auto-merge precision: a revert commit naming the PR counts as a fix", async () => {
  const { db, projectId } = freshDb();
  autoMerge(db, projectId, ["a.ts"], 10, "https://github.com/o/r/pull/42");
  autoMerge(db, projectId, ["b.ts"], 10, "https://github.com/o/r/pull/43");

  const exec: Exec = async (): Promise<ExecResult> => ({
    code: 0,
    stdout: `abc123\0Revert "thing (#42)"\n`,
    stderr: "",
  });
  const s = await autonomyStats(db, { days: 30, now: clock, exec });
  expect(s.auto_merge_precision.fixed).toBe(1);
  expect(s.auto_merge_precision.cases.find((c) => c.fix_signal)?.fix_signal).toMatchObject({ kind: "revert", commit: "abc123" });
  expect(s.auto_merge_precision.revert_detection).toBe("on");
});

test("auto-merge precision: no merges in the window returns null, not a fake 100%", async () => {
  const { db } = freshDb();
  const s = await autonomyStats(db, { days: 7, now: clock, exec: null });
  expect(s.auto_merge_precision.merges).toBe(0);
  expect(s.auto_merge_precision.precision).toBeNull();
});

test("inbox load: one row per day, split by class", async () => {
  const { db, projectId } = freshDb();
  const task = makeTask(db, projectId);
  ev(db, task, "needs-decision", at(2, 1), { decision_id: "dec_1" });
  ev(db, task, "needs-decision", at(2, 2), { decision_id: "dec_2" });
  ev(db, task, "checkpoint", at(2, 3), { note: "shortcut taken" });
  ev(db, task, "blocked_card", at(1, 1), { decision_id: "dec_3" });
  ev(db, task, "stale", at(1, 2), {});
  ev(db, task, "review_summary", at(1, 3), { understanding: { checks: [{ question: "q" }] } });
  // A review with no quiz questions is not an inbox item.
  ev(db, task, "review_summary", at(1, 4), { done: ["x"] });
  // Outside the window.
  ev(db, task, "stale", at(40), {});

  const s = await autonomyStats(db, { days: 7, now: clock, exec: null });
  expect(s.inbox_load.by_day.length).toBe(7);
  expect(s.inbox_load.totals).toEqual({ decision: 2, quiz: 1, checkpoint: 1, dialog: 1, stale: 1, total: 6 });
  const twoDaysAgo = s.inbox_load.by_day.find((d) => d.day === at(2).slice(0, 10))!;
  expect(twoDaysAgo).toMatchObject({ decision: 2, checkpoint: 1, quiz: 0, dialog: 0, stale: 0, total: 3 });
  expect(s.inbox_load.per_day).toBeCloseTo(6 / 7);
});

test("inbox load: today's events land in the last bucket", async () => {
  const { db, projectId } = freshDb();
  const task = makeTask(db, projectId);
  ev(db, task, "stale", at(0), {}); // this morning, the partially-filled last day

  const s = await autonomyStats(db, { days: 7, now: clock, exec: null });
  const last = s.inbox_load.by_day.at(-1)!;
  expect(last.day).toBe("2026-08-20");
  expect(last.stale).toBe(1);
  expect(s.inbox_load.totals.stale).toBe(1);
});

test("recovery: respawns, one-cap parks, and scouts are counted separately", async () => {
  const { db, projectId } = freshDb();
  const task = makeTask(db, projectId);
  ev(db, task, "recovery", at(3), { decision: "turn-complete-respawn", respawned: true });
  ev(db, task, "recovery", at(3, 1), { decision: "turn-complete-respawn", respawned: false }); // failed spawn, not a recovery
  ev(db, task, "recovery", at(3, 2), { decision: "turn-complete-respawn-held", reason: "project max_agents" });
  ev(db, task, "recovery", at(3, 3), { decision: "turn-complete-respawn-held", reason: "spawn backoff" });
  const scout = makeTask(db, projectId, { kind: "scout" });
  ev(db, scout, "spawned", at(2), {});
  ev(db, task, "spawned", at(2), {}); // a ship task spawn is not a scout

  const s = await autonomyStats(db, { days: 30, now: clock, exec: null });
  expect(s.recovery).toEqual({ auto_respawns: 1, one_cap_parks: 1, scouts_spawned: 1 });
});

test("agreement: auto-answered decisions minus the ones a director contradicted", async () => {
  const { db, projectId } = freshDb();
  const task = makeTask(db, projectId);
  const mkDecision = (id: string, answeredBy: string) =>
    db.query(
      `INSERT INTO decisions (id, task_id, ts, title, options, status, answer_key, answered_at, answered_by)
       VALUES (?,?,?,?,?,'answered',?,?,?)`
    ).run(id, task, at(5), id, "[]", "approve", at(5), answeredBy);
  mkDecision("dec_a", "chat_supervisor");
  mkDecision("dec_b", "system");
  mkDecision("dec_c", "director"); // a human answer is not an auto-answer
  ev(db, task, "decision_contradicted", at(4), { decision_id: "dec_a", prior_source: "chat_supervisor" });
  ev(db, task, "decision_contradicted", at(4, 1), { decision_id: "dec_c", prior_source: "director" });

  const s = await autonomyStats(db, { days: 30, now: clock, exec: null });
  expect(s.agreement).toEqual({ auto_answered: 2, contradictions: 2, auto_contradicted: 1, agreement_rate: 0.5 });
});

test("project_id filters every metric", async () => {
  const { db, projectId } = freshDb();
  const otherProject = newId("proj");
  db.query("INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)").run(
    otherProject, "other", "/other", "{}", at(60)
  );
  autoMerge(db, projectId, ["a.ts"], 3);
  autoMerge(db, otherProject, ["b.ts"], 3);
  ev(db, makeTask(db, otherProject), "stale", at(2), {});

  const s = await autonomyStats(db, { days: 30, projectId, now: clock, exec: null });
  expect(s.auto_merge_precision.merges).toBe(1);
  expect(s.inbox_load.totals.stale).toBe(0);
});

test("answering an already-answered card with a different option records a contradiction", () => {
  const { db, projectId } = freshDb();
  const task = makeTask(db, projectId, { state: "in_progress" });
  const decision = createDecision(db, {
    task_id: task,
    title: "ship it?",
    options: [{ key: "yes", label: "Yes" }, { key: "no", label: "No" }],
  });
  const herdr: any = { send: async () => ({ ok: true }) };
  expect(apiAnswerDecision(db, herdr, decision.id, { answer_key: "yes", source: "system" }).status).toBe(200);

  // Director disagrees after the fact: the answer is still refused, but recorded.
  const second = apiAnswerDecision(db, herdr, decision.id, { answer_key: "no", source: "director" });
  expect(second.status).not.toBe(200);
  const rows = db.query("SELECT payload FROM events WHERE task_id = ? AND type = 'decision_contradicted'").all(task) as { payload: string }[];
  expect(rows.length).toBe(1);
  expect(JSON.parse(rows[0].payload)).toMatchObject({
    decision_id: decision.id,
    prior_answer_key: "yes",
    prior_source: "system",
    attempted_answer_key: "no",
  });

  // Re-clicking the SAME option is agreement, and a repeat disagreement is not double-counted.
  apiAnswerDecision(db, herdr, decision.id, { answer_key: "yes", source: "director" });
  apiAnswerDecision(db, herdr, decision.id, { answer_key: "no", source: "director" });
  expect((db.query("SELECT COUNT(*) n FROM events WHERE type = 'decision_contradicted'").get() as any).n).toBe(1);
});

// The metric above is only as good as its input: mergeTask has to record what
// it landed at merge time. This is the local-ff path (no PR to ask GitHub about).
test("mergeTask records merged_files on the merged event", async () => {
  const { Herdr } = await import("../src/runtime/herdr.ts");
  const { mergeTask } = await import("../src/api.ts");
  const { writeEvent } = await import("../src/state.ts");
  const { db, projectId } = freshDb();
  const taskId = newId();
  db.query(
    "INSERT INTO tasks (id, project_id, title, state, kind, branch, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)"
  ).run(taskId, projectId, "task", "in_review", "ship", "feat", at(1), at(0));
  const review = writeEvent(db, {
    task_id: taskId,
    source: "agent",
    type: "review_summary",
    payload: { understanding: { checks: [{ question: "q", options: [{ key: "a", label: "A" }, { key: "b", label: "B" }], answer_key: "a" }] } },
  });
  writeEvent(db, { task_id: taskId, source: "director", type: "understanding_quiz_passed", payload: { review_event_id: review.id, answer_key: "a" } });

  const OK = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
  const exec: Exec = async (argv) => {
    if (argv.includes("diff") && argv.includes("--name-only")) return OK("src/task.ts\nsrc/other.ts\n");
    if (argv.includes("rev-parse")) return OK(argv.at(-1) === "main" ? "base-sha\n" : "branch-sha\n");
    if (argv.includes("symbolic-ref")) return OK("main\n");
    return OK();
  };
  const herdr = new Herdr(async () => OK("{}"), "herdr");
  const res = await mergeTask(db, herdr, taskId, {}, { exec });
  expect(res.status).toBe(200);
  const merged: any = db.query("SELECT payload FROM events WHERE task_id = ? AND type = 'merged'").get(taskId);
  expect(JSON.parse(merged.payload).merged_files).toEqual(["src/other.ts", "src/task.ts"]);
});

// The PR path asks GitHub, not local git: after a squash merge the PR head may
// not exist in the local clone at all.
test("mergeTask records merged_files from the PR's own file list", async () => {
  const { Herdr } = await import("../src/runtime/herdr.ts");
  const { mergeTask } = await import("../src/api.ts");
  const { writeEvent } = await import("../src/state.ts");
  const { db, projectId } = freshDb();
  const taskId = newId();
  db.query(
    "INSERT INTO tasks (id, project_id, title, state, kind, branch, pr_url, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)"
  ).run(taskId, projectId, "task", "in_review", "ship", "feat", "https://gh/pr/7", at(1), at(0));
  const review = writeEvent(db, {
    task_id: taskId,
    source: "agent",
    type: "review_summary",
    payload: { understanding: { checks: [{ question: "q", options: [{ key: "a", label: "A" }, { key: "b", label: "B" }], answer_key: "a" }] } },
  });
  writeEvent(db, { task_id: taskId, source: "director", type: "understanding_quiz_passed", payload: { review_event_id: review.id, answer_key: "a" } });

  const OK = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
  const exec: Exec = async (argv) => {
    if (argv[0] === "gh" && argv.includes("--json") && argv.at(-1) === "files")
      return OK(JSON.stringify({ files: [{ path: "src/b.ts" }, { path: "src/a.ts" }] }));
    if (argv[0] === "gh" && argv.includes("view"))
      return OK(JSON.stringify({ state: "OPEN", baseRefName: "main", baseRefOid: "base-sha", headRefOid: "head-sha", mergeStateStatus: "CLEAN", statusCheckRollup: [] }));
    return OK();
  };
  const herdr = new Herdr(async () => OK("{}"), "herdr");
  const res = await mergeTask(db, herdr, taskId, {}, { exec });
  expect(res.status).toBe(200);
  const merged: any = db.query("SELECT payload FROM events WHERE task_id = ? AND type = 'merged'").get(taskId);
  expect(JSON.parse(merged.payload).merged_files).toEqual(["src/a.ts", "src/b.ts"]);
});
