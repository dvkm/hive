// Auto-reviewer: when a task reaches in_review, a one-shot `claude -p` (sonnet)
// reads the PR diff against the brief and posts a structured pre-review onto
// the review card as an `auto_review` event — verdict, summary, risks,
// questions. The director reviews a screened summary instead of a raw diff
// (review latency is the pipeline ceiling; the diff-reading is the slow part).
//
// Non-blocking and advisory: the task sits in review exactly as before; the
// event just arrives on the card, usually within a cycle. A success (or a
// project-level skip) is final; a failure is retried with backoff up to
// MAX_REVIEW_ATTEMPTS times per PR head, then the card is flagged for a human.
// Per-project opt-out: config.auto_review = false. Model: config.model_by_kind
// .review, else sonnet. Argv override: config.reviewer_argv (verbatim).
import type { DB } from "./db.ts";
import { isOffline, getSetting, setSetting } from "./db.ts";
import { writeEvent, getTask } from "./state.ts";
import { broadcast } from "./bus.ts";
import type { Exec } from "./exec.ts";
import { defaultExec, projectComparisonBase } from "./exec.ts";
import { claudeBin, defaultPlannerExec, type PlannerExec } from "./planner.ts";
import { modelFailure, modelErrorText, noteModelCall, isAuthFailure } from "./modelCall.ts";
import { enqueue } from "./notifications.ts";
import { claudeProfileEnvForProject } from "./claudeProfiles.ts";
import { supervisedSql } from "./supervision.ts";
import { PLAIN_ENGLISH } from "./plainEnglish.ts";
import { parseUnifiedDiff } from "./diff.ts";

const TIMEOUT_MS = Number(process.env.HIVE_REVIEWER_TIMEOUT_MS || 180_000);
const DIFF_LIMIT = 60_000;

export interface ReviewerDeps {
  exec?: PlannerExec; // the claude -p runner (injectable in tests)
  shellExec?: Exec; // gh/git for the diff
}

export interface AutoReview {
  verdict: "looks_good" | "caution";
  summary: string;
  risks: string[];
  questions: string[];
}

// Loose-parse the model output: whole JSON, the `claude -p --output-format
// json` {result:"..."} envelope, or a braces slice of prose.
export function extractReview(raw: string): AutoReview | null {
  const norm = (o: any): AutoReview | null => {
    if (!o || typeof o.summary !== "string" || !o.summary.trim()) return null;
    return {
      verdict: o.verdict === "caution" ? "caution" : "looks_good",
      summary: o.summary.trim(),
      risks: Array.isArray(o.risks) ? o.risks.map(String) : [],
      questions: Array.isArray(o.questions) ? o.questions.map(String) : [],
    };
  };
  const tryParse = (s: string) => {
    try {
      return norm(JSON.parse(s));
    } catch {
      return null;
    }
  };
  const braces = (s: string) => {
    const a = s.indexOf("{");
    const b = s.lastIndexOf("}");
    return a >= 0 && b > a ? tryParse(s.slice(a, b + 1)) : null;
  };
  const whole = tryParse(raw);
  if (whole) return whole;
  try {
    const env = JSON.parse(raw);
    if (env && typeof env.result === "string") return tryParse(env.result) ?? braces(env.result);
  } catch {}
  return braces(raw);
}

async function rawDiff(db: DB, task: any, exec: Exec): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  if (task.pr_url) {
    const r = await exec(["gh", "pr", "diff", task.pr_url, "--patch"]);
    if (r.code !== 0) return { ok: false, error: r.stderr.trim() || `gh pr diff exited ${r.code}` };
    return { ok: true, text: r.stdout };
  }
  const project: any = db.query("SELECT repo_path, config FROM projects WHERE id = ?").get(task.project_id);
  if (!project?.repo_path || !task.branch) return { ok: false, error: "no pr_url and no branch to diff" };
  const base = projectComparisonBase(JSON.parse(project.config ?? "{}"));
  const r = await exec(["git", "-C", project.repo_path, "diff", `${base}...${task.branch}`]);
  if (r.code !== 0) return { ok: false, error: r.stderr.trim() || `git diff exited ${r.code}` };
  return { ok: true, text: r.stdout };
}

// The live PR head, read fresh right before diffing and again after the (slow)
// LLM call — a force-push or PR replacement mid-review must not let a stale
// verdict land on the new head (task HIVE-307).
async function livePrHead(exec: Exec, prUrl: string): Promise<string | null> {
  const r = await exec(["gh", "pr", "view", prUrl, "--json", "headRefOid"]);
  if (r.code !== 0) return null;
  try {
    const data = JSON.parse(r.stdout || "{}");
    return typeof data.headRefOid === "string" && data.headRefOid ? data.headRefOid : null;
  } catch {
    return null;
  }
}

function reviewPrompt(task: any, diff: string): string {
  return [
    `You are pre-reviewing a PR for a busy human reviewer. Be terse and concrete; no praise, no filler.`,
    ``,
    `Task #${task.number}: ${task.title}`,
    `Brief:\n${(task.brief ?? "").slice(0, 4000)}`,
    ``,
    `Diff (may be truncated):`,
    diff.slice(0, DIFF_LIMIT),
    ``,
    PLAIN_ENGLISH,
    ``,
    `Answer as ONLY a JSON object, no prose around it:`,
    `{"verdict": "looks_good" | "caution",`,
    ` "summary": "2-3 sentences: what the change does and whether it matches the brief",`,
    ` "risks": ["each concrete risk/bug/scope-creep, with file:line when possible"],`,
    ` "questions": ["only questions the human MUST answer before merging"]}`,
    `Rules: verdict 'caution' if anything in risks would block YOUR merge. Empty arrays are fine.`,
    `Each risk and question must add something new — never restate the summary or another bullet.`,
  ].join("\n");
}

