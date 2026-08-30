import { test, expect } from "bun:test";
import { openDb, newId, now, type DB } from "../src/db.ts";
import { gardenRepos } from "../src/branchGardener.ts";
import type { Exec, ExecResult } from "../src/exec.ts";

const OK = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });

function freshDb(): { db: DB; projectId: string } {
  const db = openDb(":memory:");
  const projectId = newId("proj");
  db.query("INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)").run(
    projectId, "p", "/repo", "{}", now()
  );
  return { db, projectId };
}

function seedTask(db: DB, projectId: string, state: string): string {
  const id = newId();
  const t = now();
  db.query(
    `INSERT INTO tasks (id, project_id, title, state, kind, branch, created_at, updated_at)
     VALUES (?,?,?,?, 'ship', ?, ?, ?)`
  ).run(id, projectId, "t", state, `hive/${id}`, t, t);
  return id;
}

// One fake repo: `done` (branch goes), `cancelled` (branch kept), `in_progress`
// (untouched), plus an unowned branch and a done branch still checked out.
function fixture() {
  const { db, projectId } = freshDb();
  const done = seedTask(db, projectId, "done");
  const cancelled = seedTask(db, projectId, "cancelled");
  const live = seedTask(db, projectId, "in_progress");
  const doneCheckedOut = seedTask(db, projectId, "done");
  const orphan = "abc123abc123";
  const branches = [
    `hive/${done} aaa1`,
    `hive/${cancelled} aaa2`,
    `hive/${live} aaa3`,
    `hive/${doneCheckedOut} aaa4`,
    `hive/${orphan} aaa5`,
  ].join("\n");
  const worktrees = [
    "worktree /repo\nHEAD x\nbranch refs/heads/main",
    `worktree /wt/hive-${cancelled}\nHEAD x\nbranch refs/heads/hive/${cancelled}`,
    `worktree /wt/hive-${doneCheckedOut}\nHEAD x\nbranch refs/heads/hive/${doneCheckedOut}`,
    `worktree /wt/hive-${live}\nHEAD x\nbranch refs/heads/hive/${live}`,
  ].join("\n\n");

  const calls: string[][] = [];
  const exec: Exec = async (argv) => {
    calls.push(argv);
    if (argv.includes("worktree") && argv.includes("list")) return OK(worktrees);
    if (argv.includes("for-each-ref")) return OK(branches);
    if (argv[0] === "du") return OK("1048576\t" + argv[2]); // 1GB each
    if (argv.includes("status")) return OK(""); // clean
    if (argv.includes("ls-remote")) return OK(`sha\trefs/heads/hive/${done}\n`);
    return OK();
  };
  return { db, projectId, exec, calls, done, cancelled, live, doneCheckedOut, orphan };
}

test("dry run classifies by task state and touches nothing", async () => {
  const f = fixture();
  const [r] = await gardenRepos(f.db, { exec: f.exec });
  expect(r.prune.map((b) => b.task_id).sort()).toEqual([f.done, f.doneCheckedOut].sort());
  expect(r.unlanded.map((b) => b.task_id)).toEqual([f.cancelled]);
  expect(r.active.map((b) => b.task_id)).toEqual([f.live]);
  expect(r.unowned.map((b) => b.task_id)).toEqual([f.orphan]);
  // Only TERMINAL tasks' checkouts are listed; the live task's worktree is not.
  expect(r.worktrees.map((w) => w.task_id).sort()).toEqual([f.cancelled, f.doneCheckedOut].sort());
  expect(r.reclaimed_kb).toBe(0);
  expect(f.calls.some((c) => c.includes("-D") || c.includes("remove") || c.includes("push"))).toBe(false);
});

test("apply deletes done branches, removes terminal worktrees, keeps unlanded ones", async () => {
  const f = fixture();
  const [r] = await gardenRepos(f.db, { exec: f.exec, apply: true });
  expect(r.removed_worktrees.sort()).toEqual([`/wt/hive-${f.cancelled}`, `/wt/hive-${f.doneCheckedOut}`].sort());
  expect(r.reclaimed_kb).toBe(2 * 1048576);
  // The cancelled task's BRANCH survives its worktree removal.
  expect(r.deleted_local.sort()).toEqual([`hive/${f.done}`, `hive/${f.doneCheckedOut}`].sort());
  expect(r.deleted_local).not.toContain(`hive/${f.cancelled}`);
  // Never the live task's or the unowned branch.
  const deleted = f.calls.filter((c) => c.includes("-D")).map((c) => c[c.length - 1]);
  expect(deleted).not.toContain(`hive/${f.live}`);
  expect(deleted).not.toContain(`hive/${f.orphan}`);
  // Origin is untouched without --remote.
  expect(r.deleted_remote).toEqual([]);
  expect(f.calls.some((c) => c.includes("push"))).toBe(false);
});

test.each([
  [" M server/src/x.ts", "modified"],
  ["?? server/src/new-file.ts", "untracked"],
])("a dirty worktree (%s) is skipped, and its done branch with it", async (statusLine) => {
  const f = fixture();
  const exec: Exec = async (argv) => {
    if (argv.includes("status")) return OK(statusLine);
    return f.exec(argv);
  };
  const [r] = await gardenRepos(f.db, { exec, apply: true });
  expect(r.removed_worktrees).toEqual([]);
  expect(r.deleted_local).toEqual([`hive/${f.done}`]); // the one with no worktree
  expect(r.skipped.map((s) => s.reason)).toContain("uncommitted changes");
});

test("worktree removal never forces", async () => {
  const f = fixture();
  await gardenRepos(f.db, { exec: f.exec, apply: true });
  const removes = f.calls.filter((c) => c.includes("worktree") && c.includes("remove"));
  expect(removes.length).toBe(2);
  expect(removes.every((c) => !c.includes("--force"))).toBe(true);
});

test("--remote deletes only origin refs that exist, in one batched push", async () => {
  const f = fixture();
  const [r] = await gardenRepos(f.db, { exec: f.exec, apply: true, remote: true });
  expect(r.deleted_remote).toEqual([`hive/${f.done}`]);
  const push = f.calls.find((c) => c.includes("push"))!;
  expect(push).toEqual(["git", "-C", "/repo", "push", "origin", "--delete", `hive/${f.done}`]);
});
