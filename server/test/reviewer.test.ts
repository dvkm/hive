// Auto-reviewer: pre-review posted onto the review card as an auto_review event.
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "hive-reviewer-"));
process.env.HIVE_HOME = HOME;

const { openDb, newId, now } = await import("../src/db.ts");
const { autoReviewOnce, extractReview, MAX_REVIEW_ATTEMPTS } = await import("../src/reviewer.ts");
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

const { verifyRisks, extractVerdict, extractAnswer, ambiguityCleared, confirmedRisks, unfinishedRiskCheck, verifyPendingOnce, requestRiskRecheck } =
  await import("../src/reviewer.ts");

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

// HIVE-571: the risk check re-raised product questions the director had
// already ruled on, because it never read the task's answered decisions.
function answerDecision(db: DB, taskId: string, title: string, at: string) {
  db.query(
    "INSERT INTO decisions (id, task_id, ts, title, options, status, answer_key, answer_note, answered_at) VALUES (?,?,?,?,?, 'answered', 'stack', ?, ?)"
  ).run(
    newId("dec"),
    taskId,
    at,
    title,
    JSON.stringify([{ key: "stack", label: "Vertical stack in one modal" }]),
    "banners are fixed-size creatives",
    at
  );
}

test("an answered decision reaches the risk prompt, with the branch commits that could revive it", async () => {
  const { db, id } = setup({}, { branch: "hive/banners" });
  answerDecision(db, id, "One modal or separate windows?", "2026-08-31T10:00:00Z");
  const prompts: string[] = [];
  const claude = async (argv: string[]) => {
    prompts.push(argv[4] ?? "");
    return { code: 0, stdout: JSON.stringify({ result: '{"verdict":"refuted","why":"settled: chose Vertical stack in one modal on 2026-08-31"}' }), stderr: "" };
  };
  const git: Exec = async () => ({ code: 0, stdout: "aaa1111 2026-08-31T09:00:00Z build the stacked modal\nbbb2222 2026-09-01T02:00:00Z autoplay every banner", stderr: "" });
  const task: any = db.query("SELECT * FROM tasks WHERE id = ?").get(id);

  await verifyRisks(db, task, { risks: ["stack vs separate windows is only one reading"], head: "head-a", diff: "d" }, { exec: claude, shellExec: git });

  const p = prompts[0];
  expect(p).toContain("ALREADY ruled");
  expect(p).toContain("One modal or separate windows? → chose: Vertical stack in one modal");
  expect(p).toContain("answered 2026-08-31");
  expect(p).toContain("Answer 'refuted'");
  // The commit made AFTER the ruling is in the prompt, so a NEW behaviour is
  // still confirmable rather than waved through by the old answer.
  expect(p).toContain("bbb2222 2026-09-01T02:00:00Z autoplay every banner");
  expect(p).toContain("name that commit");

  // The reader sees the answer on the finding instead of re-litigating it.
  expect(events(db, id, "risk_verdicts")[0].payload.verdicts[0]).toMatchObject({
    verdict: "refuted",
    why: "settled: chose Vertical stack in one modal on 2026-08-31",
  });
});

test("a risk about behaviour added after the ruling is still confirmed", async () => {
  const { db, id } = setup({}, { branch: "hive/banners" });
  answerDecision(db, id, "One modal or separate windows?", "2026-08-31T10:00:00Z");
  const claude = async () => ({
    code: 0,
    stdout: JSON.stringify({ result: '{"verdict":"confirmed","why":"bbb2222, made after the ruling, autoplays every banner"}' }),
    stderr: "",
  });
  const git: Exec = async () => ({ code: 0, stdout: "bbb2222 2026-09-01T02:00:00Z autoplay every banner", stderr: "" });
  const task: any = db.query("SELECT * FROM tasks WHERE id = ?").get(id);

  await verifyRisks(db, task, { risks: ["autoplay fights the fixed-size creative"], head: "head-a", diff: "d" }, { exec: claude, shellExec: git });
  expect(confirmedRisks(db, id, "head-a").map((c: any) => c.risk)).toEqual(["autoplay fights the fixed-size creative"]);
});