// A failed pre-review used to be as final as a successful one: one
// `auto_review_error` at the current head and the task was never picked again,
// so any transient blip (a model timeout, a rate limit, an expired login)
// silently retired that card until someone pushed a new commit. An auth outage
// left 31 of 36 review cards in exactly that state (HIVE-497). So failures now
// get a bounded retry budget per PR head instead.
export const MAX_REVIEW_ATTEMPTS = 5;
const RETRY_BASE_MS = 5 * 60_000; // 5, 10, 20, 40 min between tries
const MAX_RETRY_DELAY_MS = 60 * 60_000;

// Does this recorded review event describe the head we are about to review?
// Without a PR there is no head to key to, so any event for the task counts.
function coversHead(payload: any, task: any): boolean {
  if (!task.pr_url) return true;
  return payload?.reviewed_pr_url === task.pr_url && payload?.reviewed_head_sha === task.head_sha;
}

// Failed pre-reviews already recorded for this task at this head, newest first.
// `auth` marks the ones that were a property of the FLEET (no valid login), not
// of this task.
export function failedReviewAttempts(db: DB, task: any): { ts: string; error: string; auth: boolean }[] {
  const rows: any[] = db
    .query(`SELECT ts, payload FROM events WHERE task_id = ? AND type = 'auto_review_error' ORDER BY ts DESC, rowid DESC`)
    .all(task.id);
  const out: { ts: string; error: string; auth: boolean }[] = [];
  for (const r of rows) {
    let payload: any;
    try {
      payload = JSON.parse(r.payload);
    } catch {
      continue;
    }
    if (!coversHead(payload, task)) continue;
    const error = String(payload?.error ?? "");
    out.push({ ts: r.ts, error, auth: isAuthFailure(error) });
  }
  return out;
}

// Ready to try again? Every failure, auth or not, delays the next try — one
// broken login must not turn the reviewer into a hot loop. But only the
// non-auth ones spend the give-up budget: a fleet-wide outage is not this
// card's fault, and that is also what frees the cards the HIVE-491 outage
// poisoned, with no new commit and no manual sweep.
function retryDue(attempts: { ts: string; auth: boolean }[], nowMs = Date.now()): boolean {
  if (!attempts.length) return true;
  if (attempts.filter((a) => !a.auth).length >= MAX_REVIEW_ATTEMPTS) return false;
  const lastMs = Date.parse(attempts[0]!.ts);
  if (!Number.isFinite(lastMs)) return true;
  return nowMs - lastMs >= Math.min(RETRY_BASE_MS * 2 ** (attempts.length - 1), MAX_RETRY_DELAY_MS);
}

// Record a failed pre-review. When the give-up budget for this head runs out
// the event carries `gave_up` and the director gets one notification: a card
// hive has stopped trying to review must not keep looking like one it simply
// has not got to yet.
function recordReviewFailure(db: DB, task: any, error: string, reviewIdentity: Record<string, unknown>): void {
  const auth = isAuthFailure(error);
  const spent = failedReviewAttempts(db, task).filter((a) => !a.auth).length + (auth ? 0 : 1);
  const gaveUp = !auth && spent >= MAX_REVIEW_ATTEMPTS;
  writeEvent(db, {
    task_id: task.id,
    source: "system",
    type: "auto_review_error",
    payload: { error, attempts: spent, ...(gaveUp ? { gave_up: true } : {}), ...reviewIdentity },
  });
  if (!gaveUp) return;
  enqueue(db, {
    kind: "failed",
    task_id: task.id,
    title: `Pre-review gave up on #${task.number}`,
    body: `Hive tried to pre-review this ${MAX_REVIEW_ATTEMPTS} times and failed every time. Review it yourself, or push a commit so hive tries again. Last error: ${error.slice(0, 200)}`,
  });
}

