import { test, expect } from "bun:test";
const { openDb, newId, now } = await import("../src/db.ts");
const { writeEvent } = await import("../src/state.ts");
const { predictScope, scopeOverlap, pathsInText, scoreScopePrediction, inFlightScope } = await import("../src/fileScope.ts");

function freshDb() {
  const db = openDb(":memory:");
  const projectId = newId("proj");
  db.query("INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)")
    .run(projectId, "p", "/repo", "{}", now());
  return { db, projectId };
}
function task(db: any, projectId: string, extra: any = {}) {
  const id = newId();
  const t = now();
  db.query(
    "INSERT INTO tasks (id, project_id, title, brief, state, kind, source, parent_task_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
  ).run(id, projectId, extra.title ?? "t", extra.brief ?? null, extra.state ?? "queued", "ship", extra.source ?? null, extra.parent_task_id ?? null, t, t);
  return { id, ...extra };
}

test("paths are read out of brief prose, links are not", () => {
  const { files, dirs } = pathsInText(
    "Fix server/src/sidecar.ts and api.ts, see https://example.com/docs/setup.md, everything under web/src/ moves"
  );
  expect(files).toContain("server/src/sidecar.ts");
  expect(files).toContain("api.ts");
  expect(files).not.toContain("docs/setup.md");
  expect(dirs).toContain("web/src/");
});

test("a bare filename overlaps the same file named in full, but two different index.ts do not", () => {
  const a = { files: ["server/src/api.ts"], dirs: [], from: [] };
  const b = { files: ["api.ts"], dirs: [], from: [] };
  expect(scopeOverlap(a, b)).toEqual(["api.ts"]);

  const x = { files: ["server/src/index.ts"], dirs: [], from: [] };
  const y = { files: ["web/src/index.ts"], dirs: [], from: [] };
  expect(scopeOverlap(x, y)).toEqual([]);
});

test("a named directory overlaps a file inside it", () => {
  const dir = { files: [], dirs: ["server/src/"], from: [] };
  const file = { files: ["server/src/api.ts"], dirs: [], from: [] };
  expect(scopeOverlap(dir, file)).toEqual(["server/src/"]);
  expect(scopeOverlap(file, dir)).toEqual(["server/src/"]);
});

test("empty scopes never overlap", () => {
  expect(scopeOverlap({ files: [], dirs: [], from: [] }, { files: ["a.ts"], dirs: [], from: [] })).toEqual([]);
});

test("a requeue inherits its predecessor's real branch files", () => {
  const { db, projectId } = freshDb();
  const parent = task(db, projectId, { state: "failed" });
  writeEvent(db, { task_id: parent.id, source: "reconciler", type: "branch_scope", payload: { base_sha: "abc", files: ["server/src/loop.ts"] } });
  const child = task(db, projectId, { source: "requeue", parent_task_id: parent.id, brief: "try again" });

  const scope = predictScope(db, { id: child.id, title: "t", brief: "try again", source: "requeue", parent_task_id: parent.id });
  expect(scope.files).toContain("server/src/loop.ts");
  expect(scope.from).toContain("predecessor");
});

test("a live task's real branch files beat the dispatch-time guess", () => {
  const { db, projectId } = freshDb();
  const t = task(db, projectId, { state: "in_progress" });
  writeEvent(db, { task_id: t.id, source: "dispatcher", type: "dispatch_scope", payload: { files: ["guess.ts"], dirs: [], from: ["brief"] } });
  expect(inFlightScope(db, t.id).files).toEqual(["guess.ts"]);
  writeEvent(db, { task_id: t.id, source: "reconciler", type: "branch_scope", payload: { base_sha: "abc", files: ["real.ts"] } });
  expect(inFlightScope(db, t.id).files).toEqual(["real.ts"]);
});

test("the guess is scored against what the branch really touched, once", () => {
  const { db, projectId } = freshDb();
  const t = task(db, projectId, { state: "in_review" });
  writeEvent(db, { task_id: t.id, source: "dispatcher", type: "dispatch_scope", payload: { files: ["server/src/api.ts", "nope.ts"], dirs: [], from: ["brief"] } });

  scoreScopePrediction(db, t.id, ["server/src/api.ts", "server/src/db.ts"]);
  scoreScopePrediction(db, t.id, ["server/src/api.ts"]); // idempotent

  const rows = db.query("SELECT payload FROM events WHERE task_id = ? AND type = 'scope_prediction_scored'").all(t.id) as any[];
  expect(rows.length).toBe(1);
  const p = JSON.parse(rows[0].payload);
  expect(p.hits).toEqual(["server/src/api.ts"]);
  expect(p.precision).toBe(0.5);
  expect(p.recall).toBe(0.5);
});

test("nothing is scored when the brief named no files", () => {
  const { db, projectId } = freshDb();
  const t = task(db, projectId, { state: "in_review" });
  scoreScopePrediction(db, t.id, ["server/src/api.ts"]);
  expect((db.query("SELECT 1 FROM events WHERE task_id = ? AND type = 'scope_prediction_scored'").all(t.id) as any[]).length).toBe(0);
});
