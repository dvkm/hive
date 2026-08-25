import { test, expect } from "bun:test";
import { openDb, newId, now, type DB } from "../src/db.ts";
import { promoteOnce, startPromoter } from "../src/promoter.ts";
import type { Exec, ExecResult } from "../src/exec.ts";

const OK = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });

function freshDb(config: any = { promote: { from: "staging", to: "main" } }): { db: DB; projectId: string } {
  const db = openDb(":memory:");
  const projectId = newId("proj");
  db.query("INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)").run(
    projectId, "p", "/repo", JSON.stringify(config), now()
  );
  return { db, projectId };
}

// Stub git/gh: `ahead` commits, `sha` head, `openPrs` open promote PRs.
// `treeDiffers` = what `git diff --quiet` reports (1 = trees differ, 0 = identical).
function stubExec(ahead: number, sha = "abc123def", openPrs = 0, treeDiffers = true): Exec {
  return async (argv) => {
    if (argv.includes("fetch")) return OK();
    if (argv.includes("diff")) return { code: treeDiffers ? 1 : 0, stdout: "", stderr: "" };
    if (argv.includes("rev-list")) return OK(`${ahead}\n`);
    if (argv.includes("rev-parse")) return OK(`${sha}\n`);
    if (argv[0] === "gh") return OK(JSON.stringify(Array.from({ length: openPrs }, (_, i) => ({ number: i + 1 }))));
    return OK();
  };
}

const promoterTasks = (db: DB, pid: string) =>
  db.query("SELECT * FROM tasks WHERE project_id = ? AND source = 'promoter'").all(pid) as any[];

test("queues one evaluation task when `from` is ahead", async () => {
  const { db, projectId } = freshDb();
  await promoteOnce(db, { exec: stubExec(3) });
  const tasks = promoterTasks(db, projectId);
  expect(tasks.length).toBe(1);
  expect(tasks[0].state).toBe("queued");
  expect(tasks[0].kind).toBe("ship");
  expect(tasks[0].source_ref).toBe("abc123def");
  expect(tasks[0].title).toContain("staging → main");
  expect(tasks[0].brief).toContain("Do NOT merge it yourself");
  expect(tasks[0].brief).toContain("test comprehensiveness");
  expect(tasks[0].brief).toContain("BLOCKS promotion");
});

test("no task when not ahead, unconfigured, or a promote PR is already open", async () => {
  const { db, projectId } = freshDb();
  await promoteOnce(db, { exec: stubExec(0) });
  expect(promoterTasks(db, projectId).length).toBe(0);

  await promoteOnce(db, { exec: stubExec(2, "abc", 1) }); // open promote PR
  expect(promoterTasks(db, projectId).length).toBe(0);

  const plain = freshDb({}); // no config.promote
  await promoteOnce(plain.db, { exec: stubExec(5) });
  expect(promoterTasks(plain.db, plain.projectId).length).toBe(0);
});

test("no task when the trees are identical, however many commits `ahead` claims", async () => {
  const { db, projectId } = freshDb();
  await promoteOnce(db, { exec: stubExec(28, "squashed", 0, false) });
  expect(promoterTasks(db, projectId).length).toBe(0);
});

test("dedup: same head is never re-evaluated; a new head is; in-flight blocks", async () => {
  const { db, projectId } = freshDb();
  await promoteOnce(db, { exec: stubExec(2, "headAAA") });
  expect(promoterTasks(db, projectId).length).toBe(1);

  // in-flight (queued) blocks even a NEW head
  await promoteOnce(db, { exec: stubExec(3, "headBBB") });
  expect(promoterTasks(db, projectId).length).toBe(1);

  // finish the first evaluation -> same head stays deduped, new head queues
  db.query("UPDATE tasks SET state = 'done' WHERE project_id = ? AND source = 'promoter'").run(projectId);
  await promoteOnce(db, { exec: stubExec(2, "headAAA") });
  expect(promoterTasks(db, projectId).length).toBe(1);
  await promoteOnce(db, { exec: stubExec(3, "headBBB") });
  expect(promoterTasks(db, projectId).length).toBe(2);
});

