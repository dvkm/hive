// Per-task usage guardrails. Dollar caps cannot protect an unpriced model, so
// processed-token and wait-call limits run beside the existing cost limits.
//
//   spend >= cost_warn_usd -> one-time steer: focus on shipping.
//   spend >= cost_cap_usd  -> decision card: wrap up (recommended) or continue.
//
// Defaults are just above the observed normal range on 2026-08-22. A warning is
// advisory. A cap opens a decision and parks an in-progress task; wait caps also
// tell the worker to end its turn immediately.
import type { DB } from "./db.ts";
import { now } from "./db.ts";
import { getTask, writeEvent } from "./state.ts";
import { queueSteerEvent } from "./steer.ts";
import { createDecision, haltChatSupervisor } from "./api.ts";

// OFF by default (director's call, 2026-07-12): historical usage rows are inflated by the
// per-Stop cumulative double-count (fixed at ingestion the same day), so
// spend-sums can't be trusted until the old rows are rebuilt. Enable per
// project via config.cost_warn_usd / config.cost_cap_usd once numbers verify.
const DEFAULT_WARN_USD = 0;
const DEFAULT_CAP_USD = 0;
const DEFAULT_PROCESSED_TOKEN_WARN = 75_000_000;
const DEFAULT_PROCESSED_TOKEN_CAP = 200_000_000;
const DEFAULT_WAIT_CALL_WARN = 25;
const DEFAULT_WAIT_CALL_CAP = 100;
const TERMINAL = ["done", "cancelled", "failed"];

function cfgNum(v: unknown, fallback: number): number {
  const n = Number(v);
  return v != null && Number.isFinite(n) ? n : fallback;
}

export function taskSpend(db: DB, taskId: string): number {
  const r: any = db.query("SELECT COALESCE(SUM(cost_usd), 0) AS c FROM usage WHERE task_id = ?").get(taskId);
  return Number(r?.c ?? 0);
}

export function taskProcessedTokens(db: DB, taskId: string): number {
  const r: any = db
    .query(
      `SELECT COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens), 0) AS n
       FROM usage WHERE task_id = ?`
    )
    .get(taskId);
  return Number(r?.n ?? 0);
}

export function taskWaitCalls(db: DB, taskId: string): number {
  const r: any = db
    .query(
      `SELECT COUNT(*) AS n FROM events
       WHERE task_id = ? AND type = 'tool_use'
         AND lower(json_extract(payload, '$.tool')) IN ('wait', 'wait_agent')`
    )
    .get(taskId);
  return Number(r?.n ?? 0);
}

function queueSteer(db: DB, taskId: string, message: string): void {
  queueSteerEvent(db, taskId, message, "queued by usage guardrail");
}

function countEvents(db: DB, taskId: string, type: string): number {
  return Number((db.query("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = ?").get(taskId, type) as any)?.n ?? 0);
}

function openUsageCap(
  db: DB,
  task: any,
  kind: "processed_token" | "wait_call",
  value: number,
  cap: number
): void {
  const unit = kind === "wait_call" ? "wait calls" : "processed tokens";
  const decision = createDecision(db, {
    task_id: task.id,
    title: `Task #${task.number} passed its ${unit} cap (${cap.toLocaleString()}): wrap up or continue?`,
    context:
      `This task has used ${value.toLocaleString()} ${unit}. Hive parked it because this limit works even when the model has no price. ` +
      (kind === "wait_call" ? "Repeated waits are usually polling that Hive should handle. " : "") +
      `Choose continue to double this task's ${unit} cap.`,
    risk: "normal",
    options: [
      {
        key: "wrap_up",
        label: "Wrap up now",
        detail: "Stop polling, push current work, attach evidence, and hand off with any remaining gap stated plainly.",
        recommended: true,
      },
      {
        key: "continue",
        label: `Continue (cap doubles to ${(cap * 2).toLocaleString()})`,
        detail: "Resume this task; Hive will ask again only at the doubled cap.",
      },
    ],
  });
  writeEvent(db, {
    task_id: task.id,
    source: "system",
    type: `${kind}_cap`,
    payload: { value, cap, decision_id: decision.id },
  });
  queueSteer(
    db,
    task.id,
    `Hive parked this task at ${value.toLocaleString()} ${unit}. End this turn now. ` +
      `Do not poll or start new work until the director answers the usage-cap decision.`
  );
}

