import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "hive-review-"));
process.env.HIVE_HOME = HOME;

const { openDb } = await import("../src/db.ts");
const { makeHandler } = await import("../src/api.ts");
const { acceptReports } = await import("../src/reconciler.ts");
const { Herdr } = await import("../src/runtime/herdr.ts");
const { writeEvent } = await import("../src/state.ts");
const { reviewActionable, reviewActionableBatch, reviewGate, reviewGateBatch } = await import("../src/reviewer.ts");
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
  expect(has(seen, "git", "diff", "origin/main...hive/task1")).toBe(true);

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

// Call the handler directly instead of standing up a real HTTP server.
// HIVE-591: bun 1.3.14's global fetch pool keeps sockets alive past the server
// that owned them, and the OS hands freed ephemeral ports straight back to the
// next `Bun.serve({ port: 0 })`, so a request can go out on a dead socket and
// get an empty/null/never-arriving response. No port, no socket, no pool, no
// flake.

// Build a fresh handler whose git/gh + herdr are stubbed. `gitMergeCode` controls
// the local ff-only outcome (0 = success, non-zero = conflict); `ghMergeCode`
// independently controls `gh pr merge` (defaults to mirroring gitMergeCode, so
// existing PR-merge-failure tests keep both paths failing together).
function makeApi(
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
    baseRefOid?: string;
    headRefOid?: string;
    currentBaseAncestor?: boolean;
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
    baseRefOid: opts.baseRefOid ?? "base-sha",
    headRefOid: opts.headRefOid ?? "branch-sha",
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
    if (has(argv, "git", "merge-base", "--is-ancestor")) {
      if (opts.currentBaseAncestor === false && argv.includes(opts.baseRefOid ?? "base-sha"))
        return { code: 1, stdout: "", stderr: "not an ancestor" };
      return OK();
    }
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
      return OK(JSON.stringify({ result: { worktree: { path: join(HOME, "wt"), branch: "hive/x", open_workspace_id: "w1" } } }));
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
  const handler = makeHandler(db, { herdr, exec });
  return { db, handler, sends, removed, ghMergeCalls, updateRefCalls, prView };
}

type Handler = ReturnType<typeof makeHandler>;

