import { expect, test } from "bun:test";
import { act, create } from "react-test-renderer";
import { api } from "../src/lib/api";
import type { AutonomyStats } from "../src/lib/api";
import { AutonomyPanel } from "../src/views/Brief";

(globalThis as unknown as { window: typeof globalThis }).window = globalThis;

function stub(over: Partial<AutonomyStats> = {}): AutonomyStats {
  return {
    window: { days: 7, since: "2026-08-13T00:00:00.000Z", until: "2026-08-20T00:00:00.000Z" },
    auto_merge_precision: { merges: 13, measurable: 12, clean: 11, fixed: 1, precision: 11 / 12, revert_detection: "on" },
    inbox_load: {
      by_day: [0, 4, 8, 2, 0, 1, 3].map((total, i) => ({ day: `2026-08-1${3 + i}`, total })),
      totals: { decision: 18, quiz: 0, checkpoint: 2, dialog: 0, stale: 0, total: 20 },
      per_day: 20 / 7,
    },
    recovery: { auto_respawns: 9, one_cap_parks: 2, scouts_spawned: 4 },
    agreement: { auto_answered: 4, contradictions: 1, auto_contradicted: 1, agreement_rate: 0.75 },
    ...over,
  };
}

async function render(stats: AutonomyStats) {
  api.autonomyStats = (async () => stats) as typeof api.autonomyStats;
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(<AutonomyPanel />);
  });
  return renderer;
}

test("autonomy panel shows the four numbers", async () => {
  const renderer = await render(stub());
  const text = JSON.stringify(renderer.toJSON());
  expect(text).toContain("92%");
  expect(text).toContain("11");
  expect(text).toContain("2.9");
  expect(text).toContain("▁▅█▃▁▂▄");
  expect(text).toContain("75%");
  expect(renderer.toJSON()).toMatchSnapshot();
});

test("autonomy panel says 'no data' instead of a made-up rate", async () => {
  const renderer = await render(
    stub({
      auto_merge_precision: { merges: 3, measurable: 0, clean: 0, fixed: 0, precision: null, revert_detection: "off" },
      agreement: { auto_answered: 0, contradictions: 0, auto_contradicted: 0, agreement_rate: null },
    })
  );
  const text = JSON.stringify(renderer.toJSON());
  expect(text).toContain("no data");
  expect(text).toContain("3 merges, none measurable");
  expect(text).toContain("hive answered nothing itself");
});
