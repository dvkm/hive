// System-written learnings. Agents were told to READ learnings (briefs,
// planner) but nothing ever WROTE them automatically — every failure pattern
// had to be hand-recorded, so most weren't (2026-07-10: a 74-spawn-error
// incident produced zero learnings). Mechanical failure paths now upsert a
// learning keyed by (project, normalized signature): a recurrence bumps
// occurrences instead of duplicating, so the ledger reads "seen 74×", not 74 rows.
import type { DB } from "./db.ts";
import { now, newId } from "./db.ts";
import { broadcast } from "./bus.ts";
import { createDecision } from "./api.ts";

// Normalize a message into a stable signature: ids, hashes, paths, and numbers
// vary per occurrence; the pattern doesn't.
export function signature(text: string): string {
  return text
    .replace(/[a-f0-9]{12,}/gi, "<id>")
    .replace(/\/[^\s'"`)]+/g, "<path>")
    .replace(/\b\d+\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 110);
}

// ---- reference facts -------------------------------------------------------
// Durable project knowledge (design files, dashboards, glossary, who's who).
// Distinct from failure-learnings: pinned into every brief + planner prompt,
// never occurrence-aged. Agents write these via `hive learning add --kind
// reference`; the auto-capture below proposes them from recurring links.

export function addReference(db: DB, projectId: string, title: string, body: string | null, sourceTaskId?: string | null): string {
  const t = now();
  const existing = db
    .query("SELECT id FROM learnings WHERE project_id = ? AND kind = 'reference' AND title = ? LIMIT 1")
    .get(projectId, title) as { id: string } | undefined;
  if (existing) {
    db.query("UPDATE learnings SET body = ?, last_seen = ?, status = 'active' WHERE id = ?").run(body, t, existing.id);
    return existing.id;
  }
  const id = newId("lrn");
  db.query(
    `INSERT INTO learnings (id, project_id, title, body, source_task_id, occurrences,
      first_seen, last_seen, status, root_cause_task_id, kind)
     VALUES (?,?,?,?,?,1,?,?, 'active', NULL, 'reference')`
  ).run(id, projectId, title, body, sourceTaskId ?? null, t, t);
  broadcast({ type: "learning", learning: { id, project_id: projectId, title, body, kind: "reference" } });
  return id;
}

export function listReferences(db: DB, projectId: string): { title: string; body: string | null }[] {
  return db
    .query("SELECT title, body FROM learnings WHERE project_id = ? AND kind = 'reference' AND status = 'active' ORDER BY first_seen")
    .all(projectId) as { title: string; body: string | null }[];
}

// URLs worth remembering: docs, design, dashboards. Localhost / test hosts /
// the agent's own PR links are noise, not durable references.
const REF_URL = /https?:\/\/[^\s'")<>]+/g;
function isReferenceUrl(u: string): boolean {
  if (/localhost|127\.0\.0\.1|\.test\b|\.local\b/.test(u)) return false;
  if (/github\.com\/[^/]+\/[^/]+\/(pull|commit|blob|tree)\//.test(u)) return false; // code links churn
  return /figma\.com|docs\.google\.com|notion\.|linear\.app|\.atlassian\.|dashboard|posthog|sheets\.|drive\.google/.test(u);
}
function normalizeUrl(u: string): string {
  return u.replace(/[).,;]+$/, "").split("#")[0].split("?")[0];
}

// Auto-capture: a reference-worthy URL that appears in >=3 distinct tasks of a
// project (via steers, titles, or briefs) and isn't already stored gets ONE
// decision card proposing to save it. On approve, resolveRefCaptureForDecision
// stores it. Idempotent: an open/answered proposal or an existing reference for
// the same URL suppresses re-proposing. This is what "don't make me paste the
// Figma link a fourth time" looks like.
export function captureRecurringRefs(db: DB): void {
  const projects = db.query("SELECT id FROM projects").all() as { id: string }[];
  for (const p of projects) {
    const texts = db
      .query(
        `SELECT t.id AS task_id, t.title || ' ' || COALESCE(t.brief,'') AS txt FROM tasks t WHERE t.project_id = ?
         UNION ALL
         SELECT e.task_id, json_extract(e.payload, '$.message') FROM events e
           JOIN tasks t ON t.id = e.task_id WHERE t.project_id = ? AND e.type = 'steer'`
      )
      .all(p.id, p.id) as { task_id: string; txt: string | null }[];
    const seen = new Map<string, Set<string>>(); // url -> distinct task ids
    for (const row of texts) {
      for (const raw of row.txt?.match(REF_URL) ?? []) {
        const u = normalizeUrl(raw);
        if (!isReferenceUrl(u)) continue;
        (seen.get(u) ?? seen.set(u, new Set()).get(u)!).add(row.task_id);
      }
    }
    for (const [url, tasks] of seen) {
      if (tasks.size < 3) continue;
      const already = db
        .query("SELECT 1 FROM learnings WHERE project_id = ? AND kind = 'reference' AND body LIKE ? LIMIT 1")
        .get(p.id, `%${url}%`);
      if (already) continue;
      const proposed = db
        .query(
          "SELECT 1 FROM decisions d JOIN tasks t ON t.id = d.task_id WHERE t.project_id = ? AND d.title LIKE ? LIMIT 1"
        )
        .get(p.id, `Save recurring link%${url}%`);
      if (proposed) continue;
      const anchor = tasks.values().next().value as string;
      createDecision(db, {
        task_id: anchor,
        title: `Save recurring link as a project reference? ${url}`,
        context:
          `This URL has appeared in ${tasks.size} tasks/steers for the project but isn't a stored reference — ` +
          `so agents and the planner keep asking about it. Approving pins it into every future brief and planner ` +
          `prompt (browsable in Learnings → References). Add a one-line label in your answer note (what it is).`,
        risk: "normal",
        options: [
          { key: "save", label: "Save as reference", detail: `Store ${url} as a durable project fact.`, recommended: true },
          { key: "ignore", label: "Not worth saving", detail: "Don't propose this link again." },
        ],
      });
      writeRefCapture(db, anchor, url);
    }
  }
}

function writeRefCapture(db: DB, taskId: string, url: string): void {
  // A marker event so an 'ignore' answer can suppress re-proposing without a
  // stored reference. The decision title carries the url; this ties it to a
  // resolvable record.
  db.query(
    "INSERT INTO events (id, task_id, ts, source, type, payload) VALUES (?,?,?,?,?,?)"
  ).run(newId("evt"), taskId, now(), "system", "ref_capture_proposed", JSON.stringify({ url }));
}

// Answer hook for the auto-capture card. save → store the reference (label from
// the answer note); ignore → an 'ignored' marker suppresses re-proposal.
export function resolveRefCaptureForDecision(db: DB, decisionId: string, answerKey: string, note: string | null): boolean {
  const d: any = db.query("SELECT task_id, title FROM decisions WHERE id = ?").get(decisionId);
  if (!d || !/^Save recurring link as a project reference\?/.test(d.title)) return false;
  const url = d.title.replace(/^.*\? /, "").trim();
  const task: any = db.query("SELECT project_id FROM tasks WHERE id = ?").get(d.task_id);
  if (!task) return true;
  if (answerKey === "save") {
    const label = note?.trim() || "Recurring project link";
    addReference(db, task.project_id, label, url, d.task_id);
  } else {
    db.query("INSERT INTO events (id, task_id, ts, source, type, payload) VALUES (?,?,?,?,?,?)").run(
      newId("evt"), d.task_id, now(), "director", "ref_capture_ignored", JSON.stringify({ url })
    );
  }
  return true;
}

export function recordSystemLearning(
  db: DB,
  projectId: string,
  title: string,
  body: string | null,
  sourceTaskId?: string | null
): void {
  try {
    const t = now();
    const existing = db
      .query("SELECT id, occurrences FROM learnings WHERE project_id = ? AND title = ? LIMIT 1")
      .get(projectId, title) as { id: string; occurrences: number } | undefined;
    if (existing) {
      db.query(
        "UPDATE learnings SET occurrences = occurrences + 1, last_seen = ?, status = 'active' WHERE id = ?"
      ).run(t, existing.id);
      broadcast({ type: "learning", learning: { id: existing.id, occurrences: existing.occurrences + 1 } });
      return;
    }
    const row = {
      id: newId("lrn"),
      project_id: projectId,
      title,
      body,
      source_task_id: sourceTaskId ?? null,
      occurrences: 1,
      first_seen: t,
      last_seen: t,
      status: "active",
      root_cause_task_id: null,
    };
    db.query(
      `INSERT INTO learnings (id, project_id, title, body, source_task_id, occurrences,
        first_seen, last_seen, status, root_cause_task_id) VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run(
      row.id, row.project_id, row.title, row.body, row.source_task_id, row.occurrences,
      row.first_seen, row.last_seen, row.status, row.root_cause_task_id
    );
    broadcast({ type: "learning", learning: row });
  } catch (e) {
    // A ledger write must never break the failure path that triggered it.
    console.error("[hive] recordSystemLearning:", e);
  }
}
