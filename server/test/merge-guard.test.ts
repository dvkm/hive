import { test, expect } from "bun:test";
import { openDb, newId, now, type DB } from "../src/db.ts";
import { writeEvent, getTask } from "../src/state.ts";
import { mergeTask } from "../src/api.ts";
import { Herdr } from "../src/runtime/herdr.ts";
import type { Exec, ExecResult } from "../src/exec.ts";

const OK = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const stub = (fn: (argv: string[]) => ExecResult): Exec => async (argv) => fn(argv);

function seed(): { db: DB; taskId: string } {
  const db = openDb(":memory:");
  const projectId = newId("proj");
  db.query("INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)").run(
    projectId, "p", "/repo", "{}", now()
  );
  const taskId = newId();
  const t = now();
  // in_review, PR-less so mergeTask takes the local-ff path; a branch + a
  // pre-rebase branch_scope snapshot are what the guard reads.
  db.query(
    "INSERT INTO tasks (id, project_id, title, state, kind, branch, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)"
  ).run(taskId, projectId, "task", "in_review", "ship", "feat", t, t);
  writeEvent(db, {
    task_id: taskId,
    source: "reconciler",
    type: "branch_scope",
    payload: { base_sha: "B1", files: ["src/task.ts"] },
  });
  const review = writeEvent(db, {
    task_id: taskId,
    source: "agent",
    type: "review_summary",
    payload: {
      understanding: {
        check: {
          question: "What protects this merge?",
          options: [{ key: "guard", label: "The destructive-change guard." }, { key: "none", label: "Nothing." }],
          answer_key: "guard",
        },
      },
    },
  });
  writeEvent(db, { task_id: taskId, source: "director", type: "understanding_quiz_passed", payload: { review_event_id: review.id, answer_key: "guard" } });
  return { db, taskId };
}

// git router: authored files = task.ts + a reverted health.ts; base advanced on
// health.ts since the snapshot → destructive. The local-ff plumbing (used only
// on the override path) is stubbed to succeed so a bypassed merge lands.
const destructiveExec: Exec = stub((argv) => {
  if (argv.includes("diff") && argv.includes("--name-only")) return OK("health.ts\nsrc/task.ts\n");
  if (argv[3] === "log") return OK(argv[argv.length - 1] === "health.ts" ? "abc base commit\n" : "");
  if (argv.includes("rev-parse")) return OK(argv.at(-1) === "main" ? "base-sha\n" : "branch-sha\n");
  if (argv.includes("symbolic-ref")) return OK("main\n"); // primary checkout is on base
  return OK(); // merge-base --is-ancestor / merge --ff-only succeed
});

const herdr = new Herdr(stub(() => OK("{}")), "herdr");

test("mergeTask BLOCKS a branch that reverts base work outside its scope (#314)", async () => {
  const { db, taskId } = seed();
  const res = await mergeTask(db, herdr, taskId, {}, { exec: destructiveExec });
  expect(res.status).toBe(409);
  const body: any = await res.json();
  expect(body.error).toContain("health.ts");
  // Bounced back to the agent, and the block is recorded for the director.
  expect(getTask(db, taskId).state).toBe("in_progress");
  const ev = db.query("SELECT 1 FROM events WHERE task_id = ? AND type = 'merge_blocked_destructive'").get(taskId);
  expect(ev).toBeTruthy();
});

test("override_destructive_check bypasses the guard", async () => {
  const { db, taskId } = seed();
  // No smoke deps needed: local-ff merge is stubbed to succeed, task advances.
  const res = await mergeTask(db, herdr, taskId, { override_destructive_check: true }, { exec: destructiveExec });
  expect(res.status).toBe(200);
  const ev = db.query("SELECT 1 FROM events WHERE task_id = ? AND type = 'merge_blocked_destructive'").get(taskId);
  expect(ev).toBeFalsy();
});

test("PR destructive guard compares against the PR's exact base commit", async () => {
  const { db, taskId } = seed();
  db.query("UPDATE tasks SET pr_url = ? WHERE id = ?").run("https://gh/pr/1", taskId);
  const diffs: string[] = [];
  const exec: Exec = stub((argv) => {
    if (argv[0] === "gh" && argv.includes("view"))
      return OK(JSON.stringify({ state: "OPEN", baseRefName: "staging", baseRefOid: "staging-sha", mergeStateStatus: "CLEAN", statusCheckRollup: [] }));
    if (argv[0] === "gh" && argv.includes("merge")) return OK();
    if (argv.includes("diff") && argv.includes("--name-only")) {
      diffs.push(argv.at(-1)!);
      return OK("src/task.ts\n");
    }
    return OK();
  });

  const res = await mergeTask(db, herdr, taskId, {}, { exec });
  expect(res.status).toBe(200);
  expect(diffs).toEqual(["staging-sha...feat"]);
});

