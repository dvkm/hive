// The director's one view of what happened while they were away, per project:
// what shipped (read from GitHub, so work done outside hive counts too), what
// hive decided on its own, what is stuck, what is moving, and what came in.
// The window runs from the director's last look, and always covers at least
// the last day, so a refresh never empties it.
import type { DB } from "./db.ts";
import { getSetting, setSetting } from "./db.ts";
import { activeProjects } from "./testProjects.ts";
import { taskForHiveBranch } from "./taskIdentifier.ts";
import type { Exec } from "./exec.ts";
import { defaultExec, GH_LIST_TIMEOUT_MS, mapLimit } from "./exec.ts";
import { askedReporterAt, reporterReplyAt } from "./intentInvestigate.ts";
import type { Intent } from "./intents.ts";

const SEEN_KEY = "digest_seen_at";
const DAY_MS = 24 * 60 * 60 * 1000;
const SHIPPED_CAP = 8;
const LIST_CAP = 5;
const GH_CACHE_MS = 5 * 60 * 1000;

export interface ShippedPr {
  title: string;
  url: string;
  merged_at: string;
  task_id: string | null;
}

export interface ProjectDigest {
  id: string;
  name: string;
  shipped: ShippedPr[];
  shipped_total: number;
  decided: { decision_id: string; task_id: string; question: string; answer: string; why: string | null; at: string }[];
  stuck: { task_id: string; title: string; reason: string; since: string | null }[];
  working: { task_id: string; title: string }[];
  working_total: number;
  queued: number;
  waiting_on_others: { task_id: string; title: string; key: string | null; asked_at: string }[];
  new_requests: { task_id: string; key: string | null; title: string; at: string }[];
  // Scout reports hive accepted on its own (they ask for nothing), to read when wanted.
  reports: { task_id: string; title: string; url: string | null; at: string }[];
  github_error?: string;
}

export interface Digest {
  since: string;
  until: string;
  projects: ProjectDigest[];
}

const ghCache = new Map<string, { at: number; value: { prs: any[] } | { error: string } | null }>();

// Merged PRs since a date, straight from GitHub. A checkout with no GitHub
// remote has nothing to report, which is not an error.
async function mergedPrs(repoPath: string, sinceDay: string, exec: Exec, nowMs: number): Promise<{ prs: any[] } | { error: string } | null> {
  const key = `${repoPath}\0${sinceDay}`;
  const hit = ghCache.get(key);
  if (hit && nowMs - hit.at < GH_CACHE_MS) return hit.value;
  const r = await exec(
    ["gh", "pr", "list", "--state", "merged", "--search", `merged:>=${sinceDay}`, "--limit", "100", "--json", "number,title,url,mergedAt,headRefName"],
    { cwd: repoPath, timeoutMs: GH_LIST_TIMEOUT_MS }
  ).catch((e: any) => ({ code: 1, stdout: "", stderr: String(e?.message ?? e) }));
  let value: { prs: any[] } | { error: string } | null;
  if (r.code !== 0) {
    const text = `${r.stderr}${r.stdout}`;
    value = /remote|not a git repository|known github host/i.test(text) ? null : { error: "GitHub could not be read" };
  } else {
    try {
      const parsed = JSON.parse(r.stdout);
      value = { prs: Array.isArray(parsed) ? parsed : [] };
    } catch {
      value = { error: "GitHub could not be read" };
    }
  }
  ghCache.set(key, { at: nowMs, value });
  return value;
}

function optionLabel(options: string | null, key: string | null): string {
  try {
    const found = (JSON.parse(options || "[]") as any[]).find((o) => o?.key === key);
    return String(found?.label ?? key ?? "");
  } catch {
    return String(key ?? "");
  }
}

