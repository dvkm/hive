// The AUTONOMY block of `hive stats`: four numbers that say whether hive's
// automation is earning trust. Pure rendering — it takes whatever
// server/src/autonomyStats.ts returned and gives back lines to print. Kept out
// of cli/hive.ts so a test can render it from a stubbed payload (hive.ts runs
// main() on import).
import type { autonomyStats } from "../server/src/autonomyStats.ts";

export type AutonomyStats = Awaited<ReturnType<typeof autonomyStats>>;

const BLOCKS = "▁▂▃▄▅▆▇█";

// A text sparkbar over the last `n` buckets. Scaled to the tallest bucket, so
// it shows shape, not magnitude — the per-day number next to it carries that.
export function sparkbar(values: number[], n = 7): string {
  const tail = values.slice(-n);
  if (!tail.length) return "";
  const max = Math.max(...tail);
  return tail.map((v) => (max <= 0 ? BLOCKS[0] : BLOCKS[Math.min(BLOCKS.length - 1, Math.round((v / max) * (BLOCKS.length - 1)))])).join("");
}

const pct = (r: number) => `${Math.round(r * 100)}%`;

export function renderAutonomy(stats: AutonomyStats): string[] {
  const { auto_merge_precision: merge, inbox_load: inbox, recovery, agreement } = stats;
  const days = stats.window.days;
  const lines = [`\nAUTONOMY — last ${days}d`];

  const unmeasured = merge.merges - merge.measurable;
  lines.push(
    `  auto-merge:     ${merge.precision === null
      ? `no data (${merge.merges} merges, none measurable)`
      : `${merge.clean}/${merge.measurable} clean (${pct(merge.precision)}), ${merge.fixed} fixed after merge`}` +
      `${unmeasured ? ` · ${unmeasured} unmeasurable` : ""} · reverts ${merge.revert_detection}`
  );

  const trend = sparkbar(inbox.by_day.map((d) => d.total));
  const mix = (["decision", "quiz", "checkpoint", "dialog", "stale"] as const)
    .filter((c) => inbox.totals[c] > 0)
    .map((c) => `${inbox.totals[c]} ${c}`)
    .join(", ");
  lines.push(`  inbox:          ${inbox.per_day.toFixed(1)}/day ${trend} (${inbox.totals.total} total${mix ? `: ${mix}` : ""})`);

  lines.push(
    `  recovery:       ${recovery.auto_respawns} auto-respawns, ${recovery.one_cap_parks} held at cap, ${recovery.scouts_spawned} scouts`
  );

  lines.push(
    `  agreement:      ${agreement.agreement_rate === null
      ? "no data (hive answered nothing itself)"
      : `${pct(agreement.agreement_rate)} of ${agreement.auto_answered} self-answered decisions stood`}`
  );
  return lines;
}
