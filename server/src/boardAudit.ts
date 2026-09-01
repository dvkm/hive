// Board-vs-reality audit (HIVE-528).
//
// Hive's board is a claim about the world. On 2026-08-29 a whole session went
// into checking that claim by hand and it was wrong four separate ways, none of
// which had raised a signal: 8 queued tasks the dispatcher could never run, 10
// Jira issues still open days after the work merged, 5 "failed" tasks that had
// all shipped, and a pile of mirror rows echoing hive's own work. Every one was
// found by a query nobody ran on a schedule. This is that schedule.
//
// Two rules make it useful rather than noise:
//   - READ-ONLY. It reports disagreements; it never repairs them. Everything it
//     looks at is state that was already wrong once, so an auto-repair here
//     turns a bad diff into a bad write. It writes only its own `board_audit`
//     events (the dedupe ledger) and one notification.
//   - SILENT WHEN CLEAN. Nothing new to say, nothing said. A report that always
//     says something is a report nobody reads, which is the failure it exists
//     to fix. Each (task, check) pair is reported exactly once, ever.
//
// It rides the reconciler loop rather than adding a scheduler, as a step()
// like every other, so a failure here can never stall the sync steps.
import type { DB } from "./db.ts";
import { writeEvent } from "./state.ts";
import { enqueue } from "./notifications.ts";
import { activeProjectSql } from "./testProjects.ts";
import { isTrackingOnlyTask } from "./supervision.ts";
import { defaultExec, mapLimit, type Exec } from "./exec.ts";

export type AuditKind =
  | "merged_not_closed"
  | "closed_not_merged"
  | "queued_unrunnable"
  | "orphaned_external_key"
  | "provenance_break"
  | "stuck_spawns";

export interface AuditFinding {
  kind: AuditKind;
  task_id: string;
  note: string; // one plain-English line, written for the board
}

const TERMINAL_SQL = "('done','failed','cancelled')";
// dispatcher.ts backs a failing spawn off by 30s * 2^(n-1), capped at 30m. The
// cap is first reached at the 7th failure, so from there on the task is retried
// forever at the slowest rate hive has and nobody is told. That is the ceiling.
const SPAWN_ERROR_CEILING = 7;
// A spawn_error tagged `infra` is the herdr daemon being down, and one tagged
// `held_until` is another live agent still holding this task's name (HIVE-568).
// Neither is this task's fault — the same exclusions dispatcher.inBackoff makes.
const OWN_SPAWN_ERROR =
  "(NOT json_valid(e.payload) OR (COALESCE(json_extract(e.payload, '$.infra'), 0) = 0 " +
  "AND COALESCE(json_extract(e.payload, '$.held_until'), 0) = 0))";
// Only projects hive still drives. A test or archived project's rows are
// expected to disagree with reality: the repo they named is gone.
const active = (col = "t.project_id") => `JOIN projects p ON p.id = ${col} AND ${activeProjectSql("p.config")}`;

function label(t: { number?: number | null; title: string }): string {
  return `#${t.number ?? "?"} ${t.title}`;
}

