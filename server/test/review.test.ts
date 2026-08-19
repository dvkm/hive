import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "hive-review-"));
process.env.HIVE_HOME = HOME;

const { openDb } = await import("../src/db.ts");
const { makeHandler, repairDuplicateQuizPasses } = await import("../src/api.ts");
const { Herdr } = await import("../src/runtime/herdr.ts");
const { parseUnifiedDiff, taskDiff, MAX_DIFF_LINES } = await import("../src/diff.ts");
import type { Exec, ExecResult } from "../src/exec.ts";

const OK = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const has = (argv: string[], ...xs: string[]) => xs.every((x) => argv.includes(x));

// ---- diff parsing (pure) ----

const SAMPLE = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@ func()
 context line
-removed line
+added line one
+added line two
diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 000..333
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,2 @@
+hello
+world
`;

test("parseUnifiedDiff splits multiple files and classifies add/del/ctx", () => {
  const r = parseUnifiedDiff(SAMPLE);
  expect(r.truncated).toBe(false);
  expect(r.files.length).toBe(2);

  const a = r.files[0];
  expect(a.path).toBe("src/a.ts");
  expect(a.additions).toBe(2);
  expect(a.deletions).toBe(1);
  expect(a.hunks.length).toBe(1);
  expect(a.hunks[0].header).toContain("@@ -1,3 +1,4 @@");
  const kinds = a.hunks[0].lines.map((l) => l.kind);
  expect(kinds).toEqual(["ctx", "del", "add", "add"]);
  expect(a.hunks[0].lines[2].text).toBe("added line one");

  const b = r.files[1];
  expect(b.path).toBe("src/new.ts"); // taken from +++ (--- is /dev/null)
  expect(b.additions).toBe(2);
  expect(b.deletions).toBe(0);
});

test("parseUnifiedDiff marks binary files and truncates past the cap", () => {
  const bin = `diff --git a/img.png b/img.png
index 1..2 100644
Binary files a/img.png and b/img.png differ
`;
  const rb = parseUnifiedDiff(bin);
  expect(rb.files[0].binary).toBe(true);
  expect(rb.files[0].hunks.length).toBe(0);

  // Build a diff with more lines than a tiny cap → truncated.
  let big = "diff --git a/big.txt b/big.txt\n--- a/big.txt\n+++ b/big.txt\n@@ -0,0 +1,50 @@\n";
  for (let i = 0; i < 50; i++) big += `+line ${i}\n`;
  const rt = parseUnifiedDiff(big, 10);
  expect(rt.truncated).toBe(true);
  expect(MAX_DIFF_LINES).toBeGreaterThan(0);
});

// ---- taskDiff source selection (injected exec) ----

test("taskDiff uses git diff base...branch for a branch task, gh for a PR task", async () => {
  const db = openDb(":memory:");
  // seed directly
  db.query("INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)")
    .run("proj1", "p", "/repo", JSON.stringify({ default_branch: "main" }), new Date().toISOString());
  const t = new Date().toISOString();
  db.query("INSERT INTO tasks (id, project_id, title, state, kind, branch, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)")
    .run("task1", "proj1", "t", "in_review", "ship", "hive/task1", t, t);

  let seen: string[] = [];
  const gitExec: Exec = async (argv) => {
    seen = argv;
    return OK(SAMPLE);
  };
  const rg = await taskDiff(db, "task1", gitExec);
  expect(rg.ok).toBe(true);
  expect(has(seen, "git", "diff", "main...hive/task1")).toBe(true);

  // now give it a PR url → gh path
  db.query("UPDATE tasks SET pr_url = ? WHERE id = ?").run("https://gh/pr/1", "task1");
  const ghExec: Exec = async (argv) => {
    seen = argv;
    return OK(SAMPLE);
  };
  const rp = await taskDiff(db, "task1", ghExec);
  expect(rp.ok).toBe(true);
  expect(has(seen, "gh", "pr", "diff", "https://gh/pr/1", "--patch")).toBe(true);
});

// ---- full server: merge / request-changes / reject / brief ----

// Build a fresh server whose git/gh + herdr are stubbed. `gitMergeCode` controls
// the local ff-only outcome (0 = success, non-zero = conflict); `ghMergeCode`
// independently controls `gh pr merge` (defaults to mirroring gitMergeCode, so
// existing PR-merge-failure tests keep both paths failing together).
function makeServer(
  opts: {
    gitMergeCode?: number;
    gitMergeStderr?: string;
    ghMergeCode?: number;
    headBranch?: string;
    prState?: string;
    mergeStateStatus?: string;
    reviewDecision?: string;
    rollup?: any[];
    deadAgent?: boolean;
    baseWorktreePath?: string;
    updateRefCode?: number;
    updateRefStderr?: string;
  } = {}
) {
  const db = openDb(":memory:");
  const sends: { target: string; message: string }[] = [];
  const removed: string[] = [];
  const ghMergeCalls: string[][] = [];
  const updateRefCalls: string[][] = [];
  // Mutable so a test can reach in_review with green checks and only then flip
  // the PR's state — the same `gh pr view` stub answers both the ready-time
  // hand-off and the merge probe, so a pending rollup set up front would hold
  // the task in_progress and the merge would 409 on the state gate instead.
  const prView = {
    state: opts.prState ?? "OPEN",
    baseRefName: "main",
    baseRefOid: "base-sha",
    mergeStateStatus: opts.mergeStateStatus ?? "CLEAN",
    reviewDecision: opts.reviewDecision ?? "",
    statusCheckRollup: opts.rollup ?? [],
  };
  const exec: Exec = async (argv) => {
    if (has(argv, "gh", "pr", "view")) return OK(JSON.stringify(prView));
    if (has(argv, "gh", "pr", "merge")) {
      ghMergeCalls.push(argv);
      const code = opts.ghMergeCode ?? opts.gitMergeCode;
      return code ? { code, stdout: "", stderr: "GraphQL: Pull Request is not mergeable (mergePullRequest)" } : OK();
    }
    if (has(argv, "git", "symbolic-ref", "--short", "HEAD")) return OK(`${opts.headBranch ?? "main"}\n`);
    if (has(argv, "git", "merge-base", "--is-ancestor")) return OK();
    if (has(argv, "git", "merge", "--ff-only")) {
      const code = opts.gitMergeCode ?? 0;
      return { code, stdout: "", stderr: code ? opts.gitMergeStderr ?? "CONFLICT (content): merge conflict in x" : "" };
    }
    if (has(argv, "git", "worktree", "list", "--porcelain")) {
      const primary = `worktree /repo\nbranch refs/heads/${opts.headBranch ?? "main"}\n`;
      const base = opts.baseWorktreePath ? `\nworktree ${opts.baseWorktreePath}\nbranch refs/heads/main\n` : "";
      return OK(primary + base);
    }
    if (has(argv, "git", "rev-parse")) return OK(argv.at(-1) === "main" ? "base-sha\n" : "branch-sha\n");
    if (has(argv, "git", "update-ref")) {
      updateRefCalls.push(argv);
      const code = opts.updateRefCode ?? 0;
      return { code, stdout: "", stderr: code ? opts.updateRefStderr ?? "cannot lock ref" : "" };
    }
    if (has(argv, "git", "diff")) return OK(SAMPLE);
    // herdr worktree/agent plumbing during spawn:
    if (has(argv, "worktree", "create"))
      return OK('{"result":{"worktree":{"path":"' + join(HOME, "wt") + '","branch":"hive/x","open_workspace_id":"w1"}}}');
    if (has(argv, "agent", "get")) return OK('{"result":{"agent":{"pane_id":"p1","agent_status":"working"}}}');
    if (has(argv, "workspace", "list")) return OK('{"result":{"workspaces":[{"workspace_id":"wF","label":"hive-fleet"}]}}');
    if (has(argv, "tab", "create")) return OK('{"result":{"tab":{"tab_id":"wF:t2"}}}');
    if (has(argv, "agent", "send")) {
      sends.push({ target: argv[argv.indexOf("send") + 1], message: argv[argv.indexOf("send") + 2] });
      // A vanished agent exits 0 with an agent_not_found body (never trust the code).
      if (opts.deadAgent) return OK('{"error":{"code":"agent_not_found"}}');
      return OK();
    }
    if (has(argv, "worktree", "remove")) {
      removed.push("removed");
      return OK("{}");
    }
    // git branchIsSafe checks during teardown → report merged
    if (has(argv, "git", "branch", "--merged")) return OK("  hive/x\n");
    if (has(argv, "git", "ls-remote")) return OK("");
    return OK();
  };
  const herdr = new Herdr(exec, "herdr");
  const server = Bun.serve({ port: 0, fetch: makeHandler(db, { herdr, exec }) });
  const base = `http://127.0.0.1:${server.port}`;
  return { db, server, base, sends, removed, ghMergeCalls, updateRefCalls, prView };
}

