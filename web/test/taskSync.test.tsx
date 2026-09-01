import { expect, test } from "bun:test";
import { act, create } from "react-test-renderer";
import { MemoryRouter } from "react-router-dom";
import { api } from "../src/lib/api";
import type { Task } from "../src/lib/api";
import { StoreProvider, useStore } from "../src/lib/store";

(globalThis as unknown as { window: typeof globalThis }).window = globalThis;
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: { getItem: () => null, setItem: () => {} },
});
// StoreProvider opens a live stream on mount; a dummy stands in for it here.
(globalThis as any).EventSource = class {
  close() {}
};

const task = (id: string): Task => ({ id, title: `Task ${id}`, updated_at: "2026-01-01T00:00:00.000Z" } as Task);

// Restores whatever this file overwrote on the shared `api` singleton.
function stubStoreApi(over: Partial<typeof api>): () => void {
  const keys = ["cachedTasks", "tasks", "decisions", "projects", "checkpoints", "understandingQuizzes", "notifications", "offline", "away"] as const;
  const originals = Object.fromEntries(keys.map((k) => [k, (api as any)[k]]));
  const empty = async () => [];
  Object.assign(api, {
    cachedTasks: async () => null,
    tasks: empty,
    decisions: empty,
    projects: empty,
    checkpoints: async () => ({ checkpoints: [] }),
    understandingQuizzes: async () => ({ quizzes: [] }),
    notifications: async () => ({ notifications: [] }),
    offline: async () => ({ on: false }),
    away: async () => ({ on: false, active: false, held: 0 }),
    ...over,
  });
  return () => Object.assign(api, originals);
}

// Reads the live store out of a mounted provider.
function mount() {
  let store!: ReturnType<typeof useStore>;
  const Probe = () => {
    store = useStore();
    return null;
  };
  return {
    render: async () => {
      await act(async () => {
        create(
          <MemoryRouter>
            <StoreProvider>
              <Probe />
            </StoreProvider>
          </MemoryRouter>
        );
      });
    },
    get: () => store,
  };
}

test("a failed refresh over a cached board says so, keeps the cached rows, and retries", async () => {
  let calls = 0;
  const restore = stubStoreApi({
    cachedTasks: (async () => [task("cached")]) as typeof api.cachedTasks,
    tasks: (async () => {
      calls++;
      throw new Error("network");
    }) as typeof api.tasks,
  });
  const probe = mount();
  try {
    await probe.render();
    expect(probe.get().taskSync).toBe("failed");
    // Stale rows stay on screen — the banner is what tells the reader.
    expect(probe.get().tasks.map((t) => t.id)).toEqual(["cached"]);
    expect(calls).toBe(1);

    // The retry path is the same call the scheduled backoff makes; once the
    // fetch works, the indicator clears and fresh rows land.
    (api as any).tasks = async () => [task("fresh")];
    await act(async () => probe.get().retryTaskSync());
    expect(probe.get().taskSync).toBe("live");
    expect(probe.get().tasks.map((t) => t.id)).toEqual(["fresh"]);
  } finally {
    restore();
  }
});

test("a failed refresh with no cache does not present an empty board as real", async () => {
  const restore = stubStoreApi({
    cachedTasks: (async () => null) as typeof api.cachedTasks,
    tasks: (async () => {
      throw new Error("network");
    }) as typeof api.tasks,
  });
  const probe = mount();
  try {
    await probe.render();
    expect(probe.get().tasks).toEqual([]);
    expect(probe.get().taskSync).toBe("failed");
  } finally {
    restore();
  }
});

test("a successful refresh reports live", async () => {
  const restore = stubStoreApi({ tasks: (async () => [task("fresh")]) as typeof api.tasks });
  const probe = mount();
  try {
    await probe.render();
    expect(probe.get().taskSync).toBe("live");
  } finally {
    restore();
  }
});
