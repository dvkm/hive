// Coarse time-based reconciler: the fallback to the event-driven paths (herdr
// waits + Claude Code hooks). Every cycle it (1) syncs herdr agent status for
// tasks with an agent_target, (2) syncs CI/merge state via `gh pr view` for
// tasks with a pr_url, (3) flags tasks silent beyond a threshold as `stale`.
//
// Guard: a reconciler failure must never crash the server. Each sub-step is
// isolated; the whole cycle is wrapped, and at most one `reconciler_error`
// signal is broadcast per cycle.
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import type { DB } from "./db.ts";
import { now, newId, evidenceDir } from "./db.ts";
import { broadcast } from "./bus.ts";
import { writeEvent, transition, getTask, advanceIfFinished, TERMINAL, type State } from "./state.ts";
import { Herdr, herdr as defaultHerdr, sendFailure } from "./runtime/herdr.ts";
import { smokeThenAdvance, type MonitorDeps } from "./monitors.ts";
import { enqueue } from "./notifications.ts";
import { parseEvidence } from "./rows.ts";
import { broadcastTask } from "./health.ts";
import { requeueTask, openRecoveryDecision, linkPrIfMarked, handOffToReview } from "./api.ts";
import type { Exec } from "./exec.ts";
import { defaultExec } from "./exec.ts";

const NON_TERMINAL = "('queued','in_progress','needs_decision','in_review','verifying')";
const RECOVERABLE = "('in_progress','needs_decision','in_review','verifying')";
// Auto-requeue at most twice on repeated agent death, then escalate to a card.
const MAX_AUTO_REQUEUE = 2;
// Nudge an alive-but-silent agent up to 3 times, then escalate to a card.
const MAX_SILENT_NUDGES = 3;

export interface ReconcilerDeps {
  herdr?: Herdr;
  exec?: Exec; // for `gh`
  staleMs?: number; // default 15m
  smoke?: MonitorDeps; // deps for runSmoke on merge->verifying
  nowMs?: () => number; // injectable clock (tests)
}

const DEFAULT_STALE_MS = 15 * 60 * 1000;

export async function reconcileOnce(db: DB, deps: ReconcilerDeps = {}): Promise<void> {
  let errored = false;
  const fail = (where: string, e: unknown) => {
    if (!errored) {
      errored = true;
      console.error(`[hive] reconciler ${where}:`, e);
      broadcast({ type: "reconciler_error", error: String((e as any)?.message ?? e), where });
    }
  };
  try {
    await syncAgents(db, deps);
  } catch (e) {
    fail("syncAgents", e);
  }
  try {
    await advanceFinished(db, deps);
  } catch (e) {
    fail("advanceFinished", e);
  }
  try {
    await syncPRs(db, deps);
  } catch (e) {
    fail("syncPRs", e);
  }
  try {
    await linkPRs(db, deps);
  } catch (e) {
    fail("linkPRs", e);
  }
  try {
    flagStale(db, deps);
  } catch (e) {
    fail("flagStale", e);
  }
  try {
    await recoverStale(db, deps);
  } catch (e) {
    fail("recoverStale", e);
  }
}

// ---- agent status sync ----
// Probe every agent-bearing task. A vanished agent is recorded as status
// `gone` (so health can show "dead" within one cycle); a live status change is
// recorded as before. Recording is change-gated so the timeline never spams.
async function syncAgents(db: DB, deps: ReconcilerDeps): Promise<void> {
  const h = deps.herdr ?? defaultHerdr;
  const tasks = db
    .query(`SELECT id, agent_target FROM tasks WHERE agent_target IS NOT NULL AND state IN ${NON_TERMINAL}`)
    .all() as { id: string; agent_target: string }[];
  for (const t of tasks) {
    const { alive, status } = await h.probe(t.agent_target);
    const next = alive ? status : "gone";
    if (next === "unknown") continue; // couldn't determine; leave prior status intact
    if (next !== lastAgentStatus(db, t.id)) {
      writeEvent(db, { task_id: t.id, source: "herdr", type: "agent_status", payload: { status: next } });
      broadcastTask(db, getTask(db, t.id)); // health may have flipped (blocked / gone)
    }
  }
}

function lastAgentStatus(db: DB, taskId: string): string | null {
  const r = db
    .query("SELECT payload FROM events WHERE task_id = ? AND type = 'agent_status' ORDER BY ts DESC LIMIT 1")
    .get(taskId) as { payload: string } | undefined;
  if (!r) return null;
  try {
    return JSON.parse(r.payload).status ?? null;
  } catch {
    return null;
  }
}

