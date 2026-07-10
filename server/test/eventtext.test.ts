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

test("new transcript types are agent-lifecycle for the feed filter", () => {
  expect(eventCategory("assistant_text")).toBe("lifecycle");
  expect(eventCategory("tool_use")).toBe("lifecycle");
  expect(eventCategory("agent_turn_end")).toBe("lifecycle");
});
