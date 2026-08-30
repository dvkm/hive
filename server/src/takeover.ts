// Director take-over / hand-back for a task's worktree (HIVE-352).
//
// "Take over" is the escape hatch for when the fastest fix is the director's
// own hands: it stops the agent cleanly, frees the project's agent slot, and
// hands back the worktree path to edit directly. "Hand back" puts an agent back
// on the SAME branch with a steer describing what changed while it was parked,
// so it never has to re-derive the director's edits from scratch.
//
// Almost all of this is existing machinery, deliberately:
//   - the park itself is `deferred_until` set far into the future. That is what
//     already keeps the dispatcher off a task (dispatcher.ts's queued query) and
//     the reconciler's "gone quiet" nudges quiet (state.isDeferred). No new
//     lifecycle state, no new skip clause in either loop.
//   - stopping the agent is cleanup.ts's close-the-session sequence, with
//     agent_target cleared — which is exactly what frees the slot, since every
//     dispatcher capacity count keys on agent_target.
//   - bringing the agent back is the dispatcher's existing REATTACH pass: a live
//     task with no agent and queued steers gets one respawned onto its branch,
//     with the steers at the top of its brief. Hand-back just queues the steer.
//
// The one genuinely new thing is the baseline for "what changed while parked".
// Take-over records `git stash create`, which writes a dangling commit holding
// the working tree WITHOUT touching the index, the worktree, or the shared stash
// stack (a bare `git stash` would fight every other worktree on this machine).
// Diffing that commit at hand-back shows the director's edits alone, not the
// half-finished work the agent happened to have uncommitted at the moment it was
// parked. A clean tree has nothing to stash, so the baseline is plain HEAD.
// `stash create` does NOT capture untracked files, so the take-over event also
// records the untracked list and hand-back subtracts it — otherwise a scratch
// file the agent itself left behind comes back as "the director added this".
import type { DB } from "./db.ts";
import { now } from "./db.ts";
import { getTask, writeEvent, TERMINAL } from "./state.ts";
import { isTrackingOnlyTask } from "./supervision.ts";
import { queueSteerEvent } from "./steer.ts";
import { spawnMeta } from "./cleanup.ts";
import { broadcastTask } from "./health.ts";
import { Herdr, herdr as defaultHerdr } from "./runtime/herdr.ts";
import { defaultExec, type Exec } from "./exec.ts";

// Indefinite park. Same sentinel the v39 migration used, so a taken-over task
// reads as "deferred" everywhere deferred already means something.
export const PARK_UNTIL = "9999-12-31T00:00:00.000Z";

export class TakeoverError extends Error {}

// Cap the file list in the hand-back steer. A director who rewrote 200 files has
// told the agent something a full listing would only bury.
const MAX_FILES = 40;

async function git(exec: Exec, cwd: string, args: string[]): Promise<string | null> {
  const r = await exec(["git", "-C", cwd, ...args]).catch(() => null);
  return r && r.code === 0 ? r.stdout.trim() : null;
}

const UNTRACKED_ARGV = ["ls-files", "--others", "--exclude-standard"];

function lines(text: string | null): string[] {
  return (text ?? "").split("\n").filter(Boolean);
}

// The commit that captures the worktree as it stands. `stash create` prints
// nothing for a clean tree; fall back to HEAD.
async function captureBase(exec: Exec, cwd: string): Promise<string | null> {
  return (await git(exec, cwd, ["stash", "create"])) || (await git(exec, cwd, ["rev-parse", "HEAD"]));
}

function requireLive(task: any): void {
  if (!task) throw new TakeoverError("task not found");
  if (TERMINAL.includes(task.state)) throw new TakeoverError(`task is ${task.state} — nothing to take over`);
  if (isTrackingOnlyTask(task) || task.source === "chat_supervisor")
    throw new TakeoverError("not a hive worker task — it has no worktree of its own");
  if (!task.worktree_path) throw new TakeoverError("task has no worktree yet — dispatch it first");
}

export interface TakeoverDeps {
  herdr?: Herdr;
  exec?: Exec;
}

