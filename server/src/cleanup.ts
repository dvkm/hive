// Auto-teardown for finished tasks: remove the git worktree (guarded so no
// unmerged or uncommitted work is ever lost) and close the herdr session (the
// labelled tab + its agent), then emit a `cleaned_up` / `cleanup_skipped` event.
//
// Fired two ways: from the transition path (state.setTerminalHook, on done /
// cancelled) for immediacy, and from the reaper sweep (reaper.ts) as the
// backstop for teardowns that were skipped or missed. Idempotent: it clears the
// task's runtime binding after a successful removal so a re-run is a no-op.
import type { DB } from "./db.ts";
import { now } from "./db.ts";
import { getTask, writeEvent, TERMINAL, type State } from "./state.ts";
import { Herdr, herdr as defaultHerdr } from "./runtime/herdr.ts";
import type { Exec } from "./exec.ts";
import { defaultExec } from "./exec.ts";

// Per-project stack teardown, run BEFORE the worktree is removed (the command
// usually needs files inside it, e.g. corebeat's wt.sh). Config:
//   config.cleanup_argv = ["infra/worktree/wt.sh", "down", "{worktree}"]
// Relative argv[0] resolves against repo_path; {worktree} substitutes the
// task's worktree path. Best-effort with a hard timeout — a failed teardown
// never blocks worktree/session cleanup (256 orphaned docker containers,
// 2026-07-13, were stacks nothing ever tore down).
async function runCleanupCmd(
  db: DB,
  taskId: string,
  argvTemplate: unknown,
  repoPath: string,
  worktreePath: string,
  exec: Exec
): Promise<void> {
  if (!Array.isArray(argvTemplate) || !argvTemplate.length) return;
  const argv = argvTemplate.map((a) => String(a).replaceAll("{worktree}", worktreePath));
  if (!argv[0].startsWith("/")) argv[0] = `${repoPath}/${argv[0]}`;
  try {
    // Exec has no timeout; race one so a hung teardown can't stall the reaper.
    const r = await Promise.race([
      exec(argv, { cwd: repoPath }),
      new Promise<{ code: number; stdout: string; stderr: string }>((resolve) =>
        setTimeout(() => resolve({ code: 124, stdout: "", stderr: "cleanup command timed out (120s)" }), 120_000)
      ),
    ]);
    writeEvent(db, {
      task_id: taskId,
      source: "reaper",
      type: "stack_teardown",
      payload: { argv, ok: r.code === 0, ...(r.code !== 0 ? { error: (r.stderr || r.stdout).slice(0, 300) } : {}) },
    });
  } catch (e: any) {
    writeEvent(db, {
      task_id: taskId,
      source: "reaper",
      type: "stack_teardown",
      payload: { argv, ok: false, error: String(e?.message ?? e).slice(0, 300) },
    });
  }
}

export interface CleanupOutcome {
  cleaned: boolean;
  worktree: { removed: boolean; reason: string; ghost_branch: string | null } | null;
  session: { closed: boolean; via: string | null };
}

// The `spawned` event carries the herdr tab id (the task row does not store it).
function spawnMeta(db: DB, taskId: string): { tab_id: string | null } {
  const r = db
    .query("SELECT payload FROM events WHERE task_id = ? AND type = 'spawned' ORDER BY ts DESC LIMIT 1")
    .get(taskId) as { payload: string } | undefined;
  if (!r) return { tab_id: null };
  try {
    return { tab_id: JSON.parse(r.payload).tab_id ?? null };
  } catch {
    return { tab_id: null };
  }
}

// Tear down a finished task. `force` skips the terminal-state guard (used by the
// manual endpoint and the reaper, which have already established eligibility).
export async function cleanupTask(
  db: DB,
  herdr: Herdr = defaultHerdr,
  taskId: string,
  opts: { force?: boolean; exec?: Exec } = {}
): Promise<CleanupOutcome> {
  const noop: CleanupOutcome = { cleaned: false, worktree: null, session: { closed: false, via: null } };
  const task = getTask(db, taskId);
  if (!task) return noop;
  if (!opts.force && !TERMINAL.includes(task.state as State)) return noop;

  const project = db.query("SELECT repo_path, config FROM projects WHERE id = ?").get(task.project_id) as
    | { repo_path: string | null; config: string | null }
    | undefined;
  const repoPath = project?.repo_path ?? null;
  let defaultBranch: string | undefined;
  try {
    defaultBranch = JSON.parse(project?.config ?? "{}").default_branch;
  } catch {
    defaultBranch = undefined;
  }

  // 0) per-project stack teardown (docker etc.) — BEFORE the worktree goes
  // away, since the command usually lives inside it.
  // Once per task: a preserved worktree makes cleanupTask re-run every reaper
  // sweep, and the teardown command must not re-fire forever.
  const toreDown = db
    .query("SELECT 1 FROM events WHERE task_id = ? AND type = 'stack_teardown' LIMIT 1")
    .get(taskId);
  if (task.worktree_path && repoPath && !toreDown) {
    let cleanupArgv: unknown;
    try {
      cleanupArgv = JSON.parse(project?.config ?? "{}").cleanup_argv;
    } catch {
      cleanupArgv = undefined;
    }
    await runCleanupCmd(db, taskId, cleanupArgv, repoPath, task.worktree_path, opts.exec ?? defaultExec);
  }

  // 1) worktree — guarded removal (branch pushed/merged; uncommitted work preserved).
  let worktree: CleanupOutcome["worktree"] = null;
  if (task.worktree_path && task.branch && repoPath) {
    try {
      worktree = await herdr.cleanupWorktree({
        repoPath,
        branch: task.branch,
        worktreePath: task.worktree_path,
        taskId,
        defaultBranch,
      });
    } catch (e: any) {
      worktree = { removed: false, reason: `cleanup error: ${String(e?.message ?? e)}`, ghost_branch: null };
    }
  }

  // 2) session — close only when there is no worktree to guard OR it was removed.
  // A preserved (unmerged) worktree keeps its tab so the director can attach,
  // finish/push the branch, and let a later sweep clean it.
  const meta = spawnMeta(db, taskId);
  const preserved = !!worktree && !worktree.removed;
  let session = { closed: false, via: preserved ? "kept: worktree preserved" : null as string | null };
  if (!preserved && (task.agent_target || meta.tab_id)) {
    session = await herdr.closeSession({ agentTarget: task.agent_target, tabId: meta.tab_id });
  }

  // 3) emit + record.
  if (preserved) {
    writeEvent(db, {
      task_id: taskId,
      source: "reaper",
      type: "cleanup_skipped",
      payload: { reason: worktree!.reason, worktree_path: task.worktree_path, branch: task.branch },
    });
    return { cleaned: false, worktree, session };
  }

  writeEvent(db, {
    task_id: taskId,
    source: "reaper",
    type: "cleaned_up",
    payload: {
      worktree_path: task.worktree_path ?? null,
      branch: task.branch ?? null,
      worktree_removed: worktree?.removed ?? false,
      ghost_branch: worktree?.ghost_branch ?? null,
      session_closed: session.closed,
      session_via: session.via,
      tab_id: meta.tab_id,
    },
  });
  // Clear the now-gone runtime binding so a re-run/reaper pass is a no-op.
  db.query("UPDATE tasks SET agent_target = NULL, worktree_path = NULL, updated_at = ? WHERE id = ?").run(now(), taskId);
  return { cleaned: true, worktree, session };
}
