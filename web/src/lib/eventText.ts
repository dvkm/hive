// Human-readable event sentences, in ONE place so any view can reuse them.
// Pure: a function of the event alone (type + payload), no React, no store.
import { STATE_LABEL } from "./ui";
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
      return title ? `answered ${title}: ${label}` : `answered: ${label}`;
    }
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
      return `${badge}steered: “${s(p.message)}”`;
    }
    case "answer":
      return `answered your question: ${s(p.note)}`;
    case "blocked":
      return s(p.note) ? `agent blocked: ${s(p.note)}` : "agent blocked";
    case "spawned":
      return "agent spawned";
    case "spawn_error":
      return `spawn failed: ${s(p.error)}`;
    case "agent_status":
      return `agent ${s(p.status) || "status changed"}`;
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
  planned: "decision",
  authority_required: "decision",
  authority_granted: "decision",
  evidence: "evidence",
  smoke_passed: "evidence",
  incident: "incident",
  blocked: "incident",
  stale: "incident",
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
