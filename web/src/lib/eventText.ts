// Human-readable event sentences, in ONE place so any view can reuse them.
// Pure: a function of the event alone (type + payload), no React, no store.
import { STATE_LABEL } from "./labels"; // not ./ui — that imports react, and the server tests import this file
import type { State } from "./api";

// The event shape this module needs — a subset of Event / FeedEvent.
export interface EventLike {
  type: string;
  payload: Record<string, unknown>;
}

const s = (v: unknown): string => (v == null ? "" : String(v));

// One quiet sentence per event, e.g. "moved to In Review",
// "evidence attached: board screenshot", "decision answered: sqlite".
export function eventText(e: EventLike): string {
  const p = e.payload || {};
  switch (e.type) {
    case "created":
      return "task created";
    case "state_change": {
      const to = s(p.to) as State;
      const reason = s(p.reason);
      if (to === "done") return "marked done";
      if (to === "failed") return reason ? `failed: ${reason}` : "failed";
      if (to === "cancelled") return reason ? `cancelled: ${reason}` : "cancelled";
      const label = STATE_LABEL[to] || to;
      return `moved to ${label}`;
    }
    case "status":
      return s(p.note) || "status update";
    case "note":
      return s(p.note) || "note";
    case "evidence":
      return `evidence attached: ${s(p.caption) || s(p.kind) || "item"}`;
    case "needs-decision":
      return `asked: ${s(p.title) || "needs a decision"}`;
    case "decision_answered": {
      const label = s(p.answer_label) || s(p.answer_key) || "answered";
      const title = s(p.title);
      const who = s(p.approved_by) === "chat_supervisor" ? " (supervisor)" : "";
      return (title ? `answered ${title}: ${label}` : `answered: ${label}`) + who;
    }
    case "auto_approved":
      return `supervisor auto-approved: ${s(p.answer_key)}${s(p.reason) ? ` — ${s(p.reason)}` : ""}`;
    case "auto_approve_declined":
      return `supervisor escalated to director: ${s(p.reason) || "not auto-approvable"}`;
    case "assistant_text": {
      const first = s(p.text).split("\n").find((l) => l.trim()) || "";
      return first.length > 140 ? first.slice(0, 139) + "…" : first || "agent output";
    }
    case "tool_use": {
      const tool = s(p.tool) || "tool";
      const sum = s(p.summary);
      return sum ? `${tool}: ${sum}` : tool;
    }
    case "agent_turn_end":
      return "agent turn ended";
    case "steer": {
      // The delivery receipt: David must never wonder whether a steer landed.
      // Pre-receipt events (no `delivery`) stay bare rather than claim delivery.
      const badges: Record<string, string> = { delivered: "✓ ", queued: "⏳ queued — ", failed: "⚠ undelivered — " };
      const badge = badges[s(p.delivery)] ?? "";
      if (p.from_task_id)
        return `${badge}teammate #${s(p.from_task_number) || "?"}: “${s(p.original_message) || s(p.message)}”`;
      return `${badge}steered: “${s(p.message)}”`;
    }
    case "answer":
      return `answered your question: ${s(p.note)}`;
    case "ref_capture_proposed":
      return `recurring link — save as a project reference? ${s(p.url)}`;
    case "ref_capture_ignored":
      return `declined to save link: ${s(p.url)}`;
    case "auto_review": {
      if (s(p.skipped)) return `pre-review skipped (${s(p.skipped)})`;
      const risks = Array.isArray(p.risks) && p.risks.length ? ` — risks: ${(p.risks as string[]).join("; ")}` : "";
      return `pre-review ${s(p.verdict) === "caution" ? "⚠ CAUTION" : "✓ looks good"}: ${s(p.summary)}${risks}`;
    }
    case "auto_review_error":
      return `pre-review failed: ${s(p.error)}`;
    case "action_failed":
      return `${s(p.action) || "task action"} failed: ${s(p.reason) || `HTTP ${s(p.status)}`}`;
    case "auto_merged":
      return p.ok === false ? `automatic merge failed: ${s(p.error) || `HTTP ${s(p.status)}`}` : "automatically merged";
    case "cleanup_skipped":
      return `cleanup failed safely: ${s(p.reason) || "worktree preserved"}`;
    case "stack_setup":
    case "stack_teardown":
      return p.ok === false ? `${e.type.replace("_", " ")} failed: ${s(p.error)}` : `${e.type.replace("_", " ")} completed`;
    case "recovery":
      return `agent failure detected: ${s(p.decision) || s(p.excerpt) || "recovery required"}`;
    case "recovery_nudge":
      return p.delivered === false ? `recovery nudge failed: ${s(p.error)}` : "recovery nudge delivered";
    case "worktree_reclaim_failed":
      return `worktree reclaim failed: ${s(p.error)}`;
    case "ready_held":
      return s(p.reason) === "no_evidence"
        ? "handoff held: no evidence attached yet"
        : `handoff held: CI ${s(p.ci_status)} on ${s(p.pr_url)}`;
    case "ci_failure":
      return `CI failing — agent nudged to fix`;
    case "merge_failed": {
      // Same delivery-receipt rule as `steer`: only claim the agent was told
      // when the send actually landed.
      if (!p.conflict) return `merge failed: ${s(p.reason)}`;
      const badge = p.delivered ? "sent back to agent" : "⚠ could not notify agent";
      return `merge conflict — ${badge}: ${s(p.reason)}`;
    }
    case "merge_blocked_destructive": {
      const regressed = Array.isArray(p.regressed) ? p.regressed : [];
      const files = regressed.slice(0, 10).join(", ") + (regressed.length > 10 ? `, …(+${regressed.length - 10})` : "");
      return `merge blocked: ${s(p.reason) || `branch '${s(p.branch)}' reverts base work outside this task's scope (${files || "unknown files"})`}`;
    }
    case "pr_closed":
      return `PR closed without merging — sent back to the agent`;
    case "verify_wedged":
      return `wedged in verifying: needs evidence to complete`;
    case "blocked":
      return s(p.note) ? `agent blocked: ${s(p.note)}` : "agent blocked";
    case "spawned":
      return "agent spawned";
    case "spawn_error":
      return `spawn failed: ${s(p.error)}`;
    case "agent_status":
      return `agent ${s(p.status) || "status changed"}`;
    case "dialog_auto_approved":
      return s(p.kind) === "workspace_trust" ? "accepted the workspace trust prompt" : "approved a safe agent dialog";
    case "dialog_auto_declined":
      return "dismissed an optional agent dialog";
    case "ci_status":
      return `CI ${s(p.ci_status)}`;
    case "pr_merged":
      return "PR merged";
    case "ready_for_review":
      return s(p.via) === "emit" ? "handed off for review" : "auto-advanced to review (agent idle)";
    case "stale":
      return "agent went silent";
    case "smoke_passed":
      return "post-deploy smoke passed";
    case "smoke_failed":
      return "post-deploy smoke failed";
    case "planning":
      return "planner started";
    case "planned":
      return "planner proposed a breakdown";
    case "planner_error":
      return `planner failed: ${s(p.error)}`;
    case "authority_required":
      return `approval required: ${s(p.action)}`;
    case "authority_granted":
      return `approval granted: ${s(p.action)}`;
    case "authority_denied":
      return `action denied: ${s(p.action)}`;
    case "authority_logged":
      return `action allowed: ${s(p.action)}`;
    case "steer_error":
      return `steer failed: ${s(p.error)}`;
    case "supervise_error":
      return `supervise error: ${s(p.error)}`;
    case "incident":
      return s(p.status) === "resolved"
        ? `monitor recovered: ${s(p.monitor)}`
        : `monitor down: ${s(p.monitor)}${s(p.detail) ? ` — ${s(p.detail)}` : ""}`;
    default: {
      const words = e.type.replace(/[_-]+/g, " ");
      const note = s(p.note);
      return note ? `${words}: ${note}` : words;
    }
  }
}