// 1. Merged but not closed. Work shipped, the external issue never moved. This
//    is the check that would have caught all ten stale Jira issues: the mirror
//    row carries the issue's own status, so a non-terminal mirror sitting over
//    done hive work IS the divergence.
function mergedNotClosed(db: DB): AuditFinding[] {
  const mirrors = db
    .query(
      `SELECT t.id, t.number, t.title, t.jira_key, t.state, t.project_id FROM tasks t ${active()}
        WHERE t.jira_link_kind = 'mirror' AND t.jira_key IS NOT NULL AND t.state NOT IN ${TERMINAL_SQL}`
    )
    .all() as any[];
  const shipped = db.query(
    `SELECT id, number, title FROM tasks
      WHERE project_id = ?1 AND state = 'done' AND id <> ?2
        AND COALESCE(jira_link_kind, '') <> 'mirror' AND COALESCE(source, '') <> 'external'
        AND (jira_key = ?3 OR parent_task_id = ?2 OR instr(title, ?4) > 0)
      ORDER BY updated_at DESC LIMIT 1`
  );
  const out: AuditFinding[] = [];
  for (const m of mirrors) {
    // `[KEY]` keeps the match bounded: '[WEB-9]' cannot match '[WEB-91]'.
    const hit = shipped.get(m.project_id, m.id, m.jira_key, `[${m.jira_key}]`) as any;
    if (!hit) continue;
    out.push({
      kind: "merged_not_closed",
      task_id: m.id,
      note: `${m.jira_key} is still '${m.state}' on the board, but hive already shipped ${label(hit)}. Close the issue or reopen the work.`,
    });
  }
  return out;
}

// 2. Closed but not merged, the dangerous direction: hive says done, and the PR
//    never landed. Hive's OWN events cannot answer this — 35 corebeat tasks
//    carry no `merged` event and every one of them is merged on GitHub, because
//    a human landed them outside hive. Believing the local record here would
//    have made this the noisiest check in the audit and the first one ignored.
//    So: hive's events pick the CANDIDATES, and GitHub gives the verdict.
//
//    Each candidate is probed once, ever. The answer (landed or not) goes in
//    this audit's own ledger, so a task confirmed merged is never probed again
//    and the steady-state cost is zero `gh` calls. A probe that fails records
//    nothing and is retried next cycle: an unreachable `gh` must never be read
//    as "the PR is missing" (a broken `gh` is reported on its own, by
//    health.noteToolStart from the linkPRs step).
const GH_TIMEOUT_MS = 12_000;
const GH_CONCURRENCY = 6;
// Per-cycle probe budget, so the first run against a long-lived board (35
// candidates when this was written) cannot stretch a reconciler lap. The rest
// are picked up next cycle, and once each has an answer the budget is unused.
const GH_PROBE_BUDGET = 20;

async function closedNotMerged(db: DB, exec: Exec): Promise<AuditFinding[]> {
  const candidates = db
    .query(
      `SELECT t.id, t.number, t.title, t.pr_url FROM tasks t ${active()}
        WHERE t.state = 'done' AND t.pr_url IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM events e
             WHERE e.task_id IN (t.id, COALESCE(t.parent_task_id, t.id))
               AND e.type IN ('merged','pr_merged','unmergeable'))
          AND NOT EXISTS (
            SELECT 1 FROM events e
             WHERE e.task_id = t.id AND e.type = 'board_audit'
               AND json_extract(e.payload, '$.check') = 'closed_not_merged')
        ORDER BY t.updated_at DESC LIMIT ${GH_PROBE_BUDGET}`
    )
    .all() as any[];

  const probes = await mapLimit(candidates, GH_CONCURRENCY, async (t: any) => {
    const r = await exec(["gh", "pr", "view", t.pr_url, "--json", "state"], { timeoutMs: GH_TIMEOUT_MS });
    if (r.code !== 0) return null; // gh unavailable: no verdict, retry next cycle
    try {
      return { t, state: String(JSON.parse(r.stdout).state ?? "") };
    } catch {
      return null;
    }
  });

  const out: AuditFinding[] = [];
  for (const probe of probes) {
    if (!probe) continue;
    const { t, state } = probe;
    if (state === "MERGED") {
      // Settled, and not a disagreement worth a director's attention: the work
      // landed, hive just did not witness it. Recorded so it is never re-probed.
      writeEvent(db, { task_id: t.id, source: "reconciler", type: "board_audit", payload: { check: "closed_not_merged", landed: true } });
      continue;
    }
    out.push({
      kind: "closed_not_merged",
      task_id: t.id,
      note: `Marked done, but GitHub says ${t.pr_url} is ${state || "not merged"}. This is not shipped.`,
    });
  }
  return out;
}