async function post(base: string, path: string, body: unknown) {
  const res = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
}
async function get(base: string, path: string) {
  const res = await fetch(base + path);
  return { status: res.status, json: await res.json() };
}

// Drive a task to in_review with a branch set (via a stubbed spawn).
const QUIZ = {
  question: "What makes this change safe to approve?",
  options: [{ key: "tests", label: "Its focused tests pass." }, { key: "hope", label: "It looks plausible." }],
  answer_key: "tests",
  explanation: "The focused tests cover the changed behavior.",
};

const QUIZ_BANK = [
  { question: "Why is this safe?", options: [{ key: "safe", label: "Focused tests cover it." }, { key: "guess", label: "It seems fine." }], answer_key: "safe", explanation: "Safety comes from focused coverage." },
  { question: "What evidence should approval rely on?", options: [{ key: "safe", label: "Tests of the changed path." }, { key: "guess", label: "A plausible implementation." }], answer_key: "safe", explanation: "Approval relies on evidence from the changed path." },
  { question: "What would catch a regression?", options: [{ key: "safe", label: "A focused failing test." }, { key: "guess", label: "A code comment." }], answer_key: "safe", explanation: "A focused test catches the regression." },
  { question: "What should be tested first?", options: [{ key: "safe", label: "The changed behavior." }, { key: "guess", label: "An unrelated path." }], answer_key: "safe", explanation: "Start with the behavior that changed." },
  { question: "When should approval stop?", options: [{ key: "safe", label: "When evidence contradicts the change." }, { key: "guess", label: "Never, if the code looks tidy." }], answer_key: "safe", explanation: "Contradictory evidence should block approval." },
  { question: "Should a sixth question survive?", options: [{ key: "safe", label: "No, the bank is capped at five." }, { key: "guess", label: "Yes, every submitted question is kept." }], answer_key: "safe", explanation: "Quiz banks are capped at five questions." },
];

async function addQuiz(base: string, taskId: string) {
  await post(base, `/api/tasks/${taskId}/events`, {
    type: "review_summary",
    done: ["implemented the change"],
    understanding: { background: "This task changes behavior.", essence: "Tests cover the new behavior.", check: QUIZ },
  });
}

async function inReviewTask(base: string, extra: Record<string, unknown> = {}, passQuiz = true) {
  const p = await post(base, "/api/projects", { name: "p", repo_path: "/repo", config: { default_branch: "main", ...extra } });
  const t = await post(base, "/api/tasks", { project_id: p.json.id, title: "review me", brief: "b" });
  await post(base, `/api/tasks/${t.json.id}/spawn`, {}); // sets branch + agent_target, → in_progress
  await addQuiz(base, t.json.id);
  await post(base, `/api/tasks/${t.json.id}/transition`, { to: "in_review" });
  if (passQuiz)
    await post(base, `/api/tasks/${t.json.id}/understanding-quiz/answer`, { answer_key: "tests", source: "director" });
  return { projectId: p.json.id, taskId: t.json.id };
}

