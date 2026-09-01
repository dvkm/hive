// HIVE-355 wiring: the seed has to run inside a real spawn, in the right ORDER
// (after `worktree create`, before setup_argv), and the spawn has to record how
// long each half took. A seed that runs after setup_argv is worthless — the
// install it was meant to skip has already happened.
import { test, expect, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
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
    // The clone shells out to `cp`. Run it for real: a stub that returns 0
    // without copying would make this test pass while nothing was warmed.
    if (argv[0] === "cp") {
      const p = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
      return { code: await p.exited, stdout: "", stderr: await new Response(p.stderr).text() };
    }
    return herdrExec(argv, opts);
  };

  const r = await spawnAgent(db, new Herdr(herdrExec, "herdr"), taskId, { exec });
  expect(r.ok).toBe(true);

  // The ordering claim: setup_argv found both already in place.
  expect(sawAtSetup).toEqual({ env: true, modules: true });

  const seeded: any = db
    .query("SELECT payload FROM events WHERE task_id = ? AND type = 'worktree_seeded'")
    .get(taskId);
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
