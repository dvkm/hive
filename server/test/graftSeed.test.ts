// graft integration: a checkout that carries a graft index hands a clone of it
// to every worktree (no config), and the brief tells the agent to use it.
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedWorktree } from "../src/worktreeSeed.ts";
import { graftSection } from "../src/briefs.ts";
import type { Exec } from "../src/exec.ts";

const realExec: Exec = async (argv, opts) => {
  const p = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", cwd: opts?.cwd });
  const code = await p.exited;
  return { code, stdout: await new Response(p.stdout).text(), stderr: await new Response(p.stderr).text() };
};

function trees(indexed: boolean) {
  const root = mkdtempSync(join(tmpdir(), "hive-graft-seed-"));
  const repo = join(root, "main");
  const wt = join(root, "wt");
  mkdirSync(repo, { recursive: true });
  mkdirSync(wt, { recursive: true });
  if (indexed) {
    mkdirSync(join(repo, "graft", ".cache"), { recursive: true });
    writeFileSync(join(repo, "graft", "INDEX.md"), "# graft — repo map");
    writeFileSync(join(repo, "graft", ".cache", "extract.json"), "{}");
  }
  return { repo, wt };
}

test("a graft index in the main checkout is cloned into the worktree without any config", async () => {
  const { repo, wt } = trees(true);
  const r = await seedWorktree(repo, wt, {}, realExec);
  expect(r.warmed.map((w) => w.dir)).toEqual(["graft"]);
  expect(existsSync(join(wt, "graft", "INDEX.md"))).toBe(true);
  expect(existsSync(join(wt, "graft", ".cache", "extract.json"))).toBe(true);
  expect(r.misconfigured).toEqual([]);
  expect(graftSection(repo)).toContain("graft ask");
});

test("a checkout without an index seeds nothing and the brief stays quiet about graft", async () => {
  const { repo, wt } = trees(false);
  const r = await seedWorktree(repo, wt, {}, realExec);
  expect(r.warmed).toEqual([]);
  expect(existsSync(join(wt, "graft"))).toBe(false);
  expect(graftSection(repo)).toBeNull();
});
