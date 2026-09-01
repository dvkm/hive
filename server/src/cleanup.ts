// Auto-teardown for finished tasks: remove the git worktree (guarded so no
// unmerged or uncommitted work is ever lost) and close the herdr session (the
// labelled tab + its agent), then emit a `cleaned_up` / `cleanup_skipped` event.
//
// Fired two ways: from the transition path (state.setTerminalHook, on done /
// cancelled) for immediacy, and from the reaper sweep (reaper.ts) as the
// backstop for teardowns that were skipped or missed. Idempotent per spawn: a
// task that already has a `cleaned_up` event newer than its last `spawned` one
// is never torn down twice (see cleanedUpSinceLastSpawn).
import type { DB } from "./db.ts";
import { now } from "./db.ts";
import { getTask, writeEvent, transition, startRecoveryEpoch, recoveryAttemptId, TERMINAL, queuedInputRecoveryPending, type State } from "./state.ts";
import { Herdr, herdr as defaultHerdr } from "./runtime/herdr.ts";
import { isTrackingOnlyTask } from "./supervision.ts";
import { queuedSteers, queueSteerEvent } from "./steer.ts";
import { broadcastTask } from "./health.ts";
import type { Exec } from "./exec.ts";
import { defaultExec, projectBaseBranch } from "./exec.ts";
import { resolveConfiguredCommand } from "./platform.ts";
import { enqueue } from "./notifications.ts";
import { createHash } from "node:crypto";

// Per-project stack lifecycle command. Two symmetric hooks share this runner:
//   config.setup_argv    = ["bun", "infra/worktree/wt.ts", "up",   "{worktree}"]  (spawn time)
//   config.cleanup_argv  = ["bun", "infra/worktree/wt.ts", "down", "{worktree}"]  (before removal)
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
  argv[0] = resolveConfiguredCommand(repoPath, argv[0]);
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
type SpawnRecord = {
  event_id: string | null;
  rowid: number;
  tab_id: string | null;
  workspace_id: string | null;
  terminal_id: string | null;
  attempt_id: string | null;
};

export function latestSpawnRecord(db: DB, taskId: string): SpawnRecord {
  const empty = { event_id: null, rowid: 0, tab_id: null, workspace_id: null, terminal_id: null, attempt_id: null };
  const r = db
    .query("SELECT rowid, id, payload FROM events WHERE task_id = ? AND type = 'spawned' ORDER BY rowid DESC LIMIT 1")
    .get(taskId) as { rowid: number; id: string; payload: string } | undefined;
  if (!r) return empty;
  try {
    const p = JSON.parse(r.payload);
    return { event_id: r.id, rowid: r.rowid, tab_id: p.tab_id ?? null, workspace_id: p.workspace_id ?? null, terminal_id: p.terminal_id ?? null, attempt_id: p.attempt_id ?? null };
  } catch {
    return empty;
  }
}

export function spawnMeta(db: DB, taskId: string): { tab_id: string | null; workspace_id: string | null; terminal_id: string | null; attempt_id: string | null } {
  const { tab_id, workspace_id, terminal_id, attempt_id } = latestSpawnRecord(db, taskId);
  return { tab_id, workspace_id, terminal_id, attempt_id };
}

// `cleaned_up` is the record that this spawn's teardown already ran to
// completion: the worktree was removed (or there never was one) and the session
// close was attempted. Re-running it can only re-issue herdr calls at ids that
// are long dead and re-write the same event.
//
// Re-entry is GUARANTEED, not hypothetical. A task row whose worktree_path was
// cleared can no longer remove its own checkout, but git still LISTS that
// worktree, so the reaper's worktree pass hands the same task back on every
// 5-minute lap. Six ancient terminal tasks did exactly that: ~5 tab.close calls
// at tab ids from a herdr generation two app-restarts ago, plus a duplicate
// `cleaned_up` event and an updated_at bump each, forever — 11,458 events per
// task by 2026-08-20. a6a4c70 cleared agent_target, but the tab id ALSO comes
// from the immutable `spawned` event, which no teardown can clear.
//
// Scoped to the LAST spawn so a requeued task tears down again. A preserved
// (unmerged) worktree writes `cleanup_skipped`, not `cleaned_up`, and keeps
// retrying on purpose until its branch is mergeable.
function cleanedUpSinceLastSpawn(db: DB, taskId: string): boolean {
  const cleaned = db
    .query("SELECT rowid, payload FROM events WHERE task_id = ? AND type = 'cleaned_up' ORDER BY rowid DESC LIMIT 1")
    .get(taskId) as { rowid: number; payload: string } | undefined;
  if (!cleaned) return false;
  const spawned = latestSpawnRecord(db, taskId);
  try {
    const spawnRowid = JSON.parse(cleaned.payload)?.spawn_rowid;
    if (typeof spawnRowid === "number") return spawnRowid === spawned.rowid;
  } catch {}
  return !spawned.rowid || spawned.rowid <= cleaned.rowid;
}