test("PR guard repairs a stale local-ref snapshot from the first exact PR head", async () => {
  const { db, taskId } = seed();
  db.query("UPDATE tasks SET pr_url = ? WHERE id = ?").run("https://gh/pr/2", taskId);
  writeEvent(db, { task_id: taskId, source: "reconciler", type: "pr_synchronized", payload: { head_sha: "original-head" } });
  const diffs: string[] = [];
  const exec: Exec = stub((argv) => {
    if (argv[0] === "gh" && argv.includes("view"))
      return OK(JSON.stringify({ state: "OPEN", baseRefName: "staging", baseRefOid: "staging-sha", headRefOid: "current-head", mergeStateStatus: "CLEAN", statusCheckRollup: [] }));
    if (argv[0] === "gh" && argv.includes("merge")) return OK();
    if (argv.includes("diff") && argv.includes("--name-only")) {
      diffs.push(argv.at(-1)!);
      return OK("src/task.ts\n");
    }
    if (argv.includes("rev-parse")) return OK(`${argv.at(-1)}\n`);
    if (argv[3] === "log") return OK("base touched task file\n");
    return OK();
  });

  const res = await mergeTask(db, herdr, taskId, {}, { exec });
  expect(res.status).toBe(200);
  expect(diffs).toEqual(["staging-sha...original-head", "staging-sha...current-head"]);
  expect(db.query("SELECT 1 FROM events WHERE task_id = ? AND type = 'merge_blocked_destructive'").get(taskId)).toBeFalsy();
});

test("a replacement PR does not inherit the rejected PR's branch scope", async () => {
  const { db, taskId } = seed();
  const prUrl = "https://gh/pr/replacement";
  db.query("UPDATE tasks SET pr_url = ?, branch = ? WHERE id = ?").run(prUrl, "feat-recut", taskId);
  writeEvent(db, {
    task_id: taskId,
    source: "agent",
    type: "pr_linked",
    payload: { pr_url: prUrl, via: "ready_replaced", replaced: "https://gh/pr/rejected" },
  });
  let diffCalls = 0;
  const exec: Exec = stub((argv) => {
    if (argv[0] === "gh" && argv.includes("view"))
      return OK(JSON.stringify({ state: "OPEN", baseRefName: "main", baseRefOid: "current-base", headRefOid: "recut-head", mergeStateStatus: "CLEAN", statusCheckRollup: [] }));
    if (argv[0] === "gh" && argv.includes("merge")) return OK();
    if (argv.includes("diff") && argv.includes("--name-only")) diffCalls++;
    return OK();
  });

  const res = await mergeTask(db, herdr, taskId, {}, { exec });

  expect(res.status).toBe(200);
  expect(diffCalls).toBe(0);
  expect(db.query("SELECT 1 FROM events WHERE task_id = ? AND type = 'merge_blocked_destructive'").get(taskId)).toBeFalsy();
});

test("mergeTask atomically matches the freshly-verified PR head (HIVE-307)", async () => {
  const { db, taskId } = seed();
  const prUrl = "https://gh/pr/atomic";
  db.query("UPDATE tasks SET pr_url = ? WHERE id = ?").run(prUrl, taskId);
  const head = "verified-head";
  const mergeArgvs: string[][] = [];
  const exec: Exec = stub((argv) => {
    if (argv[0] === "gh" && argv.includes("view"))
      return OK(
        JSON.stringify({
          state: "OPEN",
          baseRefName: "main",
          baseRefOid: "base-sha",
          headRefOid: head,
          mergeStateStatus: "CLEAN",
          statusCheckRollup: [{ conclusion: "SUCCESS" }],
        })
      );
    if (argv[0] === "gh" && argv.includes("merge")) mergeArgvs.push(argv);
    if (argv.includes("diff") && argv.includes("--name-only")) return OK("src/task.ts\n");
    return OK();
  });

  const res = await mergeTask(db, herdr, taskId, {}, { exec });

  expect(res.status).toBe(200);
  expect(mergeArgvs).toEqual([["gh", "pr", "merge", prUrl, "--squash", "--match-head-commit", head]]);
});