// 3. Queued but unrunnable: the dispatcher will skip it for a reason that will
//    never stop being true, so it sits on the board looking like pending work
//    forever. (26 such tasks lifetime, 0 ever run.) Only the "not ever" reasons
//    belong here — a capacity cap, a backoff or an unmet dependency all clear
//    on their own and are not disagreements.
//    ponytail: re-derived here. When the silent-skips work lands a reason code
//    on the dispatcher, read that instead and delete this.
function queuedUnrunnable(db: DB): AuditFinding[] {
  const rows = db
    .query(
      `SELECT t.id, t.number, t.title, t.source, t.source_ref, p.repo_path FROM tasks t ${active()}
        WHERE t.state = 'queued'`
    )
    .all() as any[];
  const out: AuditFinding[] = [];
  for (const t of rows) {
    const reason = isTrackingOnlyTask(t)
      ? "it is a tracking-only row (a mirrored ticket or another agent's board entry), which hive never dispatches"
      : !t.repo_path
        ? "its project has no repo checked out, so no agent can be given a worktree"
        : null;
    if (!reason) continue;
    out.push({
      kind: "queued_unrunnable",
      task_id: t.id,
      note: `Queued but no agent will ever pick it up: ${reason}. It is not pending work.`,
    });
  }
  return out;
}

// 4. Orphaned external identity: a finished task still holds the Jira key while
//    the live successor that inherited its work holds none, so status stops
//    flowing to the issue. That is the requeue-link bug (task 43e7c5aa6a02);
//    this check is how you find out it has come back.
function orphanedExternalKey(db: DB): AuditFinding[] {
  return (
    db
      .query(
        `SELECT c.id, c.number, c.title, prev.jira_key, prev.number AS prev_number
           FROM tasks c ${active("c.project_id")}
           JOIN tasks prev ON prev.id = c.parent_task_id
          WHERE prev.jira_key IS NOT NULL AND prev.jira_link_kind = 'subtask'
            AND prev.state IN ${TERMINAL_SQL}
            AND c.jira_key IS NULL AND c.state NOT IN ${TERMINAL_SQL}`
      )
      .all() as any[]
  ).map((c) => ({
    kind: "orphaned_external_key" as const,
    task_id: c.id,
    note: `${c.jira_key} is still pinned to the finished #${c.prev_number}, while the live successor ${label(c)} carries no key. Jira will not hear about this work.`,
  }));
}

// 5. Provenance breaks: a failed task with no successor that was nonetheless
//    superseded by work that landed. The board reads it as dead; it shipped.
//    Five tasks looked abandoned this way.
//
//    Matching is the whole risk here. A shared branch is proof: hive names a
//    branch after the task, so two tasks on one branch are one piece of work.
//    A shared title is only a hint — "update dependencies" gets typed twice a
//    year by unrelated people, and a false "this already shipped" on a real
//    failure is the one error this check must not make. So the title path is
//    fenced: same kind, and landed inside the window a replacement actually
//    lands in. Outside that, a repeated title is treated as a coincidence.
const REPLACEMENT_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

function provenanceBreaks(db: DB): AuditFinding[] {
  const dead = db
    .query(
      `SELECT t.id, t.number, t.title, t.kind, t.branch, t.project_id, t.created_at FROM tasks t ${active()}
        WHERE t.state = 'failed' AND NOT EXISTS (SELECT 1 FROM tasks s WHERE s.parent_task_id = t.id)`
    )
    .all() as any[];
  const successor = db.query(
    `SELECT id, number, title, branch FROM tasks
      WHERE project_id = ?1 AND state = 'done' AND id <> ?2 AND created_at > ?3
        AND ((?5 IS NOT NULL AND branch = ?5)
             OR (title = ?4 AND kind = ?6 AND created_at <= ?7))
      ORDER BY created_at LIMIT 1`
  );
  const out: AuditFinding[] = [];
  for (const t of dead) {
    const deadline = new Date(Date.parse(t.created_at) + REPLACEMENT_WINDOW_MS).toISOString();
    const hit = successor.get(t.project_id, t.id, t.created_at, t.title, t.branch, t.kind, deadline) as any;
    if (!hit) continue;
    out.push({
      kind: "provenance_break",
      task_id: t.id,
      note:
        hit.branch && hit.branch === t.branch
          ? `Shows as failed with nothing following it, but ${label(hit)} shipped on the same branch (${t.branch}) later. The board is calling shipped work dead.`
          : `Shows as failed with nothing following it, but ${label(hit)} shipped under the same title soon after. Check they are the same work: the titles match, the branches do not.`,
    });
  }
  return out;
}

