import { test, expect } from "bun:test";
import { startLoop } from "../src/loop.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The whole point of startLoop: a cycle that outruns its interval must not get
// a second copy of itself running alongside it (HIVE-439).
test("a tick that lands mid-cycle is skipped, not stacked", async () => {
  let started = 0;
  let concurrent = 0;
  let maxConcurrent = 0;
  const stop = startLoop("test", 10, async () => {
    started++;
    maxConcurrent = Math.max(maxConcurrent, ++concurrent);
    await sleep(120);
    concurrent--;
  });
  await sleep(200);
  stop();
  expect(maxConcurrent).toBe(1);
  expect(started).toBeLessThanOrEqual(2);
  await sleep(150);
});

// A throwing cycle must release the guard, or the loop wedges for good.
test("a crashed cycle still lets the next tick run", async () => {
  let started = 0;
  const stop = startLoop("test", 10, async () => {
    started++;
    throw new Error("boom");
  });
  await sleep(60);
  stop();
  expect(started).toBeGreaterThan(1);
});
