// HIVE-348: the board's divergence radar.
import { test, expect } from "bun:test";
import { openDb, newId, now, type DB } from "../src/db.ts";
import { divergence } from "../src/divergence.ts";
import type { Exec, ExecResult } from "../src/exec.ts";

const OK = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });

function freshDb(): { db: DB; projectId: string } {
  const db = openDb(":memory:");
  const projectId = newId("proj");
  db.query("INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)").run(
    projectId, "p", "/repo", JSON.stringify({ default_branch: "main" }), now()
  );
  return { db, projectId };
}

function makeTask(db: DB, projectId: string, branch: string | null, state = "in_progress"): string {
  const id = newId();
  const t = now();
  db.query(
    `INSERT INTO tasks (id, project_id, title, state, kind, branch, created_at, updated_at)
     VALUES (?,?,?,?,'ship',?,?,?)`
  ).run(id, projectId, `task ${branch}`, state, branch, t, t);
  return id;
}

// Routes the two git reads the radar makes: the three-dot authored diff and the
// behind count.
function gitExec(files: Record<string, string[]>, behind: Record<string, number>): Exec {
  return async (argv) => {
    if (argv.includes("diff")) {
      const branch = String(argv.at(-1)).split("...")[1] ?? "";
      return OK((files[branch] ?? []).join("\n"));
    }
    if (argv.includes("rev-list")) {
      const branch = String(argv.at(-1)).split("..")[0] ?? "";
      return OK(String(behind[branch] ?? 0));
    }
    return OK();
  };
}

test("reports how far each in-flight branch trails the branch it lands on", async () => {
  const { db, projectId } = freshDb();
  makeTask(db, projectId, "a");
  makeTask(db, projectId, "b");
  const { base, rows } = await divergence(db, projectId, gitExec({ a: ["src/a.ts"], b: ["src/b.ts"] }, { a: 12, b: 0 }));
  expect(base).toBe("origin/main");
  expect(rows.map((r) => [r.branch, r.behind])).toEqual([["a", 12], ["b", 0]]);
  expect(rows.every((r) => r.overlaps.length === 0)).toBe(true);
});

test("branches editing the same file list each other, with the files", async () => {
  const { db, projectId } = freshDb();
  const a = makeTask(db, projectId, "a");
  const b = makeTask(db, projectId, "b", "in_review");
  makeTask(db, projectId, "c");
  const exec = gitExec({ a: ["src/shared.ts", "src/a.ts"], b: ["src/shared.ts"], c: ["src/c.ts"] }, {});
  const { rows } = await divergence(db, projectId, exec);
  const byId = new Map(rows.map((r) => [r.id, r]));
  expect(byId.get(a)!.overlaps).toEqual([{ task_id: b, number: byId.get(b)!.number, files: ["src/shared.ts"] }]);
  expect(byId.get(b)!.overlaps).toEqual([{ task_id: a, number: byId.get(a)!.number, files: ["src/shared.ts"] }]);
  expect(rows.find((r) => r.branch === "c")!.overlaps).toEqual([]);
});

test("merged and unstarted work is not on the radar", async () => {
  const { db, projectId } = freshDb();
  makeTask(db, projectId, "a");
  makeTask(db, projectId, "merged", "done");
  makeTask(db, projectId, "shipping", "verifying");
  makeTask(db, projectId, null, "queued");
  const { rows } = await divergence(db, projectId, gitExec({ a: ["src/a.ts"] }, {}));
  expect(rows.map((r) => r.branch)).toEqual(["a"]);
});

test("a git failure reads as 'cannot tell', never as zero", async () => {
  const { db, projectId } = freshDb();
  makeTask(db, projectId, "a");
  const failing: Exec = async () => ({ code: 128, stdout: "", stderr: "bad revision" });
  const { rows } = await divergence(db, projectId, failing);
  expect(rows[0].behind).toBe(null);
  expect(rows[0].files).toBe(0);
  expect(rows[0].overlaps).toEqual([]);
});

test("a project with no repo path yields no rows instead of shelling out", async () => {
  const db = openDb(":memory:");
  const projectId = newId("proj");
  db.query("INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)").run(
    projectId, "p", null, "{}", now()
  );
  makeTask(db, projectId, "a");
  let called = false;
  const { rows } = await divergence(db, projectId, async () => {
    called = true;
    return OK();
  });
  expect(rows).toEqual([]);
  expect(called).toBe(false);
});
