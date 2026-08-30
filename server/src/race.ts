// Best-of-N racing (HIVE-351): run the SAME brief N times, side by side, and
// keep the one that came out best.
//
// A race is nothing but N sibling tasks that share a `race_id`. The task the
// director flagged IS attempt 1; the other attempts are straight clones of it
// (same brief, kind, verification contract, priority, dependencies) with their
// own `agent_override`, so one attempt can run on codex while its sibling runs
// on claude. Everything downstream is the machinery hive already has: the
// dispatcher spawns them, herdr gives each its own worktree and branch, usage
// rows record what each one cost, and cancelling the losers tears them down
// through the normal cleanup path.
//
// Deliberately never automatic. Racing multiplies both token spend and the
// director's review burden, so it starts only when a human calls
// POST /api/tasks/:id/race on a task they consider genuinely ambiguous.
//
// The lifecycle:
//   startRace()   -> attempts queued, one `race_started` event each
//   raceSweep()   -> once every attempt is settled (or the deadline passes),
//                    opens ONE decision card comparing them
//   pickWinner()  -> winner carries on through review as usual, losers are
//                    cancelled (their cost recorded on a `race_lost` event)
import type { DB } from "./db.ts";
import { newId, now } from "./db.ts";
import { getTask, writeEvent, transition, verificationChecklist, TERMINAL } from "./state.ts";
import { parseTask } from "./rows.ts";
import { isTrackingOnlyTask } from "./supervision.ts";
import { taskProcessedTokens, taskSpend } from "./costs.ts";
import { defaultExec, projectComparisonBase, type Exec } from "./exec.ts";

// 2 or 3. One attempt is not a race; past three the compare card stops being
// something a director can hold in their head, and the token bill triples.
export const MIN_ATTEMPTS = 2;
export const MAX_ATTEMPTS = 3;
export const AGENTS = ["claude", "codex", "teamclaude"];

// An attempt whose agent has nothing left to do. `in_review` is the normal
// finish line for a ship task; the rest are attempts that ended badly and still
// belong on the comparison card (an attempt that failed IS a result).
const SETTLED = ["in_review", "verifying", "done", "failed", "cancelled"];

export interface RaceAttempt {
  task_id: string;
  number: number;
  title: string;
  agent: string;
  state: string;
  branch: string | null;
  pr_url: string | null;
  settled: boolean;
  diff: { files: number; additions: number; deletions: number } | null;
  verification: { name: string; satisfied: boolean }[];
  cost_usd: number;
  processed_tokens: number;
  outcome: "winner" | "loser" | null;
}

export function raceTasks(db: DB, raceId: string): any[] {
  return db
    .query("SELECT * FROM tasks WHERE race_id = ? ORDER BY created_at ASC, rowid ASC")
    .all(raceId)
    .map(parseTask);
}

// The deadline the race was started with, read back off any attempt's
// `race_started` event (they all carry the same one). Null when open-ended.
export function raceDeadline(db: DB, raceId: string): string | null {
  const r = db
    .query(
      `SELECT json_extract(payload, '$.deadline') AS deadline FROM events
        WHERE type = 'race_started' AND json_extract(payload, '$.race_id') = ?
        ORDER BY ts ASC LIMIT 1`
    )
    .get(raceId) as { deadline: string | null } | undefined;
  return r?.deadline ?? null;
}

function outcomeOf(db: DB, taskId: string): "winner" | "loser" | null {
  const r = db
    .query("SELECT type FROM events WHERE task_id = ? AND type IN ('race_won','race_lost') ORDER BY ts DESC LIMIT 1")
    .get(taskId) as { type: string } | undefined;
  return r ? (r.type === "race_won" ? "winner" : "loser") : null;
}

// Lines changed on an attempt's branch against the project's comparison base.
// `--numstat` over `git diff` is enough for a compare card; the full patch is a
// click away on the task's own diff view.
async function diffStat(
  repoPath: string,
  base: string,
  branch: string,
  exec: Exec
): Promise<RaceAttempt["diff"]> {
  const r = await exec(["git", "-C", repoPath, "diff", "--numstat", `${base}...${branch}`]);
  if (r.code !== 0) return null;
  let files = 0;
  let additions = 0;
  let deletions = 0;
  for (const line of r.stdout.split("\n")) {
    const m = line.match(/^(\d+|-)\t(\d+|-)\t/);
    if (!m) continue;
    files++;
    additions += m[1] === "-" ? 0 : Number(m[1]); // "-" marks a binary file
    deletions += m[2] === "-" ? 0 : Number(m[2]);
  }
  return { files, additions, deletions };
}

