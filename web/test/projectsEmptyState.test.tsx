import { expect, test } from "bun:test";
import { act, create } from "react-test-renderer";
import { MemoryRouter } from "react-router-dom";
import { api } from "../src/lib/api";
import { Ctx } from "../src/lib/store";
import type { Store } from "../src/lib/store";
import Projects from "../src/views/Projects";
import { AutoDispatchSection } from "../src/views/Policies";

(globalThis as unknown as { window: typeof globalThis }).window = globalThis;
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: { getItem: () => null, setItem: () => {} },
});

// Both views fetch projects themselves instead of reading the store, so the
// store only has to satisfy what Projects destructures.
const store = { tasks: [], reloadProjects: () => {} } as unknown as Store;

// Runs the callback the failed loader scheduled for its backoff retry, without
// waiting out the real delay.
function withCapturedTimers<T>(body: (fire: () => Promise<void>) => Promise<T>): Promise<T> {
  const real = globalThis.setTimeout;
  const pending: Array<() => void> = [];
  (globalThis as any).setTimeout = ((fn: () => void) => { pending.push(fn); return 0; });
  const fire = async () => {
    const due = pending.splice(0, pending.length);
    if (!due.length) throw new Error("no retry was scheduled");
    await act(async () => { due.forEach((fn) => fn()); });
  };
  return body(fire).finally(() => { (globalThis as any).setTimeout = real; });
}

async function render(view: "projects" | "autodispatch") {
  let tree!: ReturnType<typeof create>;
  await act(async () => {
    tree = create(
      <MemoryRouter>
        <Ctx.Provider value={store}>{view === "projects" ? <Projects /> : <AutoDispatchSection />}</Ctx.Provider>
      </MemoryRouter>
    );
  });
  return () => JSON.stringify(tree.toJSON());
}

// Restores api.projects after each case.
function stubProjects(fn: typeof api.projects): () => void {
  const original = api.projects;
  (api as any).projects = fn;
  return () => { (api as any).projects = original; };
}

for (const view of ["projects", "autodispatch"] as const) {
  test(`${view}: a failed load never says "No projects yet", and retries`, async () => {
    let calls = 0;
    const restore = stubProjects((async () => {
      calls++;
      throw new Error("network");
    }) as typeof api.projects);
    try {
      await withCapturedTimers(async (fire) => {
        const html = await render(view);
        expect(html()).not.toContain("No projects yet");
        expect(calls).toBe(1);

        (api as any).projects = async () => [{ id: "p1", name: "Hive", config: {} }];
        await fire();
        expect(html()).toContain("Hive");
        expect(html()).not.toContain("No projects yet");
      });
    } finally {
      restore();
    }
  });

  test(`${view}: a genuinely empty response still says "No projects yet"`, async () => {
    const restore = stubProjects((async () => []) as typeof api.projects);
    try {
      const html = await render(view);
      expect(html()).toContain("No projects yet");
    } finally {
      restore();
    }
  });
}
