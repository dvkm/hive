import { test, expect } from "bun:test";
import { eventText, eventCategory, isFailureEvent } from "../../web/src/lib/eventText.ts";

test("assistant_text reads as its first line", () => {
  expect(eventText({ type: "assistant_text", payload: { text: "patching the middleware\nnext step" } })).toBe(
    "patching the middleware"
  );
});

test("tool_use reads as tool: summary", () => {
  expect(eventText({ type: "tool_use", payload: { tool: "Bash", summary: "git status" } })).toBe("Bash: git status");
  expect(eventText({ type: "tool_use", payload: { tool: "TodoWrite", summary: "" } })).toBe("TodoWrite");
});

test("decision events read as asked / answered", () => {
  expect(eventText({ type: "needs-decision", payload: { title: "Which DB?" } })).toBe("asked: Which DB?");
  expect(eventText({ type: "decision_answered", payload: { title: "Which DB?", answer_label: "SQLite" } })).toBe(
    "answered Which DB?: SQLite"
  );
});

// The timeline must show whether a steer actually landed, or it gets re-sent.
test("steer carries its delivery receipt", () => {
  const steer = (delivery?: string) => eventText({ type: "steer", payload: { message: "ship it", delivery } });
  expect(steer("delivered")).toBe("✓ steered: “ship it”");
  expect(steer("queued")).toBe("⏳ queued — steered: “ship it”");
  expect(steer("failed")).toBe("⚠ undelivered — steered: “ship it”");
  expect(steer(undefined)).toBe("steered: “ship it”"); // pre-receipt events stay bare
  expect(eventText({
    type: "steer",
    payload: { message: "wrapped wire text", original_message: "which response shape?", from_task_id: "a", from_task_number: 12, delivery: "delivered" },
  })).toBe("✓ teammate #12: “which response shape?”");
});

// `conflict` is a boolean: read it directly, never through s() — s(false) is the
// non-empty string "false", which would render every failure as a conflict.
test("merge_failed distinguishes conflict from a plain failure", () => {
  const mf = (payload: Record<string, unknown>) => eventText({ type: "merge_failed", payload });
  expect(mf({ reason: "x", conflict: true, delivered: true })).toBe("merge conflict — sent back to agent: x");
  expect(mf({ reason: "x", conflict: false, delivered: false })).toBe("merge failed: x");
  // The bounce happens regardless, so an undelivered send must not claim otherwise.
  expect(mf({ reason: "x", conflict: true, delivered: false })).toBe("merge conflict — ⚠ could not notify agent: x");
});

test("destructive merge blocks are readable and compact", () => {
  const text = eventText({
    type: "merge_blocked_destructive",
    payload: { branch: "feat", regressed: Array.from({ length: 11 }, (_, i) => `file${i}`) },
  });
  expect(text).toBe("merge blocked: branch 'feat' reverts base work outside this task's scope (file0, file1, file2, file3, file4, file5, file6, file7, file8, file9, …(+1))");
  expect(eventCategory("merge_blocked_destructive")).toBe("incident");
});

test("failure history includes explicit and payload-based failures", () => {
  expect(isFailureEvent({ type: "action_failed", payload: { status: 409 } })).toBe(true);
  expect(isFailureEvent({ type: "future_worker_error", payload: {} })).toBe(true);
  expect(isFailureEvent({ type: "state_change", payload: { to: "failed" } })).toBe(true);
  expect(isFailureEvent({ type: "stack_teardown", payload: { ok: false } })).toBe(true);
  expect(isFailureEvent({ type: "steer", payload: { delivery: "failed" } })).toBe(true);
  expect(isFailureEvent({ type: "stack_teardown", payload: { ok: true } })).toBe(false);
  expect(isFailureEvent({ type: "state_change", payload: { to: "done" } })).toBe(false);
  expect(eventText({ type: "action_failed", payload: { action: "POST /merge", reason: "CI pending" } })).toBe("POST /merge failed: CI pending");
});

test("new transcript types are agent-lifecycle for the feed filter", () => {
  expect(eventCategory("assistant_text")).toBe("lifecycle");
  expect(eventCategory("tool_use")).toBe("lifecycle");
  expect(eventCategory("agent_turn_end")).toBe("lifecycle");
});

// #989: the mismatch has to be legible on the board, not just present in the DB.
// It rides the generic `<type words>: <note>` fallback rather than its own case.
test("a repo_mismatch event reads as a sentence on the timeline", () => {
  expect(
    eventText({ type: "repo_mismatch", payload: { note: 'Brief targets files that exist in project "hive" but not in "corebeat": server/src/intake/jira.ts.' } })
  ).toBe('repo mismatch: Brief targets files that exist in project "hive" but not in "corebeat": server/src/intake/jira.ts.');
});

test("automatic dialog recovery is readable in the supervisor trajectory", () => {
  expect(eventText({ type: "dialog_auto_approved", payload: { kind: "workspace_trust" } })).toBe("accepted the workspace trust prompt");
  expect(eventText({ type: "dialog_auto_declined", payload: {} })).toBe("dismissed an optional agent dialog");
});

test("Jira audit text distinguishes pending, shadow, and confirmed writes", () => {
  const jira = (payload: Record<string, unknown>) => eventText({ type: "jira_sync", payload: { issue: "WEB-1", ...payload } });

  expect(jira({ action: "push", to: "Done", outcome: "sending" })).toBe("about to send status to Jira WEB-1: Done");
  expect(jira({ action: "push", to: "Done", shadow: true })).toBe("would send status to Jira WEB-1: Done — not sent");
  expect(jira({ action: "push", to: "Done", outcome: "ok" })).toBe("status sent to Jira WEB-1: Done");
  expect(jira({ action: "label", label: "hive-needs-decision", present: true, outcome: "sending" })).toBe("about to add Jira label hive-needs-decision on WEB-1");
  expect(jira({ action: "label", label: "hive-needs-decision", present: false, shadow: true })).toBe("would remove Jira label hive-needs-decision on WEB-1 — not sent");
  expect(jira({ action: "label", label: "hive-needs-decision", present: true, outcome: "ok" })).toBe("added Jira label hive-needs-decision on WEB-1");
  expect(jira({ action: "label", label: "hive-needs-decision", present: true })).toContain("not confirmed");
  expect(jira({ action: "comment_push", outcome: "terminal_unknown", error: "timed out" })).toContain("may not have completed");
  expect(jira({ action: "comment_push", outcome: "failed", error: "403 forbidden" })).toContain("failed — 403 forbidden");
  expect(jira({ action: "comment_push", outcome: "resolved" })).toContain("uncertainty resolved after manual check");
  expect(jira({ action: "comment_push", outcome: "rejected", error: "empty" })).toContain("rejected — empty");
  expect(isFailureEvent({ type: "jira_sync", payload: { outcome: "terminal_unknown" } })).toBe(true);
  expect(isFailureEvent({ type: "jira_sync", payload: { outcome: "failed" } })).toBe(true);
});
