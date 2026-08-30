// HIVE-526: a failed `git worktree remove` used to leave the checkout directory
// on disk while git dropped its registration, so every later `worktree add` on
// that path failed with `already exists` and the task retried a spawn it could
// never complete. Two halves are covered here: removal now clears what git
// refused to delete, and a create that collides with PROVABLY-orphaned debris
// clears it and retries.
//
// The first test is the one that matters: a live worktree, or any real
// checkout, must never be touched by the self-heal path.
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "hive-wt-heal-"));
process.env.HIVE_HOME = HOME;

const { Herdr } = await import("../src/runtime/herdr.ts");
import type { Exec, ExecResult } from "../src/exec.ts";

const OK = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const FAIL = (stderr: string): ExecResult => ({ code: 1, stdout: "", stderr });
const has = (argv: string[], ...xs: string[]) => xs.every((x) => argv.includes(x));
const REGISTERED = "worktree /wt/hive/x\nHEAD abc\nbranch refs/heads/hive/x\n";

// Records every argv so a test can assert what did NOT run.
function recorder(handler: (argv: string[]) => ExecResult | undefined) {
  const seen: string[][] = [];
  const exec: Exec = async (argv) => {
    seen.push(argv);
    return handler(argv) ?? OK();
  };
  return { seen, herdr: new Herdr(exec, "herdr"), wiped: () => seen.filter((a) => a[0] === "rm") };
}

test("a registered worktree with uncommitted work is rescued and removed by git — never wiped", async () => {
  const { herdr, seen, wiped } = recorder((argv) => {
    if (has(argv, "worktree", "list")) return OK(REGISTERED);
    if (has(argv, "status", "--porcelain")) return OK(" M src/real-work.ts\n");
    if (has(argv, "rev-parse", "--verify")) return FAIL(""); // ghost name free
    return undefined;
  });

  const r = await herdr.reclaimWorktree({ repoPath: "/repo", branch: "hive/x", taskId: "t1", hintPath: "/wt/hive/x" });

  expect(r.reclaimed).toBe(true);
  expect(r.ghost_branch).toBe("ghost-t1"); // the work was preserved first
  expect(wiped()).toEqual([]); // nothing was deleted outside git
  expect(seen.some((a) => has(a, "worktree", "remove", "--force", "/wt/hive/x"))).toBe(true);
});

test("a path that is a real git checkout is left alone even when git has no worktree there", async () => {
  const { herdr, wiped } = recorder((argv) => {
    if (has(argv, "worktree", "list")) return OK(""); // nothing registered
    if (has(argv, "rev-parse", "--git-dir")) return OK(".git\n"); // but it IS a repo
    return undefined;
  });

  const r = await herdr.reclaimWorktree({ repoPath: "/repo", branch: "hive/x", taskId: "t2", hintPath: "/wt/hive/x" });

  expect(r.reclaimed).toBe(false);
  expect(r.reason).toBe("no registered worktree to reclaim");
  expect(wiped()).toEqual([]);
});

test("provably-orphaned debris is cleared and pruned, so the create can be retried", async () => {
  const { herdr, seen, wiped } = recorder((argv) => {
    if (has(argv, "worktree", "list")) return OK(""); // not registered
    if (has(argv, "rev-parse", "--git-dir")) return FAIL("not a git repository"); // not a repo
    return undefined; // test -d succeeds: it exists
  });

  const r = await herdr.reclaimWorktree({ repoPath: "/repo", branch: "hive/x", taskId: "t3", hintPath: "/wt/hive/x" });

  expect(r.reclaimed).toBe(true);
  expect(r.ghost_branch).toBeNull();
  expect(wiped()).toEqual([["rm", "-rf", "/wt/hive/x"]]);
  expect(seen.some((a) => has(a, "worktree", "prune"))).toBe(true);
});

test("a path with no directory on disk is not 'cleared'", async () => {
  const { herdr, wiped } = recorder((argv) => {
    if (has(argv, "worktree", "list")) return OK("");
    if (argv[0] === "test") return FAIL(""); // nothing there
    return undefined;
  });

  const r = await herdr.reclaimWorktree({ repoPath: "/repo", branch: "hive/x", taskId: "t4", hintPath: "/wt/hive/x" });
  expect(r.reclaimed).toBe(false);
  expect(wiped()).toEqual([]);
});

test("cleanup whose removal hits 'Directory not empty' clears the leftovers instead of stranding the path", async () => {
  const { herdr, seen, wiped } = recorder((argv) => {
    if (has(argv, "ls-remote")) return OK("abc\trefs/heads/hive/x\n"); // branch is pushed: safe
    if (has(argv, "status", "--porcelain")) return OK("?? web/.vite/\n"); // untracked build cache only
    if (has(argv, "worktree", "remove"))
      return FAIL("error: failed to delete '/wt/hive/x': Directory not empty");
    return undefined;
  });

  const r = await herdr.cleanupWorktree({ repoPath: "/repo", branch: "hive/x", worktreePath: "/wt/hive/x", taskId: "t5" });

  expect(r.removed).toBe(true);
  expect(wiped()).toEqual([["rm", "-rf", "/wt/hive/x"]]);
  expect(seen.some((a) => has(a, "worktree", "prune"))).toBe(true);
});

test("a removal that fails for any OTHER reason is reported, not wiped", async () => {
  const { herdr, wiped } = recorder((argv) => {
    if (has(argv, "ls-remote")) return OK("abc\trefs/heads/hive/x\n");
    if (has(argv, "status", "--porcelain")) return OK("");
    if (has(argv, "worktree", "remove")) return FAIL("fatal: permission denied");
    return undefined;
  });

  const r = await herdr.cleanupWorktree({ repoPath: "/repo", branch: "hive/x", worktreePath: "/wt/hive/x", taskId: "t6" });

  expect(r.removed).toBe(false);
  expect(r.reason).toContain("permission denied");
  expect(wiped()).toEqual([]);
});

test("the repo itself, and a shallow path, are never clearable", async () => {
  const { isClearableWorktreePath } = await import("../src/runtime/herdr.ts");
  expect(isClearableWorktreePath("/repo", "/repo")).toBe(false);
  expect(isClearableWorktreePath("/repo", "/repo/")).toBe(false);
  expect(isClearableWorktreePath("/repo", "/")).toBe(false);
  expect(isClearableWorktreePath("/repo", "/tmp")).toBe(false);
  expect(isClearableWorktreePath("/repo", "")).toBe(false);
  expect(isClearableWorktreePath("/repo", "relative/path")).toBe(false);
  // Shallow paths stay off limits: a home directory is not a worktree.
  expect(isClearableWorktreePath("/repo", "/Users/david")).toBe(false);
  // An ancestor of the repo is never clearable, however deep it is.
  expect(isClearableWorktreePath("/a/b/c/repo", "/a/b/c")).toBe(false);
  expect(isClearableWorktreePath("/repo", "/wt/hive/x")).toBe(true);
});
