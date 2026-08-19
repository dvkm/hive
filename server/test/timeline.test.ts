import { test, expect } from "bun:test";
import { buildTimeline, isHookStatusNoise } from "../../web/src/lib/timeline.ts";
import type { TLEvent, TLDecision } from "../../web/src/lib/timeline.ts";

let n = 0;
const ev = (type: string, payload: Record<string, unknown> = {}, source = "hook"): TLEvent => ({
  id: `e${n}`,
  ts: `2026-01-01T00:00:${String(n++).padStart(2, "0")}Z`,
  source,
  type,
  payload,
});

test("drops legacy hook-status noise and turn-end heartbeats", () => {
  expect(isHookStatusNoise({ type: "status", payload: { note: "hook: PostToolUse" } })).toBe(true);
  expect(isHookStatusNoise({ type: "status", payload: { note: "extracting middleware" } })).toBe(false);
  const items = buildTimeline(
    [ev("status", { note: "hook: Stop" }), ev("agent_turn_end"), ev("state_change", { from: "queued", to: "in_progress" })],
    []
  );
  expect(items).toHaveLength(1);
  expect(items[0].kind).toBe("event");
});

test("renders assistant_text as a transcript bubble", () => {
  const items = buildTimeline([ev("assistant_text", { text: "line one\nline two" })], []);
  expect(items).toHaveLength(1);
  expect(items[0].kind).toBe("text");
  if (items[0].kind === "text") expect(items[0].text).toBe("line one\nline two");
});

test("renders Jira comments as readable conversation bubbles", () => {
  const inbound = buildTimeline([ev("jira_comment", { direction: "inbound", author: "Sam", text: "can we ship?" }, "jira")], []);
  expect(inbound[0]).toMatchObject({ kind: "text", source: "jira", text: "Sam: can we ship?" });
  const outbound = buildTimeline([ev("jira_comment", { direction: "outbound", text: "yes" }, "director")], []);
  expect(outbound[0]).toMatchObject({ kind: "text", source: "director", text: "yes" });
});

test("groups consecutive tool_use into one item, split by assistant_text", () => {
  const items = buildTimeline(
    [
      ev("tool_use", { tool: "Read", summary: "/a" }),
      ev("tool_use", { tool: "Grep", summary: "TODO" }),
      ev("assistant_text", { text: "found it" }),
      ev("tool_use", { tool: "Edit", summary: "/b" }),
    ],
    []
  );
  expect(items.map((i) => i.kind)).toEqual(["tools", "text", "tools"]);
  if (items[0].kind === "tools") {
    expect(items[0].tools).toEqual([
      { tool: "Read", summary: "/a" },
      { tool: "Grep", summary: "TODO" },
    ]);
  }
  if (items[2].kind === "tools") expect(items[2].tools).toHaveLength(1);
});

test("needs-decision + decision_answered renders prompt + resolved answer label", () => {
  const d: TLDecision = {
    id: "dec1",
    title: "Which database?",
    context: "Pick a store for the queue.",
    status: "answered",
    answer_key: "sqlite",
    answer_note: "keep it local",
    options: [
      { key: "sqlite", label: "SQLite" },
      { key: "pg", label: "Postgres" },
    ],
  };
  const items = buildTimeline(
    [ev("needs-decision", { decision_id: "dec1", title: "Which database?" }), ev("decision_answered", { decision_id: "dec1", answer_key: "sqlite" })],
    [d]
  );
  // The decision_answered event is folded into the single decision block.
  expect(items).toHaveLength(1);
  expect(items[0].kind).toBe("decision");
  if (items[0].kind === "decision") {
    expect(items[0].open).toBe(false);
    expect(items[0].answerLabel).toBe("SQLite"); // resolved key -> label
    expect(items[0].decision.title).toBe("Which database?");
  }
});

test("unanswered decision renders as awaiting", () => {
  const d: TLDecision = { id: "dec2", title: "Ship it?", status: "open", options: [{ key: "yes", label: "Yes" }] };
  const items = buildTimeline([ev("needs-decision", { decision_id: "dec2", title: "Ship it?" })], [d]);
  expect(items).toHaveLength(1);
  if (items[0].kind === "decision") {
    expect(items[0].open).toBe(true);
    expect(items[0].answerLabel).toBe(null);
  }
});
