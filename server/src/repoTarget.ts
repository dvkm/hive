// Target-repo sanity check for task creation (#989).
//
// The failure this exists for: a parent task spawned a child whose brief edits
// `server/src/intake/jira.ts` (a HIVE file) but passed --project for another project,
// because the SUBJECT (a Jira integration) belongs to that other project while the CODE
// belongs to hive. Hive dispatched that other project's worktree and the child agent was
// asked to edit a repo it could not reach. The worktree boundary held, but only
// after a full spawn and a human cancelling it.
//
// So: at create time, pull repo-relative source paths out of the brief and ask
// whether they exist in the project that was actually chosen. If none do, and
// some exist in another project's repo, that is a strong mismatch — surface it
// and hold dispatch until the director answers. Never auto-switch the project:
// choosing the repo silently is the bug, in either direction.
import { statSync } from "node:fs";
import { join } from "node:path";
import type { DB } from "./db.ts";
import { getTask, transition, canTransition, writeEvent } from "./state.ts";
import { createDecision } from "./api.ts";

// A repo-relative path: at least one directory segment, then a filename with a
// known source extension. The leading lookbehind rejects absolute/home paths
// (/Users/... , ~/projects/...) — those aren't repo-relative and resolving them
// against a repo_path is meaningless.
// ponytail: extension-anchored only. The brief also floated "paths starting
// with a known top-level dir", but a bare dir like `web/src` exists in several
// repos and buys false positives for no coverage of the incident. Add it if a
// real miss shows up.
const PATH_RE = /(?<![\w./~-])((?:[\w.-]+\/)+[\w.-]+\.(?:tsx?|jsx?|json|md|py|go|rs|sql|css|ya?ml))(?![\w/])/g;

// Conservative by design: false negatives are fine, false positives are not.
export function extractPaths(text: string | null | undefined): string[] {
  if (!text) return [];
  const out = new Set<string>();
  for (const m of String(text).matchAll(PATH_RE)) {
    const p = m[1];
    if (p.split("/").includes("..")) continue; // never resolve outside the repo
    out.add(p);
  }
  return [...out];
}

// Only a regular FILE counts as a hit. Directory names repeat across repos
// (`server/src`, `web/src`), so counting them would manufacture matches.
const isFile = (repo: string, p: string): boolean => {
  try {
    return statSync(join(repo, p)).isFile();
  } catch {
    return false; // missing, or unreadable
  }
};

type Repo = { id: string; name: string; repo_path: string };

export type RepoMismatch = {
  paths: string[]; // the extracted paths that matched somewhere else
  likely: { id: string; name: string };
};

// Strong mismatch = NONE of the brief's paths exist in the chosen project's
// repo, and at least one exists in some other project's repo. The project with
// the most matches wins the "likely" slot.
export function detectRepoMismatch(db: DB, projectId: string, brief: string | null | undefined): RepoMismatch | null {
  const paths = extractPaths(brief);
  if (!paths.length) return null;
  const chosen = db.query("SELECT id, name, repo_path FROM projects WHERE id = ?").get(projectId) as Repo | undefined;
  if (!chosen?.repo_path) return null; // no repo to check against
  if (paths.some((p) => isFile(chosen.repo_path, p))) return null; // brief is about this repo

  const others = db
    .query(
      `SELECT id, name, repo_path FROM projects
       WHERE id != ? AND repo_path IS NOT NULL AND COALESCE(json_extract(config, '$.archived'), 0) = 0`
    )
    .all(projectId) as Repo[];

  let best: { repo: Repo; hits: string[] } | null = null;
  for (const repo of others) {
    const hits = paths.filter((p) => isFile(repo.repo_path, p));
    if (hits.length && (!best || hits.length > best.hits.length)) best = { repo, hits };
  }
  if (!best) return null; // paths exist nowhere — new files, not a wrong repo
  return { paths: best.hits, likely: { id: best.repo.id, name: best.repo.name } };
}

// Run the check on a freshly created task. On a strong mismatch: write a
// visible `repo_mismatch` event and open a decision card (which is what holds
// dispatch, see dispatcher.ts). Returns the warning line for the API response,
// or null when everything looks fine.
export function noteRepoMismatch(db: DB, task: any): string | null {
  if (!task || task.state !== "queued") return null; // cancelled/merged: nothing to dispatch
  if (task.source === "external") return null; // tracking-only mirror, never dispatched
  const m = detectRepoMismatch(db, task.project_id, task.brief);
  if (!m) return null;

  const chosen = db.query("SELECT name FROM projects WHERE id = ?").get(task.project_id) as { name: string } | undefined;
  const shown = m.paths.slice(0, 3).join(", ") + (m.paths.length > 3 ? `, +${m.paths.length - 3} more` : "");
  const note =
    `Brief targets files that exist in project "${m.likely.name}" but not in "${chosen?.name ?? task.project_id}": ${shown}. ` +
    `Dispatch is held until you confirm the target repo.`;

  const decision = createDecision(db, {
    task_id: task.id,
    title: `Wrong target repo? "${task.title}" was filed under ${chosen?.name ?? task.project_id}`,
    context:
      `The brief names ${shown}. Those files do not exist in ${chosen?.name ?? task.project_id}'s repo, ` +
      `but they do exist in ${m.likely.name}'s. An agent spawned here would be asked to edit a repo its worktree ` +
      `cannot reach. Keep it if the brief only cites those files as context; otherwise cancel and re-file it under ` +
      `${m.likely.name}. Hive will not move it for you.`,
    risk: "normal",
    blast_radius: `Task ${task.id} stays queued and undispatched until this is answered.`,
    options: [
      { key: "keep", label: `Keep it in ${chosen?.name ?? "this project"}`, detail: "The paths are context, not the work. Dispatch as filed." },
      { key: "cancel", label: `Cancel, it belongs in ${m.likely.name}`, detail: `Cancel this task so it can be re-filed under ${m.likely.name}.`, recommended: true },
    ],
  });

  writeEvent(db, {
    task_id: task.id,
    source: "system",
    type: "repo_mismatch",
    payload: { decision_id: decision.id, note, paths: m.paths, likely_project_id: m.likely.id, likely_project_name: m.likely.name },
  });
  return note;
}

// Dispatch gate: an unanswered repo_mismatch card holds the task in `queued`.
export function repoMismatchUnresolved(db: DB, taskId: string): boolean {
  return !!db
    .query(
      `SELECT 1 FROM events e JOIN decisions d ON d.id = json_extract(e.payload, '$.decision_id')
       WHERE e.task_id = ? AND e.type = 'repo_mismatch' AND d.status = 'open' LIMIT 1`
    )
    .get(taskId);
}

// Called from apiAnswerDecision. `cancel` cancels the mis-filed task so the
// director can re-file it under the right project; `keep` just closes the card
// and lets the dispatcher through. Either way hive never edits project_id —
// picking the repo silently is the bug this whole check exists for. Returns
// true if this card WAS a repo-mismatch card.
export function resolveRepoMismatchForDecision(db: DB, decisionId: string, answerKey: string): boolean {
  const ev = db
    .query("SELECT task_id FROM events WHERE type = 'repo_mismatch' AND json_extract(payload, '$.decision_id') = ? ORDER BY ts DESC LIMIT 1")
    .get(decisionId) as { task_id: string } | undefined;
  if (!ev) return false;
  if (answerKey !== "cancel") return true; // keep: nothing to do, the closed card unblocks dispatch
  const task = getTask(db, ev.task_id);
  if (task && canTransition(task.state, "cancelled"))
    transition(db, ev.task_id, "cancelled", { source: "director", reason: "filed under the wrong project" });
  return true;
}
