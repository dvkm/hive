// Throughput: one pass reviews several tasks at once, and one task's risk and
// question checks run at once (HIVE-502). Before this the whole pipeline was
// single-threaded end to end and drained slower than the fleet filled it.
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "hive-reviewer-conc-"));
process.env.HIVE_HOME = HOME;

const { openDb, newId, now } = await import("../src/db.ts");
const { autoReviewOnce, verifyRisks } = await import("../src/reviewer.ts");
const { transition } = await import("../src/state.ts");
import type { DB } from "../src/db.ts";
import type { Exec } from "../src/exec.ts";

const CAP = 4; // REVIEW_CONCURRENCY

function seed(count: number): { db: DB; ids: string[] } {
  const db = openDb(":memory:");
  const pid = newId("proj");
  const t = now();
  db.query("INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)").run(pid, "p", "/repo", "{}", t);
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = newId();
    db.query(
      "INSERT INTO tasks (id, project_id, title, brief, state, kind, branch, pr_url, created_at, updated_at) VALUES (?,?,?,?,'queued','ship',?,?,?,?)"
    ).run(id, pid, `task ${i}`, "make it work", `b${i}`, `https://gh/pr/${i}`, t, t);
    transition(db, id, "in_progress");
    transition(db, id, "in_review");
    ids.push(id);
  }
  return { db, ids };
}

const ghDiff: Exec = async (argv) =>
  argv.includes("diff")
    ? { code: 0, stdout: "--- a/x.ts\n+++ b/x.ts\n+const y = 1;", stderr: "" }
    : { code: 0, stdout: JSON.stringify({ headRefOid: "review-head" }), stderr: "" };

// A fake model runner that records how many calls are in flight at once.
function tracker(stdout: string) {
  let inFlight = 0;
  const state = { calls: 0, peak: 0 };
  const exec = async () => {
    state.calls++;
    inFlight++;
    state.peak = Math.max(state.peak, inFlight);
    await new Promise((r) => setTimeout(r, 10));
    inFlight--;
    return { code: 0, stdout, stderr: "" };
  };
  return { exec, state };
}

test("one pass reviews up to the concurrency cap, not one task", async () => {
  const { db, ids } = seed(6);
  const { exec, state } = tracker(JSON.stringify({ result: '{"verdict":"looks_good","summary":"fine","risks":[],"questions":[]}' }));
  await autoReviewOnce(db, { exec, shellExec: ghDiff });
  expect(state.calls).toBe(CAP);
  expect(state.peak).toBeGreaterThan(1);
  const reviewed = db.query("SELECT DISTINCT task_id FROM events WHERE type = 'auto_review'").all() as any[];
  expect(reviewed).toHaveLength(CAP);
  // The two left over are picked up by the next pass, oldest first.
  await autoReviewOnce(db, { exec, shellExec: ghDiff });
  expect(db.query("SELECT DISTINCT task_id FROM events WHERE type = 'auto_review'").all()).toHaveLength(6);
  expect(ids).toHaveLength(6);
});

test("a task with fewer tasks than the cap still reviews them all", async () => {
  const { db } = seed(2);
  const { exec, state } = tracker(JSON.stringify({ result: '{"verdict":"looks_good","summary":"fine","risks":[],"questions":[]}' }));
  await autoReviewOnce(db, { exec, shellExec: ghDiff });
  expect(state.calls).toBe(2);
});

test("a task's three risk checks run concurrently", async () => {
  const { db, ids } = seed(1);
  const { exec, state } = tracker(JSON.stringify({ result: '{"verdict":"refuted","reason":"not real","evidence":"x.ts:1"}' }));
  const task: any = db.query("SELECT * FROM tasks WHERE id = ?").get(ids[0]);
  await verifyRisks(db, task, { risks: ["r1", "r2", "r3"], head: "head-1", diff: "d" }, { exec });
  expect(state.calls).toBe(3);
  expect(state.peak).toBe(3);
  const payload = JSON.parse((db.query("SELECT payload FROM events WHERE type = 'risk_verdicts'").get() as any).payload);
  // Order follows the risk list, not whichever run finished first.
  expect(payload.verdicts.map((v: any) => v.risk)).toEqual(["r1", "r2", "r3"]);
});
