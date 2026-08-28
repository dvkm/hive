import type { DB } from "./db.ts";
import { getSetting, newId, now, setSetting } from "./db.ts";
import type { Exec } from "./exec.ts";
import { projectBaseBranch } from "./exec.ts";
import { enqueue } from "./notifications.ts";
import { getTask, transition, writeEvent, TERMINAL, type State } from "./state.ts";
import { broadcastTask } from "./health.ts";
import { taskIdFromBody, taskNumberFromTitle } from "./marker.ts";

export interface PrGardenerConfig {
  enabled?: boolean;
  cadence?: string;
  land_when?: "green_and_clean";
  close_stale_after?: string;
  auto_close_superseded?: boolean;
  sensitive_paths?: string[];
  max_actions_per_sweep?: number;
  max_fix_attempts?: number;
  max_gardener_agents?: number;
  adopt_untracked?: boolean;
  adopt_skip_labels?: string[];
}

export const DEFAULT_SENSITIVE_PATHS = [
  ".github/workflows/**",
  ".env",
  "**/*.env",
  "secrets",
  "secrets/**",
  "**/secrets",
  "**/secrets/**",
];

// A PR carrying either of these labels is one a human is driving by hand.
// Hive records nothing for it and the gardener leaves it alone.
export const DEFAULT_ADOPT_SKIP_LABELS = ["no-hive", "do-not-adopt"];

export type AdoptPr = {
  number: number;
  url: string;
  title: string;
  body?: string | null;
  isDraft?: boolean;
  labels?: { name?: string }[] | null;
};

export type AdoptOutcome = "adopted" | "marked" | "tracked" | "draft" | "labelled";

// Adopt one open PR that no Hive task tracks yet.
//
// The adopted task is source='external', which is Hive's existing "record it,
// never do agent work for it" lane (supervision.ts): the dispatcher never
// spawns for it and mergeTask refuses it outright. So adoption only makes the
// PR VISIBLE — to the board, to syncPRs, and to the gardener's own classifier,
// which now finds a linked task instead of dead-ending. Landing or closing it
// still needs the director to answer a gardener decision card.
//
// Idempotent: the pr_url / source_ref lookup matches an already-adopted task in
// any state, including a cancelled one, so a PR the director dismissed is never
// resurrected on the next sweep.
export function adoptUntrackedPr(
  db: DB,
  projectId: string,
  pr: AdoptPr,
  skipLabels: string[] = DEFAULT_ADOPT_SKIP_LABELS
): { outcome: AdoptOutcome; task_id?: string } {
  // A marker means the PR claims a Hive task. linkPRs owns that link; adopting
  // would double-track it. Skip on the marker alone, even if the id resolves to
  // no local task (a marker from another Hive DB is still not ours to adopt).
  if (taskIdFromBody(pr.body) || taskNumberFromTitle(pr.title) != null) return { outcome: "marked" };
  const sourceRef = `pr-adopt:${pr.number}`;
  const existing: any = db
    .query("SELECT id FROM tasks WHERE project_id = ? AND (pr_url = ? OR source_ref = ?) LIMIT 1")
    .get(projectId, pr.url, sourceRef);
  if (existing) return { outcome: "tracked", task_id: existing.id };
  if (pr.isDraft) return { outcome: "draft" };
  const labels = (pr.labels ?? []).map((l) => String(l?.name ?? "").toLowerCase());
  if (skipLabels.some((name) => labels.includes(name.toLowerCase()))) return { outcome: "labelled" };

  const id = newId("tsk");
  const timestamp = now();
  db.query(
    "INSERT INTO tasks (id, project_id, title, brief, state, kind, source, source_ref, pr_url, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
  ).run(
    id,
    projectId,
    `PR #${pr.number}: ${pr.title}`,
    `Hive adopted this pull request so it stops being invisible. It was opened outside Hive, so no Hive agent wrote it and no Hive review covers it.\n\nPR: ${pr.url}\n\nHive tracks it and the PR Gardener watches it. Hive will not merge or close it on its own. Answer the gardener's card to land or close it.`,
    "queued",
    "chore",
    "external",
    sourceRef,
    pr.url,
    timestamp,
    timestamp
  );
  writeEvent(db, { task_id: id, source: "pr-gardener", type: "pr_adopted", payload: { pr_number: pr.number, pr_url: pr.url } });
  broadcastTask(db, getTask(db, id));
  return { outcome: "adopted", task_id: id };
}

