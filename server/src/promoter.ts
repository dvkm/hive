// Continuous promotion evaluator. For projects that opt in with
//   config.promote = { from: "staging", to: "main" }
// the loop periodically fetches and, whenever `from` has commits `to` lacks,
// queues ONE evaluation task (source='promoter'). The dispatcher spawns an
// agent that judges readiness and either opens the Promote PR (the DIRECTOR
// merges — the agent never does) or attaches a report on what blocks it.
//
// Event-driven dedup: the created task carries the evaluated head SHA in
// source_ref. No new task is queued until `from` moves past the last evaluated
// SHA, so an unchanged not-ready branch is evaluated once, not every tick.
// ponytail: single global interval (HIVE_PROMOTE_MS); per-project intervals
// when someone actually needs them.
import type { DB } from "./db.ts";
import { now, newId, isOffline } from "./db.ts";
import { writeEvent, getTask } from "./state.ts";
import { broadcastTask } from "./health.ts";
import type { Exec } from "./exec.ts";
import { defaultExec } from "./exec.ts";

export interface PromoterDeps {
  exec?: Exec;
}

function promoteBrief(fromB: string, toB: string, ahead: string, sha: string): string {
  return `Continuous-promotion evaluation: decide whether \`${fromB}\` (head ${sha.slice(0, 8)}, ${ahead} commit(s) ahead) should be promoted into \`${toB}\`, and act.

Steps:
1. git fetch origin ${fromB} ${toB}, then review \`git log --oneline origin/${toB}..origin/${fromB}\` and the merged PRs it contains.
2. Check CI is green on origin/${fromB} (gh checks / recent runs).
3. Audit test comprehensiveness for the promoted range — green CI only proves the EXISTING tests pass, not that the changes are covered:
   - Bug-fix PRs: does a regression test exist that would have CAUGHT the original bug? (look for test files changed alongside the fix; read the test, don't just count it)
   - Feature PRs: are the new paths exercised — unit tests for logic, at least one e2e (or documented manual verification with evidence) for UI flows?
   - Smell: source files changed with no test changes anywhere near them.
   Verdict per PR: covered / partial / uncovered. For every real gap, spawn a follow-up task (\`hive task create\`) with a self-contained brief naming the file, the untested behavior, and the test to write.
   Blocking rule: an UNCOVERED bug fix, or any gap touching auth, billing, subscriptions/entitlements, or data integrity, BLOCKS promotion. Cosmetic/UI-copy gaps don't block — note them in the PR body.
4. Look for other promotion blockers: half-shipped work (one PR of a multi-PR feature), feature-flag-gated code whose flag story is incomplete, pending DB migrations that need ops coordination, reverts-in-waiting, anything the PR descriptions call out as "do not promote yet".
5. If READY: open a PR base \`${toB}\` head \`${fromB}\` titled with your hive marker + "Promote: <one-line summary>". Body: one bullet per included PR (number + what it does), a "Test coverage" section with the per-PR verdicts from step 3 (including gap tasks you spawned), plus any notes the director needs before merging. Then \`hive emit <task-id> ready --pr-url <url>\`. Do NOT merge it yourself — the director merges.
6. If NOT ready: attach a short report as evidence naming exactly which commits/PRs block promotion (coverage gaps included, with their spawned task ids) and what has to happen first, then \`hive emit <task-id> done\`. A new evaluation is queued automatically when ${fromB} moves.

Evaluated head: ${sha}`;
}

