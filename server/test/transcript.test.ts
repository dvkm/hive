import { test, expect } from "bun:test";
import { extractTurns, toolSummary } from "../../hooks/transcript.ts";

// A transcript is append-only JSONL; one assistant row can carry both a text
// block and several tool_use blocks.
const line = (obj: unknown) => JSON.stringify(obj);
const asst = (content: unknown[]) => line({ type: "assistant", message: { role: "assistant", content } });

test("extracts assistant text blocks as assistant_text events", () => {
  const lines = [asst([{ type: "text", text: "Reading the config now.\nThen I'll patch it." }])];
  const out = extractTurns(lines);
  expect(out).toHaveLength(1);
  expect(out[0].type).toBe("assistant_text");
  expect(out[0].source).toBe("hook");
  expect(out[0].payload.text).toBe("Reading the config now.\nThen I'll patch it.");
});

test("extracts tool_use blocks with a one-line summary per tool", () => {
  const lines = [
    asst([
      { type: "tool_use", name: "Bash", input: { command: "git status" } },
      { type: "tool_use", name: "Read", input: { file_path: "/a/b.ts" } },
      { type: "tool_use", name: "Grep", input: { pattern: "TODO" } },
    ]),
  ];
  const out = extractTurns(lines);
  expect(out.map((e) => e.type)).toEqual(["tool_use", "tool_use", "tool_use"]);
  expect(out[0].payload).toEqual({ tool: "Bash", summary: "git status" });
  expect(out[1].payload).toEqual({ tool: "Read", summary: "/a/b.ts" });
  expect(out[2].payload).toEqual({ tool: "Grep", summary: "TODO" });
});

test("extracts Codex response items", () => {
  const lines = [
    line({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Checking the tests." }] } }),
    line({ type: "response_item", payload: { type: "custom_tool_call", name: "exec_command", input: JSON.stringify({ cmd: "bun test" }) } }),
  ];
  expect(extractTurns(lines)).toEqual([
    { type: "assistant_text", source: "hook", payload: { text: "Checking the tests." } },
    { type: "tool_use", source: "hook", payload: { tool: "exec_command", summary: "bun test" } },
  ]);
});

test("interleaves text and tools in transcript order, skips empty text + non-assistant rows", () => {
  const lines = [
    line({ type: "user", message: { content: "hi" } }),
    asst([
      { type: "text", text: "Let me look." },
      { type: "tool_use", name: "Read", input: { file_path: "/x" } },
      { type: "text", text: "   " }, // whitespace-only: dropped
    ]),
    "not json at all",
    asst([{ type: "text", text: "Done." }]),
  ];
  const out = extractTurns(lines);
  expect(out.map((e) => e.type)).toEqual(["assistant_text", "tool_use", "assistant_text"]);
  expect(out[0].payload.text).toBe("Let me look.");
  expect(out[2].payload.text).toBe("Done.");
});

test("cursor slicing yields no duplicates across two hook fires", () => {
  const all = [
    asst([{ type: "tool_use", name: "Bash", input: { command: "ls" } }]),
    asst([{ type: "text", text: "first turn" }]),
    asst([{ type: "text", text: "second turn" }]),
  ];
  // First fire processes lines 0..1 (cursor=0), advances cursor to 2.
  const firstFire = extractTurns(all.slice(0, 2));
  // Second fire processes only the NEW line (cursor=2).
  const secondFire = extractTurns(all.slice(2));
  expect(firstFire.map((e) => e.payload.summary ?? e.payload.text)).toEqual(["ls", "first turn"]);
  expect(secondFire.map((e) => e.payload.text)).toEqual(["second turn"]);
  // No overlap: "first turn" never re-emitted.
  expect(secondFire.some((e) => e.payload.text === "first turn")).toBe(false);
});

test("toolSummary picks a cheap field and truncates long values", () => {
  expect(toolSummary("Edit", { file_path: "/p" })).toBe("/p");
  expect(toolSummary("WebFetch", { url: "https://x" })).toBe("https://x");
  expect(toolSummary("TodoWrite", { todos: [1, 2] })).toBe("");
  const long = "x".repeat(500);
  expect(toolSummary("Bash", { command: long }).length).toBeLessThanOrEqual(200);
  expect(toolSummary("Bash", { command: long }).endsWith("…")).toBe(true);
});
