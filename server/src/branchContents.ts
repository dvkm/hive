// Detect a stacked-PR: a task branch that shares commit history with another
// currently open task's branch beyond their common base. That means one branch
// was cut from, or had merged into it, the other's in-flight work — so if the
// other task's branch later gets its scope trimmed (force-pushed/rewritten),
// this branch keeps carrying the old, pre-trim commits invisibly (task #1000:
// PR #88 embedded #974's pre-trim commits this way, and nothing on the review
// UI said so). Returns null on any git error so callers treat "can't tell" as
// "don't flag" — never block a merge on an unreadable comparison.
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
    // gone) — skip it rather than guess.
    if (pairMerge !== null && pairMerge !== baseMerge) embedded.push({ id: o.id, number: o.number, title: o.title });
  }
  return embedded;
}
