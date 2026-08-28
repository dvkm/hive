// Dependency-aware land queue (task #1257).
//
// The director marks a set of in-review tasks "approved to land"; hive merges
// them in graph order instead of the director hand-ordering PRs. Two kinds of
// edge decide that order, both recomputed live (never stored):
//
//   depends  — task B declares A in depends_on, or its brief says "lands after
//              #A" / "depends on #A". A hard ordering: B waits until A merged.
//   conflict — two branches touch the SAME file. Nothing declares this; it is
//              inferred from `git diff --name-only base...branch` (the same
//              authoredFiles the rebase guard uses). Landing both back to back
//              would leave the second branch conflicting with the new base, so
//              only ONE of a conflicting pair lands per sweep; the other waits
//              for its agent to rebase.
//
// Everything else lands in the same sweep — independent PRs never queue behind
// each other. `from` lands BEFORE `to` on every edge.
import type { DB } from "./db.ts";
import { now } from "./db.ts";
import { getTask, writeEvent, changesRequestUnaddressed } from "./state.ts";
import { authoredFiles } from "./rebaseGuard.ts";
import { defaultExec, projectComparisonBase, type Exec } from "./exec.ts";
import { enqueue } from "./notifications.ts";
import { queueSteerEvent, queuedSteers } from "./steer.ts";

export interface LandNode {
  id: string;
  number: number;
  project_number: number | null;
  title: string;
  state: string;
  branch: string | null;
  ci_status: string | null;
  land_queued_at: string | null;
  priority: string;
}

export interface LandEdge {
  from: string; // lands first
  to: string; // lands after `from`
  kind: "depends" | "conflict";
  files?: string[]; // conflict edges: the overlapping files (capped)
}

export interface LandGraph {
  nodes: LandNode[];
  edges: LandEdge[];
}

const MERGED_STATES = ["verifying", "done"];

// now > next > normal > later. Anything unrecognised sorts last with 'later'.
const PRIORITY_ORDER = ["now", "next", "normal"];
function priorityRank(p: string | null | undefined): number {
  const i = PRIORITY_ORDER.indexOf(p ?? "normal");
  return i === -1 ? PRIORITY_ORDER.length : i;
}

// "lands after #12" / "land after #12" / "depends on #12" in a brief. The
// director's ordering notes are prose today (the 832 → 823 → 825 batch), so
// read the obvious phrasings rather than demanding the depends_on field.
const BRIEF_DEP_RE = /(?:lands?\s+after|depends\s+on)\s+#(\d+)/gi;

function briefDepNumbers(brief: string | null): number[] {
  if (!brief) return [];
  return [...brief.matchAll(BRIEF_DEP_RE)].map((m) => Number(m[1]));
}

function addEdge(edges: LandEdge[], e: LandEdge): void {
  if (e.from === e.to) return;
  if (edges.some((x) => x.from === e.from && x.to === e.to && x.kind === e.kind)) return;
  edges.push(e);
}

