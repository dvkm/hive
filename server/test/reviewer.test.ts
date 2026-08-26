// Auto-reviewer: pre-review posted onto the review card as an auto_review event.
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "hive-reviewer-"));
process.env.HIVE_HOME = HOME;

const { openDb, newId, now } = await import("../src/db.ts");
const { autoReviewOnce, extractReview } = await import("../src/reviewer.ts");
const { transition, writeEvent } = await import("../src/state.ts");
import type { DB } from "../src/db.ts";
import type { Exec } from "../src/exec.ts";

function setup(
  config: any = {},
  extra: Partial<{ source: string; agent_target: string; pr_url: string | null; branch: string }> = {}
): { db: DB; id: string } {
  const db = openDb(":memory:");
  const pid = newId("proj");
  const t = now();
  db.query("INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)").run(
    pid, "p", "/repo", JSON.stringify(config), t
  );
  const id = newId();
  db.query(
    "INSERT INTO tasks (id, project_id, title, brief, state, kind, source, agent_target, branch, pr_url, created_at, updated_at) VALUES (?,?,?,?, 'queued','ship',?,?,?,?,?,?)"
  ).run(
    id,
    pid,
    "add feature",
    "make it work",
    extra.source ?? null,
    extra.agent_target ?? null,
    extra.branch ?? null,
    extra.pr_url === undefined ? "https://gh/pr/5" : extra.pr_url,
    t,
    t
  );
  transition(db, id, "in_progress");
  transition(db, id, "in_review");
  return { db, id };
}

const ghDiff: Exec = async (argv) =>
  argv.includes("diff")
    ? { code: 0, stdout: "--- a/x.ts\n+++ b/x.ts\n+const y = 1;", stderr: "" }
    : { code: 0, stdout: JSON.stringify({ headRefOid: "review-head" }), stderr: "" };

const events = (db: DB, id: string, type: string) =>
  db.query("SELECT * FROM events WHERE task_id = ? AND type = ?").all(id, type).map((e: any) => ({ ...e, payload: JSON.parse(e.payload) }));

test("posts a structured pre-review onto the review card, once", async () => {
  const { db, id } = setup();
  let prompts: string[] = [];
  const claude = async (argv: string[]) => {
    prompts.push(argv.join(" "));
    return { code: 0, stdout: JSON.stringify({ result: '{"verdict":"caution","summary":"adds y unused","risks":["x.ts: y is dead code"],"questions":[]}' }), stderr: "" };
  };
  await autoReviewOnce(db, { exec: claude, shellExec: ghDiff });
  const revs = events(db, id, "auto_review");
  expect(revs).toHaveLength(1);
  expect(revs[0].payload.verdict).toBe("caution");
  expect(revs[0].payload.risks[0]).toContain("dead code");
  expect(revs[0].payload).toMatchObject({ reviewed_pr_url: "https://gh/pr/5", reviewed_head_sha: "review-head" });
  expect(prompts[0]).toContain("add feature"); // brief made it into the prompt
  expect(prompts[0]).toContain("--model sonnet");

  await autoReviewOnce(db, { exec: claude, shellExec: ghDiff }); // no second review
  expect(events(db, id, "auto_review")).toHaveLength(1);
});

test("reviewer discards a verdict when the live PR head changes during review", async () => {
  const { db, id } = setup();
  let head = "head-before-review";
  const shell: Exec = async (argv) =>
    argv.includes("diff")
      ? { code: 0, stdout: "+const reviewed = true;", stderr: "" }
      : { code: 0, stdout: JSON.stringify({ headRefOid: head }), stderr: "" };
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const began = new Promise<void>((resolve) => { started = resolve; });
  const stale = autoReviewOnce(db, {
    shellExec: shell,
    exec: async () => {
      started();
      await waiting;
      return {
        code: 0,
        stdout: JSON.stringify({ result: '{"verdict":"looks_good","summary":"stale head","risks":[],"questions":[]}' }),
        stderr: "",
      };
    },
  });
  await began;
  head = "head-after-force-push";
  release();
  await stale;

  expect(events(db, id, "auto_review")).toHaveLength(0);

  await autoReviewOnce(db, {
    shellExec: shell,
    exec: async () => ({
      code: 0,
      stdout: JSON.stringify({ result: '{"verdict":"looks_good","summary":"current head","risks":[],"questions":[]}' }),
      stderr: "",
    }),
  });
  expect(events(db, id, "auto_review")[0].payload).toMatchObject({
    summary: "current head",
    reviewed_pr_url: "https://gh/pr/5",
    reviewed_head_sha: "head-after-force-push",
  });
});