// One review per pass (no stampede when a backlog of reviews appears at once).
export async function autoReviewOnce(db: DB, deps: ReviewerDeps = {}): Promise<void> {
  if (isOffline(db)) return;
  // A success — a real review or a project-level skip — is what retires a card
  // at this head. Failures are weighed per candidate below, where the auth
  // class and the backoff clock can be read.
  const candidates: any[] = db
    .query(
      `SELECT t.* FROM tasks t
        WHERE t.state = 'in_review'
          AND NOT EXISTS (
            SELECT 1 FROM events e WHERE e.task_id = t.id AND e.type = 'auto_review'
              AND json_valid(e.payload)
              AND (
                t.pr_url IS NULL
                OR json_extract(e.payload, '$.skipped') IS NOT NULL
                OR (
                  json_extract(e.payload, '$.reviewed_pr_url') = t.pr_url
                  AND json_extract(e.payload, '$.reviewed_head_sha') = t.head_sha
                )
              )
          )
          AND ${supervisedSql("t.source", "t.agent_target")}
        ORDER BY t.updated_at ASC`
    )
    .all();
  const t: any = candidates.find((c) => retryDue(failedReviewAttempts(db, c)));
  if (!t) return;
  // Guards against a delayed/stale review landing after the task moved on
  // (state left in_review, or the linked PR/branch/head changed underneath
  // it) — the review this pass produces is only good for the exact task and
  // PR head captured here.
  const stillCurrent = (): boolean => {
    const current: any = getTask(db, t.id);
    return !!current
      && current.state === "in_review"
      && current.pr_url === t.pr_url
      && current.branch === t.branch
      && (!t.pr_url || current.head_sha === t.head_sha);
  };
  const project: any = db.query("SELECT repo_path, config FROM projects WHERE id = ?").get(t.project_id);
  const config = JSON.parse(project?.config ?? "{}");
  if (config.auto_review === false) {
    writeEvent(db, { task_id: t.id, source: "system", type: "auto_review", payload: { skipped: "disabled by project config" } });
    return;
  }

  const shell = deps.shellExec ?? defaultExec;
  // Refresh the exact head being reviewed BEFORE the diff is pulled, so a
  // force-push that lands right before this pass reviews its own new head
  // instead of silently diffing the old one.
  let reviewedHead: string | null = null;
  if (t.pr_url) {
    reviewedHead = await livePrHead(shell, t.pr_url);
    if (!reviewedHead || !stillCurrent()) return;
    db.query("UPDATE tasks SET head_sha = ? WHERE id = ? AND pr_url = ?").run(reviewedHead, t.id, t.pr_url);
    t.head_sha = reviewedHead;
  }
  const reviewIdentity = t.pr_url ? { reviewed_pr_url: t.pr_url, reviewed_head_sha: reviewedHead } : {};
  const diff = await rawDiff(db, t, shell);
  if (!stillCurrent() || (t.pr_url && (await livePrHead(shell, t.pr_url)) !== reviewedHead)) return;
  if (!diff.ok) {
    recordReviewFailure(db, t, diff.error, reviewIdentity);
    return;
  }
  const base: string[] =
    Array.isArray(config.reviewer_argv) && config.reviewer_argv.length
      ? [...config.reviewer_argv]
      : [claudeBin(), "-p", "--model", config.model_by_kind?.review ?? "sonnet"];
  const buildArgv = (prompt: string) => [...base, prompt, "--output-format", "json"];
  const argv = buildArgv(reviewPrompt(t, diff.text));

  const exec = deps.exec ?? defaultPlannerExec;
  let res;
  try {
    res = await exec(argv, {
      timeoutMs: TIMEOUT_MS,
      ...(project?.repo_path ? { cwd: project.repo_path } : {}),
      env: claudeProfileEnvForProject(db, t.project_id),
    });
  } catch (e: any) {
    if (!stillCurrent() || (t.pr_url && (await livePrHead(shell, t.pr_url)) !== reviewedHead)) return;
    recordReviewFailure(db, t, String(e?.message ?? e), reviewIdentity);
    return;
  }
  // The LLM call is the slow part (up to TIMEOUT_MS) — re-check right after it
  // returns, before trusting anything it said about this head.
  if (!stillCurrent() || (t.pr_url && (await livePrHead(shell, t.pr_url)) !== reviewedHead)) return;
  if (res.timedOut || res.code !== 0) {
    recordReviewFailure(db, t, modelFailure(db, res, { timeoutMs: TIMEOUT_MS }), reviewIdentity);
    return;
  }
  noteModelCall(db, null);
  let review = extractReview(res.stdout);
  if (!review) {
    // Retry once with a stricter format instruction before giving up — most
    // unparseable output is prose wrapped around the JSON, not a model that
    // refuses the format outright (task HIVE-446).
    const retryArgv = buildArgv(`${reviewPrompt(t, diff.text)}\n\nSTRICT: output ONLY the JSON object, nothing else — no prose, no markdown fences.`);
    let retryRes;
    try {
      retryRes = await exec(retryArgv, { timeoutMs: TIMEOUT_MS });
    } catch {
      retryRes = null;
    }
    if (!stillCurrent() || (t.pr_url && (await livePrHead(shell, t.pr_url)) !== reviewedHead)) return;
    if (retryRes && !retryRes.timedOut && retryRes.code === 0) review = extractReview(retryRes.stdout);
  }
  if (!review) {
    // Two unparseable attempts in a row is a dead end, not a transient blip:
    // record a real verdict (not just an error) so autoMergeReady/land surfaces
    // stop showing "-" forever, and the NOT EXISTS guard in the query above
    // stops retrying this exact head.
    const streak = Number(getSetting(db, "reviewer_parse_failure_streak") ?? "0") + 1;
    setSetting(db, "reviewer_parse_failure_streak", String(streak));
    writeEvent(db, {
      task_id: t.id,
      source: "system",
      type: "auto_review",
      payload: { verdict: "unparseable", summary: "auto-reviewer produced unparseable output twice; needs a human look", risks: [], questions: [], ...reviewIdentity },
    });
    broadcast({ type: "task", task: getTask(db, t.id) });
    return;
  }
  setSetting(db, "reviewer_parse_failure_streak", "0");
  // `files` is what the reviewed diff touched. Read back by
  // understandingChecksRequired (hive-1559) to spot sensitive paths without
  // re-shelling out to git for every task on a director surface.
  const files = parseUnifiedDiff(diff.text).files.map((f) => f.path);
  writeEvent(db, { task_id: t.id, source: "system", type: "auto_review", payload: { ...review, files, ...reviewIdentity } as any });
  broadcast({ type: "task", task: getTask(db, t.id) });
  // Any risk or question the pre-reviewer wrote is a suspicion — check each one
  // against the real code before it blocks the merge. Not caution-only: a
  // looks_good review with soft notes would otherwise veto its own auto-merge
  // forever. PR-backed tasks only: without a PR head there is nothing to key
  // the verdicts to.
  if (reviewedHead && (review.risks.length || review.questions.length)) {
    await verifyRisks(
      db,
      t,
      {
        risks: review.risks,
        questions: review.questions,
        head: reviewedHead,
        diff: diff.text,
        stillCurrent: async () => stillCurrent() && (await livePrHead(shell, t.pr_url)) === reviewedHead,
      },
      deps
    );
  }
}

