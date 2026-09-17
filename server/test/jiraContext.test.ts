// The review-context comment hive leaves on a Jira ticket: only when there is
// something a reporter can act on, never for a bare status flip, and never
// with a loopback link nobody else can open.
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { openDb, newId, now } = await import("../src/db.ts");
const { writeEvent } = await import("../src/state.ts");
const J = await import("../src/intake/jira.ts");

function freshDb() {
  const db = openDb(join(mkdtempSync(join(tmpdir(), "hive-jira-ctx-")), "t.db"));
  db.query("INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)").run("proj", "web", "/tmp/web", "{}", now());
  return db;
}
function task(db: any, extra: Record<string, unknown> = {}) {
  const id = newId();
  db.query(
    "INSERT INTO tasks (id, number, project_id, title, state, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(id, 1, "proj", "WEB-156 hotel section", "in_review", "ship", now(), now());
  return { id, number: 1, title: "WEB-156 hotel section", state: "in_review", pr_url: null, ...extra };
}

test("a bare status flip posts nothing: the internal state reason is not a headline", () => {
  const db = freshDb();
  const t = task(db);
  writeEvent(db, { task_id: t.id, source: "herdr", type: "state_change", payload: { to: "in_review", reason: "hive work for WEB-156 is in_review" } });
  expect(J.reviewContextText(db, t, "In Review")).toBeNull();
});

test("a PR or evidence makes a comment, and the loopback hive link is left out", () => {
  const db = freshDb();
  const t = task(db, { pr_url: "https://github.com/acme/web/pull/1319" });
  const text = J.reviewContextText(db, t, "In Review")!;
  expect(text).toContain("PR: https://github.com/acme/web/pull/1319");
  expect(text).not.toContain("127.0.0.1");
  expect(text).not.toContain("hive work for");
  expect(J.isLoopbackUrl("http://127.0.0.1:4700")).toBe(true);
  expect(J.isLoopbackUrl("https://mac.tail1234.ts.net")).toBe(false);
});
