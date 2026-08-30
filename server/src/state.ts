// Task state machine + event writing. Server-enforced per SPEC.md.
//
// queued -> in_progress -> (needs_decision <-> in_progress|queued) -> in_review
//        -> verifying -> done
// Any non-terminal state -> failed | cancelled (with a reason event).
// Transition to `done` is REJECTED unless >= 1 evidence row exists
// (scouts additionally require an evidence row of kind = 'report').
import { execSync } from "node:child_process";
import type { DB } from "./db.ts";
import { newId, now } from "./db.ts";
import { broadcast } from "./bus.ts";
import { parseEvent, parseTask, parseDecision } from "./rows.ts";
import { redact } from "./secrets.ts";
import { enqueue } from "./notifications.ts";
import { broadcastTask } from "./health.ts";
import { isTrackingOnlyTask, isJiraMirror } from "./supervision.ts";
import { explanationGate } from "./explainDiff.ts";

export const STATES = [
  "queued",
  "in_progress",
  "needs_decision",
  "in_review",
  "verifying",
  "done",
  "failed",
  "cancelled",
] as const;
export type State = (typeof STATES)[number];

export const TERMINAL: State[] = ["done", "failed", "cancelled"];

// Defined in supervision.ts (one definition, derived from isExternalTask).
// Re-exported here because the existing callers import it from state.
export { isTrackingOnlyTask };

export function queueJiraCancellationComment(db: DB, taskId: string, source: string): void {
  const queued = db.query(
    `SELECT 1 FROM events WHERE task_id = ? AND type = 'jira_comment'
       AND json_extract(payload, '$.linked_cancelled') = 1 LIMIT 1`
  ).get(taskId);
  if (queued) return;
  writeEvent(db, {
    task_id: taskId,
    source,
    type: "jira_comment",
    payload: { direction: "outbound", linked_cancelled: true, text: "Hive marked this task cancelled." },
  });
}

export const TRACKING_ONLY_REQUEUE_ERROR = "a mirrored Jira task has no agent work to requeue";
export const TRACKING_ONLY_OWNERSHIP_ERROR = "tracking-only tasks cannot create Hive-owned agent work";

// Allowed "forward" transitions. failed/cancelled are handled separately
// because they are reachable from any non-terminal state.
const FORWARD: Record<State, State[]> = {
  // queued -> needs_decision lets the director park a task that is ambiguous
  // before any agent even starts (e.g. a Jira mirror born unscopable, hive-1264
  // gap A): the needs_decision label rides on top without an agent-raised
  // decision card. needs_decision -> queued is the matching way back, so
  // clearing it never has to fake an in_progress a queued task never had.
  queued: ["in_progress", "needs_decision"],
  in_progress: ["needs_decision", "in_review"],
  needs_decision: ["in_progress", "queued"],
  in_review: ["verifying", "in_progress"], // in_progress = captain requested changes

  verifying: ["done", "in_progress"], // failed smoke checks bounce back
  done: [],
  failed: ["queued"], // re-queue a failed task for another attempt (attention tray)
  cancelled: [],
};

export class TransitionError extends Error {}

// Fired after a task reaches an unambiguously-final state (done / cancelled) so
// the server can auto-tear-down its worktree + herdr session. Kept as an
// injected hook (set only in production wiring, index.ts) so state.ts stays free
// of the herdr/subprocess dependency and tests transition without side effects.
// NOT fired for `failed`: a failed task may still be auto-requeued/retried, and
// its worktree is handled by the recovery path + the reaper backstop.
type TerminalHook = (db: DB, taskId: string, to: State) => void;
let terminalHook: TerminalHook | null = null;
export function setTerminalHook(fn: TerminalHook | null): void {
  terminalHook = fn;
}

// Fired for every durable task event. Production uses this to wake the chat
// supervisor when one of its workers reaches a meaningful milestone; tests
// leave it unset so event writes stay side-effect free.
type EventHook = (db: DB, event: any) => void;
let eventHook: EventHook | null = null;
export function setEventHook(fn: EventHook | null): void {
  eventHook = fn;
}

// Accepts a task id or a task NUMBER. Ids win: they are 12 hex characters, so a
// small number can never collide with one that exists. This is what makes
// hive://task/1247 and /tasks/1247 resolve the way a human writes them.
export function getTask(db: DB, id: string): any | null {
  const r =
    db.query("SELECT * FROM tasks WHERE id = ?").get(id) ??
    (/^\d{1,9}$/.test(id) ? db.query("SELECT * FROM tasks WHERE number = ?").get(Number(id)) : null);
  return r ? parseTask(r) : null;
}

// A dependency is "met" once its code has landed: PR merged (verifying) or
// fully done. Every other state — still queued/working/in review, or failed/
// cancelled — blocks the dependent. Returns the blocking dep rows (id, number,
// title, state) so callers can name them in a visible 'blocked by task X'.
const DEP_MET_STATES = ["verifying", "done"];
export function unmetDeps(db: DB, task: { depends_on?: string[] } | null | undefined): { id: string; number: number; title: string; state: string }[] {
  const ids = task?.depends_on ?? [];
  if (!ids.length) return [];
  const blocking: { id: string; number: number; title: string; state: string }[] = [];
  for (const id of ids) {
    const dep = db.query("SELECT id, number, title, state FROM tasks WHERE id = ?").get(id) as
      | { id: string; number: number; title: string; state: string }
      | undefined;
    // A vanished dependency can never be met, so it stays blocking (visible).
    if (!dep || !DEP_MET_STATES.includes(dep.state)) blocking.push(dep ?? { id, number: 0, title: "(unknown task)", state: "missing" });
  }
  return blocking;
}

