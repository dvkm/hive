// HIVE-348: merge EXECUTION is single-flight per target branch.
import { test, expect } from "bun:test";
import { openDb, newId, now, type DB } from "../src/db.ts";
import { writeEvent } from "../src/state.ts";
import { mergeTask } from "../src/api.ts";
import { landOnce, markLand } from "../src/landQueue.ts";
import { withMergeLock } from "../src/mergeLock.ts";
import { Herdr } from "../src/runtime/herdr.ts";
import type { Exec, ExecResult } from "../src/exec.ts";

const OK = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const herdr = new Herdr(async () => OK("{}"), "herdr");

test("withMergeLock runs one holder at a time, in arrival order", async () => {
  const log: string[] = [];
  const hold = (n: number, ms: number) =>
    withMergeLock("repo#main", async () => {
      log.push(`start${n}`);
      await Bun.sleep(ms);
      log.push(`end${n}`);
    });
  // The slowest arrives first: without the lock its `end` would land last.
  await Promise.all([hold(1, 20), hold(2, 5), hold(3, 1)]);
  expect(log).toEqual(["start1", "end1", "start2", "end2", "start3", "end3"]);
});

test("a rejected merge does not poison the merges queued behind it", async () => {
  const boom = withMergeLock("repo#main", async () => {
    throw new Error("merge blew up");
  });
  const after = withMergeLock("repo#main", async () => "landed");
  await expect(boom).rejects.toThrow("merge blew up");
  expect(await after).toBe("landed");
});

test("different target branches still land in parallel", async () => {
  const seen: string[] = [];
  const slow = withMergeLock("repo#main", async () => {
    await Bun.sleep(20);
    seen.push("main");
  });
  const fast = withMergeLock("repo#staging", async () => {
    seen.push("staging");
  });
  await Promise.all([slow, fast]);
  expect(seen).toEqual(["staging", "main"]);
});

// The merge gate wants a passed understanding check; these tests are about
// ordering, not the quiz, so seed a passed one.
function passQuiz(db: DB, taskId: string): void {
  const review = writeEvent(db, {
    task_id: taskId,
    source: "agent",
    type: "review_summary",
    payload: {
      understanding: {
        check: { question: "q", options: [{ key: "a", label: "a" }, { key: "b", label: "b" }], answer_key: "a" },
      },
    },
  });
  writeEvent(db, {
    task_id: taskId,
    source: "director",
    type: "understanding_quiz_passed",
    payload: { review_event_id: review.id, answer_key: "a" },
  });
}

// Two tasks in one project, merged concurrently through the real mergeTask.
// Both take the local fast-forward path, so both shell out to git against the
// same checkout — exactly the overlap that once let one merge's reset + re-merge
// write over another's.
function seedTwo(): { db: DB; a: string; b: string } {
  const db = openDb(":memory:");
  const projectId = newId("proj");
  db.query("INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)").run(
    projectId, "p", "/repo", JSON.stringify({ default_branch: "main" }), now()
  );
  const mk = (branch: string) => {
    const id = newId();
    const t = now();
    db.query(
      `INSERT INTO tasks (id, project_id, title, state, kind, branch, ci_status, created_at, updated_at)
       VALUES (?,?,?,?,'ship',?,'passing',?,?)`
    ).run(id, projectId, `task ${branch}`, "in_review", branch, t, t);
    db.query("INSERT INTO evidence (id, task_id, ts, kind, caption) VALUES (?,?,?,?,?)").run(newId(), id, t, "note", "ok");
    passQuiz(db, id);
    return id;
  };
  return { db, a: mk("feat-a"), b: mk("feat-b") };
}

// Counts how many merges are inside the git plumbing at the same moment.
function overlapExec(): { exec: Exec; maxConcurrent: () => number } {
  let inFlight = 0;
  let peak = 0;
  const exec: Exec = async (argv) => {
    const isMerge = argv.includes("merge") && argv.includes("--ff-only");
    if (isMerge) {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await Bun.sleep(10);
      inFlight--;
    }
    if (argv.includes("diff") && argv.includes("--name-only")) return OK("src/x.ts\n");
    if (argv.includes("symbolic-ref")) return OK("main\n"); // primary checkout sits on base
    if (argv.includes("rev-parse")) return OK("sha\n");
    return OK();
  };
  return { exec, maxConcurrent: () => peak };
}

test("two merges into the same branch never run at the same time", async () => {
  const { db, a, b } = seedTwo();
  const { exec, maxConcurrent } = overlapExec();
  const results = await Promise.all([
    mergeTask(db, herdr, a, {}, { exec }),
    mergeTask(db, herdr, b, {}, { exec }),
  ]);
  expect(results.map((r) => r.status)).toEqual([200, 200]);
  expect(maxConcurrent()).toBe(1);
});

test("the land queue lands its batch one PR at a time", async () => {
  const db = openDb(":memory:");
  const projectId = newId("proj");
  db.query("INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)").run(
    projectId, "p", "/repo", JSON.stringify({ default_branch: "main" }), now()
  );
  const mk = (branch: string) => {
    const id = newId();
    const t = now();
    db.query(
      `INSERT INTO tasks (id, project_id, title, state, kind, branch, ci_status, created_at, updated_at)
       VALUES (?,?,?,?,'ship',?,'passing',?,?)`
    ).run(id, projectId, branch, "in_review", branch, t, t);
    return id;
  };
  // Three branches with NO file overlap: the old code put all three in one
  // concurrent batch.
  const ids = ["a", "b", "c"].map(mk);
  markLand(db, ids, true);
  const files: Record<string, string[]> = { a: ["src/a.ts"], b: ["src/b.ts"], c: ["src/c.ts"] };
  const exec: Exec = async (argv) => OK((files[String(argv.at(-1)).split("...")[1] ?? ""] ?? []).join("\n"));

  let inFlight = 0;
  let peak = 0;
  const order: string[] = [];
  await landOnce(db, {
    exec,
    merge: async (id) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      order.push(id);
      await Bun.sleep(5);
      inFlight--;
      db.query("UPDATE tasks SET state = 'verifying' WHERE id = ?").run(id);
      return { ok: true };
    },
  });
  expect(peak).toBe(1);
  expect(order.sort()).toEqual([...ids].sort());
});

test("unmarking mid-sweep stops the merges still queued behind the one in flight", async () => {
  const db = openDb(":memory:");
  const projectId = newId("proj");
  db.query("INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)").run(
    projectId, "p", "/repo", JSON.stringify({ default_branch: "main" }), now()
  );
  const mk = (branch: string) => {
    const id = newId();
    const t = now();
    db.query(
      `INSERT INTO tasks (id, project_id, title, state, kind, branch, ci_status, created_at, updated_at)
       VALUES (?,?,?,?,'ship',?,'passing',?,?)`
    ).run(id, projectId, branch, "in_review", branch, t, t);
    return id;
  };
  const [a, b] = ["a", "b"].map(mk);
  markLand(db, [a, b], true);
  const exec: Exec = async () => OK("");
  const merged: string[] = [];
  await landOnce(db, {
    exec,
    merge: async (id) => {
      merged.push(id);
      // The director unmarks the other one while this merge is running.
      markLand(db, [id === a ? b : a], false);
      db.query("UPDATE tasks SET state = 'verifying' WHERE id = ?").run(id);
      return { ok: true };
    },
  });
  expect(merged.length).toBe(1);
});
