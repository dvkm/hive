import { test, expect } from "bun:test";
import { openDb, newId, now, type DB } from "../src/db.ts";
import { sidecarOnce, __resetSidecarCursor } from "../src/sidecar.ts";
import { writeEvent } from "../src/state.ts";
import type { Exec, ExecResult } from "../src/exec.ts";

const OK = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const SHA = "a".repeat(40);

function addTask(db: DB, projectId: string): string {
  const taskId = newId();
  const t = now();
  db.query(
    `INSERT INTO tasks (id, project_id, title, brief, state, kind, agent_target, worktree_path, created_at, updated_at)
     VALUES (?,?,?,?,'in_progress','ship',?,?,?,?)`
  ).run(taskId, projectId, "t", "", "agent-1", "/wt", t, t);
  return taskId;
}

function freshDb(): { db: DB; projectId: string; taskId: string } {
  const db = openDb(":memory:");
  const projectId = newId("proj");
  db.query("INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)").run(
    projectId, "p", "/repo", "{}", now()
  );
  return { db, projectId, taskId: addTask(db, projectId) };
}

// A worktree with a tsconfig and a lint script; `results` overrides the exit
// of a named check ("tsc" / "lint").
function fakeWorld(results: Record<string, ExecResult> = {}, opts: { lintScript?: string; porcelain?: string[] } = {}) {
  const calls: string[][] = [];
  // Successive `git status --porcelain` answers; the last one repeats.
  const porcelain = opts.porcelain ?? [""];
  let statusCalls = 0;
  const exec: Exec = async (argv) => {
    calls.push(argv);
    if (argv[4] === "HEAD") return OK(`${SHA}\n`);
    if (argv.includes("--git-path")) return OK(".git/rebase-merge\n.git/rebase-apply\n.git/MERGE_HEAD\n");
    if (argv.includes("--porcelain")) return OK(porcelain[Math.min(statusCalls++, porcelain.length - 1)]);
    if (argv.includes("tsc")) return results.tsc ?? OK();
    if (argv.includes("lint")) return results.lint ?? OK();
    return OK();
  };
  return {
    calls,
    exec,
    exists: (p: string) => p.endsWith("tsconfig.json"),
    readFile: () => JSON.stringify({ scripts: { lint: opts.lintScript ?? "eslint ." } }),
  };
}

function reports(db: DB, taskId: string): any[] {
  return (db.query("SELECT payload FROM events WHERE task_id = ? AND type = 'sidecar_report' ORDER BY rowid").all(taskId) as any[])
    .map((r) => JSON.parse(r.payload));
}

test("reports the failing tools for a fresh sha, and nothing about the passing ones", async () => {
  const { db, taskId } = freshDb();
  const world = fakeWorld({ lint: { code: 1, stdout: "src/a.ts:3 no-unused-vars\nsrc/b.ts:9 semi\n", stderr: "" } });
  await sidecarOnce(db, world);

  expect(reports(db, taskId)).toEqual([
    { sha: SHA, ok: false, findings: [{ tool: "lint", summary: "src/a.ts:3 no-unused-vars | src/b.ts:9 semi" }] },
  ]);
  // Read-only: only git reads plus the two checks, all inside the worktree.
  expect(world.calls.some((c) => c.includes("tsc"))).toBe(true);
  expect(world.calls.every((c) => c[0] === "git" || c[0] === "bun")).toBe(true);
});

test("a clean worktree reports ok with no findings", async () => {
  const { db, taskId } = freshDb();
  await sidecarOnce(db, fakeWorld());
  expect(reports(db, taskId)).toEqual([{ sha: SHA, ok: true, findings: [] }]);
});

test("summaries are capped at 200 characters", async () => {
  const { db, taskId } = freshDb();
  await sidecarOnce(db, fakeWorld({ tsc: { code: 2, stdout: "x".repeat(500), stderr: "" } }));
  expect(reports(db, taskId)[0].findings[0].summary.length).toBe(200);
});

test("skips a task whose HEAD has not moved since the last report", async () => {
  const { db, taskId } = freshDb();
  writeEvent(db, { task_id: taskId, source: "sidecar", type: "sidecar_report", payload: { sha: SHA, ok: true, findings: [] } });
  const world = fakeWorld();
  await sidecarOnce(db, world);

  expect(reports(db, taskId).length).toBe(1); // still just the seeded one
  expect(world.calls.some((c) => c.includes("tsc") || c.includes("lint"))).toBe(false);
});

test("skips a worktree that is mid-rebase", async () => {
  const { db, taskId } = freshDb();
  const world = fakeWorld();
  await sidecarOnce(db, { ...world, exists: (p: string) => p.endsWith("rebase-merge") });

  expect(reports(db, taskId)).toEqual([]);
  expect(world.calls.some((c) => c.includes("tsc") || c.includes("lint"))).toBe(false);
});

test("only one sidecar run happens at a time", async () => {
  const { db, taskId } = freshDb();
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const world = fakeWorld();
  const slow: Exec = async (argv, opts) => {
    if (argv.includes("tsc")) await gate;
    return world.exec(argv, opts);
  };

  const first = sidecarOnce(db, { ...world, exec: slow });
  await sidecarOnce(db, world); // second call while the first is mid-check
  expect(reports(db, taskId)).toEqual([]); // the second one did nothing

  release();
  await first;
  expect(reports(db, taskId).length).toBe(1);
});

