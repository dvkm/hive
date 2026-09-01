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
// Everything else lands in the same sweep — independent PRs never wait a whole
// sweep for each other. `from` lands BEFORE `to` on every edge. Within a sweep
// the merges themselves are SERIAL (HIVE-348): edges decide who may land, and
// the queue then lands them one at a time so no two merges race on one base.
import type { DB } from "./db.ts";
import { now } from "./db.ts";
import { getTask, writeEvent, changesRequestUnaddressed } from "./state.ts";
import { authoredFiles } from "./rebaseGuard.ts";
import { defaultExec, projectComparisonBase, type Exec } from "./exec.ts";
import { enqueue } from "./notifications.ts";
import { queueSteerEvent, queuedSteers } from "./steer.ts";
import { reviewPipelineSettled, requestRiskRecheck } from "./reviewer.ts";

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
  merge?: (taskId: string) => Promise<{ ok: boolean; reason?: string; code?: string }>;
}

async function defaultMerge(db: DB, taskId: string, exec: Exec): Promise<{ ok: boolean; reason?: string; code?: string }> {
  const { mergeTask } = await import("./api.ts");
  const { herdr: defaultHerdr } = await import("./runtime/herdr.ts");
  const res = await mergeTask(db, defaultHerdr, taskId, {}, { exec });
  if (res.status === 200) return { ok: true };
  let reason = `merge failed (${res.status})`;
  let code: string | undefined;
  try {
    const body = (await res.clone().json()) as any;
    reason = body?.error ?? reason;
    code = typeof body?.code === "string" ? body.code : undefined;
  } catch {}
  return { ok: false, reason, code };
}

// A land failure that will very likely clear on its own. The queue already
// serializes merges, so the cure is simply to try again a bit later:
//
//   base moved   — GitHub's "Base branch was modified", or a base/head SHA that
//                  changed under us because a sibling PR landed first.
//   queue race   — the merge queue or GitHub itself was busy / rate-limited.
//   CI pending   — required checks were still running when we asked.
//   risk check unfinished — the per-risk verification timed out on this head;
//                  it retries on its own, and nothing was confirmed (HIVE-539).
//   risk finding stale — the finding was recorded on a commit the branch has
//                  already moved past (HIVE-588); the check re-runs on the new
//                  head, so there is nothing here for a human to answer.
//
// Everything else (a real conflict, red CI, a missing understanding check) needs
// a human or the agent, so it opens the pause card instead.
const TRANSIENT_RE =
  /risk check did not finish|risk finding is stale|base branch was modified|base.{0,20}(changed|moved|out of date|behind)|not up to date|merge queue|enqueued|try again|rate limit|secondary rate|timed? ?out|temporarily unavailable|\b50[234]\b|checks? (are )?(still )?(pending|running|in progress)|required status checks? .{0,30}(pending|expected)/i;

export function isTransientLandFailure(reason: string): boolean {
  return TRANSIENT_RE.test(reason);
}

// A transient failure whose cause is SHORTAGE: the model route, GitHub or an
// upstream was saturated, so the call timed out, was rate-limited or was
// refused. Retrying one of these is not neutral — the attempt spends the very
// resource that was short, on the same shared route, for the full timeout. Live
// on 2026-08-31 one task retried an unfinished risk check 4 times in 20 minutes,
// 180s per attempt, against 1 successful merge fleet-wide; the same review call
// takes 15-38s when the route is free (HIVE-569). "Base moved" and "CI still
// running" are NOT capacity failures: retrying those costs nothing shared.
const CAPACITY_RE =
  /risk check did not finish|timed? ?out|rate limit|secondary rate|temporarily unavailable|overloaded|too many requests|\b(429|50[234])\b/i;

