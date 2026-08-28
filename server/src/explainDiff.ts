// Literate-diff explanation pages (task #1249).
//
// A task must not reach the director's review queue until two things hold: its
// CI is green (the callers check that) and a page exists that EXPLAINS the
// change. The page is one self-contained interactive HTML file per PR head —
// background, intuition with diagrams, a code walkthrough, and the same
// understanding questions the review card asks — written by a Claude Opus
// one-shot and stored as task evidence (kind 'explanation'). Because it is
// ordinary evidence, the review card, the task page and the Jira receipt
// comment all link the same artifact for free.
//
// The quiz is NOT generated here: it is rendered from the agent's
// review_summary `understanding.checks`, which is what the director is asked
// in the app. One source of truth, no second set of questions to disagree.
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DB } from "./db.ts";
import { newId, now, evidenceDir } from "./db.ts";
import { broadcast } from "./bus.ts";
import { parseEvidence } from "./rows.ts";
import { writeEvent, getTask } from "./state.ts";
import { broadcastTask } from "./health.ts";
import { claudeBin, defaultPlannerExec, type PlannerExec } from "./planner.ts";
import { modelFailure, noteModelCall } from "./modelCall.ts";
import { claudeProfileEnvForProject } from "./claudeProfiles.ts";
import { defaultExec, type Exec } from "./exec.ts";
import { handOffToReview } from "./api.ts";

const MODEL = "opus";
const TIMEOUT_MS = 15 * 60_000;
// A diff bigger than this is truncated: the model still gets the shape of the
// change, and a 2MB prompt is not a better explanation.
const MAX_DIFF_CHARS = 200_000;

// `${taskId}:${head}` currently being generated. In memory on purpose — a
// server restart mid-run should simply try again on the next gate check.
const inFlight = new Set<string>();

export interface ExplainDeps {
  exec?: Exec; // gh, for the PR diff
  plannerExec?: PlannerExec; // the claude one-shot
}

// The stored page for this PR head, or null. A null head means hive has not
// observed the PR's head commit yet (the reconciler stamps it a cycle later),
// so any page counts — the next gate check with a real head re-validates.
export function explanationFor(db: DB, taskId: string, headSha: string | null): any | null {
  const rows = db
    .query("SELECT * FROM evidence WHERE task_id = ? AND kind = 'explanation' ORDER BY ts DESC")
    .all(taskId) as any[];
  if (!rows.length) return null;
  if (!headSha) return rows[0];
  for (const r of rows) {
    try {
      if (JSON.parse(r.meta || "{}").commit_sha === headSha) return r;
    } catch {
      /* unparseable meta can't match a head */
    }
  }
  return null;
}

// The review gate. "ready" = hand off now; "generating" = hold the task with
// its agent, the generation call hands off when the page lands.
//
// Fails OPEN when there is nothing to explain (no PR) or no checkout to read
// (the worktree is gone): a missing explanation must never strand a finished
// task forever, the same reasoning that makes the gh probe fail open.
export function explanationGate(db: DB, task: any, deps: ExplainDeps = {}): "ready" | "generating" {
  if (!task?.pr_url) return "ready";
  const wt = task.worktree_path;
  if (!wt || !existsSync(join(wt, ".git"))) return "ready";
  const head: string | null = task.head_sha ?? null;
  if (explanationFor(db, task.id, head)) return "ready";
  // Already tried and failed for this head: hand off without the page rather
  // than holding the task forever (or burning another model run every cycle).
  if (generationFailed(db, task.id, head)) return "ready";
  const key = `${task.id}:${head ?? ""}`;
  if (!inFlight.has(key)) {
    inFlight.add(key);
    writeEvent(db, {
      task_id: task.id,
      source: "hive",
      type: "explanation_generating",
      payload: { pr_url: task.pr_url, head_sha: head },
    });
    generateExplanation(db, task, head, deps)
      .catch((e) => console.error(`[hive] explanation generation failed for ${task.id}:`, e))
      .finally(() => inFlight.delete(key));
  }
  return "generating";
}

// Did generation already fail for this head?
function generationFailed(db: DB, taskId: string, headSha: string | null): boolean {
  const rows = db
    .query("SELECT payload FROM events WHERE task_id = ? AND type = 'explanation_failed'")
    .all(taskId) as { payload: string }[];
  return rows.some((r) => {
    try {
      return (JSON.parse(r.payload)?.head_sha ?? null) === headSha;
    } catch {
      return false;
    }
  });
}

// The questions the director is actually asked in the app, from the newest
// review_summary. The page teaches them; it never invents its own.
function reviewChecks(db: DB, taskId: string): any[] {
  const row = db
    .query("SELECT payload FROM events WHERE task_id = ? AND type = 'review_summary' ORDER BY ts DESC LIMIT 1")
    .get(taskId) as { payload: string } | undefined;
  if (!row) return [];
  try {
    const u = JSON.parse(row.payload)?.understanding;
    const checks = Array.isArray(u?.checks) ? u.checks : u?.check ? [u.check] : [];
    return checks.filter((c: any) => c && c.question && Array.isArray(c.options));
  } catch {
    return [];
  }
}