export function checkUsageGuardrails(db: DB, taskId: string): void {
  const task = getTask(db, taskId);
  if (!task || TERMINAL.includes(task.state)) return;
  const project: any = db.query("SELECT config FROM projects WHERE id = ?").get(task.project_id);
  const cfg = JSON.parse(project?.config ?? "{}");
  const warn = cfgNum(cfg.cost_warn_usd, DEFAULT_WARN_USD);
  const cap = cfgNum(cfg.cost_cap_usd, DEFAULT_CAP_USD);
  const processedWarn = cfgNum(cfg.processed_token_warn, DEFAULT_PROCESSED_TOKEN_WARN);
  const processedCap = cfgNum(cfg.processed_token_cap, DEFAULT_PROCESSED_TOKEN_CAP);
  const waitWarn = cfgNum(cfg.wait_call_warn, DEFAULT_WAIT_CALL_WARN);
  const waitCap = cfgNum(cfg.wait_call_cap, DEFAULT_WAIT_CALL_CAP);

  const processed = taskProcessedTokens(db, taskId);
  const waits = taskWaitCalls(db, taskId);
  const processedRaised = countEvents(db, taskId, "processed_token_cap_raised");
  const waitRaised = countEvents(db, taskId, "wait_call_cap_raised");
  const effectiveProcessedCap = processedCap > 0 ? processedCap * 2 ** processedRaised : Infinity;
  const effectiveWaitCap = waitCap > 0 ? waitCap * 2 ** waitRaised : Infinity;

  // A chat supervisor is a standing session with no definition of done, so a
  // steer telling it to "hand off" changes nothing: it just keeps going. Past
  // the threshold it stops instead, and the director restarts it deliberately.
  // This keys off the CURRENT token total, not off the absence of a prior
  // warning event, so a session that was already warned - or one that is somehow
  // resumed while still over the line - halts every time it is checked.
  if (task.source === "chat_supervisor" && processedWarn > 0 && processed >= processedWarn) {
    haltChatSupervisor(db, taskId, processed, processedWarn);
    return;
  }

  if (processedWarn > 0 && processed >= processedWarn && !countEvents(db, taskId, "processed_token_warning") && processed < effectiveProcessedCap) {
    writeEvent(db, { task_id: taskId, source: "system", type: "processed_token_warning", payload: { processed_tokens: processed, warn: processedWarn } });
    queueSteer(db, taskId, `Usage check: this task has processed ${processed.toLocaleString()} tokens. Tighten scope and hand off as soon as the definition of done is met.`);
  }
  if (waitWarn > 0 && waits >= waitWarn && !countEvents(db, taskId, "wait_call_warning") && waits < effectiveWaitCap) {
    writeEvent(db, { task_id: taskId, source: "system", type: "wait_call_warning", payload: { wait_calls: waits, warn: waitWarn } });
    queueSteer(db, taskId, `Polling check: this task has called wait ${waits.toLocaleString()} times. End the turn when work is externally pending; Hive will wake you when action is needed.`);
  }

  if (task.state === "in_progress") {
    if (waitCap > 0 && waits >= effectiveWaitCap && countEvents(db, taskId, "wait_call_cap") <= waitRaised) {
      openUsageCap(db, task, "wait_call", waits, effectiveWaitCap);
      return;
    }
    if (processedCap > 0 && processed >= effectiveProcessedCap && countEvents(db, taskId, "processed_token_cap") <= processedRaised) {
      openUsageCap(db, task, "processed_token", processed, effectiveProcessedCap);
      return;
    }
  }

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
      title: `Task #${task.number} passed its cost cap ($${effCap}): wrap up or keep spending?`,
      context:
        `Token spend so far: $${spent.toFixed(2)} (cap $${effCap}). Hive parked the task; answering ` +
        `resumes it with your direction. "${task.title}"`,
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
// Returns true if this decision was a dollar, processed-token, or wait-call cap card.
export function resolveUsageCapForDecision(db: DB, decisionId: string, answerKey: string): boolean {
  const ev: any = db
    .query(
      `SELECT task_id, type FROM events
       WHERE type IN ('cost_cap', 'processed_token_cap', 'wait_call_cap')
         AND json_extract(payload, '$.decision_id') = ? LIMIT 1`
    )
    .get(decisionId);
  if (!ev) return false;
  const prefix = String(ev.type).replace(/_cap$/, "");
  const label = prefix === "cost" ? "Cost" : prefix === "wait_call" ? "Wait-call" : "Processed-token";
  if (answerKey === "continue") {
    writeEvent(db, {
      task_id: ev.task_id,
      source: "director",
      type: `${prefix}_cap_raised`,
      payload: { decision_id: decisionId, at: now() },
    });
    queueSteer(db, ev.task_id, `${label} cap raised. Keep going, but stay tight on the definition of done and do not poll external work.`);
  } else {
    queueSteer(
      db,
      ev.task_id,
      `${label} cap reached and the director chose WRAP UP: commit and push your WIP now, attach evidence ` +
        "for what already works, open the PR with what's done (list gaps honestly in review_summary " +
        "'iffy'), and emit ready. Do not start anything new."
    );
  }
  return true;
}
