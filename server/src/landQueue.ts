// Dependency-aware land queue (task #1257).
//
// The director marks a set of in-review tasks "approved to land"; hive merges
// them in graph order instead of the director hand-ordering PRs. Two kinds of
// edge decide that order, both recomputed live (never stored):
//
//   depends  — task B declares A in depends_on, or its brief says "lands after
//              #A" / "depends on #A". A hard ordering: B waits until A merged.
//   conflict — two branches touch the SAME file. Nothing declares this; it is
//              inferred from `git diff --name-only base...branch` (the same
//              authoredFiles the rebase guard uses). Landing both back to back
//              would leave the second branch conflicting with the new base, so
//              only ONE of a conflicting pair lands per sweep; the other waits
//              for its agent to rebase.
//
// Everything else lands in the same sweep — independent PRs never queue behind
// each other. `from` lands BEFORE `to` on every edge.
import type { DB } from "./db.ts";
import { now } from "./db.ts";
import { getTask, writeEvent } from "./state.ts";
import { authoredFiles } from "./rebaseGuard.ts";
import { defaultExec, projectComparisonBase, type Exec } from "./exec.ts";
import { enqueue } from "./notifications.ts";

export interface LandNode {
  id: string;
  number: number;
  project_number: number | null;
  title: string;
  state: string;
  branch: string | null;
  ci_status: string | null;
  land_queued_at: string | null;
}

export interface LandEdge {
  from: string; // lands first
  to: string; // lands after `from`
  kind: "depends" | "conflict";
  files?: string[]; // conflict edges: the overlapping files (capped)
}

export interface LandGraph {
  nodes: LandNode[];
  edges: LandEdge[];
}

const MERGED_STATES = ["verifying", "done"];

// "lands after #12" / "land after #12" / "depends on #12" in a brief. The
// director's ordering notes are prose today (the 832 → 823 → 825 batch), so
// read the obvious phrasings rather than demanding the depends_on field.
const BRIEF_DEP_RE = /(?:lands?\s+after|depends\s+on)\s+#(\d+)/gi;

function briefDepNumbers(brief: string | null): number[] {
  if (!brief) return [];
  return [...brief.matchAll(BRIEF_DEP_RE)].map((m) => Number(m[1]));
}

function addEdge(edges: LandEdge[], e: LandEdge): void {
  if (e.from === e.to) return;
  if (edges.some((x) => x.from === e.from && x.to === e.to && x.kind === e.kind)) return;
  edges.push(e);
}

// The land graph for one project's review column. Git is only read for the
// conflict edges, once per branch (not per pair). Any git failure means "can't
// tell" — that branch simply gets no conflict edges, never a blocked merge.
export async function landGraph(db: DB, projectId: string, exec: Exec = defaultExec): Promise<LandGraph> {
  const nodes = db
    .query(
      `SELECT id, number, project_number, title, state, branch, ci_status, land_queued_at
         FROM tasks WHERE project_id = ? AND state = 'in_review' ORDER BY number`
    )
    .all(projectId) as LandNode[];
  const edges: LandEdge[] = [];
  if (nodes.length < 2) return { nodes, edges };

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const byNumber = new Map<number, LandNode>();
  for (const n of nodes) {
    byNumber.set(n.number, n);
    if (n.project_number != null && !byNumber.has(n.project_number)) byNumber.set(n.project_number, n);
  }

  for (const n of nodes) {
    const row = getTask(db, n.id);
    for (const dep of row?.depends_on ?? []) if (byId.has(dep)) addEdge(edges, { from: dep, to: n.id, kind: "depends" });
    for (const num of briefDepNumbers(row?.brief ?? null)) {
      const dep = byNumber.get(num);
      if (dep) addEdge(edges, { from: dep.id, to: n.id, kind: "depends" });
    }
  }

  const project: any = db.query("SELECT repo_path, config FROM projects WHERE id = ?").get(projectId);
  if (project?.repo_path) {
    const base = projectComparisonBase(JSON.parse(project.config ?? "{}"));
    const files = new Map<string, Set<string>>();
    for (const n of nodes) {
      if (!n.branch) continue;
      const f = await authoredFiles(exec, project.repo_path, base, n.branch);
      if (f?.length) files.set(n.id, new Set(f));
    }
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = files.get(nodes[i].id);
        const b = files.get(nodes[j].id);
        if (!a || !b) continue;
        const shared = [...a].filter((f) => b.has(f));
        // The lower task number lands first — a stable order, so the same pair
        // resolves the same way every sweep.
        if (shared.length) addEdge(edges, { from: nodes[i].id, to: nodes[j].id, kind: "conflict", files: shared.slice(0, 5) });
      }
    }
  }
  return { nodes, edges };
}