// ---- ready-for-review advancement (fixes tasks stuck in in_progress) ----
// An agent that finished — opened a PR (ship/chore) or wrote its report (scout) —
// and then went idle/gone used to sit in `in_progress` forever: nothing moved it
// into the review queue. This is the backstop that unsticks it regardless of
// agent discipline (the explicit `hive emit <id> ready` path is the clean signal;
// this catches the agents that just go idle).
//
// Trigger: state=in_progress, agent status idle OR gone (NOT working/blocked/
// unknown — an agent that opens a PR and keeps working still reports `working`),
// AND a real work product exists (a pr_url, or a scout `report`). Advancing on a
// single idle read is safe precisely because mid-work reads `working`. Runs
// BEFORE recoverStale so a handed-off task is never failed/requeued.
async function advanceFinished(db: DB, _deps: ReconcilerDeps): Promise<void> {
  const tasks = db
    .query(`SELECT id FROM tasks WHERE state = 'in_progress' AND agent_target IS NOT NULL`)
    .all() as { id: string }[];
  for (const t of tasks) {
    const status = lastAgentStatus(db, t.id);
    if (status) advanceIfFinished(db, t.id, status, "reconciler");
  }
}

// ---- PR / CI sync via gh ----
async function syncPRs(db: DB, deps: ReconcilerDeps): Promise<void> {
  const exec = deps.exec ?? defaultExec;
  const h = deps.herdr ?? defaultHerdr;
  const tasks = db
    .query(`SELECT id, state, pr_url, ci_status, agent_target, project_id FROM tasks WHERE pr_url IS NOT NULL AND state IN ${NON_TERMINAL}`)
    .all() as { id: string; state: string; pr_url: string; ci_status: string | null; agent_target: string | null; project_id: string }[];

  for (const t of tasks) {
    const r = await exec(["gh", "pr", "view", t.pr_url, "--json", "state,statusCheckRollup,mergeable,headRefOid"]);
    if (r.code !== 0) continue; // gh unavailable / auth: skip, try next cycle
    let data: any;
    try {
      data = JSON.parse(r.stdout);
    } catch {
      continue;
    }
    const ci = ciStatusOf(data.statusCheckRollup);
    if (ci && ci !== t.ci_status) {
      db.query("UPDATE tasks SET ci_status = ?, updated_at = ? WHERE id = ?").run(ci, now(), t.id);
      writeEvent(db, { task_id: t.id, source: "reconciler", type: "ci_status", payload: { ci_status: ci } });
      broadcast({ type: "task", task: getTask(db, t.id) });
    }
    // Time-based fallback for the link-time hand-off: a task whose PR is open
    // but is still in_progress (pr_url set by the agent, or linked before this
    // existed) belongs in the director's Review lane.
    if (String(data.state).toUpperCase() === "OPEN" && t.state === "in_progress") {
      if (handOffToReview(db, t.id, "reconciler")) broadcast({ type: "task", task: getTask(db, t.id) });
    }
    if (String(data.state).toUpperCase() === "MERGED" && t.state === "in_review") {
      writeEvent(db, { task_id: t.id, source: "reconciler", type: "pr_merged", payload: { pr_url: t.pr_url } });
      transition(db, t.id, "verifying", { source: "reconciler", reason: "PR merged" });
      // Post-merge smoke runs once on entering verifying.
      try {
        await smokeThenAdvance(db, t.id, deps.smoke ?? {});
      } catch (e) {
        console.error(`[hive] smoke run failed for ${t.id}:`, e);
      }
    } else if (String(data.mergeable).toUpperCase() === "CONFLICTING") {
      await nudgeConflict(db, h, t, data.headRefOid ?? null);
    }
  }
}