function activeDependents(db: DB, dependencyId: string): any[] {
  return (db
    .query("SELECT * FROM tasks WHERE depends_on IS NOT NULL AND state NOT IN ('done','failed','cancelled')")
    .all() as any[])
    .map(parseTask)
    .filter((task) => task.depends_on.includes(dependencyId));
}

export function dependsTransitivelyOn(db: DB, taskId: string, dependencyId: string): boolean {
  const pending = [taskId];
  const seen = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!;
    if (id === dependencyId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    pending.push(...(getTask(db, id)?.depends_on ?? []));
  }
  return false;
}

export function repointDependents(db: DB, fromId: string, toId: string, source = "system"): string[] {
  const changed: string[] = [];
  for (const task of activeDependents(db, fromId)) {
    if (task.id !== toId && dependsTransitivelyOn(db, toId, task.id)) {
      writeEvent(db, {
        task_id: task.id,
        source,
        type: "dependency_repoint_skipped",
        payload: {
          note: `Dependency on ${fromId} was not repointed to ${toId} because that would create a cycle.`,
          from_task_id: fromId,
          to_task_id: toId,
          reason: "dependency cycle",
        },
      });
      broadcastTask(db, getTask(db, task.id));
      continue;
    }
    const dependsOn = [...new Set(task.depends_on.map((id: string) => id === fromId ? toId : id))]
      .filter((id) => id !== task.id);
    db.query("UPDATE tasks SET depends_on = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(dependsOn), now(), task.id);
    writeEvent(db, {
      task_id: task.id,
      source,
      type: "dependency_repointed",
      payload: { from_task_id: fromId, to_task_id: toId },
    });
    broadcastTask(db, getTask(db, task.id));
    changed.push(task.id);
  }
  return changed;
}

export function dependentsWedgedForDecision(db: DB, decisionId: string): { cancelledTaskId: string; dependentTaskIds: string[] } | null {
  const event = db.query(
    "SELECT task_id, payload FROM events WHERE type = 'dependents_wedged' AND json_extract(payload, '$.decision_id') = ? ORDER BY ts DESC LIMIT 1"
  ).get(decisionId) as { task_id: string; payload: string } | undefined;
  if (!event) return null;
  return { cancelledTaskId: event.task_id, dependentTaskIds: JSON.parse(event.payload).dependent_task_ids ?? [] };
}

export function resolveDependentsWedgedForDecision(
  db: DB,
  decisionId: string,
  answerKey: string,
  successorId: string | null,
  source: string
): boolean {
  const marker = dependentsWedgedForDecision(db, decisionId);
  if (!marker) return false;
  if (answerKey === "repoint" && successorId) {
    repointDependents(db, marker.cancelledTaskId, successorId, source);
  } else if (answerKey === "cancel") {
    for (const id of marker.dependentTaskIds) {
      const task = getTask(db, id);
      if (task && canTransition(task.state, "cancelled"))
        transition(db, id, "cancelled", { source, reason: `dependency ${marker.cancelledTaskId} was cancelled` });
    }
  }
  return true;
}

function openCancelledDependencyDecision(db: DB, cancelled: any, source: string): void {
  const dependents = activeDependents(db, cancelled.id);
  if (!dependents.length) return;
  const host = dependents[0];
  const affected = dependents.map((task) => `#${task.number} ${task.title} (${task.id})`);
  const row = {
    id: newId("dec"),
    task_id: host.id,
    ts: now(),
    title: `Resolve dependencies on cancelled task #${cancelled.number}`,
    context: `Task #${cancelled.number} ${cancelled.title} was cancelled. These tasks still depend on it and cannot proceed: ${affected.join(", ")}. Repoint them to a successor or cancel them. For repoint, enter the successor task ID in the answer note.`,
    risk: "normal",
    blast_radius: affected.join(", "),
    options: JSON.stringify([
      { key: "repoint", label: "Repoint dependencies", detail: "Enter the successor task ID in the answer note, then update the listed tasks to depend on it.", recommended: true },
      { key: "cancel", label: "Cancel dependents", detail: "Cancel the listed tasks if their work is no longer needed." },
    ]),
    status: "open",
    answer_key: null,
    answer_note: null,
    draft_note: null,
    answered_at: null,
    ci_status_at_card: null,
    ci_signal: null,
  };
  db.query(
    `INSERT INTO decisions (id, task_id, ts, title, context, risk, blast_radius,
      options, status, answer_key, answer_note, draft_note, answered_at, ci_status_at_card, ci_signal)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    row.id, row.task_id, row.ts, row.title, row.context, row.risk,
    row.blast_radius, row.options, row.status, row.answer_key, row.answer_note,
    row.draft_note, row.answered_at, row.ci_status_at_card, row.ci_signal
  );
  writeEvent(db, { task_id: host.id, source, type: "needs-decision", payload: { decision_id: row.id, title: row.title } });
  writeEvent(db, {
    task_id: cancelled.id,
    source,
    type: "dependents_wedged",
    payload: { decision_id: row.id, dependent_task_ids: dependents.map((task) => task.id) },
  });
  broadcast({ type: "decision", decision: parseDecision(row) });
  enqueue(db, {
    kind: "decision",
    urgency: "urgent",
    task_id: host.id,
    decision_id: row.id,
    title: `Decision needed: ${row.title}`,
    body: row.context,
  });
}

// Record a visible 'blocked by task X' — but only when the blocking set changed
// since the last such event, so a 30s dispatch loop doesn't spam the timeline.
// Mirrors the dedup discipline of nudgeConflict/ci_failure in the reconciler.
export function noteDependencyBlock(
  db: DB,
  taskId: string,
  blocking: { number: number; title: string }[],
  source: string
): void {
  const blocked_by = blocking.map((b) => `#${b.number} ${b.title}`);
  const note = `blocked by ${blocked_by.join(", ")}`;
  const last = db
    .query("SELECT payload FROM events WHERE task_id = ? AND type = 'dependency_blocked' ORDER BY ts DESC LIMIT 1")
    .get(taskId) as { payload: string } | undefined;
  if (last) {
    try {
      if (JSON.parse(last.payload).note === note) return; // same blockers already surfaced
    } catch {}
  }
  writeEvent(db, { task_id: taskId, source, type: "dependency_blocked", payload: { note, blocked_by } });
  broadcastTask(db, getTask(db, taskId));
}

// Why the dispatcher skipped a queued task, and whether that answer can change
// on its own. "not yet" = the task is waiting for something that normally
// arrives (capacity, a blocker finishing, your review). "not ever" = nothing
// will change until a human changes a setting or the task itself — those are
// the ones that used to sit in `queued` looking healthy for days (HIVE-525).
export const SKIP_REASONS: Record<string, { label: string; permanent: boolean }> = {
  no_repo_path: { label: "project has no repo path", permanent: true },
  gardener_decision: { label: "PR gardener decision card, not agent work", permanent: true },
  gardener_disabled: { label: "PR gardener is off for this project", permanent: true },
  auto_dispatch_off: { label: "auto-dispatch is off for this project", permanent: true },
  kind_excluded: { label: "kind is not in the project's dispatch_kinds", permanent: true },
  tracking_only: { label: "tracking-only task — never dispatched", permanent: true },
  authority_denied: { label: "an authority rule denies task.dispatch", permanent: true },
  intake_unreviewed: { label: "unreviewed intake — waiting on your review", permanent: false },
  triage_hold: { label: "waiting on your intake triage answer", permanent: false },
  repo_mismatch: { label: "brief targets another project's repo", permanent: false },
  dependency_blocked: { label: "blocked by unfinished dependencies", permanent: false },
  authority_decision: { label: "waiting on a dispatch decision card", permanent: false },
  no_capacity: { label: "at the project's max_agents cap", permanent: false },
  spawn_backoff: { label: "cooling down after a spawn failure", permanent: false },
};

// Record (or clear) why a queued task was skipped. Writes ONLY when the reason
// changed, so the 30s dispatch loop costs one UPDATE per transition and can
// never flood — the same discipline noteDependencyBlock uses for its event.
// Deliberately a task FIELD and not an event: a steady-state queue would
// otherwise mint one row per task per cycle (HIVE-515 burned 485k rows that way).
export function noteSkip(db: DB, taskId: string, reason: string | null): void {
  const cur = db.query("SELECT skip_reason FROM tasks WHERE id = ?").get(taskId) as { skip_reason: string | null } | undefined;
  if (!cur || (cur.skip_reason ?? null) === reason) return;
  db.query("UPDATE tasks SET skip_reason = ?, skip_reason_at = ? WHERE id = ?").run(reason, reason ? now() : null, taskId);
  broadcastTask(db, getTask(db, taskId));
}

// A task deferred pending an OFFLINE human action (e.g. sudo). It stays
// in_progress, but the stale/nudge machinery skips it while deferred_until is in
// the future — that is what stops the endless "gone quiet" nudges (task #329
// replied 9× to the same nudge). Far-future timestamp = indefinite; a real date
// = auto-resume then.
export function isDeferred(
  task: { deferred_until?: string | null } | null | undefined,
  nowMs: number = Date.now()
): boolean {
  const until = task?.deferred_until;
  return !!until && Date.parse(until) > nowMs;
}

export function deferTask(
  db: DB,
  taskId: string,
  until: string,
  opts: { source?: string; note?: string } = {}
): any {
  db.query("UPDATE tasks SET deferred_until = ?, updated_at = ? WHERE id = ?").run(until, now(), taskId);
  writeEvent(db, { task_id: taskId, source: opts.source ?? "agent", type: "deferred", payload: { until, note: opts.note ?? null } });
  const t = getTask(db, taskId);
  broadcastTask(db, t);
  return t;
}

export function undeferTask(db: DB, taskId: string, opts: { source?: string; note?: string } = {}): any {
  db.query("UPDATE tasks SET deferred_until = NULL, updated_at = ? WHERE id = ?").run(now(), taskId);
  writeEvent(db, { task_id: taskId, source: opts.source ?? "director", type: "undeferred", payload: { note: opts.note ?? null } });
  const t = getTask(db, taskId);
  broadcastTask(db, t);
  return t;
}

export function canTransition(from: State, to: State): boolean {
  if (!STATES.includes(to)) return false;
  if (to === "failed") return !TERMINAL.includes(from);
  // A failed task can be dismissed to cancelled from the attention tray; any
  // other non-terminal state can be cancelled too. done/cancelled cannot.
  if (to === "cancelled") return from !== "done" && from !== "cancelled";
  return FORWARD[from]?.includes(to) ?? false;
}

export function evidenceCount(db: DB, taskId: string, kind?: string): number {
  const sql = kind
    ? "SELECT COUNT(*) AS n FROM evidence WHERE task_id = ? AND kind = ?"
    : "SELECT COUNT(*) AS n FROM evidence WHERE task_id = ?";
  const row = kind
    ? db.query(sql).get(taskId, kind)
    : db.query(sql).get(taskId);
  return (row as { n: number }).n;
}

// Count evidence captured from a specific commit SHA (stamped into meta.commit_sha
// when the agent emits it). Drives the freshness gate: the evidence the director
// sees must reflect the latest commit, so a handoff after new commits requires
// re-captured evidence tied to the current HEAD (the #223 stale-screenshot bug).
export function evidenceAtSha(db: DB, taskId: string, sha: string): number {
  const row = db
    .query("SELECT COUNT(*) AS n FROM evidence WHERE task_id = ? AND json_extract(meta, '$.commit_sha') = ?")
    .get(taskId, sha);
  return (row as { n: number }).n;
}

function insertEvent(
  db: DB,
  args: { task_id: string; source: string; type: string; payload?: unknown }
): any {
  const row = {
    id: newId("evt"),
    task_id: args.task_id,
    ts: now(),
    source: args.source,
    type: args.type,
    payload: JSON.stringify(redact(args.payload ?? {})),
  };
  db.query(
    "INSERT INTO events (id, task_id, ts, source, type, payload) VALUES (?,?,?,?,?,?)"
  ).run(row.id, row.task_id, row.ts, row.source, row.type, row.payload);
  return parseEvent(row);
}

function publishEvent(db: DB, event: any): void {
  broadcast({ type: "event", event });
  if (eventHook) {
    try {
      eventHook(db, event);
    } catch (e) {
      console.error("[hive] event hook:", e);
    }
  }
}

// Write an append-only event row and broadcast it. Returns the parsed event.
export function writeEvent(
  db: DB,
  args: { task_id: string; source: string; type: string; payload?: unknown }
): any {
  const event = insertEvent(db, args);
  publishEvent(db, event);
  return event;
}

export function mutateWithEvent<T>(
  db: DB,
  mutate: () => T,
  args: { task_id: string; source: string; type: string; payload?: unknown }
): T {
  const [result, event] = db.transaction(() => [mutate(), insertEvent(db, args)] as const)();
  publishEvent(db, event);
  return result;
}

// Expire every still-open decision on a task: its options can no longer be
// acted on once the task is terminal, and an orphaned open card sits forever in
// the inbox. Writes a decision_expired event and broadcasts the expired card so
// the inbox clears live over SSE. Idempotent (only touches status='open' rows).
export function expireOpenDecisions(db: DB, taskId: string, reason: string): number {
  const rows = db.query("SELECT * FROM decisions WHERE task_id = ? AND status = 'open'").all(taskId) as any[];
  for (const r of rows) {
    db.query("UPDATE decisions SET status = 'expired' WHERE id = ?").run(r.id);
    writeEvent(db, { task_id: taskId, source: "system", type: "decision_expired", payload: { decision_id: r.id, reason } });
    broadcast({ type: "decision", decision: parseDecision({ ...r, status: "expired" }) });
  }
  return rows.length;
}

// Backfill/backstop: expire open decisions whose task is already terminal
// (legacy orphans created before transition-time expiry existed). Idempotent —
// safe to call on every startup.
export function expireOrphanedDecisions(db: DB): number {
  const tasks = db
    .query(
      `SELECT DISTINCT d.task_id AS task_id FROM decisions d JOIN tasks t ON t.id = d.task_id
       WHERE d.status = 'open' AND t.state IN ('done','failed','cancelled')`
    )
    .all() as { task_id: string }[];
  let n = 0;
  for (const t of tasks) n += expireOpenDecisions(db, t.task_id, "task terminal (backfill)");
  return n;
}

// A requeue's parent_task_id is trusted only if it was created through
// requeueTask's own insert+event pair (api.ts): a 'created' event from
// source='reconciler' whose payload.requeue_of names this row's parent, and
// that parent still exists in the same project. Anything else — a
// hand-inserted row, a rewritten/missing creation event, a cross-project
// parent — is untrusted lineage a recovery path must not follow.
function trustedRequeueParent(db: DB, task: any): boolean {
  if (!task.parent_task_id) return false;
  const parent = getTask(db, task.parent_task_id);
  if (!parent || parent.project_id !== task.project_id) return false;
  return Boolean(
    db
      .query(
        `SELECT 1 FROM events WHERE task_id = ? AND type = 'created' AND source = 'reconciler'
           AND json_valid(payload) AND json_extract(payload, '$.requeue_of') = ? LIMIT 1`
      )
      .get(task.id, task.parent_task_id)
  );
}

export function isSelfAuditLineage(db: DB, task: any | null): boolean {
  const seen = new Set<string>();
  let current = task;
  while (current && !seen.has(current.id)) {
    if (current.source === "self-audit") return true;
    if (current.source !== "requeue" || !trustedRequeueParent(db, current)) return false;
    seen.add(current.id);
    current = getTask(db, current.parent_task_id);
  }
  return false;
}

// Verify (or quarantine) one requeue task's provenance. Idempotent: a
// verified row is marked once (requeue_provenance_verified=1) so the indexed
// sweep below never rechecks it. An unverifiable row is detached from its
// claimed lineage — source flips to 'requeue_quarantined' so nothing
// downstream ever again treats its parent chain as trusted recovery context
// — but the task itself stays queued and dispatchable as ordinary work.
export function verifyRequeueProvenance(db: DB, task: any | null): any | null {
  if (!task || task.source !== "requeue") return task;
  if (trustedRequeueParent(db, task)) {
    if (!task.requeue_provenance_verified) {
      db.query("UPDATE tasks SET requeue_provenance_verified = 1 WHERE id = ?").run(task.id);
      return getTask(db, task.id);
    }
    return task;
  }
  db.transaction(() => {
    db.query(
      `UPDATE tasks SET source = 'requeue_quarantined', parent_task_id = NULL, requeue_provenance_verified = 1, updated_at = ? WHERE id = ?`
    ).run(now(), task.id);
    writeEvent(db, {
      task_id: task.id,
      source: "system",
      type: "requeue_provenance_rejected",
      payload: { parent_task_id: task.parent_task_id ?? null },
    });
  })();
  const updated = getTask(db, task.id);
  broadcastTask(db, updated);
  return updated;
}

// Startup/reconciliation sweep. The partial index (db.ts:
// idx_tasks_unverified_requeue) means this only ever scans rows a prior sweep
// has not yet resolved — never every historical source='requeue' task —
// and a verified or quarantined row is never rechecked. Fails closed: if
// checking a row throws, it is left unverified (picked up again next cycle)
// rather than assumed trustworthy. Idempotent — safe on every startup and
// every reconciler cycle.
export function repairRequeueProvenance(db: DB): number {
  const rows = db
    .query(
      "SELECT id FROM tasks INDEXED BY idx_tasks_unverified_requeue WHERE source = 'requeue' AND requeue_provenance_verified = 0"
    )
    .all() as { id: string }[];
  let quarantined = 0;
  for (const row of rows) {
    const task = getTask(db, row.id);
    if (!task) continue;
    try {
      const trusted = trustedRequeueParent(db, task);
      verifyRequeueProvenance(db, task);
      if (!trusted) quarantined++;
    } catch (e) {
      console.error(`[state] requeue provenance check failed for ${row.id}: ${String((e as any)?.message ?? e)}`);
    }
  }
  return quarantined;
}

// The one guard against re-queuing a PR whose latest review verdict is "changes
// requested" before the agent has actually acted (#163, #234). Returns true =
// still unaddressed = DON'T insert into the review queue. "Addressed" means
// something new landed after the latest changes_requested: a new commit pushed
// (the reconciler's `pr_synchronized` event — hive's stand-in for GitHub's
// synchronize webhook), fresh evidence, or a fresh review_summary. Any of the
// three clears the block. Callers apply this at every point that inserts into
// the queue (the idle backstop here, and handOffToReview for the reconciler/
// link-pr paths), so a bare CI-green poll can no longer bounce a task the
// director just sent back straight into review with no new work on it.
export function changesRequestUnaddressed(db: DB, taskId: string): boolean {
  const cr: any = db
    .query("SELECT ts, payload FROM events WHERE task_id = ? AND type = 'changes_requested' ORDER BY ts DESC LIMIT 1")
    .get(taskId);
  if (!cr?.ts) return false; // never sent back → nothing to guard
  // Evidence-only / review_summary path: a changes_requested can be evidence-only
  // (#163), so either of these after the request clears the block immediately.
  const nonCommit = db
    .query(
      `SELECT 1 FROM events WHERE task_id = ? AND type = 'review_summary' AND ts > ?
       UNION SELECT 1 FROM evidence WHERE task_id = ? AND ts > ? LIMIT 1`
    )
    .get(taskId, cr.ts, taskId, cr.ts);
  if (nonCommit) return false;
  // Commit signal: the baseline is the head SHA at request time (stamped into the
  // changes_requested payload; null when no pr_synchronized existed yet). A
  // pr_synchronized on the SAME head — or the first post-request observation when
  // the head was unknown — is NOT new work; only a later DIFFERENT head is.
  let baseline: string | null = null;
  try {
    baseline = JSON.parse(cr.payload ?? "{}").head_sha ?? null;
  } catch {
    baseline = null;
  }
  const syncs = db
    .query("SELECT payload FROM events WHERE task_id = ? AND type = 'pr_synchronized' AND ts > ? ORDER BY ts ASC")
    .all(taskId, cr.ts) as { payload: string }[];
  for (const s of syncs) {
    let sha: string | null = null;
    try {
      sha = JSON.parse(s.payload).head_sha ?? null;
    } catch {
      sha = null;
    }
    if (baseline === null) {
      baseline = sha; // first observation when head-at-request was unknown
      continue;
    }
    if (sha !== null && sha !== baseline) return false; // genuinely new commit → addressed
  }
  return true; // still unaddressed
}

// A director answer can invalidate the report and its quiz. Never hand the
// task back for review until the agent has summarized the answer's effect.
export function decisionAnswerUnaddressed(db: DB, taskId: string): boolean {
  const answer = db.query("SELECT rowid FROM events WHERE task_id = ? AND type = 'decision_answered' ORDER BY rowid DESC LIMIT 1").get(taskId) as { rowid: number } | undefined;
  if (!answer) return false;
  const review = db.query("SELECT rowid FROM events WHERE task_id = ? AND type = 'review_summary' ORDER BY rowid DESC LIMIT 1").get(taskId) as { rowid: number } | undefined;
  return !review || review.rowid < answer.rowid;
}

const QUEUED_INPUT_HANDOFF_GRACE_MS = 2 * 60 * 1000;

// True while a queued-input recovery (reconciler.ts's recoverQueuedInput, task
// #1098) means an automatic transition should hold off this task: the pane
// write is recent enough that the redelivered turn may not have started yet
// (this same short window also covers an in-flight `delivered: null`
// reservation, including one orphaned by a server crash mid-write — #1234
// review-14 — since it ages out instead of blocking forever), or the recovery
// escalated to an unresolved `queued_input_stuck` alert with no real activity
// on the task since (#1234 review-13 — cheaper and more accurate than the
// flat grace window alone, which could let a still-stuck task advance once the
// window passed, or hold a resolved one).
//
// Shared by every automatic transition that can act on a task mid-recovery:
// advanceIfFinished below (the reconciler's advanceFinished + api.ts's
// superviseAgent), handOffToReview, autoMergeReady, and releaseReviewAgent
// (#1234 review-12 — the guard used to cover only the first two).
export function queuedInputRecoveryPending(db: DB, taskId: string): boolean {
  const latest = db
    .query("SELECT ts FROM events WHERE task_id = ? AND type = 'queued_input_recovered' ORDER BY ts DESC, rowid DESC LIMIT 1")
    .get(taskId) as { ts: string } | undefined;
  if (!latest) return false;
  if (Date.now() - Date.parse(latest.ts) < QUEUED_INPUT_HANDOFF_GRACE_MS) return true;
  const stuck = db
    .query("SELECT ts FROM notifications WHERE kind = 'queued_input_stuck' AND task_id = ? ORDER BY ts DESC LIMIT 1")
    .get(taskId) as { ts: string } | undefined;
  if (!stuck) return false;
  const movedOn = db
    .query(
      "SELECT 1 FROM events WHERE task_id = ? AND ts > ? AND type NOT IN ('queued_input_recovered','agent_status','stale') LIMIT 1"
    )
    .get(taskId, stuck.ts);
  return !movedOn;
}

// ---- HIVE-402: the verification contract, enforced at the review handoff ----

// The contract command names that still have no matching evidence. Empty when
// the task carries no contract, so tasks without one are never gated.
//
// Freshness: when the task's head commit is known, evidence must have been
// attached AFTER that commit landed — the same rule that already governs
// screenshots (#223), applied to test runs. The commit's arrival time is the
// first moment any event on the task recorded that head_sha; if nothing did,
// the name merely has to be present. The comparison is >= because event
// timestamps are millisecond strings: evidence attached in the same tick as the
// commit's own event is fresh, not stale.
export function missingVerifications(db: DB, task: any): string[] {
  return verificationChecklist(db, task)
    .filter((c) => !c.satisfied)
    .map((c) => c.name);
}

// The same contract, item by item, for anything that has to SHOW the gate
// rather than just enforce it (the review card's checklist, HIVE-403). Each
// entry carries the id of the freshest evidence that satisfies it, or null when
// nothing does — so "missing" on the card is the identical judgement the merge
// gate makes, not a second guess at it.
export function verificationChecklist(
  db: DB,
  task: any
): { name: string; cmd: string; satisfied: boolean; evidence_id: string | null }[] {
  const cmds = task?.verification_cmds;
  if (!Array.isArray(cmds) || cmds.length === 0) return [];
  let since = "";
  if (task.head_sha) {
    const r = db
      .query("SELECT MIN(ts) AS ts FROM events WHERE task_id = ? AND json_extract(payload, '$.head_sha') = ?")
      .get(task.id, task.head_sha) as { ts: string | null } | undefined;
    since = r?.ts ?? "";
  }
  const rows = db
    .query(
      `SELECT json_extract(payload, '$.verify_name') AS name, json_extract(payload, '$.evidence_id') AS evidence_id
         FROM events
        WHERE task_id = ? AND type = 'evidence'
          AND json_extract(payload, '$.verify_name') IS NOT NULL AND ts >= ?
        ORDER BY ts ASC, rowid ASC`
    )
    .all(task.id, since) as { name: string; evidence_id: string | null }[];
  const have = new Map<string, string | null>();
  for (const r of rows) have.set(r.name, r.evidence_id); // last write wins: freshest run
  return cmds.map((c: any) => {
    const name = String(c?.name ?? "");
    // `satisfied` is name-presence, exactly as the gate has always read it; the
    // evidence id is a convenience for linking and may be absent on old rows.
    return { name, cmd: String(c?.cmd ?? ""), satisfied: have.has(name), evidence_id: have.get(name) ?? null };
  });
}

// Same check, plus a `verification_missing` event the agent's next steer can
// cite. Deduped on the name set so the polling callers (the reconciler asks
// every cycle) log the gap once instead of forever.
export function verificationGate(db: DB, task: any, source: string): string[] {
  const missing = missingVerifications(db, task);
  if (missing.length === 0) return missing;
  const last = db
    .query("SELECT payload FROM events WHERE task_id = ? AND type = 'verification_missing' ORDER BY ts DESC LIMIT 1")
    .get(task.id) as { payload: string } | undefined;
  let same = false;
  if (last) {
    try {
      same = JSON.stringify(JSON.parse(last.payload).names) === JSON.stringify(missing);
    } catch {}
  }
  if (!same)
    writeEvent(db, { task_id: task.id, source, type: "verification_missing", payload: { names: missing } });
  return missing;
}

// The finished-handoff, shared by every herdr-signal path (the reconciler's
// poll backstop and the supervise wait loop): an agent observed idle/done/gone on an
// in_progress task that has a real work product (a pr_url, or a scout report)
// advances to in_review, except while a queued-input recovery is pending.
// Deliberately independent of anything the agent emits.
// Returns true when the task was advanced.
export function advanceIfFinished(db: DB, taskId: string, agentStatus: string, source: string): boolean {
  if (agentStatus !== "idle" && agentStatus !== "done" && agentStatus !== "gone") return false; // working/blocked/unknown → leave it be
  const task = getTask(db, taskId);
  if (!task || task.state !== "in_progress" || isTrackingOnlyTask(task)) return false;
  if (queuedInputRecoveryPending(db, taskId)) return false;
  const hasReport = task.kind === "scout" && evidenceCount(db, taskId, "report") >= 1;
  if (!task.pr_url && !hasReport) return false; // no product to review → health surfaces it, don't advance
  // A PR the reconciler last observed CLOSED (not merged) has nothing to
  // review — promoting anyway is a same-tick self-contradiction: syncPRs
  // would immediately bounce it back to in_progress, ping-ponging every
  // reconciler cycle and re-steering the agent each time (#1256).
  if (task.pr_url && task.pr_state === "CLOSED") return false;
  // Review means CI is green. failing/pending holds here; the reconciler's
  // syncPRs promotes the moment checks pass (and steers the agent on red).
  // null = no checks known (repo without CI) — that flows as before.
  if (task.pr_url && (task.ci_status === "failing" || task.ci_status === "pending")) return false;
  // The idle backstop must not hand the director an empty review: a PR with no
  // evidence isn't reviewable (the protocol says attach evidence BEFORE ready;
  // the agent's explicit `ready` emit is gated the same way elsewhere).
  if (!hasReport && evidenceCount(db, taskId) < 1) return false;
  // After a changes-request, mere idleness is NOT "addressed" (#163). Require
  // visible new work before re-advancing — the shared guard below.
  if (changesRequestUnaddressed(db, taskId)) return false;
  if (decisionAnswerUnaddressed(db, taskId)) return false;
  // #1249: no explanation page yet → hold here and let the generation (kicked
  // off by the gate) hand the task off when the page is stored.
  if (explanationGate(db, task) !== "ready") return false;
  // HIVE-402: a contract with nothing behind it isn't reviewable either.
  if (verificationGate(db, task, source).length > 0) return false;
  writeEvent(db, {
    task_id: taskId,
    source,
    type: "ready_for_review",
    payload: { pr_url: task.pr_url ?? null, via: agentStatus, kind: task.kind },
  });
  transition(db, taskId, "in_review", {
    source,
    reason: hasReport ? "scout report ready; agent idle" : "PR open; agent idle",
  });
  return true;
}

// Perform a state transition. Throws TransitionError on invalid transition or
// when a `done` transition lacks required evidence. Writes a state_change event.
// Some handoffs land the PR URL only as free text in the transition reason
// (e.g. `hive emit ready --note "PR <url>"` without `--pr-url`), so task.pr_url
// never gets set and auto_review has nothing to diff. Backfill from that text —
// but ONLY a PR in the project's own repo: the reason is prose an agent wrote,
// so it can legitimately mention some other PR ("blocked on <url>"), and
// backfilling that would point hive's review/land machinery at a foreign repo.
const PR_URL_RE = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+?)\/pull\/\d+/g;

const repoSlugCache = new Map<string, string | null>();
// ponytail: sync shell-out kept simple with an in-memory cache; fine at
// per-transition and startup-sweep call rates.
function repoSlugForPath(repoPath: string): string | null {
  if (repoSlugCache.has(repoPath)) return repoSlugCache.get(repoPath)!;
  let slug: string | null = null;
  try {
    const url = execSync("git remote get-url origin", { cwd: repoPath, encoding: "utf8" }).trim();
    slug = url.match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/)?.[1] ?? null;
  } catch {
    slug = null;
  }
  repoSlugCache.set(repoPath, slug);
  return slug;
}

