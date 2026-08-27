// Sidecar checks (task HIVE-404): cheap, read-only feedback on what an agent
// has actually committed, while it is still working.
//
// Every reconciler cycle this looks at in-progress tasks with a live worktree,
// and when the worktree HEAD moved since the last report it runs the two
// cheapest signals a repo already has — `tsc --noEmit` and the project's own
// `lint` script — then writes a `sidecar_report` event. No test suite: this is
// meant to be fast and boring, not a second CI.
//
// Rules that keep it out of the way:
//   - never writes to the worktree. `tsc --noEmit` cannot write; a `lint`
//     script can, so a lint whose text carries a fix flag is skipped outright,
//     and the tree is fingerprinted before and after every run to catch one
//     that wrote anyway. A dirtied tree is reported and the whole pass stops.
//     It is never cleaned up: `git checkout` here could destroy agent work.
//   - skips a worktree mid-rebase or mid-merge: that tree is not the agent's
//     intent yet, so any finding would be noise
//   - one run at a time fleet-wide, so N busy worktrees can't all compile at once
//   - the whole fleet pass shares one 300s budget and resumes where it left off
//     next cycle, so one slow repo can't starve the rest of the fleet
//   - started, not awaited, by the reconciler — a slow check must never stall
//     the rest of the cycle
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DB } from "./db.ts";
import { writeEvent } from "./state.ts";
import { queueSteerEvent } from "./steer.ts";
import { defaultExec, type Exec } from "./exec.ts";

export interface SidecarDeps {
  exec?: Exec;
  exists?: (path: string) => boolean;
  readFile?: (path: string) => string;
}

export interface SidecarFinding {
  tool: string;
  summary: string;
}

// Total budget for one fleet-wide pass, shared across every task it visits.
const SWEEP_BUDGET_MS = 300_000;
const SUMMARY_MAX = 200;

// A lint script that rewrites the files it reads. Matched against the script
// text in package.json, not the argv we build, because the write would come
// from whatever the project put in there.
const FIX_FLAG_RE = /(^|\s)(--fix|--write|--fix-dry-run|-w)(\s|$)/;

// ponytail: a module-level promise is the whole lock. One server owns the
// fleet, so process-wide is fleet-wide; if that stops being true this becomes
// a lease row like the reconciler's.
let inFlight: Promise<void> | null = null;

// Task id to start the next pass at, when this pass ran out of budget before
// reaching the end of the fleet. Plain round-robin fairness.
let resumeFrom: string | null = null;

// The latest report, for the board card and review card chips (task HIVE-405).
export interface SidecarReport {
  sha: string;
  ok: boolean;
  findings: SidecarFinding[];
}

export function latestSidecar(db: DB, taskId: string): SidecarReport | null {
  const row = db
    .query(
      `SELECT payload FROM events
        WHERE task_id = ? AND type = 'sidecar_report' ORDER BY ts DESC, rowid DESC LIMIT 1`
    )
    .get(taskId) as { payload: string } | undefined;
  if (!row) return null;
  return parseSidecarPayload(row.payload);
}

function parseSidecarPayload(payload: string): SidecarReport | null {
  try {
    const p = JSON.parse(payload);
    if (typeof p?.sha !== "string") return null;
    return { sha: p.sha, ok: !!p.ok, findings: Array.isArray(p.findings) ? p.findings : [] };
  } catch {
    return null;
  }
}

// Batched form of latestSidecar (task HIVE-447): one grouped query for a whole
// task list instead of one query per task, so list endpoints (board,
// needs-attention, brief) stay O(1) queries regardless of list size.
export function latestSidecarBatch(db: DB, taskIds: string[]): Map<string, SidecarReport | null> {
  const result = new Map<string, SidecarReport | null>();
  const ids = [...new Set(taskIds)];
  if (ids.length === 0) return result;
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .query(
      `SELECT e.task_id AS task_id, e.payload AS payload FROM events e
        JOIN (SELECT task_id, MAX(rowid) AS rid FROM events
               WHERE type = 'sidecar_report' AND task_id IN (${placeholders})
               GROUP BY task_id) latest
          ON e.rowid = latest.rid`
    )
    .all(...ids) as { task_id: string; payload: string }[];
  for (const row of rows) result.set(row.task_id, parseSidecarPayload(row.payload));
  return result;
}