// The latest usable review for a task, or null when there is none (only a skip
// or a malformed payload). Lives with the code that WRITES these events; api.ts
// and reconciler.ts import it rather than keeping a second copy.
//
// Failed attempts (`auto_review_error`) are NOT read here. A later failure does
// not un-review an earlier success: the review happened, and its risk verdicts
// are still keyed to that head. Counting it made autoMergeReady (which reads
// successes only) and understandingChecksRequired (which read both) disagree
// about the same task, so the reconciler asked for a merge every cycle and the
// merge refused every cycle, forever (HIVE-499). Callers that care about
// freshness compare `reviewed_head_sha` to the head they are about to act on.
export interface AutoReviewVerdict {
  verdict: string;
  files: string[];
  risks: string[];
  questions: string[];
  reviewed_pr_url?: string;
  reviewed_head_sha?: string;
}

export function latestAutoReviewVerdict(db: DB, taskId: string): AutoReviewVerdict | null {
  const row = db
    .query(
      `SELECT payload FROM events WHERE task_id = ? AND type = 'auto_review'
        ORDER BY ts DESC, rowid DESC LIMIT 1`
    )
    .get(taskId) as { payload: string } | undefined;
  return row ? parseAutoReview(row.payload) : null;
}

// The row-to-verdict half of latestAutoReviewVerdict, so the batched form
// (reviewActionableBatch) reads an auto_review row exactly the same way.
function parseAutoReview(raw: string): AutoReviewVerdict | null {
  try {
    const payload = JSON.parse(raw);
    if (payload?.skipped || typeof payload?.verdict !== "string") return null;
    return {
      verdict: payload.verdict,
      files: Array.isArray(payload.files) ? payload.files.map(String) : [],
      risks: Array.isArray(payload.risks) ? payload.risks.map(String) : [],
      questions: Array.isArray(payload.questions) ? payload.questions.map(String) : [],
      reviewed_pr_url: typeof payload.reviewed_pr_url === "string" ? payload.reviewed_pr_url : undefined,
      reviewed_head_sha: typeof payload.reviewed_head_sha === "string" ? payload.reviewed_head_sha : undefined,
    };
  } catch {
    return null;
  }
}

// Risks are normally verified at the tail of autoReviewOnce, but that pass
// never revisits a task it has already reviewed at this head. So a review whose
// verification did not finish keeps NO covering verdict set and nothing ever
// produces one: ambiguityCleared rejects it on every lap and the task parks in
// review with no card, no signal and no way out. Two ways in, both seen live:
//   - verifyRisks returned early (stillCurrent went false mid-pass, or a run
//     timed out) before it could write its event, and
//   - a SECOND auto_review landed for the same head with a different risk list,
//     leaving the first pass's verdicts no longer covering the latest review.
// This pass is the missing half — it verifies any in_review task whose latest
// review is still uncovered, whether or not that review is new.
export async function verifyPendingOnce(db: DB, deps: ReviewerDeps = {}): Promise<void> {
  if (isOffline(db)) return;
  const shell = deps.shellExec ?? defaultExec;
  const rows: any[] = db
    .query(
      `SELECT t.* FROM tasks t
        WHERE t.state = 'in_review' AND ${supervisedSql("t.source", "t.agent_target")}
        ORDER BY t.updated_at ASC`
    )
    .all();
  for (const t of rows) {
    if (!t.head_sha) continue; // nothing to key verdicts to
    const project: any = db.query("SELECT config FROM projects WHERE id = ?").get(t.project_id);
    if (JSON.parse(project?.config ?? "{}").auto_review === false) continue;
    const review = latestAutoReviewVerdict(db, t.id);
    if (!review || review.reviewed_head_sha !== t.head_sha) continue;
    const risks = (review.risks ?? []).slice(0, MAX_VERIFIED_RISKS);
    const questions = (review.questions ?? []).slice(0, MAX_VERIFIED_QUESTIONS);
    if (!risks.length && !questions.length) continue;
    if (hasRiskVerdicts(db, t.id, t.head_sha, risks.length + questions.length)) continue;
    const diff = await rawDiff(db, t, shell);
    if (!diff.ok) continue;
    console.error(`[hive] verifying uncovered review for task ${t.id} at ${String(t.head_sha).slice(0, 7)}`);
    await verifyRisks(
      db,
      t,
      {
        risks,
        questions,
        head: t.head_sha,
        diff: diff.text,
        stillCurrent: async () => {
          const current: any = getTask(db, t.id);
          return (
            !!current &&
            current.state === "in_review" &&
            current.head_sha === t.head_sha &&
            (!t.pr_url || (await livePrHead(shell, t.pr_url)) === t.head_sha)
          );
        },
      },
      deps
    );
    return; // one per pass, same no-stampede rule autoReviewOnce follows
  }
}

