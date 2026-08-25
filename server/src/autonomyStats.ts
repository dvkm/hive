// Autonomy metrics: does hive's automation actually earn the director's trust?
//
// Four questions, one read-only pass over events/tasks:
//   1. auto_merge_precision — of the merges hive made on its own, how many did
//      NOT need a human fix afterwards?
//   2. inbox_load — how many things per day ask for the director's attention,
//      split by what kind of thing they are?
//   3. recovery — how often did hive un-stick itself instead of parking?
//   4. agreement — when hive answered a decision itself, did the director later
//      contradict that answer?
//
// Everything here reads; nothing here writes. The clock is injectable so tests
// can seed a fixed window.
//
// ponytail: heuristics with named ceilings, not ground truth. The fix signal is
// file-overlap plus revert-commit detection (see fixSignalFor). Both are
// best-effort and can miss a fix that touches different files, or flag an
// unrelated later task that edits the same files. Read these as trends.
import type { DB } from "./db.ts";
import { type Exec, defaultExec, projectBaseBranch } from "./exec.ts";

export const FIX_WINDOW_DAYS = 7;
// A later branch that re-touches at least half of what we merged reads as a fix.
export const FIX_OVERLAP = 0.5;

// Attention classes, keyed by the event that creates the inbox item.
const INBOX_EVENT_CLASS: Record<string, InboxClass> = {
  "needs-decision": "decision",
  checkpoint: "checkpoint",
  blocked_card: "dialog",
  stale: "stale",
};
// A review_summary only becomes an inbox item when it carries quiz questions.
// Both shapes count: the current `checks` array and the older single `check`.
const QUIZ_SQL =
  `(e.type = 'review_summary' AND (json_array_length(json_extract(e.payload, '$.understanding.checks')) > 0
     OR json_type(json_extract(e.payload, '$.understanding.check')) = 'object'))`;

export type InboxClass = "decision" | "quiz" | "checkpoint" | "dialog" | "stale";
export const INBOX_CLASSES: InboxClass[] = ["decision", "quiz", "checkpoint", "dialog", "stale"];

export interface AutonomyStatsOptions {
  days?: number;
  projectId?: string | null;
  now?: () => Date;
  // Omit to skip revert detection (file overlap still runs). Tests inject a fake.
  exec?: Exec | null;
}

export interface AutoMergeCase {
  task_id: string;
  number: number | null;
  title: string;
  merged_at: string;
  pr_url: string | null;
  merged_files: number;
  measurable: boolean;
  fix_signal: null | { kind: "file_overlap"; task_id: string; overlap: number } | { kind: "revert"; commit: string; subject: string };
}

function iso(d: Date): string {
  return d.toISOString();
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86_400_000);
}

function startOfNextUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1));
}

function parse(payload: string): any {
  try {
    return JSON.parse(payload);
  } catch {
    return {};
  }
}

// PR number from a github PR url. Null when the task merged without a PR.
function prNumber(url: string | null): number | null {
  const m = String(url ?? "").match(/\/pull\/(\d+)/);
  return m ? Number(m[1]) : null;
}

// ---- 1. auto-merge precision ----------------------------------------------

// Files hive merged, from the `merged` event mergeTask writes. Older merges
// predate merged_files; they are counted as merges but can never show a
// file-overlap fix signal (revert detection still applies).
function mergedFilesFor(db: DB, taskId: string, at: string): string[] {
  const row: any = db
    .query("SELECT payload FROM events WHERE task_id = ? AND type = 'merged' AND ts <= ? ORDER BY ts DESC, rowid DESC LIMIT 1")
    .get(taskId, at);
  const files = row ? parse(row.payload).merged_files : null;
  return Array.isArray(files) ? files.filter((f: unknown) => typeof f === "string") : [];
}

// A later task in the same project whose branch re-touches >= FIX_OVERLAP of
// what we merged. Branch file lists come from `branch_scope` events (the rebase
// guard already captures them at first review hand-off).
function fileOverlapFix(
  db: DB,
  projectId: string,
  taskId: string,
  files: string[],
  from: string,
  to: string
): { kind: "file_overlap"; task_id: string; overlap: number } | null {
  if (!files.length) return null;
  const want = new Set(files);
  const rows = db
    .query(
      `SELECT e.task_id, e.payload FROM events e JOIN tasks t ON t.id = e.task_id
        WHERE e.type = 'branch_scope' AND e.task_id != ? AND t.project_id = ?
          AND e.ts > ? AND e.ts <= ? ORDER BY e.ts ASC`
    )
    .all(taskId, projectId, from, to) as { task_id: string; payload: string }[];
  for (const row of rows) {
    const later: unknown = parse(row.payload).files;
    if (!Array.isArray(later)) continue;
    const hits = new Set(later.filter((f) => want.has(f as string))).size;
    const overlap = hits / want.size;
    if (overlap >= FIX_OVERLAP) return { kind: "file_overlap", task_id: row.task_id, overlap };
  }
  return null;
}

