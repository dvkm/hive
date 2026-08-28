import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { api } from "../src/lib/api";

test("API token entry avoids Electron's unsupported window.prompt", () => {
  const source = readFileSync(join(import.meta.dir, "../src/lib/api.ts"), "utf8");
  expect(source).not.toContain("window.prompt(");
  expect(source).toContain('document.createElement("dialog")');
});

test("task bootstrap reads the last compact list from browser cache", async () => {
  const original = globalThis.caches;
  const tasks = [{ id: "cached-task", title: "Cached" }];
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: { open: async () => ({ match: async () => new Response(JSON.stringify(tasks)) }) },
  });
  try {
    expect(await api.cachedTasks()).toEqual(tasks);
  } finally {
    if (original) Object.defineProperty(globalThis, "caches", { configurable: true, value: original });
    else delete (globalThis as { caches?: CacheStorage }).caches;
  }
});
