// Auto-reviewer: when a task reaches in_review, a one-shot `claude -p` (sonnet)
// reads the PR diff against the brief and posts a structured pre-review onto
// the review card as an `auto_review` event — verdict, summary, risks,
// questions. The director reviews a screened summary instead of a raw diff
// (review latency is the pipeline ceiling; the diff-reading is the slow part).
//
// Non-blocking and advisory: the task sits in review exactly as before; the
// event just arrives on the card, usually within a cycle. One attempt per task
// (`auto_review` / `auto_review_error` both mark it done — no retry loops).
// Per-project opt-out: config.auto_review = false. Model: config.model_by_kind
// .review, else sonnet. Argv override: config.reviewer_argv (verbatim).
import type { DB } from "./db.ts";
import { isOffline } from "./db.ts";
import { writeEvent, getTask } from "./state.ts";
import { broadcast } from "./bus.ts";
import type { Exec } from "./exec.ts";
import { defaultExec, projectComparisonBase } from "./exec.ts";
import { claudeBin, defaultPlannerExec, type PlannerExec } from "./planner.ts";
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

// One review per pass (no stampede when a backlog of reviews appears at once).
export async function autoReviewOnce(db: DB, deps: ReviewerDeps = {}): Promise<void> {
  if (isOffline(db)) return;
  const t: any = db
    .query(
      `SELECT t.* FROM tasks t
        WHERE t.state = 'in_review'
          AND NOT EXISTS (
            SELECT 1 FROM events e WHERE e.task_id = t.id AND e.type IN ('auto_review', 'auto_review_error')
              AND (
                t.pr_url IS NULL
                OR (e.type = 'auto_review' AND json_valid(e.payload) AND json_extract(e.payload, '$.skipped') IS NOT NULL)
                OR (
                  json_valid(e.payload)
                  AND json_extract(e.payload, '$.reviewed_pr_url') = t.pr_url
                  AND json_extract(e.payload, '$.reviewed_head_sha') = t.head_sha
                )
              )
          )
          AND ${supervisedSql("t.source", "t.agent_target")}
        ORDER BY t.updated_at ASC LIMIT 1`
    )
    .get();
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
    writeEvent(db, { task_id: t.id, source: "system", type: "auto_review_error", payload: { error: diff.error, ...reviewIdentity } });
    return;
  }
  const argv: string[] =
    Array.isArray(config.reviewer_argv) && config.reviewer_argv.length
      ? [...config.reviewer_argv]
      : [claudeBin(), "-p", "--model", config.model_by_kind?.review ?? "sonnet"];
  argv.push(reviewPrompt(t, diff.text), "--output-format", "json");

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
    writeEvent(db, { task_id: t.id, source: "system", type: "auto_review_error", payload: { error: String(e?.message ?? e), ...reviewIdentity } });
    return;
  }
  // The LLM call is the slow part (up to TIMEOUT_MS) — re-check right after it
  // returns, before trusting anything it said about this head.
  if (!stillCurrent() || (t.pr_url && (await livePrHead(shell, t.pr_url)) !== reviewedHead)) return;
  if (res.timedOut || res.code !== 0) {
    writeEvent(db, {
      task_id: t.id,
      source: "system",
      type: "auto_review_error",
      payload: {
        error: res.timedOut ? `timed out after ${TIMEOUT_MS}ms` : `exited ${res.code}: ${res.stderr.trim().slice(0, 300)}`,
        ...reviewIdentity,
      },
    });
    return;
  }
  const review = extractReview(res.stdout);
  if (!review) {
    writeEvent(db, {
      task_id: t.id,
      source: "system",
      type: "auto_review_error",
      payload: { error: "unparseable reviewer output", ...reviewIdentity },
    });
    return;
  }
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

export function startAutoReviewer(db: DB, deps: ReviewerDeps & { intervalMs?: number } = {}): () => void {
  const timer = setInterval(() => {
    autoReviewOnce(db, deps).catch((e) => console.error("[hive] auto-review crashed:", e));
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
  return rows.some((r) => {
    try {
      const p = JSON.parse(r.payload);
      if (p?.reviewed_head_sha !== head) return false;
      const covered =
        (Array.isArray(p.verdicts) ? p.verdicts.length : 0) +
        (Array.isArray(p.question_verdicts) ? p.question_verdicts.length : 0) +
        (typeof p.unverified === "number" ? p.unverified : 0);
      return covered === expected;
    } catch {
      return false;
    }
  });
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
  for (const risk of risks) {
    if (!(await current())) return;
    const res = await run(verifyPrompt(task, risk, input.diff));
    const v = !res || res.timedOut || res.code !== 0 ? null : extractVerdict(res.stdout);
    if (v) verdicts.push({ risk, ...v });
    else unverified++;
  }
  for (const question of questions) {
    if (!(await current())) return;
    const res = await run(answerPrompt(task, question, input.diff));
    const a = !res || res.timedOut || res.code !== 0 ? null : extractAnswer(res.stdout);
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
    } as any,
  });
  broadcast({ type: "task", task: getTask(db, task.id) });
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
