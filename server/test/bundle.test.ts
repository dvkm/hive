import { test, expect, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HIVE_HOME = mkdtempSync(join(tmpdir(), "hive-bundle-"));

const { openDb, newId, now } = await import("../src/db.ts");
const { createDecision, decisionBundle } = await import("../src/api.ts");

const db = openDb(":memory:");
const projectId = newId("proj");
const taskId = newId("task");

beforeAll(() => {
  db.query("INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)").run(
    projectId, "p", "/tmp/x", "{}", now()
  );
  db.query(
    "INSERT INTO tasks (id, project_id, title, state, kind, pr_url, branch, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)"
  ).run(taskId, projectId, "t", "in_progress", "ship", "https://github.com/o/r/pull/7", "hive/x", now(), now());
  db.query("INSERT INTO usage (id, task_id, ts, model, cost_usd) VALUES (?,?,?,?,?)").run(
    newId("u"), taskId, now(), "claude", 1.5
  );
});

test("bundle carries PR, branch, and rounded task spend", () => {
  const b = decisionBundle(db, taskId, "none");
  expect(b.pr_url).toBe("https://github.com/o/r/pull/7");
  expect(b.branch).toBe("hive/x");
  expect(b.task_display_id).toBe("P-1");
  expect(b.spend_usd).toBe(1.5);
  expect(b.prior_decisions).toEqual([]);
});

test("prior_decisions lists answered same-project cards with the chosen label, newest first", () => {
  // An answered decision on the same project becomes prior context...
  const answered = createDecision(db, {
    task_id: taskId,
    title: "earlier call",
    options: [{ key: "a", label: "Ship it" }, { key: "b", label: "Hold" }],
  });
  db.query("UPDATE decisions SET status='answered', answer_key='a', answered_at=? WHERE id=?").run(now(), answered.id);

  // ...but only for OTHER cards, never the one being decided.
  const open = createDecision(db, { task_id: taskId, title: "current call", options: [{ key: "x", label: "X" }] });
  expect(open.bundle.prior_decisions.map((p: any) => p.id)).toContain(answered.id);
  expect(open.bundle.prior_decisions.find((p: any) => p.id === answered.id).answer).toBe("Ship it");

  const b = decisionBundle(db, taskId, answered.id);
  expect(b.prior_decisions.some((p: any) => p.id === answered.id)).toBe(false);
});
