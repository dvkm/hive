// Guard against no-mistakes' CI-monitor auto-rebase silently reverting work
// outside a task's scope. Documented incident (task #314): a branch cut from an
// old main fell behind, no-mistakes' CI monitor auto-rebased it onto main and
// "resolved" the conflicts by dropping the intervening commits — it reverted an
// unrelated shipped task's work AND lost the task's own change — then CI passed
// GREEN. Green CI does not catch a destructive resolution; hive then merged the
// regression. This diffs the branch's CURRENT authored file-set against the
// scope snapshotted before any rebase: a file the branch now authors that it did
// NOT originally, AND that base advanced in the meantime, is a base commit the
// auto-resolve reverted. See the "no-mistakes CI auto-rebase can DESTRUCTIVELY
// resolve conflicts" learning.
import type { Exec } from "./exec.ts";

export interface BranchScope {
  base_sha: string; // base tip when the snapshot was taken
  files: string[]; // files the branch authored: `git diff --name-only base...branch`
}

// Files the branch's own commits touch, relative to their merge-base with base
// (three-dot: the branch's authored diff, ignoring base's own advance). Returns
// null on any git error so callers can treat "can't tell" as "don't block".
async function authoredFiles(exec: Exec, repoPath: string, base: string, branch: string): Promise<string[] | null> {
  const r = await exec(["git", "-C", repoPath, "diff", "--name-only", `${base}...${branch}`]);
  if (r.code !== 0) return null;
  return r.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .sort();
}

// Snapshot the branch's intent: the files it authors plus the base tip it was
// measured against. Captured at first review hand-off (first green CI), before
// any CI-monitor rebase can run. Returns null if git can't be read.
export async function captureBranchScope(
  exec: Exec,
  repoPath: string,
  base: string,
  branch: string
): Promise<BranchScope | null> {
  const files = await authoredFiles(exec, repoPath, base, branch);
  if (files === null) return null;
  const sha = await exec(["git", "-C", repoPath, "rev-parse", base]);
  if (sha.code !== 0) return null;
  return { base_sha: sha.stdout.trim(), files };
}

// Compare the branch's CURRENT authored files against the pre-rebase snapshot.
// A file that is (a) newly authored — not in the snapshot's intent — and (b) one
// that base advanced since the snapshot is a base commit the auto-rebase
// reverted: the branch is re-writing work that already landed on base. Returns
// the regressed files (empty = clean). Returns null when it can't decide (git
// error / no snapshot) so the caller does not block on a read failure.
//
// ponytail: heuristic, two known ceilings. (1) It only sees reverts of commits
// that landed on base AFTER the snapshot — the branch must have been snapshotted
// while still clean (the reconciler's first-sight capture makes this the normal
// case, since a rebase only runs once a PR falls behind). (2) A legitimate later
// push that starts editing a base-owned file it did not originally touch reads
// as a revert; that is rare and the merge block is overridable
// (body.override_destructive_check). Both err toward blocking, never toward
// silently landing a bad merge.
export async function detectDestructiveRebase(
  exec: Exec,
  repoPath: string,
  base: string,
  branch: string,
  snapshot: BranchScope
): Promise<string[] | null> {
  const current = await authoredFiles(exec, repoPath, base, branch);
  if (current === null) return null;
  const known = new Set(snapshot.files);
  const regressed: string[] = [];
  for (const f of current) {
    if (known.has(f)) continue; // in the original intent — a legitimate task change
    const log = await exec(["git", "-C", repoPath, "log", "--oneline", `${snapshot.base_sha}..${base}`, "--", f]);
    if (log.code === 0 && log.stdout.trim()) regressed.push(f);
  }
  return regressed;
}
