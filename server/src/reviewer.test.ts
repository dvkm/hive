// The TypeSafe (Jev) pre-judgment in front of the per-finding opus run.
// Shadow mode records it beside the opus verdict; enforce mode may decide the
// easy findings on its own. The rest of the reviewer is covered by
// server/test/reviewer.test.ts.
import { test, expect, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "hive-reviewer-typesafe-"));
process.env.HIVE_HOME = HOME;

const { openDb, newId, now } = await import("./db.ts");
const { verifyRisks } = await import("./reviewer.ts");
const { transition } = await import("./state.ts");
import type { DB } from "./db.ts";
import type { Judgment } from "./typesafe.ts";

function seed(): { db: DB; task: any } {
  const db = openDb(":memory:");
  const pid = newId("proj");
  const t = now();
  db.query("INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)").run(pid, "p", "/repo", "{}", t);
  const id = newId();
  db.query(
    "INSERT INTO tasks (id, project_id, title, brief, state, kind, branch, pr_url, created_at, updated_at) VALUES (?,?,?,?,'queued','ship',?,?,?,?)"
  ).run(id, pid, "add feature", "make it work", "b1", "https://gh/pr/1", t, t);
  transition(db, id, "in_progress");
  transition(db, id, "in_review");
  return { db, task: db.query("SELECT * FROM tasks WHERE id = ?").get(id) };
}

// A model runner that answers every risk 'confirmed' and every question
// 'machine', so anything the pre-judgment decided instead is obvious.
function fakeExec() {
  const calls: string[][] = [];
  const exec = async (argv: string[]) => {
    calls.push(argv);
    const prompt = argv.join(" ");
    const body = prompt.includes("asked ONE question")
      ? '{"answerable":"machine","answer":"read the code"}'
      : '{"verdict":"confirmed","why":"opus said so"}';
    return { code: 0, stdout: JSON.stringify({ result: body }), stderr: "" };
  };
  return { exec, calls };
}

const judgeWith = (noul: number | null) =>
  (async (_state: unknown, questions: Record<string, unknown>): Promise<Judgment | null> =>
    noul === null
      ? null
      : {
          model: "jev-1",
          answers: Object.fromEntries(Object.keys(questions).map((k) => [k, { type: "noul", noul }])) as any,
          usage: { input_tokens: 1, output_tokens: 1 },
          ms: 7,
        }) as any;

const verdicts = (db: DB, taskId: string) =>
  JSON.parse((db.query("SELECT payload FROM events WHERE task_id = ? AND type = 'risk_verdicts'").get(taskId) as any).payload);

const shell = async () => ({ code: 1, stdout: "", stderr: "" }); // no git log in tests

afterEach(() => {
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.HIVE_TYPESAFE_MODE;
});

test("shadow mode records the pre-judgment and still runs opus", async () => {
  process.env.TYPESAFE_API_KEY = "k"; // shadow is the default with a key
  const { db, task } = seed();
  const { exec, calls } = fakeExec();
  await verifyRisks(db, task, { risks: ["r1"], head: "h1", diff: "d" }, { exec, shellExec: shell, judge: judgeWith(0.01) });
  expect(calls).toHaveLength(1); // opus ran anyway
  const p = verdicts(db, task.id);
  expect(p.verdicts[0]).toMatchObject({ risk: "r1", verdict: "confirmed", typesafe: { p: 0.01, model: "jev-1", ms: 7 } });
});

test("enforce mode decides a near-zero risk itself and skips opus", async () => {
  process.env.TYPESAFE_API_KEY = "k";
  process.env.HIVE_TYPESAFE_MODE = "enforce";
  const { db, task } = seed();
  const { exec, calls } = fakeExec();
  await verifyRisks(db, task, { risks: ["r1"], questions: ["q1"], head: "h1", diff: "d" }, { exec, shellExec: shell, judge: judgeWith(0.01) });
  expect(calls).toHaveLength(0);
  const p = verdicts(db, task.id);
  expect(p.verdicts[0]).toMatchObject({ risk: "r1", verdict: "refuted", why: "typesafe p=0.01" });
  // A question may only be pushed TOWARDS the human: never cleared by Jev alone.
  expect(p.question_verdicts[0]).toMatchObject({ question: "q1", answerable: "human" });
  expect(p.unverified).toBeUndefined();
});

test("enforce mode leaves an unsure finding to opus", async () => {
  process.env.TYPESAFE_API_KEY = "k";
  process.env.HIVE_TYPESAFE_MODE = "enforce";
  const { db, task } = seed();
  const { exec, calls } = fakeExec();
  await verifyRisks(db, task, { risks: ["r1"], head: "h1", diff: "d" }, { exec, shellExec: shell, judge: judgeWith(0.5) });
  expect(calls).toHaveLength(1);
  expect(verdicts(db, task.id).verdicts[0]).toMatchObject({ verdict: "confirmed", why: "opus said so", typesafe: { p: 0.5 } });
});

test("a null judgment is the old behaviour", async () => {
  process.env.TYPESAFE_API_KEY = "k";
  process.env.HIVE_TYPESAFE_MODE = "enforce";
  const { db, task } = seed();
  const { exec, calls } = fakeExec();
  await verifyRisks(db, task, { risks: ["r1"], head: "h1", diff: "d" }, { exec, shellExec: shell, judge: judgeWith(null) });
  expect(calls).toHaveLength(1);
  const v = verdicts(db, task.id).verdicts[0];
  expect(v).toMatchObject({ verdict: "confirmed", why: "opus said so" });
  expect(v.typesafe).toBeUndefined();
});
