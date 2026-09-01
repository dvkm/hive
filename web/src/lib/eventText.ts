// Human-readable event sentences, in ONE place so any view can reuse them.
// Pure: a function of the event alone (type + payload), no React, no store.
import { STATE_LABEL } from "./labels"; // not ./ui — that imports react, and the server tests import this file
import type { State } from "./domain"; // not ./api — that pulls in DOM globals the server-test tsconfig doesn't have

// The event shape this module needs — a subset of Event / FeedEvent.
export interface EventLike {
  type: string;
  payload: Record<string, unknown>;
}

const s = (v: unknown): string => (v == null ? "" : String(v));
// Payload values are untyped, so an array field has to be narrowed before use.
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

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
    case "auto_resume": {
      const quote = s(p.quote);
      return p.escalated
        ? `stopped mid-commitment ${s(p.resumes)}× after auto-resume — escalated to you: “${quote}”`
        : `auto-resumed (#${s(p.resumes)}) — it had said: “${quote}”`;
    }
    case "steer": {
      // The delivery receipt: the director must never wonder whether a steer landed.
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
      // Only `looks_good` is good. `caution`, `unparseable` and `unavailable`
      // all used to render as "✓ looks good" here, which is the opposite of
      // what they mean (HIVE-567).
      const verdict = s(p.verdict);
      const label = verdict === "looks_good" ? "✓ looks good" : verdict === "caution" ? "⚠ CAUTION" : `⚠ ${verdict.toUpperCase()}`;
      return `pre-review ${label}: ${s(p.summary)}${risks}`;
    }
    case "auto_review_error":
      // `gave_up` means the retry budget for this PR head is spent — the card
      // needs a human, so it must not read like one more transient blip.
      if (p.gave_up) return `pre-review gave up after ${s(p.attempts) || "several"} tries, needs you: ${s(p.error)}`;
      return `pre-review failed: ${s(p.error)}`;
    case "risk_verdicts": {
      const vs = Array.isArray(p.verdicts) ? (p.verdicts as any[]) : [];
      const qs = Array.isArray(p.question_verdicts) ? (p.question_verdicts as any[]) : [];
      const unchecked = Number(p.unverified) || 0;
      const why = s(p.unverified_reason);
      // A timeout is not a verdict: say so, or an empty set reads as a clean bill.
      if (!vs.length && !qs.length)
        return `risk check did not finish — ${unchecked || "no"} finding${unchecked === 1 ? "" : "s"} got no verdict${why ? ` (${why})` : ""}`;
      const confirmed = vs.filter((v) => v?.verdict === "confirmed");
      const forYou = qs.filter((q) => q?.answerable === "human");
      const parts = [];
      if (vs.length) parts.push(`${confirmed.length} of ${vs.length} risks confirmed`);
      if (qs.length) parts.push(`${forYou.length} of ${qs.length} questions need you`);
      if (unchecked) parts.push(`${unchecked} not checked${why ? ` (${why})` : ""}`);
      const head = `risk check: ${parts.join(", ")}`;
      const named = [...confirmed.map((v) => s(v.risk)), ...forYou.map((q) => s(q.question))];
      return named.length ? `${head} — ${named.join("; ")}` : head;
    }
    case "scope_drift": {
      const beyond = Array.isArray(p.beyond) ? (p.beyond as string[]) : [];
      const listed = beyond.slice(0, 6).join(", ") + (beyond.length > 6 ? `, …(+${beyond.length - 6})` : "");
      return `scope growing past the brief at ${s(p.commits)} commits — ${listed || s(p.why) || "beyond the brief"}`;
    }
    case "scope_drift_check":
      if (s(p.error)) return `scope check failed: ${s(p.error)}`;
      return p.drifting === false
        ? `scope check at ${s(p.commits)} commits: still within the brief`
        : `scope checked at ${s(p.commits)} commits`;
    case "action_failed":
      return `${s(p.action) || "task action"} failed: ${s(p.reason) || `HTTP ${s(p.status)}`}`;
    case "sidecar_report": {
      const findings = Array.isArray(p.findings) ? (p.findings as { tool?: unknown; summary?: unknown }[]) : [];
      if (!findings.length) return "quick checks passed on the latest commit";
      return `quick checks found problems: ${findings.map((f) => `${s(f.tool)}: ${s(f.summary)}`).join("; ")}`;
    }
    case "auto_merged":
      // ok:false is history — failures are their own event type now.
      return p.ok === false ? `automatic merge failed: ${s(p.error) || `HTTP ${s(p.status)}`}` : "automatically merged";
    case "auto_merge_failed":
      return p.gave_up
        ? `automatic merge refused ${s(p.attempts)} times, stopped trying: ${s(p.error) || `HTTP ${s(p.status)}`}`
        : `automatic merge refused: ${s(p.error) || `HTTP ${s(p.status)}`}`;
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
    case "worktree_seeded": {
      const seeded = list(p.seeded);
      // Warm entries carry HOW they were warmed. A byte copy is not the win
      // this feature exists for, so say which one happened rather than letting
      // a slow machine read exactly like a fast one.
      const warmed = list(p.warmed) as { dir?: unknown; method?: unknown }[];
      // A skip is the design working — the deps really changed, or the file is
      // already there — but it is not "nothing happened". It is the reason a
      // spawn was slow, which is exactly what someone reads this line to find.
      const skipped = list(p.skipped) as { path?: unknown; reason?: unknown }[];
      const did = [
        seeded.length ? `copied ${seeded.length} config file${seeded.length === 1 ? "" : "s"}` : null,
        warmed.length
          ? `reused ${warmed.map((w) => `${s(w.dir)} (${s(w.method) === "clone" ? "copy-on-write clone" : "full copy"})`).join(", ")}`
          : null,
        skipped.length ? `skipped ${skipped.map((k) => `${s(k.path)} (${s(k.reason)})`).join(", ")}` : null,
      ].filter(Boolean);
      return did.length ? `worktree seeded: ${did.join(", ")}` : "worktree seeded: nothing to copy or reuse";
    }
    case "worktree_seed_failed": {
      // The spawn still worked; the project asked for something that is not there.
      const bad = list(p.misconfigured) as { path?: unknown; reason?: unknown }[];
      const first = bad[0] ? `${s(bad[0].path)} — ${s(bad[0].reason)}` : "see the event payload";
      return bad.length > 1
        ? `worktree setup config is wrong (${bad.length} problems), so the agent started cold: ${first}`
        : `worktree setup config is wrong, so the agent started cold: ${first}`;
    }
    case "ready_held":
      if (s(p.reason) === "no_evidence") return "handoff held: no evidence attached yet";
      if (s(p.reason) === "missing_understanding_check") return "handoff held: the review carries no understanding check";
      return `handoff held: CI ${s(p.ci_status)} on ${s(p.pr_url)}`;
    case "ci_failure":
      return `CI failing — agent nudged to fix`;
    case "requeue_failed":
      return `requeue did NOT queue a new task: ${s(p.reason) || "unknown reason"}`;
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
    case "spawn_gave_up":
      return `gave up spawning after ${s(p.attempts) || "repeated"} identical failures: ${s(p.error)}`;
    case "agent_status":
      return `agent ${s(p.status) || "status changed"}`;
    case "dialog_auto_approved":
      return s(p.kind) === "workspace_trust" ? "accepted the workspace trust prompt" : "approved a safe agent dialog";
    case "dialog_auto_declined":
      return "dismissed an optional agent dialog";
    case "dialog_auto_answered":
      return `approved a file write in the task's own files${Array.isArray(p.paths) && p.paths.length ? ` (${p.paths.join(", ")})` : ""}`;
    case "ci_status":
      return `CI ${s(p.ci_status)}`;
    case "pr_merged":
      return "PR merged";
    case "ready_for_review":
      return s(p.via) === "emit" ? "handed off for review" : "auto-advanced to review (agent idle)";
    case "stale":
      return "agent went silent";
    case "hung":
      return `no progress for ${Math.round(Number(p.silent_ms ?? 0) / 60000)} min, agent still alive${s(p.last_said) ? ` — last said: "${s(p.last_said)}"` : ""}`;
    case "deployed":
      return p.up_to_date
        ? `serving checkout '${s(p.branch)}' was already current`
        : `serving checkout '${s(p.branch)}' followed ${s(p.base)} to ${String(p.head_sha ?? "").slice(0, 7)}`;
    case "serving_follow_conflict":
      return `serving checkout '${s(p.branch)}' could not merge ${s(p.base)}${Array.isArray(p.files) && p.files.length ? ` (${p.files.join(", ")})` : ""}`;
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
    // Jira sync rows used to render as the bare words "jira sync", which told a
    // reader nothing about what happened or which way it went. Every action gets
    // a sentence naming the issue, the direction, and the outcome.
    case "jira_sync": {
      const issue = s(p.issue);
      const at = issue ? ` ${issue}` : "";
      const action = s(p.action);
      const outcome = s(p.outcome);
      const confirmed = outcome === "ok" || outcome === "recovered" || p.recovered === true;
      // A write recorded before its response came back, then never confirmed.
      if (outcome === "unknown" || outcome === "terminal_unknown") return `Jira${at}: ${action.replace(/_/g, " ")} may not have completed — ${s(p.error) || "no response"}`;
      if (outcome === "failed") return `Jira${at}: ${action.replace(/_/g, " ")} failed — ${s(p.error) || "Jira rejected the request"}`;
      if (outcome === "resolved") return `Jira${at}: ${action.replace(/_/g, " ")} uncertainty resolved after manual check`;
      if (outcome === "rejected") return `Jira${at}: ${action.replace(/_/g, " ")} rejected — ${s(p.error) || "invalid outbound item"}`;
      if (p.aborted) return `Jira${at}: ${action.replace(/_/g, " ")} aborted — ${s(p.aborted)}`;
      if (p.blocked) return `Jira${at}: ${action.replace(/_/g, " ")} not sent — ${s(p.blocked)}`;
      switch (action) {
        case "import":
          return `mirrored from Jira${at}${s(p.jira_status) ? ` (${s(p.jira_status)})` : ""}`;
        case "pull":
          return `Jira${at} moved to ${s(p.jira_status) || s(p.to)} — task follows`;
        case "push":
          if (p.shadow === true) return `would send status to Jira${at}: ${s(p.to)} — not sent`;
          if (outcome === "sending") return `about to send status to Jira${at}: ${s(p.to)}`;
          return confirmed
            ? `status sent to Jira${at}: ${s(p.to)}`
            : `status change for Jira${at} to ${s(p.to)} is not confirmed`;
        case "label": {
          const verb = p.present ? "add" : "remove";
          const target = `Jira label ${s(p.label)}${at ? ` on${at}` : ""}`;
          if (p.shadow === true) return `would ${verb} ${target} — not sent`;
          if (outcome === "sending") return `about to ${verb} ${target}`;
          return confirmed ? `${p.present ? "added" : "removed"} ${target}` : `${target} change is not confirmed`;
        }
        case "comment_push":
          if (p.recovered) return `comment to Jira${at} confirmed already delivered`;
          if (outcome === "sending") return `sending comment to Jira${at}…`;
          return `comment delivered to Jira${at}`;
        case "comment_shadow":
          return `comment queued for Jira${at} (shadow: not sent)`;
        case "receipt":
          if (p.recovered) return `report/evidence for Jira${at} confirmed already delivered`;
          if (outcome === "sending") return `delivering report/evidence to Jira${at}…`;
          return `report/evidence delivered to Jira${at}`;
        case "receipt_shadow":
          return `report/evidence ready for Jira${at} (shadow: not sent)`;
        case "comment_sync_skipped":
          return `Jira${at}: comment sync skipped this cycle — ${s(p.reason)}`;
        case "unmapped_status":
          return `Jira${at} is in "${s(p.jira_status)}", which hive has no equivalent for — left alone`;
        case "out_of_scope":
          return `Jira${at} is no longer in the synced project scope`;
        case "sync_stopped":
          return `stopped syncing Jira${at} — ${s(p.reason)}`;
        case "pull_deferred":
          return `held off following Jira${at} — ${s(p.reason)}`;
        default:
          return `Jira${at}: ${action.replace(/_/g, " ") || "sync"}`;
      }
    }
    case "jira_comment": {
      const issue = s(p.issue);
      const at = issue ? ` on ${issue}` : "";
      if (s(p.direction) === "inbound") return `Jira comment${at} from ${s(p.author) || "someone"}`;
      return `comment queued for Jira${at}`;
    }
    case "taken_over":
      return `you took the worktree over — the agent is parked and its slot is free`;
    case "handed_back":
      return s(p.summary)
        ? `handed back to an agent, steered with what you changed`
        : `handed back to an agent — nothing changed while you had it`;
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
  auto_resume: "lifecycle",
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
  hung: "incident",
  merge_failed: "incident",
  auto_merge_failed: "incident",
  requeue_failed: "incident",
  merge_blocked_destructive: "incident",
  scope_drift: "decision",
  action_failed: "incident",
  spawn_error: "incident",
  spawn_gave_up: "incident",
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
  "requeue_failed",
  "smoke_failed",
  "spawn_error",
  "spawn_gave_up",
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
  if (e.type === "recovery_nudge" || e.type === "dialog_answered" || e.type === "dialog_auto_approved" || e.type === "dialog_auto_declined" || e.type === "dialog_auto_answered")
    return p.delivered === false;
  // "Jira may have accepted it but we never saw the response" is a real, durable unknown:
  // it must not read the same as a clean success in the failure history.
  if (e.type === "jira_sync") return p.outcome === "unknown" || p.outcome === "terminal_unknown" || p.outcome === "failed" || !!p.blocked;
  return e.type === "changes_requested" && !!p.send_error;
}