test("merge success writes a merged event and moves the task to verifying", async () => {
  const s = makeServer();
  const { taskId } = await inReviewTask(s.base);
  const r = await post(s.base, `/api/tasks/${taskId}/merge`, {});
  expect(r.status).toBe(200);
  expect(r.json.state).toBe("verifying");
  const ev = await get(s.base, `/api/tasks/${taskId}/events`);
  expect(ev.json.some((e: any) => e.type === "merged")).toBe(true);
  // best-effort teardown removed the worktree
  expect(s.removed.length).toBeGreaterThan(0);
  s.server.stop(true);
});

test("understanding quiz blocks merge until the director answers correctly", async () => {
  const s = makeServer();
  const { taskId } = await inReviewTask(s.base, {}, false);

  let quizzes = await get(s.base, "/api/understanding-quizzes");
  const quiz = quizzes.json.quizzes.find((item: any) => item.task_id === taskId);
  expect(quiz.status).toBe("required");
  expect(quiz.answer_key).toBeUndefined();
  expect(quiz.task_kind).toBe("ship");
  expect(quiz.report.understanding.background).toBe("This task changes behavior.");
  expect(quiz.report.understanding.check).toBeUndefined();
  expect(quiz.report.understanding.checks).toBeUndefined();

  let merge = await post(s.base, `/api/tasks/${taskId}/merge`, {});
  expect(merge.status).toBe(409);
  expect(merge.json.error).toContain("Pass the understanding check");

  const wrong = await post(s.base, `/api/tasks/${taskId}/understanding-quiz/answer`, { answer_key: "hope", source: "director" });
  expect(wrong.json.correct).toBe(false);
  merge = await post(s.base, `/api/tasks/${taskId}/merge`, {});
  expect(merge.status).toBe(409);

  const right = await post(s.base, `/api/tasks/${taskId}/understanding-quiz/answer`, { answer_key: "tests", source: "director" });
  expect(right.json.correct).toBe(true);
  expect(right.json.passed).toBe(true);
  expect(right.json.explanation).toContain("focused tests");
  merge = await post(s.base, `/api/tasks/${taskId}/merge`, {});
  expect(merge.status).toBe(200);
  quizzes = await get(s.base, "/api/understanding-quizzes");
  expect(quizzes.json.quizzes.some((item: any) => item.task_id === taskId)).toBe(false);
  s.server.stop(true);
});

test("hive-1006: a review_summary submitted while in_progress is not listed or answerable until review", async () => {
  const s = makeServer();
  const p = await post(s.base, "/api/projects", { name: "p", repo_path: "/repo", config: { default_branch: "main" } });
  const t = await post(s.base, "/api/tasks", { project_id: p.json.id, title: "mid trim", brief: "b" });
  await post(s.base, `/api/tasks/${t.json.id}/spawn`, {}); // → in_progress
  await addQuiz(s.base, t.json.id); // review_summary submitted while still in_progress

  const beforeReview = await get(s.base, "/api/understanding-quizzes");
  expect(beforeReview.json.quizzes.some((item: any) => item.task_id === t.json.id)).toBe(false);

  const answer = await post(s.base, `/api/tasks/${t.json.id}/understanding-quiz/answer`, { answer_key: "tests", source: "director" });
  expect(answer.status).toBe(409);
  expect(answer.json.error).toContain("understanding checks can be answered during review or from the post-ship backlog");

  await post(s.base, `/api/tasks/${t.json.id}/transition`, { to: "in_review" });
  const afterReview = await get(s.base, "/api/understanding-quizzes");
  expect(afterReview.json.quizzes.some((item: any) => item.task_id === t.json.id)).toBe(true);

  s.server.stop(true);
});

test("an identical review after a merge failure keeps the completed quiz", async () => {
  const s = makeServer({ gitMergeCode: 128, gitMergeStderr: "fatal: unable to write new index file" });
  const { taskId } = await inReviewTask(s.base);

  expect((await post(s.base, `/api/tasks/${taskId}/merge`, {})).status).toBe(409);
  const duplicate = await post(s.base, `/api/tasks/${taskId}/events`, {
    type: "review_summary",
    done: ["implemented the change"],
    understanding: { background: "This task changes behavior.", essence: "Tests cover the new behavior.", check: QUIZ },
  });
  expect(duplicate.json.duplicate).toBe(true);

  const events = await get(s.base, `/api/tasks/${taskId}/events`);
  expect(events.json.filter((event: any) => event.type === "review_summary")).toHaveLength(1);
  expect((await get(s.base, "/api/understanding-quizzes")).json.quizzes.some((item: any) => item.task_id === taskId)).toBe(false);
  s.server.stop(true);
});

test("startup repair carries a completed quiz onto a legacy duplicate review", async () => {
  const s = makeServer();
  const { taskId } = await inReviewTask(s.base);
  const original: any = s.db
    .query("SELECT payload FROM events WHERE task_id = ? AND type = 'review_summary' ORDER BY rowid DESC LIMIT 1")
    .get(taskId);
  s.db
    .query("INSERT INTO events (id, task_id, ts, source, type, payload) VALUES (?,?,?,?,?,?)")
    .run("evt_legacy_duplicate", taskId, new Date().toISOString(), "agent", "review_summary", original.payload);

  expect(repairDuplicateQuizPasses(s.db)).toBe(1);
  const carried: any = s.db
    .query("SELECT payload FROM events WHERE task_id = ? AND type = 'understanding_quiz_passed' ORDER BY rowid DESC LIMIT 1")
    .get(taskId);
  expect(JSON.parse(carried.payload)).toMatchObject({
    review_event_id: "evt_legacy_duplicate",
    reason: "identical review already understood",
  });
  expect(repairDuplicateQuizPasses(s.db)).toBe(0);
  s.server.stop(true);
});

