// Duplicate-task detection + merging. Ghost-task recreation and repeated asks
// produce real duplicate tasks (e.g. two "intake form" tasks). We catch them on
// creation and fold the new one into the older survivor, only bothering the
// director when the match is fuzzy (near-duplicate → a decision card).
//
// Detection keys on the existing task id/title (NOT the parallel `number`
// column another crew is adding). Two tiers:
//  - exact: normalized titles equal (trim / lowercase / collapse ws / strip
//    trailing punctuation).
//  - near: word-set Jaccard title similarity above NEAR_THRESHOLD.
import type { DB } from "./db.ts";
import { now } from "./db.ts";
import { getTask, transition, writeEvent, canTransition, repointDependents } from "./state.ts";
import { broadcastTask } from "./health.ts";
import { createDecision } from "./api.ts";

// Non-terminal states a survivor can be in. A duplicate only matters against
// live work — a done/failed/cancelled task is not something to fold into.
export const NON_TERMINAL = ["queued", "in_progress", "needs_decision", "in_review", "verifying"] as const;

// Near-duplicate threshold: fuzzy matches at/above this open a decision card.
// STRONG marks "so close we recommend merging" (drives the recommended option).
// 0.6 is deliberately conservative — the director said "only bother me when truly
// needed", so we tolerate misses over false-positive cards. Filler words shared
// across unrelated titles ("task", "fix", "add") cap most false pairs at 0.5.
// ponytail: no stopword list; raise NEAR_THRESHOLD or add one if cards get noisy.
export const NEAR_THRESHOLD = 0.6;
export const STRONG_THRESHOLD = 0.8;

// Normalize a title for exact comparison: trim, lowercase, collapse internal
// whitespace, strip trailing punctuation.
export function normalizeTitle(s: string): string {
  return (s || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[\s\p{P}]+$/u, "");
}

