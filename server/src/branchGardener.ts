// Garden the checkout using TASK STATE, not git reachability.
//
// Why not git: hive squash-merges, so a landed task branch is still "not fully
// merged" by `git branch --merged`, and branches older than the 2026-08-27
// history rewrite share no merge base with main at all. Reachability therefore
// says nothing about 400+ `hive/*` branches. Hive knows which task a branch
// belongs to and whether that task reached `done` — that is the authoritative
// signal, and this pass is the only thing that uses it.
//
// The split that makes this safe:
//   - branch delete: ONLY for a task in state `done` (the work landed).
//   - worktree remove: any TERMINAL task (done/cancelled/failed) — the checkout
//     is disk, the commits live on the branch, and the branch is kept unless the
//     task is done. Nothing unlanded becomes unreachable.
//   - a branch with no task row, or checked out in a worktree we did not remove,
//     is REPORTED and never touched.
//
// The scan covers EVERY local branch, not just `hive/*`, so nothing is invisible:
//   - `ghost-<taskId>[-N]` branches hold WIP rescued from a dying worktree. They
//     are unlanded by definition, so they are only ever REPORTED, never deleted,
//     even when the task is done.
//   - every other branch (a human's, `replay/*`, `claude/*`, review checkouts)
//     is not hive's to delete. It is REPORTED with whether its tip is already
//     contained in the base branch, which is what a human needs to clear it.
//
// Dry run is the default; `apply` is opt-in and `remote` is opt-in on top of it.
// Every deleted branch's tip sha is recorded in the report so a mistake is
// recoverable (`git branch <name> <sha>`).
import type { DB } from "./db.ts";
import { getTask, TERMINAL, type State } from "./state.ts";
import { parseWorktreeList } from "./runtime/herdr.ts";
import { taskIdFromBranch } from "./reaper.ts";
import { activeProjects } from "./testProjects.ts";
import type { Exec } from "./exec.ts";
import { defaultExec, projectBaseBranch } from "./exec.ts";

export interface BranchItem {
  branch: string;
  task_id: string;
  sha: string;
  state: State | null;
  worktree: string | null; // checked out here, if anywhere
  merged?: boolean; // tip already contained in the base branch
}

export interface WorktreeItem {
  path: string;
  branch: string;
  task_id: string;
  state: State | null;
  size_kb: number;
}

export interface GardenReport {
  project_id: string;
  repo_path: string;
  applied: boolean;
  prune: BranchItem[]; // task done -> branch goes
  unlanded: BranchItem[]; // cancelled/failed -> branch kept on purpose
  active: BranchItem[]; // live task -> untouched
  unowned: BranchItem[]; // no task row -> a human should look once
  ghost: BranchItem[]; // ghost-<taskId> WIP rescues -> reported, never deleted
  other: BranchItem[]; // not hive's branches at all -> reported, never deleted
  worktrees: WorktreeItem[]; // terminal-task checkouts to remove
  deleted_local: string[];
  deleted_remote: string[];
  removed_worktrees: string[];
  reclaimed_kb: number;
  skipped: { what: string; reason: string }[];
}

export interface GardenOpts {
  apply?: boolean; // default false: dry run
  remote?: boolean; // also delete the matching origin branch (apply only)
  projectId?: string; // limit to one project
  exec?: Exec;
}

// `<branch> <sha>` per local branch.
function parseBranchList(stdout: string): { branch: string; sha: string }[] {
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [branch, sha] = l.split(/\s+/);
      return { branch, sha: sha ?? "" };
    });
}

// `ghost-<taskId>` and `ghost-<taskId>-2` both belong to <taskId>. The suffix is
// a retry counter (herdr.freeGhostBranch), not part of the id.
export function taskIdFromGhostBranch(branch: string): string | null {
  const m = /^ghost-([0-9a-f]{12})(?:-\d+)?$/.exec(branch);
  return m ? m[1] : null;
}

async function sizeKb(exec: Exec, path: string): Promise<number> {
  try {
    const r = await exec(["du", "-sk", path]);
    return r.code === 0 ? Number(r.stdout.trim().split(/\s+/)[0]) || 0 : 0;
  } catch {
    return 0;
  }
}

export async function gardenRepos(db: DB, opts: GardenOpts = {}): Promise<GardenReport[]> {
  const exec = opts.exec ?? defaultExec;
  const projects = activeProjects(db).filter(
    (p) => p.repo_path && (!opts.projectId || p.id === opts.projectId)
  ) as { id: string; repo_path: string; config: string | null }[];
  const out: GardenReport[] = [];
  for (const p of projects) out.push(await gardenRepo(db, p, exec, opts));
  return out;
}