test("reviewer runs again after a reviewed PR is force-pushed", async () => {
  const { db, id } = setup();
  let head = "reviewed-head";
  const shell: Exec = async (argv) =>
    argv.includes("diff")
      ? { code: 0, stdout: "+const reviewed = true;", stderr: "" }
      : { code: 0, stdout: JSON.stringify({ headRefOid: head }), stderr: "" };
  let reviews = 0;
  const claude = async () => ({
    code: 0,
    stdout: JSON.stringify({
      result: JSON.stringify({ verdict: "looks_good", summary: `review ${++reviews}`, risks: [], questions: [] }),
    }),
    stderr: "",
  });

  await autoReviewOnce(db, { exec: claude, shellExec: shell });
  head = "force-pushed-head";
  db.query("UPDATE tasks SET head_sha = ? WHERE id = ?").run(head, id);
  await autoReviewOnce(db, { exec: claude, shellExec: shell });

  expect(events(db, id, "auto_review").map((event) => event.payload.reviewed_head_sha)).toEqual([
    "reviewed-head",
    "force-pushed-head",
  ]);
});

test("a branch-only review compares against the remote integration branch", async () => {
  const { db, id } = setup(
    { promote: { from: "staging", to: "main" } },
    { branch: "hive/task", pr_url: null }
  );
  const gitCalls: string[][] = [];
  const git: Exec = async (argv) => {
    gitCalls.push(argv);
    return { code: 0, stdout: "--- a/x.ts\n+++ b/x.ts\n+const y = 1;", stderr: "" };
  };
  const claude = async () => ({
    code: 0,
    stdout: JSON.stringify({ result: '{"verdict":"looks_good","summary":"fine","risks":[],"questions":[]}' }),
    stderr: "",
  });

  await autoReviewOnce(db, { exec: claude, shellExec: git });

  expect(gitCalls).toEqual([["git", "-C", "/repo", "diff", "origin/staging...hive/task"]]);
  expect(events(db, id, "auto_review")).toHaveLength(1);
});

test("reviewer failure records auto_review_error once and never blocks review", async () => {
  const { db, id } = setup();
  const claude = async () => ({ code: 1, stdout: "", stderr: "boom" });
  await autoReviewOnce(db, { exec: claude, shellExec: ghDiff });
  await autoReviewOnce(db, { exec: claude, shellExec: ghDiff });
  expect(events(db, id, "auto_review_error")).toHaveLength(1);
  expect((db.query("SELECT state FROM tasks WHERE id = ?").get(id) as any).state).toBe("in_review");
});

test("unparseable model output retries once, then a second unparseable attempt records a verdict, not just an error", async () => {
  const { db, id } = setup();
  let calls = 0;
  const claude = async () => {
    calls++;
    return { code: 0, stdout: "sorry, I can't help with that", stderr: "" };
  };
  await autoReviewOnce(db, { exec: claude, shellExec: ghDiff });
  expect(calls).toBe(2); // one attempt, one retry
  expect(events(db, id, "auto_review_error")).toHaveLength(0);
  const revs = events(db, id, "auto_review");
  expect(revs).toHaveLength(1);
  expect(revs[0].payload.verdict).toBe("unparseable");
  expect(revs[0].payload).toMatchObject({ reviewed_pr_url: "https://gh/pr/5", reviewed_head_sha: "review-head" });

  await autoReviewOnce(db, { exec: claude, shellExec: ghDiff }); // no third attempt, same head
  expect(calls).toBe(2);
  expect(events(db, id, "auto_review")).toHaveLength(1);
});