// Cancel adopted tracking tasks whose PR is no longer in the open list.
export function retireAdoptedTasks(db: DB, projectId: string, openNumbers: Set<number>): number[] {
  const rows = db
    .query(`SELECT id, source_ref FROM tasks WHERE project_id = ? AND source = 'external' AND source_ref LIKE 'pr-adopt:%' AND state NOT IN ('done','failed','cancelled')`)
    .all(projectId) as { id: string; source_ref: string }[];
  const retired: string[] = [];
  for (const row of rows) {
    const number = Number(row.source_ref.slice("pr-adopt:".length));
    if (!Number.isFinite(number) || openNumbers.has(number)) continue;
    transition(db, row.id, "cancelled", { source: "pr-gardener", reason: "the adopted PR is no longer open" });
    retired.push(row.id);
  }
  return retired;
}

export type GardenerAction = "land" | "rebase" | "fix" | "close" | "decision" | "hold" | "wait";

export interface ClassifierInput {
  draft: boolean;
  mergeState: string;
  ci: "passing" | "failing" | "pending";
  stale: boolean;
  superseded: boolean;
  sensitive: boolean;
  linkedTaskState?: string | null;
  directorDeciding?: boolean;
  actionInFlight?: boolean;
  decisionOpen?: boolean;
  fixAttempts?: number;
  lastAction?: string | null;
  override?: string | null;
  maxFixAttempts?: number;
  autoCloseSuperseded?: boolean;
  // The linked task is an adoption record (a PR opened outside Hive), not work
  // a Hive agent did. Only changes the wording the director reads on the card.
  adopted?: boolean;
}

export function classifyPr(p: ClassifierInput): { action: GardenerAction; reason: string } {
  if (p.override === "hold") return { action: "hold", reason: "Held by the director" };
  if (p.actionInFlight) return { action: "wait", reason: "An action is already in flight" };
  if (p.override === "force_close") return { action: "close", reason: "Close approved by the director" };
  if (p.override === "force_land" && p.linkedTaskState === "in_review") return { action: "land", reason: "Land approved by the director" };
  // Passing an understanding quiz proves the director read the change. It is
  // never approval to ship. Leave the review card alone until they choose.
  if (p.directorDeciding) return { action: "wait", reason: "The director is still deciding whether to ship it" };
  if (p.override === "retry_fix") return { action: "fix", reason: "Another fix attempt was approved by the director" };
  if (p.sensitive) return { action: "decision", reason: "Touches a sensitive path" };
  if (p.decisionOpen) return { action: "wait", reason: "Waiting for the director's decision" };
  if (p.draft) return { action: "wait", reason: "Draft PR" };
  if (p.mergeState === "DIRTY") {
    if (p.lastAction === "rebase") return { action: "decision", reason: "Still conflicting after a rebase attempt" };
    return { action: "rebase", reason: "Conflicts with the base branch" };
  }
  if (p.ci === "failing") {
    if ((p.fixAttempts ?? 0) >= (p.maxFixAttempts ?? 2)) return { action: "decision", reason: "CI still fails after the fix limit" };
    return { action: "fix", reason: "CI is failing" };
  }
  if (p.superseded) {
    return p.autoCloseSuperseded
      ? { action: "close", reason: "Every PR patch is already on the base branch" }
      : { action: "decision", reason: "The change is already on the base branch" };
  }
  if (p.stale) return { action: "decision", reason: "Inactive past the configured stale threshold, but not proven superseded" };
  if (p.ci === "passing" && p.mergeState === "CLEAN") {
    return p.linkedTaskState === "in_review"
      ? { action: "land", reason: "Green, clean, and linked to an in-review Hive task" }
      : {
          action: "decision",
          reason: p.adopted
            ? "Green and clean, but it was opened outside Hive and no Hive review covers it"
            : "Ready to land, but not linked to an in-review Hive task",
        };
  }
  if (p.ci === "pending") return { action: "wait", reason: "Waiting for CI" };
  return { action: "decision", reason: `GitHub reports ${p.mergeState.toLowerCase()} merge state` };
}

export function matchesSensitivePath(paths: string[], patterns: string[]): boolean {
  return patterns.some((pattern) => {
    const glob = new Bun.Glob(pattern);
    return paths.some((path) => glob.match(path));
  });
}