// The land graph for one project's review column. Git is only read for the
// conflict edges, once per branch (not per pair). Any git failure means "can't
// tell" — that branch simply gets no conflict edges, never a blocked merge.
export async function landGraph(db: DB, projectId: string, exec: Exec = defaultExec): Promise<LandGraph> {
  const nodes = db
    .query(
      `SELECT id, number, project_number, title, state, branch, ci_status, land_queued_at, priority
         FROM tasks WHERE project_id = ? AND state = 'in_review' ORDER BY number`
    )
    .all(projectId) as LandNode[];
  const edges: LandEdge[] = [];
  if (nodes.length < 2) return { nodes, edges };

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const byNumber = new Map<number, LandNode>();
  for (const n of nodes) {
    byNumber.set(n.number, n);
    if (n.project_number != null && !byNumber.has(n.project_number)) byNumber.set(n.project_number, n);
  }

  for (const n of nodes) {
    const row = getTask(db, n.id);
    for (const dep of row?.depends_on ?? []) if (byId.has(dep)) addEdge(edges, { from: dep, to: n.id, kind: "depends" });
    for (const num of briefDepNumbers(row?.brief ?? null)) {
      const dep = byNumber.get(num);
      if (dep) addEdge(edges, { from: dep.id, to: n.id, kind: "depends" });
    }
  }

  const project: any = db.query("SELECT repo_path, config FROM projects WHERE id = ?").get(projectId);
  if (project?.repo_path) {
    const base = projectComparisonBase(JSON.parse(project.config ?? "{}"));
    const files = new Map<string, Set<string>>();
    for (const n of nodes) {
      if (!n.branch) continue;
      const f = await authoredFiles(exec, project.repo_path, base, n.branch);
      if (f?.length) files.set(n.id, new Set(f));
    }
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = files.get(nodes[i].id);
        const b = files.get(nodes[j].id);
        if (!a || !b) continue;
        const shared = [...a].filter((f) => b.has(f));
        // The lower task number lands first — a stable order, so the same pair
        // resolves the same way every sweep.
        if (shared.length) addEdge(edges, { from: nodes[i].id, to: nodes[j].id, kind: "conflict", files: shared.slice(0, 5) });
      }
    }
  }
  return { nodes, edges };
}

// Mark / unmark tasks as approved-to-land. Returns the ids actually changed.
export function markLand(db: DB, ids: string[], queued: boolean): string[] {
  const changed: string[] = [];
  for (const id of ids) {
    const task = getTask(db, id);
    if (!task) continue;
    if (queued && task.state !== "in_review") continue;
    db.query("UPDATE tasks SET land_queued_at = ?, updated_at = ? WHERE id = ?").run(queued ? now() : null, now(), id);
    writeEvent(db, { task_id: id, source: "director", type: queued ? "land_queued" : "land_unqueued", payload: {} });
    changed.push(id);
  }
  return changed;
}

export interface LandDeps {
  exec?: Exec;
  // Injected so the sweep is testable without gh/git. Defaults to POST /merge's
  // own mergeTask, so the queue lands PRs exactly the way the review click does.
  merge?: (taskId: string) => Promise<{ ok: boolean; reason?: string }>;
}

async function defaultMerge(db: DB, taskId: string, exec: Exec): Promise<{ ok: boolean; reason?: string }> {
  const { mergeTask } = await import("./api.ts");
  const { herdr: defaultHerdr } = await import("./runtime/herdr.ts");
  const res = await mergeTask(db, defaultHerdr, taskId, {}, { exec });
  if (res.status === 200) return { ok: true };
  let reason = `merge failed (${res.status})`;
  try {
    reason = ((await res.clone().json()) as any)?.error ?? reason;
  } catch {}
  return { ok: false, reason };
}

// A land failure that will very likely clear on its own. The queue already
// serializes merges, so the cure is simply to try again a bit later:
//
//   base moved   — GitHub's "Base branch was modified", or a base/head SHA that
//                  changed under us because a sibling PR landed first.
//   queue race   — the merge queue or GitHub itself was busy / rate-limited.
//   CI pending   — required checks were still running when we asked.
//
// Everything else (a real conflict, red CI, a missing understanding check) needs
// a human or the agent, so it opens the pause card instead.
const TRANSIENT_RE =
  /base branch was modified|base.{0,20}(changed|moved|out of date|behind)|not up to date|merge queue|enqueued|try again|rate limit|secondary rate|timed? ?out|temporarily unavailable|\b50[234]\b|checks? (are )?(still )?(pending|running|in progress)|required status checks? .{0,30}(pending|expected)/i;

export function isTransientLandFailure(reason: string): boolean {
  return TRANSIENT_RE.test(reason);
}

