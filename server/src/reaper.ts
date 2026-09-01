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
import { getTask, writeEvent, TERMINAL, type State } from "./state.ts";
import { Herdr, herdr as defaultHerdr, parseWorktreeList, paneHasLiveProcess, paneRunsAgentCommand, type PaneInfo } from "./runtime/herdr.ts";
import { cleanupTask, releaseReviewAgents } from "./cleanup.ts";
import { activeProjects } from "./testProjects.ts";
import { teardownBlocked } from "./teardownGuard.ts";
import { broadcast } from "./bus.ts";
import { enqueue } from "./notifications.ts";
import type { Exec } from "./exec.ts";
import { defaultExec } from "./exec.ts";
import { startLoop } from "./loop.ts";

export interface ReaperDeps {
  herdr?: Herdr;
  exec?: Exec; // for `git worktree list`
  instanceId?: string; // this server's lease instance; a displaced server must not reap
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
  // Same gates the reconciler's recovery path uses: don't remove worktrees
  // or close tabs while hive's own view of the fleet is unreliable (the minutes
  // right after a boot/self-deploy, or while the death-burst breaker is open).
  const blocked = teardownBlocked(db, Date.now(), deps.instanceId);
  if (blocked) {
    console.log(`[hive] reaper sweep held: ${blocked}`);
    setSetting(db, "last_reap_at", now()); // the loop is healthy, just holding
    return;
  }
  const herdr = deps.herdr ?? defaultHerdr;
  const exec = deps.exec ?? defaultExec;
  const projects = activeProjects(db).filter((p) => p.repo_path) as { id: string; repo_path: string }[];

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
        // The row's path/branch is what cleanupTask removes. Once they are
        // NULL it can no longer touch the checkout, so use the worktree the
        // reaper actually enumerated (same guarded removal, minus the row).
        if (task?.worktree_path && task.branch) {
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
    await sweepZombiePanes(db, deps);
  } catch (e) {
    console.error("[hive] reaper zombie-pane sweep:", e); // isolated; never crash the sweep
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
      const r = await herdr.closeSession({
        agentTarget: a.name,
        // A vanished task row leaves no cwd or terminal id with which to prove
        // ownership of the recorded tab. Resolve the named agent's exact pane
        // instead, so an orphan sweep can never close a reused or mixed tab.
        tabId: null,
        request: { caller: "reaper.sweepOrphanedAgents", reason: "orphan task agent", taskId: a.name },
      });
      broadcast({ type: "reaped_orphan_agent", name: a.name, closed: r.closed, via: r.via });
    } catch (e) {
      console.error(`[hive] reaper orphan agent ${a.name}:`, e); // isolated; never crash the sweep
    }
  }
}

// A pane's cwd basename is the worktree dir `hive-<taskId>` (branch
// hive/<taskId>), the same shape across every project repo. This maps a pane
// back to its task without a fragile per-repo label scheme; the director's own shells
// and non-hive checkouts have a different cwd and never match, so the sweep
// never touches them. Task ids are 12 lowercase-hex (db.newId); `{6,}` tolerates
// any future length while still excluding plain names like `hive-fleet`.
export function taskIdFromCwd(cwd: string | null): string | null {
  if (!cwd) return null;
  const base = (cwd.replace(/\/+$/, "").split("/").pop() ?? "");
  const m = /^hive-([0-9a-f]{6,})$/.exec(base);
  return m ? m[1] : null;
}