export function durationMs(value: string | undefined, fallback: number): number {
  const match = /^(\d+)(s|m|h|d)$/.exec(value ?? "");
  if (!match) return fallback;
  return Number(match[1]) * ({ s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]!]!);
}

type GhPr = {
  number: number;
  url: string;
  title: string;
  isDraft?: boolean;
  updatedAt: string;
  mergeStateStatus?: string;
  statusCheckRollup?: any[];
  files?: { path: string }[];
};

type GardenerDeps = {
  exec: Exec;
  land: (taskId: string) => Promise<{ ok: boolean; error?: string }>;
  // True when only the director may resolve this task's review card, e.g. they
  // passed the Focus understanding quiz. A quiz pass is never approval.
  directorDeciding?: (taskId: string) => boolean;
  decide: (input: { task_id: string; title: string; context: string; options: any[] }) => { id: string };
  nowMs?: () => number;
};

function ciState(checks: any[] | undefined): "passing" | "failing" | "pending" {
  if (!checks?.length) return "pending";
  const values = checks.map((c) => String(c.conclusion ?? c.state ?? c.status ?? "").toUpperCase());
  if (values.some((v) => ["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED"].includes(v))) return "failing";
  return values.every((v) => ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(v)) ? "passing" : "pending";
}

function activeTask(db: DB, id: string | null): boolean {
  if (!id) return false;
  const task = getTask(db, id);
  return !!task && !TERMINAL.includes(task.state as State);
}

function linkedTask(db: DB, projectId: string, url: string): any | null {
  return db.query("SELECT * FROM tasks WHERE project_id = ? AND pr_url = ? ORDER BY updated_at DESC LIMIT 1").get(projectId, url) ?? null;
}

function createActionTask(db: DB, projectId: string, pr: GhPr, action: "rebase" | "fix"): any {
  const id = newId("tsk");
  const timestamp = now();
  const brief = action === "rebase"
    ? `Rebase PR #${pr.number} (${pr.url}) onto its current base branch. Merge the base into the feature branch. Resolve conflicts by preserving both intended changes. Push normally, never force push. Attach test evidence and hand the PR back for review.`
    : `Fix the non-flaky CI failures on PR #${pr.number} (${pr.url}). Reproduce the failure, make the smallest fix, push it, and attach test evidence. Do not merge or close the PR.`;
  db.query(
    "INSERT INTO tasks (id, project_id, title, brief, state, kind, source, source_ref, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
  ).run(id, projectId, `${action === "rebase" ? "Rebase" : "Fix CI for"} PR #${pr.number}: ${pr.title}`, brief, "queued", "ship", "pr-gardener", `${action}:${pr.number}:${timestamp}`, timestamp, timestamp);
  const task = getTask(db, id);
  writeEvent(db, { task_id: id, source: "pr-gardener", type: "gardener_action_dispatched", payload: { action, pr_number: pr.number, pr_url: pr.url } });
  broadcastTask(db, task);
  return task;
}

function decisionTask(db: DB, projectId: string, pr: GhPr): any {
  return linkedTask(db, projectId, pr.url) ?? (() => {
    const id = newId("tsk");
    const timestamp = now();
    db.query(
      "INSERT INTO tasks (id, project_id, title, brief, state, kind, source, source_ref, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
    ).run(id, projectId, `Review PR #${pr.number}: ${pr.title}`, `The PR Gardener needs a director decision for ${pr.url}.`, "queued", "chore", "pr-gardener-decision", `decision:${pr.number}:${timestamp}`, timestamp, timestamp);
    const task = getTask(db, id);
    broadcastTask(db, task);
    return task;
  })();
}

async function supersededOnBase(exec: Exec, cwd: string, base: string, number: number): Promise<boolean> {
  const comparison = await exec(["git", "cherry", `origin/${base}`, `refs/hive/pr-gardener/${number}`], { cwd });
  if (comparison.code !== 0) return false;
  const patches = comparison.stdout.trim().split("\n").filter(Boolean);
  return patches.length === 0 || patches.every((line) => line.startsWith("-"));
}