// The comparison itself: what each attempt produced, what it cost, and whether
// it satisfied the task's own verification contract.
export async function raceView(
  db: DB,
  raceId: string,
  exec: Exec = defaultExec
): Promise<{ race_id: string; deadline: string | null; settled: boolean; attempts: RaceAttempt[] } | null> {
  const tasks = raceTasks(db, raceId);
  if (!tasks.length) return null;
  const project: any = db.query("SELECT repo_path, config FROM projects WHERE id = ?").get(tasks[0].project_id);
  const base = projectComparisonBase(JSON.parse(project?.config ?? "{}"));
  const attempts: RaceAttempt[] = [];
  for (const t of tasks) {
    attempts.push({
      task_id: t.id,
      number: t.number,
      title: t.title,
      agent: t.agent_override ?? "project default",
      state: t.state,
      branch: t.branch,
      pr_url: t.pr_url,
      settled: SETTLED.includes(t.state),
      diff: project?.repo_path && t.branch ? await diffStat(project.repo_path, base, t.branch, exec) : null,
      verification: verificationChecklist(db, t).map((c) => ({ name: c.name, satisfied: c.satisfied })),
      cost_usd: +taskSpend(db, t.id).toFixed(4),
      processed_tokens: taskProcessedTokens(db, t.id),
      outcome: outcomeOf(db, t.id),
    });
  }
  return { race_id: raceId, deadline: raceDeadline(db, raceId), settled: raceIsSettled(db, raceId), attempts };
}

export type StartRaceResult =
  | { ok: true; race_id: string; task_ids: string[] }
  | { ok: false; status: number; error: string };

// Flag a queued task for racing. Clones it into N-1 siblings, pins each
// attempt's agent backend, and lets the dispatcher pick all of them up.
export function startRace(
  db: DB,
  taskId: string,
  opts: { attempts?: number; agents?: string[]; deadline_min?: number } = {}
): StartRaceResult {
  const task = getTask(db, taskId);
  if (!task) return { ok: false, status: 404, error: "task not found" };
  if (task.race_id) return { ok: false, status: 409, error: "task is already part of a race" };
  if (isTrackingOnlyTask(task))
    return { ok: false, status: 409, error: "tracking-only tasks are never dispatched, so there is nothing to race" };
  // Racing means starting the same work N times from scratch. A task that has
  // already run has a branch, a worktree and possibly a PR — the attempts would
  // not be comparable, and the original's history would be silently reused.
  if (task.state !== "queued" || task.agent_target)
    return { ok: false, status: 409, error: `only a queued task with no agent can be raced (this one is '${task.state}')` };

  const n = opts.attempts ?? MIN_ATTEMPTS;
  if (!Number.isInteger(n) || n < MIN_ATTEMPTS || n > MAX_ATTEMPTS)
    return { ok: false, status: 400, error: `attempts must be ${MIN_ATTEMPTS} or ${MAX_ATTEMPTS}` };

  const project: any = db.query("SELECT config FROM projects WHERE id = ?").get(task.project_id);
  const config = JSON.parse(project?.config ?? "{}");
  const agents = opts.agents ?? defaultAgents(config, n);
  if (agents.length !== n) return { ok: false, status: 400, error: `agents must name one backend per attempt (${n})` };
  for (const a of agents)
    if (!AGENTS.includes(a)) return { ok: false, status: 400, error: `unknown agent '${a}' (use ${AGENTS.join(", ")})` };

  const raceId = newId("race");
  const deadline = opts.deadline_min ? new Date(Date.now() + opts.deadline_min * 60_000).toISOString() : null;
  const ts = now();
  const ids = [task.id];

  db.query("UPDATE tasks SET race_id = ?, agent_override = ?, updated_at = ? WHERE id = ?").run(raceId, agents[0], ts, task.id);
  // Clones are inserted directly rather than through createTask: duplicate
  // detection would see N identical briefs and cancel the race down to one task,
  // which is the exact opposite of the point.
  for (let i = 1; i < n; i++) {
    const id = newId();
    db.query(
      `INSERT INTO tasks (id, project_id, title, brief, state, kind, source, depends_on,
        verification_cmds, priority, race_id, agent_override, created_at, updated_at)
       VALUES (?,?,?,?,'queued',?,?,?,?,?,?,?,?,?)`
    ).run(
      id,
      task.project_id,
      `${task.title} (attempt ${i + 1})`,
      task.brief,
      task.kind,
      "race",
      task.depends_on?.length ? JSON.stringify(task.depends_on) : null,
      task.verification_cmds ? JSON.stringify(task.verification_cmds) : null,
      task.priority ?? "normal",
      raceId,
      agents[i],
      ts,
      ts
    );
    ids.push(id);
  }

  ids.forEach((id, i) =>
    writeEvent(db, {
      task_id: id,
      source: "director",
      type: "race_started",
      payload: { race_id: raceId, attempt: i + 1, of: n, agent: agents[i], deadline, siblings: ids.filter((x) => x !== id) },
    })
  );
  return { ok: true, race_id: raceId, task_ids: ids };
}

