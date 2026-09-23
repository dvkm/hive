import type { DB } from "./db.ts";

export function projectPrefix(name: string): string {
  // ponytail: derive the prefix until active projects actually need an override.
  return name.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4) || "TASK";
}

export function taskIdentifier(db: DB, task: { project_id: string; project_number?: number | null; number: number }): string {
  const project = db.query("SELECT name FROM projects WHERE id = ?").get(task.project_id) as { name: string } | undefined;
  return `${projectPrefix(project?.name ?? "")}-${task.project_number ?? task.number}`;
}

// The branch name a person on the team would pick: the ticket key when there is
// one, then the first words of the title. Uniqueness is the caller's job.
export function branchSlug(task: { title: string; jira_key?: string | null }): string {
  const key = String(task.jira_key || /\b([A-Z][A-Z0-9]+-\d+)\b/.exec(task.title)?.[1] || "").toLowerCase();
  const words = task.title
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/['’]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((w) => w && !key.split("-").includes(w))
    .slice(0, 5);
  const slug = [key, ...words].filter(Boolean).join("-").slice(0, 48).replace(/-+$/, "");
  return slug || "change";
}

// The task a branch belongs to, when hive named it. `hive/<id>` is the legacy
// shape; newer branches carry a plain name and are known only by the
// `branch_named` event written when hive picked it, so a person's branch that
// happens to share the name is never mistaken for hive's.
export function taskForHiveBranch(db: DB, projectId: string | null, branch: string | null | undefined): string | null {
  if (!branch) return null;
  const legacy = /^hive\/([^/]+)$/.exec(branch)?.[1];
  if (legacy) return legacy;
  const row = db
    .query(
      `SELECT e.task_id FROM events e JOIN tasks t ON t.id = e.task_id
        WHERE e.type = 'branch_named' AND json_extract(e.payload, '$.branch') = ?
          AND (? IS NULL OR t.project_id = ?)
        ORDER BY e.ts DESC LIMIT 1`
    )
    .get(branch, projectId, projectId) as { task_id: string } | undefined;
  return row?.task_id ?? null;
}
