// HIVE-355 warm worktrees. Two jobs, both against a real temp filesystem so the
// copy/clone actually happens: seed the untracked config a fresh worktree is
// missing, and clone the warm state only while its lockfile still matches.
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedWorktree } from "../src/worktreeSeed.ts";
import type { Exec } from "../src/exec.ts";

// A repo pair: main checkout with untracked config + a built node_modules, and
// a fresh worktree holding only the tracked files git would have given it.
function trees(lockInWorktree = "LOCK-V1") {
  const root = mkdtempSync(join(tmpdir(), "hive-seed-"));
  const repo = join(root, "main");
  const wt = join(root, "wt");
  mkdirSync(join(repo, "web"), { recursive: true });
  mkdirSync(join(wt, "web"), { recursive: true });
  writeFileSync(join(repo, ".env"), "TOKEN=secret");
  writeFileSync(join(repo, "config.env"), "MODE=dev");
  writeFileSync(join(repo, "bun.lock"), "LOCK-V1");
  writeFileSync(join(wt, "bun.lock"), lockInWorktree);
  mkdirSync(join(repo, "node_modules", "left-pad"), { recursive: true });
  writeFileSync(join(repo, "node_modules", "left-pad", "index.js"), "module.exports=1");
  return { repo, wt };
}

const realExec: Exec = async (argv, opts) => {
  const p = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", cwd: opts?.cwd });
  const code = await p.exited;
  return { code, stdout: await new Response(p.stdout).text(), stderr: await new Response(p.stderr).text() };
};

test("copies allowlisted untracked config into the fresh worktree", async () => {
  const { repo, wt } = trees();
  const r = await seedWorktree(repo, wt, { worktree_seed: [".env", "config.env"] }, realExec);
  expect(r.seeded.sort()).toEqual([".env", "config.env"]);
  expect(readFileSync(join(wt, ".env"), "utf8")).toBe("TOKEN=secret");
  expect(typeof r.ms).toBe("number");
});

test("a glob matches, and a file the worktree already has is never clobbered", async () => {
  const { repo, wt } = trees();
  writeFileSync(join(wt, ".env"), "MINE=1");
  const r = await seedWorktree(repo, wt, { worktree_seed: [".env*"] }, realExec);
  expect(r.seeded).toEqual([]);
  expect(readFileSync(join(wt, ".env"), "utf8")).toBe("MINE=1");
  expect(r.skipped[0]!.reason).toBe("already present in worktree");
});

test("clones node_modules when the lockfile still matches", async () => {
  const { repo, wt } = trees("LOCK-V1");
  const r = await seedWorktree(repo, wt, { worktree_warm: [{ dir: "node_modules", lock: "bun.lock" }] }, realExec);
  expect(r.warmed).toEqual([{ dir: "node_modules", method: "clone" }]);
  expect(readFileSync(join(wt, "node_modules", "left-pad", "index.js"), "utf8")).toBe("module.exports=1");
});

// A changed lockfile is the rule working, so it stays QUIET. Everything that
// means "the config names something that is not there" is LOUD, because from
// the agent's side a worktree that was never warmed looks exactly like a warm
// one until it fails somewhere unrelated.
test("a branch that changed the lockfile is refused the clone, quietly", async () => {
  const { repo, wt } = trees("LOCK-V2-branch-added-a-dep");
  const r = await seedWorktree(repo, wt, { worktree_warm: [{ dir: "node_modules", lock: "bun.lock" }] }, realExec);
  expect(r.warmed).toEqual([]);
  expect(existsSync(join(wt, "node_modules"))).toBe(false);
  expect(r.skipped[0]!.reason).toBe("bun.lock differs from main checkout");
  expect(r.misconfigured).toEqual([]); // quiet: this is the design, not a mistake
});

test("a lockfile that does not exist is loud, not a silent skip", async () => {
  const { repo, wt } = trees();
  const r = await seedWorktree(repo, wt, { worktree_warm: [{ dir: "node_modules", lock: "pnpm-lock.yaml" }] }, realExec);
  expect(r.warmed).toEqual([]);
  expect(r.misconfigured).toEqual([
    { path: "node_modules", reason: "lock file pnpm-lock.yaml is missing, so node_modules can never be warmed" },
  ]);
});

