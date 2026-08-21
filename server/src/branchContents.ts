// Detect a stacked-PR: a task branch that shares UNMERGED commit history with
// another currently open task's branch. That means one branch was cut from, or
// had merged into it, the other's in-flight work — so if the other task's
// branch later gets its scope trimmed (force-pushed/rewritten), this branch
// keeps carrying the old, pre-trim commits invisibly (task #1000: PR #88
// embedded #974's pre-trim commits this way, and nothing on the review UI said
// so). Returns null on any git error so callers treat "can't tell" as "don't
// flag" — never block a merge on an unreadable comparison.
import type { Exec } from "./exec.ts";

export interface EmbeddedTask {
  id: string;
  number: number;
  title: string;
}

async function mergeBase(exec: Exec, repoPath: string, a: string, b: string): Promise<string | null> {
  const r = await exec(["git", "-C", repoPath, "merge-base", a, b]);
  return r.code === 0 ? r.stdout.trim() : null;
}

async function isAncestor(exec: Exec, repoPath: string, commit: string, ref: string): Promise<boolean> {
  const r = await exec(["git", "-C", repoPath, "merge-base", "--is-ancestor", commit, ref]);
  return r.code === 0;
}

export async function findEmbeddedTasks(
  exec: Exec,
  repoPath: string,
  base: string,
  branch: string,
  others: { id: string; number: number; title: string; branch: string | null }[]
): Promise<EmbeddedTask[] | null> {
  const baseMerge = await mergeBase(exec, repoPath, base, branch);
  if (baseMerge === null) return null;
  const embedded: EmbeddedTask[] = [];
  for (const o of others) {
    if (!o.branch) continue;
    const pairMerge = await mergeBase(exec, repoPath, branch, o.branch);
    // pairMerge === null: that branch is unreadable (e.g. its worktree/ref is
    // gone) — skip it rather than guess. pairMerge === baseMerge: the two
    // branches diverged at our own fork point, nothing shared beyond base.
    if (pairMerge === null || pairMerge === baseMerge) continue;
    // A different merge-base is NOT yet a stack: two branches cut from
    // different points on `base` also meet deeper in base's own history, and
    // that is just ordinary forking. Only shared commits that base does not
    // already contain are in-flight work one branch carries for the other —
    // the thing a later rewrite over there would silently strand here.
    // Without this test the flag fires on every branch ever cut near base
    // (task #1134: 103 of corebeat's tasks, ~80 of them dead).
    if (await isAncestor(exec, repoPath, pairMerge, base)) continue;
    embedded.push({ id: o.id, number: o.number, title: o.title });
  }
  return embedded;
}
