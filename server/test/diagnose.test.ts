import { test, expect } from "bun:test";
import { diagnosePane } from "../src/diagnose.ts";

test("diagnoses a permission dialog (the real Figma MCP hang)", () => {
  const tail = `   an inline base64 image entry is appended to the response
 Do you want to proceed?
   1. Yes
 ❯ 2. Yes, and don't ask again for claude.ai Figma - get_screenshot commands
   3. No
 Esc to cancel`;
  const d = diagnosePane(tail);
  expect(d?.kind).toBe("blocked_dialog");
  expect(d && "excerpt" in d && d.excerpt).toContain("Do you want to proceed?");
});

test("diagnoses lost auth (the real /login loop)", () => {
  const tail = `⎿  Not logged in · Please run /login
✻ Cogitated for 0s
❯ /login
⎿  Login successful
⎿  Not logged in · Please run /login`;
  expect(diagnosePane(tail)?.kind).toBe("auth_lost");
});

test("diagnoses context exhaustion", () => {
  expect(diagnosePane("some output\nnew task? /clear to save 383.2k tokens\n❯")?.kind).toBe("context_full");
});

test("diagnoses transient API errors", () => {
  expect(diagnosePane("API Error: 529 overloaded_error, retrying...")?.kind).toBe("api_error");
  expect(diagnosePane("fetch failed: ETIMEDOUT")?.kind).toBe("api_error");
});

test("dialog wins over other matches; clean output diagnoses null", () => {
  const both = "API Error: rate limit\n...\nrequested permissions to edit .git\nDo you want to proceed?\n 1. Yes";
  expect(diagnosePane(both)?.kind).toBe("blocked_dialog");
  expect(diagnosePane("⏺ Running tests...\nall 42 passed\n⏺ Writing report")).toBeNull();
});