// Revert commits landed on the project's default branch inside the window,
// as `<sha>\0<subject>` lines. One git call per project, cached by the caller.
async function revertCommits(exec: Exec, repoPath: string, base: string, from: string, to: string): Promise<string[]> {
  const r = await exec([
    "git", "-C", repoPath, "log", base,
    `--since=${from}`, `--until=${to}`, "--format=%H%x00%s", "--grep=revert", "-i",
  ]);
  if (r.code !== 0) return [];
  return r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

function revertFix(commits: string[], pr: number | null): { kind: "revert"; commit: string; subject: string } | null {
  if (pr === null) return null;
  const mentions = new RegExp(`#${pr}(?!\\d)`);
  for (const line of commits) {
    const [commit, subject = ""] = line.split("\0");
    if (mentions.test(subject)) return { kind: "revert", commit, subject };
  }
  return null;
}

// ---- the collector ---------------------------------------------------------

export async function autonomyStats(db: DB, opts: AutonomyStatsOptions = {}) {
  const days = Math.max(1, Math.min(365, Math.floor(Number(opts.days) || 30)));
  const clock = opts.now ?? (() => new Date());
  // Snap the window to whole UTC days so "per day" means a calendar day and
  // every event in the window lands in one of the buckets. The last bucket is
  // today, still filling up.
  const until = startOfNextUtcDay(clock());
  const since = addDays(until, -days);
  const from = iso(since);
  const to = iso(until);
  const projectId = opts.projectId ?? null;
  const projectFilter = projectId ? " AND t.project_id = ?" : "";
  const projectArg: string[] = projectId ? [projectId] : [];

  // --- 1. auto-merge precision
  const merges = db
    .query(
      `SELECT e.task_id, e.ts, t.project_id, t.number, t.title, t.pr_url
         FROM events e JOIN tasks t ON t.id = e.task_id
        WHERE e.type = 'auto_merged' AND json_extract(e.payload, '$.ok') = 1
          AND e.ts >= ? AND e.ts < ?${projectFilter}
        ORDER BY e.ts ASC`
    )
    .all(from, to, ...projectArg) as { task_id: string; ts: string; project_id: string; number: number | null; title: string; pr_url: string | null }[];

  const exec = opts.exec === null ? null : (opts.exec ?? defaultExec);
  const revertCache = new Map<string, string[]>();
  const cases: AutoMergeCase[] = [];
  for (const m of merges) {
    const files = mergedFilesFor(db, m.task_id, m.ts);
    const deadline = iso(addDays(new Date(m.ts), FIX_WINDOW_DAYS));
    let signal: AutoMergeCase["fix_signal"] = fileOverlapFix(db, m.project_id, m.task_id, files, m.ts, deadline);
    if (!signal && exec) {
      if (!revertCache.has(m.project_id)) {
        const project: any = db.query("SELECT repo_path, config FROM projects WHERE id = ?").get(m.project_id);
        revertCache.set(
          m.project_id,
          project?.repo_path
            ? await revertCommits(exec, project.repo_path, projectBaseBranch(parse(project.config ?? "{}")), from, iso(addDays(until, FIX_WINDOW_DAYS)))
            : []
        );
      }
      signal = revertFix(revertCache.get(m.project_id)!, prNumber(m.pr_url));
    }
    cases.push({
      task_id: m.task_id,
      number: m.number,
      title: m.title,
      merged_at: m.ts,
      pr_url: m.pr_url,
      merged_files: files.length,
      // Could a fix signal have fired for this merge at all? A merge with no
      // recorded merged_files and no PR number is unmeasurable: it can only ever
      // come back "clean", which is absence of data, not evidence of a good merge.
      measurable: files.length > 0 || (!!exec && prNumber(m.pr_url) !== null),
      fix_signal: signal,
    });
  }
  const fixed = cases.filter((c) => c.fix_signal);
  // Precision is measured over the merges we could actually have caught a fix
  // for. Merges predating merged_files (and, with reverts off, every merge) are
  // excluded rather than silently counted as clean: a denominator of unmeasurable
  // merges returns a confident 1.0 that means "we looked at nothing".
  const measurable = cases.filter((c) => c.measurable);

  // --- 2. inbox load, per day by class
  const inboxRows = db
    .query(
      `SELECT substr(e.ts, 1, 10) AS day, e.type AS type, COUNT(*) AS n
         FROM events e JOIN tasks t ON t.id = e.task_id
        WHERE e.ts >= ? AND e.ts < ?${projectFilter}
          AND (e.type IN ('needs-decision', 'checkpoint', 'blocked_card', 'stale') OR ${QUIZ_SQL})
        GROUP BY day, e.type`
    )
    .all(from, to, ...projectArg) as { day: string; type: string; n: number }[];

  const byDay = new Map<string, Record<InboxClass, number>>();
  const totals = Object.fromEntries(INBOX_CLASSES.map((c) => [c, 0])) as Record<InboxClass, number>;
  for (let i = 0; i < days; i++) {
    byDay.set(iso(addDays(since, i)).slice(0, 10), Object.fromEntries(INBOX_CLASSES.map((c) => [c, 0])) as Record<InboxClass, number>);
  }
  for (const row of inboxRows) {
    const cls = INBOX_EVENT_CLASS[row.type] ?? "quiz";
    const day = byDay.get(row.day);
    if (day) day[cls] += row.n;
    totals[cls] += row.n;
  }
  const inboxTotal = INBOX_CLASSES.reduce((sum, c) => sum + totals[c], 0);

  // --- 3. recovery
  const recovery: any = db
    .query(
      `SELECT
         SUM(CASE WHEN e.type = 'recovery' AND json_extract(e.payload, '$.decision') = 'turn-complete-respawn'
                   AND json_extract(e.payload, '$.respawned') = 1 THEN 1 ELSE 0 END) AS auto_respawns,
         SUM(CASE WHEN e.type = 'recovery' AND json_extract(e.payload, '$.decision') = 'turn-complete-respawn-held'
                   AND json_extract(e.payload, '$.reason') = 'project max_agents' THEN 1 ELSE 0 END) AS one_cap_parks,
         SUM(CASE WHEN e.type = 'spawned' AND t.kind = 'scout' THEN 1 ELSE 0 END) AS scouts_spawned
       FROM events e JOIN tasks t ON t.id = e.task_id
      WHERE e.ts >= ? AND e.ts < ?${projectFilter}`
    )
    .get(from, to, ...projectArg);

  // --- 4. agreement scaffold
  const autoAnswered = Number(
    (db
      .query(
        `SELECT COUNT(*) AS n FROM decisions d JOIN tasks t ON t.id = d.task_id
          WHERE d.status = 'answered' AND d.answered_by IN ('chat_supervisor', 'system')
            AND d.answered_at >= ? AND d.answered_at < ?${projectFilter}`
      )
      .get(from, to, ...projectArg) as any)?.n ?? 0
  );
  const contradictions = Number(
    (db
      .query(
        `SELECT COUNT(*) AS n FROM events e JOIN tasks t ON t.id = e.task_id
          WHERE e.type = 'decision_contradicted' AND e.ts >= ? AND e.ts < ?${projectFilter}`
      )
      .get(from, to, ...projectArg) as any)?.n ?? 0
  );
  const autoContradicted = Number(
    (db
      .query(
        `SELECT COUNT(*) AS n FROM events e JOIN tasks t ON t.id = e.task_id
          WHERE e.type = 'decision_contradicted' AND json_extract(e.payload, '$.prior_source') IN ('chat_supervisor', 'system')
            AND e.ts >= ? AND e.ts < ?${projectFilter}`
      )
      .get(from, to, ...projectArg) as any)?.n ?? 0
  );

  return {
    window: { days, since: from, until: to },
    auto_merge_precision: {
      merges: cases.length,
      measurable: measurable.length,
      clean: measurable.length - fixed.length,
      fixed: fixed.length,
      precision: measurable.length ? (measurable.length - fixed.length) / measurable.length : null,
      revert_detection: exec ? "on" : "off",
      cases,
    },
    inbox_load: {
      by_day: [...byDay.entries()].map(([day, counts]) => ({ day, ...counts, total: INBOX_CLASSES.reduce((s, c) => s + counts[c], 0) })),
      totals: { ...totals, total: inboxTotal },
      per_day: inboxTotal / days,
    },
    recovery: {
      auto_respawns: Number(recovery?.auto_respawns ?? 0),
      one_cap_parks: Number(recovery?.one_cap_parks ?? 0),
      scouts_spawned: Number(recovery?.scouts_spawned ?? 0),
    },
    agreement: {
      auto_answered: autoAnswered,
      contradictions,
      auto_contradicted: autoContradicted,
      agreement_rate: autoAnswered ? (autoAnswered - autoContradicted) / autoAnswered : null,
    },
  };
}