test("a wrong answer teaches the idea and rotates to another question", async () => {
  const s = makeServer();
  const p = await post(s.base, "/api/projects", { name: "p", repo_path: "/repo" });
  const t = await post(s.base, "/api/tasks", { project_id: p.json.id, title: "review me" });
  await post(s.base, `/api/tasks/${t.json.id}/spawn`, {});
  await post(s.base, `/api/tasks/${t.json.id}/events`, {
    type: "review_summary",
    done: ["implemented the change"],
    understanding: { background: "This changes behavior.", essence: "Tests cover it.", checks: QUIZ_BANK },
  });
  await post(s.base, `/api/tasks/${t.json.id}/transition`, { to: "in_review" });

  const before = (await get(s.base, "/api/understanding-quizzes")).json.quizzes.find((item: any) => item.task_id === t.json.id);
  const seen = new Set([before.question]);
  for (let i = 0; i < 4; i++) {
    const wrong = await post(s.base, `/api/tasks/${t.json.id}/understanding-quiz/answer`, { answer_key: "guess", source: "director" });
    expect(wrong.json.correct).toBe(false);
    expect(wrong.json.explanation).toBeTruthy();
    seen.add(wrong.json.quiz.question);
  }
  expect(seen.size).toBe(5);

  const after = (await get(s.base, "/api/understanding-quizzes")).json.quizzes.find((item: any) => item.task_id === t.json.id);
  expect(seen.has(after.question)).toBe(true);
  const firstCorrect = await post(s.base, `/api/tasks/${t.json.id}/understanding-quiz/answer`, { answer_key: "safe", source: "director" });
  expect(firstCorrect.json.correct).toBe(true);
  expect(firstCorrect.json.passed).toBe(false);
  expect(firstCorrect.json.completed).toBe(1);
  expect((await get(s.base, "/api/understanding-quizzes")).json.quizzes.some((item: any) => item.task_id === t.json.id)).toBe(true);
  for (let i = 0; i < 3; i++) {
    const correct = await post(s.base, `/api/tasks/${t.json.id}/understanding-quiz/answer`, { answer_key: "safe", source: "director" });
    expect(correct.json.correct).toBe(true);
    expect(correct.json.passed).toBe(false);
  }
  const finalCorrect = await post(s.base, `/api/tasks/${t.json.id}/understanding-quiz/answer`, { answer_key: "safe", source: "director" });
  expect(finalCorrect.json.passed).toBe(true);
  expect(finalCorrect.json.completed).toBe(5);
  expect((await get(s.base, "/api/understanding-quizzes")).json.quizzes.some((item: any) => item.task_id === t.json.id)).toBe(false);
  s.server.stop(true);
});

test("list completed/total tracks a two-check quiz exactly through pass (hive-1002)", async () => {
  const s = makeServer();
  const p = await post(s.base, "/api/projects", { name: "p", repo_path: "/repo" });
  const t = await post(s.base, "/api/tasks", { project_id: p.json.id, title: "review me" });
  await post(s.base, `/api/tasks/${t.json.id}/spawn`, {});
  await post(s.base, `/api/tasks/${t.json.id}/events`, {
    type: "review_summary",
    done: ["implemented the change"],
    understanding: { background: "This changes behavior.", essence: "Tests cover it.", checks: QUIZ_BANK.slice(0, 2) },
  });
  await post(s.base, `/api/tasks/${t.json.id}/transition`, { to: "in_review" });

  let quiz = (await get(s.base, "/api/understanding-quizzes")).json.quizzes.find((item: any) => item.task_id === t.json.id);
  expect(quiz.total).toBe(2);
  expect(quiz.completed).toBe(0);

  const first = await post(s.base, `/api/tasks/${t.json.id}/understanding-quiz/answer`, { answer_key: "safe", source: "director" });
  expect(first.json.correct).toBe(true);
  expect(first.json.passed).toBe(false);
  expect(first.json.completed).toBe(1);
  expect(first.json.total).toBe(2);

  quiz = (await get(s.base, "/api/understanding-quizzes")).json.quizzes.find((item: any) => item.task_id === t.json.id);
  expect(quiz).toBeTruthy(); // one check still outstanding, must stay listed
  expect(quiz.completed).toBe(1);
  expect(quiz.total).toBe(2);

  const second = await post(s.base, `/api/tasks/${t.json.id}/understanding-quiz/answer`, { answer_key: "safe", source: "director" });
  expect(second.json.correct).toBe(true);
  expect(second.json.passed).toBe(true);
  expect(second.json.completed).toBe(2);

  expect((await get(s.base, "/api/understanding-quizzes")).json.quizzes.some((item: any) => item.task_id === t.json.id)).toBe(false);
  s.server.stop(true);
});

test("explicit escape hatch ships now and keeps the quiz in Needs You until passed", async () => {
  const s = makeServer();
  const { taskId } = await inReviewTask(s.base, {}, false);

  const badDefer = await post(s.base, `/api/tasks/${taskId}/understanding-quiz/defer`, { source: "director" });
  expect(badDefer.status).toBe(400);
  const deferred = await post(s.base, `/api/tasks/${taskId}/understanding-quiz/defer`, { confirm: "quiz_later", source: "director" });
  expect(deferred.json.status).toBe("deferred");

  const merge = await post(s.base, `/api/tasks/${taskId}/merge`, {});
  expect(merge.status).toBe(200);
  let quizzes = await get(s.base, "/api/understanding-quizzes");
  const quiz = quizzes.json.quizzes.find((item: any) => item.task_id === taskId);
  expect(quiz.status).toBe("deferred");
  expect(["verifying", "done"]).toContain(quiz.task_state);

  const passed = await post(s.base, `/api/tasks/${taskId}/understanding-quiz/answer`, { answer_key: "tests", source: "director" });
  expect(passed.json.correct).toBe(true);
  quizzes = await get(s.base, "/api/understanding-quizzes");
  expect(quizzes.json.quizzes.some((item: any) => item.task_id === taskId)).toBe(false);
  s.server.stop(true);
});

test("merge conflict bounces the task back to the agent with rebase instructions", async () => {
  const s = makeServer({ gitMergeCode: 1 });
  const { taskId } = await inReviewTask(s.base);
  const r = await post(s.base, `/api/tasks/${taskId}/merge`, {});
  expect(r.status).toBe(409);
  expect(r.json.error).toContain("sent back to the agent");
  const task = await get(s.base, `/api/tasks/${taskId}`);
  expect(task.json.state).toBe("in_progress"); // bounced, not wedged in review
  expect(s.sends.at(-1)?.message).toContain("Rebase");
  const ev = await get(s.base, `/api/tasks/${taskId}/events`);
  const mf = ev.json.find((e: any) => e.type === "merge_failed");
  expect(mf.payload.conflict).toBe(true);
  expect(mf.payload.delivered).toBe(true);
  expect(ev.json.some((e: any) => e.type === "action_failed")).toBe(false);
  s.server.stop(true);
});