// One attempt per backend, alternating, starting with the project's own. With
// two attempts on a claude project that is claude vs codex — the model-diverse
// split the whole feature exists for.
function defaultAgents(config: any, n: number): string[] {
  const own = config?.agent === "codex" ? "codex" : "claude";
  const other = own === "codex" ? "claude" : "codex";
  return Array.from({ length: n }, (_, i) => (i % 2 === 0 ? own : other));
}

// A race is ready to compare once every attempt has settled, or once its
// deadline has passed (a wedged attempt must not hold the card forever).
export function raceIsSettled(db: DB, raceId: string, nowMs: number = Date.now()): boolean {
  const tasks = raceTasks(db, raceId);
  if (!tasks.length) return false;
  if (tasks.every((t) => SETTLED.includes(t.state))) return true;
  const deadline = raceDeadline(db, raceId);
  return !!deadline && nowMs >= Date.parse(deadline);
}

function attemptLine(a: RaceAttempt): string {
  const diff = a.diff
    ? `${a.diff.files} file${a.diff.files === 1 ? "" : "s"} +${a.diff.additions}/-${a.diff.deletions}`
    : "no branch yet";
  const checks = a.verification.length
    ? `${a.verification.filter((v) => v.satisfied).length}/${a.verification.length} checks`
    : "no verification contract";
  const cost = a.cost_usd > 0 ? `$${a.cost_usd.toFixed(2)}` : `${a.processed_tokens.toLocaleString()} tokens`;
  return `${a.agent}, ${a.state}, ${diff}, ${checks}, ${cost}`;
}

// Rank: every verification check passed first, then the smallest diff. A
// recommendation only — the director reads the card and decides.
function rank(a: RaceAttempt): number {
  const unmet = a.verification.filter((v) => !v.satisfied).length;
  const size = a.diff ? a.diff.additions + a.diff.deletions : Number.MAX_SAFE_INTEGER;
  return unmet * 1e9 + size;
}

export function raceDecisionOpen(db: DB, raceId: string): boolean {
  return !!db
    .query(
      `SELECT 1 FROM events WHERE type = 'race_compare' AND json_extract(payload, '$.race_id') = ? LIMIT 1`
    )
    .get(raceId);
}

// The comparison card. One option per attempt that is still keepable, so
// answering it IS picking the winner.
export async function openRaceDecision(
  db: DB,
  raceId: string,
  exec: Exec = defaultExec
): Promise<any | null> {
  if (raceDecisionOpen(db, raceId)) return null;
  const view = await raceView(db, raceId, exec);
  if (!view) return null;
  const keepable = view.attempts.filter((a) => a.state !== "cancelled");
  if (!keepable.length) return null;
  const best = [...keepable].sort((x, y) => rank(x) - rank(y))[0];
  const host = view.attempts[0].task_id;
  const { createDecision } = await import("./api.ts"); // late import: api.ts imports this module
  const decision = createDecision(db, {
    task_id: host,
    title: `Best-of-${view.attempts.length}: which attempt at "${view.attempts[0].title}" do you keep?`,
    context:
      `${view.attempts.length} agents built the same brief in their own worktrees. Keeping one cancels the rest, ` +
      `which closes their agents and leaves their branches on disk for you. Any pull request an unkept attempt ` +
      `opened stays open until you close it.\n\n` +
      keepable.map((a) => `#${a.number} — ${attemptLine(a)}`).join("\n"),
    risk: "normal",
    // Director-only: the point of a race is a human judgement call, so no
    // auto-answer path may settle it.
    decision_class: "race",
    options: keepable.map((a) => ({
      key: optionKey(a.task_id),
      label: `Keep #${a.number} (${a.agent})`,
      detail: attemptLine(a),
      recommended: a.task_id === best.task_id,
    })),
  });
  writeEvent(db, {
    task_id: host,
    source: "system",
    type: "race_compare",
    payload: { race_id: raceId, decision_id: decision.id, attempts: keepable.map((a) => a.task_id) },
  });
  return decision;
}

