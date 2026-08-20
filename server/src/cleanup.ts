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
import { defaultExec, safeBranch } from "./exec.ts";

// Per-project stack lifecycle command. Two symmetric hooks share this runner:
//   config.setup_argv    = ["infra/worktree/wt.sh", "up",   "{worktree}"]  (spawn time, before agent starts)
//   config.cleanup_argv  = ["infra/worktree/wt.sh", "down", "{worktree}"]  (before worktree removal)
// Setup gets its own budget via config.stack_setup_timeout_ms (default 600_000);
// teardown keeps the short 120s default.
// Setup runs AFTER the worktree exists but BEFORE the agent starts (see the
// worktree-ready callback in api.ts) so agents don't have to install deps /
// bring up their docker stack themselves; teardown runs BEFORE the worktree is
// removed (the command usually needs files inside it). Both: relative argv[0]
// resolves against repo_path, {worktree} substitutes the task's worktree path,
// run with a hard timeout. Emits a stack_setup / stack_teardown event and
// returns whether the hook succeeded; the two callers treat that differently:
// teardown ignores it (a failed 'down' must never block worktree/session
// cleanup — 256 orphaned docker containers, 2026-07-13, were stacks nothing
// ever tore down), while setup ABORTS the spawn (see api.ts spawnAgent).
export async function runStackCmd(
  db: DB,
  taskId: string,
  argvTemplate: unknown,
  repoPath: string,
  worktreePath: string,
  exec: Exec,
  kind: { type: "stack_setup" | "stack_teardown"; source: string; timeoutMs?: number }
): Promise<{ ok: boolean; error?: string }> {
  if (!Array.isArray(argvTemplate) || !argvTemplate.length) return { ok: true };
  const argv = argvTemplate.map((a) => String(a).replaceAll("{worktree}", worktreePath));
  if (!argv[0].startsWith("/")) argv[0] = `${repoPath}/${argv[0]}`;
  // Teardown ('wt.sh down') is quick; setup ('wt.sh up') on a cold worktree
  // installs deps + brings up docker and routinely runs past 2 min, so it gets
  // its own (configurable) budget. Timing out setup would start the agent
  // against a half-ready stack. See config.stack_setup_timeout_ms.
  const timeoutMs = kind.timeoutMs ?? 120_000;
  try {
    // Exec has no timeout; race one so a hung hook can't stall the reaper/spawn.
    const r = await Promise.race([
      exec(argv, { cwd: repoPath }),
      new Promise<{ code: number; stdout: string; stderr: string }>((resolve) =>
        setTimeout(
          () => resolve({ code: 124, stdout: "", stderr: `${kind.type} command timed out (${Math.round(timeoutMs / 1000)}s)` }),
          timeoutMs
        )
      ),
    ]);
    const error = r.code === 0 ? undefined : (r.stderr || r.stdout).slice(0, 300);
    writeEvent(db, {
      task_id: taskId,
      source: kind.source,
      type: kind.type,
      payload: { argv, ok: r.code === 0, ...(error ? { error } : {}) },
    });
    return { ok: r.code === 0, error };
  } catch (e: any) {
    const error = String(e?.message ?? e).slice(0, 300);
    writeEvent(db, {
      task_id: taskId,
      source: kind.source,
      type: kind.type,
      payload: { argv, ok: false, error },
    });
    return { ok: false, error };
  }
}

export interface CleanupOutcome {
  cleaned: boolean;
  worktree: { removed: boolean; reason: string; ghost_branch: string | null } | null;
  session: { closed: boolean; via: string | null };
}

// The `spawned` event carries the herdr tab id and the worktree's own workspace
// id (the task row stores neither). fleet_workspace_id is deliberately NOT
// returned: it's the shared hive-fleet workspace and must never be closed.
export function spawnMeta(db: DB, taskId: string): { tab_id: string | null; workspace_id: string | null } {
  const r = db
    .query("SELECT payload FROM events WHERE task_id = ? AND type = 'spawned' ORDER BY ts DESC LIMIT 1")
    .get(taskId) as { payload: string } | undefined;
  if (!r) return { tab_id: null, workspace_id: null };
  try {
    const p = JSON.parse(r.payload);
    return { tab_id: p.tab_id ?? null, workspace_id: p.workspace_id ?? null };
  } catch {
    return { tab_id: null, workspace_id: null };
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
    defaultBranch = safeBranch(JSON.parse(project?.config ?? "{}").default_branch);
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
    await runStackCmd(db, taskId, cleanupArgv, repoPath, task.worktree_path, opts.exec ?? defaultExec, {
      type: "stack_teardown",
      source: "reaper",
    });
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

  // 2) session — close for ANY terminal task, preserved worktree or not. The
  // worktree + branch stay on disk for the director (`herdr worktree open`
  // re-attaches on demand), but the live tab must not stay: every kept session
  // pins a pty forever, and ~160 accumulated tabs exhausted the system pty pool
  // (kern.tty.ptmx_max=511) and took down all spawning (2026-07-17).
  // Preserved tasks keep agent_target until the close succeeds, then drop it so
  // later sweeps skip the herdr call instead of re-closing a dead tab.
  const meta = spawnMeta(db, taskId);
  const preserved = !!worktree && !worktree.removed;
  let session = { closed: false, via: null as string | null };
  const attemptedClose = preserved ? !!task.agent_target : !!(task.agent_target || meta.tab_id);
  if (attemptedClose) {
    session = await herdr.closeSession({ agentTarget: task.agent_target, tabId: meta.tab_id });
    // Also close the worktree's OWN herdr workspace: `worktree create` auto-spawns
    // it with a live pane the agent never uses (the agent runs in the fleet tab
    // closed above), and it leaked a pty per task until nothing reaped it
    // (2026-07-25). Same guard as the session close so it fires once, not on
    // every preserved-task sweep. Never the fleet workspace — spawnMeta returns
    // only the worktree's own id. The pane sweep is the backstop for tasks whose
    // spawned event predates this field.
    if (meta.workspace_id) await herdr.closeWorkspace(meta.workspace_id);
  }

  // 3) emit + record.
  if (preserved) {
    // The close is ATTEMPTED once, not retried forever. Keeping agent_target
    // until the call succeeded meant a herdr outage re-issued tab.close for the
    // same preserved worktrees on every reaper sweep, indefinitely (2026-08-19:
    // 6 terminal tasks, ~5 closes each, every 5 minutes). Dropping the binding
    // makes the next sweep a no-op; the pane sweep (reaper.ts) is the backstop
    // for a tab that really is still open.
    if (attemptedClose)
      db.query("UPDATE tasks SET agent_target = NULL, updated_at = ? WHERE id = ?").run(now(), taskId);
    // One event per distinct skip reason, not one per reaper sweep: the same
    // dozen preserved worktrees emitted 2,668 duplicate events in 3 days.
    const last = db
      .query("SELECT payload FROM events WHERE task_id = ? AND type = 'cleanup_skipped' ORDER BY ts DESC LIMIT 1")
      .get(taskId) as { payload: string } | undefined;
    let lastReason: string | null = null;
    try {
      lastReason = last ? (JSON.parse(last.payload).reason ?? null) : null;
    } catch {
      /* malformed payload -> treat as new reason */
    }
    if (lastReason !== worktree!.reason) {
      writeEvent(db, {
        task_id: taskId,
        source: "reaper",
        type: "cleanup_skipped",
        payload: {
          reason: worktree!.reason,
          worktree_path: task.worktree_path,
          branch: task.branch,
          session_closed: session.closed,
        },
      });
    }
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