export function startAutoReviewer(db: DB, deps: ReviewerDeps & { intervalMs?: number } = {}): () => void {
  const timer = setInterval(() => {
    autoReviewOnce(db, deps)
      .then(() => verifyPendingOnce(db, deps))
      .catch((e) => console.error("[hive] auto-review crashed:", e));
  }, deps.intervalMs ?? 60_000);
  return () => clearInterval(timer);
}

// ---------------------------------------------------------------------------
// Per-risk adversarial verification (tasks HIVE-406, HIVE-407).
//
// A pre-review lists risks the sonnet reviewer *suspects* and questions it
// wants answered. Some are real, some are the model pattern-matching on a diff
// it can only see a window of. So each one gets its own opus one-shot that can
// read the actual worktree: risks are confirmed or refuted, questions are
// answered from the code or handed to the human. The verdicts land as ONE
// `risk_verdicts` event on the card, so the director reads "3 of 5 were
// refuted" instead of five maybes — and a fully refuted/answered set lets the
// reconciler auto-merge (see ambiguityCleared).
//
// Keyed to the reviewed PR head: it re-runs only when the pre-review itself
// re-runs for a new head, and never twice for the same one.
const MAX_VERIFIED_RISKS = 5;
const MAX_VERIFIED_QUESTIONS = 5;
const VERIFY_MODEL = "opus";

export interface RiskVerdict {
  risk: string;
  verdict: "confirmed" | "refuted";
  why: string;
  evidence_path?: string;
}

// A question is only cleared when the code itself answers it. "Did you check
// this on the installed app?" needs the human — it stays a merge veto.
export interface QuestionVerdict {
  question: string;
  answerable: "machine" | "human";
  answer: string;
}

// Same loose parsing as extractReview: whole JSON, the `--output-format json`
// {result:"..."} envelope, or a braces slice of prose. `norm` decides what
// shape counts, so a parse that yields the wrong shape keeps falling through.
function looseParse<T>(raw: string, norm: (o: any) => T | null): T | null {
  const tryParse = (s: string) => {
    try {
      return norm(JSON.parse(s));
    } catch {
      return null;
    }
  };
  const braces = (s: string) => {
    const a = s.indexOf("{");
    const b = s.lastIndexOf("}");
    return a >= 0 && b > a ? tryParse(s.slice(a, b + 1)) : null;
  };
  const whole = tryParse(raw);
  if (whole) return whole;
  try {
    const env = JSON.parse(raw);
    if (env && typeof env.result === "string") return tryParse(env.result) ?? braces(env.result);
  } catch {}
  return braces(raw);
}

export function extractVerdict(raw: string): { verdict: "confirmed" | "refuted"; why: string; evidence_path?: string } | null {
  return looseParse(raw, (o: any) => {
    if (!o || (o.verdict !== "confirmed" && o.verdict !== "refuted")) return null;
    const out: any = { verdict: o.verdict, why: String(o.why ?? "").trim().slice(0, 300) };
    if (typeof o.evidence_path === "string" && o.evidence_path.trim()) out.evidence_path = o.evidence_path.trim();
    return out;
  });
}

export function extractAnswer(raw: string): { answerable: "machine" | "human"; answer: string } | null {
  return looseParse(raw, (o: any) => {
    if (!o || (o.answerable !== "machine" && o.answerable !== "human")) return null;
    return { answerable: o.answerable, answer: String(o.answer ?? "").trim().slice(0, 300) };
  });
}

function verifyPrompt(task: any, risk: string, diff: string): string {
  return [
    `A code reviewer flagged ONE risk on a pull request. Decide whether it is real.`,
    `Be adversarial: try to refute it. Say 'confirmed' only if you can point at the code that makes it true.`,
    ``,
    `Risk: ${risk}`,
    ``,
    `Task #${task.number}: ${task.title}`,
    task.worktree_path ? `The full checkout is at ${task.worktree_path} — read files there to check. Do not edit anything.` : ``,
    ``,
    `Diff (may be truncated):`,
    diff.slice(0, DIFF_LIMIT),
    ``,
    PLAIN_ENGLISH,
    ``,
    `Answer as ONLY a JSON object, no prose around it:`,
    `{"verdict": "confirmed" | "refuted",`,
    ` "why": "one or two sentences, 300 characters or fewer",`,
    ` "evidence_path": "file:line you checked, if any"}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function answerPrompt(task: any, question: string, diff: string): string {
  return [
    `A code reviewer asked ONE question about a pull request before merging it.`,
    `Decide who can answer it. Answer it yourself ("machine") only if reading this repository settles it.`,
    `Say "human" when the answer needs something outside the code: a manual check on a running or installed app,`,
    `product intent, a business decision, credentials, or anything only the director knows.`,
    `If you are unsure, say "human".`,
    ``,
    `Question: ${question}`,
    ``,
    `Task #${task.number}: ${task.title}`,
    task.worktree_path ? `The full checkout is at ${task.worktree_path} — read files there to check. Do not edit anything.` : ``,
    ``,
    `Diff (may be truncated):`,
    diff.slice(0, DIFF_LIMIT),
    ``,
    PLAIN_ENGLISH,
    ``,
    `Answer as ONLY a JSON object, no prose around it:`,
    `{"answerable": "machine" | "human",`,
    ` "answer": "the answer if you can give it, otherwise what the human must check — 300 characters or fewer"}`,
  ]
    .filter(Boolean)
    .join("\n");
}

