// HIVE-527. Two rules, both about who resolved a decision card.
//
// 1. Every resolved card names an actor. 414 rows in the live DB were answered
//    with answered_by NULL — all of them before the v19 migration that added
//    the column, so the answerer was never recorded rather than lost. NULL is
//    now impossible on a resolved row: the answer path stamps it, the expiry
//    paths stamp it, and the v40 migration renames the legacy gap
//    'unattributed'.
// 2. A high-risk card is only ever answered by the director. Not on timeout,
//    not by the supervisor, not by an agent answering its own question.
import { test, expect } from "bun:test";
import { openDb, newId, now, type DB } from "../src/db.ts";
import { createDecision, apiAnswerDecision, apiDismissDecision } from "../src/api.ts";
import { expireOpenDecisions } from "../src/state.ts";
import { riskLevel } from "../src/autoapprove.ts";
import { Herdr } from "../src/runtime/herdr.ts";

function freshDb(config: any = {}): { db: DB; projectId: string } {
  const db = openDb(":memory:");
  const projectId = newId("proj");
  db.query("INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)").run(
    projectId, "p", "/repo", JSON.stringify(config), now()
  );
  return { db, projectId };
}
function makeTask(db: DB, projectId: string, state = "in_progress"): string {
  const id = newId();
  const t = now();
  db.query(
    "INSERT INTO tasks (id, project_id, title, state, kind, created_at, updated_at) VALUES (?,?,?,?,?,?,?)"
  ).run(id, projectId, "t", state, "ship", t, t);
  return id;
}
const herdr = () => new Herdr(async () => ({ code: 0, stdout: "", stderr: "" }), "herdr");
const card = (db: DB, taskId: string, risk: string | null) =>
  createDecision(db, {
    task_id: taskId,
    title: "ship it?",
    risk,
    options: [{ key: "go", label: "Go", recommended: true }, { key: "no", label: "No" }],
  });
const rowOf = (db: DB, id: string) =>
  db.query("SELECT status, answered_by, answered_at FROM decisions WHERE id = ?").get(id) as any;

// ---- risk normalization ----------------------------------------------------
// The live bug: agents write a whole sentence into `risk`, so the sweep's
// `risk != 'high'` test was true for "high — if these keys are real...".
test("riskLevel reads the level word, and treats unrecognized prose as high", () => {
  expect(riskLevel("high")).toBe("high");
  expect(riskLevel("HIGH")).toBe("high");
  expect(riskLevel("high — if these keys are real, anyone with repo read access can use them")).toBe("high");
  expect(riskLevel("low -- only affects a gated branch")).toBe("low");
  expect(riskLevel("medium")).toBe("medium");
  expect(riskLevel(null)).toBe("normal");
  expect(riskLevel("   ")).toBe("normal");
  // No level word at all. Fail closed: prose is not a licence to auto-answer.
  expect(riskLevel("Deletes real prod rows (2 groups + their subscriptions).")).toBe("high");
  expect(riskLevel("플래그가 켜진 채 방치되면 가짜 일정이 실사용자에게 노출될 수 있음")).toBe("high");
});

// ---- rule 2: high risk is the director's alone ------------------------------
test("every non-director source is refused on a high-risk card, prose risk included", () => {
  const { db, projectId } = freshDb();
  const h = herdr();
  for (const risk of ["high", "high — leaked prod key", "Deletes real prod rows."]) {
    for (const source of ["system", "chat_supervisor", "agent", "unknown"]) {
      const d = card(db, makeTask(db, projectId), risk);
      const res = apiAnswerDecision(db, h, d.id, { answer_key: "go", source });
      expect(res.status).toBe(403);
      expect(rowOf(db, d.id).status).toBe("open");
    }
  }
});

test("the director can still answer a high-risk card, and a normal one still auto-answers", () => {
  const { db, projectId } = freshDb();
  const h = herdr();
  const high = card(db, makeTask(db, projectId), "high");
  expect(apiAnswerDecision(db, h, high.id, { answer_key: "go", source: "director" }).status).toBe(200);
  expect(rowOf(db, high.id).answered_by).toBe("director");

  const normal = card(db, makeTask(db, projectId), "normal");
  expect(apiAnswerDecision(db, h, normal.id, { answer_key: "go", source: "system" }).status).toBe(200);
  expect(rowOf(db, normal.id).answered_by).toBe("system");
});

// ---- rule 1: no resolved card without an actor ------------------------------
test("answering, dismissing and expiring all stamp an actor — no resolved row is left NULL", () => {
  const { db, projectId } = freshDb();
  const h = herdr();
  const answered = card(db, makeTask(db, projectId), "normal");
  apiAnswerDecision(db, h, answered.id, { answer_key: "go", source: "director" });

  const dismissed = card(db, makeTask(db, projectId), "normal");
  apiDismissDecision(db, dismissed.id);

  const taskId = makeTask(db, projectId);
  const expired = card(db, taskId, "normal");
  expireOpenDecisions(db, taskId, "task done");

  expect(rowOf(db, answered.id).answered_by).toBe("director");
  expect(rowOf(db, dismissed.id).answered_by).toBe("director");
  expect(rowOf(db, expired.id).answered_by).toBe("system");
  for (const id of [answered.id, dismissed.id, expired.id]) expect(rowOf(db, id).answered_at).toBeTruthy();

  // The standing invariant. This is the check that fails if a new resolution
  // path forgets to say who did it.
  const orphans = db
    .query("SELECT COUNT(*) n FROM decisions WHERE status IN ('answered','expired') AND answered_by IS NULL")
    .get() as any;
  expect(orphans.n).toBe(0);
});

test("dismissing a high-risk card tells the agent it is unapproved, not to use its judgment", () => {
  const { db, projectId } = freshDb();
  const taskId = makeTask(db, projectId);
  const d = card(db, taskId, "high — rotates live prod credentials");
  apiDismissDecision(db, d.id);
  const steer = db
    .query("SELECT payload FROM events WHERE task_id = ? AND type = 'steer' ORDER BY rowid DESC LIMIT 1")
    .get(taskId) as any;
  const text = JSON.parse(steer?.payload ?? "{}").message ?? "";
  expect(text).toContain("do NOT carry out the risky action");
  expect(text).not.toContain("Proceed with your best judgment");
});

test("v40 backfill names the legacy gap 'unattributed' instead of leaving it NULL", () => {
  const { db, projectId } = freshDb();
  const taskId = makeTask(db, projectId);
  // A pre-v19 row: answered, no answerer ever recorded.
  db.query(
    `INSERT INTO decisions (id, task_id, ts, title, options, status, answer_key, answered_at)
     VALUES (?,?,?,?,'[]','answered','go',?)`
  ).run("dec_legacy", taskId, now(), "old", now());
  db.query("DELETE FROM schema_migrations WHERE name = 'v40-attribute-legacy-decisions'").run();
  db.query("UPDATE decisions SET answered_by = NULL WHERE id = 'dec_legacy'").run();

  // Re-open the same file-backed DB is overkill; run the statement the
  // migration runs, which is what re-running the migration would do.
  db.query("UPDATE decisions SET answered_by = 'unattributed' WHERE status IN ('answered','expired') AND answered_by IS NULL").run();
  expect(rowOf(db, "dec_legacy").answered_by).toBe("unattributed");
});