// Forward a predecessor's cleanup rescue (a ghost branch, or just "the kept
// worktree is gone now") onto one live successor — a requeued row or the same
// row's next in-place retry. Opens a fresh recovery epoch on the successor so
// evidence captured before this point can't satisfy a review/merge gate for
// work the successor never actually saw (late rescue events must not revive
// an older generation), bounces it out of review if it had already gotten
// there, and steers the agent. Idempotent per (cleanup event, successor).
function forwardRescuedWork(
  db: DB,
  cleanupEventId: string,
  predecessorTaskId: string,
  ghostBranch: string | null,
  successorId: string
): boolean {
  const successor = getTask(db, successorId);
  if (!successor || !["queued", "in_progress", "needs_decision", "in_review", "verifying"].includes(successor.state)) return false;
  const forwarded = db
    .query(
      `SELECT 1 FROM events
       WHERE task_id = ? AND type = 'recovery_work_forwarded'
         AND json_extract(payload, '$.cleanup_event_id') = ? LIMIT 1`
    )
    .get(successor.id, cleanupEventId);
  if (forwarded) return false;
  db.query("UPDATE tasks SET resume_ghost_branch = COALESCE(?, resume_ghost_branch), updated_at = ? WHERE id = ?")
    .run(ghostBranch, now(), successor.id);
  const recoveryAttempt = recoveryAttemptId(db, successor.id);
  const attemptId = recoveryAttempt === undefined ? spawnMeta(db, successor.id).attempt_id ?? undefined : recoveryAttempt ?? undefined;
  startRecoveryEpoch(db, successor.id, "reaper", attemptId);
  if (successor.state === "in_review" || successor.state === "verifying")
    transition(db, successor.id, "in_progress", { source: "reaper", reason: "predecessor cleanup invalidated recovery worktree" });
  const message = ghostBranch
    ? `Recovery update: cleanup rescued additional predecessor work onto \`${ghostBranch}\`. Fetch and merge it before continuing.`
    : "Recovery update: cleanup removed the previously advertised kept worktree. That path is no longer available; continue from the inherited branch and do not rely on the old worktree.";
  queueSteerEvent(
    db,
    successor.id,
    message,
    ghostBranch ? "predecessor cleanup rescued work" : "predecessor cleanup removed kept worktree"
  );
  writeEvent(db, {
    task_id: successor.id,
    source: "reaper",
    type: "recovery_work_forwarded",
    payload: { cleanup_event_id: cleanupEventId, predecessor_task_id: predecessorTaskId, ghost_branch: ghostBranch },
  });
  return true;
}