export function isCapacityLandFailure(reason: string): boolean {
  return CAPACITY_RE.test(reason);
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

// Capacity failures wait far longer and give up far sooner. The point is to sit
// out the congestion instead of adding to it: a saturated route needs minutes,
// not seconds, and three attempts spread over roughly an hour is the whole
// budget. Past that the stall stops counting as transient and becomes the pause
// card, exactly like any other cause that never clears (HIVE-569).
const CAPACITY_BACKOFF_MS = [300_000, 900_000, 2_700_000];
const MAX_CAPACITY_RETRIES = CAPACITY_BACKOFF_MS.length;

// A hard ceiling on attempts of ANY kind since the mark (HIVE-539). A
// non-transient failure normally opens one pause card and stops, but a failure
// that BOUNCES the task out of review (the destructive-rebase guard does) skips
// the card — and the mark is sticky, so the task came back and re-attempted the
// same doomed merge every sweep: b5f437266360 tried 52 times before a human
// unqueued it. At the ceiling hive unqueues it itself and says so.
const MAX_LAND_ATTEMPTS = 10;

// Failed land attempts since the last land_queued mark, ordered by insertion.
// A success or a fresh mark ends the run, exactly like retryState.
function failedAttemptRun(db: DB, taskId: string): number {
  const rows = db
    .query(
      `SELECT payload FROM events
        WHERE task_id = ? AND type IN ('land_attempted', 'land_queued')
        ORDER BY rowid DESC LIMIT ${MAX_LAND_ATTEMPTS + 1}`
    )
    .all(taskId) as { payload: string }[];
  let failures = 0;
  for (const row of rows) {
    let payload: any = {};
    try {
      payload = JSON.parse(row.payload ?? "{}");
    } catch {}
    if (payload.ok !== false) break;
    failures++;
  }
  return failures;
}

// A non-transient failure is permanent until something actually changes: the
// scope check, the missing understanding check, the confirmed risk and the
// "task is not in_review" refusal all give the SAME answer on the same commit,
// every sweep, forever. So a task gets ONE retry after the first non-transient
// failure (the director answering "retry" on the pause card), and after that it
// is held — still queued, not merged — until a human unqueues it or the agent
// pushes a new head_sha. Measured on one machine: 116 land failures were only 30
// real blockages, and a single PR contributed 52 of them (HIVE-555).
const MAX_NON_TRANSIENT_ATTEMPTS = 2;

// A ceiling on the "wait for the auto review" hold (HIVE-581). Holding is right
// while a review is on its way, but a reviewer that keeps erroring never
// settles, and a task that never merges and never says why is the worst failure
// shape here: it looks fine until someone goes looking hours later. So the hold
// expires. Past the ceiling the task falls through to the merge attempt exactly
// as it did before this change — today's noisy refusal and its pause card,
// which is the signal. Fifteen minutes is several times a normal review.
const REVIEW_WAIT_CEILING_MS = 900_000;

// Have we been waiting on the reviewer for THIS head past the ceiling? The first
// hold writes one `land_review_wait` event and holds; later sweeps measure from
// it. Keyed to the head, so a new push starts a fresh wait. One event per head,
// so the wait leaves a trace without a per-sweep log.
function reviewWaitExpired(db: DB, taskId: string, headSha: string | null, nowMs: number): boolean {
  const rows = db
    .query("SELECT ts, payload FROM events WHERE task_id = ? AND type = 'land_review_wait' ORDER BY rowid DESC LIMIT 5")
    .all(taskId) as { ts: string; payload: string }[];
  for (const row of rows) {
    let payload: any = {};
    try {
      payload = JSON.parse(row.payload ?? "{}");
    } catch {}
    if ((payload.head_sha ?? null) !== headSha) continue;
    return nowMs - Date.parse(row.ts) >= REVIEW_WAIT_CEILING_MS;
  }
  writeEvent(db, {
    task_id: taskId,
    source: "reconciler",
    type: "land_review_wait",
    payload: { head_sha: headSha, ceiling_ms: REVIEW_WAIT_CEILING_MS },
  });
  return false;
}

// HIVE-559: a CONFIRMED risk is agent work, not a director ruling. Measured over
// 24h on one machine: 18 pause cards for confirmed risks, 0 of them needed a
// human — every one was fixed by the agent as soon as someone relayed it by
// hand. So hive relays it first and only asks the director when the agent
// argues back or the same risk survives the relay.
//
// The routing decision reads the refusal's machine-readable `code`, NOT its
// prose. The message is built in api.ts and consumed here; nothing tied the two
// files together, so a reworded sentence would have reverted every confirmed
// risk to the old always-ask-the-director path with nobody the wiser.
// `CONFIRMED_RISK_CODE` is that contract, exported from this one module and
// imported by api.ts, so it cannot desync.
export const CONFIRMED_RISK_CODE = "confirmed_risk";

export function isConfirmedRiskFailure(code: string | undefined): boolean {
  return code === CONFIRMED_RISK_CODE;
}

// The tripwire for the failure this design is meant to remove. If a refusal
// still READS like a confirmed risk but arrived with no code, the two sides have
// drifted apart. Rather than quietly falling back to the director, hive keeps
// routing (so behaviour does not regress) and says loudly that the contract
// broke, once per merge attempt.
const CONFIRMED_RISK_RE = /the risk check confirmed/i;

function codeOfFailure(db: DB, node: LandNode, reason: string, code: string | undefined): string | undefined {
  if (code || !CONFIRMED_RISK_RE.test(reason)) return code;
  writeEvent(db, {
    task_id: node.id,
    source: "reconciler",
    type: "risk_code_desync",
    payload: { reason, expected_code: CONFIRMED_RISK_CODE },
  });
  enqueue(db, {
    kind: "stale",
    task_id: node.id,
    title: `Land refusal lost its ${CONFIRMED_RISK_CODE} code`,
    body:
      `PR #${node.number} was refused with a confirmed-risk message that carried no \`code\` field. ` +
      `The merge gate in server/src/api.ts and the land queue have drifted apart. Risk routing still ran, ` +
      `but fix the missing code before it stops working.`,
  });
  return CONFIRMED_RISK_CODE;
}

// One relay against ONE commit is the ceiling. Counted per head_sha, so a real
// fix (a new commit) starts fresh and an agent that hands the same branch back
// unchanged runs out. It is 1, not 2, because HIVE-555 already stops the queue
// re-attempting the same commit after two non-transient failures — a second
// relay could never be reached, and a constant the surrounding code cannot
// honour is a lie. Never auto-overrides: `override_confirmed_risks` stays a
// human act, and the merge itself is re-attempted, never waved through.
const MAX_RISK_ROUTES_PER_HEAD = 1;

// How many times the director has already said "this finding is wrong" about
// this exact commit. One is the ceiling: the check has re-run with the
// argument, and asking the same thing again would be the no-op this replaced.
function riskRechecksAtHead(db: DB, taskId: string, headSha: string | null): number {
  const row = db
    .query(
      `SELECT COUNT(*) AS n FROM events
        WHERE task_id = ? AND type = 'risk_recheck'
          AND json_extract(payload, '$.head_sha') IS ?`
    )
    .get(taskId, headSha) as { n: number };
  return row?.n ?? 0;
}

function riskRoutesAtHead(db: DB, taskId: string, headSha: string | null): number {
  const row = db
    .query(
      `SELECT COUNT(*) AS n FROM events
        WHERE task_id = ? AND type = 'risk_routed_to_agent'
          AND json_extract(payload, '$.head_sha') IS ?`
    )
    .get(taskId, headSha) as { n: number };
  return row?.n ?? 0;
}

// The agent's reply since the last relay, when it still applies to THIS commit.
// A dispute is an ESCALATION, not a retry: if the agent says the finding is
// wrong, that is exactly when a person should look, and the argument is what
// makes the card cheap to answer. A new head means the agent pushed instead, so
// the relay did its job and there is nothing to escalate.
//
// The signal is its own event type, NOT `answer`. `answer` is the generic reply
// channel for every steer and change-request question, so reading it here made
// "on it, fixing now" — or a reply about something else entirely — escalate to
// the director. That is the exact interruption this feature exists to remove,
// so disputing takes a deliberate, separate act:
//   hive emit <task-id> risk_dispute --note "why the finding is wrong"
// `risk_dispute` needs no server or CLI plumbing: unknown event types already
// ingest through the generic path in ingestEvent, which stores `{ note }`.
// An agent that disputes on the wrong channel is not read as a dispute — it
// spends its relay instead and gets the ordinary pause card, which errs toward
// the quiet outcome rather than a false escalation.
const RISK_DISPUTE_EVENT = "risk_dispute";

function pendingRiskDispute(db: DB, taskId: string, headSha: string | null): { dispute: string; reason: string; code: string } | null {
  const routed = db
    .query("SELECT rowid AS rid, payload FROM events WHERE task_id = ? AND type = 'risk_routed_to_agent' ORDER BY rowid DESC LIMIT 1")
    .get(taskId) as { rid: number; payload: string } | undefined;
  if (!routed) return null;
  let payload: any = {};
  try {
    payload = JSON.parse(routed.payload ?? "{}");
  } catch {}
  if ((payload.head_sha ?? null) !== headSha) return null;
  const disputed = db
    .query(
      `SELECT json_extract(payload, '$.note') AS note FROM events
        WHERE task_id = ? AND type = ? AND rowid > ? ORDER BY rowid DESC LIMIT 1`
    )
    .get(taskId, RISK_DISPUTE_EVENT, routed.rid) as { note: string | null } | undefined;
  if (!disputed?.note) return null;
  return {
    dispute: disputed.note,
    reason: payload.reason ?? "the risk check confirmed a risk on this head",
    code: payload.code ?? CONFIRMED_RISK_CODE,
  };
}

// Did we already open a card for the current relay episode? Without this the
// dispute escalation below would re-ask the same question every sweep for as
// long as the agent's argument stands.
function escalatedSinceRelay(db: DB, taskId: string): boolean {
  const row = db
    .query(
      `SELECT (SELECT MAX(rowid) FROM events WHERE task_id = ? AND type = 'risk_routed_to_agent') AS routed,
              (SELECT MAX(rowid) FROM events WHERE task_id = ? AND type = 'land_paused') AS paused`
    )
    .get(taskId, taskId) as { routed: number | null; paused: number | null };
  return !!(row?.routed && row?.paused && row.paused > row.routed);
}

// The pause card, shared by both callers: the failed-merge path below and the
// dispute escalation, which fires while the task is being HELD and so never
// reaches a merge attempt of its own.
async function createLandPauseCard(
  db: DB,
  node: LandNode,
  reason: string,
  dispute: string | null,
  code: string | undefined
): Promise<void> {
  const { createDecision } = await import("./api.ts");
  const head = headShaOf(db, node.id);
  // Only a confirmed risk has a stored verdict to set aside, and only the first
  // ask on a commit can tell the director anything new.
  const riskRecheckOffered = isConfirmedRiskFailure(code) && !!head && !riskRechecksAtHead(db, node.id, head);
  const decision = createDecision(db, {
    task_id: node.id,
    title: `PR #${node.number} paused in the land queue`,
    context:
      `${node.title}\n\nIt is still approved to land, but the merge stopped: ${reason.slice(0, 300)}\n\n` +
      (dispute
        ? `Hive sent this finding to the agent first. The agent disputes it: “${dispute.slice(0, 500)}” — ` +
          `that argument is why you are seeing this instead of a fix.\n\n`
        : isConfirmedRiskFailure(code)
          ? `Hive already relayed this finding to the agent on this same commit and the branch came back unfixed.\n\n`
          : "") +
      (isCapacityLandFailure(reason)
        ? `That looks like a busy shared route, not a problem with the branch. Hive already waited it out over ` +
          `about an hour and it did not clear, so it stopped retrying: each attempt spends the same capacity that ` +
          `was short. Retry once the fleet is quieter, or take it out of the queue (\`hive land ${node.id} --off\`).`
        : `Retrying only helps if that cause has changed. Nothing has changed on its own, so the same merge will ` +
          `fail the same way. Hive retries once and then holds the PR quietly until the agent pushes a new commit ` +
          `or you take it out of the queue (\`hive land ${node.id} --off\`).`),
    options: [
      { key: "send_back", label: "Send it back to the agent", detail: "Unmark it and ask the agent to fix what blocked the merge.", recommended: true },
      { key: "unqueue", label: "Take it out of the queue", detail: "Leave the PR open and unmarked. Nothing is sent to the agent." },
      // HIVE-588: "try landing it again" is honest for a cause you can fix
      // yourself, but a CONFIRMED risk is a stored verdict — re-attempting
      // re-reads the same row and fails the same way, so the option looked
      // real and behaved like a no-op. On a risk card it is replaced by the
      // one answer that changes something: say why the finding is wrong, and
      // hive re-runs the check with your reasoning in front of it. Offered
      // once per commit, because a second identical ask is the no-op again.
      riskRecheckOffered
        ? {
            key: "recheck",
            label: "The finding is wrong — re-run the check",
            detail:
              "Write why in the note. Hive sets the stored verdict aside and runs the risk check again on this same commit, with your reasoning in front of it. If it confirms the risk again, the merge stays blocked.",
          }
        : { key: "retry", label: "Try landing it again", detail: "Only if you just fixed the cause yourself. One more attempt, then hive holds it." },
    ],
  });
  writeEvent(db, {
    task_id: node.id,
    source: "reconciler",
    type: "land_paused",
    payload: { decision_id: decision.id, reason, code, head_sha: head, ...(dispute ? { dispute: true } : {}) },
  });
}

// Consecutive trailing NON-transient failures against `headSha`. A success, a
// transient failure, a fresh `land_queued` mark or an attempt on a different
// head ends the run — the count is about this commit and this blocker.
function nonTransientFailuresAtHead(db: DB, taskId: string, headSha: string | null): number {
  const rows = db
    .query(
      `SELECT payload FROM events
        WHERE task_id = ? AND type IN ('land_attempted', 'land_queued')
        ORDER BY rowid DESC LIMIT 20`
    )
    .all(taskId) as { payload: string }[];
  let failures = 0;
  for (const row of rows) {
    let payload: any = {};
    try {
      payload = JSON.parse(row.payload ?? "{}");
    } catch {}
    if (payload.ok !== false || payload.transient) break;
    // Attempts written before this field existed carry no head: treat them as
    // "unknown head" and stop counting rather than blocking on stale history.
    if ((payload.head_sha ?? null) !== headSha) break;
    failures++;
  }
  return failures;
}

// Log the hold once per episode, not once per 30s sweep.
function alreadyBlocked(db: DB, taskId: string): boolean {
  const row = db
    .query(
      `SELECT type FROM events
        WHERE task_id = ? AND type IN ('land_blocked', 'land_attempted', 'land_queued', 'land_unqueued')
        ORDER BY rowid DESC LIMIT 1`
    )
    .get(taskId) as { type: string } | undefined;
  return row?.type === "land_blocked";
}

interface RetryState {
  transientFailures: number; // consecutive transient failures since the last non-attempt
  capacityFailures: number; // of those, the ones caused by a shortage (timeout, 429, 503)
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
  let capacityFailures = 0;
  let lastAttemptMs = 0;
  for (const row of rows) {
    let payload: any = {};
    try {
      payload = JSON.parse(row.payload ?? "{}");
    } catch {}
    if (payload.ok !== false || !payload.transient) break;
    if (!lastAttemptMs) lastAttemptMs = Date.parse(row.ts) || 0;
    transientFailures++;
    // Classified from the reason already stored on the attempt, so old rows and
    // rows written before this existed read correctly with no new field.
    if (isCapacityLandFailure(String(payload.reason ?? ""))) capacityFailures++;
  }
  return { transientFailures, capacityFailures, lastAttemptMs };
}

// Is this task inside its backoff window, i.e. too soon to retry again?
// A run that contains ANY capacity failure waits on the long curve. Mixing the
// two the other way round would let one "base moved" in between reset a
// congested task back to a 30s cadence.
function backingOff(state: RetryState, nowMs: number): boolean {
  if (!state.transientFailures || !state.lastAttemptMs) return false;
  let wait = RETRY_BACKOFF_MS[Math.min(state.transientFailures, RETRY_BACKOFF_MS.length) - 1];
  if (state.capacityFailures)
    wait = Math.max(wait, CAPACITY_BACKOFF_MS[Math.min(state.capacityFailures, CAPACITY_BACKOFF_MS.length) - 1]);
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
export function resolveLandPauseForDecision(
  db: DB,
  decisionId: string,
  answerKey: string,
  answerNote?: string | null
): boolean {
  const ev = db
    .query(
      "SELECT task_id, json_extract(payload, '$.head_sha') AS head_sha FROM events WHERE type = 'land_paused' AND json_extract(payload, '$.decision_id') = ? LIMIT 1"
    )
    .get(decisionId) as { task_id: string; head_sha: string | null } | undefined;
  if (!ev) return false;
  // HIVE-588: the director read the finding and says it is wrong. The argument
  // is the valuable part and it used to have nowhere to go — on one task the
  // refutation was a commit date and two PR numbers, checkable in seconds, and
  // the queue re-refused twice against the stored verdict anyway. Now the
  // verdict for this head is set aside, the check re-runs from scratch, and
  // the reasoning reaches it: the verify prompt already reads answered
  // decisions as settled rulings. It is NOT an override — a re-run that
  // confirms the risk again blocks the merge exactly as before.
  if (answerKey === "recheck") {
    // The ruling is about the commit the card was BUILT on, not whatever the
    // branch points at now. A card can sit open for hours and the agent can
    // push in the meantime, so reading the live head here would set aside
    // verdicts about brand-new code the director never saw. If the head has
    // moved, the card is stale: set nothing aside and just re-arm, and the
    // sweep checks the new commit from scratch — same rule the merge gate
    // already applies to a verdict whose head no longer matches.
    const live = headShaOf(db, ev.task_id);
    const head = ev.head_sha ?? live;
    const moved = !!ev.head_sha && !!live && live !== ev.head_sha;
    if (head && !moved) requestRiskRecheck(db, ev.task_id, head, answerNote ?? null);
    // Re-arm the queue: a `land_queued` mark ends the failed-attempt run, which
    // is what otherwise holds a task after two failures on one commit.
    markLand(db, [ev.task_id], true);
    return true;
  }
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
  // A new head_sha closes the card too: the agent pushed, so the verdict that
  // stopped the merge may genuinely differ now and the old question is stale.
  const rows = db
    .query(
      `SELECT d.id AS id, d.title AS title,
              json_extract(e.payload, '$.reason') AS pause_reason,
              t.state AS state, t.land_queued_at AS land_queued_at
         FROM events e
         JOIN decisions d ON d.id = json_extract(e.payload, '$.decision_id')
         JOIN tasks t ON t.id = e.task_id
        WHERE e.type = 'land_paused' AND d.status = 'open'
          AND (t.state != 'in_review' OR t.land_queued_at IS NULL
               OR (t.head_sha IS NOT NULL AND json_extract(e.payload, '$.head_sha') IS NOT NULL
                   AND t.head_sha != json_extract(e.payload, '$.head_sha')))`
    )
    .all() as { id: string; title: string; pause_reason: string | null; state: string; land_queued_at: string | null }[];
  for (const r of rows) {
    const { apiDismissDecision } = await import("./api.ts");
    // The card is about the PAUSE, so it ends when the pause ends. But the
    // reason the merge stopped is the part the director was reading, and taking
    // the PR out of the queue is the RIGHT answer to a permanent failure — so
    // closing the card must not be how that explanation disappears (HIVE-570).
    // It is repeated here, along with what actually ended the pause.
    const ended =
      r.state !== "in_review"
        ? "the task left review"
        : !r.land_queued_at
          ? "you took it out of the land queue"
          : "the agent pushed a new commit";
    apiDismissDecision(db, r.id, {
      reason: "land_blocker_cleared",
      why:
        `Hive closed this because ${ended}, so the pause it asked about is over.` +
        (r.pause_reason ? ` The merge had stopped with: ${String(r.pause_reason).slice(0, 300)}` : ""),
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

// The commit the PR currently points at. `null` when hive has not synced one
// yet; a null head simply means "no re-arm signal available", never a block.
function headShaOf(db: DB, taskId: string): string | null {
  return (db.query("SELECT head_sha FROM tasks WHERE id = ?").get(taskId) as { head_sha: string | null } | undefined)?.head_sha ?? null;
}

function lastLandFailureReason(db: DB, taskId: string): string | null {
  const row = db
    .query("SELECT payload FROM events WHERE task_id = ? AND type = 'land_attempted' ORDER BY rowid DESC LIMIT 1")
    .get(taskId) as { payload: string } | undefined;
  try {
    return JSON.parse(row?.payload ?? "{}")?.reason ?? null;
  } catch {
    return null;
  }
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
// card for that task and holds it until the card is answered, and gets at most
// one retry after that: a permanent blocker gives the same answer on the same
// commit every sweep, so hive holds the task instead of re-failing it forever
// (HIVE-555). A new head_sha or a human re-arms it.
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
    const failed: { node: LandNode; reason: string; code: string | undefined }[] = [];

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
        // still enter the same batch (they land one after another, not at once).
        if (n.ci_status === "failing" || n.ci_status === "pending") continue;
        // The reviewer has not spoken for this head yet (HIVE-581). The merge
        // asks understandingChecksRequired, and that reads "no verdict" as
        // "needs a check" — so attempting now refuses a task that would land
        // free a couple of minutes later. Nothing here needs a human, so hold
        // quietly: no attempt, no failed land_attempted, no pause card.
        // reviewPipelineSettled (not a bare !verdict) is what keeps a project
        // with auto review off, or a task with no head, from stalling forever.
        // The ceiling keeps an erroring reviewer from wedging the task in
        // silence: past it, fall through and attempt the merge as before.
        if (
          !reviewPipelineSettled(db, { id: n.id, head_sha: headShaOf(db, n.id), project_id }) &&
          !reviewWaitExpired(db, n.id, headShaOf(db, n.id), nowMs)
        )
          continue;
        // A pause card already waiting on the director holds the task too —
        // otherwise every sweep would re-attempt and re-ask the same question.
        if (openPauseDecisionId(db, n.id)) continue;
        // The agent argued back about a risk hive relayed to it (HIVE-559). It
        // is being held below (a queued steer, an unaddressed change request),
        // so no merge attempt will ever reach the card path at the end of this
        // sweep — the escalation has to happen here.
        const argued = pendingRiskDispute(db, n.id, headShaOf(db, n.id));
        if (argued && !escalatedSinceRelay(db, n.id)) {
          await createLandPauseCard(db, n, argued.reason, argued.dispute, argued.code);
          continue;
        }
        if (backingOff(retryState(db, n.id), nowMs)) continue;
        // Retried once against an unchanged blocker and an unchanged commit:
        // stop. Only a new head_sha or a human re-arms it (HIVE-555).
        if (nonTransientFailuresAtHead(db, n.id, headShaOf(db, n.id)) >= MAX_NON_TRANSIENT_ATTEMPTS) {
          if (!alreadyBlocked(db, n.id))
            writeEvent(db, {
              task_id: n.id,
              source: "reconciler",
              type: "land_blocked",
              payload: { reason: lastLandFailureReason(db, n.id), head_sha: headShaOf(db, n.id) },
            });
          continue;
        }
        // Out of attempts: stop retrying a merge that keeps refusing, and tell
        // the director rather than looping in silence.
        if (failedAttemptRun(db, n.id) >= MAX_LAND_ATTEMPTS) {
          db.query("UPDATE tasks SET land_queued_at = NULL, updated_at = ? WHERE id = ?").run(now(), n.id);
          writeEvent(db, {
            task_id: n.id,
            source: "reconciler",
            type: "land_retry_exhausted",
            payload: { attempts: MAX_LAND_ATTEMPTS },
          });
          enqueue(db, {
            kind: "stale",
            task_id: n.id,
            title: `PR #${n.number} left the land queue after ${MAX_LAND_ATTEMPTS} failed merges`,
            body: `${n.title} — the same merge kept failing, so hive stopped retrying. Fix what blocks it, then queue it again.`,
          });
          pending.delete(n.id);
          continue;
        }
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

      // Land ONE AT A TIME (HIVE-348). These branches don't touch the same
      // files, so merging them together looked safe — but each merge moves the
      // base under the next one, and two `gh pr merge` calls racing on one base
      // is how a commit once vanished. mergeTask re-reads the PR's live base and
      // head on every call, so landing serially means each merge is validated
      // against the base the previous one just created. It also re-reads the
      // mark first: a director unmarking mid-sweep must stop the merges still
      // queued behind the one in flight.
      for (const node of batch) {
        const stillMarked = (db.query("SELECT land_queued_at FROM tasks WHERE id = ?").get(node.id) as { land_queued_at: string | null } | undefined)
          ?.land_queued_at;
        if (!stillMarked) {
          pending.delete(node.id);
          continue;
        }
        const result = await merge(node.id);
        pending.delete(node.id);
        const reason = result.reason ?? "merge failed";
        const code = result.ok ? undefined : codeOfFailure(db, node, reason, result.code);
        // Waiting on the director's quiz answer: hold quietly, log nothing. A
        // sweep runs every 30s and this refusal is a local check, so an event
        // per sweep would be pure timeline noise.
        if (!result.ok && isQuizHold(reason)) continue;
        // A transient cause that has already burned its retries is no longer
        // transient: it is a stall the director needs to see.
        const priorRetries = retryState(db, node.id);
        const transient =
          !result.ok &&
          isTransientLandFailure(reason) &&
          priorRetries.transientFailures < MAX_TRANSIENT_RETRIES &&
          priorRetries.capacityFailures < MAX_CAPACITY_RETRIES;
        if (result.ok) {
          landed.add(node.id);
          db.query("UPDATE tasks SET land_queued_at = NULL WHERE id = ?").run(node.id);
        } else if (!transient) {
          failed.push({ node, reason, code });
        }
        writeEvent(db, {
          task_id: node.id,
          source: "reconciler",
          type: "land_attempted",
          payload: { ok: result.ok, reason: result.reason, ...(result.ok ? {} : { transient, code, head_sha: headShaOf(db, node.id) }) },
        });
      }
    }

    if (landed.size)
      enqueue(db, {
        kind: "auto_merged",
        title: `Landed ${landed.size} PR${landed.size === 1 ? "" : "s"} from the land queue`,
        body: [...landed].map((id) => `#${byId.get(id)?.number}`).join(", "),
      });

    for (const { node, reason, code } of failed) {
      if (openPauseDecisionId(db, node.id)) continue; // already asked
      // HIVE-559: a confirmed risk is agent work. It wrote the code, it can fix
      // the finding, and every one of these the director answered by hand was
      // answered by relaying it. So this runs BEFORE the HIVE-555 quiet-hold
      // gate below: that gate stops the queue after two failures on one commit,
      // and a risk that reached it would go silent with no card ever — the
      // agent ignoring the relay would simply bury the finding. Escalate on a
      // dispute, or once the relay is spent and the same commit still fails.
      if (isConfirmedRiskFailure(code)) {
        // Bounced back to its agent already (a conflict, a change request): the
        // agent has the finding and no card is owed. The held-task escalation
        // earlier in this sweep covers a dispute raised from there.
        if (getTask(db, node.id)?.state !== "in_review") continue;
        const head = headShaOf(db, node.id);
        const dispute = pendingRiskDispute(db, node.id, head)?.dispute ?? null;
        const routes = riskRoutesAtHead(db, node.id, head);
        if (!dispute && routes < MAX_RISK_ROUTES_PER_HEAD) {
          const msg =
            `hive: your PR #${node.number} is held in the land queue — the risk check confirmed a risk on the commit ` +
            `you pushed. This is the finding, verbatim:\n\n${reason}\n\n` +
            `Fix it and push; the merge re-arms itself on the new commit. If you believe the finding is WRONG, do not ` +
            `push a no-op — say why with \`hive emit ${node.id} risk_dispute --note "..."\` and a human reads it. ` +
            `That exact command is the only thing read as a dispute; a plain \`answer\` is not, so it will not reach ` +
            `anyone here. Nothing merges until one of those two things happens.`;
          if (queueSteerEvent(db, node.id, msg, "confirmed risk routed to the agent")) {
            writeEvent(db, {
              task_id: node.id,
              source: "reconciler",
              type: "risk_routed_to_agent",
              payload: { reason, code, head_sha: head, round: routes + 1 },
            });
            continue;
          }
          // Undeliverable — nothing will ever carry it, so ask the director.
        }
        await createLandPauseCard(db, node, reason, dispute, code);
        continue;
      }
      // Already asked once and retried once against this same commit: a second
      // card would ask the identical question with the identical answer. Record
      // the hold and stop (HIVE-555).
      if (nonTransientFailuresAtHead(db, node.id, headShaOf(db, node.id)) >= MAX_NON_TRANSIENT_ATTEMPTS) {
        if (!alreadyBlocked(db, node.id))
          writeEvent(db, {
            task_id: node.id,
            source: "reconciler",
            type: "land_blocked",
            payload: { reason, head_sha: headShaOf(db, node.id) },
          });
        continue;
      }
      // A conflict bounce already sent the task to its agent with rebase
      // instructions. Asking the director what to do about work hive has
      // already routed is the duplicate card this task exists to remove.
      if (getTask(db, node.id)?.state !== "in_review") continue;
      await createLandPauseCard(db, node, reason, null, code);
    }
  }
}