test("mergeTask BLOCKS while a declared dependency hasn't actually merged/done yet (#1000)", async () => {
  const { db, taskId } = seed();
  const projectId = (db.query("SELECT project_id FROM tasks WHERE id = ?").get(taskId) as any).project_id;
  const depId = newId();
  const t = now();
  db.query(
    "INSERT INTO tasks (id, project_id, title, state, kind, created_at, updated_at) VALUES (?,?,?,?,?,?,?)"
  ).run(depId, projectId, "dependency task", "in_progress", "ship", t, t);
  db.query("UPDATE tasks SET depends_on = ? WHERE id = ?").run(JSON.stringify([depId]), taskId);

  const res = await mergeTask(db, herdr, taskId, {}, { exec: destructiveExec });
  expect(res.status).toBe(409);
  const body: any = await res.json();
  expect(body.error).toContain("unmet dependency");
  expect(body.error).toContain("dependency task");
  // Refused outright, not bounced to the agent — this isn't the agent's fix to make.
  expect(getTask(db, taskId).state).toBe("in_review");
});

test("mergeTask proceeds once the declared dependency reaches done", async () => {
  const { db, taskId } = seed();
  const projectId = (db.query("SELECT project_id FROM tasks WHERE id = ?").get(taskId) as any).project_id;
  const depId = newId();
  const t = now();
  db.query(
    "INSERT INTO tasks (id, project_id, title, state, kind, created_at, updated_at) VALUES (?,?,?,?,?,?,?)"
  ).run(depId, projectId, "dependency task", "done", "ship", t, t);
  db.query("UPDATE tasks SET depends_on = ? WHERE id = ?").run(JSON.stringify([depId]), taskId);

  const res = await mergeTask(db, herdr, taskId, { override_destructive_check: true }, { exec: destructiveExec });
  expect(res.status).toBe(200);
});

// A PR's baseRefName is GitHub-sourced (set via the GitHub UI/API, not local
// config), but it lands as a POSITIONAL git argument in attemptLocalFf's
// fallback path the same way config.default_branch does, and git's ref-name
// rules don't forbid a leading `-` (task #1086, same bug class as #1024).
// baseRefOid stays a real sha so the early "PR base metadata is missing"
// guard doesn't short-circuit before the vulnerable read.
test("mergeTask never lets an option-shaped PR baseRefName reach git argv (task #1086)", async () => {
  const { db, taskId } = seed();
  db.query("UPDATE tasks SET pr_url = ? WHERE id = ?").run("https://gh/pr/evil", taskId);
  const payload = "--upload-pack=/tmp/evil";
  const argvs: string[][] = [];
  const exec: Exec = stub((argv) => {
    argvs.push(argv);
    if (argv[0] === "gh" && argv.includes("view"))
      return OK(
        JSON.stringify({
          state: "OPEN",
          mergeStateStatus: "DIRTY",
          reviewDecision: "APPROVED",
          statusCheckRollup: [{ conclusion: "SUCCESS" }],
          baseRefName: payload,
          baseRefOid: "base-sha-real",
          headRefOid: "feat-sha",
        })
      );
    if (argv[0] === "gh" && argv.includes("merge")) return { code: 1, stdout: "", stderr: "GraphQL: Pull Request is not mergeable" };
    if (argv.includes("diff") && argv.includes("--name-only")) return OK("src/task.ts\n");
    if (argv.includes("rev-parse")) return OK(argv.at(-1) === "feat" ? "feat-sha\n" : "main-sha\n");
    if (argv.includes("merge-base") && argv.includes("--is-ancestor")) return OK();
    if (argv.includes("symbolic-ref")) return OK("other\n");
    if (argv.includes("worktree") && argv.includes("list")) return OK("");
    if (argv.includes("update-ref")) return OK();
    return OK();
  });

  const res = await mergeTask(db, herdr, taskId, {}, { exec });
  expect(res.status).toBe(200);
  for (const argv of argvs) expect(argv).not.toContain(payload);
  // fell back to config.default_branch's own fallback ("main"), not the payload
  const merged: any = db.query("SELECT payload FROM events WHERE task_id = ? AND type = 'merged'").get(taskId);
  expect(JSON.parse(merged.payload).base).toBe("main");
});