// Already verified for this exact PR head? Then don't spend the model again.
//
// The head alone is not enough to answer that. autoReviewOnce can write a
// SECOND auto_review for the same head (overlapping reconciler laps), and the
// new review's risk and question lists are regenerated, so they routinely
// differ from the ones the stored verdicts were produced for. Keying only on
// the head made that set look reusable forever, while ambiguityCleared compares
// it against the LATEST review and rejects it on the count mismatch — the task
// parks with no card and no signal, and nothing ever re-runs the pass to fix it
// (observed on HIVE-445/HIVE-455: 3 risks vs 2 verdicts, 1 question vs 0).
//
// So a stored set counts as covering this review only when it accounts for
// every risk and question the review actually raised. Anything else re-verifies.
function hasRiskVerdicts(db: DB, taskId: string, head: string, expected: number): boolean {
  const rows = db.query("SELECT payload FROM events WHERE task_id = ? AND type = 'risk_verdicts'").all(taskId) as { payload: string }[];
  return rows.some((r) => coversReview(r.payload, head, expected));
}

// One opus run per risk and per question, in sequence, each capped. A run that
// fails or returns junk is left out and counted in `unverified`, so a broken
// run never reads as an all-clear. `stillCurrent` is re-checked between runs:
// these verdicts now decide whether a PR auto-merges, so a set produced for a
// head that has since been force-pushed must never be written at all.
export async function verifyRisks(
  db: DB,
  task: any,
  input: { risks?: string[]; questions?: string[]; head: string; diff: string; stillCurrent?: () => boolean | Promise<boolean> },
  deps: ReviewerDeps = {}
): Promise<void> {
  const risks = (input.risks ?? []).slice(0, MAX_VERIFIED_RISKS);
  const questions = (input.questions ?? []).slice(0, MAX_VERIFIED_QUESTIONS);
  if (!risks.length && !questions.length) return;
  if (hasRiskVerdicts(db, task.id, input.head, risks.length + questions.length)) return;
  const exec = deps.exec ?? defaultPlannerExec;
  const current = async () => (input.stillCurrent ? await input.stillCurrent() : true);
  const run = async (prompt: string) => {
    try {
      return await exec([claudeBin(), "-p", "--model", VERIFY_MODEL, prompt, "--output-format", "json"], {
        timeoutMs: TIMEOUT_MS,
        cwd: task.worktree_path ?? undefined,
        env: claudeProfileEnvForProject(db, task.project_id),
      });
    } catch {
      return null;
    }
  };
  const verdicts: RiskVerdict[] = [];
  const question_verdicts: QuestionVerdict[] = [];
  let unverified = 0;
  // The reason the last run failed. `unverified` alone reads as "the model was
  // unsure"; an auth outage is a completely different story (hive-1800).
  let unverified_reason: string | null = null;
  for (const risk of risks) {
    if (!(await current())) return;
    const res = await run(verifyPrompt(task, risk, input.diff));
    const failed = !res || noteModelCall(db, res.code === 0 && !res.timedOut ? null : modelErrorText(res, { timeoutMs: TIMEOUT_MS }));
    if (typeof failed === "string") unverified_reason = failed;
    const v = failed ? null : extractVerdict(res!.stdout);
    if (v) verdicts.push({ risk, ...v });
    else unverified++;
  }
  for (const question of questions) {
    if (!(await current())) return;
    const res = await run(answerPrompt(task, question, input.diff));
    const failed = !res || noteModelCall(db, res.code === 0 && !res.timedOut ? null : modelErrorText(res, { timeoutMs: TIMEOUT_MS }));
    if (typeof failed === "string") unverified_reason = failed;
    const a = failed ? null : extractAnswer(res!.stdout);
    if (a) question_verdicts.push({ question, ...a });
    else unverified++;
  }
  if (!(await current())) return;
  writeEvent(db, {
    task_id: task.id,
    source: "system",
    type: "risk_verdicts",
    payload: {
      reviewed_head_sha: input.head,
      verdicts,
      ...(question_verdicts.length ? { question_verdicts } : {}),
      ...(unverified ? { unverified } : {}),
      ...(unverified_reason ? { unverified_reason } : {}),
    } as any,
  });
  broadcast({ type: "task", task: getTask(db, task.id) });
}

// Does one stored risk_verdicts row account for this exact head's whole review?
// Split out of hasRiskVerdicts so the batched path applies the identical test.
function coversReview(raw: string, head: string, expected: number): boolean {
  try {
    const p = JSON.parse(raw);
    if (p?.reviewed_head_sha !== head) return false;
    const covered =
      (Array.isArray(p.verdicts) ? p.verdicts.length : 0) +
      (Array.isArray(p.question_verdicts) ? p.question_verdicts.length : 0) +
      (typeof p.unverified === "number" ? p.unverified : 0);
    return covered === expected;
  } catch {
    return false;
  }
}