// A broken build is the one finding worth interrupting an agent for: everything
// it writes on top of it is built on a tree that does not compile. Lint is not
// — style noise mid-task is exactly the nagging this whole feature avoids.
// A check we skipped proves nothing, so it is not a break either.
function buildBreak(findings: SidecarFinding[]): SidecarFinding | undefined {
  return findings.find((f) => f.tool === "tsc" && !f.summary.startsWith("skipped:"));
}

// One FYI steer per commit. The sha sits in the message itself, so the events
// table is the dedupe key too — no side table, same as steer.ts.
function steerOnBuildBreak(db: DB, taskId: string, sha: string, findings: SidecarFinding[]): void {
  const broken = buildBreak(findings);
  if (!broken) return;
  const marker = `sidecar: build broken since ${sha.slice(0, 7)}:`;
  const seen = db
    .query(
      `SELECT 1 FROM events
        WHERE task_id = ? AND type = 'steer' AND json_extract(payload, '$.message') LIKE ? LIMIT 1`
    )
    .get(taskId, `${marker}%`);
  if (seen) return;
  queueSteerEvent(
    db,
    taskId,
    `${marker} ${broken.summary}\nFYI from hive's background type check, not a blocker: keep going and fix it whenever it suits you.`,
    "sidecar found a broken build"
  );
}

function lastReportedSha(db: DB, taskId: string): string | null {
  const row = db
    .query(
      `SELECT json_extract(payload, '$.sha') AS sha FROM events
        WHERE task_id = ? AND type = 'sidecar_report' ORDER BY ts DESC, rowid DESC LIMIT 1`
    )
    .get(taskId) as { sha: string | null } | undefined;
  return row?.sha ?? null;
}

function cap(summary: string): string {
  return summary.length > SUMMARY_MAX ? summary.slice(0, SUMMARY_MAX - 1) + "…" : summary;
}

// The first meaningful line(s) of a failing tool's output, capped so a 5000
// line tsc dump doesn't land in the event log.
function summarize(res: { stdout: string; stderr: string }): string {
  const text = [res.stdout, res.stderr].map((t) => t.trim()).filter(Boolean).join("\n");
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  return cap(lines.slice(0, 3).join(" | ") || "failed with no output");
}

function lintScript(readFile: (p: string) => string, worktree: string): string | null {
  try {
    const script = JSON.parse(readFile(join(worktree, "package.json")))?.scripts?.lint;
    return typeof script === "string" ? script : null;
  } catch {
    return null;
  }
}

// Fingerprint of everything git considers uncommitted, or null when git itself
// failed — in which case we can't prove anything either way and don't alarm.
async function porcelain(exec: Exec, worktree: string): Promise<string | null> {
  const res = await exec(["git", "-C", worktree, "status", "--porcelain"]);
  return res.code === 0 ? res.stdout.trim() : null;
}

type CheckRun = { findings: SidecarFinding[]; dirtied: boolean };