test("non-conflict merge failure returns 409 and does not change state", async () => {
  const s = makeServer({ gitMergeCode: 128, gitMergeStderr: "fatal: unable to write new index file" });
  const { taskId } = await inReviewTask(s.base);
  const sendsBefore = s.sends.length;
  const r = await post(s.base, `/api/tasks/${taskId}/merge`, {});
  expect(r.status).toBe(409);
  expect(r.json.error).toContain("unable to write");
  const task = await get(s.base, `/api/tasks/${taskId}`);
  expect(task.json.state).toBe("in_review"); // unchanged, no bounce
  expect(s.sends.length).toBe(sendsBefore); // agent not pinged
  s.server.stop(true);
});

// Drive a task into review via the agent's own handoff, PR attached.
async function inReviewWithPr(base: string, prUrl: string) {
  const p = await post(base, "/api/projects", { name: "p", repo_path: "/repo" });
  const t = await post(base, "/api/tasks", { project_id: p.json.id, title: "pr task", brief: "b" });
  await post(base, `/api/tasks/${t.json.id}/spawn`, {});
  // The evidence gate holds evidence-less handoffs; these tests are about the
  // PR/CI plumbing, so satisfy it.
  await post(base, `/api/tasks/${t.json.id}/events`, { type: "evidence", note: "proof", kind: "log" });
  await addQuiz(base, t.json.id);
  await post(base, `/api/tasks/${t.json.id}/events`, { type: "ready", pr_url: prUrl });
  await post(base, `/api/tasks/${t.json.id}/understanding-quiz/answer`, { answer_key: "tests", source: "director" });
  return t.json.id as string;
}

test("a 'ready' with a new PR url re-links the task (replaced PR, the #90 loop)", async () => {
  const s = makeServer();
  const id = await inReviewWithPr(s.base, "https://gh/pr/161");
  let task = await get(s.base, `/api/tasks/${id}`);
  expect(task.json.pr_url).toBe("https://gh/pr/161");
  // PR replaced: task bounces to in_progress, agent re-emits ready with the new url
  await post(s.base, `/api/tasks/${id}/transition`, { to: "in_progress" });
  await post(s.base, `/api/tasks/${id}/events`, { type: "ready", pr_url: "https://gh/pr/166" });
  task = await get(s.base, `/api/tasks/${id}`);
  expect(task.json.pr_url).toBe("https://gh/pr/166"); // used to stay 161 forever
  const ev = await get(s.base, `/api/tasks/${id}/events`);
  const link = ev.json.filter((e: any) => e.type === "pr_linked").at(-1);
  expect(link.payload.via).toBe("ready_replaced");
  expect(link.payload.replaced).toBe("https://gh/pr/161");
});

test("merging a PR GitHub already merged advances to verifying instead of failing", async () => {
  const s = makeServer({ prState: "MERGED" });
  const id = await inReviewWithPr(s.base, "https://gh/pr/166");
  const r = await post(s.base, `/api/tasks/${id}/merge`, {});
  expect(r.status).toBe(200);
  // evidence + no smoke checks configured → verifying auto-advances to done
  expect(["verifying", "done"]).toContain(r.json.state);
  s.server.stop(true);
});

test("merging a CLOSED PR fails truthfully, no bogus conflict bounce", async () => {
  const s = makeServer({ prState: "CLOSED" });
  const id = await inReviewWithPr(s.base, "https://gh/pr/161");
  const sendsBefore = s.sends.length;
  const r = await post(s.base, `/api/tasks/${id}/merge`, {});
  expect(r.status).toBe(409);
  expect(r.json.error).toContain("CLOSED (not merged)");
  const task = await get(s.base, `/api/tasks/${id}`);
  expect(task.json.state).toBe("in_review"); // no bounce: nothing for the agent to rebase
  expect(s.sends.length).toBe(sendsBefore);
  s.server.stop(true);
});

test("PR merge fails on a stale base but the branch is a clean local ff → falls back instead of bouncing (task 328)", async () => {
  // gh pr merge fails "not mergeable" over a stale base; local ff-only stays green (default)
  const s = makeServer({ ghMergeCode: 1, mergeStateStatus: "BEHIND" });
  const id = await inReviewWithPr(s.base, "https://gh/pr/328");
  const r = await post(s.base, `/api/tasks/${id}/merge`, {});
  expect(r.status).toBe(200);
  expect(["verifying", "done"]).toContain(r.json.state); // not bounced back to in_progress
  const ev = await get(s.base, `/api/tasks/${id}/events`);
  const merged = ev.json.find((e: any) => e.type === "merged");
  expect(merged.payload.method).toContain("local ff-only");
  expect(ev.json.some((e: any) => e.type === "merge_failed")).toBe(false);
  s.server.stop(true);
});

test("PR merge fails and the local ff also fails (real conflict) → still bounces to the agent", async () => {
  // both gh and local ff fail
  const s = makeServer({ ghMergeCode: 1, gitMergeCode: 1, mergeStateStatus: "DIRTY" });
  const id = await inReviewWithPr(s.base, "https://gh/pr/329");
  const r = await post(s.base, `/api/tasks/${id}/merge`, {});
  expect(r.status).toBe(409);
  expect(r.json.error).toContain("sent back to the agent");
  expect(r.json.error).toContain("local fast-forward also refused"); // the actionable ff reason, not just gh's
  const task = await get(s.base, `/api/tasks/${id}`);
  expect(task.json.state).toBe("in_progress");
  s.server.stop(true);
});

