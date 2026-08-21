import type { DB } from "./db.ts";

export function projectPrefix(name: string): string {
  // ponytail: derive the prefix until active projects actually need an override.
  return name.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4) || "TASK";
}

export function taskIdentifier(db: DB, task: { project_id: string; project_number?: number | null; number: number }): string {
  const project = db.query("SELECT name FROM projects WHERE id = ?").get(task.project_id) as { name: string } | undefined;
  return `${projectPrefix(project?.name ?? "")}-${task.project_number ?? task.number}`;
}
