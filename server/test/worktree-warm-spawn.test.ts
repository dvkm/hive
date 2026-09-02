// HIVE-355 wiring: the seed has to run inside a real spawn, in the right ORDER
// (after `worktree create`, before setup_argv), and the spawn has to record how
// long each half took. A seed that runs after setup_argv is worthless — the
// install it was meant to skip has already happened.
import { test, expect, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "hive-warm-"));
process.env.HIVE_HOME = HOME;

const { openDb } = await import("../src/db.ts");
const { spawnAgent } = await import("../src/api.ts");
const { Herdr } = await import("../src/runtime/herdr.ts");
import type { Exec, ExecResult } from "../src/exec.ts";

const OK = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const has = (argv: string[], ...xs: string[]) => xs.every((x) => argv.includes(x));

// Main checkout: untracked config + a built node_modules + a lockfile.
const REPO = join(HOME, "main");
const WT = join(HOME, "wt");
const WT2 = join(HOME, "wt2");
const WT3 = join(HOME, "wt3");
const WT4 = join(HOME, "wt4");
beforeAll(() => {
  mkdirSync(join(REPO, "node_modules", "left-pad"), { recursive: true });
  writeFileSync(join(REPO, "node_modules", "left-pad", "index.js"), "1");
  writeFileSync(join(REPO, ".env"), "TOKEN=secret");
  writeFileSync(join(REPO, "bun.lock"), "LOCK-V1");
  // The fresh worktree as git would leave it: tracked files only.
  mkdirSync(WT, { recursive: true });
  writeFileSync(join(WT, "bun.lock"), "LOCK-V1");
  mkdirSync(WT2, { recursive: true });
  writeFileSync(join(WT2, "bun.lock"), "LOCK-V1");
  for (const wt of [WT3, WT4]) {
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, "bun.lock"), "LOCK-V1");
  }
});

// Each test gets its OWN worktree: the first one warms WT, which would make the
// second silently hit "already present" instead of the case it is testing.
const herdrExecFor = (worktree: string): Exec => async (argv) => {
  if (has(argv, "worktree", "create"))
    return OK(`{"result":{"worktree":{"path":${JSON.stringify(worktree)},"branch":"hive/warm","open_workspace_id":"w1"}}}`);
  if (has(argv, "agent", "get")) return OK('{"result":{"agent":{"pane_id":"p1","agent_status":"working"}}}');
  if (has(argv, "workspace", "list")) return OK('{"result":{"workspaces":[{"workspace_id":"wF","label":"hive-fleet"}]}}');
  if (has(argv, "tab", "create")) return OK('{"result":{"tab":{"tab_id":"wF:t2"}}}');
  return OK();
};
const herdrExec = herdrExecFor(WT);

test("seeds and warms the worktree before setup_argv, and records the timings", async () => {
  const db = openDb(":memory:");
  const projectId = "proj_warm";
  db.query("INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)").run(
    projectId,
    "warm",
    REPO,
    JSON.stringify({
      agent: "codex", // skips the claude hook-settings write, which wants a real HOME layout
      worktree_seed: [".env"],
      worktree_warm: [{ dir: "node_modules", lock: "bun.lock" }],
      setup_argv: ["./setup.sh", "{worktree}"],
    }),
    new Date().toISOString()
  );
  const taskId = "t_warm";
  db.query("INSERT INTO tasks (id, project_id, title, kind, state, created_at, updated_at) VALUES (?,?,?,?,?,?,?)").run(
    taskId,
    projectId,
    "warm worktree",
    "ship",
    "queued",
    new Date().toISOString(),
    new Date().toISOString()
  );

  // What the world looked like at the moment setup_argv ran.
  let sawAtSetup: { env: boolean; modules: boolean } | null = null;
  const exec: Exec = async (argv, opts) => {
    if (argv[0]?.endsWith("setup.sh")) {
      sawAtSetup = { env: existsSync(join(WT, ".env")), modules: existsSync(join(WT, "node_modules", "left-pad", "index.js")) };
      return OK();
    }
    // The clone shells out to `cp`. Do the copy for real — a stub that returned
    // 0 without moving bytes would make this test pass while nothing was warmed
    // — but succeed unconditionally, because whether the real `cp` can clone
    // depends on the host filesystem (APFS can, a CI runner on ext4 cannot) and
    // this test is about the recorded label, not about the test host.
    if (argv[0] === "cp") {
      cpSync(argv[argv.length - 2]!, argv[argv.length - 1]!, { recursive: true });
      return OK();
    }
    return herdrExec(argv, opts);
  };

  const r = await spawnAgent(db, new Herdr(herdrExec, "herdr"), taskId, { exec });
  expect(r.ok).toBe(true);

  // The ordering claim: setup_argv found both already in place.
  expect(sawAtSetup as { env: boolean; modules: boolean } | null).toEqual({ env: true, modules: true });

  const seeded: any = db
    .query("SELECT payload FROM events WHERE task_id = ? AND type = 'worktree_seeded'")
    .get(taskId);
  // `cp` succeeded above, so this must record the copy-on-write path by name.
  expect(JSON.parse(seeded.payload)).toMatchObject({ seeded: [".env"], warmed: [{ dir: "node_modules", method: "clone" }] });

  const spawned: any = db.query("SELECT payload FROM events WHERE task_id = ? AND type = 'spawned'").get(taskId);
  const p = JSON.parse(spawned.payload);
  expect(p.warmed).toEqual([{ dir: "node_modules", method: "clone" }]);
  for (const key of ["spawn_ms", "seed_ms", "setup_ms"]) expect(typeof p[key]).toBe("number");
  expect(p.spawn_ms).toBeGreaterThanOrEqual(p.seed_ms + p.setup_ms);

  // A healthy spawn must not raise the alarm.
  expect(db.query("SELECT count(*) c FROM events WHERE task_id = ? AND type = 'worktree_seed_failed'").get(taskId)).toMatchObject({ c: 0 });
});