test("a lint script that can rewrite files is never run", async () => {
  const { db, taskId } = freshDb();
  const world = fakeWorld({}, { lintScript: "eslint . --fix" });
  await sidecarOnce(db, world);

  expect(world.calls.some((c) => c.includes("lint"))).toBe(false);
  expect(reports(db, taskId)[0].findings).toEqual([
    { tool: "lint", summary: "skipped: the lint script can write to the worktree (eslint . --fix)" },
  ]);
});

test("a check that dirties the worktree is reported, and nothing is reverted", async () => {
  const { db, taskId } = freshDb();
  const world = fakeWorld({}, { porcelain: ["", " M src/a.ts"] });
  await sidecarOnce(db, world);

  const report = reports(db, taskId)[0];
  expect(report.ok).toBe(false);
  expect(report.findings.at(-1).tool).toBe("sidecar");
  expect(report.findings.at(-1).summary).toContain("Nothing was reverted");
  // Detect and alarm only: no restore command may ever run.
  expect(world.calls.some((c) => c.includes("checkout") || c.includes("reset") || c.includes("clean"))).toBe(false);
});

test("one pass is capped at 300s total and the next pass resumes where it stopped", async () => {
  const { db, projectId, taskId } = freshDb();
  const [first, second] = [taskId, addTask(db, projectId)].sort();
  const world = fakeWorld();
  const realNow = Date.now;
  let clock = 1_000_000;
  Date.now = () => clock;
  try {
    // The first task's tsc burns the whole fleet budget by itself.
    const slow: Exec = async (argv, opts) => {
      if (argv.includes("tsc")) clock += 301_000;
      return world.exec(argv, opts);
    };
    await sidecarOnce(db, { ...world, exec: slow });
    expect(reports(db, first).length).toBe(1);
    expect(reports(db, second)).toEqual([]); // the budget ran out before reaching it

    await sidecarOnce(db, world); // next cycle picks up where this one stopped
    expect(reports(db, second).length).toBe(1);
    expect(reports(db, first).length).toBe(1); // same sha, not re-checked
  } finally {
    Date.now = realNow;
    __resetSidecarCursor();
  }
});

// ---- steering on a broken build (task HIVE-405) --------------------------
// A broken build is the one finding worth telling the agent about mid-task, and
// it is worth telling it exactly once per commit.
function steers(db: DB, taskId: string): any[] {
  return (db.query("SELECT payload FROM events WHERE task_id = ? AND type = 'steer' ORDER BY rowid").all(taskId) as any[])
    .map((r) => JSON.parse(r.payload));
}

// A second HEAD, so a pass can look at a fresh commit on the same task.
function fakeWorldAtSha(sha: string, results: Record<string, ExecResult> = {}) {
  const world = fakeWorld(results);
  const exec: Exec = async (argv, opts) => (argv[4] === "HEAD" ? OK(`${sha}\n`) : world.exec(argv, opts));
  return { ...world, exec };
}

test("a broken build queues ONE non-blocking FYI steer, and never a second one for the same sha", async () => {
  const { db, taskId } = freshDb();
  const tsc = { code: 2, stdout: "src/a.ts(3,1): error TS2345: nope\n", stderr: "" };
  await sidecarOnce(db, fakeWorld({ tsc }));

  const queued = steers(db, taskId);
  expect(queued.length).toBe(1);
  expect(queued[0].delivery).toBe("queued");
  expect(queued[0].message).toContain(`sidecar: build broken since ${SHA.slice(0, 7)}:`);
  expect(queued[0].message).toContain("src/a.ts(3,1): error TS2345: nope");
  expect(queued[0].message).toContain("not a blocker");

  // Same commit checked again (the report row is gone, so HEAD reads as fresh):
  // the sha marker in the queued steer is what stops the repeat.
  db.query("DELETE FROM events WHERE type = 'sidecar_report'").run();
  await sidecarOnce(db, fakeWorld({ tsc }));
  expect(steers(db, taskId).length).toBe(1);
});

test("a new commit that is still broken gets its own steer", async () => {
  const { db, taskId } = freshDb();
  const tsc = { code: 2, stdout: "src/a.ts(3,1): error TS2345: nope\n", stderr: "" };
  await sidecarOnce(db, fakeWorld({ tsc }));
  await sidecarOnce(db, fakeWorldAtSha("b".repeat(40), { tsc }));

  const messages = steers(db, taskId).map((s) => s.message);
  expect(messages.length).toBe(2);
  expect(messages[1]).toContain(`sidecar: build broken since ${"b".repeat(7)}:`);
});

test("lint-only findings never steer the agent", async () => {
  const { db, taskId } = freshDb();
  await sidecarOnce(db, fakeWorld({ lint: { code: 1, stdout: "src/a.ts:3 no-unused-vars\n", stderr: "" } }));

  expect(reports(db, taskId)[0].ok).toBe(false);
  expect(steers(db, taskId)).toEqual([]);
});

test("a tsc check that was skipped for budget is not a broken build", async () => {
  const { db, taskId } = freshDb();
  const world = fakeWorld();
  const realNow = Date.now;
  let clock = 1_000_000;
  Date.now = () => clock;
  try {
    // Burn the budget inside the pass, before the checks themselves run.
    const slow: Exec = async (argv, opts) => {
      if (argv.includes("--porcelain")) clock += 301_000;
      return world.exec(argv, opts);
    };
    await sidecarOnce(db, { ...world, exec: slow });
  } finally {
    Date.now = realNow;
    __resetSidecarCursor();
  }
  expect(reports(db, taskId)[0].findings.every((f: any) => f.summary.startsWith("skipped:"))).toBe(true);
  expect(steers(db, taskId)).toEqual([]);
});
