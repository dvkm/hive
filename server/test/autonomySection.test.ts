import { test, expect } from "bun:test";
import { renderAutonomy, sparkbar, type AutonomyStats } from "../../cli/autonomySection.ts";

// A stubbed /api/stats/autonomy payload — the CLI section is pure rendering,
// so the stub is the whole contract it depends on.
function stub(over: Partial<AutonomyStats> = {}): AutonomyStats {
  return {
    window: { days: 7, since: "2026-08-13T00:00:00.000Z", until: "2026-08-20T00:00:00.000Z" },
    auto_merge_precision: { merges: 13, measurable: 12, clean: 11, fixed: 1, precision: 11 / 12, revert_detection: "on", cases: [] },
    inbox_load: {
      by_day: [0, 4, 8, 2, 0, 1, 3].map((total, i) => ({
        day: `2026-08-1${3 + i}`, decision: total, quiz: 0, checkpoint: 0, dialog: 0, stale: 0, total,
      })),
      totals: { decision: 18, quiz: 0, checkpoint: 2, dialog: 0, stale: 0, total: 20 },
      per_day: 20 / 7,
    },
    recovery: { auto_respawns: 9, one_cap_parks: 2, scouts_spawned: 4 },
    agreement: { auto_answered: 4, contradictions: 1, auto_contradicted: 1, agreement_rate: 0.75 },
    ...over,
  } as AutonomyStats;
}

test("CLI autonomy section renders all four numbers", () => {
  const out = renderAutonomy(stub()).join("\n");
  expect(out).toContain("AUTONOMY — last 7d");
  expect(out).toContain("11/12 clean (92%), 1 fixed after merge");
  expect(out).toContain("1 unmeasurable");
  expect(out).toContain("reverts on");
  expect(out).toContain("2.9/day");
  expect(out).toContain("(20 total: 18 decision, 2 checkpoint)");
  expect(out).toContain("9 auto-respawns, 2 held at cap, 4 scouts");
  expect(out).toContain("75% of 4 self-answered decisions stood");
});

test("CLI autonomy section says 'no data' instead of inventing a rate", () => {
  const out = renderAutonomy(
    stub({
      auto_merge_precision: { merges: 3, measurable: 0, clean: 0, fixed: 0, precision: null, revert_detection: "off", cases: [] },
      agreement: { auto_answered: 0, contradictions: 0, auto_contradicted: 0, agreement_rate: null },
    } as Partial<AutonomyStats>)
  ).join("\n");
  expect(out).toContain("no data (3 merges, none measurable)");
  expect(out).toContain("reverts off");
  expect(out).toContain("agreement:      no data (hive answered nothing itself)");
});

test("sparkbar scales to the tallest bucket and keeps the last 7", () => {
  expect(sparkbar([0, 4, 8, 2, 0, 1, 3])).toBe("▁▅█▃▁▂▄");
  expect(sparkbar([9, 9, 9, 9, 9, 9, 9, 0])).toBe("██████▁");
  expect(sparkbar([0, 0, 0])).toBe("▁▁▁");
  expect(sparkbar([])).toBe("");
});