test("a warm config naming a lockfile nobody has raises a failure event, and the spawn still succeeds", async () => {
  const db = openDb(":memory:");
  const projectId = "proj_badwarm";
  db.query("INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)").run(
    projectId,
    "badwarm",
    REPO,
    JSON.stringify({ agent: "codex", worktree_warm: [{ dir: "node_modules", lock: "pnpm-lock.yaml" }] }),
    new Date().toISOString()
  );
  const taskId = "t_badwarm";
  db.query("INSERT INTO tasks (id, project_id, title, kind, state, created_at, updated_at) VALUES (?,?,?,?,?,?,?)").run(
    taskId, projectId, "bad warm config", "ship", "queued", new Date().toISOString(), new Date().toISOString()
  );

  const exec = herdrExecFor(WT2);
  const r = await spawnAgent(db, new Herdr(exec, "herdr"), taskId, { exec });
  // Loud, but never fatal: a misconfigured seed is a slow spawn, not a failed one.
  expect(r.ok).toBe(true);

  const failed: any = db.query("SELECT payload FROM events WHERE task_id = ? AND type = 'worktree_seed_failed'").get(taskId);
  expect(failed).toBeTruthy();
  expect(JSON.parse(failed.payload).misconfigured[0].reason).toContain("pnpm-lock.yaml is missing");
});

test("the same broken seed config reports once per project, not on every spawn", async () => {
  const db = openDb(":memory:");
  const projectId = "proj_noisy";
  db.query("INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)").run(
    projectId,
    "noisy",
    REPO,
    // A warm dir that does not exist in the main checkout: broken now and on
    // every future spawn, which is exactly the config that used to shout forever.
    JSON.stringify({ agent: "codex", worktree_warm: [{ dir: "vendor" }] }),
    new Date().toISOString()
  );
  const mk = (taskId: string) =>
    db.query("INSERT INTO tasks (id, project_id, title, kind, state, created_at, updated_at) VALUES (?,?,?,?,?,?,?)").run(
      taskId, projectId, "noisy seed", "ship", "queued", new Date().toISOString(), new Date().toISOString()
    );
  mk("t_noisy1");
  mk("t_noisy2");

  const first = herdrExecFor(WT3);
  expect((await spawnAgent(db, new Herdr(first, "herdr"), "t_noisy1", { exec: first })).ok).toBe(true);
  const second = herdrExecFor(WT4);
  expect((await spawnAgent(db, new Herdr(second, "herdr"), "t_noisy2", { exec: second })).ok).toBe(true);

  // One event for the project, on the spawn that found it first.
  const rows = db
    .query("SELECT task_id FROM events WHERE type = 'worktree_seed_failed' AND task_id IN ('t_noisy1','t_noisy2')")
    .all() as { task_id: string }[];
  expect(rows.map((r) => r.task_id)).toEqual(["t_noisy1"]);

  // A DIFFERENT problem is still reported: the dedupe is per problem, not a
  // permanent mute on the project.
  db.query("UPDATE projects SET config = ? WHERE id = ?").run(
    JSON.stringify({ agent: "codex", worktree_warm: [{ dir: "node_modules", lock: "pnpm-lock.yaml" }] }),
    projectId
  );
  mk("t_noisy3");
  const third = herdrExecFor(WT3);
  expect((await spawnAgent(db, new Herdr(third, "herdr"), "t_noisy3", { exec: third })).ok).toBe(true);
  const later: any = db.query("SELECT payload FROM events WHERE task_id = 't_noisy3' AND type = 'worktree_seed_failed'").get();
  expect(JSON.parse(later.payload).misconfigured[0].reason).toContain("pnpm-lock.yaml is missing");
});