test("a retry that succeeds posts a normal review, not an unparseable verdict", async () => {
  const { db, id } = setup();
  let calls = 0;
  const claude = async () => {
    calls++;
    return calls === 1
      ? { code: 0, stdout: "not json", stderr: "" }
      : { code: 0, stdout: JSON.stringify({ verdict: "looks_good", summary: "fine", risks: [], questions: [] }), stderr: "" };
  };
  await autoReviewOnce(db, { exec: claude, shellExec: ghDiff });
  expect(calls).toBe(2);
  const revs = events(db, id, "auto_review");
  expect(revs).toHaveLength(1);
  expect(revs[0].payload.verdict).toBe("looks_good");
});

test("project opt-out records a skip", async () => {
  const { db, id } = setup({ auto_review: false });
  const claude = async () => { throw new Error("should not run"); };
  await autoReviewOnce(db, { exec: claude as any, shellExec: ghDiff });
  expect(events(db, id, "auto_review")[0].payload.skipped).toContain("disabled");
});

test("a never-dispatched external task in review is skipped, not auto-reviewed", async () => {
  const { db, id } = setup({}, { source: "external" });
  const claude = async () => { throw new Error("should not run"); };
  await autoReviewOnce(db, { exec: claude as any, shellExec: ghDiff });
  expect(events(db, id, "auto_review")).toHaveLength(0);
  expect(events(db, id, "auto_review_error")).toHaveLength(0);
});

test("an external task that WAS spawned before (agent_target set, real hive-driven work) is still auto-reviewed", async () => {
  const { db, id } = setup({}, { source: "external", agent_target: "t-live" });
  writeEvent(db, { task_id: id, source: "herdr", type: "spawned", payload: { agent_target: "t-live" } });
  const claude = async () => ({
    code: 0,
    stdout: JSON.stringify({ result: '{"verdict":"looks_good","summary":"fine","risks":[],"questions":[]}' }),
    stderr: "",
  });
  await autoReviewOnce(db, { exec: claude, shellExec: ghDiff });
  expect(events(db, id, "auto_review")).toHaveLength(1);
});

test("extractReview parses whole JSON, envelope, and prose-wrapped output", () => {
  const body = '{"verdict":"looks_good","summary":"fine","risks":[],"questions":[]}';
  expect(extractReview(body)?.summary).toBe("fine");
  expect(extractReview(JSON.stringify({ result: body }))?.verdict).toBe("looks_good");
  expect(extractReview(`Sure! Here you go:\n${body}\nHope that helps.`)?.summary).toBe("fine");
  expect(extractReview("no json at all")).toBeNull();
});

// --- per-risk adversarial verification (task HIVE-406) ---------------------

const { verifyRisks, extractVerdict, extractAnswer, ambiguityCleared, confirmedRisks, verifyPendingOnce } = await import("../src/reviewer.ts");

// A pre-review that flags `n` risks, so autoReviewOnce triggers verification.
const cautionWith = (risks: string[]) =>
  JSON.stringify({ result: JSON.stringify({ verdict: "caution", summary: "risky", risks, questions: [] }) });

test("caution risks each get a verification run, capped at 5", async () => {
  const { db, id } = setup();
  const argvs: string[][] = [];
  const claude = async (argv: string[]) => {
    argvs.push(argv);
    return argv.includes("opus")
      ? { code: 0, stdout: JSON.stringify({ result: '{"verdict":"refuted","why":"guarded upstream","evidence_path":"x.ts:3"}' }), stderr: "" }
      : { code: 0, stdout: cautionWith(["r1", "r2", "r3", "r4", "r5", "r6", "r7"]), stderr: "" };
  };
  await autoReviewOnce(db, { exec: claude, shellExec: ghDiff });

  const opusRuns = argvs.filter((a) => a.includes("opus"));
  expect(opusRuns).toHaveLength(5); // 7 risks in, 5 verified
  expect(opusRuns[0].join(" ")).toContain("r1"); // the risk text reaches the prompt
  expect(opusRuns[0].join(" ")).toContain("--output-format json");

  const evs = events(db, id, "risk_verdicts");
  expect(evs).toHaveLength(1);
  expect(evs[0].payload.reviewed_head_sha).toBe("review-head");
  expect(evs[0].payload.verdicts).toHaveLength(5);
  expect(evs[0].payload.verdicts[0]).toEqual({ risk: "r1", verdict: "refuted", why: "guarded upstream", evidence_path: "x.ts:3" });
});