// ---- PR conflict watchdog ----
// A PR GitHub reports CONFLICTING gets its agent told to resolve it — conflict
// resolution is the agent's job, not the captain's. Deduped per head SHA: one
// nudge per pushed state of the branch, so a cycle tick never spams but a push
// that still conflicts re-nudges. Lifecycle is untouched: an in_review task
// stays reviewable (the merge button's own failure path bounces it if the
// captain gets there first), and a delivered send flips the agent to `working`,
// which keeps advanceFinished from churning states.
async function nudgeConflict(
  db: DB,
  h: Herdr,
  t: { id: string; pr_url: string; agent_target: string | null; project_id: string },
  headSha: string | null
): Promise<void> {
  const last = db
    .query("SELECT payload FROM events WHERE task_id = ? AND type = 'pr_conflict' ORDER BY ts DESC LIMIT 1")
    .get(t.id) as { payload: string } | undefined;
  if (last) {
    try {
      if ((JSON.parse(last.payload).head_sha ?? null) === headSha) return; // already nudged for this push
    } catch {}
  }
  const project = db.query("SELECT config FROM projects WHERE id = ?").get(t.project_id) as { config: string } | undefined;
  let base = "main";
  try {
    base = JSON.parse(project?.config ?? "{}").default_branch || "main";
  } catch {}
  let delivered = false;
  let error: string | null = null;
  if (t.agent_target) {
    try {
      const r = await h.send(
        t.agent_target,
        `hive: your PR ${t.pr_url} has merge conflicts with '${base}'. Fetch and merge the latest 'origin/${base}' into your branch (or rebase onto it), resolve the conflicts, rerun the tests, then push.`
      );
      error = sendFailure(r);
      delivered = error === null;
    } catch (e: any) {
      error = String(e?.message ?? e);
    }
  }
  writeEvent(db, {
    task_id: t.id,
    source: "reconciler",
    type: "pr_conflict",
    payload: { pr_url: t.pr_url, head_sha: headSha, delivered, ...(error ? { error } : {}) },
  });
}

// ---- PR → task linking via gh ----
// Scan each project's open PRs and link any carrying a hive marker back to its
// task (by `hive-task: <id>` body footer, falling back to the `[hive-<n>]`
// title). linkPrIfMarked only sets pr_url when the task isn't already linked, so
// this is idempotent and never clobbers an agent-reported PR.
// ponytail: re-lists all open PRs per project every cycle; fine for a localhost
// tool with a handful of repos. Add a since-cursor if repos ever have many PRs.
async function linkPRs(db: DB, deps: ReconcilerDeps): Promise<void> {
  const exec = deps.exec ?? defaultExec;
  const projects = db
    .query("SELECT id, repo_path FROM projects WHERE repo_path IS NOT NULL")
    .all() as { id: string; repo_path: string }[];
  for (const p of projects) {
    const r = await exec(["gh", "pr", "list", "--state", "open", "--json", "number,title,body,url"], { cwd: p.repo_path });
    if (r.code !== 0) continue; // gh unavailable / not a gh repo: skip, retry next cycle
    let list: any;
    try {
      list = JSON.parse(r.stdout);
    } catch {
      continue;
    }
    if (!Array.isArray(list)) continue;
    for (const pr of list) linkPrIfMarked(db, { title: pr.title, body: pr.body, url: pr.url });
  }
}

// Derive a coarse ci_status from gh's statusCheckRollup (a mix of CheckRun and
// StatusContext objects). failing > pending > passing.
export function ciStatusOf(rollup: any): string | null {
  if (!Array.isArray(rollup) || rollup.length === 0) return null;
  let anyPending = false;
  for (const c of rollup) {
    const conclusion = String(c.conclusion ?? "").toUpperCase();
    const status = String(c.status ?? "").toUpperCase();
    const state = String(c.state ?? "").toUpperCase(); // StatusContext
    if (conclusion === "FAILURE" || conclusion === "ERROR" || conclusion === "CANCELLED" || conclusion === "TIMED_OUT" || state === "FAILURE" || state === "ERROR")
      return "failing";
    if (status === "QUEUED" || status === "IN_PROGRESS" || status === "PENDING" || state === "PENDING")
      anyPending = true;
  }
  return anyPending ? "pending" : "passing";
}

// ---- stale detection ----
function flagStale(db: DB, deps: ReconcilerDeps): void {
  const staleMs = deps.staleMs ?? DEFAULT_STALE_MS;
  const nowMs = (deps.nowMs ?? (() => Date.now()))();
  // Only tasks that are actively worked (an agent could go silent).
  // needs_decision / in_review are parked on the DIRECTOR — silence there is
  // expected, and flagging it spawned pointless recovery nudges (2026-07-10).
  const tasks = db
    .query(`SELECT id FROM tasks WHERE state IN ('in_progress','verifying')`)
    .all() as { id: string }[];
  for (const t of tasks) {
    const last = db
      .query("SELECT ts, type FROM events WHERE task_id = ? ORDER BY ts DESC LIMIT 1")
      .get(t.id) as { ts: string; type: string } | undefined;
    if (!last) continue;
    if (last.type === "stale") continue; // already flagged; don't spam
    const age = nowMs - Date.parse(last.ts);
    if (age > staleMs) {
      writeEvent(db, {
        task_id: t.id,
        source: "reconciler",
        type: "stale",
        payload: { silent_ms: age, threshold_ms: staleMs },
      });
      const task = getTask(db, t.id);
      enqueue(db, { kind: "stale", task_id: t.id, title: `Task stale: ${task?.title ?? t.id}` });
    }
  }
}

