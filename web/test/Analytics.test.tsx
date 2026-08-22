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

test("brief and task usage summaries call the aggregate processed and expose its components", () => {
  for (const file of ["Brief.tsx", "Task.tsx"]) {
    const text = source(file);
    expect(text).toContain("processed");
    expect(text).toContain("fresh");
    expect(text).toContain("cached");
    expect(text).toContain("output");
    expect(text).toContain("cache write");
  }
});