function saveClassification(db: DB, projectId: string, pr: GhPr, action: GardenerAction, reason: string, sensitive: boolean): void {
  db.query(`INSERT INTO pr_gardener_items (project_id, pr_number, pr_url, title, classification, reason, sensitive, updated_at)
    VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(project_id, pr_number) DO UPDATE SET
    pr_url=excluded.pr_url, title=excluded.title, classification=excluded.classification,
    reason=excluded.reason, sensitive=excluded.sensitive, updated_at=excluded.updated_at`)
    .run(projectId, pr.number, pr.url, pr.title, action, reason, sensitive ? 1 : 0, now());
}

function openDecision(db: DB, deps: GardenerDeps, projectId: string, pr: GhPr, reason: string, previous: any): string | null {
  if (previous?.decision_id) {
    const old: any = db.query("SELECT status FROM decisions WHERE id = ?").get(previous.decision_id);
    if (old) return null;
  }
  const task = decisionTask(db, projectId, pr);
  const canLand = task.pr_url === pr.url && task.state === "in_review";
  const options = [
    ...(canLand ? [{ key: "force_land", label: "Land it", description: "Run Hive's normal guarded merge path." }] : []),
    { key: "force_close", label: "Close it", description: "Close the PR with an audit comment on the next sweep." },
    ...(reason.includes("fix limit") ? [{ key: "retry_fix", label: "Try one more fix", description: "Dispatch one more focused CI fix task." }] : []),
    { key: "hold", label: "Hold", description: "Skip this PR until the hold is released." },
  ];
  const decision = deps.decide({
    task_id: task.id,
    title: `What should the PR Gardener do with #${pr.number}?`,
    context: `${reason}. PR: ${pr.url}. Recommendation: hold it unless you have verified that landing or closing is safe.`,
    options,
  });
  db.query("UPDATE pr_gardener_items SET decision_id = ? WHERE project_id = ? AND pr_number = ?").run(decision.id, projectId, pr.number);
  return decision.id;
}

