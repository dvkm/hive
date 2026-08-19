import { test, expect } from "bun:test";
import { findEmbeddedTasks } from "../src/branchContents.ts";
import type { Exec, ExecResult } from "../src/exec.ts";

const OK = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const FAIL = (stderr = "boom"): ExecResult => ({ code: 1, stdout: "", stderr });

// Routes `git merge-base <a> <b>` to a lookup keyed by the exact call order
// findEmbeddedTasks uses: first "<base>|<branch>", then "<branch>|<other>".
function mergeBaseStub(bases: Record<string, string>): Exec {
  return async (argv) => {
    if (argv[3] !== "merge-base") return OK();
    const key = `${argv[4]}|${argv[5]}`;
    return bases[key] !== undefined ? OK(bases[key]) : FAIL("no merge base");
  };
}

test("no shared history beyond base → no embedded tasks", async () => {
  const exec = mergeBaseStub({
    "main|feat": "base-sha",
    "feat|other": "base-sha", // same as base — clean divergence
  });
  const embedded = await findEmbeddedTasks(exec, "/repo", "main", "feat", [
    { id: "t2", number: 2, title: "other task", branch: "other" },
  ]);
  expect(embedded).toEqual([]);
});

test("branch shares history with another open task's branch → flagged", async () => {
  // feat merged dep-branch in at some point, so their pairwise merge-base is
  // deeper than feat's merge-base with main.
  const exec = mergeBaseStub({
    "main|feat": "base-sha",
    "feat|dep-branch": "dep-sha", // != base-sha
  });
  const embedded = await findEmbeddedTasks(exec, "/repo", "main", "feat", [
    { id: "t2", number: 974, title: "consolidate external-task exclusion", branch: "dep-branch" },
  ]);
  expect(embedded).toEqual([{ id: "t2", number: 974, title: "consolidate external-task exclusion" }]);
});

test("a task with no branch is skipped", async () => {
  const exec = mergeBaseStub({ "main|feat": "base-sha" });
  const embedded = await findEmbeddedTasks(exec, "/repo", "main", "feat", [
    { id: "t2", number: 2, title: "no branch yet", branch: null },
  ]);
  expect(embedded).toEqual([]);
});

test("unreadable comparison to one candidate is skipped, not flagged", async () => {
  const exec = mergeBaseStub({ "main|feat": "base-sha" }); // dep-branch|feat is FAIL (unset)
  const embedded = await findEmbeddedTasks(exec, "/repo", "main", "feat", [
    { id: "t2", number: 2, title: "unreadable branch", branch: "dep-branch" },
  ]);
  expect(embedded).toEqual([]);
});

test("this branch itself unreadable against base → null (caller must not block on it)", async () => {
  const exec: Exec = async () => FAIL();
  const embedded = await findEmbeddedTasks(exec, "/repo", "main", "feat", [
    { id: "t2", number: 2, title: "x", branch: "other" },
  ]);
  expect(embedded).toBeNull();
});