async function gardenRepo(
  db: DB,
  project: { id: string; repo_path: string; config: string | null },
  exec: Exec,
  opts: GardenOpts
): Promise<GardenReport> {
  const repo = project.repo_path;
  const report: GardenReport = {
    project_id: project.id,
    repo_path: repo,
    applied: !!opts.apply,
    prune: [],
    unlanded: [],
    active: [],
    unowned: [],
    ghost: [],
    other: [],
    worktrees: [],
    deleted_local: [],
    deleted_remote: [],
    removed_worktrees: [],
    reclaimed_kb: 0,
    skipped: [],
  };
  let config: any = {};
  try {
    config = JSON.parse(project.config ?? "{}") ?? {};
  } catch {
    config = {};
  }
  const base = projectBaseBranch(config);

  const wtList = await exec(["git", "-C", repo, "worktree", "list", "--porcelain"]);
  if (wtList.code !== 0) {
    report.skipped.push({ what: repo, reason: `worktree list failed: ${wtList.stderr.trim().slice(0, 200)}` });
    return report;
  }
  // branch -> worktree path, for the "never delete a checked-out branch" rule.
  const byBranch = new Map<string, string>();
  for (const wt of parseWorktreeList(wtList.stdout)) if (wt.branch) byBranch.set(wt.branch, wt.path);

  const refs = await exec(["git", "-C", repo, "for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads/"]);
  if (refs.code !== 0) {
    report.skipped.push({ what: repo, reason: `for-each-ref failed: ${refs.stderr.trim().slice(0, 200)}` });
    return report;
  }

  // One call for the whole "is this tip already in base" question, so the
  // ghost/other report can say what a human can safely clear without asking git
  // 500 times. A squash-merged branch is NOT listed here — that is exactly why
  // hive's own branches are judged by task state instead.
  const mergedSet = new Set<string>();
  const merged = await exec(["git", "-C", repo, "branch", "--merged", base, "--format=%(refname:short)"]);
  if (merged.code === 0)
    for (const l of merged.stdout.split("\n").map((x) => x.trim()).filter(Boolean)) mergedSet.add(l);

  for (const b of parseBranchList(refs.stdout)) {
    const taskId = taskIdFromBranch(b.branch);
    const ghostTaskId = taskId ? null : taskIdFromGhostBranch(b.branch);
    const owner = taskId ?? ghostTaskId;
    const task = owner ? getTask(db, owner) : null;
    const item: BranchItem = {
      branch: b.branch,
      task_id: owner ?? "",
      sha: b.sha,
      state: (task?.state as State) ?? null,
      worktree: byBranch.get(b.branch) ?? null,
      merged: mergedSet.has(b.branch),
    };
    if (ghostTaskId) {
      // Rescued uncommitted work. The task reaching done says the PR landed; it
      // says nothing about this snapshot, so the branch stays either way.
      report.ghost.push(item);
      continue;
    }
    if (!taskId) {
      if (b.branch !== base) report.other.push(item);
      continue;
    }
    if (!task) report.unowned.push(item);
    else if (task.state === "done") report.prune.push(item);
    else if (TERMINAL.includes(task.state as State)) report.unlanded.push(item);
    else report.active.push(item);
    // A worktree on a TERMINAL task's branch is pure disk: the commits stay on
    // the branch (which we keep unless the task is done), so removing the
    // checkout can only lose uncommitted files — and a dirty tree (untracked
    // files included) is skipped below rather than removed.
    const wtPath = item.worktree;
    if (wtPath && task && TERMINAL.includes(task.state as State)) {
      report.worktrees.push({
        path: wtPath,
        branch: b.branch,
        task_id: taskId,
        state: task.state as State,
        size_kb: await sizeKb(exec, wtPath),
      });
    }
  }

  if (!opts.apply) return report;

  // 1) worktrees first: a branch checked out anywhere cannot be deleted.
  for (const wt of report.worktrees) {
    // Any porcelain line counts, `??` included: an untracked file can be work
    // nobody has committed yet. Ignored build junk (node_modules) is not listed
    // by --porcelain, so it never blocks. No --force either, so git's own
    // dirty/locked checks stay as the backstop if the status read went wrong.
    const status = await exec(["git", "-C", wt.path, "status", "--porcelain"]);
    const dirty = status.code !== 0 || status.stdout.split("\n").some((l) => l.trim().length > 0);
    if (dirty) {
      report.skipped.push({ what: wt.path, reason: "uncommitted changes" });
      continue;
    }
    const rm = await exec(["git", "-C", repo, "worktree", "remove", wt.path]);
    if (rm.code !== 0) {
      report.skipped.push({ what: wt.path, reason: `worktree remove failed: ${(rm.stderr || rm.stdout).trim().slice(0, 200)}` });
      continue;
    }
    report.removed_worktrees.push(wt.path);
    report.reclaimed_kb += wt.size_kb;
    byBranch.delete(wt.branch);
  }

  // 2) local branches of DONE tasks. `-D` because a squash merge leaves the
  //    branch "unmerged" to git; the task reaching done is the merge proof, and
  //    the tip sha is in the report if anyone needs it back.
  for (const item of report.prune) {
    if (byBranch.has(item.branch)) {
      report.skipped.push({ what: item.branch, reason: `checked out at ${byBranch.get(item.branch)}` });
      continue;
    }
    const del = await exec(["git", "-C", repo, "branch", "-D", item.branch]);
    if (del.code !== 0) {
      report.skipped.push({ what: item.branch, reason: `branch -D failed: ${(del.stderr || del.stdout).trim().slice(0, 200)}` });
      continue;
    }
    report.deleted_local.push(item.branch);
  }

  // 3) matching origin branches, opt-in. One ls-remote up front, then one
  //    batched push --delete: 400 sequential pushes is minutes of network.
  if (opts.remote && report.deleted_local.length) {
    const ls = await exec(["git", "-C", repo, "ls-remote", "--heads", "origin", "hive/*"]);
    if (ls.code !== 0) {
      report.skipped.push({ what: "origin", reason: `ls-remote failed: ${ls.stderr.trim().slice(0, 200)}` });
      return report;
    }
    const onOrigin = new Set(
      ls.stdout
        .split("\n")
        .map((l) => l.trim().split(/\s+/)[1])
        .filter(Boolean)
        .map((ref) => ref.replace(/^refs\/heads\//, ""))
    );
    const targets = report.deleted_local.filter((b) => onOrigin.has(b) && b !== base);
    for (let i = 0; i < targets.length; i += 100) {
      const chunk = targets.slice(i, i + 100);
      const push = await exec(["git", "-C", repo, "push", "origin", "--delete", ...chunk]);
      if (push.code !== 0) {
        report.skipped.push({ what: chunk.join(" "), reason: `push --delete failed: ${(push.stderr || push.stdout).trim().slice(0, 200)}` });
        continue;
      }
      report.deleted_remote.push(...chunk);
    }
  }

  return report;
}

// One screen a director can read before letting the real run go.
export function formatGardenReport(r: GardenReport): string {
  const gb = (kb: number) => `${(kb / 1024 / 1024).toFixed(1)}GB`;
  const L: string[] = [];
  L.push(`${r.repo_path}  (${r.applied ? "APPLIED" : "dry run"})`);
  L.push(`  done tasks, branch goes:      ${r.prune.length}`);
  L.push(`  cancelled/failed, branch kept: ${r.unlanded.length}`);
  L.push(`  active tasks, untouched:      ${r.active.length}`);
  L.push(`  no task in hive, look once:   ${r.unowned.length}${r.unowned.length ? `  (${r.unowned.map((b) => b.branch).join(", ")})` : ""}`);
  L.push(`  ghost WIP rescues, kept:      ${r.ghost.length}  (unlanded work; clear by hand)`);
  L.push(`  branches hive does not own:   ${r.other.length}  (${r.other.filter((b) => b.merged).length} already in ${r.other.length ? "the base branch" : "base"})`);
  L.push(`  worktrees of terminal tasks:  ${r.worktrees.length}  ${gb(r.worktrees.reduce((n, w) => n + w.size_kb, 0))}`);
  if (r.applied) {
    L.push(`  deleted: ${r.deleted_local.length} local, ${r.deleted_remote.length} on origin, ${r.removed_worktrees.length} worktrees`);
    L.push(`  reclaimed: ${gb(r.reclaimed_kb)}`);
  }
  for (const s of r.skipped) L.push(`  skipped ${s.what}: ${s.reason}`);
  return L.join("\n");
}