function projectDigest(db: DB, project: { id: string; name: string }, since: string): Omit<ProjectDigest, "shipped" | "shipped_total"> {
  const decided = (db
    .query(
      `SELECT d.id, d.task_id, d.title, d.options, d.answer_key, d.answer_note, d.answered_at FROM decisions d
         JOIN tasks t ON t.id = d.task_id
        WHERE t.project_id = ? AND d.status = 'answered' AND d.answered_at >= ?
          AND COALESCE(d.answered_by, '') NOT IN ('director', 'unattributed')
        ORDER BY d.answered_at DESC LIMIT ?`
    )
    .all(project.id, since, LIST_CAP) as any[]).map((d) => ({
    decision_id: d.id,
    task_id: d.task_id,
    question: d.title,
    answer: optionLabel(d.options, d.answer_key),
    why: d.answer_note ?? null,
    at: d.answered_at,
  }));

  const stuck = (db
    .query(
      `SELECT t.id, t.title, t.updated_at,
              (SELECT json_extract(e.payload, '$.reason') FROM events e
                WHERE e.task_id = t.id AND e.type = 'state_change' AND json_extract(e.payload, '$.to') = 'failed'
                ORDER BY e.ts DESC LIMIT 1) AS reason
         FROM tasks t
        WHERE t.project_id = ? AND t.state = 'failed' AND t.updated_at >= ?
          AND COALESCE(t.source, '') NOT IN ('external', 'chat_supervisor')
          AND NOT EXISTS (SELECT 1 FROM tasks s WHERE s.parent_task_id = t.id AND s.source = 'requeue')
        ORDER BY t.updated_at DESC LIMIT ?`
    )
    .all(project.id, since, LIST_CAP) as any[]).map((t) => ({
    task_id: t.id,
    title: t.title,
    reason: String(t.reason ?? "it failed and hive has not retried it"),
    since: t.updated_at ?? null,
  }));

  const liveWhere = `t.project_id = ? AND COALESCE(t.source, '') NOT IN ('external', 'chat_supervisor') AND COALESCE(t.jira_link_kind, '') != 'mirror'`;
  const working = db
    .query(`SELECT t.id, t.title FROM tasks t WHERE ${liveWhere} AND t.state IN ('in_progress', 'needs_decision', 'in_review') ORDER BY t.updated_at DESC`)
    .all(project.id) as { id: string; title: string }[];
  const queued = (db.query(`SELECT COUNT(*) AS n FROM tasks t WHERE ${liveWhere} AND t.state = 'queued'`).get(project.id) as { n: number }).n;

  const waiting_on_others = (db
    .query(`SELECT * FROM intents WHERE project_id = ? AND status = 'draft' AND source = 'jira' ORDER BY created_at DESC`)
    .all(project.id) as Intent[])
    .flatMap((intent) => {
      const asked = askedReporterAt(db, intent);
      if (!asked || reporterReplyAt(db, intent)) return [];
      const mirror = db
        .query("SELECT id, title FROM tasks WHERE project_id = ? AND jira_key = ? AND jira_link_kind = 'mirror' LIMIT 1")
        .get(project.id, intent.source_ref) as { id: string; title: string } | undefined;
      return [{ task_id: mirror?.id ?? intent.task_id ?? "", title: mirror?.title ?? String(intent.source_ref ?? ""), key: intent.source_ref ?? null, asked_at: asked }];
    })
    .slice(0, LIST_CAP);

  const new_requests = (db
    .query(
      `SELECT id, jira_key, title, created_at FROM tasks
        WHERE project_id = ? AND jira_link_kind = 'mirror' AND created_at >= ? ORDER BY created_at DESC LIMIT ?`
    )
    .all(project.id, since, LIST_CAP) as any[]).map((t) => ({ task_id: t.id, key: t.jira_key ?? null, title: t.title, at: t.created_at }));

  const reports = (db
    .query(
      `SELECT t.id, t.title, e.ts AS at,
              (SELECT v.url FROM evidence v WHERE v.task_id = t.id AND v.kind = 'report' ORDER BY v.ts DESC LIMIT 1) AS url
         FROM tasks t JOIN events e ON e.task_id = t.id
        WHERE t.project_id = ? AND t.kind = 'scout' AND e.type = 'state_change'
          AND json_extract(e.payload, '$.to') = 'verifying' AND e.ts >= ?
        ORDER BY e.ts DESC LIMIT ?`
    )
    .all(project.id, since, LIST_CAP) as any[]).map((r) => ({ task_id: r.id, title: r.title, url: r.url ?? null, at: r.at }));

  return {
    id: project.id,
    name: project.name,
    reports,
    decided,
    stuck,
    working: working.slice(0, LIST_CAP).map((t) => ({ task_id: t.id, title: t.title })),
    working_total: working.length,
    queued,
    waiting_on_others,
    new_requests,
  };
}

export async function buildDigest(db: DB, opts: { since?: string | null; mark?: boolean; exec?: Exec; nowMs?: number } = {}): Promise<Digest> {
  const nowMs = opts.nowMs ?? Date.now();
  const until = new Date(nowMs).toISOString();
  const floor = new Date(nowMs - DAY_MS).toISOString();
  const seen = getSetting(db, SEEN_KEY);
  const asked = opts.since && !Number.isNaN(Date.parse(opts.since)) ? new Date(opts.since).toISOString() : null;
  const since = asked ?? (seen && seen < floor ? seen : floor);
  const exec = opts.exec ?? defaultExec;
  const projects = activeProjects(db).filter((p) => p.repo_path) as { id: string; name: string; repo_path: string }[];

  const shipped = await mapLimit(projects, 3, async (p) => {
    const result = await mergedPrs(p.repo_path, since.slice(0, 10), exec, nowMs);
    if (!result) return { shipped: [] as ShippedPr[], shipped_total: 0 };
    if ("error" in result) return { shipped: [] as ShippedPr[], shipped_total: 0, github_error: result.error };
    const prs = result.prs
      .filter((pr) => typeof pr?.mergedAt === "string" && pr.mergedAt >= since)
      .sort((a, b) => String(b.mergedAt).localeCompare(String(a.mergedAt)))
      .map((pr): ShippedPr => {
        const byUrl = db.query("SELECT id FROM tasks WHERE project_id = ? AND pr_url = ? LIMIT 1").get(p.id, pr.url) as { id: string } | undefined;
        return {
          title: String(pr.title ?? "").replace(/^\[hive-\d+\]\s*/, ""),
          url: String(pr.url ?? ""),
          merged_at: pr.mergedAt,
          task_id: byUrl?.id ?? taskForHiveBranch(db, p.id, pr.headRefName),
        };
      });
    return { shipped: prs.slice(0, SHIPPED_CAP), shipped_total: prs.length };
  });

  const digest: Digest = {
    since,
    until,
    projects: projects.map((p, i) => ({ ...projectDigest(db, p, since), ...shipped[i] })),
  };
  if (opts.mark) setSetting(db, SEEN_KEY, until);
  return digest;
}