// Replay any cleanup (or late worktree reclamation) rescues that haven't yet
// been forwarded onto their live successor(s) — a requeued row's whole
// lineage, plus a same-row replacement generation. Scoped to a single
// predecessor when `taskId` is given (the normal cleanupTask/reclaim call);
// unscoped for a startup/reaper sweep. Cross-project requeue rows are never
// followed — the lineage walk requires the parent and child to share a
// project.
export function replayCleanedUpRecovery(db: DB, taskId?: string): number {
  const rows = db
    .query(
      `WITH RECURSIVE active_recoveries(id, task_number) AS (
         SELECT candidate.id, candidate.number
         FROM tasks candidate
         WHERE candidate.state IN ('queued','in_progress','needs_decision','in_review','verifying')
       ), lineage(successor_id, successor_number, task_id) AS (
         SELECT id, task_number, id FROM active_recoveries
         UNION ALL
         SELECT lineage.successor_id, lineage.successor_number, parent.id
         FROM lineage
         JOIN tasks child ON child.id = lineage.task_id
         JOIN tasks parent ON parent.id = child.parent_task_id
         WHERE child.source = 'requeue'
           AND child.project_id = parent.project_id
           AND EXISTS (
             SELECT 1 FROM events AS provenance
             WHERE provenance.task_id = child.id
               AND provenance.type = 'created'
               AND provenance.source = 'reconciler'
               AND json_extract(provenance.payload, '$.requeue_of') = parent.id
           )
       )
       SELECT cleanup.id AS cleanup_event_id,
              cleanup.task_id AS predecessor_task_id,
              json_extract(cleanup.payload, '$.ghost_branch') AS ghost_branch,
              lineage.successor_id
       FROM lineage
       JOIN events AS cleanup
         ON cleanup.task_id = lineage.task_id AND cleanup.type IN ('cleaned_up','worktree_reclaimed')
       WHERE (
           cleanup.type = 'worktree_reclaimed'
           OR json_extract(cleanup.payload, '$.worktree_removed') = 1
           OR json_extract(cleanup.payload, '$.ghost_branch') IS NOT NULL
         )
         ${taskId ? "AND cleanup.task_id = ?" : ""}
         AND (
           cleanup.task_id != lineage.successor_id
           OR EXISTS (
             SELECT 1 FROM events AS changed
             WHERE changed.task_id = lineage.successor_id
               AND changed.type = 'state_change'
               -- No fallback to 0: a cleanup event without a real spawn_rowid (e.g. an
               -- older worktree_reclaimed event, before reconciler started stamping one)
               -- must never match — json_extract(...) IS NULL makes the comparison NULL,
               -- so EXISTS finds nothing, rather than "any failed->queued ever" matching.
               AND changed.rowid > json_extract(cleanup.payload, '$.spawn_rowid')
               AND json_extract(changed.payload, '$.from') = 'failed'
               AND json_extract(changed.payload, '$.to') = 'queued'
           )
         )
         AND NOT EXISTS (
           SELECT 1 FROM events AS forwarded
           WHERE forwarded.task_id = lineage.successor_id
             AND forwarded.type = 'recovery_work_forwarded'
             AND json_extract(forwarded.payload, '$.cleanup_event_id') = cleanup.id
         )
       ORDER BY cleanup.rowid, lineage.successor_number DESC`
    )
    .all(...(taskId ? [taskId] : [])) as {
      cleanup_event_id: string;
      predecessor_task_id: string;
      ghost_branch: string | null;
      successor_id: string;
    }[];
  let forwarded = 0;
  for (const row of rows)
    if (forwardRescuedWork(db, row.cleanup_event_id, row.predecessor_task_id, row.ghost_branch, row.successor_id))
      forwarded++;
  return forwarded;
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
  const initialSpawn = latestSpawnRecord(db, taskId);
  // A replacement generation (a requeue, or the same row's next in-place
  // attempt) can start mid-cleanup — herdr calls below are `await`-ed, so a
  // fresh spawn/state-change race is real, not hypothetical (see the
  // same-row test). Once the generation has moved on, this cleanup no longer
  // owns the row: bail rather than clear/rebind state out from under the
  // replacement.
  const ownsCleanupGeneration = (): boolean => {
    const current = getTask(db, taskId);
    return Boolean(current && current.state === task.state && latestSpawnRecord(db, taskId).rowid === initialSpawn.rowid);
  };
  if (cleanedUpSinceLastSpawn(db, taskId)) {
    replayCleanedUpRecovery(db, taskId);
    db.query("UPDATE tasks SET agent_target = NULL, worktree_path = NULL, updated_at = ? WHERE id = ?").run(now(), taskId);
    return noop;
  }

  const project = db.query("SELECT repo_path, config FROM projects WHERE id = ?").get(task.project_id) as
    | { repo_path: string | null; config: string | null }
    | undefined;
  const repoPath = project?.repo_path ?? null;
  let config: Record<string, any> = {};
  try {
    config = JSON.parse(project?.config ?? "{}") ?? {};
  } catch {
    config = {};
  }
  const defaultBranch = projectBaseBranch(config);
  if (!ownsCleanupGeneration()) return noop;

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

  // 0) per-project stack teardown (docker etc.) — BEFORE the worktree goes
  // away, since the command usually lives inside it.
  // Once per task: a preserved worktree makes cleanupTask re-run every reaper
  // sweep, and the teardown command must not re-fire forever.
  const toreDown = db
    .query("SELECT 1 FROM events WHERE task_id = ? AND type = 'stack_teardown' LIMIT 1")
    .get(taskId);
  if (task.worktree_path && repoPath && !toreDown) {
    await runStackCmd(db, taskId, config.cleanup_argv, repoPath, task.worktree_path, opts.exec ?? defaultExec, {
      type: "stack_teardown",
      source: "reaper",
    });
    if (!ownsCleanupGeneration()) return noop;
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

  // 1b) origin branch — the task is over and its commits are already in the
  // default branch, so the pushed copy is pure litter (500+ stale `hive/*` refs
  // accumulated on one origin). Skipped for a PRESERVED worktree: that branch is
  // exactly the one still holding work. Per-project opt-out:
  // config.delete_remote_branches = false. Never blocks the rest of cleanup —
  // deleteRemoteBranch swallows its own failures and the outcome is recorded on
  // the cleaned_up event.
  const preservedWorktree = !!worktree && !worktree.removed;
  let remote: { deleted: boolean; reason: string } | null = null;
  if (task.branch && repoPath && !preservedWorktree && config.delete_remote_branches !== false) {
    remote = await herdr
      .deleteRemoteBranch({ repoPath, branch: task.branch, defaultBranch })
      .catch((e: any) => ({ deleted: false, reason: String(e?.message ?? e).slice(0, 200) }));
  }

  // 2) session — close for ANY terminal task, preserved worktree or not. The
  // worktree + branch stay on disk for the director (`herdr worktree open`
  // re-attaches on demand), but the live tab must not stay: every kept session
  // pins a pty forever, and ~160 accumulated tabs exhausted the system pty pool
  // (kern.tty.ptmx_max=511) and took down all spawning (2026-07-17).
  // Preserved tasks keep agent_target until the close succeeds, then drop it so
  // later sweeps skip the herdr call instead of re-closing a dead tab.
  const generationChanged = !ownsCleanupGeneration();
  const meta = initialSpawn;
  const preserved = preservedWorktree;
  let session = { closed: false, via: null as string | null };
  const attemptedClose = !generationChanged && (preserved ? !!task.agent_target : !!(task.agent_target || meta.tab_id));
  if (attemptedClose) {
    session = await herdr.closeSession({
      agentTarget: task.agent_target,
      tabId: meta.tab_id,
      request: { caller: "cleanup.cleanupTask", reason: "terminal task cleanup", taskId },
      // Prove the tab is still THIS task's before closing it: herdr recycles tab
      // ids, so a stale one recorded at spawn can name another agent's live tab.
      expectTerminalId: meta.terminal_id,
      expectCwd: task.worktree_path,
    });
    // Also close the worktree's OWN herdr workspace: `worktree create` auto-spawns
    // it with a live pane the agent never uses (the agent runs in the fleet tab
    // closed above), and it leaked a pty per task until nothing reaped it
    // (2026-07-25). Same guard as the session close so it fires once, not on
    // every preserved-task sweep. Never the fleet workspace — spawnMeta returns
    // only the worktree's own id. The pane sweep is the backstop for tasks whose
    // spawned event predates this field.
    if (meta.workspace_id && task.worktree_path) await herdr.closeWorkspace({
      workspaceId: meta.workspace_id,
      expectCwd: task.worktree_path,
      request: { caller: "cleanup.cleanupTask", reason: "terminal task cleanup", taskId },
    });
  }

  // 3) emit + record.
  if (preserved) {
    // The close is ATTEMPTED once, not retried forever. Keeping agent_target
    // until the call succeeded meant a herdr outage re-issued tab.close for the
    // same preserved worktrees on every reaper sweep, indefinitely (2026-08-19:
    // 6 terminal tasks, ~5 closes each, every 5 minutes). Dropping the binding
    // makes the next sweep a no-op; the pane sweep (reaper.ts) is the backstop
    // for a tab that really is still open.
    if (attemptedClose && ownsCleanupGeneration())
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
      remote_branch_deleted: remote?.deleted ?? false,
      ...(remote && !remote.deleted ? { remote_branch_reason: remote.reason } : {}),
      session_closed: session.closed,
      session_via: session.via,
      tab_id: meta.tab_id,
      spawn_event_id: meta.event_id,
      spawn_rowid: meta.rowid,
    },
  });
  replayCleanedUpRecovery(db, taskId);
  // Clear the now-gone runtime binding so a re-run/reaper pass is a no-op.
  if (ownsCleanupGeneration())
    db.query("UPDATE tasks SET agent_target = NULL, worktree_path = NULL, updated_at = ? WHERE id = ?").run(now(), taskId);
  return { cleaned: true, worktree, session };
}

