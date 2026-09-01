// The catchup glance: one small card per shipped change, built to be read in
// 15-30 seconds (HIVE-511).
//
// The long explanation page (explainDiff.ts) stays exactly as it is. This is a
// layer ABOVE it: a one-line headline, a picture, and four numbers. The card
// links to the page for anything that needs depth.
//
// Nothing here is written by a model. The headline reuses the agent's own
// `understanding.essence` from review_summary and CAPS it — a paragraph gets
// cut, never rendered — so catchup can never grow back into prose.
import type { DB } from "./db.ts";
import { parseEvidence } from "./rows.ts";
import { taskIdentifier } from "./taskIdentifier.ts";
import type { Exec } from "./exec.ts";
import { defaultExec, isSafeRef, projectComparisonBase } from "./exec.ts";

// The whole point of the card. One line on a phone is ~60 characters; two is
// the most a glance tolerates, so the cap is 140 and the render is one line
// with an ellipsis. Enforced here, not in a prompt: a model that ignores the
// instruction still cannot put a paragraph on the card.
export const HEADLINE_MAX = 140;

export interface GlanceArea {
  area: string;
  churn: number;
}
export interface GlanceImage {
  url: string;
  caption: string | null;
  phase: "before" | "after" | null;
}
export interface GlanceCard {
  task_id: string;
  number: number;
  display_id: string;
  title: string;
  project_id: string;
  kind: string;
  state: string;
  shipped_at: string;
  headline: string;
  merged_by: "auto" | "director" | null;
  files: number;
  additions: number;
  deletions: number;
  // The diff could not be read at all (a wrong repo_path, a deleted branch, a
  // gh call that failed). The counts above are then meaningless, and the card
  // says so instead of showing a confident 0.
  diff_unavailable: boolean;
  areas: GlanceArea[];
  images: GlanceImage[];
  explanation_url: string | null;
}

// Shipped = merged and no longer asking anything of the director. `verifying`
// is included because the code is already on the base branch by then.
const SHIPPED_STATES = ["done", "verifying"];
// A glance pass is ten changes, not a scroll of the year.
const DEFAULT_LIMIT = 10;
// Five bars is a shape; twelve is a table.
const MAX_AREAS = 5;
// Two pictures max, the same rule render_proof follows.
const MAX_IMAGES = 2;