// A refusal that is waiting on the DIRECTOR, not on the queue and not on the
// agent: an understanding check that has been submitted but not yet answered.
// The review card already asks that question, so a land-queue card here would be
// the same question twice. The mark stays and the queue simply re-checks the
// gate each sweep, which is what makes a quiz reset by a NEW review_summary land
// on its own once the director passes it — no re-marking, no second card.
// (A task with NO check submitted at all is a different thing: that needs the
// agent, so it falls through to the pause card.)
const QUIZ_HOLD_RE = /pass the understanding check/i;

export function isQuizHold(reason: string): boolean {
  return QUIZ_HOLD_RE.test(reason);
}

// The mark predates the insight. A director who marks a PR approved-to-land and
// only THEN passes its understanding check has just learned what the change
// actually does — and may no longer want it. So a pass recorded after the mark
// freezes the queue for that task until the director taps "Land now" on the
// review card, which re-marks it and postdates the pass (director ruling,
// HIVE-421). Unmarking clears it the other way.
// ponytail: derived from event order, no new column — "Land now" is the
// existing land-queue mark call, not a new endpoint.
export function landHeldForQuiz(db: DB, taskId: string): boolean {
  const row = db
    .query(
      `SELECT (SELECT MAX(rowid) FROM events WHERE task_id = ? AND type = 'land_queued') AS marked,
              (SELECT MAX(rowid) FROM events
                 WHERE task_id = ? AND type = 'understanding_quiz_passed'
                   AND json_extract(payload, '$.review_event_id') = (
                     SELECT id FROM events WHERE task_id = ? AND type = 'review_summary'
                      ORDER BY ts DESC, rowid DESC LIMIT 1)) AS passed`
    )
    .get(taskId, taskId, taskId) as { marked: number | null; passed: number | null };
  return !!(row?.marked && row?.passed && row.passed > row.marked);
}

// Retry spacing after consecutive transient failures. The reconciler sweeps
// every 30s; without this a base that keeps moving would be re-merged every
// sweep forever. After MAX_TRANSIENT_RETRIES the failure stops being treated as
// transient and opens the pause card, so nothing retries silently for ever.
const RETRY_BACKOFF_MS = [30_000, 60_000, 120_000, 300_000, 600_000];
const MAX_TRANSIENT_RETRIES = RETRY_BACKOFF_MS.length;

interface RetryState {
  transientFailures: number; // consecutive transient failures since the last non-attempt
  lastAttemptMs: number;
}

// Consecutive trailing transient failures on this task, newest first. Ordered by
// rowid, not ts: insertion order is the real sequence and cannot be reshuffled
// by a clock skew or a backdated row. A success,
// a non-transient failure, or a fresh `land_queued` resets the run — the count is
// about THIS stall, not the task's whole history.
function retryState(db: DB, taskId: string): RetryState {
  const rows = db
    .query(
      `SELECT ts, payload FROM events
        WHERE task_id = ? AND type IN ('land_attempted', 'land_queued')
        ORDER BY rowid DESC LIMIT 20`
    )
    .all(taskId) as { ts: string; payload: string }[];
  let transientFailures = 0;
  let lastAttemptMs = 0;
  for (const row of rows) {
    let payload: any = {};
    try {
      payload = JSON.parse(row.payload ?? "{}");
    } catch {}
    if (payload.ok !== false || !payload.transient) break;
    if (!lastAttemptMs) lastAttemptMs = Date.parse(row.ts) || 0;
    transientFailures++;
  }
  return { transientFailures, lastAttemptMs };
}

// Is this task inside its backoff window, i.e. too soon to retry again?
function backingOff(state: RetryState, nowMs: number): boolean {
  if (!state.transientFailures || !state.lastAttemptMs) return false;
  const wait = RETRY_BACKOFF_MS[Math.min(state.transientFailures, RETRY_BACKOFF_MS.length) - 1];
  return nowMs - state.lastAttemptMs < wait;
}