// Branch protection wears the same opaque "not mergeable" reason as a stale
// base; the local ff must never be used to merge around it. The rollup mixes
// CheckRun (progress in `status`) and StatusContext (`state`) shapes — both
// must block. Each case reaches in_review green, then flips the PR state, so
// the 409 proves the fallback gate refused rather than the in_review gate.
for (const [label, blocker] of [
  ["a failing required check", { statusCheckRollup: [{ conclusion: "FAILURE" }] }],
  ["an errored required check", { statusCheckRollup: [{ conclusion: "ERROR" }] }],
  ["a cancelled required check", { statusCheckRollup: [{ conclusion: "CANCELLED" }] }],
  ["a running required StatusContext", { statusCheckRollup: [{ state: "PENDING" }] }],
  ["a running required CheckRun", { statusCheckRollup: [{ status: "IN_PROGRESS" }] }],
  ["a queued required CheckRun", { statusCheckRollup: [{ status: "QUEUED" }] }],
  ["a missing required review", { reviewDecision: "REVIEW_REQUIRED" }],
  ["a reviewer requesting changes", { reviewDecision: "CHANGES_REQUESTED" }],
  ["BLOCKED with no detail", { mergeStateStatus: "BLOCKED" }],
] as const) {
  test(`PR merge blocked by ${label} → no local ff fallback, no merge`, async () => {
    const s = makeServer({ ghMergeCode: 1 }); // local ff would succeed
    const id = await inReviewWithPr(s.base, "https://gh/pr/331");
    expect((await get(s.base, `/api/tasks/${id}`)).json.state).toBe("in_review");
    Object.assign(s.prView, { mergeStateStatus: "BEHIND" }, blocker); // stale base + a protection blocker
    const r = await post(s.base, `/api/tasks/${id}/merge`, {});
    expect(r.status).toBe(409);
    expect(r.json.error).not.toContain("not 'in_review'"); // the fallback gate refused, not the state gate
    const ev = await get(s.base, `/api/tasks/${id}/events`);
    expect(ev.json.some((e: any) => e.type === "merged")).toBe(false);
    s.server.stop(true);
  });
}

test("merge_strategy: 'local_ff' forces the local path for a PR-backed task, skipping gh pr merge entirely", async () => {
  const s = makeServer(); // gh pr merge would succeed here too — this proves it's never called
  const id = await inReviewWithPr(s.base, "https://gh/pr/330");
  const r = await post(s.base, `/api/tasks/${id}/merge`, { merge_strategy: "local_ff" });
  expect(r.status).toBe(200);
  expect(["verifying", "done"]).toContain(r.json.state);
  expect(s.ghMergeCalls.length).toBe(0);
  const ev = await get(s.base, `/api/tasks/${id}/events`);
  const merged = ev.json.find((e: any) => e.type === "merged");
  expect(merged.payload.method).toContain("local ff-only (forced");
  s.server.stop(true);
});

test("merge_strategy: 'local_ff' still refuses a CLOSED PR", async () => {
  const s = makeServer(); // local ff would succeed — the PR state probe is what refuses
  const id = await inReviewWithPr(s.base, "https://gh/pr/332");
  Object.assign(s.prView, { state: "CLOSED" });
  const r = await post(s.base, `/api/tasks/${id}/merge`, { merge_strategy: "local_ff" });
  expect(r.status).toBe(409);
  expect(r.json.error).toContain("CLOSED (not merged)");
  const ev = await get(s.base, `/api/tasks/${id}/events`);
  expect(ev.json.some((e: any) => e.type === "merged")).toBe(false);
  s.server.stop(true);
});

test("local ff atomically advances an un-checked-out base without switching the primary checkout", async () => {
  const s = makeServer({ headBranch: "some/feature" });
  const id = await inReviewWithPr(s.base, "https://gh/pr/333");
  const r = await post(s.base, `/api/tasks/${id}/merge`, { merge_strategy: "local_ff" });
  expect(r.status).toBe(200);
  expect(s.updateRefCalls[0]?.slice(-3)).toEqual(["refs/heads/main", "branch-sha", "base-sha"]);
  const ev = await get(s.base, `/api/tasks/${id}/events`);
  expect(ev.json.some((e: any) => e.type === "merged")).toBe(true);
  s.server.stop(true);
});

test("local ff refuses to desynchronize a base checked out in another worktree", async () => {
  const s = makeServer({ headBranch: "some/feature", baseWorktreePath: "/repo-main" });
  const id = await inReviewWithPr(s.base, "https://gh/pr/334");
  const r = await post(s.base, `/api/tasks/${id}/merge`, { merge_strategy: "local_ff" });
  expect(r.status).toBe(409);
  expect(r.json.error).toContain("/repo-main");
  expect(s.updateRefCalls.length).toBe(0);
  const ev = await get(s.base, `/api/tasks/${id}/events`);
  expect(ev.json.some((e: any) => e.type === "merged")).toBe(false);
  s.server.stop(true);
});

test("local ff reports an atomic ref race without recording a merge", async () => {
  const s = makeServer({ headBranch: "some/feature", updateRefCode: 1, updateRefStderr: "cannot lock ref: expected base-sha" });
  const id = await inReviewWithPr(s.base, "https://gh/pr/335");
  const r = await post(s.base, `/api/tasks/${id}/merge`, { merge_strategy: "local_ff" });
  expect(r.status).toBe(409);
  expect(r.json.error).toContain("cannot lock ref");
  expect((await get(s.base, `/api/tasks/${id}`)).json.state).toBe("in_review");
  const ev = await get(s.base, `/api/tasks/${id}/events`);
  expect(ev.json.some((e: any) => e.type === "merged")).toBe(false);
  s.server.stop(true);
});