function targetBelongsOnlyToTask(panes: Awaited<ReturnType<Herdr["listPanes"]>>, key: "tabId" | "workspaceId", id: string, taskId: string): boolean {
  const held = panes.filter((pane) => pane[key] === id);
  return held.length > 0 && held.every((pane) => taskIdFromCwd(pane.cwd) === taskId);
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
          if (!targetBelongsOnlyToTask(panes, "tabId", p.tabId, taskId)) continue;
          const r = await herdr.closeSession({
            agentTarget: taskId,
            tabId: p.tabId,
            expectCwd: p.cwd,
            request: { caller: "reaper.sweepOrphanedPanes", reason: task ? "terminal task pane" : "orphan task pane", taskId },
          });
          if (r.closed) broadcast({ type: "reaped_orphan_pane", task_id: taskId, via: r.via });
        }
      } else if (p.workspaceId && p.workspaceId !== fleetWs) {
        // The worktree's own workspace: close it whole (its single pane is the
        // leaked pty). Guarded above so the fleet workspace is never closed here.
        if (!targetBelongsOnlyToTask(panes, "workspaceId", p.workspaceId, taskId)) continue;
        const r = await herdr.closeWorkspace({
          workspaceId: p.workspaceId,
          expectCwd: p.cwd ?? "",
          request: { caller: "reaper.sweepOrphanedPanes", reason: task ? "terminal task workspace" : "orphan task workspace", taskId },
        });
        if (r.code === 0) broadcast({ type: "reaped_orphan_pane", task_id: taskId, via: `workspace ${p.workspaceId}` });
      }
    } catch (e) {
      console.error(`[hive] reaper orphan pane ${taskId}:`, e); // isolated; never crash the sweep
    }
  }
}

