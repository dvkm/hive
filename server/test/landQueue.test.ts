import { test, expect } from "bun:test";
import { openDb, newId, now, type DB } from "../src/db.ts";
import { landGraph, landOnce, markLand } from "../src/landQueue.ts";
import { transition } from "../src/state.ts";
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

function makeTask(
  db: DB,
  projectId: string,
  extra: { title?: string; branch?: string; state?: string; ci_status?: string; brief?: string; depends_on?: string[] } = {}
): string {
  const id = newId();
  const t = now();
  db.query(
    `INSERT INTO tasks (id, project_id, title, brief, state, kind, branch, ci_status, depends_on, created_at, updated_at)
     VALUES (?,?,?,?,?,'ship',?,?,?,?,?)`
  ).run(
    id, projectId, extra.title ?? "t", extra.brief ?? "", extra.state ?? "in_review", extra.branch ?? null,
    extra.ci_status ?? "passing", extra.depends_on ? JSON.stringify(extra.depends_on) : null, t, t
  );
  return id;
}

// `git diff --name-only main...<branch>` per branch — the only git the graph reads.
const filesExec = (byBranch: Record<string, string[]>): Exec => async (argv) => {
  const spec = argv[argv.length - 1];
  const branch = String(spec).split("...")[1] ?? "";
  return OK((byBranch[branch] ?? []).join("\n"));
};

// A merge stub that lands the task the way mergeTask would (in_review →
// verifying), so the sweep sees the state change. `red` never merges.
function mergeStub(db: DB, failing: Record<string, string> = {}) {
  const calls: string[] = [];
  const merge = async (id: string) => {
    calls.push(id);
    if (failing[id]) return { ok: false, reason: failing[id] };
    transition(db, id, "verifying", { source: "director", reason: "test merge" });
    return { ok: true };
  };
  return { calls, merge };
}

test("conflict edges come from overlapping files; independent branches get none", async () => {
  const { db, projectId } = freshDb();
  const a = makeTask(db, projectId, { branch: "a" });
  const b = makeTask(db, projectId, { branch: "b" });
  const c = makeTask(db, projectId, { branch: "c" });
  const exec = filesExec({ a: ["src/a.ts"], b: ["src/shared.ts"], c: ["src/shared.ts", "src/c.ts"] });

  const { edges } = await landGraph(db, projectId, exec);
  expect(edges).toEqual([{ from: b, to: c, kind: "conflict", files: ["src/shared.ts"] }]);
  expect(edges.some((e) => e.from === a || e.to === a)).toBe(false);
});

test("declared and brief-written dependencies both become 'depends' edges", async () => {
  const { db, projectId } = freshDb();
  const a = makeTask(db, projectId, { branch: "a" });
  const aNumber = (db.query("SELECT number FROM tasks WHERE id = ?").get(a) as any).number;
  const b = makeTask(db, projectId, { branch: "b", depends_on: [a] });
  const c = makeTask(db, projectId, { branch: "c", brief: `Do the thing. Lands after #${aNumber}.` });
  const { edges } = await landGraph(db, projectId, filesExec({}));
  expect(edges).toEqual([
    { from: a, to: b, kind: "depends" },
    { from: a, to: c, kind: "depends" },
  ]);
});

// The brief's regression test: A is independent, B and C both touch a file A
// does not. A lands alongside the first of B/C; the second waits a sweep. A red
// CI on B must not hold C back.
test("independent PRs land together, conflicting ones serialize", async () => {
  const { db, projectId } = freshDb();
  const a = makeTask(db, projectId, { branch: "a" });
  const b = makeTask(db, projectId, { branch: "b" });
  const c = makeTask(db, projectId, { branch: "c" });
  const exec = filesExec({ a: ["src/a.ts"], b: ["src/shared.ts"], c: ["src/shared.ts"] });
  markLand(db, [a, b, c], true);

  const calls: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const firstSweep = landOnce(db, {
    exec,
    merge: async (id) => {
      calls.push(id);
      await gate;
      transition(db, id, "verifying", { source: "director", reason: "test merge" });
      return { ok: true };
    },
  });
  await Bun.sleep(0);
  expect(calls).toEqual([a, b]); // both started before either merge finished
  release();
  await firstSweep;

  // Next sweep: B has merged, so C is unblocked and lands on its own.
  const second = mergeStub(db);
  await landOnce(db, { exec, merge: second.merge });
  expect(second.calls).toEqual([c]);
  expect((db.query("SELECT land_queued_at FROM tasks WHERE id = ?").get(c) as any).land_queued_at).toBeNull();
});

test("a red CI on one PR never blocks the PR that conflicts with it", async () => {
  const { db, projectId } = freshDb();
  const a = makeTask(db, projectId, { branch: "a" });
  const b = makeTask(db, projectId, { branch: "b", ci_status: "failing" });
  const c = makeTask(db, projectId, { branch: "c" });
  const exec = filesExec({ a: ["src/a.ts"], b: ["src/shared.ts"], c: ["src/shared.ts"] });
  markLand(db, [a, b, c], true);

  const { calls, merge } = mergeStub(db);
  await landOnce(db, { exec, merge });
  expect(calls).toEqual([a, c]); // B held on red CI, C lands in its place
  // B keeps its mark: red CI is a hold, not a drop.
  expect((db.query("SELECT land_queued_at FROM tasks WHERE id = ?").get(b) as any).land_queued_at).toBeTruthy();
});

test("a declared dependency lands first, and holds its dependent until it has merged", async () => {
  const { db, projectId } = freshDb();
  const a = makeTask(db, projectId, { branch: "a", ci_status: "pending" });
  const b = makeTask(db, projectId, { branch: "b", depends_on: [a] });
  markLand(db, [a, b], true);
  const held = mergeStub(db);
  await landOnce(db, { exec: filesExec({}), merge: held.merge });
  expect(held.calls).toEqual([]); // A is not green yet, so B waits too

  db.query("UPDATE tasks SET ci_status = 'passing' WHERE id = ?").run(a);
  const go = mergeStub(db);
  await landOnce(db, { exec: filesExec({}), merge: go.merge });
  expect(go.calls).toEqual([a, b]);
});

test("failed merges drop out of the queue and raise one decision", async () => {
  const { db, projectId } = freshDb();
  const a = makeTask(db, projectId, { branch: "a" });
  const b = makeTask(db, projectId, { branch: "b" });
  markLand(db, [a, b], true);
  const { calls, merge } = mergeStub(db, { [a]: "PR has merge conflicts", [b]: "CI blocked" });
  await landOnce(db, { exec: filesExec({}), merge });
  expect(calls).toEqual([a, b]);
  for (const id of [a, b])
    expect((db.query("SELECT land_queued_at FROM tasks WHERE id = ?").get(id) as any).land_queued_at).toBeNull();
  const notes = db.query("SELECT title, body FROM notifications").all() as any[];
  expect(notes.length).toBe(1);
  expect(notes[0].title).toContain("2 PRs paused");
  expect((db.query("SELECT COUNT(*) AS n FROM decisions WHERE status = 'open'").get() as any).n).toBe(1);
});

test("leaving review clears the mark: the approval was for that diff", async () => {
  const { db, projectId } = freshDb();
  const a = makeTask(db, projectId, { branch: "a" });
  markLand(db, [a], true);
  transition(db, a, "in_progress", { source: "director", reason: "changes requested" });
  const { calls, merge } = mergeStub(db);
  await landOnce(db, { exec: filesExec({}), merge });
  expect(calls).toEqual([]);
  expect((db.query("SELECT land_queued_at FROM tasks WHERE id = ?").get(a) as any).land_queued_at).toBeNull();
});