// 6. Stuck spawns: past the dispatcher's retry ceiling, so it is now retried at
//    the slowest rate hive has, forever, in silence.
function stuckSpawns(db: DB): AuditFinding[] {
  return (
    db
      .query(
        `SELECT t.id, t.number, t.title, COUNT(*) AS n FROM tasks t ${active()}
           JOIN events e ON e.task_id = t.id AND e.type = 'spawn_error' AND ${OWN_SPAWN_ERROR}
          WHERE t.state = 'queued' GROUP BY t.id HAVING n >= ${SPAWN_ERROR_CEILING}`
      )
      .all() as any[]
  ).map((t) => ({
    kind: "stuck_spawns" as const,
    task_id: t.id,
    note: `Failed to start ${t.n} times running, past the retry ceiling. Nothing will fix itself here.`,
  }));
}

// The checks that need nothing but the database. Pure read, so every caller can
// run this as often as it likes. `closed_not_merged` is deliberately not here:
// it needs GitHub to answer, and lives in reportBoardAudit.
export function auditBoard(db: DB): AuditFinding[] {
  return [
    ...mergedNotClosed(db),
    ...queuedUnrunnable(db),
    ...orphanedExternalKey(db),
    ...provenanceBreaks(db),
    ...stuckSpawns(db),
  ];
}

const HEADLINE: Record<AuditKind, string> = {
  merged_not_closed: "shipped but the ticket is still open",
  closed_not_merged: "marked done with no proof the PR landed",
  queued_unrunnable: "queued but nothing will ever run it",
  orphaned_external_key: "Jira key left on a finished task",
  provenance_break: "failed on the board but the work shipped",
  stuck_spawns: "stuck failing to start",
};

// Run the audit and report only what has never been reported before. Returns
// the new findings (empty = clean = nothing said anywhere).
export async function reportBoardAudit(db: DB, deps: { exec?: Exec } = {}): Promise<AuditFinding[]> {
  const seen = db.query("SELECT 1 FROM events WHERE task_id = ? AND type = 'board_audit' AND json_extract(payload, '$.check') = ? LIMIT 1");
  const all = [...auditBoard(db), ...(await closedNotMerged(db, deps.exec ?? defaultExec))];
  const fresh = all.filter((f) => !seen.get(f.task_id, f.kind));
  if (!fresh.length) return [];

  for (const f of fresh) {
    writeEvent(db, {
      task_id: f.task_id,
      source: "reconciler",
      type: "board_audit",
      payload: { check: f.kind, note: f.note },
    });
  }

  const byKind = new Map<AuditKind, number>();
  for (const f of fresh) byKind.set(f.kind, (byKind.get(f.kind) ?? 0) + 1);
  const lines = [...byKind].map(([kind, n]) => `${n} ${HEADLINE[kind]}`);
  enqueue(db, {
    kind: "board_audit",
    urgency: "normal",
    title: `Board audit: ${fresh.length} thing${fresh.length === 1 ? "" : "s"} the board gets wrong`,
    body: `${lines.join("; ")}. Each task carries the detail.`,
  });
  return fresh;
}