// Word-set Jaccard similarity of two titles: |A∩B| / |A∪B| over their word sets
// (normalized first). 1.0 = same words, 0.0 = no shared words. Pure, no deps.
export function titleSimilarity(a: string, b: string): number {
  const words = (s: string) => new Set(normalizeTitle(s).split(" ").filter(Boolean));
  const A = words(a);
  const B = words(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

export type DupMatch = { tier: "exact" | "near"; survivor: any; score: number };

// Find the best duplicate of `task` among the OTHER non-terminal tasks in the
// same project. Survivor is the OLDER task (existing tasks are older than a
// just-created one, so this naturally keeps the original). Prefers an exact
// match; otherwise the highest-scoring near match at/above NEAR_THRESHOLD.
export function detectDuplicate(db: DB, task: any): DupMatch | null {
  const rows = db
    .query(
      `SELECT * FROM tasks
       WHERE project_id = ? AND id != ? AND state IN (${NON_TERMINAL.map(() => "?").join(",")})
       ORDER BY created_at ASC`
    )
    .all(task.project_id, task.id, ...NON_TERMINAL) as any[];

  const norm = normalizeTitle(task.title);
  let best: DupMatch | null = null;
  for (const r of rows) {
    // A `[WEB-137] ...` work task carries the SAME title as the Jira mirror it
    // sits under, deliberately — that prefix is the link (HIVE-546/631). So the
    // mirror is a guaranteed exact "duplicate" of its own work, and folding
    // them would cancel the work into a tracking-only row hive never
    // dispatches, which is the opposite of what the board is for.
    if (r.id === task.jira_mirror_task_id) continue;
    if (normalizeTitle(r.title) === norm) return { tier: "exact", survivor: r, score: 1 };
    const score = titleSimilarity(task.title, r.title);
    if (score >= NEAR_THRESHOLD && (!best || score > best.score))
      best = { tier: "near", survivor: r, score };
  }
  return best;
}

// Fold `sourceId` into `targetId`: record the merge on the survivor (carrying the
// source's brief when it adds anything), mark the source with a duplicate_of
// pointer, and cancel it. Never deletes — the cancelled row + pointer preserve
// history. Throws (via transition) if the source can't be cancelled (already
// terminal), which is the intended guard for a done/cancelled task.
export function mergeInto(db: DB, sourceId: string, targetId: string, reason?: string): any {
  const source = getTask(db, sourceId);
  const target = getTask(db, targetId);
  if (!source) throw new Error("unknown source task");
  if (!target) throw new Error("unknown target task");

  // Fold the source brief onto the survivor's OWN brief, not just an event.
  // Title similarity says nothing about which row carries the content, so a
  // stub survivor can win over the real filing; without this the instructions
  // only survive in the event log, where nobody working the task reads them.
  const srcBrief = (source.brief ?? "").trim();
  const tgtBrief = (target.brief ?? "").trim();
  const adds = !!srcBrief && srcBrief !== tgtBrief && !tgtBrief.includes(srcBrief);
  const note = adds ? `Folded from duplicate ${source.id} "${source.title}":\n${srcBrief}` : undefined;
  // Empty survivor takes the brief verbatim; a survivor that already has one
  // keeps it and gets the source appended. Never overwrite, never drop.
  if (adds)
    db.query("UPDATE tasks SET brief = ?, updated_at = ? WHERE id = ?").run(
      tgtBrief ? `${tgtBrief}\n\n${note}` : srcBrief,
      now(),
      targetId
    );
  writeEvent(db, {
    task_id: targetId,
    source: "system",
    type: "duplicate_merged",
    payload: { duplicate_task_id: sourceId, title: source.title, note },
  });

  db.query("UPDATE tasks SET duplicate_of = ?, updated_at = ? WHERE id = ?").run(targetId, now(), sourceId);
  writeEvent(db, { task_id: sourceId, source: "system", type: "duplicate_merged", payload: { duplicate_of: targetId } });
  repointDependents(db, sourceId, targetId);
  const cancelled = transition(db, sourceId, "cancelled", {
    source: "system",
    reason: reason ?? `duplicate of ${targetId}`,
  });
  broadcastTask(db, getTask(db, targetId));
  return cancelled;
}

// Open a "possible duplicate" decision card on the NEW task. `merge` is
// recommended when the match is exact or a very strong near match. On answer,
// resolveDuplicateForDecision folds or keeps-separate.
export function openDuplicateDecision(db: DB, task: any, match: DupMatch): any {
  const recommendMerge = match.tier === "exact" || match.score >= STRONG_THRESHOLD;
  const pct = Math.round(match.score * 100);
  // Title similarity is the one dimension that does NOT say which row holds the
  // work. Spell out the brief asymmetry so the answer is an informed one.
  const survivorBrief = (match.survivor.brief ?? "").trim();
  const taskBrief = (task.brief ?? "").trim();
  let briefLine = "";
  if (taskBrief && !survivorBrief)
    briefLine =
      `Heads up: the existing task has no brief, and this one has ${taskBrief.length} characters of instructions. ` +
      `Merging copies them onto the existing task, so nothing is lost. `;
  else if (taskBrief && survivorBrief && taskBrief.length >= survivorBrief.length * 2)
    briefLine =
      `Heads up: this task's brief is ${taskBrief.length} characters and the existing one's is ${survivorBrief.length}. ` +
      `Merging appends this brief to it, so nothing is lost. `;
  const decision = createDecision(db, {
    task_id: task.id,
    title: `Possible duplicate of "${match.survivor.title}"`,
    context:
      `This new task looks like a duplicate of existing task ${match.survivor.id} ` +
      `"${match.survivor.title}" (${match.tier} match, ${pct}% title similarity). ` +
      briefLine +
      `Merge into it, or keep them separate?`,
    risk: "normal",
    blast_radius: `Task ${task.id} would be folded into ${match.survivor.id}.`,
    options: [
      { key: "merge", label: `Merge into "${match.survivor.title}"`, detail: "Fold this task in and cancel it as a duplicate.", recommended: recommendMerge },
      { key: "keep-separate", label: "Keep separate", detail: "They are different; keep both.", recommended: !recommendMerge },
    ],
  });
  writeEvent(db, {
    task_id: task.id,
    source: "system",
    type: "duplicate_suspected",
    payload: { decision_id: decision.id, survivor_id: match.survivor.id, tier: match.tier, score: match.score },
  });
  return decision;
}

// Called from apiAnswerDecision. If this card was a duplicate-suspected card,
// `merge` folds the new task into the survivor; anything else keeps them
// separate (event-only). Returns true if it WAS a duplicate card.
export function resolveDuplicateForDecision(db: DB, decisionId: string, answerKey: string): boolean {
  const ev = db
    .query("SELECT task_id, payload FROM events WHERE type = 'duplicate_suspected' AND json_extract(payload, '$.decision_id') = ? ORDER BY ts DESC LIMIT 1")
    .get(decisionId) as { task_id: string; payload: string } | undefined;
  if (!ev) return false;
  if (answerKey !== "merge") return true; // keep-separate: nothing to do
  const survivorId = JSON.parse(ev.payload).survivor_id;
  const source = getTask(db, ev.task_id);
  const survivor = getTask(db, survivorId);
  // Guard: never fold into a vanished/terminal survivor, and only cancel a source
  // that's still cancellable (safety: no work-in-flight gets yanked here).
  if (source && survivor && canTransition(source.state, "cancelled"))
    mergeInto(db, ev.task_id, survivorId, `duplicate of ${survivorId} (director-approved)`);
  return true;
}

// Cluster the current non-terminal tasks by duplicate similarity (union-find over
// pairs that are exact or near matches, within a project). Returns only clusters
// of size >= 2, for the /api/tasks/duplicates backfill/UI surface.
export function duplicateClusters(db: DB): { project_id: string; tasks: any[] }[] {
  const rows = db
    .query(`SELECT * FROM tasks WHERE state IN (${NON_TERMINAL.map(() => "?").join(",")}) ORDER BY created_at ASC`)
    .all(...NON_TERMINAL) as any[];

  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    return r;
  };
  for (const r of rows) parent.set(r.id, r.id);
  const unite = (a: string, b: string) => parent.set(find(a), find(b));

  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      if (rows[i].project_id !== rows[j].project_id) continue;
      const exact = normalizeTitle(rows[i].title) === normalizeTitle(rows[j].title);
      if (exact || titleSimilarity(rows[i].title, rows[j].title) >= NEAR_THRESHOLD)
        unite(rows[i].id, rows[j].id);
    }
  }

  const groups = new Map<string, any[]>();
  for (const r of rows) {
    const root = find(r.id);
    (groups.get(root) ?? groups.set(root, []).get(root)!).push({
      id: r.id, title: r.title, project_id: r.project_id, state: r.state, created_at: r.created_at,
    });
  }
  return [...groups.values()]
    .filter((g) => g.length >= 2)
    .map((g) => ({ project_id: g[0].project_id, tasks: g }));
}