export async function promoteOnce(db: DB, deps: PromoterDeps = {}): Promise<void> {
  if (isOffline(db)) return; // offline mode: no network, no new evaluations
  const exec = deps.exec ?? defaultExec;
  const projects = db.query("SELECT * FROM projects").all() as any[];
  for (const p of projects) {
    try {
      const cfg = JSON.parse(p.config ?? "{}");
      const { from: fromB, to: toB } = cfg.promote ?? {};
      if (!fromB || !toB || !p.repo_path) continue;

      // One evaluation in flight at a time.
      const open = db
        .query(
          "SELECT 1 FROM tasks WHERE project_id = ? AND source = 'promoter' AND state NOT IN ('done','cancelled','failed') LIMIT 1"
        )
        .get(p.id);
      if (open) continue;

      const fetch = await exec(["git", "-C", p.repo_path, "fetch", "origin", fromB, toB, "--quiet"]);
      if (fetch.code !== 0) continue; // offline / remote missing: try next tick
      const ahead = await exec(["git", "-C", p.repo_path, "rev-list", "--count", `origin/${toB}..origin/${fromB}`]);
      const n = parseInt(ahead.stdout.trim(), 10);
      if (ahead.code !== 0 || !Number.isFinite(n) || n === 0) continue;

      // The commit count is only a hint: promotion PRs get squash-merged, so
      // `from`'s commits stay non-ancestors of `to` forever and the count never
      // returns to 0. The trees are what decides — identical trees = nothing to
      // promote. (`git diff --quiet` exits 0 when equal, 1 when different.)
      const diff = await exec(["git", "-C", p.repo_path, "diff", "--quiet", `origin/${toB}`, `origin/${fromB}`]);
      if (diff.code === 0) continue;

      const head = await exec(["git", "-C", p.repo_path, "rev-parse", `origin/${fromB}`]);
      const sha = head.stdout.trim();
      if (head.code !== 0 || !sha) continue;

      // Already evaluated this exact head (ready PR awaiting merge, or a
      // not-ready verdict)? Wait for new commits.
      const seen = db
        .query("SELECT 1 FROM tasks WHERE project_id = ? AND source = 'promoter' AND source_ref = ? LIMIT 1")
        .get(p.id, sha);
      if (seen) continue;

      // A promote PR someone opened by hand also counts as in-flight.
      const prs = await exec(
        ["gh", "pr", "list", "--base", toB, "--head", fromB, "--state", "open", "--json", "number"],
        { cwd: p.repo_path }
      );
      if (prs.code === 0) {
        try {
          if ((JSON.parse(prs.stdout) as any[]).length > 0) continue;
        } catch {
          /* unparseable: fall through and evaluate */
        }
      }

      const id = newId();
      const t = now();
      db.query(
        `INSERT INTO tasks (id, project_id, title, brief, state, kind, source, source_ref, created_at, updated_at)
         VALUES (?,?,?,?, 'queued', 'ship', 'promoter', ?, ?, ?)`
      ).run(
        id,
        p.id,
        `Promote ${fromB} → ${toB}: evaluate & open the PR (${n} commit${n === 1 ? "" : "s"} ahead)`,
        promoteBrief(fromB, toB, String(n), sha),
        sha,
        t,
        t
      );
      writeEvent(db, {
        task_id: id,
        source: "system",
        type: "created",
        payload: { title: `Promote ${fromB} → ${toB}`, via: "promoter", head: sha, ahead: n },
      });
      broadcastTask(db, getTask(db, id));
    } catch (e) {
      console.error(`[hive] promoter project ${p.id}:`, e);
    }
  }
}

// Production starts one background loop from index.ts. Each start call owns its
// timers and in-flight guard; a slow cycle skips ticks instead of queueing them.
// It fires once shortly after boot (SHA dedup makes restarts harmless), then on
// every interval.
export function startPromoter(db: DB, deps: PromoterDeps & { intervalMs?: number } = {}): () => void {
  const intervalMs = deps.intervalMs ?? 30 * 60 * 1000;
  let running = false;
  const run = () => {
    if (running) {
      console.error("[hive] promoter cycle skipped: previous cycle still running");
      return;
    }
    running = true;
    promoteOnce(db, deps)
      .catch((e) => console.error("[hive] promoter cycle crashed:", e))
      .finally(() => {
        running = false;
      });
  };
  const boot = setTimeout(run, 30_000);
  const timer = setInterval(run, intervalMs);
  return () => {
    clearTimeout(boot);
    clearInterval(timer);
  };
}