test("a task with no answered decision still gets the repair block, but no settled-decision section", async () => {
  const { db, id } = setup();
  const prompts: string[] = [];
  const claude = async (argv: string[]) => {
    prompts.push(argv[4] ?? "");
    return { code: 0, stdout: JSON.stringify({ result: '{"verdict":"refuted","why":"no"}' }), stderr: "" };
  };
  const git: Exec = async () => {
    throw new Error("no decisions: nothing to date-check against");
  };
  const task: any = db.query("SELECT * FROM tasks WHERE id = ?").get(id);
  await verifyRisks(db, task, { risks: ["r1"], head: "head-a", diff: "d" }, { exec: claude, shellExec: git });
  expect(prompts[0]).not.toContain("ALREADY ruled");
  expect(prompts[0]).toContain("AFTER this work landed on it"); // repairBlock still applies
});

// HIVE-587: repair work always looks clean at review time, so the judge was
// told the state it sees is the work's own output.
test("the verify prompt says the branch it reads already contains this work", async () => {
  const { db, id } = setup({}, { branch: "hive/stale" });
  const prompts: string[] = [];
  const claude = async (argv: string[]) => {
    prompts.push(argv[4] ?? "");
    return { code: 0, stdout: JSON.stringify({ result: '{"verdict":"refuted","why":"the merge under review is what made it current"}' }), stderr: "" };
  };
  const gitArgs: string[][] = [];
  const git: Exec = async (argv) => {
    gitArgs.push(argv);
    return { code: 0, stdout: "60e3c7a0 2026-09-01T10:00:00Z Merge main into hive/stale", stderr: "" };
  };
  const task: any = db.query("SELECT * FROM tasks WHERE id = ?").get(id);

  await verifyRisks(db, task, { risks: ["the branch is 0 commits behind main, so the premise was stale"], head: "head-a", diff: "d" }, { exec: claude, shellExec: git });

  const p = prompts[0];
  expect(p).toContain("AFTER this work landed on it");
  expect(p).toContain("60e3c7a0 2026-09-01T10:00:00Z Merge main into hive/stale"); // the merge is listed
  expect(p).toContain("answer 'refuted'");
  expect(p).not.toContain("ALREADY ruled"); // no decisions on this task
  expect(gitArgs[0]).not.toContain("--no-merges"); // a repair merge must not be filtered out
  expect(events(db, id, "risk_verdicts")[0].payload.verdicts[0].verdict).toBe("refuted");
});

// HIVE-603: the risk check read only the commit, so a PR whose evidence proved
// the work was done was blocked twice for not evidencing it, with no way out.
function addEvidence(db: DB, taskId: string, caption: string, sha: string | null, kind = "text") {
  db.query("INSERT INTO evidence (id, task_id, ts, kind, path, url, caption, meta) VALUES (?,?,?,?,?,?,?,?)").run(
    newId("ev"), taskId, now(), kind, null, null, caption, JSON.stringify(sha ? { commit_sha: sha } : {})
  );
}

