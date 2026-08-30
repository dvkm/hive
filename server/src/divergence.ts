// Divergence radar (HIVE-348).
//
// The land graph answers "which of these finished PRs may land next". This
// answers the earlier question: of the branches still being WORKED ON, which
// ones have already drifted from the branch they will land on, and which ones
// are quietly editing the same files as a sibling. Both facts are cheap to read
// from git and impossible to see on the board today — they surface at merge
// time, as a conflict, after the review has already been done.
//
// It deliberately reuses `authoredFiles`, the same three-dot diff the rebase
// guard and the land graph's conflict edges use. One detector, three readers.
import type { DB } from "./db.ts";
import { authoredFiles } from "./rebaseGuard.ts";
import { defaultExec, projectComparisonBase, type Exec } from "./exec.ts";

// The states where a branch exists and is still moving. `verifying` and `done`
// have already merged; anything before `in_progress` has no branch yet.
const IN_FLIGHT = ["in_progress", "in_review", "needs_decision"];

export interface DivergenceOverlap {
  task_id: string;
  number: number;
  files: string[]; // capped, same cap the land graph uses
}

export interface DivergenceRow {
  id: string;
  number: number;
  title: string;
  state: string;
  branch: string;
  // Commits on the target branch that this branch does not have. null = git
  // could not tell (branch not fetched locally, bad ref); never treated as 0.
  behind: number | null;
  files: number; // how many files the branch authors
  overlaps: DivergenceOverlap[];
}

export interface ProjectDivergence {
  project_id: string;
  base: string; // the ref everything is measured against, e.g. origin/main
  rows: DivergenceRow[];
}

// How far `branch` trails `base`. `git rev-list --count branch..base` counts the
// commits base has that branch doesn't, which is exactly "commits behind".
async function commitsBehind(exec: Exec, repoPath: string, base: string, branch: string): Promise<number | null> {
  const r = await exec(["git", "-C", repoPath, "rev-list", "--count", `${branch}..${base}`]);
  if (r.code !== 0) return null;
  const n = Number(r.stdout.trim());
  return Number.isFinite(n) ? n : null;
}

// Divergence for one project's in-flight branches. Git is read once per branch,
// not once per pair. Any git failure means "can't tell" for that branch — a
// null count and no overlaps, never a blocked or hidden card.
export async function divergence(db: DB, projectId: string, exec: Exec = defaultExec): Promise<ProjectDivergence> {
  const project: any = db.query("SELECT repo_path, config FROM projects WHERE id = ?").get(projectId);
  const base = projectComparisonBase(JSON.parse(project?.config ?? "{}"));
  if (!project?.repo_path) return { project_id: projectId, base, rows: [] };

  const tasks = db
    .query(
      `SELECT id, number, title, state, branch FROM tasks
        WHERE project_id = ? AND branch IS NOT NULL AND branch != ''
          AND state IN (${IN_FLIGHT.map(() => "?").join(", ")})
        ORDER BY number`
    )
    .all(projectId, ...IN_FLIGHT) as { id: string; number: number; title: string; state: string; branch: string }[];

  const files = new Map<string, Set<string>>();
  const rows: DivergenceRow[] = [];
  for (const t of tasks) {
    const authored = await authoredFiles(exec, project.repo_path, base, t.branch);
    if (authored?.length) files.set(t.id, new Set(authored));
    rows.push({
      id: t.id,
      number: t.number,
      title: t.title,
      state: t.state,
      branch: t.branch,
      behind: await commitsBehind(exec, project.repo_path, base, t.branch),
      files: authored?.length ?? 0,
      overlaps: [],
    });
  }

  const byId = new Map(rows.map((r) => [r.id, r]));
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = files.get(rows[i].id);
      const b = files.get(rows[j].id);
      if (!a || !b) continue;
      const shared = [...a].filter((f) => b.has(f)).slice(0, 5);
      if (!shared.length) continue;
      // Symmetric: each side lists the other, so a card shows its own clashes
      // without the board having to walk the whole table.
      byId.get(rows[i].id)!.overlaps.push({ task_id: rows[j].id, number: rows[j].number, files: shared });
      byId.get(rows[j].id)!.overlaps.push({ task_id: rows[i].id, number: rows[i].number, files: shared });
    }
  }
  return { project_id: projectId, base, rows };
}