// Reap ZOMBIE panes: pane rows whose process already exited but whose herdr
// row lingers (task #1706 / 2026-08-26 — a session restart left 3 dead agents
// with ~5 pane rows apiece, fleet tab + own workspace, all at zero processes).
// This is what blocks a respawn: `Herdr.spawn` refuses as long as the task's
// name still resolves to a pane, and the dispatcher's own respawn query only
// considers tasks with agent_target IS NULL (dispatcher.ts). Both stay stuck
// until these panes and that binding are cleared.
//
// Independent of task state on purpose — that's what makes it safe to run
// even while the row shows non-terminal (e.g. queued for respawn): a genuinely
// live agent always has a live process in at least one of its panes, so the
// per-worktree liveness check below can never mistake it for dead. Grouped by
// taskId (all panes sharing that worktree's cwd) so a fleet tab's second pane
// or the worktree's own workspace pane can't be judged in isolation.
export async function sweepZombiePanes(db: DB, deps: ReaperDeps = {}): Promise<void> {
  const herdr = deps.herdr ?? defaultHerdr;
  const panes = await herdr.listPanes();
  const byTask = new Map<string, PaneInfo[]>();
  for (const p of panes) {
    const taskId = taskIdFromCwd(p.cwd);
    if (!taskId) continue; // not a hive-managed pane
    const group = byTask.get(taskId);
    if (group) group.push(p);
    else byTask.set(taskId, [p]);
  }

  for (const [taskId, group] of byTask) {
    try {
      let anyLive = false;
      for (const p of group) {
        if (paneHasLiveProcess(await herdr.paneProcessInfo(p.paneId))) {
          anyLive = true;
          break;
        }
      }
      if (anyLive) continue; // SAFETY: never touch a worktree with any live process

      for (const p of group) {
        const r = await herdr.closePane(p.paneId, {
          caller: "reaper.zombiePanes",
          reason: "pane process gone but row still held the agent name",
          taskId,
        });
        if (r.closed) broadcast({ type: "reaped_zombie_pane", task_id: taskId, pane_id: p.paneId });
      }
      // Unblock the next spawn attempt: dispatcher.ts only respawns tasks with
      // agent_target IS NULL.
      db.query("UPDATE tasks SET agent_target = NULL, updated_at = ? WHERE id = ? AND agent_target IS NOT NULL").run(now(), taskId);
    } catch (e) {
      console.error(`[hive] reaper zombie pane ${taskId}:`, e); // isolated; never crash the sweep
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

// Is this pane sitting inside that worktree checkout? Path comparison, not the
// `hive-<taskId>` basename parse taskIdFromCwd does: the worktree that killed
// the HIVE-213 agent was `hive-46c8e9afa8af-main` (suffixed because its base
// branch history was disjoint), which that regex does not match at all.
export function paneInWorktree(cwd: string | null, worktreePath: string): boolean {
  if (!cwd || !worktreePath) return false;
  const trim = (s: string) => s.replace(/\/+$/, "");
  const wt = trim(worktreePath);
  const c = trim(cwd);
  return c === wt || c.startsWith(wt + "/");
}

// The liveness guard for a worktree with NO task row, resolved by PATH because
// there is no agent_target to probe. Two signals, in order of confidence:
//   1. a pane herdr's registry still labels with an agent name → probe it, and
//      defer on the same predicate cleanupTask uses (alive AND working/blocked;
//      "unknown" does NOT defer, so a herdr outage cannot wedge cleanup shut).
//   2. no label (a desktop-app restart wipes the registry while the claude
//      processes keep running — the false-dead incident) → fall back to the
//      pane's own root process. paneRunsAgentCommand is the right test here,
//      not "any process": a fleet tab's root pane sits at the same cwd running
//      a login shell, and treating that as live would pin orphans forever.
async function liveAgentInWorktree(herdr: Herdr, worktreePath: string): Promise<{ target: string; status: string } | null> {
  for (const pane of (await herdr.listPanes()).filter((p) => paneInWorktree(p.cwd, worktreePath))) {
    if (pane.label) {
      const probe = await herdr.probe(pane.label).catch(() => ({ alive: false, status: "unknown" as const }));
      if (probe.alive && (probe.status === "working" || probe.status === "blocked")) return { target: pane.label, status: probe.status };
      continue;
    }
    if (paneRunsAgentCommand(await herdr.paneProcessInfo(pane.paneId))) return { target: pane.paneId, status: "unregistered" };
  }
  return null;
}

// A worktree with no usable task metadata — the row is gone, or it lost its
// worktree_path/branch. Removal is guarded twice: an agent still working in the
// directory defers it (see liveAgentInWorktree), and cleanupWorktree still
// rescues uncommitted work before removing anything.
//
// Every outcome leaves a DURABLE record, not just a broadcast. reapOrphan used
// to write nothing at all, so a worktree vanished from under an agent with no
// event anywhere and three separate investigations blamed cleanupTask and the
// deploy instead (HIVE-624). An event when a task row exists, a notification
// when it does not (events.task_id is a NOT NULL foreign key).
async function reapOrphan(db: DB, herdr: Herdr, repoPath: string, branch: string, worktreePath: string): Promise<void> {
  const taskId = taskIdFromBranch(branch)!;
  const live = await liveAgentInWorktree(herdr, worktreePath);
  if (live) {
    // Deferrals are not recorded durably on purpose: the reaper retries every
    // sweep, and one row per lap for the whole life of a long agent is noise.
    console.log(`[hive] reaper orphan ${branch}: agent ${live.target} is ${live.status} in ${worktreePath} — deferring removal`);
    broadcast({ type: "reaped_orphan_deferred", branch, worktree_path: worktreePath, agent: live.target, status: live.status });
    return;
  }
  const r = await herdr.cleanupWorktree({ repoPath, branch, worktreePath, taskId });
  broadcast({
    type: "reaped_orphan",
    branch,
    worktree_path: worktreePath,
    removed: r.removed,
    reason: r.reason,
    ghost_branch: r.ghost_branch,
  });
  if (!r.removed) return; // nothing was torn down; nothing to attribute
  // Once per branch. git can keep listing a worktree that is already gone from
  // disk, and cleanupWorktree calls that a successful removal — without this,
  // every 300s lap would re-record the same teardown (the #1112 event flood).
  const task = getTask(db, taskId);
  const title = `Removed an orphan worktree (${branch})`;
  if (task) {
    const already = db
      .query("SELECT 1 FROM events WHERE task_id = ? AND type = 'reaped_orphan_worktree' AND json_extract(payload, '$.branch') = ? LIMIT 1")
      .get(taskId, branch);
    if (already) return;
    writeEvent(db, {
      task_id: taskId,
      source: "reaper",
      type: "reaped_orphan_worktree",
      payload: { branch, worktree_path: worktreePath, reason: r.reason, ghost_branch: r.ghost_branch, why_orphan: "task row has no worktree_path/branch" },
    });
    return;
  }
  if (db.query("SELECT 1 FROM notifications WHERE title = ? LIMIT 1").get(title)) return;
  enqueue(db, {
    kind: "incident",
    title,
    body: `${worktreePath} was on branch ${branch} with no task row, so the reaper removed it (${r.reason}).${r.ghost_branch ? ` Uncommitted work was rescued to ${r.ghost_branch}.` : ""}`,
  });
}

// Background loop. Started only from index.ts (never in tests).
export function startReaper(db: DB, deps: ReaperDeps & { intervalMs?: number } = {}): () => void {
  return startLoop("reaper", deps.intervalMs ?? 300_000, () => reapOnce(db, deps));
}