// How many verdicts a review must have before it counts as fully verified.
function expectedVerdicts(review: AutoReviewVerdict): number {
  return (
    (review.risks ?? []).slice(0, MAX_VERIFIED_RISKS).length +
    (review.questions ?? []).slice(0, MAX_VERIFIED_QUESTIONS).length
  );
}

// What the risk check decided for one PR head, or null when it never ran for
// that head. Read by the reconciler (auto-merge) and by mergeTask (the 409
// that names the confirmed risks) — both must ignore a verdict set produced
// for an older head.
export function riskVerdictsFor(
  db: DB,
  taskId: string,
  head: string | null | undefined
): { verdicts: RiskVerdict[]; question_verdicts: QuestionVerdict[]; unverified: number } | null {
  if (!head) return null;
  const rows = db
    .query("SELECT payload FROM events WHERE task_id = ? AND type = 'risk_verdicts' ORDER BY ts DESC, rowid DESC")
    .all(taskId) as { payload: string }[];
  for (const r of rows) {
    let p: any;
    try {
      p = JSON.parse(r.payload);
    } catch {
      continue;
    }
    if (p?.reviewed_head_sha !== head) continue;
    return {
      verdicts: Array.isArray(p.verdicts) ? p.verdicts : [],
      question_verdicts: Array.isArray(p.question_verdicts) ? p.question_verdicts : [],
      unverified: Number(p.unverified) || 0,
    };
  }
  return null;
}

// Has the review pipeline actually FINISHED for this head (HIVE-488)? Read
// from the other side, this is the same test verifyPendingOnce uses to decide a
// task needs no further verification: the newest review was written for this
// exact head, and every risk and question it raised already has a verdict keyed
// to that head. Until then the missing quiz answer is a pass that has not run,
// not a question for the director — so the director surfaces must not count it.
export function reviewCompleteForHead(db: DB, taskId: string, head: string | null | undefined): boolean {
  if (!head) return false;
  const review = latestAutoReviewVerdict(db, taskId);
  if (!review || review.reviewed_head_sha !== head) return false;
  const expected = expectedVerdicts(review);
  return expected === 0 || hasRiskVerdicts(db, taskId, head, expected);
}

// Is there any further review work COMING for this head, or is what we have as
// complete as the review will ever get? Nothing coming means either no head to
// key verdicts to or a project that never auto-reviews (the reviewer skips
// both); otherwise the pipeline must have finished for this exact head.
export function reviewPipelineSettled(
  db: DB,
  task: { id: string; head_sha?: string | null; project_id: string }
): boolean {
  if (!task.head_sha) return true;
  const project: any = db.query("SELECT config FROM projects WHERE id = ?").get(task.project_id);
  if (JSON.parse(project?.config ?? "{}").auto_review === false) return true;
  return reviewCompleteForHead(db, task.id, task.head_sha);
}

// Can the DIRECTOR act on this review right now (HIVE-500)? The review column
// counts everything in_review, but most of it is still the agent's or the
// pipeline's work, not a decision waiting on a human. Two rules:
//   - WITH a pull request: CI must not be red or still running (a red build is
//     the agent's to fix), and the review pipeline must have settled on the
//     live head, or the director would read a report about a stale commit.
//   - WITHOUT a pull request: there must be something to READ — a self-review
//     summary or a report attached as evidence. A task with neither has no
//     work product and nothing to merge; it is unfinished agent work, and
//     health surfaces it as stuck instead.
// Anything false here stays VISIBLE as in-review; it just must not be counted
// as something needing the director.
export function reviewActionable(
  db: DB,
  task: { id: string; state: string; pr_url?: string | null; ci_status?: string | null; head_sha?: string | null; project_id: string }
): boolean {
  if (task.state !== "in_review") return false;
  if (task.pr_url) {
    // Matches advanceIfFinished / landQueue: only failing and pending hold.
    // A null or 'unavailable' rollup means a repo (or check run) that never
    // reports, and holding the review there would hide mergeable work forever.
    if (task.ci_status === "failing" || task.ci_status === "pending") return false;
    return reviewPipelineSettled(db, task);
  }
  return hasDirectorReport(db, task.id);
}

export interface ReviewActionableTask {
  id: string;
  state: string;
  pr_url?: string | null;
  ci_status?: string | null;
  head_sha?: string | null;
  project_id: string;
}