// One line, hard-capped. Prefers the first sentence when it fits on its own,
// which is how a well-written essence already starts; otherwise it cuts at a
// word boundary and marks the cut.
export function headline(text: unknown, max = HEADLINE_MAX): string {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!flat) return "";
  const first = flat.match(/^.*?[.!?](?=\s|$)/)?.[0];
  const pick = first && first.length <= max ? first : flat;
  if (pick.length <= max) return pick;
  const cut = pick.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/, "")}…`;
}

// Where the change actually landed, as a handful of buckets. Two path segments
// is the level a person recognises ("web/src", "server/test"); one is too
// coarse to say anything and three is a file list again.
export function areasFromFiles(files: { path: string; additions: number; deletions: number }[]): GlanceArea[] {
  const totals = new Map<string, number>();
  for (const f of files) {
    const parts = f.path.split("/");
    const area = parts.length > 2 ? parts.slice(0, 2).join("/") : parts.length > 1 ? parts[0] : "(root)";
    totals.set(area, (totals.get(area) ?? 0) + f.additions + f.deletions);
  }
  return [...totals.entries()]
    .map(([area, churn]) => ({ area, churn }))
    .sort((a, b) => b.churn - a.churn)
    .slice(0, MAX_AREAS);
}

// `git diff --numstat` output. A binary file reports "-\t-\t<path>" and counts
// as a touched file with no churn, which is exactly how it should read.
export function parseNumstat(stdout: string): { path: string; additions: number; deletions: number }[] {
  return stdout
    .split("\n")
    .map((line) => line.split("\t"))
    .filter((cols) => cols.length >= 3 && cols[2])
    .map(([add, del, path]) => ({
      path: path.trim(),
      additions: Number(add) || 0,
      deletions: Number(del) || 0,
    }));
}

// A shipped change's file stats never change again, so they are fetched once
// per PR (or branch tip) and kept. In memory on purpose: a server restart
// costs one gh call per card, and a table for a derived number is a migration
// nobody needs.
// ponytail: in-memory cache, move it to a table if restarts start hurting.
const statsCache = new Map<string, { path: string; additions: number; deletions: number }[]>();

async function fileStats(
  db: DB,
  task: any,
  exec: Exec
): Promise<{ files: { path: string; additions: number; deletions: number }[]; ok: boolean }> {
  const key = task.pr_url || (task.head_sha ? `sha:${task.head_sha}` : task.branch ? `br:${task.project_id}:${task.branch}` : "");
  if (!key) return { files: [], ok: false };
  const hit = statsCache.get(key);
  if (hit) return { files: hit, ok: true };

  let files: { path: string; additions: number; deletions: number }[] = [];
  // Did any source actually answer? An empty diff and a diff we could not read
  // are different facts, and only one of them may render as 0.
  let ok = false;
  if (task.pr_url) {
    const r = await exec(["gh", "pr", "view", task.pr_url, "--json", "files"]);
    if (r.code === 0) {
      try {
        files = (JSON.parse(r.stdout)?.files ?? []).map((f: any) => ({
          path: String(f.path ?? ""),
          additions: Number(f.additions) || 0,
          deletions: Number(f.deletions) || 0,
        }));
        ok = true;
      } catch {
        /* a gh answer we cannot parse is the same as no stats */
      }
    }
  }
  // No PR (a project that only commits to its worktree), or gh had nothing:
  // diff the branch locally against the project's comparison base.
  if (!files.length && isSafeRef(task.branch)) {
    const project: any = db.query("SELECT * FROM projects WHERE id = ?").get(task.project_id);
    if (project?.repo_path) {
      let config: any = {};
      try {
        config = JSON.parse(project.config ?? "{}");
      } catch {
        /* unparseable config still has a default base */
      }
      const base = projectComparisonBase(config);
      const r = await exec(["git", "-C", project.repo_path, "diff", "--numstat", `${base}...${task.branch}`]);
      if (r.code === 0) {
        files = parseNumstat(r.stdout);
        ok = true;
      }
    }
  }
  // Only a real answer is worth keeping. Caching a failure would freeze
  // "unavailable" onto the card until the server restarts.
  if (ok) statsCache.set(key, files);
  return { files, ok };
}

// Short enough to say nothing. "Two changes." is a real essence a real agent
// wrote, and as the only line on a card it is worse than the task title.
const MIN_HEADLINE = 24;

// The agent's own words, already written for this change. Nothing is generated
// here — `essence` is one sentence by contract, and the cap enforces it.
function headlineFor(db: DB, task: any): string {
  const row = db
    .query("SELECT payload FROM events WHERE task_id = ? AND type = 'review_summary' ORDER BY ts DESC LIMIT 1")
    .get(task.id) as { payload: string } | undefined;
  const fallback = headline(task.summary) || headline(task.title);
  if (row) {
    try {
      const u = JSON.parse(row.payload)?.understanding;
      const line = headline(u?.essence || u?.background);
      if (line.length >= MIN_HEADLINE || (line && !fallback)) return line;
    } catch {
      /* fall through to the task's own summary */
    }
  }
  return fallback;
}

// Who shipped it: the reconciler's auto-merge, or the director pressing merge.
function mergedBy(db: DB, taskId: string): "auto" | "director" | null {
  const row = db
    .query(
      `SELECT type, payload FROM events WHERE task_id = ? AND type IN ('auto_merged','merged')
        ORDER BY ts DESC LIMIT 1`
    )
    .get(taskId) as { type: string; payload: string } | undefined;
  if (!row) return null;
  if (row.type === "merged") return "director";
  try {
    return JSON.parse(row.payload)?.ok === false ? null : "auto";
  } catch {
    return "auto";
  }
}

// Newest first, and a before/after pair kept in that order so the card reads
// left to right the way time runs.
function imagesFor(db: DB, taskId: string): GlanceImage[] {
  const rows = (db
    .query("SELECT * FROM evidence WHERE task_id = ? AND kind = 'screenshot' AND url IS NOT NULL ORDER BY ts DESC")
    .all(taskId) as any[]).map(parseEvidence);
  const phase = (r: any): "before" | "after" | null =>
    r.meta?.render_phase === "before" ? "before" : r.meta?.render_phase === "after" ? "after" : null;
  const before = rows.find((r) => phase(r) === "before");
  const after = rows.find((r) => phase(r) === "after");
  const picked = before && after ? [before, after] : rows.slice(0, MAX_IMAGES);
  return picked.map((r) => ({ url: r.url, caption: r.caption ?? null, phase: phase(r) }));
}

function explanationUrl(db: DB, taskId: string): string | null {
  const row = db
    .query("SELECT url FROM evidence WHERE task_id = ? AND kind = 'explanation' ORDER BY ts DESC LIMIT 1")
    .get(taskId) as { url: string | null } | undefined;
  return row?.url ?? null;
}

export async function catchupCards(
  db: DB,
  opts: { projectId?: string | null; limit?: number } = {},
  exec: Exec = defaultExec
): Promise<GlanceCard[]> {
  const limit = Math.min(Math.max(Number(opts.limit) || DEFAULT_LIMIT, 1), 50);
  const placeholders = SHIPPED_STATES.map(() => "?").join(",");
  const projectId = opts.projectId ?? null;
  const tasks = db
    .query(
      `SELECT * FROM tasks
        WHERE state IN (${placeholders}) AND (? IS NULL OR project_id = ?)
        ORDER BY updated_at DESC LIMIT ?`
    )
    .all(...SHIPPED_STATES, projectId, projectId, limit) as any[];

  return await Promise.all(
    tasks.map(async (task) => {
      const { files, ok } = await fileStats(db, task, exec);
      return {
        task_id: task.id,
        number: task.number,
        display_id: taskIdentifier(db, task),
        title: task.title,
        project_id: task.project_id,
        kind: task.kind,
        state: task.state,
        shipped_at: task.updated_at,
        headline: headlineFor(db, task),
        merged_by: mergedBy(db, task.id),
        files: files.length,
        additions: files.reduce((n, f) => n + f.additions, 0),
        deletions: files.reduce((n, f) => n + f.deletions, 0),
        diff_unavailable: !ok,
        areas: areasFromFiles(files),
        images: imagesFor(db, task.id),
        explanation_url: explanationUrl(db, task.id),
      };
    })
  );
}
