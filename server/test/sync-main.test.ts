// HIVE-548: sync-main.sh refused to update the live checkout 1093 times in a
// row because main was checked out in another worktree, and /api/health had no
// idea the running code had fallen 30 commits behind main.
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { measureLiveCheckout } from "../src/api.ts";

function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const out = new TextDecoder().decode(r.stdout).trim();
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${new TextDecoder().decode(r.stderr)}`);
  return out;
}

function commit(cwd: string, name: string, env: Record<string, string> = {}) {
  writeFileSync(join(cwd, name), name);
  git(cwd, ["add", "-A"], env);
  git(cwd, ["commit", "-m", name], { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", ...env });
}

// origin (bare) <- upstream working copy; repo is a clone whose primary checkout
// sits on a feature branch and whose "live" worktree holds main. That is the
// exact shape the launchd job runs in.
function scaffold(): { repo: string; live: string; origin: string } {
  const root = mkdtempSync(join(tmpdir(), "syncmain-"));
  const origin = join(root, "origin.git");
  const seed = join(root, "seed");
  mkdirSync(seed);
  git(seed, ["init", "-q", "-b", "main"]);
  commit(seed, "a");
  git(root, ["clone", "-q", "--bare", seed, origin]);
  const repo = join(root, "repo");
  git(root, ["clone", "-q", origin, repo]);
  const live = join(root, "live");
  // main moves to the live worktree, so the primary checkout must leave it.
  git(repo, ["checkout", "-q", "-b", "feat/x"]);
  git(repo, ["worktree", "add", "-q", live, "main"]);
  return { repo, live, origin };
}

function runSync(repo: string, live: string, log: string) {
  return Bun.spawnSync(["bash", join(import.meta.dir, "..", "..", "scripts", "sync-main.sh")], {
    env: { ...process.env, HIVE_SYNC_REPO: repo, HIVE_SYNC_LIVE: live, HIVE_SYNC_LOG: log },
    stdout: "pipe",
    stderr: "pipe",
  });
}

test("sync-main fast-forwards the worktree that holds main instead of giving up", async () => {
  const { repo, live, origin } = scaffold();
  const seed = mkdtempSync(join(tmpdir(), "syncmain-push-"));
  git(seed, ["clone", "-q", origin, "."]);
  commit(seed, "b");
  git(seed, ["push", "-q", "origin", "main"]);
  const before = git(live, ["rev-parse", "HEAD"]);

  const log = join(repo, "..", "sync.log");
  // The deploy half (bun install, web build, launchctl kickstart) cannot run
  // against a scratch repo, so it exits nonzero after the sync. What is under
  // test is the sync half above it.
  runSync(repo, live, log);

  expect(git(live, ["rev-parse", "HEAD"])).not.toBe(before);
  expect(git(live, ["rev-parse", "HEAD"])).toBe(git(repo, ["rev-parse", "refs/remotes/origin/main"]));
  const t = await Bun.file(log).text();
  expect(t).toContain("pulled 1 commit(s) from origin/main");
  expect(t).not.toContain("not updating its ref behind that checkout");
});

test("sync-main refuses loudly, naming the drift, when the live tree cannot fast-forward", async () => {
  const { repo, live, origin } = scaffold();
  const seed = mkdtempSync(join(tmpdir(), "syncmain-push2-"));
  git(seed, ["clone", "-q", origin, "."]);
  commit(seed, "b");
  git(seed, ["push", "-q", "origin", "main"]);
  // A local edit to the very file the incoming commit adds blocks the ff.
  writeFileSync(join(live, "b"), "conflicting local edit");

  const log = join(repo, "..", "sync2.log");
  const before = git(live, ["rev-parse", "HEAD"]);
  const r = runSync(repo, live, log);

  expect(r.exitCode).not.toBe(0);
  expect(git(live, ["rev-parse", "HEAD"])).toBe(before);
  const t = await Bun.file(log).text();
  expect(t).toContain("STALE DEPLOY");
  expect(t).toContain("is 1 commit(s) behind origin/main and NOT being updated");
  expect(t).toContain("running server stays on old code");
});

test("live checkout drift is clean when the checkout is on origin/main", () => {
  const { repo } = scaffold();
  expect(measureLiveCheckout(repo)).toMatchObject({ behind: 0, stale: false, error: null });
});

test("live checkout drift is stale once the missing commits have sat unmerged", () => {
  const { repo, origin } = scaffold();
  const seed = mkdtempSync(join(tmpdir(), "syncmain-push3-"));
  git(seed, ["clone", "-q", origin, "."]);
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  commit(seed, "b", { GIT_COMMITTER_DATE: old });
  git(seed, ["push", "-q", "origin", "main"]);
  git(repo, ["fetch", "-q", "origin", "main"]);

  expect(measureLiveCheckout(repo)).toMatchObject({ behind: 1, stale: true });
});

test("live checkout drift is not stale in the minutes right after a merge", () => {
  const { repo, origin } = scaffold();
  const seed = mkdtempSync(join(tmpdir(), "syncmain-push4-"));
  git(seed, ["clone", "-q", origin, "."]);
  commit(seed, "b");
  git(seed, ["push", "-q", "origin", "main"]);
  git(repo, ["fetch", "-q", "origin", "main"]);

  expect(measureLiveCheckout(repo)).toMatchObject({ behind: 1, stale: false });
});