// The project's own owner/repo, or null if it can't be determined (no
// repo_path, or the git remote lookup failed) — callers treat null as "can't
// verify" and refuse to backfill rather than guessing.
export function projectRepoSlug(db: DB, projectId: string): string | null {
  const project = db.query("SELECT repo_path FROM projects WHERE id = ?").get(projectId) as
    | { repo_path: string | null }
    | undefined;
  if (!project?.repo_path) return null;
  return repoSlugForPath(project.repo_path);
}

// Extracts a PR URL from free text, scoped to `allowedSlug` (owner/repo). If
// the text names more than one PR URL, the intended one is ambiguous — take
// NONE rather than guessing. If `allowedSlug` is omitted, any single match is
// accepted (used by the standalone unit test); real call sites always pass it.
export function extractPrUrl(text: string | null | undefined, allowedSlug?: string | null): string | null {
  if (!text) return null;
  const matches = [...text.matchAll(PR_URL_RE)];
  if (matches.length !== 1) return null;
  const [url, slug] = matches[0];
  if (allowedSlug !== undefined && slug !== allowedSlug) return null;
  return url;
}

// Reconciliation sweep for tasks that got stuck before the transition()-time
// backfill above existed: a task already sitting in in_review with pr_url
// still null, whose state_change reason carried the URL as free text.
// transition() can't fix these itself (it only runs on entry to in_review,
// and throws on from === to), so this scans the task's own event history
// instead. Idempotent — skips tasks that already have a pr_url. Startup-only
// (see index.ts): once history is repaired this can never find anything
// again, so running it every reconciler lap is a permanent cost for no gain.
export function backfillStuckPrUrls(db: DB): number {
  const rows = db
    .query(
      `SELECT tasks.id AS id, tasks.project_id AS project_id
       FROM tasks WHERE tasks.state = 'in_review' AND tasks.pr_url IS NULL`
    )
    .all() as { id: string; project_id: string }[];
  let backfilled = 0;
  for (const row of rows) {
    const allowedSlug = projectRepoSlug(db, row.project_id);
    if (!allowedSlug) continue;
    const events = db
      .query(
        "SELECT payload FROM events WHERE task_id = ? AND type = 'state_change' ORDER BY ts DESC"
      )
      .all(row.id) as { payload: string }[];
    let foundPrUrl: string | null = null;
    for (const e of events) {
      const reason = JSON.parse(e.payload)?.reason;
      foundPrUrl = extractPrUrl(reason, allowedSlug);
      if (foundPrUrl) break;
    }
    if (!foundPrUrl) continue;
    db.query("UPDATE tasks SET pr_url = ?, updated_at = ? WHERE id = ?").run(foundPrUrl, now(), row.id);
    writeEvent(db, {
      task_id: row.id,
      source: "system",
      type: "pr_linked",
      payload: { pr_url: foundPrUrl, via: "stuck_reason_backfill" },
    });
    backfilled++;
  }
  return backfilled;
}

