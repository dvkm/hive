import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HOME = mkdtempSync(join(tmpdir(), "hive-branch-"));
const { openDb, newId, now } = await import("../src/db.ts");
import type { DB } from "../src/db.ts";
const { writeEvent } = await import("../src/state.ts");
const { branchSlug, taskForHiveBranch } = await import("../src/taskIdentifier.ts");
const { taskFromPrMarker } = await import("../src/api.ts");
const { worktreePathFor, worktreeCreateArgv } = await import("../src/runtime/herdr.ts");

// Branches, PR titles and worktrees read like a person's work; hive keeps the
// link to its task in its own database instead of in the names.

function setup(): { db: DB; projectId: string; task: (title: string) => string } {
  const db = openDb(":memory:");
  const projectId = newId("proj");
  db.query("INSERT INTO projects (id, name, created_at) VALUES (?,?,?)").run(projectId, "p", now());
  const task = (title: string) => {
    const id = newId();
    db.query("INSERT INTO tasks (id, project_id, title, state, kind, created_at, updated_at) VALUES (?,?,?, 'in_progress', 'ship', ?, ?)")
      .run(id, projectId, title, now(), now());
    return id;
  };
  return { db, projectId, task };
}

test("a branch is named the way a person would name it", () => {
  expect(branchSlug({ title: "[ABC-12] [버그] 로그인 후 첫 화면이 비어 있음" })).toBe("abc-12");
  expect(branchSlug({ title: "Stop agents committing graft's .ignore from the seeded worktree" })).toBe("stop-agents-committing-grafts-ignore");
  expect(branchSlug({ title: "Fix WEB-7 login redirect", jira_key: "WEB-7" })).toBe("web-7-fix-login-redirect");
  expect(branchSlug({ title: "로그인 화면" })).toBe("change");
  for (const title of ["[ABC-12] 로그인", "Fix the thing", "x".repeat(200)]) {
    const slug = branchSlug({ title });
    expect(slug).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    expect(slug.length).toBeLessThanOrEqual(48);
    expect(slug).not.toContain("hive");
  }
});

test("hive knows its own branches by record, never a person's branch that shares the name", () => {
  const { db, projectId, task } = setup();
  const id = task("Fix the login redirect");
  expect(taskForHiveBranch(db, projectId, "fix-the-login-redirect")).toBeNull(); // a person's branch
  writeEvent(db, { task_id: id, source: "herdr", type: "branch_named", payload: { branch: "fix-the-login-redirect" } });
  expect(taskForHiveBranch(db, projectId, "fix-the-login-redirect")).toBe(id);
  expect(taskForHiveBranch(db, newId("proj"), "fix-the-login-redirect")).toBeNull(); // another project's
  expect(taskForHiveBranch(db, projectId, `hive/${id}`)).toBe(id); // older tasks keep working
});

test("a PR is linked to its task by the branch hive recorded, with no marker in the title or body", () => {
  const { db, projectId, task } = setup();
  const id = task("Fix the login redirect");
  writeEvent(db, { task_id: id, source: "herdr", type: "branch_named", payload: { branch: "fix-the-login-redirect" } });
  const found = taskFromPrMarker(db, { title: "fix(web): send users back where they came from", body: "Short and plain.", headRefName: "fix-the-login-redirect", project_id: projectId });
  expect(found?.task.id).toBe(id);
  expect(found?.via).toBe("branch");
  expect(taskFromPrMarker(db, { title: "fix(web): x", body: "y", headRefName: "someone-elses-branch", project_id: projectId })).toBeNull();
  // A PR opened before the change still links by its marker.
  const legacy = task("old work");
  const number = (db.query("SELECT number FROM tasks WHERE id = ?").get(legacy) as { number: number }).number;
  expect(taskFromPrMarker(db, { title: `[hive-${number}] old work`, body: `hive-task: ${legacy}`, headRefName: `hive/${legacy}` })?.task.id).toBe(legacy);
});

test("a hive-named branch keeps the local hive-<id> worktree directory the reaper reads", () => {
  expect(worktreePathFor("/Users/x/projects/shop", "hive/abc123def456", "abc123def456")).toBeUndefined();
  const path = worktreePathFor("/Users/x/projects/shop", "abc-12", "abc123def456")!;
  expect(path.endsWith(join("worktrees", "shop", "hive-abc123def456"))).toBe(true);
  expect(worktreeCreateArgv("/repo", "abc-12", "origin/main", path)).toEqual([
    "worktree", "create", "--cwd", "/repo", "--branch", "abc-12", "--base", "origin/main", "--path", path, "--json",
  ]);
});
