#!/usr/bin/env bun
// Rebuild historical usage rows inflated by the per-Stop cumulative
// double-count (hooks/report-usage.ts posted whole-transcript totals as a NEW
// row on every Stop; interactive agents Stop every turn).
//
// Detection: within (task_id, model, source='hook') ordered by ts, totals only
// grow while the same session keeps re-posting; a DROP in output_tokens means a
// new session began. Keep each segment's LAST row (the converged total), delete
// the rest.
//
//   bun scripts/dedupe-usage.ts [--db path]          dry run (default ~/.hive/hive.db)
//   bun scripts/dedupe-usage.ts --db path --apply    apply
import { Database } from "bun:sqlite";

const args = process.argv.slice(2);
const dbPath = args.includes("--db") ? args[args.indexOf("--db") + 1] : `${process.env.HOME}/.hive/hive.db`;
const apply = args.includes("--apply");

const db = new Database(dbPath);
const groups = db
  .query("SELECT DISTINCT task_id, model FROM usage WHERE source = 'hook'")
  .all() as { task_id: string; model: string }[];

let drop: string[] = [];
for (const g of groups) {
  const rows = db
    .query("SELECT id, ts, input_tokens, output_tokens FROM usage WHERE source = 'hook' AND task_id = ? AND model = ? ORDER BY ts")
    .all(g.task_id, g.model) as { id: string; output_tokens: number }[];
  let segment: string[] = [];
  let prevOut = -1;
  for (const r of rows) {
    if (r.output_tokens < prevOut && segment.length) {
      drop.push(...segment.slice(0, -1)); // keep the segment's last (converged) row
      segment = [];
    }
    segment.push(r.id);
    prevOut = r.output_tokens;
  }
  drop.push(...segment.slice(0, -1));
}

const before = db.query("SELECT COUNT(*) n, ROUND(SUM(cost_usd),2) c FROM usage").get() as any;
console.log(`db: ${dbPath}`);
console.log(`before: ${before.n} rows, $${before.c}`);
console.log(`cumulative-duplicate rows to remove: ${drop.length}`);
if (!apply) {
  const kept = db
    .query(`SELECT ROUND(SUM(cost_usd),2) c FROM usage WHERE id NOT IN (${drop.map(() => "?").join(",") || "''"})`)
    .get(...drop) as any;
  console.log(`after (dry run): ${before.n - drop.length} rows, $${kept.c}`);
  console.log("re-run with --apply to write");
  process.exit(0);
}
db.exec("BEGIN");
const del = db.query("DELETE FROM usage WHERE id = ?");
for (const id of drop) del.run(id);
db.exec("COMMIT");
const after = db.query("SELECT COUNT(*) n, ROUND(SUM(cost_usd),2) c FROM usage").get() as any;
console.log(`after: ${after.n} rows, $${after.c}`);
