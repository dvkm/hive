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
import { setSetting, now, isOffline } from "./db.ts";
import { getTask, TERMINAL, type State } from "./state.ts";
import { Herdr, herdr as defaultHerdr, parseWorktreeList } from "./runtime/herdr.ts";
import { cleanupTask, releaseReviewAgents } from "./cleanup.ts";
import { teardownBlocked } from "./teardownGuard.ts";
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
  // Offline is the director's stop button. It gated dispatch only, so the reaper
  // kept closing tabs and removing worktrees while the fleet was supposedly
  // paused (2026-08-19). Everything here is a side effect; skip the whole sweep.
  if (isOffline(db)) {
    setSetting(db, "last_reap_at", now()); // the loop is healthy, just idle
    return;
  }
  // Same two gates the reconciler's recovery path uses: don't remove worktrees
  // or close tabs while hive's own view of the fleet is unreliable (the minutes
  // right after a boot/self-deploy, or while the death-burst breaker is open).
  const blocked = teardownBlocked(db);
  if (blocked) {
    console.log(`[hive] reaper sweep held: ${blocked}`);
    setSetting(db, "last_reap_at", now()); // the loop is healthy, just holding
    return;
  }
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

  // Free the agents parked on review BEFORE the orphan sweeps: they are live,
  // idle/done and holding both a pty and a dispatch slot (see releaseReviewAgent).
  try {
    await releaseReviewAgents(db, herdr);
  } catch (e) {
    console.error("[hive] reaper review-agent release:", e); // isolated; never crash the sweep
  }

  try {
    await sweepOrphanedAgents(db, deps);
  } catch (e) {
    console.error("[hive] reaper agent sweep:", e); // isolated; never crash the sweep
  }

  try {
    await sweepOrphanedPanes(db, deps);
  } catch (e) {
    console.error("[hive] reaper pane sweep:", e); // isolated; never crash the sweep
  }

  try {
    sweepFinishedTestProjects(db);
  } catch (e) {
    console.error("[hive] reaper test-project sweep:", e); // isolated; never crash the sweep
  }

  // Liveness heartbeat, written only once a cycle COMPLETES so a wedged sweep
  // (e.g. a hung `git worktree list`) ages toward stale instead of a fresh
  // setInterval tick re-marking it. See dispatcher.ts.
  setSetting(db, "last_reap_at", now());
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

// A pane's cwd basename is the worktree dir `hive-<taskId>` (branch
// hive/<taskId>), the same shape across every project repo. This maps a pane
// back to its task without a fragile per-repo label scheme; David's own shells
// and non-hive checkouts have a different cwd and never match, so the sweep
// never touches them. Task ids are 12 lowercase-hex (db.newId); `{6,}` tolerates
// any future length while still excluding plain names like `hive-fleet`.
export function taskIdFromCwd(cwd: string | null): string | null {
  if (!cwd) return null;
  const base = (cwd.replace(/\/+$/, "").split("/").pop() ?? "");
  const m = /^hive-([0-9a-f]{6,})$/.exec(base);
  return m ? m[1] : null;
}

// The pty-leak sweep. The leak is held by PANES (one pty each), and the two
// biggest leak sources are invisible to `agent list`: (1) the per-task workspace
// `worktree create` auto-spawns, whose lone pane the agent never uses, and (2) a
// fleet tab whose agent already exited. Both persist after the task is long
// terminal (2026-07-25: 452 of 511 ptys were day-old sessions of finished
// tasks). This enumerates every pane, maps it to a task by cwd, and reclaims the
// pty for any whose task is TERMINAL or gone.
//
// SAFETY (the one dangerous regression — closing a live agent): a pane is closed
// ONLY when the task parsed from its cwd is terminal (done/failed/cancelled) or
// has no row at all. A live agent belongs, by construction, to a NON-terminal
// task (it's in an agent-bearing state), so `getTask(...).state` is not in
// TERMINAL, the `continue` below fires, and its pane is never touched. The
// decision reads the authoritative DB state, not a herdr probe, so a transient
// herdr hiccup can't misclassify live work. The vanished-mid-flight case (agent
// died, task still in_progress) is left to the reconciler on purpose: the sweep
// keeps that session until the reconciler moves the task terminal, then reaps.
export async function sweepOrphanedPanes(db: DB, deps: ReaperDeps = {}): Promise<void> {
  const herdr = deps.herdr ?? defaultHerdr;
  const panes = await herdr.listPanes();
  // Record utilization for /api/health BEFORE reaping: this is the pre-sweep
  // high-water mark, the number that actually approaches the pty wall.
  setSetting(db, "herdr_pane_count", String(panes.length));
  setSetting(db, "herdr_pane_at", now());

  // Must know the fleet workspace id before closing anything: without it a fleet
  // tab would fall into the workspace-close branch below and take the WHOLE fleet
  // (every live agent) with it. If we can't resolve it (herdr flaky/down), record
  // the count and skip reaping this cycle — the next cycle retries.
  const fleetWs = await herdr.fleetWorkspaceId();
  if (!fleetWs) return;

  for (const p of panes) {
    const taskId = taskIdFromCwd(p.cwd);
    if (!taskId) continue; // not a hive-managed pane
    try {
      const task = getTask(db, taskId);
      if (task && !TERMINAL.includes(task.state as State)) continue; // live — keep

      if (fleetWs && p.workspaceId === fleetWs) {
        // Fleet tab of a terminal/orphan task: close the tab, NOT the shared
        // fleet workspace (that would kill every live agent).
        if (p.tabId) {
          const r = await herdr.closeSession({ agentTarget: taskId, tabId: p.tabId });
          if (r.closed) broadcast({ type: "reaped_orphan_pane", task_id: taskId, via: r.via });
        }
      } else if (p.workspaceId && p.workspaceId !== fleetWs) {
        // The worktree's own workspace: close it whole (its single pane is the
        // leaked pty). Guarded above so the fleet workspace is never closed here.
        const r = await herdr.closeWorkspace(p.workspaceId);
        if (r.code === 0) broadcast({ type: "reaped_orphan_pane", task_id: taskId, via: `workspace ${p.workspaceId}` });
      }
    } catch (e) {
      console.error(`[hive] reaper orphan pane ${taskId}:`, e); // isolated; never crash the sweep
    }
  }
}

// A test/ephemeral project (config.test = true, see testProjects.ts) auto-
// archives once every task it owns is terminal — the "auto-reap" half of
// #1020: scratch board noise from an agent's own live E2E run clears itself
// instead of sitting in the project list forever. A project with zero tasks
// yet is left alone (just created, not "finished"). Archiving (not deleting)
// reuses the existing hide mechanism GET /api/projects already has for
// config.archived, and keeps the row around in case someone needs to check
// what happened.
export function sweepFinishedTestProjects(db: DB): void {
  const projects = db
    .query(
      `SELECT id, config FROM projects
        WHERE COALESCE(json_extract(config, '$.test'), 0) = 1
          AND COALESCE(json_extract(config, '$.archived'), 0) = 0`
    )
    .all() as { id: string; config: string }[];
  for (const p of projects) {
    const states = (db.query("SELECT state FROM tasks WHERE project_id = ?").all(p.id) as { state: string }[]).map((r) => r.state);
    if (!states.length || states.some((s) => !TERMINAL.includes(s as State))) continue;
    let config: any;
    try {
      config = JSON.parse(p.config);
    } catch {
      config = {};
    }
    config.archived = true;
    db.query("UPDATE projects SET config = ? WHERE id = ?").run(JSON.stringify(config), p.id);
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
