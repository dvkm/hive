import { expect, test } from "bun:test";
import { act, create } from "react-test-renderer";
import { MemoryRouter } from "react-router-dom";
import { api } from "../src/lib/api";
import type { Task } from "../src/lib/api";
import { StoreProvider, useStore } from "../src/lib/store";
import Chat from "../src/views/Chat";

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

// The siblings of the task list. Each initial load in StoreProvider retries the
// same way, and the two that make a positive claim when empty (projects renders
// first-run onboarding, decisions renders "nothing needs you") only make it once
// the list has really landed.

// Runs the callback the failed loader scheduled for its backoff retry, without
// waiting out the real delay.
function withCapturedTimers<T>(body: (fire: () => Promise<void>) => Promise<T>): Promise<T> {
  const real = globalThis.setTimeout;
  const pending: Array<() => void> = [];
  (globalThis as any).setTimeout = ((fn: () => void) => { pending.push(fn); return 0; });
  // Fires every retry scheduled so far (each failure schedules a new one).
  const fire = async () => {
    const due = pending.splice(0, pending.length);
    if (!due.length) throw new Error("no retry was scheduled");
    await act(async () => { due.forEach((fn) => fn()); });
  };
  return body(fire).finally(() => { (globalThis as any).setTimeout = real; });
}

test("a failed projects load does not claim a fresh install, and retries", async () => {
  let calls = 0;
  const restore = stubStoreApi({
    projects: (async () => {
      calls++;
      throw new Error("network");
    }) as typeof api.projects,
  });
  const probe = mount();
  try {
    await withCapturedTimers(async (fire) => {
      await probe.render();
      expect(probe.get().projects).toEqual([]);
      // The onboarding gate: empty, but never confirmed empty.
      expect(probe.get().projectsLoaded).toBe(false);
      expect(calls).toBe(1);

      (api as any).projects = async () => [{ id: "p1", name: "Hive" }];
      await fire();
      expect(probe.get().projectsLoaded).toBe(true);
      expect(probe.get().projects.map((p) => p.id)).toEqual(["p1"]);
    });
  } finally {
    restore();
  }
});

test("a failed decisions load does not claim that nothing needs you, and retries", async () => {
  const restore = stubStoreApi({
    decisions: (async () => {
      throw new Error("network");
    }) as typeof api.decisions,
  });
  const probe = mount();
  try {
    await withCapturedTimers(async (fire) => {
      await probe.render();
      expect(probe.get().decisions).toEqual([]);
      expect(probe.get().decisionsLoaded).toBe(false);

      (api as any).decisions = async () => [{ id: "d1" }];
      await fire();
      expect(probe.get().decisionsLoaded).toBe(true);
      expect(probe.get().decisions.map((d) => d.id)).toEqual(["d1"]);
    });
  } finally {
    restore();
  }
});

test("a genuinely empty response still counts as loaded", async () => {
  const restore = stubStoreApi({});
  const probe = mount();
  try {
    await probe.render();
    expect(probe.get().projects).toEqual([]);
    expect(probe.get().projectsLoaded).toBe(true);
    expect(probe.get().decisionsLoaded).toBe(true);
  } finally {
    restore();
  }
});

test("the other siblings keep trying too", async () => {
  let checkpointCalls = 0;
  let quizCalls = 0;
  let awayCalls = 0;
  let notificationCalls = 0;
  const restore = stubStoreApi({
    checkpoints: (async () => { checkpointCalls++; throw new Error("network"); }) as typeof api.checkpoints,
    understandingQuizzes: (async () => { quizCalls++; throw new Error("network"); }) as typeof api.understandingQuizzes,
    away: (async () => { awayCalls++; throw new Error("network"); }) as typeof api.away,
    notifications: (async () => { notificationCalls++; throw new Error("network"); }) as typeof api.notifications,
  });
  const probe = mount();
  try {
    await withCapturedTimers(async (fire) => {
      await probe.render();
      expect([checkpointCalls, quizCalls, awayCalls, notificationCalls]).toEqual([1, 1, 1, 1]);
      // Four scheduled retries; firing them is a second attempt each.
      await fire();
      expect([checkpointCalls, quizCalls, awayCalls, notificationCalls]).toEqual([2, 2, 2, 2]);
    });
  } finally {
    restore();
  }
});

test("the chat panel only offers first-run onboarding once the projects list has landed", async () => {
  const restore = stubStoreApi({
    projects: (async () => {
      throw new Error("network");
    }) as typeof api.projects,
  });
  const onboarding = (r: ReturnType<typeof create>) =>
    r.root.findAll((n) => n.props?.className === "manager-empty-title" && String(n.children[0]).startsWith("Connect your first project"));
  try {
    await withCapturedTimers(async (fire) => {
      let renderer!: ReturnType<typeof create>;
      await act(async () => {
        renderer = create(
          <MemoryRouter>
            <StoreProvider><Chat embedded /></StoreProvider>
          </MemoryRouter>
        );
      });
      expect(onboarding(renderer)).toHaveLength(0);

      // A real empty install still gets the real empty state.
      (api as any).projects = async () => [];
      await fire();
      expect(onboarding(renderer)).toHaveLength(1);
    });
  } finally {
    restore();
  }
});
