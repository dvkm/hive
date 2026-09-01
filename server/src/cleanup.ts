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
import { enqueue } from "./notifications.ts";
import { createHash } from "node:crypto";

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
function spawnMeta(db: DB, taskId: string): { tab_id: string | null; workspace_id: string | null } {
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

// Deferral must be bounded, but bounded by the RIGHT thing. Capping on "how
// long have we been deferring" punishes exactly the agent we are protecting: a
// 66-round run is hours long and would lose its worktree on the clock alone.
// So the cap measures LACK OF PROGRESS instead. Every sweep we fingerprint the
// agent's pane; while that fingerprint keeps changing the agent is demonstrably
// alive and we defer indefinitely. Once it stops changing for DEFER_CAP_MS the
// agent is wedged (herdr still says "working", nothing is actually happening),
// and we release so the worktree and its pty cannot be pinned forever.
//
// A live claude pane always moves — spinner, elapsed timer, token counter — so
// "fingerprint unchanged for 30 minutes" means the process behind it is not
// running, not merely thinking slowly.
export const DEFER_CAP_MS = 30 * 60_000;

// How often a still-progressing agent re-stamps its deferral. The reaper sweeps
// every 300s, so this logs at most one progress event every other sweep: enough
// resolution under a 30-minute cap, without flooding the task timeline.
export const PROGRESS_MIN_GAP_MS = 10 * 60_000;

// The current deferral run's anchor: the newest cleanup_deferred event, but only
// if nothing terminal-ish has happened since. A task that gets cleaned, reopened
// and re-deferred therefore starts a fresh clock instead of inheriting a stale one.
function lastDeferral(db: DB, taskId: string): { ts: string; fingerprint: string | null } | null {
  const r = db
    .query(
      "SELECT type, ts, payload FROM events WHERE task_id = ? AND type IN ('cleanup_deferred','cleaned_up','cleanup_skipped') ORDER BY ts DESC, rowid DESC LIMIT 1"
    )
    .get(taskId) as { type: string; ts: string; payload: string } | undefined;
  if (!r || r.type !== "cleanup_deferred") return null;
  let fingerprint: string | null = null;
  try {
    fingerprint = JSON.parse(r.payload)?.fingerprint ?? null;
  } catch {
    /* legacy/unparseable payload — treated as "no fingerprint recorded" */
  }
  return { ts: r.ts, fingerprint };
}

// A cheap digest of the agent's pane tail. Any change at all counts as progress;
// we never interpret the text. A failed read yields a stable error string, which
// deliberately reads as "no progress" so a herdr that answers `probe` but not
// `read` still cannot pin the worktree forever.
async function paneFingerprint(herdr: Herdr, target: string): Promise<string> {
  const text = await herdr.read(target, 40).catch((e) => `(fingerprint read failed: ${String((e as any)?.message ?? e)})`);
  return createHash("sha1").update(text).digest("hex").slice(0, 16);
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

  // A task can go terminal while its agent is STILL WORKING in the worktree:
  // the PR merges, or the stale timer fails the task, mid-turn. Tearing down
  // here runs `git worktree remove --force` on that agent's own cwd, and the
  // agent dies on the next file it touches (2026-09-01: three agents lost this
  // way in five hours, one of them the agent investigating this bug). The
  // branch-pushed/merged guard in cleanupWorktree does NOT catch it — a pushed
  // branch is exactly when removal looks safest and the agent is still live.
  // So: defer while the agent is demonstrably alive. The reaper retries every
  // sweep, so this delays teardown, never cancels it.
  if (task.agent_target) {
    const probe = await herdr.probe(task.agent_target).catch(() => ({ alive: false, status: "unknown" as const }));
    // "working" AND "blocked" both defer. A blocked agent is paused on a dialog
    // or a confirmation prompt: alive, holding its worktree, and about to carry
    // on the moment someone answers — the state in which it is least able to
    // defend itself. "unknown" deliberately does NOT defer: probe() reports it
    // when the herdr call itself fails, and an outage that wedged cleanup shut
    // would leak worktrees and ptys (the July pty-pool failure).
    if (probe.alive && (probe.status === "working" || probe.status === "blocked")) {
      const last = lastDeferral(db, taskId);
      const fingerprint = await paneFingerprint(herdr, task.agent_target);
      const sinceMs = last ? Date.now() - Date.parse(last.ts) : 0;
      const moved = !last || (fingerprint !== last.fingerprint && sinceMs >= PROGRESS_MIN_GAP_MS);

      if (moved) {
        // Re-stamping the run on observed progress is what lets a genuinely long
        // agent defer indefinitely; the cap below then only bites a pane that
        // has stopped moving altogether.
        writeEvent(db, {
          task_id: taskId,
          source: "cleanup",
          type: "cleanup_deferred",
          payload: {
            reason: "agent still live in worktree",
            agent_target: task.agent_target,
            status: probe.status,
            fingerprint,
          },
        });
        return noop;
      }
      if (!Number.isFinite(sinceMs) || sinceMs < DEFER_CAP_MS) return noop;

      // Hard release. This is the one path that can still remove a worktree an
      // agent might be sitting in, and it is exactly the event that took three
      // attempts to diagnose — so it announces itself instead of being inferred
      // from a gap in the logs hours later. cleanupWorktree still rescues any
      // uncommitted work to a ghost branch before removing anything.
      writeEvent(db, {
        task_id: taskId,
        source: "cleanup",
        type: "cleanup_force_released",
        payload: {
          agent_target: task.agent_target,
          status: probe.status,
          stalled_ms: sinceMs,
          fingerprint,
          reason: `pane unchanged for ${Math.round(sinceMs / 60_000)}m — treating the agent as wedged`,
        },
      });
      enqueue(db, {
        kind: "incident",
        task_id: taskId,
        urgency: "urgent",
        title: `Tore down a worktree an agent may still be in (${taskId})`,
        body: `Agent ${task.agent_target} still reports "${probe.status}", but its pane has not changed for ${Math.round(
          sinceMs / 60_000
        )} minutes, so cleanup treated it as wedged and removed the worktree. Uncommitted work was rescued to a ghost branch. If the agent was in fact alive, this is the HIVE-213 failure mode recurring.`,
      });
    }
  }

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
  if (preserved ? task.agent_target : task.agent_target || meta.tab_id) {
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
    if (session.closed)
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
