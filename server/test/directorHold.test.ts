import { test, expect } from "bun:test";
import { openDb, newId, now, type DB } from "../src/db.ts";
import { writeEvent } from "../src/state.ts";
import { directorHold, sensitivePathHit, DEFAULT_SENSITIVE_PATHS } from "../src/reviewer.ts";

// The one line between hive and the director: which settled reviews wait for
// the director's own Ship, and which hive lands on its own.

function setup(config: any = { auto_merge: { kinds: ["ship", "chore"] } }): { db: DB; task: (kind?: string) => { id: string; kind: string; project_id: string } } {
  const db = openDb(":memory:");
  const projectId = newId("proj");
  db.query("INSERT INTO projects (id, name, config, created_at) VALUES (?,?,?,?)").run(projectId, "p", JSON.stringify(config), now());
  const task = (kind = "ship") => {
    const id = newId();
    db.query("INSERT INTO tasks (id, project_id, title, state, kind, created_at, updated_at) VALUES (?,?,?, 'in_review', ?, ?, ?)")
      .run(id, projectId, "t", kind, now(), now());
    return { id, kind, project_id: projectId };
  };
  return { db, task };
}

function review(db: DB, taskId: string, payload: Record<string, unknown>): void {
  writeEvent(db, { task_id: taskId, source: "system", type: "auto_review", payload: { summary: "s", risks: [], questions: [], files: [], reviewed_head_sha: "h1", ...payload } });
}

test("a clean review of a kind the project ships on its own is hive's", () => {
  const { db, task } = setup();
  const t = task();
  review(db, t.id, { verdict: "looks_good", files: ["server/src/rows.ts"] });
  expect(directorHold(db, t)).toBeNull();
});

test("a kind the project never ships alone waits, and says which kind", () => {
  const { db, task } = setup({ auto_merge: { kinds: ["chore"] } });
  const t = task("ship");
  review(db, t.id, { verdict: "looks_good" });
  expect(directorHold(db, t)).toBe("This project does not ship ship changes on its own.");
});

test("money, auth and migration code waits, camelCase file names included", () => {
  const { db, task } = setup();
  for (const [file, word] of [
    ["db/migrations/007.sql", "migration"],
    ["web/src/authGuard.ts", "auth"],
    ["server/billing/invoice.ts", "billing"],
  ]) {
    const t = task();
    review(db, t.id, { verdict: "looks_good", files: [file] });
    expect(directorHold(db, t)).toBe(`It changes ${word} code.`);
  }
  expect(sensitivePathHit(["server/src/rows.ts"], DEFAULT_SENSITIVE_PATHS)).toBeNull();
  // A project can widen the list.
  const custom = setup({ auto_merge: { kinds: ["ship"] }, understanding_checks: { sensitive_paths: ["quota"] } });
  const q = custom.task();
  review(custom.db, q.id, { verdict: "looks_good", files: ["node-server/domains/quota/service.ts"] });
  expect(directorHold(custom.db, q)).toBe("It changes quota code.");
});

test("a finding nobody refuted waits, with the finding as the reason; a refuted one does not", () => {
  const { db, task } = setup();
  const open = task();
  review(db, open.id, { verdict: "looks_good", risks: ["the cache key ignores the locale"] });
  expect(directorHold(db, open)).toBe("The reviewer raised a call only you can make: the cache key ignores the locale");

  const caution = task();
  review(db, caution.id, { verdict: "caution", questions: ["should deleted rows still count?"], risks: ["maybe a leak"] });
  expect(directorHold(db, caution)).toBe("The reviewer raised a call only you can make: should deleted rows still count?");

  const refuted = task();
  review(db, refuted.id, { verdict: "caution", risks: ["maybe a leak"], questions: ["is the flag on?"] });
  writeEvent(db, {
    task_id: refuted.id,
    source: "system",
    type: "risk_verdicts",
    payload: {
      reviewed_head_sha: "h1",
      verdicts: [{ risk: "maybe a leak", verdict: "refuted", why: "w" }],
      question_verdicts: [{ question: "is the flag on?", answerable: "machine", answer: "a" }],
    },
  });
  expect(directorHold(db, refuted)).toBeNull();
});

test("a change the director pushed back on waits; hive's own mechanical bounce does not count", () => {
  const { db, task } = setup();
  const human = task();
  review(db, human.id, { verdict: "looks_good" });
  writeEvent(db, { task_id: human.id, source: "director", type: "changes_requested", payload: { notes: "use the other endpoint" } });
  expect(directorHold(db, human)).toBe("You asked for changes on it before.");

  const bounced = task();
  review(db, bounced.id, { verdict: "looks_good" });
  writeEvent(db, { task_id: bounced.id, source: "reconciler", type: "changes_requested", payload: { notes: "hive: your PR has merge conflicts" } });
  expect(directorHold(db, bounced)).toBeNull();
});

test("an unreadable review waits, a scout's report never does, and an old director flag still holds", () => {
  const { db, task } = setup();
  const broken = task();
  review(db, broken.id, { verdict: "unparseable" });
  expect(directorHold(db, broken)).toBe("The automatic review could not read this change.");

  const scout = task("scout");
  expect(directorHold(db, scout)).toBeNull();

  const flagged = task();
  review(db, flagged.id, { verdict: "looks_good" });
  writeEvent(db, { task_id: flagged.id, source: "director", type: "understanding_required", payload: {} });
  expect(directorHold(db, flagged)).toBe("You asked to see this one before it ships.");
});
