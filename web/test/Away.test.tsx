import { expect, test } from "bun:test";
import { act, create } from "react-test-renderer";
import { MemoryRouter } from "react-router-dom";
import { api } from "../src/lib/api";
import type { Away } from "../src/lib/api";
import { Ctx, StoreProvider } from "../src/lib/store";
import { AwayBanner, AwayToggle, HeldSummary } from "../src/views/Away";
import { MicButton } from "../src/views/DecisionCard";

(globalThis as unknown as { window: typeof globalThis }).window = globalThis;
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: { getItem: () => null, setItem: () => {} },
});
// StoreProvider opens a live stream on mount; a dummy stands in for it here.
(globalThis as any).EventSource = class {
  close() {}
};

// The strings a reader actually sees: JSX splits one sentence across several
// text children, so flatten the tree before matching on it.
function flatten(node: any): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(flatten).join("");
  return flatten(node.children);
}
const text = (renderer: ReturnType<typeof create>) => flatten(renderer.toJSON());

// Restores whatever this file overwrote on the shared `api` singleton — other
// test files in the same run see the same object.
function stubStoreApi(): () => void {
  const keys = ["cachedTasks", "tasks", "decisions", "projects", "checkpoints", "understandingQuizzes", "notifications", "offline", "away", "setAway"] as const;
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
  });
  return () => Object.assign(api, originals);
}

test("the banner says what away mode is doing, and names the wake-up time when a schedule set it", () => {
  const away: Away = {
    on: false,
    active: true,
    schedule: { start: "23:00", end: "08:00", tz: "Asia/Seoul" },
    held: 3,
  };
  const scheduled = create(
    <MemoryRouter>
      <AwayBanner away={away} onResume={() => {}} />
    </MemoryRouter>
  );
  expect(text(scheduled)).toContain("until 08:00");
  expect(text(scheduled)).toContain("3 so far");

  // Flipped by hand, so there is no end time to promise.
  const manual = create(
    <MemoryRouter>
      <AwayBanner away={{ ...away, on: true, held: 0 }} onResume={() => {}} />
    </MemoryRouter>
  );
  expect(text(manual)).not.toContain("until");
  expect(text(manual)).toContain("Holding notifications.");
});

test("no banner when away mode is off", () => {
  const renderer = create(
    <MemoryRouter>
      <AwayBanner away={{ on: false, active: false, held: 0 }} onResume={() => {}} />
    </MemoryRouter>
  );
  expect(renderer.toJSON()).toBe(null);
});

test("the topbar toggle round-trips through /api/away", async () => {
  const restore = stubStoreApi();
  let posted: boolean | null = null;
  api.away = (async () => ({ on: false, active: false, held: 0 })) as typeof api.away;
  api.setAway = (async (on: boolean) => {
    posted = on;
    return { on, active: on, held: 0 };
  }) as typeof api.setAway;

  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(
      <MemoryRouter>
        <StoreProvider>
          <AwayToggle />
        </StoreProvider>
      </MemoryRouter>
    );
  });
  const button = renderer.root.findByType("button");
  expect(button.props["aria-pressed"]).toBe(false);

  await act(async () => button.props.onClick());
  expect(posted).toBe(true);
  expect(renderer.root.findByType("button").props["aria-pressed"]).toBe(true);

  // And back off again.
  await act(async () => renderer.root.findByType("button").props.onClick());
  expect(posted).toBe(false);
  expect(renderer.root.findByType("button").props["aria-pressed"]).toBe(false);
  restore();
});

test("the mic button is hidden where the browser has no Web Speech API", () => {
  delete (globalThis as any).SpeechRecognition;
  delete (globalThis as any).webkitSpeechRecognition;
  const renderer = create(<MicButton onText={() => {}} />);
  expect(renderer.toJSON()).toBe(null);
});

test("the mic button dictates final phrases into the note", async () => {
  const started: FakeRecognition[] = [];
  class FakeRecognition {
    lang = "";
    continuous = false;
    interimResults = true;
    onresult: ((event: any) => void) | null = null;
    onend: (() => void) | null = null;
    onerror: (() => void) | null = null;
    start() {
      started.push(this);
    }
    stop() {
      this.onend?.();
    }
  }
  // iOS Safari only ships the prefixed constructor, which is the one this runs on.
  (globalThis as any).webkitSpeechRecognition = FakeRecognition;

  const heard: string[] = [];
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(<MicButton onText={(t) => heard.push(t)} />);
  });
  await act(async () => renderer.root.findByType("button").props.onClick());
  expect(started.length).toBe(1);
  expect(text(renderer)).toContain("Listening");

  await act(async () =>
    started[0].onresult?.({
      resultIndex: 0,
      results: [
        { isFinal: true, 0: { transcript: "ship it" } },
        { isFinal: false, 0: { transcript: "still talking" } },
      ],
    })
  );
  expect(heard).toEqual(["ship it"]);

  // Stopping ends the session and the button goes back to idle.
  await act(async () => renderer.root.findByType("button").props.onClick());
  expect(text(renderer)).toContain("Speak");
  delete (globalThis as any).webkitSpeechRecognition;
});

function heldSummary(away: Away) {
  return create(
    <MemoryRouter>
      <Ctx.Provider value={{ away } as any}>
        <HeldSummary />
      </Ctx.Provider>
    </MemoryRouter>
  );
}

test("the summary shows what is being held now, and what the wake-up push covered after", () => {
  const item = { at: new Date().toISOString(), class: "decision", title: "Merge PR #811?", body: null, url: "/inbox" };
  const holding = heldSummary({ on: true, active: true, held: 1, items: [item], last_flush: null });
  expect(text(holding)).toContain("Held while away");
  expect(text(holding)).toContain("Merge PR #811?");

  const woken = heldSummary({ on: false, active: false, held: 0, items: [], last_flush: { at: item.at, items: [item] } });
  expect(text(woken)).toContain("While you were away");
  expect(text(woken)).toContain("Merge PR #811?");

  // Nothing held and nothing flushed: the section stays out of the way.
  expect(heldSummary({ on: false, active: false, held: 0, items: [], last_flush: null }).toJSON()).toBe(null);
});