test("evidence attached to the task reaches the risk prompt, stamped with the commit it came from", async () => {
  const { db, id } = setup();
  addEvidence(db, id, "24 valid full-suite runs, lease test clean in all", "head-a");
  addEvidence(db, id, "screenshot from an older build", "head-old", "screenshot");
  addEvidence(db, id, "a production reading", null, "observation");
  const prompts: string[] = [];
  const claude = async (argv: string[]) => {
    prompts.push(argv[4] ?? "");
    return { code: 0, stdout: JSON.stringify({ result: '{"verdict":"refuted","why":"evidence: 24 valid full-suite runs"}' }), stderr: "" };
  };
  const git: Exec = async () => ({ code: 0, stdout: "aaa1111 2026-09-01T09:00:00Z fix the lease", stderr: "" });
  const task: any = db.query("SELECT * FROM tasks WHERE id = ?").get(id);

  await verifyRisks(db, task, { risks: ["the commit does not evidence 20 consecutive runs"], head: "head-a", diff: "d" }, { exec: claude, shellExec: git });

  const p = prompts[0];
  expect(p).toContain("24 valid full-suite runs, lease test clean in all [text, captured on the commit under review]");
  expect(p).toContain("screenshot from an older build [screenshot, captured on an earlier commit]");
  expect(p).toContain("a production reading [observation, not tied to a commit]");
  expect(p).toContain("Answer 'refuted'");
  // A caption never absolves the code itself.
  expect(p).toContain("A defect you can point at in the code stays");
  expect(events(db, id, "risk_verdicts")[0].payload.verdicts[0].verdict).toBe("refuted");
});

test("a task with no evidence gets no evidence block", async () => {
  const { db, id } = setup();
  const prompts: string[] = [];
  const claude = async (argv: string[]) => {
    prompts.push(argv[4] ?? "");
    return { code: 0, stdout: JSON.stringify({ result: '{"verdict":"confirmed","why":"nothing shows it ran"}' }), stderr: "" };
  };
  const git: Exec = async () => ({ code: 0, stdout: "", stderr: "" });
  const task: any = db.query("SELECT * FROM tasks WHERE id = ?").get(id);
  await verifyRisks(db, task, { risks: ["r1"], head: "head-a", diff: "d" }, { exec: claude, shellExec: git });
  expect(prompts[0]).not.toContain("attached this evidence");
});