// Batched form of reviewActionable for list endpoints, the same reason
// latestSidecarBatch exists: the single-task rule runs up to five queries, and
// a board with thirty in-review cards paid all of them once per card. This
// applies the identical rule with a fixed number of queries instead.
// Returns the ids that ARE actionable; anything absent is not.
export function reviewActionableBatch(db: DB, tasks: ReviewActionableTask[]): Set<string> {
  const actionable = new Set<string>();
  const candidates = tasks.filter((t) => t.state === "in_review");
  if (candidates.length === 0) return actionable;

  // No pull request: actionable only when there is something to READ.
  const noPr = candidates.filter((t) => !t.pr_url);
  if (noPr.length > 0) {
    const ids = noPr.map((t) => t.id);
    const ph = ids.map(() => "?").join(",");
    for (const row of db
      .query(`SELECT DISTINCT task_id FROM events WHERE type = 'review_summary' AND task_id IN (${ph})`)
      .all(...ids) as { task_id: string }[])
      actionable.add(row.task_id);
    for (const row of db
      .query(`SELECT DISTINCT task_id FROM evidence WHERE kind = 'report' AND task_id IN (${ph})`)
      .all(...ids) as { task_id: string }[])
      actionable.add(row.task_id);
  }

  // With a pull request: red or running CI is still the agent's problem.
  const live = candidates.filter(
    (t) => t.pr_url && t.ci_status !== "failing" && t.ci_status !== "pending"
  );
  if (live.length === 0) return actionable;

  const projectIds = [...new Set(live.map((t) => t.project_id))];
  const noAutoReview = new Set(
    (db
      .query(`SELECT id, config FROM projects WHERE id IN (${projectIds.map(() => "?").join(",")})`)
      .all(...projectIds) as { id: string; config: string | null }[])
      .filter((p) => {
        try {
          return JSON.parse(p.config ?? "{}").auto_review === false;
        } catch {
          return false;
        }
      })
      .map((p) => p.id)
  );

  // Nothing further is coming for these, so what we have is as complete as it gets.
  const needSettle: ReviewActionableTask[] = [];
  for (const t of live) {
    if (!t.head_sha || noAutoReview.has(t.project_id)) actionable.add(t.id);
    else needSettle.push(t);
  }
  if (needSettle.length === 0) return actionable;

  const ids = needSettle.map((t) => t.id);
  const ph = ids.map(() => "?").join(",");
  // Newest auto_review per task, read in the same order latestAutoReviewVerdict uses.
  const latest = new Map<string, AutoReviewVerdict | null>();
  for (const row of db
    .query(
      `SELECT task_id, payload FROM events WHERE type = 'auto_review' AND task_id IN (${ph})
        ORDER BY ts DESC, rowid DESC`
    )
    .all(...ids) as { task_id: string; payload: string }[])
    if (!latest.has(row.task_id)) latest.set(row.task_id, parseAutoReview(row.payload));

  const verdictRows = new Map<string, string[]>();
  for (const row of db
    .query(`SELECT task_id, payload FROM events WHERE type = 'risk_verdicts' AND task_id IN (${ph})`)
    .all(...ids) as { task_id: string; payload: string }[]) {
    const list = verdictRows.get(row.task_id);
    if (list) list.push(row.payload);
    else verdictRows.set(row.task_id, [row.payload]);
  }

  for (const t of needSettle) {
    const review = latest.get(t.id);
    if (!review || review.reviewed_head_sha !== t.head_sha) continue;
    const expected = expectedVerdicts(review);
    if (expected === 0) {
      actionable.add(t.id);
      continue;
    }
    const rows = verdictRows.get(t.id) ?? [];
    if (rows.some((raw) => coversReview(raw, t.head_sha!, expected))) actionable.add(t.id);
  }
  return actionable;
}

// Something the director can actually read: the agent's own review summary, or
// a report attached as evidence (how scouts hand work over).
export function hasDirectorReport(db: DB, taskId: string): boolean {
  if (db.query("SELECT 1 FROM events WHERE task_id = ? AND type = 'review_summary' LIMIT 1").get(taskId)) return true;
  return !!db.query("SELECT 1 FROM evidence WHERE task_id = ? AND kind = 'report' LIMIT 1").get(taskId);
}

export function confirmedRisks(db: DB, taskId: string, head: string | null | undefined): RiskVerdict[] {
  return (riskVerdictsFor(db, taskId, head)?.verdicts ?? []).filter((v) => v?.verdict === "confirmed");
}

// The pre-reviewer nearly always writes at least one soft risk or question, so
// treating "wrote something" as ambiguity meant nothing ever auto-merged
// (HIVE-407). The flag clears only when the verification pass covered EVERY
// risk and question for this exact head, refuted every risk, and could answer
// every question from the code. Anything unverified, uncovered, confirmed, or
// human-only leaves it ambiguous, and the director decides.
// A caution verdict is only as good as the check that cleared it. A caution
// with nothing listed was never verified at all, so it stays the director's
// call — `ambiguityCleared` alone would wave it through as "nothing to clear".
export function cautionCleared(
  db: DB,
  taskId: string,
  head: string | null | undefined,
  review: { risks?: string[]; questions?: string[] }
): boolean {
  const noted = (review.risks?.length ?? 0) + (review.questions?.length ?? 0) > 0;
  return noted && ambiguityCleared(db, taskId, head, review);
}

export function ambiguityCleared(
  db: DB,
  taskId: string,
  head: string | null | undefined,
  review: { risks?: string[]; questions?: string[] }
): boolean {
  const risks = review.risks ?? [];
  const questions = review.questions ?? [];
  if (!risks.length && !questions.length) return true;
  const found = riskVerdictsFor(db, taskId, head);
  if (!found || found.unverified) return false;
  if (found.verdicts.length !== risks.length || found.question_verdicts.length !== questions.length) return false;
  return (
    found.verdicts.every((v) => v?.verdict === "refuted") && found.question_verdicts.every((q) => q?.answerable === "machine")
  );
}
