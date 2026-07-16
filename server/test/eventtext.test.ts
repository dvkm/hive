import { test, expect } from "bun:test";
import { eventText, eventCategory } from "../../web/src/lib/eventText.ts";

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

test("new transcript types are agent-lifecycle for the feed filter", () => {
  expect(eventCategory("assistant_text")).toBe("lifecycle");
  expect(eventCategory("tool_use")).toBe("lifecycle");
  expect(eventCategory("agent_turn_end")).toBe("lifecycle");
});
