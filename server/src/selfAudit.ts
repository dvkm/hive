import type { DB } from "./db.ts";
import { isOffline, newId } from "./db.ts";
import { broadcastTask } from "./health.ts";
import { startLoop } from "./loop.ts";
import { getTask, writeEvent } from "./state.ts";
import { activeProjects } from "./testProjects.ts";

export const SELF_AUDIT_CADENCE_MS = 7 * 24 * 60 * 60 * 1000;

const BRIEF = `Audit Hive's agent efficiency over the last 7 days, compare it with the preceding 7 days, and ship at most one measured improvement.

Use the Hive database and available provider trajectory JSONL files as evidence. Break token use down by task kind and inspect input/output/cache/processed tokens, failed or cancelled work, context compactions and retries, repeated file reads or tool calls, manager and reviewer overhead, idle waits, and duplicated validation. Look beyond this list when the data points elsewhere.

Attach the audit findings as report evidence. If there is no safe, material improvement supported by the evidence, make no code change and emit done. Otherwise, record the baseline and expected effect, make the smallest change in this task, add one focused behavioral test, and use Hive's normal PR, review, CI, and merge controls. Do not create follow-up tasks, make broad refactors, weaken safety or review gates, or add an abstraction for a single use.`;

export function selfAuditOnce(db: DB, nowMs = Date.now()): string | null {
  if (isOffline(db)) return null;
  const project = activeProjects(db).find((p) => p.name.trim().toLowerCase() === "hive" && p.repo_path);
  if (!project) return null;

  const id = db.transaction(() => {
    const latest = db
      .query(`WITH RECURSIVE audit_lineage(id) AS (
          SELECT id FROM tasks WHERE project_id = ? AND source = 'self-audit'
          UNION
          SELECT child.id FROM tasks child
          JOIN audit_lineage parent ON child.parent_task_id = parent.id
          JOIN events created ON created.task_id = child.id
            AND created.type = 'created' AND created.source = 'reconciler'
            AND json_valid(created.payload)
            AND json_extract(created.payload, '$.requeue_of') = parent.id
          WHERE child.project_id = ? AND child.source = 'requeue'
        )
        SELECT state, created_at FROM tasks
        WHERE id IN (SELECT id FROM audit_lineage)
        ORDER BY created_at DESC LIMIT 1`)
      .get(project.id, project.id) as { state: string; created_at: string } | undefined;
    if (latest) {
      if (!["done", "cancelled", "failed"].includes(latest.state)) return null;
      if (nowMs - Date.parse(latest.created_at) < SELF_AUDIT_CADENCE_MS) return null;
    }

    const id = newId("tsk");
    const timestamp = new Date(nowMs).toISOString();
    db.query(
      `INSERT INTO tasks (id, project_id, title, brief, state, kind, source, priority, created_at, updated_at)
       VALUES (?,?,?,?, 'queued', 'ship', 'self-audit', 'next', ?, ?)`
    ).run(id, project.id, "Audit Hive efficiency and ship one measured improvement", BRIEF, timestamp, timestamp);
    writeEvent(db, { task_id: id, source: "system", type: "created", payload: { via: "self-audit" } });
    return id;
  }).immediate();
  if (!id) return null;
  broadcastTask(db, getTask(db, id));
  return id;
}

export function startSelfAudit(db: DB, intervalMs = 60 * 60 * 1000): () => void {
  return startLoop("self-audit", intervalMs, async () => {
    selfAuditOnce(db);
  });
}
