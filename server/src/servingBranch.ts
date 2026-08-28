// The server serves from the checkout it was STARTED in (process.cwd()), which
// is not the checkout the land queue advances. Hive runs from
// ~/projects/hive-live on branch 'live'; 'main' is checked out at
// ~/projects/hive, so hive-live cannot hold main directly. On 2026-08-25 that
// gap ate two production fixes: the land-queue autonomy fix and the PR-gardener
// fix both landed on main and then sat there, unrun, until someone typed
// `git -C hive-live merge main` by hand.
//
// So: after every successful land, and once at boot, merge the base branch into
// the serving checkout. `bun --watch` hot-reloads on the resulting file change,
// so nothing has to be restarted. Only ever `git merge` — never a reset, never a
// force-push. A conflict is not something to guess at: it names the files on a
// decision card and stops auto-following until the director answers.
import { resolve } from "node:path";
import type { DB } from "./db.ts";
import { getSetting, newId, now, setSetting } from "./db.ts";
import { getTask, transition, writeEvent } from "./state.ts";
import { defaultExec, projectBaseBranch, type Exec } from "./exec.ts";

export type FollowResult =
  | { status: "skipped"; reason: string }
  | { status: "followed"; head: string }
  | { status: "conflict"; files: string[]; decision_id: string };

// Which repository a checkout belongs to. Worktrees of one repo share a common
// git dir, so this is what tells "the serving checkout is another view of THIS
// project's repo" apart from "a different project entirely".
async function repoKey(exec: Exec, cwd: string): Promise<string | null> {
  const r = await exec(["git", "rev-parse", "--git-common-dir"], { cwd });
  const out = r.stdout.trim();
  if (r.code !== 0 || !out) return null;
  return resolve(cwd, out);
}

// One open card at a time. While it is open, following is off: a second land
// must not stack the same question on the director's inbox, and must not retry
// a merge we already know conflicts.
function openConflictDecisionId(db: DB): string | null {
  const row = db
    .query(
      `SELECT d.id AS id FROM events e JOIN decisions d ON d.id = json_extract(e.payload, '$.decision_id')
        WHERE e.type = 'serving_follow_conflict' AND d.status = 'open'
        ORDER BY e.rowid DESC LIMIT 1`
    )
    .get() as { id: string } | undefined;
  return row?.id ?? null;
}

// "Leave it alone" holds only until the next server start — by then the
// director has restarted onto whatever they fixed, and a hold nobody can see is
// worse than one that expires on its own.
function heldByDirector(db: DB): boolean {
  const held = getSetting(db, "serving_follow_held_at");
  return !!held && held === getSetting(db, "server_started_at");
}

// A card needs a task to hang on. The merged task is the wrong home: it goes
// terminal moments later and terminal tasks expire their open decisions. So the
// card gets its own parked task, reused while it is still open.
function holderTask(db: DB, projectId: string, base: string): any {
  const existing: any = db
    .query("SELECT * FROM tasks WHERE project_id = ? AND source = 'serving-follow' AND state NOT IN ('done','cancelled','failed') ORDER BY created_at DESC LIMIT 1")
    .get(projectId);
  if (existing) return existing;
  const id = newId("tsk");
  const ts = now();
  db.query(
    "INSERT INTO tasks (id, project_id, title, brief, state, kind, source, source_ref, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
  ).run(
    id,
    projectId,
    "Serving checkout cannot follow " + base,
    `The running server's checkout could not merge '${base}' on its own. Until this is answered, landed changes will not reach the running server.`,
    "needs_decision",
    "chore",
    "serving-follow",
    `serving-follow:${ts}`,
    ts,
    ts
  );
  return getTask(db, id);
}

// Answering the card resumes following (the block is derived from the card
// being open) and closes the parked task, so the board does not collect one
// dangling chore per incident.
export function resolveServingFollowForDecision(db: DB, decisionId: string, answerKey: string): boolean {
  const ev = db
    .query("SELECT task_id FROM events WHERE type = 'serving_follow_conflict' AND json_extract(payload, '$.decision_id') = ? LIMIT 1")
    .get(decisionId) as { task_id: string } | undefined;
  if (!ev) return false;
  if (answerKey === "hold") setSetting(db, "serving_follow_held_at", getSetting(db, "server_started_at") ?? now());
  const task = getTask(db, ev.task_id);
  if (task && !["done", "cancelled", "failed"].includes(task.state))
    transition(db, ev.task_id, "cancelled", { source: "director", reason: "serving-branch follow card answered" });
  return true;
}

