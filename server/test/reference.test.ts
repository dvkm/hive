// Reference facts + recurring-link auto-capture.
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "hive-ref-"));
process.env.HIVE_HOME = HOME;

const { openDb, newId, now } = await import("../src/db.ts");
const { addReference, listReferences, captureRecurringRefs, resolveRefCaptureForDecision } = await import("../src/learn.ts");
const { composeBrief } = await import("../src/briefs.ts");
import type { DB } from "../src/db.ts";

const FIGMA = "https://www.figma.com/design/Fak3K3yFak3K3yFak3K3y0/CoreData";

function freshDb(): { db: DB; projectId: string } {
  const db = openDb(":memory:");
  const projectId = newId("proj");
  db.query("INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)").run(
    projectId, "p", "/repo", "{}", now()
  );
  return { db, projectId };
}
function task(db: DB, projectId: string, title: string, brief = ""): string {
  const id = newId();
  db.query(
    "INSERT INTO tasks (id, project_id, title, brief, state, kind, created_at, updated_at) VALUES (?,?,?,?, 'queued','ship',?,?)"
  ).run(id, projectId, title, brief, now(), now());
  return id;
}
const openCards = (db: DB) => db.query("SELECT * FROM decisions WHERE status = 'open'").all() as any[];

test("addReference stores a pinned fact; the brief carries a count + recall pointer", () => {
  const { db, projectId } = freshDb();
  addReference(db, projectId, "Design file", FIGMA);
  expect(listReferences(db, projectId)).toEqual([{ title: "Design file", body: FIGMA }]);
  const id = task(db, projectId, "make market-radar match the design");
  const brief = composeBrief(db, id);
  expect(brief).toContain("hive recall"); // agents search on demand
  expect(brief).toContain("1 references");
  expect(brief).not.toContain("Design file");
  expect(brief).not.toContain(FIGMA);
  // upsert by title: no duplicate row
  addReference(db, projectId, "Design file", FIGMA + "?node-id=1");
  expect(listReferences(db, projectId)).toHaveLength(1);
});

test("reference titles and bodies stay out of the brief bulk", () => {
  const { db, projectId } = freshDb();
  const longBody = "This is a long multi-line fact.\n".repeat(20);
  addReference(db, projectId, "Deploy runbook", longBody);
  const brief = composeBrief(db, task(db, projectId, "t"));
  expect(brief).toContain("1 references");
  expect(brief).not.toContain("Deploy runbook");
  expect(brief).not.toContain("long multi-line fact");
});

test("references stay in their own store, separate from failure learnings", () => {
  const { db, projectId } = freshDb();
  const { recordSystemLearning } = require("../src/learn.ts");
  for (let i = 0; i < 15; i++) recordSystemLearning(db, projectId, `failure ${i}`, "b");
  addReference(db, projectId, "Ref A", "https://a");
  const brief = composeBrief(db, task(db, projectId, "t"));
  expect(brief).toContain("1 references");
  expect(brief).toContain("15 failure patterns");
});

test("captureRecurringRefs proposes a card for a link in >=3 tasks, once, and save stores it", () => {
  const { db, projectId } = freshDb();
  task(db, projectId, `redesign per ${FIGMA}`);
  task(db, projectId, `Forum page ${FIGMA}?node-id=458`);
  db.query("INSERT INTO events (id, task_id, ts, source, type, payload) VALUES (?,?,?,?,?,?)").run(
    newId("e"), task(db, projectId, "steered task"), now(), "director", "steer",
    JSON.stringify({ message: `also fix the header ${FIGMA}` })
  );
  captureRecurringRefs(db);
  let cards = openCards(db);
  expect(cards).toHaveLength(1);
  expect(cards[0].title).toContain(FIGMA.split("?")[0]);

  captureRecurringRefs(db); // idempotent — no second card
  expect(openCards(db)).toHaveLength(1);

  resolveRefCaptureForDecision(db, cards[0].id, "save", "CoreData design file");
  expect(listReferences(db, projectId)[0].title).toBe("CoreData design file");
  // already stored → no re-propose even after the card is answered
  db.query("UPDATE decisions SET status = 'answered' WHERE id = ?").run(cards[0].id);
  captureRecurringRefs(db);
  expect(openCards(db)).toHaveLength(0);
});

