import type { DB } from "./db.ts";
import { isOffline, newId } from "./db.ts";
import { broadcastTask } from "./health.ts";
import { startLoop } from "./loop.ts";
import { getTask, writeEvent } from "./state.ts";
import { activeProjects } from "./testProjects.ts";

export const SELF_AUDIT_CADENCE_MS = 7 * 24 * 60 * 60 * 1000;

const BRIEF = `Audit Hive's agent efficiency over the last 7 days, compare it with the preceding 7 days, and identify at most one measured improvement.

Use the Hive database and available provider trajectory JSONL files as evidence. Break token use down by task kind and inspect input/output/cache/processed tokens, failed or cancelled work, context compactions and retries, repeated file reads or tool calls, manager and reviewer overhead, idle waits, and duplicated validation. Look beyond this list when the data points elsewhere.

Attach the audit findings as report evidence. If there is no safe, material improvement supported by the evidence, finish without changing code. Otherwise, create exactly one ship follow-up task with the baseline, expected effect, and evidence in its brief. Do not edit code in this audit task. The follow-up must make the smallest change, add one focused behavioral test, and use Hive's normal dispatch, authority, PR, review, CI, and merge controls. Do not make broad refactors, weaken safety or review gates, or add an abstraction for a single use.`;

export function selfAuditOnce(db: DB, nowMs = Date.now()): string | null {
  if (isOffline(db)) return null;
  const project = activeProjects(db).find((p) => p.name.trim().toLowerCase() === "hive" && p.repo_path);
  if (!project) return null;

  const id = db.transaction(() => {
    const latest = db
      .query("SELECT state, created_at FROM tasks WHERE project_id = ? AND source = 'self-audit' ORDER BY created_at DESC LIMIT 1")
      .get(project.id) as { state: string; created_at: string } | undefined;
    if (latest) {
      if (!["done", "cancelled", "failed"].includes(latest.state)) return null;
      if (nowMs - Date.parse(latest.created_at) < SELF_AUDIT_CADENCE_MS) return null;
    }

    const id = newId("tsk");
    const timestamp = new Date(nowMs).toISOString();
    db.query(
      `INSERT INTO tasks (id, project_id, title, brief, state, kind, source, priority, created_at, updated_at)
       VALUES (?,?,?,?, 'queued', 'scout', 'self-audit', 'next', ?, ?)`
    ).run(id, project.id, "Audit Hive efficiency and identify one measured improvement", BRIEF, timestamp, timestamp);
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
