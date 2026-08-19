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
import { now, newId, evidenceDir, isOffline } from "./db.ts";
import { broadcast } from "./bus.ts";
import { writeEvent, transition, getTask, advanceIfFinished, unmetDeps, noteDependencyBlock, isDeferred, TERMINAL, type State } from "./state.ts";
import { Herdr, herdr as defaultHerdr, sendFailure } from "./runtime/herdr.ts";
import { queuedSteers, markSteersDelivered, queueSteerEvent } from "./steer.ts";
import { isReviewed } from "./dispatcher.ts";
import { smokeThenAdvance, type MonitorDeps } from "./monitors.ts";
import { enqueue } from "./notifications.ts";
import { parseEvidence } from "./rows.ts";
import { broadcastTask } from "./health.ts";
import { recordSystemLearning, captureRecurringRefs } from "./learn.ts";
import { diagnosePane, dialogAutoApprovable, parseResetClock } from "./diagnose.ts";
import { requeueTask, openRecoveryDecision, linkPrIfMarked, handOffToReview, createDecision, mergeTask, apiAnswerDecision } from "./api.ts";
import type { Exec } from "./exec.ts";
import { defaultExec } from "./exec.ts";
import { captureBranchScope } from "./rebaseGuard.ts";
import { classifyEscalation, optionNeedsDirectorInput } from "./policy.ts";

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
  smoke?: MonitorDeps; // deps for smokeThenAdvance on merge->verifying
  nowMs?: () => number; // injectable clock (tests)
}

const DEFAULT_STALE_MS = 15 * 60 * 1000;

