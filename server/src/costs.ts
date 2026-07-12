// Per-task cost guardrails. The top 3 tasks burned $428/$416/$288 — 22% of all
// spend on 2% of tasks — with nothing watching. Usage rows stream in per turn
// (hooks/report-usage.ts -> ingestUsage), so the check runs right where cost
// lands:
//
//   spend >= cost_warn_usd (default $75)  -> one-time steer: focus on shipping.
//   spend >= cost_cap_usd  (default $200) -> decision card: wrap up (recommended)
//                                            or continue (doubles the cap).
//
// Advisory, never blocking: the agent keeps working while the card is open —
// a cost ceiling is a judgment call, not an emergency stop. Steers are written
// as QUEUED events; the reconciler's drainSteers delivers them to a live agent
// within a cycle (<=60s), and a respawn brief carries them otherwise. Config
// per project: cost_warn_usd / cost_cap_usd (0 disables either).
import type { DB } from "./db.ts";
import { now } from "./db.ts";
import { getTask, writeEvent } from "./state.ts";
import { queueSteerEvent } from "./steer.ts";
import { createDecision } from "./api.ts";

const DEFAULT_WARN_USD = 75;
const DEFAULT_CAP_USD = 200;
const TERMINAL = ["done", "cancelled", "failed"];

function cfgNum(v: unknown, fallback: number): number {
  const n = Number(v);
  return v != null && Number.isFinite(n) ? n : fallback;
}

export function taskSpend(db: DB, taskId: string): number {
  const r: any = db.query("SELECT COALESCE(SUM(cost_usd), 0) AS c FROM usage WHERE task_id = ?").get(taskId);
  return Number(r?.c ?? 0);
}

function queueSteer(db: DB, taskId: string, message: string): void {
  queueSteerEvent(db, taskId, message, "queued by cost guardrail");
}

export function checkCostGuardrails(db: DB, taskId: string): void {
  const task = getTask(db, taskId);
  if (!task || TERMINAL.includes(task.state)) return;
  const project: any = db.query("SELECT config FROM projects WHERE id = ?").get(task.project_id);
  const cfg = JSON.parse(project?.config ?? "{}");
  const warn = cfgNum(cfg.cost_warn_usd, DEFAULT_WARN_USD);
  const cap = cfgNum(cfg.cost_cap_usd, DEFAULT_CAP_USD);
  if (warn <= 0 && cap <= 0) return;

  const spent = taskSpend(db, taskId);
  const counts: any = db
    .query(
      `SELECT
         COALESCE(SUM(type = 'cost_warning'), 0) AS warned,
         COALESCE(SUM(type = 'cost_cap'), 0) AS carded,
         COALESCE(SUM(type = 'cost_cap_raised'), 0) AS raised
       FROM events WHERE task_id = ?`
    )
    .get(taskId);
  // Each answered "continue" doubles the effective cap for this task.
  const effCap = cap > 0 ? cap * 2 ** Number(counts.raised) : Infinity;

  if (warn > 0 && spent >= warn && !Number(counts.warned) && spent < effCap) {
    writeEvent(db, {
      task_id: taskId,
      source: "system",
      type: "cost_warning",
      payload: { spent_usd: +spent.toFixed(2), warn_usd: warn },
    });
    queueSteer(
      db,
      taskId,
      `Cost check: this task has spent $${spent.toFixed(2)} in tokens (warn threshold $${warn}). ` +
        `Not a stop — but bias hard toward shipping: cut nice-to-haves, checkpoint open questions ` +
        `instead of exploring them, push WIP, and hand off as soon as the definition of done is met.`
    );
    return;
  }

  // One card per cap level: carded resets against raised, so after a "continue"
  // the next card only opens when the DOUBLED cap is crossed.
  if (cap > 0 && spent >= effCap && Number(counts.carded) <= Number(counts.raised)) {
    const decision = createDecision(db, {
      task_id: taskId,
      title: `Task #${task.number} passed its cost cap ($${effCap}) — wrap up or keep spending?`,
      context:
        `Token spend so far: $${spent.toFixed(2)} (cap $${effCap}). The agent keeps working while ` +
        `this is open; answering steers it. "${task.title}"`,
      risk: "normal",
      options: [
        {
          key: "wrap_up",
          label: "Wrap up now",
          detail: "Steer the agent to push WIP, attach evidence for what works, and open the PR with what's done.",
          recommended: true,
        },
        {
          key: "continue",
          label: `Continue (cap doubles to $${effCap * 2})`,
          detail: "Let it keep working; the next card opens at the doubled cap.",
        },
      ],
    });
    writeEvent(db, {
      task_id: taskId,
      source: "system",
      type: "cost_cap",
      payload: { spent_usd: +spent.toFixed(2), cap_usd: effCap, decision_id: decision.id },
    });
  }
}

// Answer hook (wired into apiAnswerDecision alongside the other resolvers).
// Returns true if this decision was a cost-cap card.
export function resolveCostCapForDecision(db: DB, decisionId: string, answerKey: string): boolean {
  const ev: any = db
    .query(
      "SELECT task_id FROM events WHERE type = 'cost_cap' AND json_extract(payload, '$.decision_id') = ? LIMIT 1"
    )
    .get(decisionId);
  if (!ev) return false;
  if (answerKey === "continue") {
    writeEvent(db, {
      task_id: ev.task_id,
      source: "director",
      type: "cost_cap_raised",
      payload: { decision_id: decisionId, at: now() },
    });
    queueSteer(db, ev.task_id, "Cost cap raised — keep going, but stay tight on the definition of done.");
  } else {
    queueSteer(
      db,
      ev.task_id,
      "Cost cap reached and the director chose WRAP UP: commit and push your WIP now, attach evidence " +
        "for what already works, open the PR with what's done (list gaps honestly in review_summary " +
        "'iffy'), and emit ready. Do not start anything new."
    );
  }
  return true;
}