test("the question prompt sees the same evidence, told to answer from it", async () => {
  const { db, id } = setup();
  addEvidence(db, id, "ran the suite 24 times, no flake", "head-a");
  const prompts: string[] = [];
  const claude = async (argv: string[]) => {
    prompts.push(argv[4] ?? "");
    return { code: 0, stdout: JSON.stringify({ result: '{"answerable":"machine","answer":"evidence: ran the suite 24 times, no flake"}' }), stderr: "" };
  };
  const git: Exec = async () => ({ code: 0, stdout: "", stderr: "" });
  const task: any = db.query("SELECT * FROM tasks WHERE id = ?").get(id);

  await verifyRisks(db, task, { questions: ["was this run enough times to trust it?"], head: "head-a", diff: "d" }, { exec: claude, shellExec: git });

  const p = prompts[0];
  expect(p).toContain("ran the suite 24 times, no flake [text, captured on the commit under review]");
  expect(p).toContain('say "machine" and quote the caption');
  expect(p).not.toContain("Answer 'refuted'"); // risk vocabulary stays out of the question prompt
  expect(events(db, id, "risk_verdicts")[0].payload.question_verdicts[0].answerable).toBe("machine");
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
  expect(calls).toBe(4); // 2 + 2: r1/r2 already have verdicts at this head, only r3 and q1 run

  const latest: any = events(db, id, "risk_verdicts").at(-1);
  expect(latest.payload.verdicts).toHaveLength(3);
  expect(latest.payload.question_verdicts).toHaveLength(1);
  expect(ambiguityCleared(db, id, "head-a", { risks: ["r1", "r2", "r3"], questions: ["q1"] })).toBe(true);

  // A repeat of that same review is still deduped.
  await verifyRisks(db, task, { risks: ["r1", "r2", "r3"], questions: ["q1"], head: "head-a", diff: "diff" }, { exec: answer });
  expect(calls).toBe(4);
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

// HIVE-497: a failed pre-review used to retire the card at that head forever.
// Any blip (model timeout, rate limit, expired login) took the task out of the
// review queue permanently, and 31 of 36 cards ended up stuck that way.
const ageEvents = (db: DB, id: string) =>
  db.query("UPDATE events SET ts = ? WHERE task_id = ? AND type = 'auto_review_error'").run(
    new Date(Date.now() - 6 * 3600_000).toISOString(),
    id
  );

test("a failed pre-review is retried once the backoff has passed, and can then succeed", async () => {
  const { db, id } = setup();
  const failing = async () => ({ code: 1, stdout: "", stderr: "boom" });
  const ok = async () => ({
    code: 0,
    stdout: JSON.stringify({ result: '{"verdict":"looks_good","summary":"fine","risks":[],"questions":[]}' }),
    stderr: "",
  });
  await autoReviewOnce(db, { exec: failing, shellExec: ghDiff });
  await autoReviewOnce(db, { exec: failing, shellExec: ghDiff }); // inside backoff: no retry
  expect(events(db, id, "auto_review_error")).toHaveLength(1);
  ageEvents(db, id);
  await autoReviewOnce(db, { exec: ok, shellExec: ghDiff });
  expect(events(db, id, "auto_review")).toHaveLength(1);
});

test("an auth outage never spends the retry budget, so those cards free themselves", async () => {
  const { db, id } = setup();
  const notLoggedIn = async () => ({
    code: 1,
    stdout: JSON.stringify({ is_error: true, result: "Not logged in - Please run /login" }),
    stderr: "",
  });
  for (let i = 0; i < MAX_REVIEW_ATTEMPTS + 1; i++) {
    await autoReviewOnce(db, { exec: notLoggedIn, shellExec: ghDiff });
    ageEvents(db, id);
  }
  const errs = events(db, id, "auto_review_error");
  expect(errs.length).toBe(MAX_REVIEW_ATTEMPTS + 1);
  expect(errs.some((e: any) => e.payload.gave_up)).toBe(false);
  const ok = async () => ({
    code: 0,
    stdout: JSON.stringify({ result: '{"verdict":"looks_good","summary":"fine","risks":[],"questions":[]}' }),
    stderr: "",
  });
  await autoReviewOnce(db, { exec: ok, shellExec: ghDiff });
  expect(events(db, id, "auto_review")).toHaveLength(1);
});

test("after the retry budget runs out the card is flagged for a human, not silently skipped", async () => {
  const { db, id } = setup();
  const failing = async () => ({ code: 1, stdout: "", stderr: "boom" });
  for (let i = 0; i < MAX_REVIEW_ATTEMPTS + 2; i++) {
    await autoReviewOnce(db, { exec: failing, shellExec: ghDiff });
    ageEvents(db, id);
  }
  const errs = events(db, id, "auto_review_error");
  expect(errs).toHaveLength(MAX_REVIEW_ATTEMPTS); // stops trying at the cap
  expect(errs[MAX_REVIEW_ATTEMPTS - 1].payload.gave_up).toBe(true);
  const notes: any[] = db.query("SELECT title FROM notifications WHERE task_id = ? AND kind = 'failed'").all(id);
  expect(notes).toHaveLength(1);
  expect(notes[0].title).toContain("gave up");
});

// HIVE-567: 15 timeouts across 4 PRs left every one of those cards with NO
// verdict at all, so a task hive had given up on looked exactly like one it
// simply had not reached yet.
test("giving up leaves a visible terminal verdict, not silence", async () => {
  const { db, id } = setup();
  const failing = async () => ({ code: 1, stdout: "", stderr: "timed out after 180000ms" });
  for (let i = 0; i < MAX_REVIEW_ATTEMPTS + 2; i++) {
    await autoReviewOnce(db, { exec: failing, shellExec: ghDiff });
    ageEvents(db, id);
  }
  const revs = events(db, id, "auto_review");
  expect(revs).toHaveLength(1);
  expect(revs[0].payload.verdict).toBe("unavailable");
  expect(revs[0].payload.summary).toContain("could not complete");
  expect(revs[0].payload.reviewed_head_sha).toBe("review-head");
  // Never a pass: no auto-merge path may read this as a reviewed, clean PR.
  expect(revs[0].payload.verdict).not.toBe("looks_good");
});

// HIVE-567: four identical 180s runs was three wasted ones. Two tries, and the
// second reads a much shorter diff.
test("the one retry is smaller than the first attempt, and there is no third", async () => {
  const { db, id } = setup();
  const bigDiff: Exec = async (argv) =>
    argv.includes("diff")
      ? { code: 0, stdout: "+x\n".repeat(30_000), stderr: "" }
      : { code: 0, stdout: JSON.stringify({ headRefOid: "review-head" }), stderr: "" };
  const prompts: number[] = [];
  const failing = async (argv: string[]) => {
    prompts.push(argv[4]!.length);
    return { code: 1, stdout: "", stderr: "timed out after 180000ms" };
  };
  for (let i = 0; i < 4; i++) {
    await autoReviewOnce(db, { exec: failing, shellExec: bigDiff });
    ageEvents(db, id);
  }
  expect(prompts).toHaveLength(2); // no third attempt
  expect(prompts[1]).toBeLessThan(prompts[0]! / 2);
});

// HIVE-539: a run that times out is "I do not know", never "I checked and it is
// bad" — and the verdicts it DID produce must survive the ones that did not.
test("a timed-out verification keeps the verdicts it got and retries only the gaps", async () => {
  const { db, id } = setup();
  const task: any = db.query("SELECT * FROM tasks WHERE id = ?").get(id);
  const review = { risks: ["r1", "r2"], questions: [] };

  // Pass one: r1 answers, r2 times out.
  const half: Exec = async (argv: string[]) =>
    (argv[4] ?? "").includes("r1")
      ? { code: 0, stdout: JSON.stringify({ result: '{"verdict":"refuted","why":"checked"}' }), stderr: "" }
      : ({ code: 124, stdout: "", stderr: "", timedOut: true } as any);
  await verifyRisks(db, task, { ...review, head: "head-a", diff: "d" }, { exec: half });
  let latest: any = events(db, id, "risk_verdicts").at(-1);
  expect(latest.payload.verdicts).toHaveLength(1);
  expect(latest.payload.unverified).toBe(1);

  // Nothing was confirmed, so the merge gate must not read a confirmed risk —
  // it reads an unfinished check instead.
  expect(confirmedRisks(db, id, "head-a")).toHaveLength(0);
  expect(unfinishedRiskCheck(db, id, "head-a")).toMatchObject({ unverified: 1, checked: 1 });
  expect(ambiguityCleared(db, id, "head-a", review)).toBe(false);

  // Pass two: only the gap re-runs, and the earlier verdict is carried forward.
  let asked: string[] = [];
  const rest: Exec = async (argv: string[]) => {
    asked.push(argv[4] ?? "");
    return { code: 0, stdout: JSON.stringify({ result: '{"verdict":"refuted","why":"checked"}' }), stderr: "" };
  };
  await verifyRisks(db, task, { ...review, head: "head-a", diff: "d" }, { exec: rest });
  expect(asked).toHaveLength(1);
  expect(asked[0]).toContain("r2");
  latest = events(db, id, "risk_verdicts").at(-1);
  expect(latest.payload.verdicts.map((v: any) => v.risk).sort()).toEqual(["r1", "r2"]);
  expect(latest.payload.unverified).toBeUndefined();
  expect(unfinishedRiskCheck(db, id, "head-a")).toBeNull();
  expect(ambiguityCleared(db, id, "head-a", review)).toBe(true);
});

test("verification retries are capped, so a finding that never fits stops burning the model", async () => {
  const { db, id } = setup();
  const task: any = db.query("SELECT * FROM tasks WHERE id = ?").get(id);
  let calls = 0;
  const timeout: Exec = async () => {
    calls++;
    return { code: 124, stdout: "", stderr: "", timedOut: true } as any;
  };
  for (let i = 0; i < 6; i++) await verifyRisks(db, task, { risks: ["r1"], head: "head-a", diff: "d" }, { exec: timeout });
  expect(calls).toBe(3); // MAX_VERIFY_ATTEMPTS
  expect(events(db, id, "risk_verdicts")).toHaveLength(3);
});

test("two verification passes for one head never overlap", async () => {
  const { db, id } = setup();
  const task: any = db.query("SELECT * FROM tasks WHERE id = ?").get(id);
  let inFlight = 0;
  let maxInFlight = 0;
  const slow: Exec = async () => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 20));
    inFlight--;
    return { code: 0, stdout: JSON.stringify({ result: '{"verdict":"refuted","why":"ok"}' }), stderr: "" };
  };
  await Promise.all([
    verifyRisks(db, task, { risks: ["r1"], head: "head-a", diff: "d" }, { exec: slow }),
    verifyRisks(db, task, { risks: ["r1"], head: "head-a", diff: "d" }, { exec: slow }),
  ]);
  expect(maxInFlight).toBe(1);
  expect(events(db, id, "risk_verdicts")).toHaveLength(1);
});