test("ready with failing CI is HELD in_progress; with passing CI it hands off", async () => {
  const failing = makeServer({ rollup: [{ conclusion: "FAILURE" }] });
  let id = await inReviewWithPr(failing.base, "https://gh/pr/9"); // helper emits ready
  let task = await get(failing.base, `/api/tasks/${id}`);
  expect(task.json.state).toBe("in_progress"); // held, not review
  expect(task.json.ci_status).toBe("failing");
  const ev = await get(failing.base, `/api/tasks/${id}/events`);
  expect(ev.json.some((e: any) => e.type === "ready_held")).toBe(true);
  failing.server.stop(true);

  const green = makeServer({ rollup: [{ conclusion: "SUCCESS" }] });
  id = await inReviewWithPr(green.base, "https://gh/pr/10");
  task = await get(green.base, `/api/tasks/${id}`);
  expect(task.json.state).toBe("in_review");
  green.server.stop(true);

  const pending = makeServer({ rollup: [{ status: "IN_PROGRESS" }] });
  id = await inReviewWithPr(pending.base, "https://gh/pr/11");
  task = await get(pending.base, `/api/tasks/${id}`);
  expect(task.json.state).toBe("in_progress"); // held while checks run
  pending.server.stop(true);
});

test("merge is blocked by a task.merge deny rule (authority gate)", async () => {
  const s = makeServer();
  const { projectId, taskId } = await inReviewTask(s.base);
  await post(s.base, "/api/authority/rules", { project_id: projectId, action_pattern: "task.merge", effect: "deny", note: "no auto-merge" });
  const r = await post(s.base, `/api/tasks/${taskId}/merge`, {});
  expect(r.status).toBe(403);
  const task = await get(s.base, `/api/tasks/${taskId}`);
  expect(task.json.state).toBe("in_review");
  s.server.stop(true);
});

test("merge refuses a task that is not in_review", async () => {
  const s = makeServer();
  const p = await post(s.base, "/api/projects", { name: "p", repo_path: "/repo" });
  const t = await post(s.base, "/api/tasks", { project_id: p.json.id, title: "queued task" });
  const r = await post(s.base, `/api/tasks/${t.json.id}/merge`, {});
  expect(r.status).toBe(409);
  expect(r.json.error).toContain("in_review");
  s.server.stop(true);
});

test("merge refuses report-only scout tasks", async () => {
  const s = makeServer();
  const p = await post(s.base, "/api/projects", { name: "p", repo_path: "/repo" });
  const t = await post(s.base, "/api/tasks", { project_id: p.json.id, title: "review report", kind: "scout" });
  await post(s.base, `/api/tasks/${t.json.id}/spawn`, {});
  await post(s.base, `/api/tasks/${t.json.id}/transition`, { to: "in_review" });
  const r = await post(s.base, `/api/tasks/${t.json.id}/merge`, {});
  expect(r.status).toBe(409);
  expect(r.json.error).toContain("report-only");
  expect((await get(s.base, `/api/tasks/${t.json.id}`)).json.state).toBe("in_review");
  s.server.stop(true);
});

test("report acceptance requires its understanding quiz", async () => {
  const s = makeServer();
  const p = await post(s.base, "/api/projects", { name: "p", repo_path: "/repo" });
  const t = await post(s.base, "/api/tasks", { project_id: p.json.id, title: "explain findings", kind: "scout" });
  await post(s.base, `/api/tasks/${t.json.id}/spawn`, {});
  await post(s.base, `/api/tasks/${t.json.id}/transition`, { to: "in_review" });

  let accept = await post(s.base, `/api/tasks/${t.json.id}/transition`, { to: "verifying" });
  expect(accept.status).toBe(409);
  expect(accept.json.error).toContain("Understanding check required");

  await addQuiz(s.base, t.json.id);
  accept = await post(s.base, `/api/tasks/${t.json.id}/transition`, { to: "verifying" });
  expect(accept.status).toBe(409);
  expect(accept.json.error).toContain("Pass the understanding check");

  await post(s.base, `/api/tasks/${t.json.id}/understanding-quiz/answer`, { answer_key: "tests", source: "director" });
  accept = await post(s.base, `/api/tasks/${t.json.id}/transition`, { to: "verifying" });
  expect(accept.status).toBe(200);
  expect(["verifying", "done"]).toContain(accept.json.state);
  s.server.stop(true);
});

test("request-changes returns the task to in_progress, sends notes, records an event", async () => {
  const s = makeServer();
  const { taskId } = await inReviewTask(s.base);
  const r = await post(s.base, `/api/tasks/${taskId}/request-changes`, { notes: "tighten the error handling" });
  expect(r.status).toBe(200);
  expect(r.json.ok).toBe(true);
  expect(r.json.delivered).toBe(true);
  expect(r.json.task.state).toBe("in_progress");
  expect(s.sends.at(-1)?.message).toContain("tighten the error handling");
  const ev = await get(s.base, `/api/tasks/${taskId}/events`);
  const cr = ev.json.find((e: any) => e.type === "changes_requested");
  expect(cr.payload.notes).toBe("tighten the error handling");
  s.server.stop(true);
});

test("request-changes requires notes", async () => {
  const s = makeServer();
  const { taskId } = await inReviewTask(s.base);
  const r = await post(s.base, `/api/tasks/${taskId}/request-changes`, { notes: "  " });
  expect(r.status).toBe(400);
  s.server.stop(true);
});

// ---- external-task supervision hardening (#996) ------------------------------
// A never-dispatched external task (see supervision.ts) has no agent to bounce
// back to — request-changes and the in_progress bounce below must reject
// outright rather than queuing a steer nobody will ever read.
async function externalInReviewTask(base: string) {
  const p = await post(base, "/api/projects", { name: "p-ext-hardening", repo_path: "/repo" });
  const t = await post(base, "/api/tasks", { project_id: p.json.id, title: "mirrored issue, in review", source: "external" });
  await post(base, `/api/tasks/${t.json.id}/transition`, { to: "in_progress" }); // never spawned — external tasks move freely
  await post(base, `/api/tasks/${t.json.id}/transition`, { to: "in_review" });
  return { projectId: p.json.id, taskId: t.json.id };
}

test("request-changes rejects a never-dispatched external task in review", async () => {
  const s = makeServer();
  const { taskId } = await externalInReviewTask(s.base);
  const r = await post(s.base, `/api/tasks/${taskId}/request-changes`, { notes: "fix it" });
  expect(r.status).toBe(409);
  expect(r.json.error).toContain("never been spawned");
  expect(s.sends.length).toBe(0);
  const ev = await get(s.base, `/api/tasks/${taskId}/events`);
  expect(ev.json.some((e: any) => e.type === "changes_requested")).toBe(false);
  s.server.stop(true);
});