test("a same-branch re-cut (force-push) invalidates a stale snapshot and re-baselines instead of blocking (#1696)", async () => {
  const { db, taskId } = seed();
  const prUrl = "https://gh/pr/recut";
  db.query("UPDATE tasks SET pr_url = ? WHERE id = ?").run(prUrl, taskId);
  // Simulate a snapshot taken long ago, against a head that got force-pushed
  // away — it is no longer an ancestor of the rebuilt branch's current head.
  writeEvent(db, { task_id: taskId, source: "reconciler", type: "branch_scope", payload: { base_sha: "old-base-sha", files: ["src/task.ts"], head_sha: "old-head" } });
  const rebuiltFiles = "db.ts\nreconciler.ts\nsrc/task.ts\n";
  const exec: Exec = stub((argv) => {
    if (argv[0] === "gh" && argv.includes("view"))
      return OK(JSON.stringify({ state: "OPEN", baseRefName: "main", baseRefOid: "base-sha-now", headRefOid: "rebuilt-head", mergeStateStatus: "CLEAN", statusCheckRollup: [] }));
    if (argv[0] === "gh" && argv.includes("merge")) return OK();
    if (argv.includes("merge-base") && argv.includes("--is-ancestor")) return { code: 1, stdout: "", stderr: "not an ancestor" };
    if (argv.includes("diff") && argv.includes("--name-only")) return OK(rebuiltFiles);
    if (argv.includes("rev-parse")) return OK(`${argv.at(-1)}\n`);
    return OK();
  });

  const res = await mergeTask(db, herdr, taskId, {}, { exec });

  expect(res.status).toBe(200);
  expect(db.query("SELECT 1 FROM events WHERE task_id = ? AND type = 'merge_blocked_destructive'").get(taskId)).toBeFalsy();
  const latest: any = db.query("SELECT payload FROM events WHERE task_id = ? AND type = 'branch_scope' ORDER BY ts DESC LIMIT 1").get(taskId);
  expect(JSON.parse(latest.payload).head_sha).toBe("rebuilt-head");
});

test("a real revert still blocks after the snapshot was re-baselined (#1696)", async () => {
  const { db, taskId } = seed();
  const prUrl = "https://gh/pr/recut2";
  db.query("UPDATE tasks SET pr_url = ? WHERE id = ?").run(prUrl, taskId);
  // A prior merge attempt already re-baselined against the rebuilt branch.
  writeEvent(db, {
    task_id: taskId,
    source: "director",
    type: "branch_scope",
    payload: { base_sha: "base-sha-now", files: ["db.ts", "reconciler.ts", "src/task.ts"], head_sha: "rebuilt-head" },
  });
  const exec: Exec = stub((argv) => {
    if (argv[0] === "gh" && argv.includes("view"))
      return OK(JSON.stringify({ state: "OPEN", baseRefName: "main", baseRefOid: "base-sha-later", headRefOid: "rebuilt-head-2", mergeStateStatus: "CLEAN", statusCheckRollup: [] }));
    if (argv[0] === "gh" && argv.includes("merge")) return OK();
    if (argv.includes("merge-base") && argv.includes("--is-ancestor")) return OK(); // rebuilt-head is still an ancestor: a legit follow-up push
    if (argv.includes("diff") && argv.includes("--name-only")) {
      const range = argv.at(-1);
      if (range === "base-sha-later...rebuilt-head") return OK("db.ts\nreconciler.ts\nsrc/task.ts\n"); // original intent, unchanged
      if (range === "base-sha-later...rebuilt-head-2") return OK("db.ts\nreconciler.ts\nsrc/task.ts\nhealth.ts\n"); // health.ts newly reverted
      return OK();
    }
    if (argv[3] === "log") return OK(argv.at(-1) === "health.ts" ? "abc base commit\n" : "");
    if (argv.includes("rev-parse")) return OK(`${argv.at(-1)}\n`);
    return OK();
  });

  const res = await mergeTask(db, herdr, taskId, {}, { exec });

  expect(res.status).toBe(409);
  const body: any = await res.json();
  expect(body.error).toContain("health.ts");
  expect(db.query("SELECT 1 FROM events WHERE task_id = ? AND type = 'merge_blocked_destructive'").get(taskId)).toBeTruthy();
});

test("PR merge fails closed when its base metadata is unavailable", async () => {
  const { db, taskId } = seed();
  db.query("UPDATE tasks SET pr_url = ? WHERE id = ?").run("https://gh/pr/1", taskId);
  let gitCalls = 0;
  const exec: Exec = stub((argv) => {
    if (argv[0] === "gh" && argv.includes("view")) return { code: 1, stdout: "", stderr: "network unavailable" };
    gitCalls++;
    return OK();
  });

  const res = await mergeTask(db, herdr, taskId, {}, { exec });
  expect(res.status).toBe(409);
  expect((await res.json() as any).error).toContain("Could not inspect PR metadata");
  expect(getTask(db, taskId).state).toBe("in_review");
  expect(gitCalls).toBe(0);
  expect(db.query("SELECT 1 FROM events WHERE task_id = ? AND type = 'merge_failed'").get(taskId)).toBeTruthy();
});