test("a clean looks_good review with no notes verifies nothing", async () => {
  const { db, id } = setup();
  const claude = async (argv: string[]) => {
    if (argv.includes("opus")) throw new Error("should not verify");
    return { code: 0, stdout: JSON.stringify({ result: '{"verdict":"looks_good","summary":"fine","risks":[],"questions":[]}' }), stderr: "" };
  };
  await autoReviewOnce(db, { exec: claude, shellExec: ghDiff });
  expect(events(db, id, "risk_verdicts")).toHaveLength(0);
});

// HIVE-407: the pre-reviewer almost always writes at least one soft note, and
// a looks_good-with-notes review used to veto its own auto-merge forever.
test("a looks_good review with a soft risk or question is still verified", async () => {
  const { db, id } = setup();
  const claude = async (argv: string[]) =>
    argv.includes("opus")
      ? {
          code: 0,
          stdout: argv.join(" ").includes("q1")
            ? JSON.stringify({ result: '{"answerable":"machine","answer":"yes, line 4 covers it"}' })
            : JSON.stringify({ result: '{"verdict":"refuted","why":"guarded upstream"}' }),
          stderr: "",
        }
      : { code: 0, stdout: JSON.stringify({ result: '{"verdict":"looks_good","summary":"fine","risks":["nit"],"questions":["q1"]}' }), stderr: "" };
  await autoReviewOnce(db, { exec: claude, shellExec: ghDiff });
  const p = events(db, id, "risk_verdicts")[0].payload;
  expect(p.verdicts).toEqual([{ risk: "nit", verdict: "refuted", why: "guarded upstream" }]);
  expect(p.question_verdicts).toEqual([{ question: "q1", answerable: "machine", answer: "yes, line 4 covers it" }]);
});

test("a question only the human can answer is recorded as human-only", async () => {
  const { db, id } = setup();
  const claude = async () => ({ code: 0, stdout: JSON.stringify({ result: '{"answerable":"human","answer":"check the installed app"}' }), stderr: "" });
  const task: any = db.query("SELECT * FROM tasks WHERE id = ?").get(id);
  await verifyRisks(db, task, { questions: ["did you verify on the installed app?"], head: "head-a", diff: "d" }, { exec: claude });
  expect(events(db, id, "risk_verdicts")[0].payload.question_verdicts[0].answerable).toBe("human");
});

test("a verdict set is not written when the head moved during verification", async () => {
  const { db, id } = setup();
  const claude = async () => ({ code: 0, stdout: JSON.stringify({ result: '{"verdict":"refuted","why":"no"}' }), stderr: "" });
  const task: any = db.query("SELECT * FROM tasks WHERE id = ?").get(id);
  let calls = 0;
  await verifyRisks(
    db,
    task,
    { risks: ["r1", "r2"], head: "head-a", diff: "d", stillCurrent: () => ++calls <= 1 },
    { exec: claude }
  );
  expect(events(db, id, "risk_verdicts")).toHaveLength(0);
});

