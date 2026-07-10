// System-written learnings. Agents were told to READ learnings (briefs,
// planner) but nothing ever WROTE them automatically — every failure pattern
// had to be hand-recorded, so most weren't (2026-07-10: a 74-spawn-error
// incident produced zero learnings). Mechanical failure paths now upsert a
// learning keyed by (project, normalized signature): a recurrence bumps
// occurrences instead of duplicating, so the ledger reads "seen 74×", not 74 rows.
import type { DB } from "./db.ts";
import { now, newId } from "./db.ts";
import { broadcast } from "./bus.ts";

// Normalize a message into a stable signature: ids, hashes, paths, and numbers
// vary per occurrence; the pattern doesn't.
export function signature(text: string): string {
  return text
    .replace(/[a-f0-9]{12,}/gi, "<id>")
    .replace(/\/[^\s'"`)]+/g, "<path>")
    .replace(/\b\d+\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 110);
}

export function recordSystemLearning(
  db: DB,
  projectId: string,
  title: string,
  body: string | null,
  sourceTaskId?: string | null
): void {
  try {
    const t = now();
    const existing = db
      .query("SELECT id, occurrences FROM learnings WHERE project_id = ? AND title = ? LIMIT 1")
      .get(projectId, title) as { id: string; occurrences: number } | undefined;
    if (existing) {
      db.query(
        "UPDATE learnings SET occurrences = occurrences + 1, last_seen = ?, status = 'active' WHERE id = ?"
      ).run(t, existing.id);
      broadcast({ type: "learning", learning: { id: existing.id, occurrences: existing.occurrences + 1 } });
      return;
    }
    const row = {
      id: newId("lrn"),
      project_id: projectId,
      title,
      body,
      source_task_id: sourceTaskId ?? null,
      occurrences: 1,
      first_seen: t,
      last_seen: t,
      status: "active",
      root_cause_task_id: null,
    };
    db.query(
      `INSERT INTO learnings (id, project_id, title, body, source_task_id, occurrences,
        first_seen, last_seen, status, root_cause_task_id) VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run(
      row.id, row.project_id, row.title, row.body, row.source_task_id, row.occurrences,
      row.first_seen, row.last_seen, row.status, row.root_cause_task_id
    );
    broadcast({ type: "learning", learning: row });
  } catch (e) {
    // A ledger write must never break the failure path that triggered it.
    console.error("[hive] recordSystemLearning:", e);
  }
}
