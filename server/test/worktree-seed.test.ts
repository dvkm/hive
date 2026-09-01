// HIVE-355 warm worktrees. Two jobs, both against a real temp filesystem so the
// copy/clone actually happens: seed the untracked config a fresh worktree is
// missing, and clone the warm state only while its lockfile still matches.
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, cpSync } from "node:fs";
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
  // `cp` SUCCEEDS here, which is the only thing that means the copy-on-write
  // path ran: both platform flags (macOS -c, Linux --reflink=always) refuse
  // rather than degrade. Stubbed rather than run for real because whether a
  // machine can clone is a property of its filesystem — APFS can, a CI runner
  // on ext4 cannot — and this test is about which label we record, not about
  // what the test host happens to support. It still does the copy, so a warm
  // that recorded success without moving bytes would fail below.
  const cloningExec: Exec = async (argv) => {
    cpSync(argv[argv.length - 2]!, argv[argv.length - 1]!, { recursive: true });
    return { code: 0, stdout: "", stderr: "" };
  };
  const r = await seedWorktree(repo, wt, { worktree_warm: [{ dir: "node_modules", lock: "bun.lock" }] }, cloningExec);
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

// Stand in for a filesystem with no reflink support (ext4): the clone flags are
// refused, the plain `cp -R` that follows works. Both run as child processes, so
// the slow byte copy never blocks the server's event loop.
const noReflinkExec: Exec = async (argv) => {
  if (argv.includes("-Rc") || argv.includes("--reflink=always"))
    return { code: 1, stdout: "", stderr: "cp: no clone support" };
  cpSync(argv[argv.length - 2]!, argv[argv.length - 1]!, { recursive: true });
  return { code: 0, stdout: "", stderr: "" };
};

test("a clone that fails leaves nothing half-built behind", async () => {
  const { repo, wt } = trees();
  const r = await seedWorktree(repo, wt, { worktree_warm: [{ dir: "node_modules", lock: "bun.lock" }] }, noReflinkExec);
  // The fallback ran, so it must NOT claim the fast path: a byte copy on a
  // filesystem without clone support has to be visible as one in the stats.
  expect(r.warmed).toEqual([{ dir: "node_modules", method: "copy" }]);
  expect(readFileSync(join(wt, "node_modules", "left-pad", "index.js"), "utf8")).toBe("module.exports=1");
});

// The slow path must stay OFF the event loop. A byte copy of a real
// node_modules takes seconds, and doing it in-process would freeze every other
// spawn and API request for all of them. So the fallback has to be a child
// process too: proved by it arriving as a second `cp` through exec.
test("the byte-copy fallback runs as a child process, not in-process", async () => {
  const { repo, wt } = trees();
  const calls: string[][] = [];
  const r = await seedWorktree(
    repo,
    wt,
    { worktree_warm: [{ dir: "node_modules", lock: "bun.lock" }] },
    async (argv) => {
      calls.push(argv);
      return noReflinkExec(argv);
    }
  );
  expect(r.warmed).toEqual([{ dir: "node_modules", method: "copy" }]);
  expect(calls.length).toBe(2);
  expect(calls[1]!.slice(0, 2)).toEqual(["cp", "-R"]);
});

test("a fallback copy that fails too is loud, and leaves no node_modules", async () => {
  const { repo, wt } = trees();
  const allFail: Exec = async () => ({ code: 1, stdout: "", stderr: "cp: Read-only file system" });
  const r = await seedWorktree(repo, wt, { worktree_warm: [{ dir: "node_modules", lock: "bun.lock" }] }, allFail);
  expect(r.warmed).toEqual([]);
  expect(existsSync(join(wt, "node_modules"))).toBe(false);
  expect(r.misconfigured[0]!.reason).toContain("Read-only file system");
});

test("a cp that dies part-way never leaves a half-built node_modules", async () => {
  const { repo, wt } = trees();
  // Stand in for a killed `cp`: it writes some of the tree, then exits non-zero.
  // Everything it wrote goes to a temp path, so the destination must still be
  // untouched, and the fallback copy that follows must not inherit the scraps.
  const killedPartWay: Exec = async (argv) => {
    const dest = argv[argv.length - 1]!;
    expect(dest).not.toBe(join(wt, "node_modules")); // built beside it, not on it
    if (argv.includes("-Rc") || argv.includes("--reflink=always")) {
      mkdirSync(join(dest, "half-written"), { recursive: true });
      expect(existsSync(join(wt, "node_modules"))).toBe(false);
      return { code: 137, stdout: "", stderr: "terminated" };
    }
    return noReflinkExec(argv);
  };
  const r = await seedWorktree(repo, wt, { worktree_warm: [{ dir: "node_modules", lock: "bun.lock" }] }, killedPartWay);
  expect(r.warmed).toEqual([{ dir: "node_modules", method: "copy" }]);
  expect(readFileSync(join(wt, "node_modules", "left-pad", "index.js"), "utf8")).toBe("module.exports=1");
  expect(existsSync(join(wt, "node_modules", "half-written"))).toBe(false);
});

test("a wide-open seed pattern stops at the cap instead of copying the whole checkout", async () => {
  const { repo, wt } = trees();
  // `**/*` is the pattern the cap exists for: it matches everything in the main
  // checkout, so without a limit every spawn would copy the lot.
  mkdirSync(join(repo, "junk"), { recursive: true });
  for (let i = 0; i < 200; i++) writeFileSync(join(repo, "junk", `f${i}.txt`), "x");
  const r = await seedWorktree(repo, wt, { worktree_seed: ["**/*"] }, realExec);
  expect(r.seeded.length).toBe(100);
  expect(r.misconfigured.some((m) => m.reason.includes("worktree_seed stopped at"))).toBe(true);
});