// Feed filter categories. Keep in sync with FEED_CATEGORIES in server/src/api.ts.
export type FeedCategory = "state" | "decision" | "evidence" | "incident" | "lifecycle";

export const FEED_CATEGORIES: { key: FeedCategory; label: string }[] = [
  { key: "state", label: "State changes" },
  { key: "decision", label: "Decisions" },
  { key: "evidence", label: "Evidence" },
  { key: "incident", label: "Incidents" },
  { key: "lifecycle", label: "Agent lifecycle" },
];

const CATEGORY_OF: Record<string, FeedCategory> = {
  assistant_text: "lifecycle",
  tool_use: "lifecycle",
  agent_turn_end: "lifecycle",
  state_change: "state",
  ready_for_review: "state",
  "needs-decision": "decision",
  decision_answered: "decision",
  auto_approved: "decision",
  auto_approve_declined: "decision",
  planned: "decision",
  authority_required: "decision",
  authority_granted: "decision",
  evidence: "evidence",
  smoke_passed: "evidence",
  incident: "incident",
  blocked: "incident",
  stale: "incident",
  merge_failed: "incident",
  merge_blocked_destructive: "incident",
  action_failed: "incident",
  spawn_error: "incident",
  smoke_failed: "incident",
  steer_error: "incident",
  planner_error: "incident",
  supervise_error: "incident",
  authority_denied: "incident",
};

// Which filter bucket an event type belongs to. Unknown/custom types are agent
// lifecycle (the catch-all), matching the server's default grouping.
export function eventCategory(type: string): FeedCategory {
  return CATEGORY_OF[type] ?? "lifecycle";
}

const FAILURE_TYPES = new Set([
  "action_failed",
  "authority_denied",
  "auto_review_error",
  "ci_failure",
  "cleanup_skipped",
  "merge_blocked_destructive",
  "merge_failed",
  "planner_error",
  "pr_closed",
  "pr_conflict",
  "recovery",
  "smoke_failed",
  "spawn_error",
  "steer_error",
  "supervise_error",
  "usage_limit",
  "verify_wedged",
  "worktree_reclaim_failed",
]);

// One definition for the durable failure history. Most failures have their own
// event type; a few lifecycle events carry success/failure in their payload.
export function isFailureEvent(e: EventLike): boolean {
  if (FAILURE_TYPES.has(e.type) || /(?:_error|_failed|_failure)$/.test(e.type)) return true;
  const p = e.payload || {};
  if (e.type === "state_change") return p.to === "failed";
  if (e.type === "auto_merged" || e.type === "stack_setup" || e.type === "stack_teardown") return p.ok === false;
  if (e.type === "steer") return p.delivery === "failed";
  if (e.type === "recovery_nudge" || e.type === "dialog_answered" || e.type === "dialog_auto_approved" || e.type === "dialog_auto_declined")
    return p.delivered === false;
  return e.type === "changes_requested" && !!p.send_error;
}