export function buildPrompt(task: any, diff: string, checks: any[]): string {
  return [
    "Write a rich, interactive explanation of the code change below, for a busy",
    "director who will review and merge it. Explore the surrounding code in the",
    "current working directory to get the background right (you can read files).",
    "",
    "Sections, in this order, with a table of contents:",
    "- Background: the existing system this change touches. Include a deep layer for a",
    "  beginner (clearly marked skippable) and then a narrow layer about just this area.",
    "- Intuition: the essence of the change, with concrete toy-data examples. Use a small",
    "  number of reusable diagram families: simplified mockups of the UI for UI changes,",
    "  and box-and-arrow data-flow diagrams WITH example data flowing through them.",
    "- Code: a high-level walkthrough of the diff, grouped and ordered so it reads as a",
    "  story rather than file-by-file.",
    "- Quiz: the questions given below, interactive multiple choice. Clicking an option",
    "  says whether it is right and explains why that option is right or wrong.",
    "",
    "Rules:",
    "- Output ONE self-contained HTML document and NOTHING else. No markdown fences, no",
    "  preamble. Start with <!doctype html>. Inline all CSS and JavaScript. No external",
    "  resources of any kind (no CDN, no fonts, no images).",
    "- One long scrolling page with section headers. No tabs for the top-level structure.",
    "  Responsive enough to read on a phone.",
    "- Light and dark, via prefers-color-scheme colour tokens.",
    "- Plain English: one idea per sentence, around 20 words or fewer, everyday words,",
    "  the point first. Spell out jargon the first time. Never say the same thing twice.",
    "- Diagrams are plain HTML and CSS, never ASCII art. Lists are HTML lists.",
    "- Code blocks use <pre> tags. Any custom code block div MUST set white-space: pre-wrap,",
    "  or the browser eats the newlines. Check every code block before you finish.",
    "- Use callouts for key concepts, definitions and important edge cases.",
    "- Write with the clarity and flow of Martin Kleppmann: engaging, classic style, smooth",
    "  transitions between sections.",
    "",
    `Task: ${task.title ?? ""}`,
    `Pull request: ${task.pr_url}`,
    task.brief ? `Brief:\n${String(task.brief).slice(0, 4000)}` : "",
    "",
    checks.length
      ? [
          "Quiz questions — use these EXACTLY, same wording, same options, same correct answer.",
          "These are the questions the director is asked in the app, so the page must not",
          "invent different ones. Teach every answer in the sections above.",
          JSON.stringify(checks, null, 2),
        ].join("\n")
      : "No quiz questions were supplied — omit the Quiz section entirely rather than inventing questions.",
    "",
    "Diff:",
    diff,
  ]
    .filter(Boolean)
    .join("\n");
}

// Strip the odd stray fence or preamble a model still emits around the page.
function extractHtml(raw: string): string | null {
  let text = raw.trim();
  try {
    const env = JSON.parse(text);
    if (typeof env?.result === "string") text = env.result.trim();
  } catch {
    /* plain text output */
  }
  const start = text.search(/<!doctype html|<html[\s>]/i);
  if (start < 0) return null;
  text = text.slice(start);
  const end = text.toLowerCase().lastIndexOf("</html>");
  return end < 0 ? text : text.slice(0, end + 7);
}

async function generateExplanation(db: DB, task: any, head: string | null, deps: ExplainDeps): Promise<void> {
  const exec = deps.exec ?? defaultExec;
  const plannerExec = deps.plannerExec ?? defaultPlannerExec;
  const fail = (reason: string) => {
    // Fail open: record why, then hand off anyway. An unexplainable change is
    // still a finished change, and a permanently held task is worse than a
    // review card without a page (the CI-unavailable lesson, learning #1084).
    writeEvent(db, { task_id: task.id, source: "hive", type: "explanation_failed", payload: { reason, pr_url: task.pr_url, head_sha: head } });
    if (handOffToReview(db, task.id, "hive")) broadcastTask(db, getTask(db, task.id));
  };

  const d = await exec(["gh", "pr", "diff", task.pr_url]);
  const diff = d.code === 0 ? d.stdout : "";
  if (!diff.trim()) return fail(d.stderr?.trim() || "gh pr diff returned nothing");

  const res = await plannerExec(
    [claudeBin(), "-p", "--model", MODEL, buildPrompt(task, diff.slice(0, MAX_DIFF_CHARS), reviewChecks(db, task.id)), "--output-format", "json"],
    {
      timeoutMs: TIMEOUT_MS,
      cwd: task.worktree_path,
      env: claudeProfileEnvForProject(db, task.project_id),
    }
  );
  if (res.timedOut || res.code !== 0) return fail(`explanation run ${modelFailure(db, res, { timeoutMs: TIMEOUT_MS })}`);
  noteModelCall(db, null);
  const html = extractHtml(res.stdout);
  if (!html) return fail("explanation run produced no HTML document");

  const dir = join(evidenceDir(), task.id);
  mkdirSync(dir, { recursive: true });
  const name = `${Date.now()}_explanation.html`;
  await Bun.write(join(dir, name), html);
  const ev = {
    id: newId("ev"),
    task_id: task.id,
    ts: now(),
    kind: "explanation",
    path: join(dir, name),
    url: `/evidence/${task.id}/${name}`,
    caption: "Explanation of this change",
    meta: JSON.stringify({ commit_sha: head, pr_url: task.pr_url }),
  };
  db.query("INSERT INTO evidence (id, task_id, ts, kind, path, url, caption, meta) VALUES (?,?,?,?,?,?,?,?)").run(
    ev.id, ev.task_id, ev.ts, ev.kind, ev.path, ev.url, ev.caption, ev.meta
  );
  broadcast({ type: "evidence", evidence: parseEvidence(ev) });
  writeEvent(db, { task_id: task.id, source: "hive", type: "explanation_ready", payload: { evidence_id: ev.id, url: ev.url, head_sha: head } });
  if (handOffToReview(db, task.id, "hive")) broadcastTask(db, getTask(db, task.id));
}