async function post(handler: Handler, path: string, body: unknown) {
  const res = await handler(
    new Request("http://127.0.0.1" + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
  return { status: res.status, json: await res.json() };
}
async function get(handler: Handler, path: string) {
  const res = await handler(new Request("http://127.0.0.1" + path));
  return { status: res.status, json: await res.json() };
}

// Drive a task to in_review with a branch set (via a stubbed spawn).
const REVIEW = {
  type: "review_summary",
  done: ["implemented the change"],
  understanding: { background: "This task changes behavior.", essence: "Tests cover the new behavior." },
};

async function addReview(handler: Handler, taskId: string) {
  await post(handler, `/api/tasks/${taskId}/events`, REVIEW);
}

async function inReviewTask(handler: Handler, extra: Record<string, unknown> = {}) {
  const p = await post(handler, "/api/projects", { name: "p", repo_path: "/repo", config: { default_branch: "main", ...extra } });
  const t = await post(handler, "/api/tasks", { project_id: p.json.id, title: "review me", brief: "b" });
  await post(handler, `/api/tasks/${t.json.id}/spawn`, {}); // sets branch + agent_target, → in_progress
  await addReview(handler, t.json.id);
  await post(handler, `/api/tasks/${t.json.id}/transition`, { to: "in_review" });
  return { projectId: p.json.id, taskId: t.json.id };
}

test("merge success writes a merged event and moves the task to verifying", async () => {
  const s = makeApi();
  const { taskId } = await inReviewTask(s.handler);
  const r = await post(s.handler, `/api/tasks/${taskId}/merge`, { actor: "director-tab-a" });
  expect(r.status).toBe(200);
  expect(r.json.state).toBe("verifying");
  const ev = await get(s.handler, `/api/tasks/${taskId}/events`);
  expect(ev.json.some((e: any) => e.type === "merged" && e.payload.actor === "director-tab-a")).toBe(true);
  // best-effort teardown removed the worktree
  expect(s.removed.length).toBeGreaterThan(0);
});

test("an identical review after a merge failure is recorded once", async () => {
  const s = makeApi({ gitMergeCode: 128, gitMergeStderr: "fatal: unable to write new index file" });
  const { taskId } = await inReviewTask(s.handler);

  expect((await post(s.handler, `/api/tasks/${taskId}/merge`, {})).status).toBe(409);
  const duplicate = await post(s.handler, `/api/tasks/${taskId}/events`, REVIEW);
  expect(duplicate.json.duplicate).toBe(true);

  const events = await get(s.handler, `/api/tasks/${taskId}/events`);
  expect(events.json.filter((event: any) => event.type === "review_summary")).toHaveLength(1);
});

test("merge conflict bounces the task back to the agent with rebase instructions", async () => {
  const s = makeApi({ gitMergeCode: 1 });
  const { taskId } = await inReviewTask(s.handler);
  const r = await post(s.handler, `/api/tasks/${taskId}/merge`, {});
  expect(r.status).toBe(409);
  expect(r.json.error).toContain("sent back to the agent");
  const task = await get(s.handler, `/api/tasks/${taskId}`);
  expect(task.json.state).toBe("in_progress"); // bounced, not wedged in review
  expect(s.sends.at(-1)?.message).toContain("Rebase");
  const ev = await get(s.handler, `/api/tasks/${taskId}/events`);
  const mf = ev.json.find((e: any) => e.type === "merge_failed");
  expect(mf.payload.conflict).toBe(true);
  expect(mf.payload.delivered).toBe(true);
  expect(ev.json.some((e: any) => e.type === "action_failed")).toBe(false);
});

test("non-conflict merge failure returns 409 and does not change state", async () => {
  const s = makeApi({ gitMergeCode: 128, gitMergeStderr: "fatal: unable to write new index file" });
  const { taskId } = await inReviewTask(s.handler);
  const sendsBefore = s.sends.length;
  const r = await post(s.handler, `/api/tasks/${taskId}/merge`, {});
  expect(r.status).toBe(409);
  expect(r.json.error).toContain("unable to write");
  const task = await get(s.handler, `/api/tasks/${taskId}`);
  expect(task.json.state).toBe("in_review"); // unchanged, no bounce
  expect(s.sends.length).toBe(sendsBefore); // agent not pinged
});

// Drive a task into review via the agent's own handoff, PR attached.
async function inReviewWithPr(handler: Handler, prUrl: string) {
  const p = await post(handler, "/api/projects", { name: "p", repo_path: "/repo" });
  const t = await post(handler, "/api/tasks", { project_id: p.json.id, title: "pr task", brief: "b" });
  await post(handler, `/api/tasks/${t.json.id}/spawn`, {});
  // The evidence gate holds evidence-less handoffs; these tests are about the
  // PR/CI plumbing, so satisfy it.
  await post(handler, `/api/tasks/${t.json.id}/events`, { type: "evidence", note: "proof", kind: "log" });
  await addReview(handler, t.json.id);
  await post(handler, `/api/tasks/${t.json.id}/events`, { type: "ready", pr_url: prUrl });
  return t.json.id as string;
}

test("a 'ready' with a new PR url re-links the task (replaced PR, the #90 loop)", async () => {
  const s = makeApi();
  const id = await inReviewWithPr(s.handler, "https://gh/pr/161");
  let task = await get(s.handler, `/api/tasks/${id}`);
  expect(task.json.pr_url).toBe("https://gh/pr/161");
  s.db.query("UPDATE tasks SET head_sha = ?, ci_status = ? WHERE id = ?").run("old-pr-head", "failing", id);
  // PR replaced: task bounces to in_progress, agent re-emits ready with the new url
  await post(s.handler, `/api/tasks/${id}/transition`, { to: "in_progress" });
  await post(s.handler, `/api/tasks/${id}/events`, { type: "ready", pr_url: "https://gh/pr/166" });
  task = await get(s.handler, `/api/tasks/${id}`);
  expect(task.json.pr_url).toBe("https://gh/pr/166"); // used to stay 161 forever
  expect(task.json.head_sha).toBeNull();
  expect(task.json.ci_status).toBeNull();
  const ev = await get(s.handler, `/api/tasks/${id}/events`);
  const link = ev.json.filter((e: any) => e.type === "pr_linked").at(-1);
  expect(link.payload.via).toBe("ready_replaced");
  expect(link.payload.replaced).toBe("https://gh/pr/161");
});

test("merging a PR GitHub already merged advances to verifying instead of failing", async () => {
  const s = makeApi({ prState: "MERGED" });
  const id = await inReviewWithPr(s.handler, "https://gh/pr/166");
  const r = await post(s.handler, `/api/tasks/${id}/merge`, {});
  expect(r.status).toBe(200);
  // evidence + no smoke checks configured → verifying auto-advances to done
  expect(["verifying", "done"]).toContain(r.json.state);
});

test("merging a CLOSED PR fails truthfully, no bogus conflict bounce", async () => {
  const s = makeApi({ prState: "CLOSED" });
  const id = await inReviewWithPr(s.handler, "https://gh/pr/161");
  const sendsBefore = s.sends.length;
  const r = await post(s.handler, `/api/tasks/${id}/merge`, {});
  expect(r.status).toBe(409);
  expect(r.json.error).toContain("CLOSED (not merged)");
  const task = await get(s.handler, `/api/tasks/${id}`);
  expect(task.json.state).toBe("in_review"); // no bounce: nothing for the agent to rebase
  expect(s.sends.length).toBe(sendsBefore);
});

test("PR merge fails on a stale base but the branch is a clean local ff → falls back instead of bouncing (task 328)", async () => {
  // gh pr merge fails "not mergeable" over a stale base; local ff-only stays green (default)
  const s = makeApi({ ghMergeCode: 1, mergeStateStatus: "BEHIND" });
  const id = await inReviewWithPr(s.handler, "https://gh/pr/328");
  const r = await post(s.handler, `/api/tasks/${id}/merge`, {});
  expect(r.status).toBe(200);
  expect(["verifying", "done"]).toContain(r.json.state); // not bounced back to in_progress
  const ev = await get(s.handler, `/api/tasks/${id}/events`);
  const merged = ev.json.find((e: any) => e.type === "merged");
  expect(merged.payload.method).toContain("local ff-only");
  expect(ev.json.some((e: any) => e.type === "merge_failed")).toBe(false);
});

test("PR merge fails and the local ff also fails (real conflict) → still bounces to the agent", async () => {
  // both gh and local ff fail
  const s = makeApi({ ghMergeCode: 1, gitMergeCode: 1, mergeStateStatus: "DIRTY" });
  const id = await inReviewWithPr(s.handler, "https://gh/pr/329");
  const r = await post(s.handler, `/api/tasks/${id}/merge`, {});
  expect(r.status).toBe(409);
  expect(r.json.error).toContain("sent back to the agent");
  expect(r.json.error).toContain("local fast-forward also refused"); // the actionable ff reason, not just gh's
  const task = await get(s.handler, `/api/tasks/${id}`);
  expect(task.json.state).toBe("in_progress");
});

test("a stale local base cannot bypass a conflict with the PR's current remote base", async () => {
  const s = makeApi({
    ghMergeCode: 1,
    mergeStateStatus: "BEHIND",
    baseRefOid: "remote-base-sha",
    currentBaseAncestor: false,
  });
  const id = await inReviewWithPr(s.handler, "https://gh/pr/817");
  const r = await post(s.handler, `/api/tasks/${id}/merge`, {});
  expect(r.status).toBe(409);
  expect(r.json.error).toContain("current PR base remote-base");
  expect((await get(s.handler, `/api/tasks/${id}`)).json.state).toBe("in_progress");
  const ev = await get(s.handler, `/api/tasks/${id}/events`);
  expect(ev.json.some((e: any) => e.type === "merged")).toBe(false);
});

test("a stale local task branch cannot replace the PR head during fallback", async () => {
  const s = makeApi({
    ghMergeCode: 1,
    mergeStateStatus: "BEHIND",
    headRefOid: "reviewed-head-sha",
  });
  const id = await inReviewWithPr(s.handler, "https://gh/pr/818");
  const r = await post(s.handler, `/api/tasks/${id}/merge`, {});
  expect(r.status).toBe(409);
  expect(r.json.error).toContain("but the PR head is reviewed-hea");
  expect((await get(s.handler, `/api/tasks/${id}`)).json.state).toBe("in_progress");
  const ev = await get(s.handler, `/api/tasks/${id}/events`);
  expect(ev.json.some((e: any) => e.type === "merged")).toBe(false);
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
    const s = makeApi({ ghMergeCode: 1 }); // local ff would succeed
    const id = await inReviewWithPr(s.handler, "https://gh/pr/331");
    expect((await get(s.handler, `/api/tasks/${id}`)).json.state).toBe("in_review");
    Object.assign(s.prView, { mergeStateStatus: "BEHIND" }, blocker); // stale base + a protection blocker
    const r = await post(s.handler, `/api/tasks/${id}/merge`, {});
    expect(r.status).toBe(409);
    expect(r.json.error).not.toContain("not 'in_review'"); // the fallback gate refused, not the state gate
    const ev = await get(s.handler, `/api/tasks/${id}/events`);
    expect(ev.json.some((e: any) => e.type === "merged")).toBe(false);
  });
}

test("merge_strategy: 'local_ff' forces the local path for a PR-backed task, skipping gh pr merge entirely", async () => {
  const s = makeApi(); // gh pr merge would succeed here too — this proves it's never called
  const id = await inReviewWithPr(s.handler, "https://gh/pr/330");
  const r = await post(s.handler, `/api/tasks/${id}/merge`, { merge_strategy: "local_ff" });
  expect(r.status).toBe(200);
  expect(["verifying", "done"]).toContain(r.json.state);
  expect(s.ghMergeCalls.length).toBe(0);
  const ev = await get(s.handler, `/api/tasks/${id}/events`);
  const merged = ev.json.find((e: any) => e.type === "merged");
  expect(merged.payload.method).toContain("local ff-only (forced");
});

test("merge_strategy: 'local_ff' still refuses a CLOSED PR", async () => {
  const s = makeApi(); // local ff would succeed — the PR state probe is what refuses
  const id = await inReviewWithPr(s.handler, "https://gh/pr/332");
  Object.assign(s.prView, { state: "CLOSED" });
  const r = await post(s.handler, `/api/tasks/${id}/merge`, { merge_strategy: "local_ff" });
  expect(r.status).toBe(409);
  expect(r.json.error).toContain("CLOSED (not merged)");
  const ev = await get(s.handler, `/api/tasks/${id}/events`);
  expect(ev.json.some((e: any) => e.type === "merged")).toBe(false);
});

test("local ff atomically advances an un-checked-out base without switching the primary checkout", async () => {
  const s = makeApi({ headBranch: "some/feature" });
  const id = await inReviewWithPr(s.handler, "https://gh/pr/333");
  const r = await post(s.handler, `/api/tasks/${id}/merge`, { merge_strategy: "local_ff" });
  expect(r.status).toBe(200);
  expect(s.updateRefCalls[0]?.slice(-3)).toEqual(["refs/heads/main", "branch-sha", "base-sha"]);
  const ev = await get(s.handler, `/api/tasks/${id}/events`);
  expect(ev.json.some((e: any) => e.type === "merged")).toBe(true);
});

test("local ff refuses to desynchronize a base checked out in another worktree", async () => {
  const s = makeApi({ headBranch: "some/feature", baseWorktreePath: "/repo-main" });
  const id = await inReviewWithPr(s.handler, "https://gh/pr/334");
  const r = await post(s.handler, `/api/tasks/${id}/merge`, { merge_strategy: "local_ff" });
  expect(r.status).toBe(409);
  expect(r.json.error).toContain("/repo-main");
  expect(s.updateRefCalls.length).toBe(0);
  const ev = await get(s.handler, `/api/tasks/${id}/events`);
  expect(ev.json.some((e: any) => e.type === "merged")).toBe(false);
});

test("local ff reports an atomic ref race without recording a merge", async () => {
  const s = makeApi({ headBranch: "some/feature", updateRefCode: 1, updateRefStderr: "cannot lock ref: expected base-sha" });
  const id = await inReviewWithPr(s.handler, "https://gh/pr/335");
  const r = await post(s.handler, `/api/tasks/${id}/merge`, { merge_strategy: "local_ff" });
  expect(r.status).toBe(409);
  expect(r.json.error).toContain("cannot lock ref");
  expect((await get(s.handler, `/api/tasks/${id}`)).json.state).toBe("in_review");
  const ev = await get(s.handler, `/api/tasks/${id}/events`);
  expect(ev.json.some((e: any) => e.type === "merged")).toBe(false);
});

test("ready with failing CI is HELD in_progress; with passing CI it hands off", async () => {
  const failing = makeApi({ rollup: [{ conclusion: "FAILURE" }] });
  let id = await inReviewWithPr(failing.handler, "https://gh/pr/9"); // helper emits ready
  let task = await get(failing.handler, `/api/tasks/${id}`);
  expect(task.json.state).toBe("in_progress"); // held, not review
  expect(task.json.ci_status).toBe("failing");
  const ev = await get(failing.handler, `/api/tasks/${id}/events`);
  expect(ev.json.some((e: any) => e.type === "ready_held")).toBe(true);

  const green = makeApi({ rollup: [{ conclusion: "SUCCESS" }] });
  id = await inReviewWithPr(green.handler, "https://gh/pr/10");
  task = await get(green.handler, `/api/tasks/${id}`);
  expect(task.json.state).toBe("in_review");

  const pending = makeApi({ rollup: [{ status: "IN_PROGRESS" }] });
  id = await inReviewWithPr(pending.handler, "https://gh/pr/11");
  task = await get(pending.handler, `/api/tasks/${id}`);
  expect(task.json.state).toBe("in_progress"); // held while checks run
  const held = await post(pending.handler, `/api/tasks/${id}/events`, { type: "ready" });
  expect(held.json.message).toContain("End this turn");
  expect(held.json.message).not.toContain("Stay on the task");
});

test("merge is blocked by a task.merge deny rule (authority gate)", async () => {
  const s = makeApi();
  const { projectId, taskId } = await inReviewTask(s.handler);
  await post(s.handler, "/api/authority/rules", { project_id: projectId, action_pattern: "task.merge", effect: "deny", note: "no auto-merge" });
  const r = await post(s.handler, `/api/tasks/${taskId}/merge`, {});
  expect(r.status).toBe(403);
  const task = await get(s.handler, `/api/tasks/${taskId}`);
  expect(task.json.state).toBe("in_review");
});

test("merge refuses a task that is not in_review", async () => {
  const s = makeApi();
  const p = await post(s.handler, "/api/projects", { name: "p", repo_path: "/repo" });
  const t = await post(s.handler, "/api/tasks", { project_id: p.json.id, title: "queued task" });
  const r = await post(s.handler, `/api/tasks/${t.json.id}/merge`, {});
  expect(r.status).toBe(409);
  expect(r.json.error).toContain("in_review");
});

test("merge refuses report-only scout tasks", async () => {
  const s = makeApi();
  const p = await post(s.handler, "/api/projects", { name: "p", repo_path: "/repo" });
  const t = await post(s.handler, "/api/tasks", { project_id: p.json.id, title: "review report", kind: "scout" });
  await post(s.handler, `/api/tasks/${t.json.id}/spawn`, {});
  await post(s.handler, `/api/tasks/${t.json.id}/transition`, { to: "in_review" });
  const r = await post(s.handler, `/api/tasks/${t.json.id}/merge`, {});
  expect(r.status).toBe(409);
  expect(r.json.error).toContain("report-only");
  expect((await get(s.handler, `/api/tasks/${t.json.id}`)).json.state).toBe("in_review");
});

// A scout hands over a written report, not a change. Hive accepts it on its
// own once it is in review WITH that report; without one there is nothing to accept.
test("hive accepts a scout's report only once a report is attached", async () => {
  const s = makeApi();
  const p = await post(s.handler, "/api/projects", { name: "p", repo_path: "/repo" });
  const t = await post(s.handler, "/api/tasks", { project_id: p.json.id, title: "explain findings", kind: "scout" });
  await post(s.handler, `/api/tasks/${t.json.id}/spawn`, {});
  await post(s.handler, `/api/tasks/${t.json.id}/transition`, { to: "in_review" });

  acceptReports(s.db);
  expect((await get(s.handler, `/api/tasks/${t.json.id}`)).json.state).toBe("in_review");

  await post(s.handler, `/api/tasks/${t.json.id}/events`, { type: "evidence", kind: "report", note: "the findings" });
  acceptReports(s.db);
  expect((await get(s.handler, `/api/tasks/${t.json.id}`)).json.state).toBe("verifying");

  // A scout that opened a PR along the way is still a report: it never merges.
  const withPr = await post(s.handler, "/api/tasks", { project_id: p.json.id, title: "smoke the driver", kind: "scout" });
  await post(s.handler, `/api/tasks/${withPr.json.id}/spawn`, {});
  await post(s.handler, `/api/tasks/${withPr.json.id}/transition`, { to: "in_review" });
  s.db.query("UPDATE tasks SET pr_url = 'https://github.com/o/r/pull/196' WHERE id = ?").run(withPr.json.id);
  await post(s.handler, `/api/tasks/${withPr.json.id}/events`, { type: "evidence", kind: "report", note: "smoke results" });
  acceptReports(s.db);
  expect((await get(s.handler, `/api/tasks/${withPr.json.id}`)).json.state).toBe("verifying");
});

test("request-changes returns the task to in_progress, sends notes, records an event", async () => {
  const s = makeApi();
  const { taskId } = await inReviewTask(s.handler);
  const r = await post(s.handler, `/api/tasks/${taskId}/request-changes`, { notes: "tighten the error handling" });
  expect(r.status).toBe(200);
  expect(r.json.ok).toBe(true);
  expect(r.json.delivered).toBe(true);
  expect(r.json.task.state).toBe("in_progress");
  expect(s.sends.at(-1)?.message).toContain("tighten the error handling");
  const ev = await get(s.handler, `/api/tasks/${taskId}/events`);
  const cr = ev.json.find((e: any) => e.type === "changes_requested");
  expect(cr.payload.notes).toBe("tighten the error handling");
});

test("request-changes requires notes", async () => {
  const s = makeApi();
  const { taskId } = await inReviewTask(s.handler);
  const r = await post(s.handler, `/api/tasks/${taskId}/request-changes`, { notes: "  " });
  expect(r.status).toBe(400);
});

// ---- external-task supervision hardening (#996) ------------------------------
// A never-dispatched external task (see supervision.ts) has no agent to bounce
// back to — request-changes and the in_progress bounce below must reject
// outright rather than queuing a steer nobody will ever read.
async function externalInReviewTask(handler: Handler) {
  const p = await post(handler, "/api/projects", { name: "p-ext-hardening", repo_path: "/repo" });
  const t = await post(handler, "/api/tasks", { project_id: p.json.id, title: "mirrored issue, in review", source: "external" });
  await post(handler, `/api/tasks/${t.json.id}/transition`, { to: "in_progress" }); // never spawned — external tasks move freely
  await post(handler, `/api/tasks/${t.json.id}/transition`, { to: "in_review" });
  return { projectId: p.json.id, taskId: t.json.id };
}

test("request-changes rejects a never-dispatched external task in review", async () => {
  const s = makeApi();
  const { taskId } = await externalInReviewTask(s.handler);
  const r = await post(s.handler, `/api/tasks/${taskId}/request-changes`, { notes: "fix it" });
  expect(r.status).toBe(409);
  expect(r.json.error).toContain("never been spawned");
  expect(s.sends.length).toBe(0);
  const ev = await get(s.handler, `/api/tasks/${taskId}/events`);
  expect(ev.json.some((e: any) => e.type === "changes_requested")).toBe(false);
});

// SUPERSEDED BEHAVIOR, deliberately. hive-996 rejected this move with a 409 so
// bounceForChanges could not queue a steer nobody reads and fail to spawn an
// agent. A tracking-only task now falls THROUGH to a plain transition instead,
// which achieves the same thing — no steer, no spawn attempt — and lets the
// move succeed, which is what a mirrored ticket moving back to active work in
// the external system actually needs. What the original test protected (the
// bounce must never run here) is still asserted; only the outcome changed from
// "rejected" to "plainly transitioned".
test("task move to in_progress from in_review does not bounce a never-dispatched external task", async () => {
  const s = makeApi();
  const { taskId } = await externalInReviewTask(s.handler);
  const before = s.sends.length;
  const r = await post(s.handler, `/api/tasks/${taskId}/transition`, { to: "in_progress" });
  expect(r.status).toBe(200);
  expect(r.json.bounce).toBeUndefined(); // the bounce path never ran
  expect(s.sends.length).toBe(before); // and no agent was contacted
  const task = await get(s.handler, `/api/tasks/${taskId}`);
  expect(task.json.state).toBe("in_progress");
});

test("request-changes and the in_progress bounce work normally on an external task that WAS spawned before (recovery, not first dispatch)", async () => {
  const s = makeApi();
  const p = await post(s.handler, "/api/projects", { name: "p-ext-recovered", repo_path: "/repo" });
  const t = await post(s.handler, "/api/tasks", { project_id: p.json.id, title: "mirrored issue, previously spawned", source: "external" });
  const taskId = t.json.id;
  // Simulate an external task that WAS legitimately spawned before (recovery
  // after a requeue nulls agent_target, or a legacy pre-#996 manual dispatch)
  // — supervision.ts's neverDispatched checks the permanent `spawned` event,
  // not the current agent_target snapshot, so this must behave like normal work.
  s.db.query("INSERT INTO events (id, task_id, ts, source, type, payload) VALUES (?,?,?,?,?,?)").run(
    "ev_spawned_996", taskId, new Date().toISOString(), "herdr", "spawned", JSON.stringify({ agent_target: "t-ext-live" })
  );
  s.db.query("UPDATE tasks SET agent_target = 't-ext-live', state = 'in_progress' WHERE id = ?").run(taskId);
  await post(s.handler, `/api/tasks/${taskId}/transition`, { to: "in_review" });

  const r = await post(s.handler, `/api/tasks/${taskId}/request-changes`, { notes: "still reachable" });
  expect(r.status).toBe(200);
  expect(r.json.delivered).toBe(true);
  expect(s.sends.at(-1)?.message).toContain("still reachable");
});

// #710: `hive task move <id> in_progress --note` is a reviewer bounce. It must
// record changes_requested (so the idle-advance backstop can't silently flip the
// task back to in_review) and deliver the note to the agent, respawning a dead one.
test("task move to in_progress from in_review records changes_requested and delivers the note", async () => {
  const s = makeApi();
  const { taskId } = await inReviewTask(s.handler);
  const r = await post(s.handler, `/api/tasks/${taskId}/transition`, { to: "in_progress", reason: "the diff misses site 4" });
  expect(r.status).toBe(200);
  expect(r.json.state).toBe("in_progress");
  expect(r.json.bounce.delivered).toBe(true);
  expect(s.sends.at(-1)?.message).toContain("the diff misses site 4");
  const ev = await get(s.handler, `/api/tasks/${taskId}/events`);
  const cr = ev.json.find((e: any) => e.type === "changes_requested");
  expect(cr.payload.notes).toBe("the diff misses site 4");
});

test("tracking-only review moves use a plain transition and never contact an agent", async () => {
  const s = makeApi();
  const p = await post(s.handler, "/api/projects", { name: "tracking", repo_path: "/repo" });
  const t = await post(s.handler, "/api/tasks", {
    project_id: p.json.id,
    title: "tracked Jira issue",
    source: "external",
    kind: "scout",
  });
  await post(s.handler, `/api/tasks/${t.json.id}/transition`, { to: "in_progress" });
  await post(s.handler, `/api/tasks/${t.json.id}/transition`, { to: "in_review" });

  const moved = await post(s.handler, `/api/tasks/${t.json.id}/transition`, {
    to: "in_progress",
    reason: "Jira moved back to active work",
  });
  expect(moved.status).toBe(200);
  expect(moved.json.state).toBe("in_progress");
  expect(moved.json.bounce).toBeUndefined();
  expect(s.sends).toEqual([]);
  await post(s.handler, `/api/tasks/${t.json.id}/transition`, { to: "in_review" });
  s.db.query("UPDATE tasks SET pr_url = ? WHERE id = ?").run("https://gh/pr/legacy", t.json.id);
  const verifying = await post(s.handler, `/api/tasks/${t.json.id}/transition`, { to: "verifying" });
  expect(verifying.status).toBe(200);
  expect(verifying.json.state).toBe("verifying");
  const events = await get(s.handler, `/api/tasks/${t.json.id}/events`);
  expect(events.json.some((event: any) => ["changes_requested", "steer", "spawned"].includes(event.type))).toBe(false);
});

test("task move bounce respawns the agent when it has exited, note rides the fresh brief", async () => {
  const s = makeApi({ deadAgent: true });
  const { taskId } = await inReviewTask(s.handler);
  const spawnsBefore = s.sends.length;
  const r = await post(s.handler, `/api/tasks/${taskId}/transition`, { to: "in_progress", reason: "fix X" });
  expect(r.status).toBe(200);
  expect(r.json.bounce.respawned).toBe(true);
  // A respawn re-created the worktree/agent; the queued steer was receipted.
  const ev = await get(s.handler, `/api/tasks/${taskId}/events`);
  expect(ev.json.filter((e: any) => e.type === "spawned").length).toBe(2);
  const steer = ev.json.find((e: any) => e.type === "steer");
  expect(steer.payload.delivery).toBe("delivered");
  expect(steer.payload.message).toContain("fix X");
  expect(spawnsBefore).toBeGreaterThanOrEqual(0);
});

test("reject path: an in_review task can be cancelled with a reason", async () => {
  const s = makeApi();
  const { taskId } = await inReviewTask(s.handler);
  const r = await post(s.handler, `/api/tasks/${taskId}/transition`, { to: "cancelled", reason: "not the approach we want" });
  expect(r.status).toBe(200);
  expect(r.json.state).toBe("cancelled");
  const ev = await get(s.handler, `/api/tasks/${taskId}/events`);
  const sc = ev.json.find((e: any) => e.type === "state_change" && e.payload.to === "cancelled");
  expect(sc.payload.reason).toBe("not the approach we want");
});

test("brief.to_review derivation lists in_review tasks", async () => {
  const s = makeApi();
  const { taskId } = await inReviewTask(s.handler);
  const b = await get(s.handler, `/api/brief`);
  expect(Array.isArray(b.json.to_review)).toBe(true);
  expect(b.json.to_review.some((t: any) => t.id === taskId)).toBe(true);
  // a fresh, still-queued task is NOT in the review list
  const p = await post(s.handler, "/api/projects", { name: "p2", repo_path: "/r" });
  const q = await post(s.handler, "/api/tasks", { project_id: p.json.id, title: "queued" });
  const b2 = await get(s.handler, `/api/brief`);
  expect(b2.json.to_review.some((t: any) => t.id === q.json.id)).toBe(false);

  const external = await post(s.handler, "/api/tasks", { project_id: p.json.id, title: "external review", source: "external" });
  const linked = await post(s.handler, "/api/tasks", { project_id: p.json.id, title: "Jira-linked review" });
  s.db.query("UPDATE tasks SET source_ref = ? WHERE id = ?").run("jira:WEB-2", linked.json.id);
  for (const id of [external.json.id, linked.json.id]) {
    await post(s.handler, `/api/tasks/${id}/transition`, { to: "in_progress" });
    await post(s.handler, `/api/tasks/${id}/transition`, { to: "in_review" });
  }
  const b3 = await get(s.handler, `/api/brief`);
  expect(b3.json.to_review.some((t: any) => t.id === external.json.id)).toBe(false);
  expect(b3.json.to_review.some((t: any) => t.id === linked.json.id)).toBe(false);
});

// HIVE-500: the review column counted everything in_review, so the Backlogs
// number was mostly pipeline state. One task per bucket; only the last two are
// the director's.
test("brief.to_review counts only reviews the director can act on", async () => {
  const s = makeApi();
  const p = await post(s.handler, "/api/projects", { name: "actionable", repo_path: "/repo" });
  const make = async (title: string, cols: Record<string, any>) => {
    const t = await post(s.handler, "/api/tasks", { project_id: p.json.id, title });
    const id = t.json.id;
    for (const [k, v] of Object.entries(cols)) s.db.query(`UPDATE tasks SET ${k} = ? WHERE id = ?`).run(v, id);
    s.db.query("UPDATE tasks SET state = 'in_review' WHERE id = ?").run(id);
    return id;
  };
  const review = (id: string, head: string, risks: string[] = []) =>
    writeEvent(s.db, { task_id: id, source: "system", type: "auto_review", payload: { verdict: "looks_good", summary: "s", risks, questions: [], reviewed_head_sha: head } });
  const PR = { pr_url: "https://x/pr/1", ci_status: "passing", head_sha: "head1" };

  const noReview = await make("no review yet", PR);
  const staleReview = await make("review at a stale head", PR);
  review(staleReview, "old-head");
  const unverified = await make("risks unverified", PR);
  review(unverified, "head1", ["a risk nobody checked"]);
  const noPrNoReport = await make("no PR and no report", {});
  const noPrReport = await make("no PR but a report", {});
  writeEvent(s.db, { task_id: noPrReport, source: "agent", type: "review_summary", payload: { done: ["read the docs"] } });
  const redCi = await make("PR with red CI", { ...PR, ci_status: "failing" });
  review(redCi, "head1");
  const ready = await make("PR with green CI and a finished review", PR);
  review(ready, "head1");
  // A verified review whose risk check CONFIRMED a finding stays the agent's
  // (the land queue holds it); one whose finding was refuted is the director's.
  const verdicts = (id: string, verdict: "confirmed" | "refuted") =>
    writeEvent(s.db, { task_id: id, source: "system", type: "risk_verdicts", payload: { reviewed_head_sha: "head1", verdicts: [{ risk: "r", verdict, why: "w" }], question_verdicts: [], unverified: 0 } });
  const confirmedRisk = await make("PR whose risk check confirmed a finding", PR);
  review(confirmedRisk, "head1", ["a real risk"]);
  verdicts(confirmedRisk, "confirmed");
  const refutedRisk = await make("PR whose risk check refuted its finding", PR);
  review(refutedRisk, "head1", ["a false alarm"]);
  verdicts(refutedRisk, "refuted");

  const b = await get(s.handler, "/api/brief");
  const ids = (rows: any[]) => rows.map((t: any) => t.id).sort();
  expect(ids(b.json.to_review)).toEqual([noPrReport, ready, refutedRisk].sort());
  // Everything else stays visible, just uncounted.
  expect(ids(b.json.in_review_pending)).toEqual([noReview, staleReview, unverified, noPrNoReport, redCi, confirmedRisk].sort());

  // The batched rule the list endpoints use must agree with the single-task one
  // on every bucket, or a board card and its brief row would disagree.
  const rows = s.db.query("SELECT * FROM tasks").all() as any[];
  const batch = reviewActionableBatch(s.db, rows);
  for (const t of rows) expect(batch.has(t.id)).toBe(reviewActionable(s.db, t));

  // The board column holds every one of these; the gate says why each card is
  // or is not the director's yet, and it agrees with the single-task rule.
  const gates = reviewGateBatch(s.db, rows);
  expect(gates.get(ready)).toBe("needs_you");
  expect(gates.get(refutedRisk)).toBe("needs_you");
  expect(gates.get(noPrReport)).toBe("needs_you");
  expect(gates.get(confirmedRisk)).toBe("risk_confirmed");
  expect(gates.get(redCi)).toBe("ci_failing");
  expect(gates.get(noReview)).toBe("review_running");
  expect(gates.get(staleReview)).toBe("review_running");
  expect(gates.get(unverified)).toBe("review_running");
  expect(gates.get(noPrNoReport)).toBe("no_pr");
  for (const t of rows) expect(gates.get(t.id) ?? null).toBe(reviewGate(s.db, t));
  // and the list endpoint carries it, so the board can draw the chip
  const listed = await get(s.handler, "/api/tasks");
  expect(listed.json.find((t: any) => t.id === confirmedRisk).review_gate).toBe("risk_confirmed");

});

test("diff endpoint returns the structured shape for a branch task", async () => {
  const s = makeApi();
  const { taskId } = await inReviewTask(s.handler);
  const r = await get(s.handler, `/api/tasks/${taskId}/diff`);
  expect(r.status).toBe(200);
  expect(r.json.files.length).toBe(2);
  expect(r.json.files[0].path).toBe("src/a.ts");
  expect(r.json.truncated).toBe(false);
});

test("diff endpoint rejects tracking-only review tasks", async () => {
  const s = makeApi();
  const p = await post(s.handler, "/api/projects", { name: "tracking", repo_path: "/repo" });
  const t = await post(s.handler, "/api/tasks", { project_id: p.json.id, title: "tracked review", source: "external" });
  await post(s.handler, `/api/tasks/${t.json.id}/transition`, { to: "in_progress" });
  await post(s.handler, `/api/tasks/${t.json.id}/transition`, { to: "in_review" });
  const r = await get(s.handler, `/api/tasks/${t.json.id}/diff`);
  expect(r.status).toBe(409);
  expect(r.json.error).toContain("tracking-only");
});


// ---- risk verdicts at the merge gate ----

// A task in review with a review summary, plus whatever auto-review verdict the
// case needs. `kind` decides whether it is inside the project's auto_merge list.
async function judgmentTask(
  s: ReturnType<typeof makeApi>,
  opts: {
    kind?: string;
    verdict?: "looks_good" | "caution";
    files?: string[];
    risks?: string[];
    head?: string;
    config?: Record<string, unknown>;
  } = {}
) {
  const p = await post(s.handler, "/api/projects", {
    name: "p",
    repo_path: "/repo",
    config: { default_branch: "main", auto_merge: { kinds: ["chore"] }, ...(opts.config ?? {}) },
  });
  const t = await post(s.handler, "/api/tasks", { project_id: p.json.id, title: "mechanical bump", brief: "b", kind: opts.kind ?? "chore" });
  await post(s.handler, `/api/tasks/${t.json.id}/spawn`, {});
  await addReview(s.handler, t.json.id);
  await post(s.handler, `/api/tasks/${t.json.id}/transition`, { to: "in_review" });
  if (opts.verdict)
    s.db.query("INSERT INTO events (id, task_id, ts, source, type, payload) VALUES (?,?,?,?,?,?)").run(
      `ev-auto-${t.json.id}`,
      t.json.id,
      new Date().toISOString(),
      "system",
      "auto_review",
      JSON.stringify({
        verdict: opts.verdict,
        summary: "s",
        risks: opts.risks ?? [],
        questions: [],
        files: opts.files ?? ["server/src/rows.ts"],
        ...(opts.head ? { reviewed_head_sha: opts.head } : {}),
      })
    );
  if (opts.head) s.db.query("UPDATE tasks SET head_sha = ? WHERE id = ?").run(opts.head, t.json.id);
  return { projectId: p.json.id, taskId: t.json.id };
}

// The verification pass's answer for one head, as the reviewer would write it.
function addRiskVerdicts(s: ReturnType<typeof makeApi>, taskId: string, head: string, verdict: "confirmed" | "refuted") {
  s.db.query("INSERT INTO events (id, task_id, ts, source, type, payload) VALUES (?,?,?,?,?,?)").run(
    `ev-rv-${head}-${taskId}`,
    taskId,
    new Date().toISOString(),
    "system",
    "risk_verdicts",
    JSON.stringify({ reviewed_head_sha: head, verdicts: [{ risk: "maybe a leak", verdict, why: "checked it" }] })
  );
}

test("a confirmed risk blocks the merge and the 409 names it", async () => {
  const s = makeApi();
  const { taskId } = await judgmentTask(s, { verdict: "caution", risks: ["maybe a leak"], head: "head-1" });
  addRiskVerdicts(s, taskId, "head-1", "confirmed");

  const blocked = await post(s.handler, `/api/tasks/${taskId}/merge`, {});
  expect(blocked.status).toBe(409);
  expect(blocked.json.error).toContain("maybe a leak");
  expect(blocked.json.error).toContain("checked it");

  // Verdicts from an older head say nothing about the head being merged.
  s.db.query("UPDATE tasks SET head_sha = 'head-2' WHERE id = ?").run(taskId);
  const stale = await post(s.handler, `/api/tasks/${taskId}/merge`, {});
  expect(stale.status).not.toBe(409);
});

// HIVE-539: a risk check that never produced a verdict must not be quoted as a
// confirmed risk. The 409 says the check did not finish, and the director can
// still merge over it.
test("a timed-out risk check blocks with an honest reason, not a confirmed risk", async () => {
  const s = makeApi();
  const { taskId } = await judgmentTask(s, { verdict: "caution", risks: ["maybe a leak"], head: "head-1" });
  s.db.query("INSERT INTO events (id, task_id, ts, source, type, payload) VALUES (?,?,?,?,?,?)").run(
    `ev-rv-timeout-${taskId}`,
    taskId,
    new Date().toISOString(),
    "system",
    "risk_verdicts",
    JSON.stringify({ reviewed_head_sha: "head-1", verdicts: [], unverified: 1, unverified_reason: "timed out after 180000ms" })
  );

  const blocked = await post(s.handler, `/api/tasks/${taskId}/merge`, {});
  expect(blocked.status).toBe(409);
  expect(blocked.json.error).toContain("did not finish");
  expect(blocked.json.error).toContain("timed out after 180000ms");
  expect(blocked.json.error).not.toContain("confirmed 1 risk");
  expect(blocked.json.error).not.toContain("maybe a leak");

  const merged = await post(s.handler, `/api/tasks/${taskId}/merge`, { override_confirmed_risks: true });
  expect(merged.status).toBe(200);
});

test("the director can merge over a confirmed risk on purpose", async () => {
  const s = makeApi();
  const { taskId } = await judgmentTask(s, { verdict: "caution", risks: ["maybe a leak"], head: "head-1" });
  addRiskVerdicts(s, taskId, "head-1", "confirmed");
  const merge = await post(s.handler, `/api/tasks/${taskId}/merge`, { override_confirmed_risks: true });
  expect(merge.status).toBe(200);
});

afterAll(() => {});

// ---------------------------------------------------------------------------
// HIVE-570. The risk finding is a property of the change, not an event in the
// land queue: the director sees it before Ship is offered, and taking the PR out
// of the queue (the right answer to a permanent failure) keeps the explanation.

test("Ship is not offered while a confirmed risk sits on the head (HIVE-570)", async () => {
  const s = makeApi();
  const t = await judgmentTask(s, { kind: "ship", verdict: "caution", risks: ["maybe a leak"], head: "head-1" });
  addRiskVerdicts(s, t.taskId, "head-1", "confirmed");

  // The review card reads this BEFORE it offers Ship, so the check that can
  // refuse has already run by the time the button exists.
  const check = (await get(s.handler, `/api/tasks/${t.taskId}/branch-check`)).json;
  expect(check.confirmed_risks.map((r: any) => r.risk)).toEqual(["maybe a leak"]);
  expect(check.risk_check_unfinished).toBeNull();

  // And the merge itself still refuses.
  const refused = await post(s.handler, `/api/tasks/${t.taskId}/merge`, {});
  expect(refused.status).toBe(409);
  expect(refused.json.error).toContain("the risk check confirmed 1 risk");
});

test("a confirmed risk stays readable after the task leaves the land queue (HIVE-570)", async () => {
  const s = makeApi();
  const t = await judgmentTask(s, { kind: "ship", verdict: "caution", risks: ["maybe a leak"], head: "head-1" });
  addRiskVerdicts(s, t.taskId, "head-1", "confirmed");

  await post(s.handler, "/api/land-queue", { task_ids: [t.taskId], queued: true });
  await post(s.handler, "/api/land-queue", { task_ids: [t.taskId], queued: false });

  // The verdicts live on the task, not on the pause card, so unqueueing cannot
  // take the explanation with it.
  const detail = (await get(s.handler, `/api/tasks/${t.taskId}`)).json;
  const verdictEvent = [...detail.events].reverse().find((e: any) => e.type === "risk_verdicts");
  expect(verdictEvent.payload.reviewed_head_sha).toBe("head-1");
  expect(verdictEvent.payload.verdicts[0]).toMatchObject({ risk: "maybe a leak", verdict: "confirmed" });
});
