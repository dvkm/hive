import { expect, test } from "bun:test";
import { buildTimeline, quietTimeline } from "../src/lib/timeline";
import type { TLEvent } from "../src/lib/timeline";

const ev = (id: string, type: string, payload: Record<string, unknown> = {}): TLEvent => ({
  id, ts: `2026-09-15T10:00:0${id}.000Z`, source: "hook", type, payload,
});

test("the quiet timeline keeps what the agent said and what changed, and drops tool calls and the permission ledger", () => {
  const full = buildTimeline(
    [
      ev("1", "spawned"),
      ev("2", "tool_use", { tool: "Read", summary: "/a" }),
      ev("3", "tool_use", { tool: "Grep", summary: "TODO" }),
      ev("4", "assistant_text", { text: "I'll start with the parser." }),
      ev("5", "authority_logged", { note: "action allowed: command" }),
      ev("6", "state_change", { to: "in_review" }),
    ],
    []
  );
  expect(full.map((i) => i.kind)).toEqual(["event", "tools", "text", "event", "event"]);
  const quiet = quietTimeline(full);
  expect(quiet.map((i) => (i.kind === "event" ? i.ev.type : i.kind))).toEqual(["spawned", "text", "state_change"]);
});