// Option keys are the attempt's task id, prefixed so the key is never mistaken
// for one of the generic approve/reject vocabularies.
export function optionKey(taskId: string): string {
  return `keep_${taskId}`;
}

export type PickResult =
  | { ok: true; winner: string; losers: string[] }
  | { ok: false; status: number; error: string };

// Keep one attempt, cancel the rest. Cancelling is the ONLY teardown here:
// hive's terminal-state hook already closes the agent session and runs the
// guarded worktree removal, and a loser's branch holds unmerged commits, so
// that guard preserves the checkout on disk on purpose.
export function pickWinner(db: DB, raceId: string, winnerId: string, source = "director"): PickResult {
  const tasks = raceTasks(db, raceId);
  if (!tasks.length) return { ok: false, status: 404, error: "race not found" };
  const winner = tasks.find((t) => t.id === winnerId);
  if (!winner) return { ok: false, status: 400, error: "winner is not an attempt in this race" };
  if (winner.state === "cancelled") return { ok: false, status: 409, error: "that attempt was already cancelled" };
  if (outcomeOf(db, winnerId)) return { ok: false, status: 409, error: "this race already has a winner" };

  const losers: string[] = [];
  for (const t of tasks) {
    if (t.id === winnerId) continue;
    // Cost is recorded BEFORE the cancel: the event is the durable record of
    // what the losing attempt spent, and usage rows are per-task forever after.
    writeEvent(db, {
      task_id: t.id,
      source,
      type: "race_lost",
      payload: {
        race_id: raceId,
        winner_task_id: winnerId,
        cost_usd: +taskSpend(db, t.id).toFixed(4),
        processed_tokens: taskProcessedTokens(db, t.id),
        branch: t.branch,
        pr_url: t.pr_url,
      },
    });
    if (!TERMINAL.includes(t.state)) {
      try {
        transition(db, t.id, "cancelled", { source, reason: `lost best-of-N race to #${winner.number}` });
      } catch (e) {
        // One stuck attempt must never block the rest of the teardown.
        console.error(`[hive] race ${raceId}: cancelling attempt ${t.id}:`, e);
      }
    }
    losers.push(t.id);
  }
  writeEvent(db, {
    task_id: winnerId,
    source,
    type: "race_won",
    payload: {
      race_id: raceId,
      losers,
      cost_usd: +taskSpend(db, winnerId).toFixed(4),
      race_cost_usd: +tasks.reduce((sum, t) => sum + taskSpend(db, t.id), 0).toFixed(4),
    },
  });
  return { ok: true, winner: winnerId, losers };
}

// Answer hook for the compare card, wired into apiAnswerDecision alongside the
// other resolvers. Returns true when this card was a race comparison.
export function resolveRaceForDecision(db: DB, decisionId: string, answerKey: string): boolean {
  const ev: any = db
    .query(
      `SELECT json_extract(payload, '$.race_id') AS race_id FROM events
        WHERE type = 'race_compare' AND json_extract(payload, '$.decision_id') = ? LIMIT 1`
    )
    .get(decisionId);
  if (!ev?.race_id) return false;
  const winnerId = String(answerKey).replace(/^keep_/, "");
  const r = pickWinner(db, String(ev.race_id), winnerId);
  if (!r.ok) console.error(`[hive] race ${ev.race_id}: pick winner failed: ${r.error}`);
  return true;
}

// Reconciler sweep: open the compare card for every race that has finished.
export async function raceSweep(db: DB, opts: { exec?: Exec; nowMs?: number } = {}): Promise<number> {
  const rows = db
    .query("SELECT DISTINCT race_id FROM tasks WHERE race_id IS NOT NULL")
    .all() as { race_id: string }[];
  let opened = 0;
  for (const { race_id } of rows) {
    if (raceDecisionOpen(db, race_id)) continue;
    if (!raceIsSettled(db, race_id, opts.nowMs ?? Date.now())) continue;
    try {
      if (await openRaceDecision(db, race_id, opts.exec ?? defaultExec)) opened++;
    } catch (e) {
      console.error(`[hive] race sweep ${race_id}:`, e); // isolated; never stop the sweep
    }
  }
  return opened;
}
