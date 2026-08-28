// Self-check for the cross-platform hive per-worktree bootstrap hook.
// Exercises the dispatch/branch logic without a real (networked) `bun install`:
// the idempotent "deps present" path, down's no-op, arg defaulting, and usage.
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "..", "infra", "worktree", "wt.ts");

function run(args: string[]): { code: number; out: string } {
  const p = Bun.spawnSync([process.execPath, SCRIPT, ...args]);
  return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() };
}

test("up is an idempotent no-op when node_modules already exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "wt-"));
  mkdirSync(join(dir, "node_modules"));
  try {
    const r = run(["up", dir]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("deps present");
    expect(r.out).toContain(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("down exits 0 and reports there is no stack to remove", () => {
  const dir = mkdtempSync(join(tmpdir(), "wt-"));
  try {
    const r = run(["down", dir]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("no stack to remove");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unknown subcommand prints usage and exits nonzero", () => {
  const r = run(["sideways", tmpdir()]);
  expect(r.code).not.toBe(0);
  expect(r.out).toContain("usage:");
});

test("an unresolvable worktree path fails soft (exit 0, best-effort)", () => {
  const r = run(["up", "/no/such/worktree/here"]);
  expect(r.code).toBe(0);
  expect(r.out).toContain("cannot resolve worktree path");
});
