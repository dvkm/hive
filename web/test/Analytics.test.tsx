import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = (name: string) => readFileSync(join(import.meta.dir, `../src/views/${name}`), "utf8");

test("analytics calls aggregate usage processed tokens and shows every component", () => {
  const analytics = source("Analytics.tsx");
  expect(analytics).toContain('label="Processed tokens"');
  expect(analytics).toContain('label="Fresh input"');
  expect(analytics).toContain('label="Cached input"');
  expect(analytics).toContain('label="Output"');
  expect(analytics).toContain('label="Cache write"');
  expect(analytics).not.toContain('label="Total tokens"');
});

test("the task usage summary calls the aggregate processed and exposes its components", () => {
  const text = source("Task.tsx");
  expect(text).toContain("processed");
  expect(text).toContain("fresh");
  expect(text).toContain("cached");
  expect(text).toContain("output");
  expect(text).toContain("cache write");
});