// Bring the serving checkout up to `base`. Safe to call on every land: it is a
// no-op unless the serving checkout is another branch of this project's repo.
export async function followServingBranch(
  db: DB,
  opts: { exec?: Exec; repoPath: string | null; projectId: string; base: string; taskId?: string; cwd?: string }
): Promise<FollowResult> {
  const exec = opts.exec ?? defaultExec;
  const cwd = opts.cwd ?? process.cwd();
  if (!opts.repoPath) return { status: "skipped", reason: "project has no repo_path" };
  if (openConflictDecisionId(db)) return { status: "skipped", reason: "waiting on the conflict card" };
  if (heldByDirector(db)) return { status: "skipped", reason: "held by the director until the next restart" };

  const [serving, project] = await Promise.all([repoKey(exec, cwd), repoKey(exec, opts.repoPath)]);
  if (!serving || serving !== project) return { status: "skipped", reason: "serving checkout is a different repo" };

  const head = await exec(["git", "branch", "--show-current"], { cwd });
  const branch = head.stdout.trim();
  if (head.code !== 0 || !branch) return { status: "skipped", reason: "serving checkout has no branch (detached)" };
  if (branch === opts.base) return { status: "skipped", reason: `serving checkout is already on ${opts.base}` };

  const merged = await exec(["git", "merge", opts.base, "--no-edit"], { cwd });
  if (merged.code !== 0) {
    // Read the conflicts BEFORE aborting — the abort is what erases them.
    const conflicted = await exec(["git", "diff", "--name-only", "--diff-filter=U"], { cwd });
    const files = conflicted.stdout.split("\n").map((f) => f.trim()).filter(Boolean);
    await exec(["git", "merge", "--abort"], { cwd });
    const task = holderTask(db, opts.projectId, opts.base);
    const { createDecision } = await import("./api.ts"); // lazy: api.ts imports this module
    const detail = files.length ? `Conflicting files: ${files.join(", ")}.` : merged.stderr.trim() || "git merge failed.";
    const decision = createDecision(db, {
      task_id: task.id,
      title: `Serving checkout '${branch}' cannot merge '${opts.base}'`,
      context:
        `The hive server runs from ${cwd} on branch '${branch}'. Landed work goes to '${opts.base}', so hive merges ` +
        `'${opts.base}' into '${branch}' after every land to keep the running server current. That merge just ` +
        `conflicted and was aborted; nothing was changed. ${detail} Until this is answered, changes that land will ` +
        `NOT reach the running server. Recommendation: resolve the merge by hand in ${cwd}, then choose "Fixed it".`,
      risk: "high",
      blast_radius: "Landed fixes stop reaching the running hive server until the serving checkout can follow again.",
      options: [
        { key: "resolved", label: "Fixed it — follow again", description: "You merged by hand; hive resumes following after the next land." },
        { key: "hold", label: "Leave it alone", description: "Stop following until the server is restarted; deploys stay manual." },
      ],
    });
    writeEvent(db, {
      task_id: task.id,
      source: "system",
      type: "serving_follow_conflict",
      payload: { decision_id: decision.id, cwd, branch, base: opts.base, files },
    });
    return { status: "conflict", files, decision_id: decision.id };
  }

  const sha = (await exec(["git", "rev-parse", "HEAD"], { cwd })).stdout.trim();
  if (opts.taskId)
    writeEvent(db, {
      task_id: opts.taskId,
      source: "system",
      type: "deployed",
      payload: { cwd, branch, base: opts.base, head_sha: sha, up_to_date: /already up to date/i.test(merged.stdout) },
    });
  console.log(`[hive] serving checkout ${cwd} (${branch}) follows ${opts.base} at ${sha}`);
  return { status: "followed", head: sha };
}

// Boot pass: whatever landed while the server was down still has to reach it.
// Every project is offered; the repo check keeps all but the serving one out.
export async function followServingBranchOnBoot(db: DB, exec: Exec = defaultExec): Promise<void> {
  const projects = db.query("SELECT * FROM projects WHERE repo_path IS NOT NULL").all() as any[];
  for (const project of projects) {
    const base = projectBaseBranch(JSON.parse(project.config || "{}"));
    const res = await followServingBranch(db, { exec, repoPath: project.repo_path, projectId: project.id, base });
    if (res.status !== "skipped") return; // only one checkout can be the serving one
  }
}
