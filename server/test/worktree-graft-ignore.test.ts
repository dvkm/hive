// HIVE-649: graft build writes a repo-root .ignore that is untracked on
// corebeat and hive, so an agent's `git add -A` picks it up and the risk
// check blocks the PR as scope creep. excludeGraftIgnore hides it via the
// worktree's own git exclude file instead of touching tracked content.
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { excludeGraftIgnore } from "../src/worktreeSeed.ts";
import type { Exec } from "../src/exec.ts";

const realExec: Exec = async (argv, opts) => {
  const p = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", cwd: opts?.cwd });
  const code = await p.exited;
  return { code, stdout: await new Response(p.stdout).text(), stderr: await new Response(p.stderr).text() };
};

async function scratchRepo(name: string): Promise<string> {
  const repo = join(mkdtempSync(join(tmpdir(), "hive-graft-ignore-")), name);
  await realExec(["git", "init", "-q", repo]);
  await realExec(["git", "config", "user.email", "test@example.com"], { cwd: repo });
  await realExec(["git", "config", "user.name", "Test"], { cwd: repo });
  writeFileSync(join(repo, "README.md"), "hi\n");
  await realExec(["git", "add", "README.md"], { cwd: repo });
  await realExec(["git", "commit", "-q", "-m", "init"], { cwd: repo });
  return repo;
}

test("an untracked .ignore stops showing up in git status", async () => {
  const repo = await scratchRepo("untracked");
  writeFileSync(join(repo, ".ignore"), "!graft/\n");
  expect((await realExec(["git", "status", "--porcelain"], { cwd: repo })).stdout).toContain(".ignore");

  await excludeGraftIgnore(repo, realExec);

  expect((await realExec(["git", "status", "--porcelain"], { cwd: repo })).stdout).not.toContain(".ignore");
});

test("a tracked .ignore in another repo is left alone", async () => {
  const repo = await scratchRepo("tracked");
  writeFileSync(join(repo, ".ignore"), "!graft/\n");
  await realExec(["git", "add", ".ignore"], { cwd: repo });
  await realExec(["git", "commit", "-q", "-m", "track ignore"], { cwd: repo });
  writeFileSync(join(repo, ".ignore"), "!graft/\nextra\n");

  await excludeGraftIgnore(repo, realExec);

  expect((await realExec(["git", "status", "--porcelain"], { cwd: repo })).stdout).toContain(".ignore");
});

test("running twice does not duplicate the exclude line", async () => {
  const repo = await scratchRepo("idempotent");
  writeFileSync(join(repo, ".ignore"), "!graft/\n");

  await excludeGraftIgnore(repo, realExec);
  await excludeGraftIgnore(repo, realExec);

  const excludePath = (await realExec(["git", "rev-parse", "--git-path", "info/exclude"], { cwd: repo })).stdout.trim();
  const contents = await Bun.file(join(repo, excludePath)).text();
  expect(contents.match(/^\.ignore$/gm)?.length).toBe(1);
});
