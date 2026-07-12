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
import { defaultExec } from "./exec.ts";
import { claudeBin, defaultPlannerExec, type PlannerExec } from "./planner.ts";

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
  const base = JSON.parse(project.config ?? "{}").default_branch || "main";
  const r = await exec(["git", "-C", project.repo_path, "diff", `${base}...${task.branch}`]);
  if (r.code !== 0) return { ok: false, error: r.stderr.trim() || `git diff exited ${r.code}` };
  return { ok: true, text: r.stdout };
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
    `Answer as ONLY a JSON object, no prose around it:`,
    `{"verdict": "looks_good" | "caution",`,
    ` "summary": "2-3 sentences: what the change does and whether it matches the brief",`,
    ` "risks": ["each concrete risk/bug/scope-creep, with file:line when possible"],`,
    ` "questions": ["only questions the human MUST answer before merging"]}`,
    `Rules: verdict 'caution' if anything in risks would block YOUR merge. Empty arrays are fine.`,
  ].join("\n");
}

// One review per pass (no stampede when a backlog of reviews appears at once).
export async function autoReviewOnce(db: DB, deps: ReviewerDeps = {}): Promise<void> {
  if (isOffline(db)) return;
  const t: any = db
    .query(
      `SELECT t.* FROM tasks t
        WHERE t.state = 'in_review'
          AND NOT EXISTS (SELECT 1 FROM events e WHERE e.task_id = t.id AND e.type IN ('auto_review', 'auto_review_error'))
        ORDER BY t.updated_at ASC LIMIT 1`
    )
    .get();
  if (!t) return;
  const project: any = db.query("SELECT config FROM projects WHERE id = ?").get(t.project_id);
  const config = JSON.parse(project?.config ?? "{}");
  if (config.auto_review === false) {
    writeEvent(db, { task_id: t.id, source: "system", type: "auto_review", payload: { skipped: "disabled by project config" } });
    return;
  }

  const shell = deps.shellExec ?? defaultExec;
  const diff = await rawDiff(db, t, shell);
  if (!diff.ok) {
    writeEvent(db, { task_id: t.id, source: "system", type: "auto_review_error", payload: { error: diff.error } });
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
    writeEvent(db, { task_id: t.id, source: "system", type: "auto_review_error", payload: { error: String(e?.message ?? e) } });
    return;
  }
  if (res.timedOut || res.code !== 0) {
    writeEvent(db, {
      task_id: t.id,
      source: "system",
      type: "auto_review_error",
      payload: { error: res.timedOut ? `timed out after ${TIMEOUT_MS}ms` : `exited ${res.code}: ${res.stderr.trim().slice(0, 300)}` },
    });
    return;
  }
  const review = extractReview(res.stdout);
  if (!review) {
    writeEvent(db, { task_id: t.id, source: "system", type: "auto_review_error", payload: { error: "unparseable reviewer output" } });
    return;
  }
  writeEvent(db, { task_id: t.id, source: "system", type: "auto_review", payload: review as any });
  broadcast({ type: "task", task: getTask(db, t.id) });
}

export function startAutoReviewer(db: DB, deps: ReviewerDeps & { intervalMs?: number } = {}): () => void {
  const timer = setInterval(() => {
    autoReviewOnce(db, deps).catch((e) => console.error("[hive] auto-review crashed:", e));
  }, deps.intervalMs ?? 60_000);
  return () => clearInterval(timer);
}