test("ambiguityCleared: all refuted and machine-answered clears; anything else does not", async () => {
  const { db, id } = setup();
  const task: any = db.query("SELECT * FROM tasks WHERE id = ?").get(id);
  const refuted = async () => ({ code: 0, stdout: JSON.stringify({ result: '{"verdict":"refuted","why":"no"}' }), stderr: "" });

  expect(ambiguityCleared(db, id, "head-a", { risks: [], questions: [] })).toBe(true); // nothing to clear
  expect(ambiguityCleared(db, id, "head-a", { risks: ["r1"], questions: [] })).toBe(false); // never verified

  await verifyRisks(db, task, { risks: ["r1"], head: "head-a", diff: "d" }, { exec: refuted });
  expect(ambiguityCleared(db, id, "head-a", { risks: ["r1"], questions: [] })).toBe(true);
  expect(ambiguityCleared(db, id, "head-b", { risks: ["r1"], questions: [] })).toBe(false); // stale head ignored
  expect(ambiguityCleared(db, id, "head-a", { risks: ["r1", "r2"], questions: [] })).toBe(false); // uncovered risk

  const confirmedExec = async () => ({ code: 0, stdout: JSON.stringify({ result: '{"verdict":"confirmed","why":"real"}' }), stderr: "" });
  await verifyRisks(db, task, { risks: ["r1"], head: "head-c", diff: "d" }, { exec: confirmedExec });
  expect(ambiguityCleared(db, id, "head-c", { risks: ["r1"], questions: [] })).toBe(false);
  expect(confirmedRisks(db, id, "head-c").map((c: any) => c.risk)).toEqual(["r1"]);
  expect(confirmedRisks(db, id, "head-a")).toEqual([]);
});

test("extractAnswer parses envelope and prose, and rejects anything else", () => {
  const body = '{"answerable":"machine","answer":"line 4"}';
  expect(extractAnswer(JSON.stringify({ result: body }))?.answerable).toBe("machine");
  expect(extractAnswer(`Here: ${body} done`)?.answer).toBe("line 4");
  expect(extractAnswer('{"answerable":"maybe","answer":"hm"}')).toBeNull();
  expect(extractAnswer("no json")).toBeNull();
});

test("verification is keyed to the reviewed head: same head skips, new head re-runs", async () => {
  const { db, id } = setup();
  let calls = 0;
  const claude = async () => {
    calls++;
    return { code: 0, stdout: JSON.stringify({ result: '{"verdict":"confirmed","why":"real"}' }), stderr: "" };
  };
  const task: any = db.query("SELECT * FROM tasks WHERE id = ?").get(id);

  await verifyRisks(db, task, { risks: ["r1"], head: "head-a", diff: "diff" }, { exec: claude });
  await verifyRisks(db, task, { risks: ["r1"], head: "head-a", diff: "diff" }, { exec: claude }); // same head — no second run
  expect(calls).toBe(1);
  expect(events(db, id, "risk_verdicts")).toHaveLength(1);

  await verifyRisks(db, task, { risks: ["r1"], head: "head-b", diff: "diff" }, { exec: claude }); // new head — runs again
  expect(calls).toBe(2);
  expect(events(db, id, "risk_verdicts").map((e: any) => e.payload.reviewed_head_sha).sort()).toEqual(["head-a", "head-b"]);
});

test("a re-review at the same head re-verifies when the risk list grew", async () => {
  const { db, id } = setup();
  let calls = 0;
  const claude = async () => {
    calls++;
    return { code: 0, stdout: JSON.stringify({ result: '{"verdict":"refuted","why":"checked"}' }), stderr: "" };
  };
  const task: any = db.query("SELECT * FROM tasks WHERE id = ?").get(id);

  // First review at this head raised two risks.
  await verifyRisks(db, task, { risks: ["r1", "r2"], head: "head-a", diff: "diff" }, { exec: claude });
  expect(calls).toBe(2);

  // Overlapping reconciler laps write a SECOND auto_review for the same head,
  // and it raises a third risk plus a question. The stored set no longer covers
  // the review, so it must not be reused — otherwise ambiguityCleared compares
  // 2 verdicts against 3 risks forever and the task parks with no card.
  // One exec for both prompt kinds: the question pass wants an `answerable`,
  // the risk pass wants a `verdict`.
  const answer = async (argv: string[]) => {
    calls++;
    const prompt = argv[4] ?? "";
    const result = prompt.includes("q1")
      ? '{"answerable":"machine","answer":"yes"}'
      : '{"verdict":"refuted","why":"checked"}';
    return { code: 0, stdout: JSON.stringify({ result }), stderr: "" };
  };
  await verifyRisks(db, task, { risks: ["r1", "r2", "r3"], questions: ["q1"], head: "head-a", diff: "diff" }, { exec: answer });
  expect(calls).toBe(6); // 2 + 4 (three risks and one question re-run)

  const latest: any = events(db, id, "risk_verdicts").at(-1);
  expect(latest.payload.verdicts).toHaveLength(3);
  expect(latest.payload.question_verdicts).toHaveLength(1);
  expect(ambiguityCleared(db, id, "head-a", { risks: ["r1", "r2", "r3"], questions: ["q1"] })).toBe(true);

  // A repeat of that same review is still deduped.
  await verifyRisks(db, task, { risks: ["r1", "r2", "r3"], questions: ["q1"], head: "head-a", diff: "diff" }, { exec: answer });
  expect(calls).toBe(6);
});

