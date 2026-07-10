import { test, expect } from "bun:test";
import { openDb, newId, now, type DB } from "../src/db.ts";
import { promoteOnce } from "../src/promoter.ts";
import type { Exec, ExecResult } from "../src/exec.ts";

const OK = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });

function freshDb(config: any = { promote: { from: "staging", to: "main" } }): { db: DB; projectId: string } {
  const db = openDb(":memory:");
  const projectId = newId("proj");
  db.query("INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)").run(
    projectId, "p", "/repo", JSON.stringify(config), now()
  );
  return { db, projectId };
}

// Stub git/gh: `ahead` commits, `sha` head, `openPrs` open promote PRs.
function stubExec(ahead: number, sha = "abc123def", openPrs = 0): Exec {
  return async (argv) => {
    if (argv.includes("fetch")) return OK();
    if (argv.includes("rev-list")) return OK(`${ahead}\n`);
    if (argv.includes("rev-parse")) return OK(`${sha}\n`);
    if (argv[0] === "gh") return OK(JSON.stringify(Array.from({ length: openPrs }, (_, i) => ({ number: i + 1 }))));
    return OK();
  };
}

const promoterTasks = (db: DB, pid: string) =>
  db.query("SELECT * FROM tasks WHERE project_id = ? AND source = 'promoter'").all(pid) as any[];

test("queues one evaluation task when `from` is ahead", async () => {
  const { db, projectId } = freshDb();
  await promoteOnce(db, { exec: stubExec(3) });
  const tasks = promoterTasks(db, projectId);
  expect(tasks.length).toBe(1);
  expect(tasks[0].state).toBe("queued");
  expect(tasks[0].kind).toBe("ship");
  expect(tasks[0].source_ref).toBe("abc123def");
  expect(tasks[0].title).toContain("staging → main");
  expect(tasks[0].brief).toContain("Do NOT merge it yourself");
  expect(tasks[0].brief).toContain("test comprehensiveness");
  expect(tasks[0].brief).toContain("BLOCKS promotion");
});

test("no task when not ahead, unconfigured, or a promote PR is already open", async () => {
  const { db, projectId } = freshDb();
  await promoteOnce(db, { exec: stubExec(0) });
  expect(promoterTasks(db, projectId).length).toBe(0);

  await promoteOnce(db, { exec: stubExec(2, "abc", 1) }); // open promote PR
  expect(promoterTasks(db, projectId).length).toBe(0);

  const plain = freshDb({}); // no config.promote
  await promoteOnce(plain.db, { exec: stubExec(5) });
  expect(promoterTasks(plain.db, plain.projectId).length).toBe(0);
});

test("dedup: same head is never re-evaluated; a new head is; in-flight blocks", async () => {
  const { db, projectId } = freshDb();
  await promoteOnce(db, { exec: stubExec(2, "headAAA") });
  expect(promoterTasks(db, projectId).length).toBe(1);

  // in-flight (queued) blocks even a NEW head
  await promoteOnce(db, { exec: stubExec(3, "headBBB") });
  expect(promoterTasks(db, projectId).length).toBe(1);

  // finish the first evaluation -> same head stays deduped, new head queues
  db.query("UPDATE tasks SET state = 'done' WHERE project_id = ? AND source = 'promoter'").run(projectId);
  await promoteOnce(db, { exec: stubExec(2, "headAAA") });
  expect(promoterTasks(db, projectId).length).toBe(1);
  await promoteOnce(db, { exec: stubExec(3, "headBBB") });
  expect(promoterTasks(db, projectId).length).toBe(2);
});