test("an emptier later pass never loses the verdicts an earlier pass produced", async () => {
  const { db, id } = setup();
  const task: any = db.query("SELECT * FROM tasks WHERE id = ?").get(id);
  // What the old code wrote: a good set, then a pass that timed out on everything.
  for (const payload of [
    { reviewed_head_sha: "head-a", verdicts: [{ risk: "r1", verdict: "refuted", why: "checked" }], unverified: 1 },
    { reviewed_head_sha: "head-a", verdicts: [], unverified: 2, unverified_reason: "timed out after 180000ms" },
  ])
    writeEvent(db, { task_id: id, source: "system", type: "risk_verdicts", payload: payload as any });

  let asked: string[] = [];
  const claude: Exec = async (argv: string[]) => {
    asked.push(argv[4] ?? "");
    return { code: 0, stdout: JSON.stringify({ result: '{"verdict":"refuted","why":"checked"}' }), stderr: "" };
  };
  await verifyRisks(db, task, { risks: ["r1", "r2"], head: "head-a", diff: "d" }, { exec: claude });
  expect(asked).toHaveLength(1); // r1's verdict survived the empty pass
  expect(asked[0]).toContain("r2");
  const latest: any = events(db, id, "risk_verdicts").at(-1);
  expect(latest.payload.verdicts.map((v: any) => v.risk)).toEqual(["r1", "r2"]);
});