// Mark / unmark tasks as approved-to-land. Returns the ids actually changed.
export function markLand(db: DB, ids: string[], queued: boolean): string[] {
  const changed: string[] = [];
  for (const id of ids) {
    const task = getTask(db, id);
    if (!task) continue;
    if (queued && task.state !== "in_review") continue;
    db.query("UPDATE tasks SET land_queued_at = ?, updated_at = ? WHERE id = ?").run(queued ? now() : null, now(), id);
    writeEvent(db, { task_id: id, source: "director", type: queued ? "land_queued" : "land_unqueued", payload: {} });
    changed.push(id);
  }
  return changed;
}

export interface LandDeps {
  exec?: Exec;
  // Injected so the sweep is testable without gh/git. Defaults to POST /merge's
  // own mergeTask, so the queue lands PRs exactly the way the review click does.
  merge?: (taskId: string) => Promise<{ ok: boolean; reason?: string }>;
}

async function defaultMerge(db: DB, taskId: string, exec: Exec): Promise<{ ok: boolean; reason?: string }> {
  const { mergeTask } = await import("./api.ts");
  const { herdr: defaultHerdr } = await import("./runtime/herdr.ts");
  const res = await mergeTask(db, defaultHerdr, taskId, {}, { exec });
  if (res.status === 200) return { ok: true };
  let reason = `merge failed (${res.status})`;
  try {
    reason = ((await res.clone().json()) as any)?.error ?? reason;
  } catch {}
  return { ok: false, reason };
}

// One sweep of the land queue for every project that has one. Lands everything
// whose edges are satisfied, skips the rest for the next sweep, and drops a
// task that actually failed to merge out of the queue (so a broken PR is not
// retried every 30s) with ONE notification naming what stopped.
export async function landOnce(db: DB, deps: LandDeps = {}): Promise<void> {
  const exec = deps.exec ?? defaultExec;
  const merge = deps.merge ?? ((id: string) => defaultMerge(db, id, exec));

  // The mark means "land THIS diff". A task that left review (changes
  // requested, bounced by a conflict) needs a fresh approval.
  db.query("UPDATE tasks SET land_queued_at = NULL WHERE land_queued_at IS NOT NULL AND state != 'in_review'").run();

  const projects = db
    .query("SELECT DISTINCT project_id FROM tasks WHERE land_queued_at IS NOT NULL AND state = 'in_review'")
    .all() as { project_id: string }[];

  for (const { project_id } of projects) {
    const { nodes, edges } = await landGraph(db, project_id, exec);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const landed = new Set<string>();
    const pending = new Set(nodes.filter((n) => n.land_queued_at).map((n) => n.id));
    const failed: { node: LandNode; reason: string }[] = [];

    while (pending.size) {
      const batch: LandNode[] = [];
      const selected = new Set<string>();
      for (const n of nodes.filter((x) => pending.has(x.id)).sort((a, b) => a.number - b.number)) {
        // Red or still-running CI holds only this node. Independent nodes can
        // still enter the same concurrent batch.
        if (n.ci_status === "failing" || n.ci_status === "pending") continue;
        const waiting = edges.some((e) => {
          if (e.to !== n.id) return false;
          if (e.kind === "depends")
            return !landed.has(e.from) && !MERGED_STATES.includes(byId.get(e.from)?.state ?? "");
          return landed.has(e.from) || selected.has(e.from);
        });
        if (waiting) continue;
        batch.push(n);
        selected.add(n.id);
      }
      if (!batch.length) break;

      const results = await Promise.all(batch.map(async (node) => ({ node, result: await merge(node.id) })));
      for (const { node, result } of results) {
        pending.delete(node.id);
        if (result.ok) landed.add(node.id);
        else failed.push({ node, reason: result.reason ?? "merge failed" });
        db.query("UPDATE tasks SET land_queued_at = NULL WHERE id = ?").run(node.id);
        writeEvent(db, { task_id: node.id, source: "reconciler", type: "land_attempted", payload: { ok: result.ok, reason: result.reason } });
      }
    }

    if (landed.size)
      enqueue(db, {
        kind: "auto_merged",
        title: `Landed ${landed.size} PR${landed.size === 1 ? "" : "s"} from the land queue`,
        body: [...landed].map((id) => `#${byId.get(id)?.number}`).join(", "),
      });
    if (failed.length) {
      const { createDecision } = await import("./api.ts");
      createDecision(db, {
        task_id: failed[0].node.id,
        title: `${failed.length} PR${failed.length === 1 ? "" : "s"} paused in the land queue`,
        context: failed.map((f) => `#${f.node.number}: ${f.reason.slice(0, 120)}`).join("\n"),
        options: [
          { key: "fix", label: "Fix and requeue", detail: "Resolve the failure, then mark the PR to land again.", recommended: true },
          { key: "leave", label: "Leave paused", detail: "Keep the failed PR out of the land queue." },
        ],
      });
    }
  }
}