// The open pause card for this task, if one is already waiting. One card per
// task: a second sweep hitting the same wall must not stack a duplicate on the
// director's inbox, and the task stays held until the card is answered.
function openPauseDecisionId(db: DB, taskId: string): string | null {
  const row = db
    .query(
      `SELECT d.id AS id FROM events e JOIN decisions d ON d.id = json_extract(e.payload, '$.decision_id')
        WHERE e.task_id = ? AND e.type = 'land_paused' AND d.status = 'open'
        ORDER BY e.rowid DESC LIMIT 1`
    )
    .get(taskId) as { id: string } | undefined;
  return row?.id ?? null;
}

// Answering a pause card. This resolver EXISTS so `apiAnswerDecision` treats the
// card as claimed: an unclaimed card falls through to a generic steer, which the
// steer-delivery path turns into a `changes_requested` — that is what bounced a
// finished PR back to in_progress after an administrative "fix" answer. Only the
// `send_back` option, which says so on the label, may touch the agent.
export function resolveLandPauseForDecision(db: DB, decisionId: string, answerKey: string): boolean {
  const ev = db
    .query("SELECT task_id FROM events WHERE type = 'land_paused' AND json_extract(payload, '$.decision_id') = ? LIMIT 1")
    .get(decisionId) as { task_id: string } | undefined;
  if (!ev) return false;
  if (answerKey === "unqueue") {
    markLand(db, [ev.task_id], false);
    return true;
  }
  if (answerKey === "send_back") {
    // The one answer that is allowed to steer. Clearing the mark matters here:
    // the diff the director approved is about to change.
    markLand(db, [ev.task_id], false);
    queueSteerEvent(
      db,
      ev.task_id,
      "The director sent this PR back from the land queue. Fix what stopped it from merging, push, and hand off for review again.",
      "queued by land-queue pause card"
    );
    return true;
  }
  // "retry": the mark is sticky, so closing the card is the whole action — the
  // next sweep picks the task up again with no re-marking.
  writeEvent(db, { task_id: ev.task_id, source: "director", type: "land_retry", payload: { decision_id: decisionId } });
  return true;
}

// Close pause cards whose blocker is gone. A merge conflict bounces the task
// out of review and straight to its agent (mergeTask's own path), so the card
// asking the director what to do about it is answered by hive itself one sweep
// later. Same when the director simply unmarks the task. Modelled on
// revalidateCiDecisions: showing a stale question is worse than showing none.
async function revalidateLandPauseCards(db: DB): Promise<void> {
  const rows = db
    .query(
      `SELECT d.id AS id, d.title AS title FROM events e
         JOIN decisions d ON d.id = json_extract(e.payload, '$.decision_id')
         JOIN tasks t ON t.id = e.task_id
        WHERE e.type = 'land_paused' AND d.status = 'open'
          AND (t.state != 'in_review' OR t.land_queued_at IS NULL)`
    )
    .all() as { id: string; title: string }[];
  for (const r of rows) {
    const { apiDismissDecision } = await import("./api.ts");
    apiDismissDecision(db, r.id, {
      reason: "land_blocker_cleared",
      steer:
        `hive closed the land-queue card "${r.title}" on its own: the PR is no longer sitting in the queue waiting ` +
        `on that answer. Carry on with the work you were given; nothing here needs a reply.`,
    });
  }
}

// Has this task's most recent land-queue event already logged the pending-steer
// hold? Sweeps run every 30s and a slow agent can sit between turns for a long
// time, so without this check `land_retry_held` would write once per sweep for
// the whole hold instead of once per episode (HIVE-444 follow-up). Any other
// event type (a delivered steer resuming retries, a fresh attempt, a re-mark)
// means the episode ended, so the next hold logs again.
function alreadyHeldForSteer(db: DB, taskId: string): boolean {
  const row = db
    .query(
      `SELECT type FROM events
        WHERE task_id = ? AND type IN ('land_retry_held', 'land_attempted', 'land_queued', 'land_unqueued')
        ORDER BY rowid DESC LIMIT 1`
    )
    .get(taskId) as { type: string } | undefined;
  return row?.type === "land_retry_held";
}

