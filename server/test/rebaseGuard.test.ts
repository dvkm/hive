import { test, expect } from "bun:test";
import { captureBranchScope, detectDestructiveRebase, type BranchScope } from "../src/rebaseGuard.ts";
import type { Exec, ExecResult } from "../src/exec.ts";

const OK = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const FAIL = (stderr = "boom"): ExecResult => ({ code: 1, stdout: "", stderr });
const stub = (fn: (argv: string[]) => ExecResult): Exec => async (argv) => fn(argv);

// Route git subcommands: `diff --name-only` (authored files) and
// `log --oneline <range> -- <file>` (did base advance on <file>).
// `edited` names files whose branch content DIFFERS from the snapshot-base
// content (ordinary work on top of base); everything else reads as unchanged
// since the snapshot, i.e. a rollback.
function gitStub(opts: { authored: string; advanced: Set<string>; edited?: Set<string> }): Exec {
  return stub((argv) => {
    if (argv.includes("diff") && argv.includes("--name-only")) return OK(opts.authored);
    if (argv[3] === "log") {
      const file = argv[argv.length - 1];
      return OK(opts.advanced.has(file) ? "abc123 some base commit\n" : "");
    }
    if (argv.includes("rev-parse")) {
      const [rev, path] = String(argv.at(-1)).split(":");
      if (!path) return OK("basesha\n");
      return OK(opts.edited?.has(path) ? `blob-${rev}-${path}\n` : `blob-${path}\n`);
    }
    return OK();
  });
}

const SNAP: BranchScope = { base_sha: "B1", files: ["src/task.ts"] };

test("captureBranchScope records the authored file-set and base tip", async () => {
  const exec = gitStub({ authored: "src/b.ts\nsrc/a.ts\n", advanced: new Set() });
  const scope = await captureBranchScope(exec, "/repo", "main", "feat");
  expect(scope).toEqual({ base_sha: "basesha", files: ["src/a.ts", "src/b.ts"] });
});

test("clean rebase (same authored scope) → no regression", async () => {
  const exec = gitStub({ authored: "src/task.ts\n", advanced: new Set() });
  const regressed = await detectDestructiveRebase(exec, "/repo", "main", "feat", SNAP);
  expect(regressed).toEqual([]);
});

test("destructive rebase reverting a base-advanced file → flagged", async () => {
  // Branch now authors src/task.ts (intended) + health.ts + web/app.ts, and base
  // advanced those two since the snapshot — the auto-resolve reverted them.
  const exec = gitStub({
    authored: "health.ts\nsrc/task.ts\nweb/app.ts\n",
    advanced: new Set(["health.ts", "web/app.ts"]),
  });
  const regressed = await detectDestructiveRebase(exec, "/repo", "main", "feat", SNAP);
  expect(regressed).toEqual(["health.ts", "web/app.ts"]);
});

test("agent legitimately adds a new file base never touched → not flagged", async () => {
  const exec = gitStub({ authored: "src/new.ts\nsrc/task.ts\n", advanced: new Set() });
  const regressed = await detectDestructiveRebase(exec, "/repo", "main", "feat", SNAP);
  expect(regressed).toEqual([]);
});

test("editing a file base recently touched is work, not a revert (HIVE-543)", async () => {
  // The branch authors a spec file base moved since the snapshot, but its
  // content is NOT the old content — it changed an assertion. Not a revert.
  const exec = gitStub({
    authored: "e2e/tracker.spec.ts\nsrc/task.ts\n",
    advanced: new Set(["e2e/tracker.spec.ts"]),
    edited: new Set(["e2e/tracker.spec.ts"]),
  });
  expect(await detectDestructiveRebase(exec, "/repo", "main", "feat", SNAP)).toEqual([]);
});

test("git read failure → null (caller must not block on it)", async () => {
  const exec = stub(() => FAIL());
  expect(await detectDestructiveRebase(exec, "/repo", "main", "feat", SNAP)).toBeNull();
  expect(await captureBranchScope(exec, "/repo", "main", "feat")).toBeNull();
});
