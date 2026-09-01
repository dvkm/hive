// The attention budget: how many things need the director right now, and what
// hive stops doing when that number outgrows one person.
//
// The count is NOT a second definition of "needs you". It calls the exact
// function the board, the nav badge and the inbox call
// (web/src/lib/needsYou.ts), fed the same four lists those surfaces fetch:
// open decisions, open checkpoints, open understanding checks, and tasks with
// health. A count that disagrees with the badge would be worse than no count.
//
// Over budget, hive pauses its OPTIONAL generators — the two that file work
// nobody asked for right now:
//   - auto-dispatching queued scouts (investigations, not shipping work)
//   - filing new watcher tasks (a watched doc changed)
// Everything else keeps running. A monitor firing still files its incident
// task: something is already down, and that is not optional.
//
// The threshold is a starting hypothesis, not a cap on concurrency. Nothing
// running is ever stopped or throttled by it; only NEW optional work waits.
import type { DB } from "./db.ts";
import { getSetting, setSetting } from "./db.ts";
import { parseTask, parseDecision } from "./rows.ts";
import { tasksWithHealth } from "./health.ts";
import { notTestProjectSql } from "./testProjects.ts";
import { openCheckpointRows, openUnderstandingQuizzes } from "./api.ts";
import { getNeedsYouItems, isActionable, itemProject, inProjectFilter } from "../../web/src/lib/needsYou.ts";

// Conductor's 3-5 concurrent-workspace sweet spot is where 5 comes from. It is
// a hypothesis about how much a person can hold, not a number to enforce.
export const ATTENTION_BUDGET_DEFAULT = 5;
const SETTING_KEY = "attention_budget";

export function attentionThreshold(db: DB): number {
  const stored = getSetting(db, SETTING_KEY);
  if (stored === null || stored === "") return ATTENTION_BUDGET_DEFAULT;
  const raw = Number(stored);
  // A stored 0 means "no budget" — never pause anything. An unreadable value
  // falls back to the default rather than silently turning the budget off.
  return Number.isFinite(raw) && raw >= 0 ? raw : ATTENTION_BUDGET_DEFAULT;
}

export function setAttentionThreshold(db: DB, value: number): void {
  setSetting(db, SETTING_KEY, String(Math.max(0, Math.floor(value))));
}

// Same rows the browser fetches for its three needs-you surfaces, so the number
// here and the number in the nav badge come out of the same input.
function actionable(db: DB, projectId = ""): { project_id?: string }[] {
  const tasks = tasksWithHealth(
    db,
    db
      .query(
        `SELECT t.*,
          CASE WHEN t.state IN ('in_review', 'failed') THEN COALESCE(
            (SELECT MAX(e.ts) FROM events e WHERE e.task_id = t.id AND e.type = 'state_change'
              AND json_extract(e.payload, '$.to') = t.state), t.updated_at)
          END AS needs_you_since
         FROM tasks t JOIN projects p ON p.id = t.project_id
         WHERE ${notTestProjectSql("p.config")}`
      )
      .all()
      .map(parseTask)
  );
  const decisions = db
    .query(
      `SELECT d.* FROM decisions d JOIN tasks t ON t.id = d.task_id JOIN projects p ON p.id = t.project_id
        WHERE d.status = 'open' AND ${notTestProjectSql("p.config")}`
    )
    .all()
    .map(parseDecision);
  const checkpoints = openCheckpointRows(db, null).map((row: any) => ({
    id: row.id,
    task_id: row.task_id,
    ts: row.ts,
    project_id: row.project_id,
  }));
  const quizzes = openUnderstandingQuizzes(db, null);
  return getNeedsYouItems(decisions as any, tasks as any, checkpoints as any, quizzes as any)
    .filter((item) => isActionable(item) && inProjectFilter(itemProject(item, tasks as any), projectId))
    .map((item) => ({ project_id: itemProject(item, tasks as any) }));
}

export interface AttentionBudget {
  count: number;
  threshold: number;
  over: boolean;
  // What is paused right now, in the director's words. Empty when nothing is.
  paused: string[];
}

// The budget is the DIRECTOR's, not a project's: three projects at four items
// each is twelve things waiting on one person. So the count is fleet-wide and
// the pause is fleet-wide, whatever project the generator belongs to.
export function attentionBudget(db: DB, projectId = ""): AttentionBudget {
  const threshold = attentionThreshold(db);
  const count = actionable(db, projectId).length;
  const over = threshold > 0 && count > threshold;
  return { count, threshold, over, paused: over ? ["new scouts", "watcher tasks"] : [] };
}

// Is hive over budget right now? Used by the optional generators before they
// file or dispatch anything new.
export function overAttentionBudget(db: DB): boolean {
  return attentionBudget(db).over;
}