test("task move to in_progress from in_review rejects a never-dispatched external task", async () => {
  const s = makeServer();
  const { taskId } = await externalInReviewTask(s.base);
  const r = await post(s.base, `/api/tasks/${taskId}/transition`, { to: "in_progress" });
  expect(r.status).toBe(409);
  expect(r.json.error).toContain("never been spawned");
  const task = await get(s.base, `/api/tasks/${taskId}`);
  expect(task.json.state).toBe("in_review"); // rejected before the bounce ran
  s.server.stop(true);
});

test("request-changes and the in_progress bounce work normally on an external task that WAS spawned before (recovery, not first dispatch)", async () => {
  const s = makeServer();
  const p = await post(s.base, "/api/projects", { name: "p-ext-recovered", repo_path: "/repo" });
  const t = await post(s.base, "/api/tasks", { project_id: p.json.id, title: "mirrored issue, previously spawned", source: "external" });
  const taskId = t.json.id;
  // Simulate an external task that WAS legitimately spawned before (recovery
  // after a requeue nulls agent_target, or a legacy pre-#996 manual dispatch)
  // — supervision.ts's neverDispatched checks the permanent `spawned` event,
  // not the current agent_target snapshot, so this must behave like normal work.
  s.db.query("INSERT INTO events (id, task_id, ts, source, type, payload) VALUES (?,?,?,?,?,?)").run(
    "ev_spawned_996", taskId, new Date().toISOString(), "herdr", "spawned", JSON.stringify({ agent_target: "t-ext-live" })
  );
  s.db.query("UPDATE tasks SET agent_target = 't-ext-live', state = 'in_progress' WHERE id = ?").run(taskId);
  await post(s.base, `/api/tasks/${taskId}/transition`, { to: "in_review" });

  const r = await post(s.base, `/api/tasks/${taskId}/request-changes`, { notes: "still reachable" });
  expect(r.status).toBe(200);
  expect(r.json.delivered).toBe(true);
  expect(s.sends.at(-1)?.message).toContain("still reachable");
  s.server.stop(true);
});

// #710: `hive task move <id> in_progress --note` is a reviewer bounce. It must
// record changes_requested (so the idle-advance backstop can't silently flip the
// task back to in_review) and deliver the note to the agent, respawning a dead one.
test("task move to in_progress from in_review records changes_requested and delivers the note", async () => {
  const s = makeServer();
  const { taskId } = await inReviewTask(s.base);
  const r = await post(s.base, `/api/tasks/${taskId}/transition`, { to: "in_progress", reason: "the diff misses site 4" });
  expect(r.status).toBe(200);
  expect(r.json.state).toBe("in_progress");
  expect(r.json.bounce.delivered).toBe(true);
  expect(s.sends.at(-1)?.message).toContain("the diff misses site 4");
  const ev = await get(s.base, `/api/tasks/${taskId}/events`);
  const cr = ev.json.find((e: any) => e.type === "changes_requested");
  expect(cr.payload.notes).toBe("the diff misses site 4");
  s.server.stop(true);
});

test("task move bounce respawns the agent when it has exited, note rides the fresh brief", async () => {
  const s = makeServer({ deadAgent: true });
  const { taskId } = await inReviewTask(s.base);
  const spawnsBefore = s.sends.length;
  const r = await post(s.base, `/api/tasks/${taskId}/transition`, { to: "in_progress", reason: "fix X" });
  expect(r.status).toBe(200);
  expect(r.json.bounce.respawned).toBe(true);
  // A respawn re-created the worktree/agent; the queued steer was receipted.
  const ev = await get(s.base, `/api/tasks/${taskId}/events`);
  expect(ev.json.filter((e: any) => e.type === "spawned").length).toBe(2);
  const steer = ev.json.find((e: any) => e.type === "steer");
  expect(steer.payload.delivery).toBe("delivered");
  expect(steer.payload.message).toContain("fix X");
  expect(spawnsBefore).toBeGreaterThanOrEqual(0);
  s.server.stop(true);
});

test("reject path: an in_review task can be cancelled with a reason", async () => {
  const s = makeServer();
  const { taskId } = await inReviewTask(s.base);
  const r = await post(s.base, `/api/tasks/${taskId}/transition`, { to: "cancelled", reason: "not the approach we want" });
  expect(r.status).toBe(200);
  expect(r.json.state).toBe("cancelled");
  const ev = await get(s.base, `/api/tasks/${taskId}/events`);
  const sc = ev.json.find((e: any) => e.type === "state_change" && e.payload.to === "cancelled");
  expect(sc.payload.reason).toBe("not the approach we want");
  s.server.stop(true);
});

test("brief.to_review derivation lists in_review tasks", async () => {
  const s = makeServer();
  const { taskId } = await inReviewTask(s.base);
  const b = await get(s.base, `/api/brief`);
  expect(Array.isArray(b.json.to_review)).toBe(true);
  expect(b.json.to_review.some((t: any) => t.id === taskId)).toBe(true);
  // a fresh, still-queued task is NOT in the review list
  const p = await post(s.base, "/api/projects", { name: "p2", repo_path: "/r" });
  const q = await post(s.base, "/api/tasks", { project_id: p.json.id, title: "queued" });
  const b2 = await get(s.base, `/api/brief`);
  expect(b2.json.to_review.some((t: any) => t.id === q.json.id)).toBe(false);
  s.server.stop(true);
});

test("diff endpoint returns the structured shape for a branch task", async () => {
  const s = makeServer();
  const { taskId } = await inReviewTask(s.base);
  const r = await get(s.base, `/api/tasks/${taskId}/diff`);
  expect(r.status).toBe(200);
  expect(r.json.files.length).toBe(2);
  expect(r.json.files[0].path).toBe("src/a.ts");
  expect(r.json.truncated).toBe(false);
  s.server.stop(true);
});

afterAll(() => {});