export async function runPrGardener(db: DB, deps: GardenerDeps): Promise<void> {
  const projects = db.query("SELECT * FROM projects WHERE repo_path IS NOT NULL").all() as any[];
  for (const project of projects) {
    const config = JSON.parse(project.config || "{}");
    const gardener: PrGardenerConfig = config.pr_gardener ?? {};
    if (!gardener.enabled) continue;
    const clock = (deps.nowMs ?? Date.now)();
    const setting = `pr_gardener_last:${project.id}`;
    const last = Date.parse(getSetting(db, setting) ?? "");
    if (Number.isFinite(last) && clock - last < durationMs(gardener.cadence, 30 * 60_000)) continue;
    const base = projectBaseBranch(config);
    const listed = await deps.exec(["gh", "pr", "list", "--state", "open", "--base", base, "--limit", "100", "--json", "number,url,title,isDraft,updatedAt,mergeStateStatus,statusCheckRollup,files"], { cwd: project.repo_path });
    if (listed.code !== 0) throw new Error(`PR Gardener could not list ${project.name} PRs: ${listed.stderr.trim()}`);
    setSetting(db, setting, new Date(clock).toISOString());
    const prs = JSON.parse(listed.stdout || "[]") as GhPr[];
    const openNumbers = new Set(prs.map((pr) => pr.number));
    for (const row of db.query("SELECT pr_number FROM pr_gardener_items WHERE project_id = ?").all(project.id) as { pr_number: number }[]) {
      if (!openNumbers.has(row.pr_number)) db.query("DELETE FROM pr_gardener_items WHERE project_id = ? AND pr_number = ?").run(project.id, row.pr_number);
    }

    const digest = { adopted: [] as number[], landed: [] as number[], closed: [] as number[], rebased: [] as number[], fixing: [] as number[], escalated: [] as number[] };
    let actions = 0;
    const maxActions = gardener.max_actions_per_sweep ?? 5;

    // Discovery: record open PRs that no Hive task tracks yet, so PRs opened by
    // hand (or by another tool) stop being invisible to the board and to this
    // gardener. Listed WITHOUT --base on purpose: a hotfix opened straight
    // against main gets recorded too, even though the classifier below only
    // grades PRs on the configured base branch. Adoption writes one row and
    // touches no repo, so it is capped separately from the mutation budget.
    if (gardener.adopt_untracked) {
      const all = await deps.exec(
        ["gh", "pr", "list", "--state", "open", "--limit", "100", "--json", "number,url,title,body,isDraft,labels"],
        { cwd: project.repo_path }
      );
      let candidates: AdoptPr[] | null = null;
      try {
        if (all.code === 0) {
          const parsed = JSON.parse(all.stdout || "[]");
          if (Array.isArray(parsed)) candidates = parsed;
        }
      } catch {
        candidates = null; // gh gave us nothing usable; try again next sweep
      }
      if (candidates) {
        const skipLabels = gardener.adopt_skip_labels ?? DEFAULT_ADOPT_SKIP_LABELS;
        for (const candidate of candidates) {
          if (digest.adopted.length >= maxActions) break;
          if (adoptUntrackedPr(db, project.id, candidate, skipLabels).outcome === "adopted") digest.adopted.push(candidate.number);
        }
        // An adopted task is pure bookkeeping, so once its PR stops being open
        // there is nothing left to track. Close it out rather than let adoption
        // ratchet the board fuller every sweep. Only ever touches tasks this
        // code created (source_ref 'pr-adopt:<n>'), and only when gh answered.
        retireAdoptedTasks(db, project.id, new Set(candidates.map((pr) => pr.number)));
      }
    }
    const fetched = await deps.exec([
      "git",
      "fetch",
      "--quiet",
      "--no-tags",
      "origin",
      `+refs/heads/${base}:refs/remotes/origin/${base}`,
      ...prs.map((pr) => `+refs/pull/${pr.number}/head:refs/hive/pr-gardener/${pr.number}`),
    ], { cwd: project.repo_path });
    for (const pr of prs) {
      const prior: any = db.query("SELECT * FROM pr_gardener_items WHERE project_id = ? AND pr_number = ?").get(project.id, pr.number);
      if (prior?.action_task_id && !activeTask(db, prior.action_task_id)) {
        db.query("UPDATE pr_gardener_items SET action_task_id = NULL WHERE project_id = ? AND pr_number = ?").run(project.id, pr.number);
        prior.action_task_id = null;
      }
      const paths = (pr.files ?? []).map((file) => file.path);
      const sensitive = matchesSensitivePath(paths, [...DEFAULT_SENSITIVE_PATHS, ...(gardener.sensitive_paths ?? [])]);
      const stale = clock - Date.parse(pr.updatedAt) > durationMs(gardener.close_stale_after, 14 * 86_400_000);
      const superseded = fetched.code === 0 && await supersededOnBase(deps.exec, project.repo_path, base, pr.number);
      const linked = linkedTask(db, project.id, pr.url);
      const ci = ciState(pr.statusCheckRollup);
      if (ci !== "failing" && prior?.fix_attempts) prior.fix_attempts = 0;
      if (pr.mergeStateStatus !== "DIRTY" && prior?.last_action === "rebase") prior.last_action = null;
      const result = classifyPr({
        draft: !!pr.isDraft,
        mergeState: pr.mergeStateStatus ?? "UNKNOWN",
        ci,
        stale,
        superseded,
        sensitive,
        linkedTaskState: linked?.state,
        adopted: String(linked?.source_ref ?? "").startsWith("pr-adopt:"),
        directorDeciding: !!linked && !!deps.directorDeciding?.(linked.id),
        actionInFlight: activeTask(db, prior?.action_task_id),
        decisionOpen: !!prior?.decision_id,
        fixAttempts: prior?.fix_attempts,
        lastAction: prior?.last_action,
        override: prior?.override,
        maxFixAttempts: gardener.max_fix_attempts,
        autoCloseSuperseded: gardener.auto_close_superseded,
      });
      saveClassification(db, project.id, pr, result.action, result.reason, sensitive);
      if (prior) {
        db.query("UPDATE pr_gardener_items SET fix_attempts = ?, last_action = ? WHERE project_id = ? AND pr_number = ?")
          .run(prior.fix_attempts ?? 0, prior.last_action ?? null, project.id, pr.number);
      }
      if (actions >= maxActions && ["land", "close", "rebase", "fix"].includes(result.action)) continue;

      if (result.action === "land" && linked) {
        actions++;
        const landed = await deps.land(linked.id);
        if (landed.ok) {
          digest.landed.push(pr.number);
          db.query("UPDATE pr_gardener_items SET last_action = 'land', last_action_at = ?, override = NULL WHERE project_id = ? AND pr_number = ?")
            .run(now(), project.id, pr.number);
        } else {
          saveClassification(db, project.id, pr, "decision", `Hive refused to land it: ${landed.error ?? "unknown error"}`, sensitive);
          if (openDecision(db, deps, project.id, pr, `Hive refused to land it: ${landed.error ?? "unknown error"}`, prior)) digest.escalated.push(pr.number);
        }
      } else if (result.action === "close") {
        actions++;
        const comment = `Closed by Hive's PR Gardener. ${result.reason}. This action is recorded in the project digest.`;
        const closed = await deps.exec(["gh", "pr", "close", pr.url, "--comment", comment], { cwd: project.repo_path });
        if (closed.code === 0) {
          digest.closed.push(pr.number);
          db.query("UPDATE pr_gardener_items SET last_action = 'close', last_action_at = ?, override = NULL WHERE project_id = ? AND pr_number = ?")
            .run(now(), project.id, pr.number);
        } else {
          const reason = `GitHub refused to close it: ${closed.stderr.trim() || "unknown error"}`;
          saveClassification(db, project.id, pr, "decision", reason, sensitive);
          if (openDecision(db, deps, project.id, pr, reason, prior)) digest.escalated.push(pr.number);
        }
      } else if (result.action === "rebase" || result.action === "fix") {
        actions++;
        const task = createActionTask(db, project.id, pr, result.action);
        const attempts = result.action === "fix" ? Number(prior?.fix_attempts ?? 0) + 1 : Number(prior?.fix_attempts ?? 0);
        db.query("UPDATE pr_gardener_items SET action_task_id = ?, fix_attempts = ?, last_action = ?, last_action_at = ?, override = NULL WHERE project_id = ? AND pr_number = ?")
          .run(task.id, attempts, result.action, now(), project.id, pr.number);
        (result.action === "rebase" ? digest.rebased : digest.fixing).push(pr.number);
      } else if (result.action === "decision") {
        if (openDecision(db, deps, project.id, pr, result.reason, prior)) {
          digest.escalated.push(pr.number);
        }
      }
    }
    const parts = Object.entries(digest).filter(([, values]) => values.length).map(([name, values]) => `${name} #${values.join(", #")}`);
    if (parts.length) enqueue(db, { kind: "pr_gardener_digest", title: `${project.name} PR Gardener`, body: parts.join(" · "), urgency: "normal" });
  }
}

