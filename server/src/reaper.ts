// Periodic reaper: the backstop for worktree/session teardowns that were skipped
// or missed. Every cycle it enumerates hive worker worktrees (`git worktree
// list` across every project repo) and, for each whose task id maps to a
// TERMINAL task (or to no task at all), tears it down — guarded so unmerged or
// uncommitted work is never lost (see herdr.cleanupWorktree). Live/queued tasks
// keep their worktree. It then separately diffs `herdr agent list` against
// live DB tasks (sweepOrphanedAgents) to catch sessions the worktree-branch
// pass can't see — e.g. a task row that no longer exists at all (task #341).
// Isolated try/catch per item; a failure never crashes the server. Mirrors the
// reconciler loop pattern.
import type { DB } from "./db.ts";
import { getTask, TERMINAL, type State } from "./state.ts";
import { Herdr, herdr as defaultHerdr, parseWorktreeList } from "./runtime/herdr.ts";
import { cleanupTask } from "./cleanup.ts";
import { broadcast } from "./bus.ts";
import type { Exec } from "./exec.ts";
import { defaultExec } from "./exec.ts";

export interface ReaperDeps {
  herdr?: Herdr;
  exec?: Exec; // for `git worktree list`
}

// A hive worker worktree is checked out on `hive/<taskId>`. Ghost branches
// (`ghost-<taskId>`, preserved WIP) and the main checkout never match, so they
// are never reaped.
export function taskIdFromBranch(branch: string | null): string | null {
  const m = branch ? /^hive\/([^/]+)$/.exec(branch) : null;
  return m ? m[1] : null;
}

export async function reapOnce(db: DB, deps: ReaperDeps = {}): Promise<void> {
  const herdr = deps.herdr ?? defaultHerdr;
  const exec = deps.exec ?? defaultExec;
  const projects = db
    .query("SELECT id, repo_path FROM projects WHERE repo_path IS NOT NULL")
    .all() as { id: string; repo_path: string }[];

  for (const p of projects) {
    let list;
    try {
      list = await exec(["git", "-C", p.repo_path, "worktree", "list", "--porcelain"]);
    } catch (e) {
      console.error(`[hive] reaper worktree list ${p.repo_path}:`, e);
      continue;
    }
    if (list.code !== 0) continue;

    for (const wt of parseWorktreeList(list.stdout)) {
      const taskId = taskIdFromBranch(wt.branch);
      if (!taskId) continue; // not a hive worker worktree
      try {
        const task = getTask(db, taskId);
        // A live/queued task keeps its worktree — never touch non-terminal work.
        if (task && !TERMINAL.includes(task.state as State)) continue;
        if (task) {
          await cleanupTask(db, herdr, taskId, { force: true });
        } else {
          await reapOrphan(db, herdr, p.repo_path, wt.branch!, wt.path);
        }
      } catch (e) {
        console.error(`[hive] reaper ${taskId}:`, e); // isolated; never crash the sweep
      }
    }
  }

  try {
    await sweepOrphanedAgents(db, deps);
  } catch (e) {
    console.error("[hive] reaper agent sweep:", e); // isolated; never crash the sweep
  }
}

// Diff every herdr-visible agent (named by task id) against the DB. A name
// with no task row at all is a true orphan — the worktree-branch pass above
// never sees it once its worktree is gone, and it would otherwise sit running
// forever (exactly what task #341 found: 5 of 6 stale agents had zero
// corresponding DB task). A name that DOES resolve to a task is left to
// cleanupTask, which already knows whether that task's worktree/session is
// safe to close — this never second-guesses a preserved (unmerged) worktree.
export async function sweepOrphanedAgents(db: DB, deps: ReaperDeps = {}): Promise<void> {
  const herdr = deps.herdr ?? defaultHerdr;
  const agents = await herdr.listAgents();
  for (const a of agents) {
    try {
      const task = getTask(db, a.name);
      if (task && !TERMINAL.includes(task.state as State)) continue; // live task, keep it
      if (task) {
        await cleanupTask(db, herdr, a.name, { force: true });
        continue;
      }
      const r = await herdr.closeSession({ agentTarget: a.name, tabId: a.tabId });
      broadcast({ type: "reaped_orphan_agent", name: a.name, closed: r.closed, via: r.via });
    } catch (e) {
      console.error(`[hive] reaper orphan agent ${a.name}:`, e); // isolated; never crash the sweep
    }
  }
}

// A worktree whose task record no longer exists: no task to attach an event to,
// so remove it (guarded) and broadcast a signal instead.
async function reapOrphan(db: DB, herdr: Herdr, repoPath: string, branch: string, worktreePath: string): Promise<void> {
  const taskId = taskIdFromBranch(branch)!;
  const r = await herdr.cleanupWorktree({ repoPath, branch, worktreePath, taskId });
  broadcast({
    type: "reaped_orphan",
    branch,
    worktree_path: worktreePath,
    removed: r.removed,
    reason: r.reason,
    ghost_branch: r.ghost_branch,
  });
}

// Background loop. Started only from index.ts (never in tests).
export function startReaper(db: DB, deps: ReaperDeps & { intervalMs?: number } = {}): () => void {
  const intervalMs = deps.intervalMs ?? 300_000;
  const timer = setInterval(() => {
    reapOnce(db, deps).catch((e) => console.error("[hive] reaper cycle crashed:", e));
  }, intervalMs);
  return () => clearInterval(timer);
}
