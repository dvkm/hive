import { test, expect } from "bun:test";
import { openDb, newId, now, type DB } from "../src/db.ts";
import { reapOnce, taskIdFromBranch } from "../src/reaper.ts";
import { Herdr } from "../src/runtime/herdr.ts";
import type { Exec, ExecResult } from "../src/exec.ts";

const OK = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const has = (argv: string[], ...xs: string[]) => xs.every((x) => argv.includes(x));

function freshDb(): { db: DB; projectId: string } {
  const db = openDb(":memory:");
  const projectId = newId("proj");
  db.query("INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)").run(
    projectId, "p", "/repo", "{}", now()
  );
  return { db, projectId };
}
function seedTask(db: DB, projectId: string, id: string, state: string): void {
  const t = now();
  db.query(
    `INSERT INTO tasks (id, project_id, title, state, kind, agent_target, worktree_path, branch, created_at, updated_at)
     VALUES (?,?,?,?, 'ship', ?, ?, ?, ?, ?)`
  ).run(id, projectId, "t", state, `agent-${id}`, `/wt/hive-${id}`, `hive/${id}`, t, t);
}

test("taskIdFromBranch extracts only hive/<id>; ghosts and others are ignored", () => {
  expect(taskIdFromBranch("hive/abc123")).toBe("abc123");
  expect(taskIdFromBranch("ghost-abc123")).toBeNull();
  expect(taskIdFromBranch("main")).toBeNull();
  expect(taskIdFromBranch(null)).toBeNull();
});

// A world with three hive worktrees: DONE+merged (reap), IN_PROGRESS (skip),
// DONE+unmerged (preserve). git branch --merged returns only the merged one.
function reaperWorld() {
  const removed: string[] = [];
  const porcelain =
    "worktree /repo\nHEAD r0\nbranch refs/heads/main\n\n" +
    "worktree /wt/hive-DONE\nHEAD r1\nbranch refs/heads/hive/DONE\n\n" +
    "worktree /wt/hive-LIVE\nHEAD r2\nbranch refs/heads/hive/LIVE\n\n" +
    "worktree /wt/hive-KEEP\nHEAD r3\nbranch refs/heads/hive/KEEP\n";
  const exec: Exec = async (argv) => {
    if (argv[0] === "git" && has(argv, "worktree", "list")) return OK(porcelain);
    if (argv[0] === "git" && argv.includes("ls-remote")) return OK(""); // nothing pushed
    if (argv[0] === "git" && argv.includes("--merged")) return OK("  main\n  hive/DONE"); // only DONE merged
    if (argv[0] === "git" && has(argv, "status", "--porcelain")) return OK(""); // clean
    if (argv[0] === "git" && has(argv, "worktree", "remove")) {
      removed.push(argv[argv.length - 1]);
      return OK();
    }
    return OK();
  };
  return { herdr: new Herdr(exec, "herdr"), removed };
}

test("reapOnce reaps a terminal+merged worktree, skips a live one, preserves an unmerged one", async () => {
  const { db, projectId } = freshDb();
  seedTask(db, projectId, "DONE", "done");
  seedTask(db, projectId, "LIVE", "in_progress");
  seedTask(db, projectId, "KEEP", "done"); // terminal but branch not merged/pushed

  const { herdr, removed } = reaperWorld();
  await reapOnce(db, { herdr, exec: (herdr as any).exec });

  // only the merged, terminal worktree was removed
  expect(removed).toEqual(["/wt/hive-DONE"]);
  // DONE emitted cleaned_up; KEEP emitted cleanup_skipped; LIVE emitted nothing
  expect(db.query("SELECT * FROM events WHERE task_id = 'DONE' AND type = 'cleaned_up'").all().length).toBe(1);
  expect(db.query("SELECT * FROM events WHERE task_id = 'KEEP' AND type = 'cleanup_skipped'").all().length).toBe(1);
  expect(db.query("SELECT * FROM events WHERE task_id = 'LIVE'").all().length).toBe(0);
});

test("reapOnce isolates a per-item failure and keeps sweeping", async () => {
  const { db, projectId } = freshDb();
  seedTask(db, projectId, "DONE", "done");
  const porcelain =
    "worktree /wt/hive-BOOM\nHEAD r1\nbranch refs/heads/hive/BOOM\n\n" + // no task → orphan path
    "worktree /wt/hive-DONE\nHEAD r2\nbranch refs/heads/hive/DONE\n";
  let removedDone = false;
  const exec: Exec = async (argv) => {
    if (argv[0] === "git" && has(argv, "worktree", "list")) return OK(porcelain);
    if (argv[0] === "git" && argv.includes("--merged")) return OK("  main\n  hive/DONE");
    if (argv[0] === "git" && argv.includes("ls-remote")) {
      if (argv.includes("hive/BOOM")) throw new Error("herdr socket blew up"); // item failure
      return OK("");
    }
    if (argv[0] === "git" && has(argv, "status", "--porcelain")) return OK("");
    if (argv[0] === "git" && has(argv, "worktree", "remove")) { removedDone = true; return OK(); }
    return OK();
  };
  const herdr = new Herdr(exec, "herdr");
  await reapOnce(db, { herdr, exec });
  // BOOM threw, but DONE was still reaped
  expect(removedDone).toBe(true);
  expect(db.query("SELECT * FROM events WHERE task_id = 'DONE' AND type = 'cleaned_up'").all().length).toBe(1);
});