export function transition(
  db: DB,
  taskId: string,
  to: State,
  opts: { source?: string; reason?: string; force?: boolean; skipVerification?: boolean } = {}
): any {
  const task = getTask(db, taskId);
  if (!task) throw new TransitionError(`unknown task: ${taskId}`);
  const from = task.state as State;
  const source = opts.source ?? "director";

  if (from === to) throw new TransitionError(`task already in state '${to}'`);
  // Requeue means "retry the agent work". For a JIRA MIRROR there is none, so
  // the operation is undefined rather than merely risky — refuse it. A plain
  // source='external' task a director actually spawned DOES have agent work to
  // retry, so it requeues normally (hive-996); scoping this to mirrors is what
  // keeps both true.
  if (from === "failed" && to === "queued" && isJiraMirror(task)) {
    throw new TransitionError(TRACKING_ONLY_REQUEUE_ERROR);
  }
  // force skips the normal FORWARD-graph check (still non-terminal -> terminal
  // only, evidence gates still apply below). HIVE-314's escape hatch for a PR
  // that closed with nothing left to merge: the caller has already verified the
  // work landed on the base branch via a different commit, so the usual
  // in_review -> verifying -> done merge path doesn't apply.
  if (opts.force) {
    if (TERMINAL.includes(from)) throw new TransitionError(`task already terminal ('${from}')`);
  } else if (!canTransition(from, to)) {
    // Agents jump straight to done often enough (4/16 sampled sessions) that
    // the error should teach the path, not just reject.
    const hint =
      to === "done" && (from === "in_progress" || from === "in_review")
        ? " — done is reached via review: emit `ready --pr-url <url>` (in_review), then the director merges (verifying -> done)"
        : to === "queued" && ["in_progress", "in_review", "verifying"].includes(from)
        ? `; to retry a live task, POST /api/tasks/${taskId}/requeue (fails and requeues atomically)`
        : "";
    throw new TransitionError(`invalid transition: '${from}' -> '${to}'${hint}`);
  }

  // HIVE-402: the verification contract is enforced HERE, at the one helper every
  // route to review funnels through (director move, agent `ready`, PR-link
  // handoff, the reconciler's CI-green promote). skipVerification is for the one
  // caller catching up on a PR that already merged — the work has landed, so
  // holding it in_progress would strand it forever.
  if (from === "in_progress" && to === "in_review" && !isTrackingOnlyTask(task) && !opts.skipVerification) {
    const missing = verificationGate(db, task, source);
    if (missing.length > 0)
      throw new TransitionError(
        `cannot hand off to review: the verification contract is unmet — no fresh evidence for: ${missing.join(", ")}. ` +
          `Run each command from the task's verification contract and attach its output with ` +
          `\`hive emit ${taskId} evidence --verify-name <name> --file <output>\`, then hand off again.`
      );
  }

  // Evidence gates apply to hive-driven work. Tracking-only tasks (source
  // 'external', or a Jira mirror) move freely: hive records them, it does not
  // supervise them.
  if (to === "done" && !isTrackingOnlyTask(task)) {
    if (evidenceCount(db, taskId) < 1) {
      throw new TransitionError(
        "cannot transition to 'done': task has no evidence"
      );
    }
    if (task.kind === "scout" && evidenceCount(db, taskId, "report") < 1) {
      throw new TransitionError(
        "cannot transition to 'done': scout task requires a report evidence"
      );
    }
  }

  if (to === "in_review" && !task.pr_url) {
    const foundPrUrl = extractPrUrl(opts.reason, projectRepoSlug(db, task.project_id));
    if (foundPrUrl) {
      db.query("UPDATE tasks SET pr_url = ?, updated_at = ? WHERE id = ?").run(foundPrUrl, now(), taskId);
      writeEvent(db, { task_id: taskId, source, type: "pr_linked", payload: { pr_url: foundPrUrl, via: "reason_backfill" } });
    }
  }

  const updated = mutateWithEvent(db, () => {
    // Re-queuing a failed task (attention tray) resets its runtime binding so the
    // next spawn is clean — a queued task must not point at a dead agent/worktree.
    // Any state change answers the dispatcher's "why not" (noteSkip): the task
    // either started, or is no longer queued at all. Clear it in the same write
    // so a stale reason can never outlive the state it described.
    if (to === "queued") {
      db.query(
        "UPDATE tasks SET state = ?, updated_at = ?, agent_target = NULL, worktree_path = NULL, branch = NULL, skip_reason = NULL, skip_reason_at = NULL WHERE id = ?"
      ).run(to, now(), taskId);
    } else {
      db.query("UPDATE tasks SET state = ?, updated_at = ?, skip_reason = NULL, skip_reason_at = NULL WHERE id = ?").run(to, now(), taskId);
    }
    return getTask(db, taskId);
  }, {
    task_id: taskId,
    source,
    type: "state_change",
    payload: { from, to, reason: opts.reason ?? null },
  });
  if (to === "cancelled" && task.jira_key && task.jira_link_kind === "subtask") {
    queueJiraCancellationComment(db, taskId, source);
  }
  broadcastTask(db, updated);
  // A terminal task can no longer act on any open decision — expire them so the
  // inbox clears and the answer endpoint can't be hit against a dead task.
  if (TERMINAL.includes(to)) expireOpenDecisions(db, taskId, `task ${to}`);
  if (to === "cancelled") openCancelledDependencyDecision(db, updated, source);
  // Notify on notable terminal-ish outcomes (batched into the digest).
  if (to === "done")
    enqueue(db, { kind: "done", task_id: taskId, title: `Task done: ${task.title}`, body: task.summary ?? undefined });
  else if (to === "failed")
    enqueue(db, { kind: "failed", task_id: taskId, title: `Task failed: ${task.title}`, body: opts.reason ?? undefined });
  // A task landing in review is waiting on the director and nobody else: the
  // agent is parked until it is approved, sent back, or its understanding check
  // is answered. That is urgent by definition, not digest material.
  else if (to === "in_review")
    enqueue(db, {
      kind: "review",
      urgency: "urgent",
      task_id: taskId,
      title: `Review #${task.number}: ${task.title}`,
      body: "Approve, request changes, or answer the understanding check.",
    });
  // Auto-teardown on an unambiguously-final state. failed is excluded (still retriable).
  if ((to === "done" || to === "cancelled") && terminalHook) {
    try {
      terminalHook(db, taskId, to);
    } catch (e) {
      console.error("[hive] terminal cleanup hook:", e);
    }
  }
  return updated;
}
