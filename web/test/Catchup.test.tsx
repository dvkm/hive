import { expect, test } from "bun:test";
import { act, create } from "react-test-renderer";
import { MemoryRouter } from "react-router-dom";
import { api } from "../src/lib/api";
import type { GlanceCard } from "../src/lib/api";
import { LightboxProvider } from "../src/lib/lightbox";
import Catchup, { CARD_TEXT_MAX, capLine } from "../src/views/Catchup";

(globalThis as unknown as { window: typeof globalThis }).window = globalThis;
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: { getItem: () => null, setItem: () => {} },
});

const card = (over: Partial<GlanceCard> = {}): GlanceCard => ({
  task_id: `t${Math.random()}`,
  number: 1,
  display_id: "HIVE-1",
  title: "Ship the thing",
  project_id: "project-1",
  kind: "ship",
  state: "done",
  shipped_at: "2026-08-28T00:00:00.000Z",
  headline: "The card now shows a picture per change.",
  merged_by: "auto",
  files: 3,
  additions: 120,
  deletions: 4,
  areas: [{ area: "web/src", churn: 124 }],
  images: [],
  explanation_url: "/evidence/x/explain.html",
  ...over,
});

async function render(cards: GlanceCard[]) {
  api.catchup = (async () => ({ cards })) as typeof api.catchup;
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(
      <MemoryRouter>
        <LightboxProvider><Catchup /></LightboxProvider>
      </MemoryRouter>
    );
  });
  return renderer;
}

test("capLine never renders a paragraph, however long the payload is", () => {
  const line = capLine("word ".repeat(200));
  expect(line.length).toBeLessThanOrEqual(CARD_TEXT_MAX + 1);
  expect(line.endsWith("…")).toBe(true);
  expect(capLine("short one")).toBe("short one");
});

test("ten shipped changes render ten cards, each with a visual and no long text", async () => {
  const cards = Array.from({ length: 10 }, (_, i) =>
    card(i % 2 === 0
      ? { task_id: `t${i}`, images: [{ url: `/evidence/${i}.png`, caption: "after", phase: null }] }
      : { task_id: `t${i}`, images: [] })
  );
  const renderer = await render(cards);

  expect(renderer.root.findAllByProps({ className: "glance-card" })).toHaveLength(10);
  // Every card carries either an image or a generated visual, never nothing.
  const visuals =
    renderer.root.findAllByType("img").length +
    renderer.root.findAllByProps({ className: "glance-areas" }).length;
  expect(visuals).toBe(10);
  for (const line of renderer.root.findAllByProps({ className: "glance-line" }))
    expect(String(line.children[0]).length).toBeLessThanOrEqual(CARD_TEXT_MAX + 1);
});

test("a before/after pair is labelled so the eye reads it left to right", async () => {
  const renderer = await render([
    card({
      images: [
        { url: "/before.png", caption: null, phase: "before" },
        { url: "/after.png", caption: null, phase: "after" },
      ],
    }),
  ]);
  const tags = renderer.root.findAllByProps({ className: "glance-shot-tag" }).map((n) => n.children[0]);
  expect(tags).toEqual(["before", "after"]);
});

test("a card with no picture and no diff shape says so instead of leaving a hole", async () => {
  const renderer = await render([card({ images: [], areas: [] })]);
  expect(renderer.root.findAllByProps({ className: "glance-noshape" })).toHaveLength(1);
});

test("the card links to the long explanation page rather than inlining it", async () => {
  const renderer = await render([card()]);
  const link = renderer.root.findAll((n) => n.type === "a" && n.props.href === "/evidence/x/explain.html");
  expect(link).toHaveLength(1);
  expect(link[0].props.target).toBe("_blank");
});
