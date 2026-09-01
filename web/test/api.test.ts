import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { api } from "../src/lib/api";

test("API token entry avoids Electron's unsupported window.prompt", () => {
  const source = readFileSync(join(import.meta.dir, "../src/lib/api.ts"), "utf8");
  expect(source).not.toContain("window.prompt(");
  expect(source).toContain('document.createElement("dialog")');
});

// Stands in the browser Cache API up with one entry stamped `cachedAt`.
function withCachedTasks(tasks: unknown, cachedAt: number | null, run: () => Promise<void>) {
  const original = globalThis.caches;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cachedAt !== null) headers["x-hive-cached-at"] = String(cachedAt);
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: { open: async () => ({ match: async () => new Response(JSON.stringify(tasks), { headers }) }) },
  });
  return run().finally(() => {
    if (original) Object.defineProperty(globalThis, "caches", { configurable: true, value: original });
    else delete (globalThis as { caches?: CacheStorage }).caches;
  });
}

test("task bootstrap reads the last compact list from browser cache", async () => {
  const tasks = [{ id: "cached-task", title: "Cached" }];
  await withCachedTasks(tasks, Date.now(), async () => {
    expect(await api.cachedTasks()).toEqual(tasks);
  });
});

// An unbounded cache can paint an arbitrarily old board, which is exactly the
// confidently-wrong screen every action then 409s against.
test("a cached task list older than five minutes is refused", async () => {
  const tasks = [{ id: "cached-task", title: "Cached" }];
  await withCachedTasks(tasks, Date.now() - 6 * 60 * 1000, async () => {
    expect(await api.cachedTasks()).toBe(null);
  });
  // Entries written before the stamp existed carry no date, so they are old too.
  await withCachedTasks(tasks, null, async () => {
    expect(await api.cachedTasks()).toBe(null);
  });
});