// HIVE-588: a verdict the director has refuted must stop being read, but only
// for the commit it was recorded on — and a fresh pass on that same commit has
// to count again, or the PR could never merge afterwards.
test("a recheck sets aside the verdicts stored for that head, and only that head", async () => {
  const { db, id } = setup();
  const verdict = (head: string) => ({
    reviewed_head_sha: head,
    verdicts: [{ risk: "export drops rows", why: "the CSV writer skips the last page", verdict: "confirmed" }],
  });
  writeEvent(db, { task_id: id, source: "system", type: "risk_verdicts", payload: verdict("head-1") });
  writeEvent(db, { task_id: id, source: "system", type: "risk_verdicts", payload: verdict("head-2") });
  expect(confirmedRisks(db, id, "head-1")).toHaveLength(1);

  requestRiskRecheck(db, id, "head-1", "the finding cites code from before the fix landed");
  expect(confirmedRisks(db, id, "head-1")).toHaveLength(0);
  // A different commit's verdict is untouched: the ruling was about one finding
  // on one commit, not about the risk check in general.
  expect(confirmedRisks(db, id, "head-2")).toHaveLength(1);

  // The re-run happens and confirms the risk again — that verdict is newer than
  // the ruling, so it counts, and the merge stays blocked. Not an override.
  writeEvent(db, { task_id: id, source: "system", type: "risk_verdicts", payload: verdict("head-1") });
  expect(confirmedRisks(db, id, "head-1")).toHaveLength(1);
});