// One sweep of the land queue for every project that has one. Lands everything
// whose edges are satisfied and skips the rest for the next sweep.
//
// The approved-to-land mark is STICKY: it survives a failed attempt and a state
// bounce (a rebase round-trip through in_progress, a review reset) until the
// task actually lands or the director unmarks it. Only tasks currently in review
// are queue nodes, so a bounced task simply stops being a candidate and resumes
// its place the moment it is back in review — no re-marking by hand.
//
// A failure that looks transient (base moved, merge-queue race, CI pending)
// retries on a backoff and opens NO card. Anything else opens exactly one pause
// card for that task and holds it until the card is answered.
export async function landOnce(db: DB, deps: LandDeps = {}): Promise<void> {
  const exec = deps.exec ?? defaultExec;
  const merge = deps.merge ?? ((id: string) => defaultMerge(db, id, exec));
  const nowMs = Date.now();

  await revalidateLandPauseCards(db);

  // Landing clears the mark; nothing else does. MERGED_STATES is the "it landed"
  // test the graph already uses.
  db.query(
    `UPDATE tasks SET land_queued_at = NULL
      WHERE land_queued_at IS NOT NULL AND state IN (${MERGED_STATES.map(() => "?").join(", ")})`
  ).run(...MERGED_STATES);

  const projects = db
    .query("SELECT DISTINCT project_id FROM tasks WHERE land_queued_at IS NOT NULL AND state = 'in_review'")
    .all() as { project_id: string }[];

  for (const { project_id } of projects) {
    const { nodes, edges } = await landGraph(db, project_id, exec);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const landed = new Set<string>();
    const pending = new Set(nodes.filter((n) => n.land_queued_at).map((n) => n.id));
    const failed: { node: LandNode; reason: string }[] = [];

    while (pending.size) {
      const batch: LandNode[] = [];
      const selected = new Set<string>();
      // Dependency and conflict EDGES decide the order first — they are hard
      // constraints checked below and priority never overrides them. Priority
      // only breaks the tie among nodes that are all ready to land in this
      // batch, with the task number as the final, stable tiebreak. Edge
      // construction still keys on the number alone, so a conflicting pair
      // resolves the same way every sweep.
      for (const n of nodes.filter((x) => pending.has(x.id)).sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority) || a.number - b.number)) {
        // Re-read the mark fresh right before attempting: `pending` was built
        // from one snapshot at the top of this sweep, and an unmark landing in
        // between must drop the task on the spot, not ride out on stale state
        // (HIVE-444 addendum — unqueue wasn't stopping the periodic retries).
        const stillMarked = (db.query("SELECT land_queued_at FROM tasks WHERE id = ?").get(n.id) as { land_queued_at: string | null } | undefined)?.land_queued_at;
        if (!stillMarked) {
          pending.delete(n.id);
          continue;
        }
        // Red or still-running CI holds only this node. Independent nodes can
        // still enter the same concurrent batch.
        if (n.ci_status === "failing" || n.ci_status === "pending") continue;
        // A pause card already waiting on the director holds the task too —
        // otherwise every sweep would re-attempt and re-ask the same question.
        if (openPauseDecisionId(db, n.id)) continue;
        if (backingOff(retryState(db, n.id), nowMs)) continue;
        // Quiz passed after the mark: wait for the director's "Land now" tap.
        if (landHeldForQuiz(db, n.id)) continue;
        // A corrective steer is queued for the agent (it's between turns) but
        // not delivered yet: the branch is known to need a fix, so retrying the
        // merge against it now just burns attempts (HIVE-444). Hold quietly
        // until the steer is delivered AND a new head_sha shows up.
        if (queuedSteers(db, n.id).length) {
          if (!alreadyHeldForSteer(db, n.id)) {
            writeEvent(db, { task_id: n.id, source: "reconciler", type: "land_retry_held", payload: { reason: "pending steer" } });
          }
          continue;
        }
        // A changes_requested this task hasn't addressed yet (no new commit
        // since) — same hold, covers the steer having just been delivered.
        if (changesRequestUnaddressed(db, n.id)) continue;
        const waiting = edges.some((e) => {
          // depends is directional and hard: `to` waits until `from` has merged.
          if (e.kind === "depends")
            return e.to === n.id && !landed.has(e.from) && !MERGED_STATES.includes(byId.get(e.from)?.state ?? "");
          // conflict is SYMMETRIC: only one of the pair may land per sweep, and
          // whichever side is picked first holds the other. The edge direction
          // is just the stable default (lower number first); with priority in
          // the scan order the `to` side can now be visited first, so the check
          // must look at both ends — reading only `to` would let a conflicting
          // pair land together.
          const other = e.to === n.id ? e.from : e.from === n.id ? e.to : null;
          return other != null && (landed.has(other) || selected.has(other));
        });
        if (waiting) continue;
        batch.push(n);
        selected.add(n.id);
      }
      if (!batch.length) break;

      const results = await Promise.all(batch.map(async (node) => ({ node, result: await merge(node.id) })));
      for (const { node, result } of results) {
        pending.delete(node.id);
        const reason = result.reason ?? "merge failed";
        // Waiting on the director's quiz answer: hold quietly, log nothing. A
        // sweep runs every 30s and this refusal is a local check, so an event
        // per sweep would be pure timeline noise.
        if (!result.ok && isQuizHold(reason)) continue;
        // A transient cause that has already burned its retries is no longer
        // transient: it is a stall the director needs to see.
        const transient =
          !result.ok &&
          isTransientLandFailure(reason) &&
          retryState(db, node.id).transientFailures < MAX_TRANSIENT_RETRIES;
        if (result.ok) {
          landed.add(node.id);
          db.query("UPDATE tasks SET land_queued_at = NULL WHERE id = ?").run(node.id);
        } else if (!transient) {
          failed.push({ node, reason });
        }
        writeEvent(db, {
          task_id: node.id,
          source: "reconciler",
          type: "land_attempted",
          payload: { ok: result.ok, reason: result.reason, ...(result.ok ? {} : { transient }) },
        });
      }
    }

    if (landed.size)
      enqueue(db, {
        kind: "auto_merged",
        title: `Landed ${landed.size} PR${landed.size === 1 ? "" : "s"} from the land queue`,
        body: [...landed].map((id) => `#${byId.get(id)?.number}`).join(", "),
      });

    for (const { node, reason } of failed) {
      if (openPauseDecisionId(db, node.id)) continue; // already asked
      // A conflict bounce already sent the task to its agent with rebase
      // instructions. Asking the director what to do about work hive has
      // already routed is the duplicate card this task exists to remove.
      if (getTask(db, node.id)?.state !== "in_review") continue;
      const { createDecision } = await import("./api.ts");
      const decision = createDecision(db, {
        task_id: node.id,
        title: `PR #${node.number} paused in the land queue`,
        context:
          `${node.title}\n\nIt is still approved to land, but the merge stopped: ${reason.slice(0, 300)}\n\n` +
          `The approval sticks, so "Try landing it again" needs no re-marking.`,
        options: [
          { key: "retry", label: "Try landing it again", detail: "Keep it queued; the next sweep re-attempts the merge.", recommended: true },
          { key: "unqueue", label: "Take it out of the queue", detail: "Leave the PR open and unmarked. Nothing is sent to the agent." },
          { key: "send_back", label: "Send it back to the agent", detail: "Unmark it and ask the agent to fix what blocked the merge." },
        ],
      });
      writeEvent(db, { task_id: node.id, source: "reconciler", type: "land_paused", payload: { decision_id: decision.id, reason } });
    }
  }
}