export function gardenerQueue(db: DB, projectId: string): any[] {
  return db.query(`SELECT i.*,
    (SELECT id FROM tasks WHERE project_id = i.project_id AND pr_url = i.pr_url ORDER BY updated_at DESC LIMIT 1) AS linked_task_id,
    (SELECT state FROM tasks WHERE project_id = i.project_id AND pr_url = i.pr_url ORDER BY updated_at DESC LIMIT 1) AS linked_task_state
    FROM pr_gardener_items i WHERE project_id = ? ORDER BY pr_number`).all(projectId);
}

export function setGardenerOverride(db: DB, projectId: string, prNumber: number, override: unknown): boolean {
  if (![null, "force_land", "force_close", "hold"].includes(override as any)) return false;
  const changed = db.query("UPDATE pr_gardener_items SET override = ?, updated_at = ? WHERE project_id = ? AND pr_number = ?")
    .run(override as string | null, now(), projectId, prNumber);
  return changed.changes > 0;
}

export function resolveGardenerDecision(db: DB, decisionId: string, answerKey: string): boolean {
  const item: any = db.query("SELECT * FROM pr_gardener_items WHERE decision_id = ?").get(decisionId);
  if (!item) return false;
  const override = ["force_land", "force_close", "hold"].includes(answerKey) ? answerKey : answerKey === "retry_fix" ? "retry_fix" : "hold";
  db.query("UPDATE pr_gardener_items SET override = ?, decision_id = NULL, fix_attempts = CASE WHEN ? = 'retry_fix' THEN 0 ELSE fix_attempts END, updated_at = ? WHERE project_id = ? AND pr_number = ?")
    .run(override, override, now(), item.project_id, item.pr_number);
  const decision: any = db.query("SELECT task_id FROM decisions WHERE id = ?").get(decisionId);
  const task = decision ? getTask(db, decision.task_id) : null;
  if (task?.source === "pr-gardener-decision" && task.state === "queued") transition(db, task.id, "cancelled", { source: "pr-gardener", reason: "gardener decision recorded" });
  return true;
}