test("startPromoter skips a tick while a cycle is already running", async () => {
  const { db } = freshDb();
  let active = 0;
  let maxActive = 0;
  let cycles = 0;
  // Ticks are driven by hand (setInterval is stubbed) so the overlap is exact
  // instead of racing wall-clock timers on a loaded CI box.
  let tick: () => void = () => {};
  let releaseFetch!: () => void;
  let fetchStarted!: () => void;
  let fetchFinished!: () => void;
  const blocked = new Promise<void>((resolve) => (releaseFetch = resolve));
  const started = new Promise<void>((resolve) => (fetchStarted = resolve));
  const finished = new Promise<void>((resolve) => (fetchFinished = resolve));
  // Never "ahead" -> no task ever created, so the in-flight-task dedup never
  // blocks a later tick and every tick re-runs the (slow) fetch.
  const slowExec: Exec = async (argv) => {
    if (argv.includes("fetch")) {
      cycles++;
      active++;
      maxActive = Math.max(maxActive, active);
      fetchStarted();
      await blocked;
      active--;
      fetchFinished();
      return OK();
    }
    if (argv.includes("rev-list")) return OK("0\n");
    return OK();
  };

  const origError = console.error;
  const origSetInterval = globalThis.setInterval;
  const origClearInterval = globalThis.clearInterval;
  const logs: string[] = [];
  console.error = ((...args: any[]) => logs.push(String(args[0]))) as typeof console.error;
  globalThis.setInterval = ((callback: () => void) => {
    tick = callback;
    return 1;
  }) as typeof setInterval;
  globalThis.clearInterval = (() => {}) as typeof clearInterval;
  let stop: () => void;
  try {
    stop = startPromoter(db, { exec: slowExec, intervalMs: 15 });
    tick();
    await started;
    tick(); // second tick lands mid-cycle -> must be skipped, not queued
    releaseFetch();
    await finished;
    await new Promise(setImmediate);
    stop();
  } finally {
    console.error = origError;
    globalThis.setInterval = origSetInterval;
    globalThis.clearInterval = origClearInterval;
  }

  expect(maxActive).toBe(1); // never two cycles in flight at once
  expect(cycles).toBe(1); // the overlapping tick was skipped, not queued
  expect(logs.some((m) => m.includes("skipped"))).toBe(true);
});

// Argument injection (task #1024). config.promote.{from,to} are POSITIONAL
// arguments to `git fetch origin <from> <to>`, and git reads a positional
// starting with `-` as an OPTION: `--upload-pack=<cmd>` makes git run <cmd> as
// the local user. config is caller-writable via PUT /api/projects, so the
// branch names must never reach argv unchecked. Asserts the behaviour — exec is
// never called at all — not that some regex exists.
test("a config.promote branch name starting with `-` never reaches exec (task #1024)", async () => {
  const payload = "--upload-pack=/tmp/pwn.sh";
  for (const promote of [{ from: payload, to: "main" }, { from: "staging", to: payload }]) {
    const { db, projectId } = freshDb({ promote });
    const calls: string[][] = [];
    const recording: Exec = async (argv) => {
      calls.push(argv);
      return OK("9\n");
    };
    const origError = console.error;
    console.error = (() => {}) as typeof console.error;
    try {
      await promoteOnce(db, { exec: recording });
    } finally {
      console.error = origError;
    }
    expect(calls).toEqual([]);
    expect(promoterTasks(db, projectId).length).toBe(0);
  }
});

test("ordinary branch names still promote (guard is not over-tight)", async () => {
  for (const promote of [
    { from: "staging", to: "main" },
    { from: "release/2.1", to: "main" },
    { from: "feature_x.y", to: "trunk-1" },
  ]) {
    const { db, projectId } = freshDb({ promote });
    await promoteOnce(db, { exec: stubExec(3) });
    expect(promoterTasks(db, projectId).length).toBe(1);
  }
});
