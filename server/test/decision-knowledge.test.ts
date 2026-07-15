// Resolved decision cards write their answer back into the project knowledge
// store, so the next crew consults the prior ruling instead of re-raising it.
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "hive-dk-"));
process.env.HIVE_HOME = HOME;

const { openDb, newId, now } = await import("../src/db.ts");
const { createDecision, makeHandler } = await import("../src/api.ts");
const { composeBrief } = await import("../src/briefs.ts");
import type { DB } from "../src/db.ts";

function freshDb(): { db: DB; projectId: string } {
  const db = openDb(":memory:");
  const projectId = newId("proj");
  db.query("INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)").run(
    projectId, "p", "/repo", "{}", now()
  );
  return { db, projectId };
}
function task(db: DB, projectId: string, title = "t"): string {
  const id = newId();
  db.query(
    "INSERT INTO tasks (id, project_id, title, brief, state, kind, created_at, updated_at) VALUES (?,?,?,?, 'in_progress','ship',?,?)"
  ).run(id, projectId, title, "", now(), now());
  return id;
}
const answer = (handle: any, id: string, key: string, note?: string) =>
  handle(new Request(`http://x/api/decisions/${id}/answer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ answer_key: key, answer_note: note }),
  }));

test("answering a plain question persists it as decision knowledge; recall + brief surface it", async () => {
  const { db, projectId } = freshDb();
  const handle = makeHandler(db, {});
  const tid = task(db, projectId, "build the export");
  const d = createDecision(db, {
    task_id: tid,
    title: "Which format for the data export — CSV or XLSX?",
    context: "the customer asked for a spreadsheet",
    options: [
      { key: "csv", label: "CSV", detail: "plain, universal", recommended: true },
      { key: "xlsx", label: "XLSX", detail: "native Excel" },
    ],
  });

  await answer(handle, d.id, "xlsx", "they open it in Excel, keep formatting");

  // stored under kind='decision', scoped to the project
  const rows = db.query("SELECT title, body, kind, occurrences FROM learnings WHERE project_id = ?").all(projectId) as any[];
  expect(rows).toHaveLength(1);
  expect(rows[0].kind).toBe("decision");
  expect(rows[0].body).toContain("XLSX"); // the chosen option label
  expect(rows[0].body).toContain("Excel"); // the note

  // recall finds it
  const res = await handle(new Request(`http://x/api/knowledge?project_id=${projectId}&q=export`));
  const knowledge = await res.json();
  expect(knowledge.decisions).toHaveLength(1);
  expect(knowledge.decisions[0].title).toContain("Which format");

  // the next task's brief carries it so the crew doesn't re-ask
  const brief = composeBrief(db, task(db, projectId, "add a second export button"));
  expect(brief).toContain("Decisions already made");
  expect(brief).toContain("Which format for the data export");
});

test("re-asking the same question bumps occurrences, refreshes the answer, no duplicate", async () => {
  const { db, projectId } = freshDb();
  const handle = makeHandler(db, {});
  const mk = () => createDecision(db, {
    task_id: task(db, projectId),
    title: "Deploy target — staging or prod?",
    options: [{ key: "staging", label: "Staging", recommended: true }, { key: "prod", label: "Prod" }],
  });
  await answer(handle, mk().id, "staging");
  await answer(handle, mk().id, "prod", "hotfix goes straight to prod");

  const rows = db.query("SELECT body, occurrences FROM learnings WHERE project_id = ? AND kind = 'decision'").all(projectId) as any[];
  expect(rows).toHaveLength(1);
  expect(rows[0].occurrences).toBe(2);
  expect(rows[0].body).toContain("Prod"); // latest answer wins
});

test("a resolver-claimed card (recovery) is NOT recorded as decision knowledge", async () => {
  const { db, projectId } = freshDb();
  const { openRecoveryDecision } = await import("../src/api.ts");
  const handle = makeHandler(db, {});
  const tid = task(db, projectId);
  const d = openRecoveryDecision(db, db.query("SELECT * FROM tasks WHERE id = ?").get(tid), 2);
  await answer(handle, d.id, "abandon"); // claimed by resolveRecoveryForDecision → not knowledge

  const rows = db.query("SELECT 1 FROM learnings WHERE project_id = ? AND kind = 'decision'").all(projectId);
  expect(rows).toHaveLength(0);
});