// ---- stale recovery (observed → acted on) ----
// For each agent-bearing task whose newest event is `stale`, probe the agent
// and act (SPEC "Stale recovery"):
//   dead        → capture pane tail as evidence, fail, auto-requeue under a cap
//                 (MAX_AUTO_REQUEUE) then a decision card.
//   alive+silent → nudge via `herdr agent send`; after MAX_SILENT_NUDGES, fail
//                 and open a decision card.
// Each action re-arms the flow: writing an event resets the task's age, so the
// next stale flag (one threshold later) drives the next step — that spacing IS
// the requeue/nudge backoff.
async function recoverStale(db: DB, deps: ReconcilerDeps): Promise<void> {
  const h = deps.herdr ?? defaultHerdr;
  const tasks = db
    .query(`SELECT id, agent_target FROM tasks WHERE agent_target IS NOT NULL AND state IN ${RECOVERABLE}`)
    .all() as { id: string; agent_target: string }[];
  for (const t of tasks) {
    // A handed-off task (advanceFinished / director moved it to in_review, or it's
    // verifying) is owned by a human/the merge flow: a gone agent there is expected
    // (its work is done), so it must NOT be failed/requeued.
    const cur = getTask(db, t.id);
    if (cur && (cur.state === "in_review" || cur.state === "verifying")) continue;
    // A vanished agent (syncAgents just recorded `gone`) recovers within THIS
    // cycle — the SPEC requires detecting a ghost within one cycle, not waiting
    // out the stale threshold. The silent path is driven by a `stale` flag,
    // read past agent_status noise so a status sync can't hide the flag.
    const goneNow = lastAgentStatus(db, t.id) === "gone";
    const meaningful = db
      .query("SELECT type FROM events WHERE task_id = ? AND type != 'agent_status' ORDER BY ts DESC LIMIT 1")
      .get(t.id) as { type: string } | undefined;
    const staleFlagged = meaningful?.type === "stale";
    if (!goneNow && !staleFlagged) continue;

    const { alive } = await h.probe(t.agent_target);
    if (!alive) await recoverDead(db, h, t.id, t.agent_target);
    else if (staleFlagged) await recoverSilent(db, h, t.id, t.agent_target);
  }
}

async function recoverDead(db: DB, h: Herdr, taskId: string, target: string): Promise<void> {
  const task = getTask(db, taskId);
  if (!task || TERMINAL.includes(task.state as State)) return;

  const tail = await h.read(target, 200);
  attachLog(db, taskId, tail, "agent pane tail at death (stale recovery)");
  await reclaimDeadWorktree(db, h, task);
  const attempts = requeueDepth(db, task); // requeues already made in this lineage
  writeEvent(db, { task_id: taskId, source: "reconciler", type: "recovery", payload: { decision: "dead", attempts } });
  transition(db, taskId, "failed", { source: "reconciler", reason: "agent vanished; recovered from stale" });

  if (attempts >= MAX_AUTO_REQUEUE) {
    openRecoveryDecision(db, task, attempts);
    enqueue(db, { kind: "failed", task_id: taskId, title: `Recovery cap reached: ${task.title}` });
  } else {
    const newId = requeueTask(db, task);
    writeEvent(db, { task_id: taskId, source: "reconciler", type: "requeued", payload: { new_task_id: newId, attempt: attempts + 1 } });
    enqueue(db, { kind: "failed", task_id: taskId, title: `Auto-requeued (attempt ${attempts + 1}): ${task.title}` });
  }
}

// Teardown at death-detection time: the dead agent's worktree lingers, and the
// next spawn on this branch (a manual respawn, or the director answering the
// recovery card) would collide with it. Reclaim it here, while the pane tail is
// still fresh, preserving any uncommitted work to a ghost branch.
// Never fatal: a reclaim failure is recorded and recovery proceeds.
async function reclaimDeadWorktree(db: DB, h: Herdr, task: any): Promise<void> {
  if (!task.branch || !task.worktree_path) return;
  const project = db.query("SELECT repo_path FROM projects WHERE id = ?").get(task.project_id) as
    | { repo_path: string | null }
    | undefined;
  if (!project?.repo_path) return;
  try {
    const r = await h.reclaimWorktree({
      repoPath: project.repo_path,
      branch: task.branch,
      taskId: task.id,
      hintPath: task.worktree_path,
    });
    writeEvent(db, {
      task_id: task.id,
      source: "reconciler",
      type: r.reclaimed ? "worktree_reclaimed" : "worktree_reclaim_skipped",
      payload: { ghost_branch: r.ghost_branch, path: r.path, reason: r.reason },
    });
  } catch (e) {
    writeEvent(db, {
      task_id: task.id,
      source: "reconciler",
      type: "worktree_reclaim_failed",
      payload: { error: String((e as any)?.message ?? e) },
    });
  }
}

