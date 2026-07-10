#!/usr/bin/env bun
// Recompute usage.cost_usd for every row against the current price table.
// Run after editing server/src/pricing.ts. Rows whose model is unpriced go null.
//
//   bun scripts/reprice-usage.ts [--db path] [--apply]
//
// Without --apply it prints the delta and writes nothing.
//
// Rows written before the v12 migration have their cache-write tokens folded
// into input_tokens, so they reprice at the input rate rather than 1.25x. Close
// enough — the alternative is re-reading every agent transcript.

import { Database } from "bun:sqlite";
import { costUsd } from "../server/src/pricing.ts";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const dbPath =
  args[args.indexOf("--db") + 1] && args.includes("--db")
    ? args[args.indexOf("--db") + 1]
    : `${process.env.HOME}/.hive/hive.db`;

// readwrite even for a dry run: a WAL database can't be opened read-only
// without write access to its -shm sidecar. Nothing is written unless --apply.
const db = new Database(dbPath, { readwrite: true });
const rows = db.query("SELECT * FROM usage").all() as any[];

let before = 0;
let after = 0;
const updates: [number | null, string][] = [];
for (const r of rows) {
  const next = costUsd(r.model, r);
  before += r.cost_usd ?? 0;
  after += next ?? 0;
  if (next !== r.cost_usd) updates.push([next, r.id]);
}

console.log(`db:      ${dbPath}`);
console.log(`rows:    ${rows.length} (${updates.length} change)`);
console.log(`before:  $${before.toFixed(2)}`);
console.log(`after:   $${after.toFixed(2)}`);

if (!apply) {
  console.log("\ndry run — pass --apply to write");
  process.exit(0);
}

const stmt = db.query("UPDATE usage SET cost_usd = ? WHERE id = ?");
db.transaction(() => updates.forEach((u) => stmt.run(...u)))();
console.log(`\nupdated ${updates.length} rows`);
