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
  const project: any = db.query("SELECT config FROM projects WHERE id = ?").get(t.project_id);
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
    res = await exec(argv, { timeoutMs: TIMEOUT_MS });
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
  // A cautious verdict's risks are suspicions — check each one against the
  // real code before the director acts on them. PR-backed tasks only: without
  // a PR head there is nothing to key the verdicts to.
  if (review.verdict === "caution" && review.risks.length && reviewedHead) {
    await verifyRisks(db, t, review.risks, reviewedHead, diff.text, deps);
  }
}

export function startAutoReviewer(db: DB, deps: ReviewerDeps & { intervalMs?: number } = {}): () => void {
  const timer = setInterval(() => {
    autoReviewOnce(db, deps).catch((e) => console.error("[hive] auto-review crashed:", e));
  }, deps.intervalMs ?? 60_000);
  return () => clearInterval(timer);
}

// ---------------------------------------------------------------------------
// Per-risk adversarial verification (task HIVE-406).
//
// A `caution` pre-review lists risks the sonnet reviewer *suspects*. Some are
// real bugs, some are the model pattern-matching on a diff it can only see a
// window of. So each risk gets its own opus one-shot that can read the actual
// worktree, and answers one question: does this risk hold up? The verdicts land
// as ONE `risk_verdicts` event on the card, so the director reads "3 of 5 were
// refuted" instead of five maybes.
//
// Keyed to the reviewed PR head: it re-runs only when the pre-review itself
// re-runs for a new head, and never twice for the same one.
const MAX_VERIFIED_RISKS = 5;
const VERIFY_MODEL = "opus";

export interface RiskVerdict {
  risk: string;
  verdict: "confirmed" | "refuted";
  why: string;
  evidence_path?: string;
}

// Same loose parsing as extractReview: whole JSON, the `--output-format json`
// {result:"..."} envelope, or a braces slice of prose.
export function extractVerdict(raw: string): { verdict: "confirmed" | "refuted"; why: string; evidence_path?: string } | null {
  const norm = (o: any) => {
    if (!o || (o.verdict !== "confirmed" && o.verdict !== "refuted")) return null;
    const out: any = { verdict: o.verdict, why: String(o.why ?? "").trim().slice(0, 300) };
    if (typeof o.evidence_path === "string" && o.evidence_path.trim()) out.evidence_path = o.evidence_path.trim();
    return out;
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

// Already verified for this exact PR head? Then don't spend the model again.
function hasRiskVerdicts(db: DB, taskId: string, head: string): boolean {
  const rows = db.query("SELECT payload FROM events WHERE task_id = ? AND type = 'risk_verdicts'").all(taskId) as { payload: string }[];
  return rows.some((r) => {
    try {
      return JSON.parse(r.payload)?.reviewed_head_sha === head;
    } catch {
      return false;
    }
  });
}

// One opus run per risk, in sequence, capped at MAX_VERIFIED_RISKS. A run that
// fails or returns junk is left out of `verdicts` and counted in `unverified`,
// so a broken run never reads as an all-clear.
export async function verifyRisks(
  db: DB,
  task: any,
  risks: string[],
  head: string,
  diff: string,
  deps: ReviewerDeps = {}
): Promise<void> {
  if (!risks.length || hasRiskVerdicts(db, task.id, head)) return;
  const exec = deps.exec ?? defaultPlannerExec;
  const verdicts: RiskVerdict[] = [];
  let unverified = 0;
  for (const risk of risks.slice(0, MAX_VERIFIED_RISKS)) {
    let res;
    try {
      res = await exec([claudeBin(), "-p", "--model", VERIFY_MODEL, verifyPrompt(task, risk, diff), "--output-format", "json"], {
        timeoutMs: TIMEOUT_MS,
        cwd: task.worktree_path ?? undefined,
      });
    } catch {
      unverified++;
      continue;
    }
    const v = res.timedOut || res.code !== 0 ? null : extractVerdict(res.stdout);
    if (v) verdicts.push({ risk, ...v });
    else unverified++;
  }
  writeEvent(db, {
    task_id: task.id,
    source: "system",
    type: "risk_verdicts",
    payload: { reviewed_head_sha: head, verdicts, ...(unverified ? { unverified } : {}) } as any,
  });
  broadcast({ type: "task", task: getTask(db, task.id) });
}