test("a failed verification run is counted, never reported as an all-clear", async () => {
  const { db, id } = setup();
  const claude = async () => ({ code: 1, stdout: "", stderr: "boom" });
  const task: any = db.query("SELECT * FROM tasks WHERE id = ?").get(id);
  await verifyRisks(db, task, { risks: ["r1", "r2"], head: "head-a", diff: "diff" }, { exec: claude });
  const p = events(db, id, "risk_verdicts")[0].payload;
  expect(p.verdicts).toEqual([]);
  expect(p.unverified).toBe(2);
});

test("extractVerdict parses envelope and prose, and rejects anything else", () => {
  const body = '{"verdict":"confirmed","why":"y is unused"}';
  expect(extractVerdict(JSON.stringify({ result: body }))?.verdict).toBe("confirmed");
  expect(extractVerdict(`Here: ${body} done`)?.why).toBe("y is unused");
  expect(extractVerdict('{"verdict":"maybe","why":"hm"}')).toBeNull();
  expect(extractVerdict("no json")).toBeNull();
});

// --- the standalone verification pass -------------------------------------

test("verifyPendingOnce verifies a review autoReviewOnce will never revisit", async () => {
  const { db, id } = setup();
  db.query("UPDATE tasks SET state = 'in_review', head_sha = 'review-head' WHERE id = ?").run(id);
  // A review that raises risks but whose verification never produced verdicts —
  // autoReviewOnce skips this task (it already has an auto_review at this head),
  // so before this pass existed nothing could ever cover it.
  writeEvent(db, {
    task_id: id,
    source: "system",
    type: "auto_review",
    payload: { verdict: "caution", summary: "s", risks: ["r1", "r2"], questions: [], reviewed_head_sha: "review-head" },
  });
  expect(events(db, id, "risk_verdicts")).toHaveLength(0);

  const claude = async () => ({
    code: 0,
    stdout: JSON.stringify({ result: '{"verdict":"refuted","why":"checked"}' }),
    stderr: "",
  });
  await verifyPendingOnce(db, { exec: claude, shellExec: ghDiff });

  const [verdicts] = events(db, id, "risk_verdicts");
  expect(verdicts.payload.verdicts).toHaveLength(2);
  expect(ambiguityCleared(db, id, "review-head", { risks: ["r1", "r2"], questions: [] })).toBe(true);

  // Already covered now, so a second pass is a no-op.
  await verifyPendingOnce(db, { exec: claude, shellExec: ghDiff });
  expect(events(db, id, "risk_verdicts")).toHaveLength(1);
});

test("verifyPendingOnce leaves alone a review whose verdicts already cover it", async () => {
  const { db, id } = setup();
  db.query("UPDATE tasks SET state = 'in_review', head_sha = 'review-head' WHERE id = ?").run(id);
  writeEvent(db, {
    task_id: id,
    source: "system",
    type: "auto_review",
    payload: { verdict: "caution", summary: "s", risks: ["r1"], questions: [], reviewed_head_sha: "review-head" },
  });
  writeEvent(db, {
    task_id: id,
    source: "system",
    type: "risk_verdicts",
    payload: { reviewed_head_sha: "review-head", verdicts: [{ risk: "r1", verdict: "refuted" }] },
  });
  const claude = async () => { throw new Error("should not run"); };
  await verifyPendingOnce(db, { exec: claude as any, shellExec: ghDiff });
  expect(events(db, id, "risk_verdicts")).toHaveLength(1);
});