export async function reconcileOnce(db: DB, deps: ReconcilerDeps = {}): Promise<void> {
  const startedAt = Date.now();
  let errored = false;
  let steps = 0;
  let errors = 0;
  const fail = (where: string, e: unknown) => {
    errors++;
    if (!errored) {
      errored = true;
      console.error(`[hive] reconciler ${where}:`, e);
      broadcast({ type: "reconciler_error", error: String((e as any)?.message ?? e), where });
    }
  };
  // Runs one labeled sub-step, isolated so a failure never stops the rest of
  // the cycle; counts toward the run-summary log below.
  const step = async (where: string, fn: () => unknown) => {
    steps++;
    try {
      await fn();
    } catch (e) {
      fail(where, e);
    }
  };
  const logRun = (outcome: string) => {
    console.log(`[hive] reconciler run: duration_ms=${Date.now() - startedAt} steps=${steps} errors=${errors} outcome=${outcome}`);
  };
  await step("syncAgents", () => syncAgents(db, deps));
  await step("drainSteers", () => drainSteers(db, deps));
  await step("advanceFinished", () => advanceFinished(db, deps));
  await step("nagOpenDecisions", () => nagOpenDecisions(db, (deps.nowMs ?? (() => Date.now()))()));
  await step("unparkAnswered", () => unparkAnswered(db, (deps.nowMs ?? (() => Date.now()))()));
  await step("remindUnreviewedIntake", () => remindUnreviewedIntake(db, (deps.nowMs ?? (() => Date.now()))()));
  await step("captureRecurringRefs", () => captureRecurringRefs(db));
  // Offline mode: everything above is local (herdr + sqlite) and keeps state
  // honest; everything below either needs the network (gh) or would punish
  // agents for being offline (stale flags, nudges, failure escalation). Stop here.
  if (isOffline(db)) {
    logRun("offline");
    return;
  }
  await step("syncPRs", () => syncPRs(db, deps));
  await step("linkPRs", () => linkPRs(db, deps));
  await step("resumeUsageLimited", () => resumeUsageLimited(db, (deps.nowMs ?? (() => Date.now()))()));
  await step("flagStale", () => flagStale(db, deps));
  await step("recoverStale", () => recoverStale(db, deps));
  await step("sweepVerifying", () => sweepVerifying(db, deps));
  await step("autoMergeReady", () => autoMergeReady(db, deps));
  await step("autoAnswerStale", () => autoAnswerStale(db, deps.herdr ?? defaultHerdr, (deps.nowMs ?? (() => Date.now()))()));
  logRun(errors > 0 ? "error" : "ok");
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
    // React to dialogs EVERY cycle, not just on a status transition. Claude's
    // startup trust dialog reports `idle`, auto-mode setup reports `done`, and
    // tool permission dialogs report `blocked`. Idempotent: a handled dialog
    // disappears from the pane.
    if (next === "blocked" || next === "idle" || next === "done") {
      try {
        await handleBlockedAgent(db, h, t.id, t.agent_target);
      } catch (e) {
        console.error(`[hive] handleBlockedAgent ${t.id}:`, e);
      }
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

// ---- queued-steer drain ----
// A steer herdr refuses is queued rather than dropped (steer.ts), but until this
// it was drained ONLY at spawn time. So a socket blip while the agent was alive
// and working queued the message and then never redelivered it: no respawn was
// coming, and it sat there until the task ended. Every cycle, re-attempt any
// queued steer against an agent that still probes alive.
//
// Cheap: the queued-steer read is checked BEFORE any probe, so the ordinary case
// (nothing queued) costs one small query per agent-bearing task and zero herdr
// calls. Idempotent: a steer stays queued until a send actually lands, so a
// failure here simply retries next cycle — or rides the next respawn.
//
// Deliberately writes no event of its own. The `steer` event's own receipt
// flipping to delivered IS the record, and a fresh event here would reset the
// task's silence clock (flagStale reads the newest event), masking a mute agent.
async function drainSteers(db: DB, deps: ReconcilerDeps): Promise<void> {
  const h = deps.herdr ?? defaultHerdr;
  const tasks = db
    .query(`SELECT id, agent_target FROM tasks WHERE agent_target IS NOT NULL AND state IN ${NON_TERMINAL}`)
    .all() as { id: string; agent_target: string }[];
  for (const t of tasks) {
    const pending = queuedSteers(db, t.id);
    if (!pending.length) continue; // the common case: no probe, no herdr call
    // Dead agent → leave them queued; the next spawn's brief carries them. A herdr
    // hiccup reads as alive+unknown (parseAgentProbe), so the send below is what
    // actually decides, and it fails safe.
    if (!(await h.probe(t.agent_target)).alive) continue;

    const delivered: string[] = [];
    for (const s of pending) {
      // sendFailure, never the exit code: herdr exits 0 with an agent_not_found
      // body, which is exactly how a steer disappears without a trace.
      let failure: string | null;
      try {
        failure = sendFailure(await h.send(t.agent_target, s.message));
      } catch (e: any) {
        failure = String(e?.message ?? e);
      }
      // Stop at the first failure rather than skipping it: the agent went away
      // mid-drain, and the remaining steers must stay queued IN ORDER so the
      // respawn brief replays them as the director wrote them.
      if (failure) break;
      delivered.push(s.id);
    }
    markSteersDelivered(db, delivered, "drain");
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
    // Never advance a task past its dependency gate. The dispatcher blocks
    // auto-spawn, but the manual /spawn endpoint bypasses that — this holds a
    // blocked task in_progress until its deps merge, surfacing the reason.
    const task = getTask(db, t.id);
    const blocking = unmetDeps(db, task);
    if (blocking.length) {
      noteDependencyBlock(db, t.id, blocking, "reconciler");
      continue;
    }
    const status = lastAgentStatus(db, t.id);
    if (status) advanceIfFinished(db, t.id, status, "reconciler");
  }
}

// ---- PR / CI sync via gh ----
async function syncPRs(db: DB, deps: ReconcilerDeps): Promise<void> {
  const exec = deps.exec ?? defaultExec;
  const h = deps.herdr ?? defaultHerdr;
  const tasks = db
    .query(`SELECT id, state, pr_url, ci_status, head_sha, agent_target, project_id, branch FROM tasks WHERE pr_url IS NOT NULL AND state IN ${NON_TERMINAL}`)
    .all() as { id: string; state: string; pr_url: string; ci_status: string | null; head_sha: string | null; agent_target: string | null; project_id: string; branch: string | null }[];

  for (const t of tasks) {
    const r = await exec(["gh", "pr", "view", t.pr_url, "--json", "state,statusCheckRollup,mergeable,headRefOid,baseRefName,baseRefOid"]);
    if (r.code !== 0) continue; // gh unavailable / auth: skip, try next cycle
    let data: any;
    try {
      data = JSON.parse(r.stdout);
    } catch {
      continue;
    }
    // The task's state may have moved on since the SELECT above — a concurrent
    // POST /merge, autoMergeReady, or an overlapping reconcile cycle can land
    // while this `await exec` was in flight and advance the task to a terminal
    // state. Every branch below transitions off the task's state; re-read it
    // fresh and skip once terminal, rather than trusting the stale `t.state`
    // snapshot — that stale read is exactly what threw
    // "invalid transition: 'done' -> 'verifying'" in production (task #621).
    const live = getTask(db, t.id);
    if (!live || TERMINAL.includes(live.state as State)) continue;
    const state: string = live.state;
    // Record a new pushed commit as `pr_synchronized` (hive's stand-in for
    // GitHub's synchronize webhook) so changesRequestUnaddressed can tell "the
    // agent pushed a fix" from "CI is still green on the same old head". The
    // first observation is a baseline (no changes_requested exists yet when a PR
    // is first linked); only a CHANGED head afterward counts as new work.
    // ponytail: last-seen head is read back from the prior pr_synchronized event
    // (no task column); a PR reaches review long before any changes_requested,
    // so the baseline is always in place by the time the guard matters.
    const headSha: string | null = data.headRefOid ?? null;
    if (headSha) {
      const lastSync: any = db
        .query("SELECT payload FROM events WHERE task_id = ? AND type = 'pr_synchronized' ORDER BY ts DESC LIMIT 1")
        .get(t.id);
      const lastSha = lastSync ? (JSON.parse(lastSync.payload).head_sha ?? null) : null;
      if (headSha !== lastSha) {
        writeEvent(db, { task_id: t.id, source: "reconciler", type: "pr_synchronized", payload: { head_sha: headSha } });
      }
    }
    // Snapshot the branch's intended scope ONCE, at first sight — before any
    // no-mistakes CI-monitor rebase can run (a rebase only fires after the PR
    // falls behind, which is later). mergeTask diffs the branch's final scope
    // against this to catch a destructive auto-rebase (task #314). One event per
    // task: the existence check makes this idempotent across cycles.
    if (t.branch) {
      const have = db.query("SELECT 1 FROM events WHERE task_id = ? AND type = 'branch_scope' LIMIT 1").get(t.id);
      if (!have) {
        const project = db.query("SELECT config, repo_path FROM projects WHERE id = ?").get(t.project_id) as
          | { config: string; repo_path: string | null }
          | undefined;
        if (project?.repo_path) {
          let base = data.baseRefName || "main";
          try {
            base = data.baseRefName || JSON.parse(project.config ?? "{}").default_branch || "main";
          } catch {}
          const scope = await captureBranchScope(exec, project.repo_path, data.baseRefOid || base, t.branch);
          if (scope) writeEvent(db, { task_id: t.id, source: "reconciler", type: "branch_scope", payload: scope });
        }
      }
    }
    const ci = ciStatusOf(data.statusCheckRollup);
    if (ci && ci !== t.ci_status) {
      db.query("UPDATE tasks SET ci_status = ?, updated_at = ? WHERE id = ?").run(ci, now(), t.id);
      writeEvent(db, { task_id: t.id, source: "reconciler", type: "ci_status", payload: { ci_status: ci } });
      broadcast({ type: "task", task: getTask(db, t.id) });
    }
    if (data.headRefOid && data.headRefOid !== t.head_sha) {
      db.query("UPDATE tasks SET head_sha = ?, updated_at = ? WHERE id = ?").run(data.headRefOid, now(), t.id);
      broadcast({ type: "task", task: getTask(db, t.id) });
    }
    // Time-based fallback for the link-time hand-off — but review means "CI is
    // green and the director can merge", so failing/pending checks HOLD the
    // task in_progress (this is also what promotes a held `ready`: the moment
    // checks pass, the task moves to review; failing checks steer the agent).
    if (String(data.state).toUpperCase() === "OPEN" && state === "in_progress") {
      if (ci === "failing") {
        await nudgeCiFailure(db, h, t, data.headRefOid ?? null);
      } else if (ci !== "pending") {
        if (handOffToReview(db, t.id, "reconciler")) broadcast({ type: "task", task: getTask(db, t.id) });
      }
    }
    if (String(data.state).toUpperCase() === "MERGED" && state === "in_review") {
      writeEvent(db, { task_id: t.id, source: "reconciler", type: "pr_merged", payload: { pr_url: t.pr_url } });
      transition(db, t.id, "verifying", { source: "reconciler", reason: "PR merged" });
      // Post-merge smoke runs once on entering verifying.
      try {
        await smokeThenAdvance(db, t.id, deps.smoke ?? {});
      } catch (e) {
        console.error(`[hive] smoke run failed for ${t.id}:`, e);
      }
    } else if (String(data.state).toUpperCase() === "CLOSED" && state === "in_review") {
      // Closed-not-merged: nothing reviewable exists. Self-heal instead of
      // waiting for the director to discover it via a failed merge click.
      writeEvent(db, { task_id: t.id, source: "reconciler", type: "pr_closed", payload: { pr_url: t.pr_url } });
      queueSteerEvent(
        db,
        t.id,
        `Your PR ${t.pr_url} is CLOSED (not merged), so this task has nothing to review. If you replaced it, ` +
          `emit ready with the new PR url (that re-links the task); otherwise reopen or recreate the PR.`,
        "queued by closed-PR bounce"
      );
      transition(db, t.id, "in_progress", { source: "reconciler", reason: "PR closed without merging — returned to the agent" });
      broadcast({ type: "task", task: getTask(db, t.id) });
    } else if (ci === "failing" && state === "in_review") {
      // Checks went red AFTER the handoff: red is not reviewable. Send it back
      // to the agent to iterate; it returns automatically when green.
      await nudgeCiFailure(db, h, t, data.headRefOid ?? null);
      transition(db, t.id, "in_progress", { source: "reconciler", reason: "CI failing — returned to the agent to iterate" });
      broadcast({ type: "task", task: getTask(db, t.id) });
    } else if (String(data.mergeable).toUpperCase() === "CONFLICTING") {
      await nudgeConflict(db, h, t, data.headRefOid ?? null, exec);
    }
  }
}

// Failing checks put the AGENT back to work — one nudge per pushed head SHA
// (same dedupe discipline as nudgeConflict), so a red run never spams but a
// push that still fails re-nudges.
async function nudgeCiFailure(
  db: DB,
  h: Herdr,
  t: { id: string; pr_url: string; agent_target: string | null },
  headSha: string | null
): Promise<void> {
  const last = db
    .query("SELECT payload FROM events WHERE task_id = ? AND type = 'ci_failure' ORDER BY ts DESC LIMIT 1")
    .get(t.id) as { payload: string } | undefined;
  if (last) {
    try {
      if ((JSON.parse(last.payload).head_sha ?? null) === headSha) return;
    } catch {}
  }
  let delivered = false;
  let error: string | null = null;
  if (t.agent_target) {
    try {
      const r = await h.send(
        t.agent_target,
        `hive: CI is FAILING on your PR ${t.pr_url}. Run \`gh pr checks ${t.pr_url}\` to see the failures, fix them, and push. ` +
          `The task returns to review automatically when checks pass — do not emit ready while CI is red.`
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
    type: "ci_failure",
    payload: { pr_url: t.pr_url, head_sha: headSha, delivered, ...(error ? { error } : {}) },
  });
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
  t: { id: string; pr_url: string; agent_target: string | null; project_id: string; branch: string | null },
  headSha: string | null,
  exec: Exec
): Promise<void> {
  const last = db
    .query("SELECT payload FROM events WHERE task_id = ? AND type = 'pr_conflict' ORDER BY ts DESC LIMIT 1")
    .get(t.id) as { payload: string } | undefined;
  if (last) {
    try {
      if ((JSON.parse(last.payload).head_sha ?? null) === headSha) return; // already nudged for this push
    } catch {}
  }
  const project = db.query("SELECT config, repo_path FROM projects WHERE id = ?").get(t.project_id) as
    | { config: string; repo_path: string | null }
    | undefined;
  let base = "main";
  try {
    base = JSON.parse(project?.config ?? "{}").default_branch || "main";
  } catch {}

  // GitHub reports CONFLICTING against origin/<base>, which is a DIVERGENT line
  // from the LOCAL <base> that hive cuts worktrees from and merges back into.
  // If the branch is already a clean fast-forward onto LOCAL <base>, the
  // conflict is purely origin/<base>'s divergence — nudging "merge origin/base"
  // makes the agent pull the stale fork in, pushing a new head that STILL
  // conflicts, which defeats the per-SHA dedup and loops forever (task #321,
  // PR #38 got 5+ identical nudges). Suppress the nudge: the director merges
  // locally. See the origin/main-stale-fork learning.
  if (project?.repo_path && t.branch) {
    const anc = await exec(["git", "-C", project.repo_path, "merge-base", "--is-ancestor", base, t.branch]);
    if (anc.code === 0) {
      writeEvent(db, {
        task_id: t.id,
        source: "reconciler",
        type: "pr_conflict",
        payload: { pr_url: t.pr_url, head_sha: headSha, delivered: false, suppressed: "local-ff", base },
      });
      return;
    }
  }

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
// Open decisions age badly: median answer latency was 2.5h and 22 of 95 cards
// expired unanswered, each stranding whatever waited on it. The first
// notification rides createDecision; this escalates — an URGENT re-notify (macOS
// push) at 15m and again at 60m, keyed off prior decision_nag rows so each tier
// fires once. Exported for tests.
const NAG_TIERS_MS = [15 * 60 * 1000, 60 * 60 * 1000];

export function nagOpenDecisions(db: DB, nowMs: number = Date.now()): void {
  const open = db
    .query("SELECT id, task_id, ts, title FROM decisions WHERE status = 'open'")
    .all() as { id: string; task_id: string; ts: string; title: string }[];
  for (const d of open) {
    const age = nowMs - Date.parse(d.ts);
    const due = NAG_TIERS_MS.filter((t) => age >= t).length;
    if (!due) continue;
    const sent = (
      db.query("SELECT COUNT(*) AS n FROM notifications WHERE kind = 'decision_nag' AND decision_id = ?").get(d.id) as any
    ).n as number;
    if (sent >= due) continue;
    const mins = Math.round(age / 60000);
    enqueue(db, {
      kind: "decision_nag",
      urgency: "urgent",
      task_id: d.task_id,
      decision_id: d.id,
      title: `Decision waiting ${mins >= 60 ? `${Math.round(mins / 60)}h` : `${mins}m`}: ${d.title}`,
      body: "An agent may be parked on this. Answer or dismiss it.",
    });
  }
}

// Auto-merge: the director's review click is predictable when EVERYTHING
// already says yes — CI green, the auto-reviewer found no risks and no
// questions, evidence attached, no changes ever requested. For task kinds a
// project opts into (config.auto_merge = {kinds: ["chore", ...]}), merge
// those without waiting. Anything contested (caution verdict, risks, red CI,
// a changes_requested in history) still parks for the human. A notification
// reports every auto-merge; the existing verifying/smoke gates still run.
export async function autoMergeReady(db: DB, deps: ReconcilerDeps = {}): Promise<void> {
  const h = deps.herdr ?? defaultHerdr;
  const rows = db
    .query(
      `SELECT t.id, t.number, t.title, t.kind, p.config FROM tasks t JOIN projects p ON p.id = t.project_id
        WHERE t.state = 'in_review' AND t.ci_status = 'passing'`
    )
    .all() as { id: string; number: number; title: string; kind: string; config: string }[];
  for (const r of rows) {
    let kinds: string[] = [];
    try {
      const c = JSON.parse(r.config ?? "{}");
      kinds = Array.isArray(c.auto_merge?.kinds) ? c.auto_merge.kinds : [];
    } catch {
      continue;
    }
    const review: any = db
      .query("SELECT payload FROM events WHERE task_id = ? AND type = 'auto_review' ORDER BY ts DESC LIMIT 1")
      .get(r.id);
    if (!review) continue; // no pre-review yet — wait for it
    let verdict: any;
    try {
      verdict = JSON.parse(review.payload);
    } catch {
      continue;
    }
    if (verdict.skipped || verdict.verdict !== "looks_good") continue;
    // Same policy the planner uses for its breakdown cards: a PR merge is
    // always revertible (reversible=true) and touches the shared main branch
    // (blastRadius="shared"); the pre-review's own risks/questions are the
    // ambiguity signal, and the project's auto_merge.kinds allow-list IS the
    // stored preference — unset/not-listed means "preference unknown".
    const escalation = classifyEscalation({
      reversible: true,
      blastRadius: "shared",
      ambiguous: Boolean(verdict.risks?.length || verdict.questions?.length),
      preferenceKnown: kinds.includes(r.kind),
    });
    if (escalation.effect !== "auto_handle") continue;
    const contested = db
      .query("SELECT 1 FROM events WHERE task_id = ? AND type = 'changes_requested' LIMIT 1")
      .get(r.id);
    if (contested) continue; // a human pushed back once — never auto-merge this task
    const evidence = (db.query("SELECT COUNT(*) n FROM evidence WHERE task_id = ?").get(r.id) as any).n;
    if (!evidence) continue;
    try {
      const res = await mergeTask(db, h, r.id, {}, { exec: deps.exec });
      const ok = res.status === 200;
      writeEvent(db, { task_id: r.id, source: "reconciler", type: "auto_merged", payload: { ok, status: res.status } });
      if (ok)
        enqueue(db, {
          kind: "auto_merged",
          task_id: r.id,
          title: `Auto-merged #${r.number}: ${r.title.slice(0, 70)}`,
          body: "Green CI, clean pre-review, evidence attached. Now verifying.",
        });
    } catch (e) {
      writeEvent(db, { task_id: r.id, source: "reconciler", type: "auto_merged", payload: { ok: false, error: String((e as any)?.message ?? e) } });
    }
  }
}

// Auto-answer: a decision card that sits past the project's timeout
// (config.decision_auto_answer_hours, off unless set) and carries a
// RECOMMENDED option gets answered with that recommendation — except
// risk='high' cards (authority/prod), which always wait for the human.
// The notification names what was chosen, so silence is informed consent,
// not surprise.
export function autoAnswerStale(db: DB, herdr: Herdr, nowMs: number = Date.now()): void {
  const rows = db
    .query(
      `SELECT d.id, d.task_id, d.ts, d.title, d.options, p.config FROM decisions d
         JOIN tasks t ON t.id = d.task_id JOIN projects p ON p.id = t.project_id
        WHERE d.status = 'open' AND COALESCE(d.risk, 'normal') != 'high'`
    )
    .all() as { id: string; task_id: string; ts: string; title: string; options: string; config: string }[];
  for (const r of rows) {
    let hours = 0;
    try {
      hours = Number(JSON.parse(r.config ?? "{}").decision_auto_answer_hours) || 0;
    } catch {
      continue;
    }
    if (hours <= 0) continue;
    if (nowMs - Date.parse(r.ts) < hours * 3600_000) continue;
    let rec: any;
    try {
      rec = JSON.parse(r.options || "[]").find((o: any) => o.recommended);
    } catch {
      continue;
    }
    if (!rec?.key) continue;
    // An auto-answer is only meaningful when acting on the option needs nothing
    // further from the director. If the recommended option asks them to attach a
    // credential/token/file, answering it strands the agent — notify once and
    // leave the card open for a human (incident dec_8f964774097e).
    if (optionNeedsDirectorInput(rec)) {
      const already = db
        .query("SELECT 1 FROM events WHERE task_id = ? AND type = 'auto_answer_skipped' LIMIT 1")
        .get(r.task_id);
      if (already) continue;
      writeEvent(db, { task_id: r.task_id, source: "reconciler", type: "auto_answer_skipped", payload: { decision_id: r.id } });
      enqueue(db, {
        kind: "auto_answer_skipped",
        task_id: r.task_id,
        decision_id: r.id,
        title: `Needs you: "${r.title.slice(0, 70)}"`,
        body: `Open ${hours}h but the recommended option "${rec.label ?? rec.key}" needs you to supply something — not auto-answered.`,
      });
      continue;
    }
    apiAnswerDecision(db, herdr, r.id, {
      answer_key: rec.key,
      answer_note: `auto-answered with the recommended option after ${hours}h (project timeout policy — set decision_auto_answer_hours to 0 to disable)`,
      source: "system",
      actor: "reconciler-auto-answer",
    });
    enqueue(db, {
      kind: "auto_answered",
      task_id: r.task_id,
      decision_id: r.id,
      title: `Auto-answered "${rec.label ?? rec.key}": ${r.title.slice(0, 70)}`,
      body: `Open ${hours}h with a recommendation and no reply.`,
    });
  }
}

// Verifying watchdog: a task enters `verifying` exactly once (merge time) and
// smoke runs exactly once — a crash, restart, or the silent evidence-gate catch
// in smokeThenAdvance leaves it wedged forever with no signal. Sweep: re-run
// the advance for any verifying task idle past the threshold; if it STILL
// won't advance (the done gate wants evidence), steer the agent to attach it
// and tell the director once.
const VERIFY_WEDGE_MS = 15 * 60 * 1000;

export async function sweepVerifying(db: DB, deps: ReconcilerDeps = {}): Promise<void> {
  const nowMs = (deps.nowMs ?? (() => Date.now()))();
  const rows = db
    .query("SELECT id, title, updated_at FROM tasks WHERE state = 'verifying'")
    .all() as { id: string; title: string; updated_at: string }[];
  for (const r of rows) {
    if (nowMs - Date.parse(r.updated_at) < VERIFY_WEDGE_MS) continue;
    try {
      await smokeThenAdvance(db, r.id, deps.smoke ?? {});
    } catch (e) {
      console.error(`[hive] verify sweep ${r.id}:`, e);
    }
    const after = getTask(db, r.id);
    if (after?.state !== "verifying") {
      broadcast({ type: "task", task: after });
      continue;
    }
    const already = db
      .query("SELECT 1 FROM events WHERE task_id = ? AND type = 'verify_wedged' LIMIT 1")
      .get(r.id);
    if (already) continue;
    writeEvent(db, { task_id: r.id, source: "reconciler", type: "verify_wedged", payload: {} });
    queueSteerEvent(
      db,
      r.id,
      "Your task is merged but WEDGED in verifying: the done gate needs at least one evidence item and " +
        "none is attached. Attach proof of the shipped behavior (screenshot/test output/log) with " +
        "`hive emit <task-id> evidence --file ... --note ...` — the task completes automatically after.",
      "queued by verify sweep"
    );
    enqueue(db, { kind: "stale", task_id: r.id, title: `Wedged in verifying (needs evidence): ${r.title}` });
  }
}

// Intake tasks wait for the director's review before dispatch — correct, but a
// forgotten one rots in `queued` invisibly. One reminder after a day.
const INTAKE_REMINDER_MS = 24 * 60 * 60 * 1000;

export function remindUnreviewedIntake(db: DB, nowMs: number = Date.now()): void {
  const rows = db
    .query(
      `SELECT id, title, created_at FROM tasks
        WHERE state = 'queued' AND source LIKE 'intake_%'
          AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.task_id = tasks.id AND n.kind = 'intake_unreviewed')`
    )
    .all() as { id: string; title: string; created_at: string }[];
  for (const r of rows) {
    if (nowMs - Date.parse(r.created_at) < INTAKE_REMINDER_MS) continue;
    if (isReviewed(db, r.id)) continue;
    enqueue(db, {
      kind: "intake_unreviewed",
      task_id: r.id,
      title: `Intake waiting on review for 24h+: ${r.title.slice(0, 70)}`,
      body: "It will never dispatch until reviewed (or cancelled).",
    });
  }
}

// A task parked in needs_decision with NOTHING open to answer is stuck forever
// and eats a dispatch slot (needs_decision counts as working): task #96 re-
// parked itself 16 minutes AFTER its card was answered, and the unpark that
// rides apiAnswerDecision had already fired into the void. The grace period
// covers the legitimate emit-needs-decision-then-open-card ordering. Exported
// for tests.
const UNPARK_GRACE_MS = 3 * 60 * 1000;

export function unparkAnswered(db: DB, nowMs: number = Date.now()): void {
  const rows = db
    .query(
      `SELECT t.id, t.updated_at FROM tasks t
        WHERE t.state = 'needs_decision'
          AND NOT EXISTS (SELECT 1 FROM decisions d WHERE d.task_id = t.id AND d.status = 'open')`
    )
    .all() as { id: string; updated_at: string }[];
  for (const r of rows) {
    if (nowMs - Date.parse(r.updated_at) < UNPARK_GRACE_MS) continue;
    transition(db, r.id, "in_progress", {
      source: "reconciler",
      reason: "needs_decision with no open decision card — unparked",
    });
    queueSteerEvent(
      db,
      r.id,
      "You are parked in needs_decision but there is NO open decision card — everything you asked was " +
        "already answered (or expired). Read the answers in your task feed, act on them, and move the " +
        "task forward: emit ready (or done with evidence). If you truly need a decision, open a real card.",
      "queued by needs_decision unpark"
    );
    broadcast({ type: "task", task: getTask(db, r.id) });
  }
}

function flagStale(db: DB, deps: ReconcilerDeps): void {
  const staleMs = deps.staleMs ?? DEFAULT_STALE_MS;
  const nowMs = (deps.nowMs ?? (() => Date.now()))();
  // Only tasks that are actively worked (an agent could go silent).
  // needs_decision / in_review are parked on the DIRECTOR — silence there is
  // expected, and flagging it spawned pointless recovery nudges (2026-07-10).
  // Tracking-only tasks are externally driven, and chat supervisors are
  // intentionally idle between turns/wakeups: neither gets worker staleness.
  // A task deferred pending a human action
  // (deferred_until in the future) is intentionally parked — skip it so the
  // "gone quiet" nudge/notification never fires (task #679).
  const nowIso = new Date(nowMs).toISOString();
  const tasks = db
    .query(
      `SELECT id FROM tasks WHERE state IN ('in_progress','verifying') AND COALESCE(source,'') NOT IN ('external','chat_supervisor')
         AND (deferred_until IS NULL OR deferred_until <= ?)`
    )
    .all(nowIso) as { id: string }[];
  for (const t of tasks) {
    // Held by the dependency gate: advanceFinished refuses to advance it and
    // dependency_blocked is deduped, so it stays intentionally quiet — never
    // stale (skipping the flag also spares it recoverStale, which the flag drives).
    if (unmetDeps(db, getTask(db, t.id)).length) continue;
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
      // A task can re-stale every cycle-plus-nudge round trip; the same title
      // notified 8× in a day (seen live). One stale notification per task per
      // 24h — the event log above still records every occurrence.
      const recent = db
        .query("SELECT 1 FROM notifications WHERE kind = 'stale' AND task_id = ? AND ts > ? LIMIT 1")
        .get(t.id, new Date(nowMs - 24 * 60 * 60 * 1000).toISOString());
      if (!recent) enqueue(db, { kind: "stale", task_id: t.id, title: `Task stale: ${task?.title ?? t.id}` });
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
    .query(`SELECT id, agent_target FROM tasks WHERE agent_target IS NOT NULL AND COALESCE(source, '') != 'chat_supervisor' AND state IN ${RECOVERABLE}`)
    .all() as { id: string; agent_target: string }[];
  for (const t of tasks) {
    // A handed-off task (advanceFinished / director moved it to in_review, or it's
    // verifying) is owned by a human/the merge flow: a gone agent there is expected
    // (its work is done), so it must NOT be failed/requeued.
    const cur = getTask(db, t.id);
    if (cur && (cur.state === "in_review" || cur.state === "verifying")) continue;
    // Deferred pending a human action: neither nudge nor fail it (the goneNow
    // branch below would otherwise fail an idle-but-deferred task) — task #679.
    if (cur && isDeferred(cur)) continue;
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

    const { alive, status } = await h.probe(t.agent_target);
    if (!alive) await recoverDead(db, h, t.id, t.agent_target);
    else if (staleFlagged) {
      // Quiet but WORKING is not stuck — long tool runs and big builds are
      // silent by nature. Only idle/blocked/unknown agents enter recovery.
      if (status === "working") continue;
      await recoverSilent(db, h, t.id, t.agent_target);
    }
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
    {
      const t = getTask(db, taskId);
      if (t) recordSystemLearning(db, t.project_id, "agent died mid-task (auto-requeued)", `Task: ${t.title}`, taskId);
    }
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

// A usage-limited session is a hard wall with a printed reset time: nudging it
// re-triggers the same "hit your session limit" reply (one task burned 4 nudges
// over 47 minutes, then sat ~19h until a manual redispatch — the reset was 7
// minutes after the last nudge). Park it once with the parsed resume time;
// resumeUsageLimited() queues the wake-up steer when the clock passes.
function recoverUsageLimit(db: DB, task: any, excerpt: string): void {
  const open = db
    .query(
      `SELECT 1 FROM events WHERE task_id = ? AND type = 'usage_limit'
        AND ts > COALESCE((SELECT MAX(ts) FROM events WHERE task_id = ? AND type = 'usage_limit_resumed'), '')
        LIMIT 1`
    )
    .get(task.id, task.id);
  if (open) return; // already parked on this limit window; stay quiet
  const resumeAt = parseResetClock(excerpt, Date.now()) ?? new Date(Date.now() + 60 * 60 * 1000).toISOString();
  writeEvent(db, {
    task_id: task.id,
    source: "reconciler",
    type: "usage_limit",
    payload: { resume_at: resumeAt, excerpt: excerpt.slice(0, 300) },
  });
}

// The wake-up half: once a parked task's resume_at passes, queue a steer (the
// drain/respawn machinery delivers it) and mark the window resumed. A session
// answers normally again after its reset — observed live, task #105.
export function resumeUsageLimited(db: DB, nowMs: number = Date.now()): void {
  const rows = db
    .query(
      `SELECT e.task_id, MAX(e.ts) AS ts, json_extract(e.payload, '$.resume_at') AS resume_at
         FROM events e JOIN tasks t ON t.id = e.task_id
        WHERE e.type = 'usage_limit' AND t.state IN ('in_progress', 'needs_decision')
          AND e.ts > COALESCE((SELECT MAX(ts) FROM events WHERE task_id = e.task_id AND type = 'usage_limit_resumed'), '')
        GROUP BY e.task_id`
    )
    .all() as { task_id: string; resume_at: string | null }[];
  for (const r of rows) {
    if (!r.resume_at || Date.parse(r.resume_at) > nowMs) continue;
    queueSteerEvent(
      db,
      r.task_id,
      "Your usage-limit window has reset — you are unblocked. Re-read your last few steps, emit a status note, and continue the task.",
      "queued by usage-limit resume"
    );
    writeEvent(db, { task_id: r.task_id, source: "reconciler", type: "usage_limit_resumed", payload: { resume_at: r.resume_at } });
  }
}

async function recoverSilent(db: DB, h: Herdr, taskId: string, target: string): Promise<void> {
  const task = getTask(db, taskId);
  if (!task || TERMINAL.includes(task.state as State)) return;

  // Diagnose BEFORE nudging: the pane usually names the problem, and each
  // class has a graceful path. Nudge→fail is only for the truly unexplained.
  const tail = await h.read(target, 200);
  const diag = diagnosePane(tail);
  if (diag?.kind === "blocked_dialog") return handleBlockedAgent(db, h, taskId, target);
  if (diag?.kind === "auth_lost") return recoverAuthLost(db, task, diag.excerpt, tail);
  if (diag?.kind === "context_full") return recoverContextFull(db, task, tail);
  if (diag?.kind === "usage_limit") return recoverUsageLimit(db, task, diag.excerpt);
  if (diag?.kind === "api_error") {
    // Transient (rate limit / network / overload): extend patience instead of
    // burning a nudge — this event resets the silence clock for one threshold.
    writeEvent(db, {
      task_id: taskId,
      source: "reconciler",
      type: "recovery",
      payload: { decision: "transient-api-error", excerpt: diag.excerpt.slice(0, 300) },
    });
    return;
  }

  const nudges = nudgesSinceActivity(db, taskId);
  if (nudges >= MAX_SILENT_NUDGES) {
    attachLog(db, taskId, tail, "agent pane tail at silent-escalation");
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

// ---- blocked-signal handler (herdr status -> immediate reaction) ----
// Called the moment syncAgents observes an agent flip to `blocked` (60s worst
// case), and again from recoverSilent as the backstop. Known-safe dialogs
// (read-only MCP tools + project config.dialog_auto_approve patterns) are
// answered automatically with "2" (yes, don't ask again in this worktree) so
// the same tool never re-prompts; everything else opens the answerable card.
export async function handleBlockedAgent(db: DB, h: Herdr, taskId: string, target: string): Promise<void> {
  const task = getTask(db, taskId);
  if (!task || TERMINAL.includes(task.state as State)) return;
  const tail = await h.read(target, 200);
  const diag = diagnosePane(tail);
  if (diag?.kind === "auto_mode_setup") {
    const r = await h.answerDialog(target, "Escape");
    writeEvent(db, {
      task_id: taskId,
      source: "reconciler",
      type: "dialog_auto_declined",
      payload: { delivered: r.code === 0, kind: "auto_mode_setup", excerpt: diag.excerpt.slice(0, 300) },
    });
    return;
  }
  if (diag?.kind === "trust_dialog") {
    const r = await h.answerDialog(target, "1");
    writeEvent(db, {
      task_id: taskId,
      source: "reconciler",
      type: "dialog_auto_approved",
      payload: { delivered: r.code === 0, kind: "workspace_trust", excerpt: diag.excerpt.slice(0, 300) },
    });
    return;
  }
  if (diag?.kind !== "blocked_dialog") return; // blocked but no visible dialog: leave to the silent path

  const project = db.query("SELECT config FROM projects WHERE id = ?").get(task.project_id) as { config: string } | undefined;
  let extra: string[] = [];
  try {
    extra = JSON.parse(project?.config ?? "{}").dialog_auto_approve ?? [];
  } catch {
    /* bad config never breaks recovery */
  }

  if (dialogAutoApprovable(diag.excerpt, extra)) {
    const r = await h.answerDialog(target, "2");
    writeEvent(db, {
      task_id: taskId,
      source: "reconciler",
      type: "dialog_auto_approved",
      payload: { delivered: r.code === 0, excerpt: diag.excerpt.slice(0, 300) },
    });
    return;
  }
  await recoverBlockedDialog(db, task, diag.excerpt, tail);
}

// ---- graceful failure-class handlers (pane-diagnosed) ----

// A dialog froze the agent: open ONE answerable card (approve/deny resolve by
// sending the keystroke to the pane — resolveBlockedForDecision in api.ts).
// The task parks in needs_decision instead of rotting to failed.
async function recoverBlockedDialog(db: DB, task: any, excerpt: string, tail: string): Promise<void> {
  const open = db
    .query("SELECT 1 FROM decisions WHERE task_id = ? AND status = 'open' AND title LIKE 'Agent blocked on a dialog%' LIMIT 1")
    .get(task.id);
  if (open) return; // card already waiting — don't spam
  attachLog(db, task.id, tail, "agent pane tail: blocked on a dialog");
  const firstLine = excerpt.split("\n").find((l) => l.trim()) ?? "permission prompt";
  const d = createDecision(db, {
    task_id: task.id,
    title: `Agent blocked on a dialog: ${firstLine.trim().slice(0, 70)}`,
    context:
      `The agent's pane is frozen on an interactive prompt. Answering here sends the keystroke to the pane remotely.\n\n${excerpt}`,
    risk: "medium",
    blast_radius: `agent ${task.agent_target} (task #${task.number})`,
    options: [
      { key: "approve", label: "Approve (option 1)", detail: "Send '1' + Enter to the pane; the agent continues." },
      { key: "deny", label: "Deny (option 3)", detail: "Send '3' + Enter; the agent is told no and adapts." },
    ],
  });
  writeEvent(db, { task_id: task.id, source: "reconciler", type: "blocked_card", payload: { decision_id: d.id } });
  // Re-read: createDecision may already have parked the task, and a redundant
  // transition throws (crashed the sync loop 2026-07-11).
  const fresh = getTask(db, task.id);
  if (fresh?.state === "in_progress")
    transition(db, task.id, "needs_decision", { source: "reconciler", reason: "agent blocked on an interactive dialog" });
  enqueue(db, { kind: "decision", task_id: task.id, decision_id: d.id, title: `Agent blocked on a dialog: ${task.title}`, urgency: "urgent" });
}

// Claude Code lost auth: failing or requeuing is pointless (a fresh agent hits
// the same wall). Urgent-notify the director once per hour and wait.
async function recoverAuthLost(db: DB, task: any, excerpt: string, tail: string): Promise<void> {
  writeEvent(db, { task_id: task.id, source: "reconciler", type: "recovery", payload: { decision: "auth-lost", excerpt: excerpt.slice(0, 300) } });
  const recent = db
    .query("SELECT 1 FROM notifications WHERE kind = 'auth_lost' AND ts > datetime('now', '-60 minutes') LIMIT 1")
    .get();
  if (recent) return;
  attachLog(db, task.id, tail, "agent pane tail: Claude Code auth lost");
  enqueue(db, {
    kind: "auth_lost",
    task_id: task.id,
    title: "Claude Code auth expired — agents cannot work",
    body: "An agent pane shows 'Not logged in'. Run /login in any Claude Code session (or fix credentials); affected agents resume on their own.",
    urgency: "urgent",
  });
  recordSystemLearning(db, task.project_id, "Claude Code auth expired mid-fleet", "Agents stall with 'Not logged in · Please run /login'. Fix auth once; do not requeue (a fresh agent hits the same wall).", task.id);
}

// Context window exhausted: the ONE case where auto-requeue is exactly right —
// a fresh agent gets a fresh context. Capped by MAX_AUTO_REQUEUE like death.
async function recoverContextFull(db: DB, task: any, tail: string): Promise<void> {
  attachLog(db, task.id, tail, "agent pane tail: context window exhausted");
  const attempts = requeueDepth(db, task);
  writeEvent(db, { task_id: task.id, source: "reconciler", type: "recovery", payload: { decision: "context-full", attempts } });
  transition(db, task.id, "failed", { source: "reconciler", reason: "context window exhausted" });
  if (attempts >= MAX_AUTO_REQUEUE) {
    openRecoveryDecision(db, task, attempts);
    enqueue(db, { kind: "failed", task_id: task.id, title: `Context exhausted repeatedly — task may be too big: ${task.title}` });
    recordSystemLearning(db, task.project_id, "task repeatedly exhausts the context window (too big?)", `Task: ${task.title} — consider splitting it.`, task.id);
  } else {
    const fresh = requeueTask(db, task);
    writeEvent(db, { task_id: task.id, source: "reconciler", type: "requeued", payload: { new_task_id: fresh, attempt: attempts + 1, reason: "context-full" } });
    enqueue(db, { kind: "failed", task_id: task.id, title: `Context exhausted — requeued with fresh context: ${task.title}` });
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