test("knowledgeSearch scopes to a project and ranks keyword matches across kinds", async () => {
  const { makeHandler } = await import("../src/api.ts");
  const { db, projectId } = freshDb();
  addReference(db, projectId, "Design file", FIGMA);
  const { recordSystemLearning } = require("../src/learn.ts");
  recordSystemLearning(db, projectId, "migration collation mismatch", "utf8mb4 vs general_ci");
  db.query("INSERT INTO policies (id, scope, title, body, active, created_at, updated_at) VALUES (?,?,?,?,1,?,?)").run(
    newId("pol"), `project:${projectId}`, "PR conventions", "PR into staging", now(), now()
  );
  const handle = makeHandler(db, {});
  const search = async (q: string) => {
    const res = await handle(new Request(`http://x/api/knowledge?project_id=${projectId}&q=${encodeURIComponent(q)}`));
    return res.json();
  };
  expect((await search("figma")).references).toHaveLength(1);
  expect((await search("migration collation")).learnings).toHaveLength(1); // both terms present
  // one right keyword + one wrong one still finds the row (no AND cliff)
  expect((await search("migration figma")).learnings).toHaveLength(1);
  expect((await search("staging")).policies).toHaveLength(1);
  // a query that hits nothing says so instead of returning bare empty arrays
  const miss = await search("kubernetes");
  expect(miss.no_matches).toBe(true);
  expect(miss.note).toContain("hive recall");
  // a query that hits something carries no miss signal
  expect((await search("figma")).no_matches).toBeUndefined();
  // task_id resolves the project
  const tid = task(db, projectId, "t");
  const byTask = await handle(new Request(`http://x/api/knowledge?task_id=${tid}&q=figma`));
  expect((await byTask.json()).references).toHaveLength(1);
});

test("knowledgeSearch ranks by how many keywords hit, and the no-q index is unfiltered", async () => {
  const { makeHandler } = await import("../src/api.ts");
  const { db, projectId } = freshDb();
  const { recordSystemLearning } = require("../src/learn.ts");
  recordSystemLearning(db, projectId, "migration collation mismatch", "utf8mb4 vs general_ci");
  recordSystemLearning(db, projectId, "migration lock timeout", "long DDL blocks writes");
  const handle = makeHandler(db, {});
  const search = async (q: string) => {
    const res = await handle(new Request(`http://x/api/knowledge?project_id=${projectId}${q ? `&q=${encodeURIComponent(q)}` : ""}`));
    return res.json();
  };
  // both rows mention "migration"; only one mentions "collation", so it ranks first
  const ranked = (await search("migration collation")).learnings;
  expect(ranked).toHaveLength(2);
  expect(ranked[0].title).toBe("migration collation mismatch");
  // no q → the whole index, no miss signal
  const all = await search("");
  expect(all.learnings).toHaveLength(2);
  expect(all.no_matches).toBeUndefined();
});

test("localhost / PR / non-doc links are not captured", () => {
  const { db, projectId } = freshDb();
  for (const u of [
    "http://localhost:5173/x",
    "https://github.com/acmecokr/monorepo/pull/20",
    "https://api-foo.test.acme.co.kr",
  ]) {
    task(db, projectId, `a ${u}`);
    task(db, projectId, `b ${u}`);
    task(db, projectId, `c ${u}`);
  }
  captureRecurringRefs(db);
  expect(openCards(db)).toHaveLength(0);
});

test("every recall is logged with its result counts, and the stats read it back", async () => {
  const { makeHandler } = await import("../src/api.ts");
  const { db, projectId } = freshDb();
  addReference(db, projectId, "Design file", FIGMA);
  const handle = makeHandler(db, {});
  const search = async (q: string) => {
    const res = await handle(new Request(`http://x/api/knowledge?project_id=${projectId}&q=${encodeURIComponent(q)}`));
    return res.json();
  };
  await search("figma");
  await search("kubernetes");
  await search("kubernetes");
  await search(""); // the "list everything" index — not a search

  const logged = db.query("SELECT q, n_references FROM recall_log ORDER BY rowid").all() as any[];
  expect(logged.map((r) => r.q)).toEqual(["figma", "kubernetes", "kubernetes", ""]);
  expect(logged[0].n_references).toBe(1);
  expect(logged[1].n_references).toBe(0);

  const res = await handle(new Request(`http://x/api/knowledge/stats?project_id=${projectId}`));
  const stats = await res.json();
  expect(stats.queries).toBe(3); // the empty-q index listing is excluded
  expect(stats.zero_result_queries).toBe(2);
  expect(stats.zero_result_share).toBeCloseTo(2 / 3);
  expect(stats.top_zero_result_queries).toEqual([{ q: "kubernetes", count: 2 }]);
});