async function runChecks(
  exec: Exec,
  deps: Required<Pick<SidecarDeps, "exists" | "readFile">>,
  worktree: string,
  deadline: number
): Promise<CheckRun> {
  const findings: SidecarFinding[] = [];
  const remaining = () => deadline - Date.now();
  const checks: { tool: string; argv: string[] }[] = [];
  if (deps.exists(join(worktree, "tsconfig.json"))) checks.push({ tool: "tsc", argv: ["bun", "x", "tsc", "--noEmit"] });
  const lint = lintScript(deps.readFile, worktree);
  if (lint !== null) {
    // Never run a linter that can rewrite the agent's files under it.
    if (FIX_FLAG_RE.test(lint)) findings.push({ tool: "lint", summary: cap(`skipped: the lint script can write to the worktree (${lint})`) });
    else checks.push({ tool: "lint", argv: ["bun", "run", "lint"] });
  }
  if (checks.length === 0) return { findings, dirtied: false };

  const before = await porcelain(exec, worktree);
  for (const check of checks) {
    // A skipped check is a finding: the report has to say this sha was only
    // partly checked, rather than quietly reading as clean.
    if (remaining() <= 0) {
      findings.push({ tool: check.tool, summary: "skipped: the 300s sidecar budget ran out" });
      continue;
    }
    const res = await exec(check.argv, { cwd: worktree, timeoutMs: remaining() });
    if (res.code !== 0) findings.push({ tool: check.tool, summary: summarize(res) });
  }
  const after = await porcelain(exec, worktree);
  // Detect and alarm only. Reverting could clobber work the agent did while
  // these checks were running, which is strictly worse than a false alarm.
  const dirtied = before !== null && after !== null && before !== after;
  if (dirtied) {
    findings.push({
      tool: "sidecar",
      summary: cap("the worktree changed while checks ran, so a check may have written to it. Nothing was reverted. Check `git status` in this worktree before trusting it."),
    });
  }
  return { findings, dirtied };
}

async function sweep(db: DB, deps: SidecarDeps): Promise<void> {
  const exec = deps.exec ?? defaultExec;
  const fs = { exists: deps.exists ?? existsSync, readFile: deps.readFile ?? ((p: string) => readFileSync(p, "utf8")) };
  const deadline = Date.now() + SWEEP_BUDGET_MS;
  const rows = db
    .query(
      `SELECT id, worktree_path FROM tasks
        WHERE state = 'in_progress' AND agent_target IS NOT NULL AND worktree_path IS NOT NULL
        ORDER BY id`
    )
    .all() as { id: string; worktree_path: string }[];
  // Resume where the last pass ran out of budget, then wrap around.
  const start = resumeFrom ? rows.findIndex((r) => r.id === resumeFrom) : 0;
  const ordered = start > 0 ? [...rows.slice(start), ...rows.slice(0, start)] : rows;
  resumeFrom = null;

  for (const [i, row] of ordered.entries()) {
    if (Date.now() >= deadline) {
      resumeFrom = row.id; // pick this one up first next cycle
      return;
    }
    const wt = row.worktree_path;
    const head = await exec(["git", "-C", wt, "rev-parse", "HEAD"]);
    if (head.code !== 0) continue; // gone, or not a repo yet — nothing to check
    const sha = head.stdout.trim();
    if (!sha || sha === lastReportedSha(db, row.id)) continue;
    // A worktree's .git is a file, so these paths must come from git itself.
    const paths = await exec(["git", "-C", wt, "rev-parse", "--git-path", "rebase-merge", "--git-path", "rebase-apply", "--git-path", "MERGE_HEAD"]);
    const midOperation = paths.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .some((p) => fs.exists(p.startsWith("/") ? p : join(wt, p)));
    if (midOperation) continue;
    const { findings, dirtied } = await runChecks(exec, fs, wt, deadline);
    writeEvent(db, {
      task_id: row.id,
      source: "sidecar",
      type: "sidecar_report",
      payload: { sha, ok: findings.length === 0, findings },
    });
    steerOnBuildBreak(db, row.id, sha, findings);
    if (dirtied) {
      // Hard fail: something under us can write. Stop the pass rather than
      // point the same checks at the next live worktree.
      console.error(`[hive] sidecar: ${wt} was modified during checks; stopping this pass`);
      resumeFrom = ordered[i + 1]?.id ?? null;
      return;
    }
  }
}

// One sidecar pass. Resolves when the pass finishes; a call made while another
// pass is still running is a no-op. Never rejects.
export async function sidecarOnce(db: DB, deps: SidecarDeps = {}): Promise<void> {
  if (inFlight) return;
  const run = sweep(db, deps).catch((e) => {
    console.error("[hive] sidecar:", e);
  });
  inFlight = run;
  try {
    await run;
  } finally {
    inFlight = null;
  }
}

// Test-only: the pass cursor is module state, so a test that leaves it set
// would leak into the next one.
export function __resetSidecarCursor(): void {
  resumeFrom = null;
}
