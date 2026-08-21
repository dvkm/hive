// Auto-reviewer: pre-review posted onto the review card as an auto_review event.
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "hive-reviewer-"));
process.env.HIVE_HOME = HOME;

const { openDb, newId, now } = await import("../src/db.ts");
const { autoReviewOnce, extractReview } = await import("../src/reviewer.ts");
const { transition, writeEvent } = await import("../src/state.ts");
import type { DB } from "../src/db.ts";
import type { Exec } from "../src/exec.ts";

function setup(
  config: any = {},
  extra: Partial<{ source: string; agent_target: string; pr_url: string | null; branch: string }> = {}
): { db: DB; id: string } {
  const db = openDb(":memory:");
  const pid = newId("proj");
  const t = now();
  db.query("INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)").run(
    pid, "p", "/repo", JSON.stringify(config), t
  );
  const id = newId();
  db.query(
    "INSERT INTO tasks (id, project_id, title, brief, state, kind, source, agent_target, branch, pr_url, created_at, updated_at) VALUES (?,?,?,?, 'queued','ship',?,?,?,?,?,?)"
  ).run(
    id,
    pid,
    "add feature",
    "make it work",
    extra.source ?? null,
    extra.agent_target ?? null,
    extra.branch ?? null,
    extra.pr_url === undefined ? "https://gh/pr/5" : extra.pr_url,
    t,
    t
  );
  transition(db, id, "in_progress");
  transition(db, id, "in_review");
  return { db, id };
}

const ghDiff: Exec = async (argv) =>
  argv.includes("diff")
    ? { code: 0, stdout: "--- a/x.ts\n+++ b/x.ts\n+const y = 1;", stderr: "" }
    : { code: 0, stdout: "", stderr: "" };

const events = (db: DB, id: string, type: string) =>
  db.query("SELECT * FROM events WHERE task_id = ? AND type = ?").all(id, type).map((e: any) => ({ ...e, payload: JSON.parse(e.payload) }));

test("posts a structured pre-review onto the review card, once", async () => {
  const { db, id } = setup();
  let prompts: string[] = [];
  const claude = async (argv: string[]) => {
    prompts.push(argv.join(" "));
    return { code: 0, stdout: JSON.stringify({ result: '{"verdict":"caution","summary":"adds y unused","risks":["x.ts: y is dead code"],"questions":[]}' }), stderr: "" };
  };
  await autoReviewOnce(db, { exec: claude, shellExec: ghDiff });
  const revs = events(db, id, "auto_review");
  expect(revs).toHaveLength(1);
  expect(revs[0].payload.verdict).toBe("caution");
  expect(revs[0].payload.risks[0]).toContain("dead code");
  expect(prompts[0]).toContain("add feature"); // brief made it into the prompt
  expect(prompts[0]).toContain("--model sonnet");

  await autoReviewOnce(db, { exec: claude, shellExec: ghDiff }); // no second review
  expect(events(db, id, "auto_review")).toHaveLength(1);
});

test("a branch-only review compares against the remote integration branch", async () => {
  const { db, id } = setup(
    { promote: { from: "staging", to: "main" } },
    { branch: "hive/task", pr_url: null }
  );
  const gitCalls: string[][] = [];
  const git: Exec = async (argv) => {
    gitCalls.push(argv);
    return { code: 0, stdout: "--- a/x.ts\n+++ b/x.ts\n+const y = 1;", stderr: "" };
  };
  const claude = async () => ({
    code: 0,
    stdout: JSON.stringify({ result: '{"verdict":"looks_good","summary":"fine","risks":[],"questions":[]}' }),
    stderr: "",
  });

  await autoReviewOnce(db, { exec: claude, shellExec: git });

  expect(gitCalls).toEqual([["git", "-C", "/repo", "diff", "origin/staging...hive/task"]]);
  expect(events(db, id, "auto_review")).toHaveLength(1);
});

test("reviewer failure records auto_review_error once and never blocks review", async () => {
  const { db, id } = setup();
  const claude = async () => ({ code: 1, stdout: "", stderr: "boom" });
  await autoReviewOnce(db, { exec: claude, shellExec: ghDiff });
  await autoReviewOnce(db, { exec: claude, shellExec: ghDiff });
  expect(events(db, id, "auto_review_error")).toHaveLength(1);
  expect((db.query("SELECT state FROM tasks WHERE id = ?").get(id) as any).state).toBe("in_review");
});

test("project opt-out records a skip", async () => {
  const { db, id } = setup({ auto_review: false });
  const claude = async () => { throw new Error("should not run"); };
  await autoReviewOnce(db, { exec: claude as any, shellExec: ghDiff });
  expect(events(db, id, "auto_review")[0].payload.skipped).toContain("disabled");
});

test("a never-dispatched external task in review is skipped, not auto-reviewed", async () => {
  const { db, id } = setup({}, { source: "external" });
  const claude = async () => { throw new Error("should not run"); };
  await autoReviewOnce(db, { exec: claude as any, shellExec: ghDiff });
  expect(events(db, id, "auto_review")).toHaveLength(0);
  expect(events(db, id, "auto_review_error")).toHaveLength(0);
});

test("an external task that WAS spawned before (agent_target set, real hive-driven work) is still auto-reviewed", async () => {
  const { db, id } = setup({}, { source: "external", agent_target: "t-live" });
  writeEvent(db, { task_id: id, source: "herdr", type: "spawned", payload: { agent_target: "t-live" } });
  const claude = async () => ({
    code: 0,
    stdout: JSON.stringify({ result: '{"verdict":"looks_good","summary":"fine","risks":[],"questions":[]}' }),
    stderr: "",
  });
  await autoReviewOnce(db, { exec: claude, shellExec: ghDiff });
  expect(events(db, id, "auto_review")).toHaveLength(1);
});

test("extractReview parses whole JSON, envelope, and prose-wrapped output", () => {
  const body = '{"verdict":"looks_good","summary":"fine","risks":[],"questions":[]}';
  expect(extractReview(body)?.summary).toBe("fine");
  expect(extractReview(JSON.stringify({ result: body }))?.verdict).toBe("looks_good");
  expect(extractReview(`Sure! Here you go:\n${body}\nHope that helps.`)?.summary).toBe("fine");
  expect(extractReview("no json at all")).toBeNull();
});
