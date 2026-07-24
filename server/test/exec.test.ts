import { test, expect } from "bun:test";
import { defaultExec } from "../src/exec.ts";

test("defaultExec returns real output and code for a normal command", async () => {
  const r = await defaultExec(["echo", "hi"]);
  expect(r.code).toBe(0);
  expect(r.stdout.trim()).toBe("hi");
});

// A stalled subprocess (network hang, or a detached grandchild still holding
// the stdio pipes open after the direct child exits) used to hang the caller
// forever — observed live wedging POST /merge (task #621). This asserts the
// bound actually fires instead of waiting out the full subprocess runtime.
test("defaultExec bounds a hung subprocess with a timeout (task #621)", async () => {
  const start = Date.now();
  const r = await defaultExec(["sleep", "5"], { timeoutMs: 100 });
  expect(Date.now() - start).toBeLessThan(2000);
  expect(r.code).toBe(124);
});
