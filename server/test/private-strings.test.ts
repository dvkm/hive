import { test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";

// Names that must never land in this public repo are kept outside it, one
// extended regex per line, so the repo itself never spells them. The home
// directory comes from the account, not HOME: other tests in this process point
// HOME at a scratch directory. A clone without the file has nothing to check.
const PATTERNS = join(userInfo().homedir, ".hive", "private-strings");

test.skipIf(!existsSync(PATTERNS))("no tracked file matches a pattern in ~/.hive/private-strings", () => {
  const root = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { cwd: import.meta.dir }).stdout.toString().trim();
  const grep = Bun.spawnSync(["git", "grep", "-nIE", "-f", PATTERNS], { cwd: root });
  expect(grep.stdout.toString()).toBe("");
  expect(grep.stderr.toString()).toBe("");
  expect(grep.exitCode).toBe(1);
});