async function recoverSilent(db: DB, h: Herdr, taskId: string, target: string): Promise<void> {
  const task = getTask(db, taskId);
  if (!task || TERMINAL.includes(task.state as State)) return;

  const nudges = nudgesSinceActivity(db, taskId);
  if (nudges >= MAX_SILENT_NUDGES) {
    writeEvent(db, { task_id: taskId, source: "reconciler", type: "recovery", payload: { decision: "silent-escalate", nudges } });
    transition(db, taskId, "failed", { source: "reconciler", reason: `agent silent; ${nudges} nudges ignored` });
    openRecoveryDecision(db, task, requeueDepth(db, task));
    enqueue(db, { kind: "failed", task_id: taskId, title: `Agent unresponsive: ${task.title}` });
  } else {
    let error: string | null;
    try {
      const r = await h.send(
        target,
        `hive: you've gone quiet. Reply with \`hive emit ${taskId} status --note "..."\` or say what's blocking you.`
      );
      error = sendFailure(r);
    } catch (e: any) {
      error = String(e?.message ?? e);
    }
    writeEvent(db, {
      task_id: taskId,
      source: "reconciler",
      type: "recovery_nudge",
      payload: { nudge: nudges + 1, delivered: error === null, ...(error ? { error } : {}) },
    });
    broadcastTask(db, getTask(db, taskId));
  }
}

// Pane tail → an evidence row (kind=log) written to the evidence store.
function attachLog(db: DB, taskId: string, text: string, caption: string): void {
  const dir = join(evidenceDir(), taskId);
  mkdirSync(dir, { recursive: true });
  const name = `${Date.now()}_panetail.log`;
  const dest = join(dir, name);
  writeFileSync(dest, text ?? "");
  const ev = {
    id: newId("ev"),
    task_id: taskId,
    ts: now(),
    kind: "log",
    path: dest,
    url: `/evidence/${taskId}/${name}`,
    caption,
    meta: "{}",
  };
  db.query("INSERT INTO evidence (id, task_id, ts, kind, path, url, caption, meta) VALUES (?,?,?,?,?,?,?,?)")
    .run(ev.id, ev.task_id, ev.ts, ev.kind, ev.path, ev.url, ev.caption, ev.meta);
  broadcast({ type: "evidence", evidence: parseEvidence(ev) });
  writeEvent(db, { task_id: taskId, source: "reconciler", type: "evidence", payload: { evidence_id: ev.id, kind: "log", caption } });
}

// How many times this lineage has already been auto-requeued (walk the
// source='requeue' / parent_task_id chain back to the original task).
function requeueDepth(db: DB, task: any): number {
  let depth = 0;
  let cur: any = task;
  while (cur && cur.source === "requeue") {
    depth++;
    cur = cur.parent_task_id ? getTask(db, cur.parent_task_id) : null;
  }
  return depth;
}

// Consecutive recovery nudges since the last real activity (stale flags and the
// nudges themselves don't count as activity, so silence keeps accumulating).
// Only DELIVERED nudges count toward the escalation: failing a task for "3
// nudges ignored" when herdr never landed one is a lie. A permanently
// undeliverable agent is dead, and the dead branch (recoverDead) owns it — this
// one only ever runs on an agent that probed alive.
function nudgesSinceActivity(db: DB, taskId: string): number {
  const rows = db.query("SELECT type, payload FROM events WHERE task_id = ? ORDER BY ts DESC").all(taskId) as {
    type: string;
    payload: string;
  }[];
  let n = 0;
  for (const r of rows) {
    if (r.type === "recovery_nudge") {
      try {
        if (JSON.parse(r.payload).delivered === false) continue; // never landed; doesn't count
      } catch {}
      n++;
    } else if (r.type === "stale" || r.type === "agent_status") continue; // reconciler noise
    else break; // real activity resets the count
  }
  return n;
}

// Background loop. Started only from index.ts (never in tests).
export function startReconciler(db: DB, deps: ReconcilerDeps & { intervalMs?: number } = {}): () => void {
  const intervalMs = deps.intervalMs ?? 60_000;
  const timer = setInterval(() => {
    reconcileOnce(db, deps).catch((e) => console.error("[hive] reconciler cycle crashed:", e));
  }, intervalMs);
  return () => clearInterval(timer);
}
