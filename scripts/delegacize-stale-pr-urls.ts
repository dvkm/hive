#!/usr/bin/env bun
// hive-487: after the 2026-08-27 public-repo migration, PR numbering restarted
// from 1, so old pr_urls like https://github.com/dvkm/hive/pull/6 now resolve
// to a different, unrelated PR. Any terminal task (done/failed/cancelled)
// still holding one of these is wrong.
//
// A task's pr_url is legitimate only if the PR it points at actually carries
// that task's `hive-task: <id>` marker (or a `[hive-<number>]` title prefix
// naming its number). This script reads every PR in the target repo via `gh`,
// then for each terminal task pointing at that repo whose PR doesn't name it,
// moves pr_url -> legacy_pr_url (preserving the historical reference) and
// records an event.
//
//   bun scripts/delegacize-stale-pr-urls.ts [--db path] [--repo owner/name]
//   bun scripts/delegacize-stale-pr-urls.ts --apply

import { Database } from "bun:sqlite";

const args = process.argv.slice(2);
const dbPath = args.includes("--db") ? args[args.indexOf("--db") + 1] : `${process.env.HOME}/.hive/hive.db`;
const repo = args.includes("--repo") ? args[args.indexOf("--repo") + 1] : "dvkm/hive";
const apply = args.includes("--apply");

function taskIdFromBody(body: string | null | undefined): string | null {
  if (!body) return null;
  return /hive-task:\s*([A-Za-z0-9_]+)/.exec(body)?.[1] ?? null;
}
function taskNumberFromTitle(title: string | null | undefined): number | null {
  if (!title) return null;
  const m = /\[hive-(\d+)\]/.exec(title);
  return m ? Number(m[1]) : null;
}

const proc = Bun.spawnSync(["gh", "pr", "list", "--repo", repo, "--state", "all", "--limit", "500", "--json", "number,title,body"]);
if (proc.exitCode !== 0) {
  console.error(new TextDecoder().decode(proc.stderr));
  process.exit(1);
}
const prs = JSON.parse(new TextDecoder().decode(proc.stdout)) as { number: number; title: string; body: string }[];
const markerIdByNumber = new Map<number, string>();
const numberByPrNumber = new Map<number, number>(); // pr number -> title-prefix task number
for (const pr of prs) {
  const id = taskIdFromBody(pr.body);
  if (id) markerIdByNumber.set(pr.number, id);
  const n = taskNumberFromTitle(pr.title);
  if (n != null) numberByPrNumber.set(pr.number, n);
}

const db = new Database(dbPath);
const prefix = `https://github.com/${repo}/pull/`;
const rows = db
  .query("SELECT id, number, title, state, pr_url FROM tasks WHERE pr_url LIKE ? AND state IN ('done','failed','cancelled')")
  .all(`${prefix}%`) as { id: string; number: number | null; title: string; state: string; pr_url: string }[];

let stale = 0;
for (const t of rows) {
  const prNumber = Number(t.pr_url.slice(prefix.length));
  const markerId = markerIdByNumber.get(prNumber);
  const titleNumber = numberByPrNumber.get(prNumber);
  const ok = markerId ? markerId === t.id : titleNumber != null && titleNumber === t.number;
  if (ok) continue;
  stale++;
  console.log(`${apply ? "delegacizing" : "would delegacize"} ${t.id} #${t.number} [${t.state}] "${t.title}" -> ${t.pr_url}`);
  if (!apply) continue;
  const now = new Date().toISOString();
  db.query("UPDATE tasks SET legacy_pr_url = ?, pr_url = NULL, updated_at = ? WHERE id = ?").run(t.pr_url, now, t.id);
  db.query(
    "INSERT INTO events (id, task_id, source, type, payload, ts) VALUES (?,?,?,?,?,?)"
  ).run(
    `evt_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
    t.id,
    "system",
    "pr_url_delegacized",
    JSON.stringify({ legacy_pr_url: t.pr_url, reason: "pr_url pointed at a PR that no longer carries this task's hive-task marker (repo migration, hive-487)" }),
    now
  );
}

console.log(`${stale} stale terminal pr_url(s) found${apply ? ", delegacized" : " (dry run, pass --apply to fix)"}`);