test("a warm directory that was never built in the main checkout is loud", async () => {
  const { repo, wt } = trees();
  const r = await seedWorktree(repo, wt, { worktree_warm: [{ dir: "vendor", lock: "bun.lock" }] }, realExec);
  expect(r.warmed).toEqual([]);
  expect(r.misconfigured[0]).toEqual({
    path: "vendor",
    reason: "named in worktree_warm but not built in the main checkout",
  });
});

test("no seed config at all stays quiet — that is the deliberate default", async () => {
  const { repo, wt } = trees();
  const r = await seedWorktree(repo, wt, {}, realExec);
  expect(r.misconfigured).toEqual([]);
  expect(r.skipped).toEqual([]);
});

test("one optional pattern missing is quiet, but an allowlist matching nothing is loud", async () => {
  const { repo, wt } = trees();
  // `.env` exists, `.env.local` does not: the normal optional-file case.
  const partial = await seedWorktree(repo, wt, { worktree_seed: [".env", ".env.local"] }, realExec);
  expect(partial.seeded).toEqual([".env"]);
  expect(partial.misconfigured).toEqual([]);

  const { repo: r2, wt: w2 } = trees();
  const none = await seedWorktree(r2, w2, { worktree_seed: ["secrets.yml", "app.env"] }, realExec);
  expect(none.seeded).toEqual([]);
  expect(none.misconfigured[0]!.reason).toBe("no worktree_seed pattern matched anything in the main checkout");
});

test("a path that escapes the worktree is refused, not followed", async () => {
  const { repo, wt } = trees();
  const r = await seedWorktree(
    repo,
    wt,
    { worktree_seed: ["../main/.env"], worktree_warm: [{ dir: "../elsewhere" }, { dir: "/etc" }] },
    realExec
  );
  expect(r.seeded).toEqual([]);
  expect(r.warmed).toEqual([]);
  expect(r.misconfigured.length).toBeGreaterThan(0);
  expect(r.misconfigured.some((m) => m.reason === "escapes the worktree")).toBe(true);
});

test("a clone that fails leaves nothing half-built behind", async () => {
  const { repo, wt } = trees();
  // Every `cp` fails, so the exec path bails and the fs fallback still finishes.
  const failing: Exec = async () => ({ code: 1, stdout: "", stderr: "cp: no clone support" });
  const r = await seedWorktree(repo, wt, { worktree_warm: [{ dir: "node_modules", lock: "bun.lock" }] }, failing);
  // The fallback ran, so it must NOT claim the fast path: a byte copy on a
  // filesystem without clone support has to be visible as one in the stats.
  expect(r.warmed).toEqual([{ dir: "node_modules", method: "copy" }]);
  expect(readFileSync(join(wt, "node_modules", "left-pad", "index.js"), "utf8")).toBe("module.exports=1");
});

test("a cp that dies part-way never leaves a half-built node_modules", async () => {
  const { repo, wt } = trees();
  // Stand in for a killed `cp`: it writes some of the tree, then exits non-zero.
  // Everything it wrote goes to a temp path, so the destination must still be
  // untouched, and the fallback copy that follows must not inherit the scraps.
  const killedPartWay: Exec = async (argv) => {
    const dest = argv[argv.length - 1]!;
    expect(dest).not.toBe(join(wt, "node_modules")); // built beside it, not on it
    mkdirSync(join(dest, "half-written"), { recursive: true });
    expect(existsSync(join(wt, "node_modules"))).toBe(false);
    return { code: 137, stdout: "", stderr: "Killed" };
  };
  const r = await seedWorktree(repo, wt, { worktree_warm: [{ dir: "node_modules", lock: "bun.lock" }] }, killedPartWay);
  expect(r.warmed).toEqual([{ dir: "node_modules", method: "copy" }]);
  expect(readFileSync(join(wt, "node_modules", "left-pad", "index.js"), "utf8")).toBe("module.exports=1");
  expect(existsSync(join(wt, "node_modules", "half-written"))).toBe(false);
});
