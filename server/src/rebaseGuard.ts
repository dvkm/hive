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
export async function authoredFiles(exec: Exec, repoPath: string, base: string, branch: string): Promise<string[] | null> {
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
// A file is a scope violation only when all three hold: (a) it is newly authored
// — not in the snapshot's intent, (b) base advanced it since the snapshot, and
// (c) the branch's copy of it is byte-identical to the pre-advance version, i.e.
// the branch DROPPED base's commits rather than building on them. (c) is the
// HIVE-543 fix: without it, editing one assertion in a spec file base recently
// touched read as "reverts base work", which pushed agents to weaken their own
// tests to get past the gate. Returns the regressed files (empty = clean), or
// null when it can't decide (git error) so the caller does not block on a read
// failure.
//
// ponytail: still a heuristic, with a narrower ceiling than before. It catches
// the wholesale drop (#314's signature: the file returns to its old content
// exactly); a partial revert that also adds new lines slips through to PR
// review. Blocking stays overridable (body.override_destructive_check).
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
    if (log.code !== 0 || !log.stdout.trim()) continue; // base never touched it
    // Base moved this file, and the branch touches it too. That is only a revert
    // if the branch's content is the pre-move content — an edit on top of base's
    // version is ordinary work.
    if ((await blobId(exec, repoPath, branch, f)) === (await blobId(exec, repoPath, snapshot.base_sha, f))) regressed.push(f);
  }
  return regressed;
}

// Content id of <rev>:<path>, or "" when the path does not exist at that rev
// (so "missing on both sides" compares equal — the branch dropped a file base
// added, which is a real revert).
async function blobId(exec: Exec, repoPath: string, rev: string, path: string): Promise<string> {
  const r = await exec(["git", "-C", repoPath, "rev-parse", `${rev}:${path}`]);
  return r.code === 0 ? r.stdout.trim() : "";
}