// ---- review-parked agent release ----
// A task in review is parked on the DIRECTOR: the PR is open, CI is green, and
// nothing in hive asks its agent to act again until a human (or a red check)
// does. Left alive that agent still holds a pty AND a dispatch slot — 10 idle
// review agents starved a consuming project to 3 running against 19 queued (2026-08-19).
//
// Release = close the session, KEEP the worktree and branch (the PR still needs
// them), drop agent_target so the dispatcher stops counting it. Feedback brings
// an agent back onto the same branch with that feedback in its brief (the
// reattach pass in dispatcher.ts).
//
// Deliberately NOT gated on the understanding quiz: a quiz is director-only
// (answering or deferring it never reaches the agent), so "quiz still pending"
// is exactly the state the slot would be held for. `idle` is the same signal
// advanceIfFinished already reads as "this agent has nothing left to do".
export async function releaseReviewAgent(
  db: DB,
  herdr: Herdr = defaultHerdr,
  taskId: string
): Promise<{ released: boolean; reason: string }> {
  const task = getTask(db, taskId);
  if (!task) return { released: false, reason: "no such task" };
  if (task.state !== "in_review" || !task.agent_target) return { released: false, reason: "no review-parked agent" };
  if (isTrackingOnlyTask(task) || task.source === "chat_supervisor")
    return { released: false, reason: "not a hive worker task" };
  // Undelivered feedback is already waiting: the reconciler's drainSteers can
  // hand it to the live agent this cycle, which beats release-then-respawn.
  if (queuedSteers(db, taskId).length) return { released: false, reason: "steers pending delivery" };
  // #1234 review-12: a queued-input recovery in flight on this same task means
  // a turn may be about to run — closing the session now would kill it mid-air.
  if (queuedInputRecoveryPending(db, taskId)) return { released: false, reason: "queued-input recovery pending" };

  const meta = spawnMeta(db, taskId);
  const probe = await herdr.probe(task.agent_target).catch(() => ({ alive: true, status: "unknown" as const }));
  // `gone` needs positive proof. An unresolvable probe is what a herdr registry
  // wipe looks like, and closing a tab under a live agent is the kill wave this
  // repo already paid for once (2026-08-19, false-dead incident).
  const gone = !probe.alive && (await herdr.confirmGone({ cwd: task.worktree_path, tabId: meta.tab_id }));
  if (!gone && !(probe.alive && (probe.status === "idle" || probe.status === "done")))
    return { released: false, reason: `agent is ${probe.alive ? probe.status : "unconfirmed-gone"}` };

  const reason = gone ? "agent gone" : `${probe.status} in review`;
  const session = await herdr.closeSession({
    agentTarget: task.agent_target,
    tabId: meta.tab_id,
    expectTerminalId: meta.terminal_id,
    expectCwd: task.worktree_path,
    request: { caller: "cleanup.releaseReviewAgent", reason, taskId },
  });
  // The worktree's OWN workspace holds a second pty the agent never used (see
  // cleanupTask). The checkout on disk is untouched by a workspace close.
  if (meta.workspace_id && task.worktree_path) await herdr.closeWorkspace({
    workspaceId: meta.workspace_id,
    expectCwd: task.worktree_path,
    request: { caller: "cleanup.releaseReviewAgent", reason, taskId },
  });
  db.query("UPDATE tasks SET agent_target = NULL, updated_at = ? WHERE id = ?").run(now(), taskId);
  writeEvent(db, {
    task_id: taskId,
    source: "reaper",
    type: "agent_released",
    payload: {
      reason,
      branch: task.branch,
      worktree_path: task.worktree_path,
      session_closed: session.closed,
      session_via: session.via,
    },
  });
  broadcastTask(db, getTask(db, taskId));
  return { released: true, reason };
}

// Sweep every review-parked agent. Per-project opt-out:
// config.release_review_agents = false keeps agents alive through review.
export async function releaseReviewAgents(db: DB, herdr: Herdr = defaultHerdr): Promise<number> {
  const rows = db
    .query(
      `SELECT t.id FROM tasks t JOIN projects p ON p.id = t.project_id
        WHERE t.state = 'in_review' AND t.agent_target IS NOT NULL
          AND COALESCE(json_extract(p.config, '$.release_review_agents'), 1) != 0`
    )
    .all() as { id: string }[];
  let released = 0;
  for (const r of rows) {
    try {
      if ((await releaseReviewAgent(db, herdr, r.id)).released) released++;
    } catch (e) {
      console.error(`[hive] release review agent ${r.id}:`, e); // isolated; never crash the sweep
    }
  }
  return released;
}
