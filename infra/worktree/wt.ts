#!/usr/bin/env bun
// Cross-platform per-worktree bootstrap. Hive has no per-worktree services, so
// up only installs dependencies when needed and down is intentionally a no-op.
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

const [command = "up", requested] = process.argv.slice(2);
const target = resolve(requested || process.cwd());

if (!existsSync(target) || !statSync(target).isDirectory()) {
  console.error(`wt.ts: cannot resolve worktree path '${requested || ""}'`);
  process.exit(0);
}

if (command === "up") {
  console.log(`==> hive worktree bootstrap: ${target}`);
  if (existsSync(resolve(target, "node_modules"))) {
    console.log("   deps present — nothing to do");
    process.exit(0);
  }
  console.log("==> bun install");
  const result = Bun.spawnSync([process.execPath, "install"], { cwd: target, stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0)
    console.error("   WARNING: bun install failed; run it manually in the worktree");
  process.exit(0); // setup is best-effort and never blocks the agent
}

if (command === "down") {
  console.log(`==> hive worktree teardown: ${target} (no stack to remove)`);
  process.exit(0);
}

console.error(`usage: ${process.argv[1]} {up|down} [worktree-path]`);
process.exit(1);