export async function takeOver(
  db: DB,
  taskId: string,
  deps: TakeoverDeps = {}
): Promise<{ worktree_path: string; branch: string | null; base: string | null; agent_stopped: boolean }> {
  const task = getTask(db, taskId);
  requireLive(task);
  if (task.parked_for_director) throw new TakeoverError("already taken over — hand it back first");

  const h = deps.herdr ?? defaultHerdr;
  const exec = deps.exec ?? defaultExec;

  // Stop the agent BEFORE the baseline: a still-running turn could write another
  // file into the snapshot and then look like the director's edit at hand-back.
  let agent_stopped = false;
  if (task.agent_target) {
    const meta = spawnMeta(db, taskId);
    const request = { caller: "takeover.takeOver", reason: "director took the worktree over", taskId };
    const session = await h.closeSession({
      agentTarget: task.agent_target,
      tabId: meta.tab_id,
      expectTerminalId: meta.terminal_id,
      expectCwd: task.worktree_path,
      request,
    });
    if (meta.workspace_id)
      await h.closeWorkspace({ workspaceId: meta.workspace_id, expectCwd: task.worktree_path, request });
    agent_stopped = session.closed;
  }

  const base = await captureBase(exec, task.worktree_path);
  const untracked_at_takeover = lines(await git(exec, task.worktree_path, UNTRACKED_ARGV));
  db.query(
    `UPDATE tasks SET agent_target = NULL, parked_for_director = ?, takeover_base = ?,
       deferred_until = ?, updated_at = ? WHERE id = ?`
  ).run(now(), base, PARK_UNTIL, now(), taskId);
  writeEvent(db, {
    task_id: taskId,
    source: "director",
    type: "taken_over",
    payload: { worktree_path: task.worktree_path, branch: task.branch, base, agent_stopped, untracked_at_takeover },
  });
  broadcastTask(db, getTask(db, taskId));
  return { worktree_path: task.worktree_path, branch: task.branch, base, agent_stopped };
}

// What changed in the worktree since `base`. Null when git can't answer (no
// baseline recorded, worktree gone); the caller says so rather than inventing a
// summary the agent would trust.
export async function takeoverDiffSummary(
  exec: Exec,
  cwd: string,
  base: string | null,
  untrackedAtTakeover: string[] = []
): Promise<string | null> {
  if (!base) return null;
  const stat = await git(exec, cwd, ["diff", "--stat", base]);
  if (stat === null) return null;
  const commits = await git(exec, cwd, ["log", "--oneline", `${base}..HEAD`]);
  const already = new Set(untrackedAtTakeover);
  const untracked = lines(await git(exec, cwd, UNTRACKED_ARGV)).filter((f) => !already.has(f)).join("\n");

  const parts: string[] = [];
  const clip = (text: string) => {
    const lines = text.split("\n").filter(Boolean);
    return lines.length > MAX_FILES
      ? [...lines.slice(0, MAX_FILES), `… and ${lines.length - MAX_FILES} more`].join("\n")
      : lines.join("\n");
  };
  if (commits) parts.push(`New commits:\n${clip(commits)}`);
  if (stat) parts.push(`Changed files:\n${clip(stat)}`);
  if (untracked) parts.push(`New untracked files:\n${clip(untracked)}`);
  return parts.length ? parts.join("\n\n") : "";
}

// The untracked files that were already there when the director took over. Read
// off the take-over event rather than a column: it is one list, only ever needed
// by its own hand-back.
function untrackedAtTakeover(db: DB, taskId: string): string[] {
  const r = db
    .query("SELECT payload FROM events WHERE task_id = ? AND type = 'taken_over' ORDER BY ts DESC LIMIT 1")
    .get(taskId) as { payload: string } | undefined;
  try {
    const list = r ? JSON.parse(r.payload).untracked_at_takeover : null;
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export async function handBack(
  db: DB,
  taskId: string,
  opts: { note?: string } & TakeoverDeps = {}
): Promise<{ steer_queued: boolean; summary: string | null; branch: string | null }> {
  const task = getTask(db, taskId);
  requireLive(task);
  if (!task.parked_for_director) throw new TakeoverError("task is not taken over");

  const exec = opts.exec ?? defaultExec;
  const summary = await takeoverDiffSummary(
    exec,
    task.worktree_path,
    task.takeover_base,
    untrackedAtTakeover(db, taskId)
  );

  const body =
    summary === null
      ? "The director edited this worktree while you were parked, but hive could not read the diff. Run `git status` and `git diff` in your worktree before you continue."
      : summary === ""
        ? "The director took this worktree over and handed it back with no file changes."
        : `The director edited this worktree while you were parked. Do NOT redo this work — read it, then continue from here.\n\n${summary}`;
  const message = opts.note ? `${body}\n\nDirector's note: ${opts.note}` : body;
  const steer_queued = queueSteerEvent(db, taskId, message, "handed back from a director take-over");

  // Only lift the park WE set. A director who had separately deferred this task
  // for their own reasons keeps that deferral.
  db.query(
    `UPDATE tasks SET parked_for_director = NULL, takeover_base = NULL,
       deferred_until = CASE WHEN deferred_until = ? THEN NULL ELSE deferred_until END,
       updated_at = ? WHERE id = ?`
  ).run(PARK_UNTIL, now(), taskId);
  writeEvent(db, {
    task_id: taskId,
    source: "director",
    type: "handed_back",
    payload: { branch: task.branch, base: task.takeover_base, summary, note: opts.note ?? null },
  });
  broadcastTask(db, getTask(db, taskId));
  return { steer_queued, summary, branch: task.branch };
}
