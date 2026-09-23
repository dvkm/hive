import { test, expect } from "bun:test";
import { openDb, newId, now, getSetting, type DB } from "../src/db.ts";
import { buildDigest } from "../src/digest.ts";
import type { Exec } from "../src/exec.ts";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-09-23T12:00:00.000Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function setup(repo: string): { db: DB; projectId: string } {
  const db = openDb(":memory:");
  const projectId = newId("proj");
  db.query("INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)").run(projectId, "acme", repo, "{}", now());
  return { db, projectId };
}

function task(db: DB, projectId: string, title: string, state: string, extra: Record<string, unknown> = {}): string {
  const id = newId();
  const row: Record<string, unknown> = { id, project_id: projectId, title, state, kind: "ship", created_at: iso(1000), updated_at: iso(1000), ...extra };
  const cols = Object.keys(row);
  db.query(`INSERT INTO tasks (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...(Object.values(row) as any[]));
  return id;
}

// gh answers with merged PRs; anything older than the window is filtered out.
function gh(prs: object[]): { exec: Exec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: Exec = async (argv) => {
    calls.push(argv);
    return { code: 0, stdout: JSON.stringify(prs), stderr: "" };
  };
  return { exec, calls };
}

test("the digest says what shipped (hive's work and anyone else's), what hive decided, what is stuck and what is moving", async () => {
  const { db, projectId } = setup("/repo/digest-a");
  const mine = task(db, projectId, "view counts", "verifying", { pr_url: "https://github.com/o/r/pull/2" });
  const { exec } = gh([
    { number: 2, title: "[hive-2261] fix(api): count insight views", url: "https://github.com/o/r/pull/2", mergedAt: iso(2 * 3600_000), headRefName: "hive/x" },
    { number: 3, title: "ci: run on the small runner", url: "https://github.com/o/r/pull/3", mergedAt: iso(3600_000), headRefName: "claude/ci" },
    { number: 1, title: "too old", url: "https://github.com/o/r/pull/1", mergedAt: iso(3 * DAY), headRefName: "x" },
  ]);

  const decidedTask = task(db, projectId, "dedupe", "in_progress");
  db.query("INSERT INTO decisions (id, task_id, ts, title, options, status, answer_key, answer_note, answered_at, answered_by) VALUES (?,?,?,?,?, 'answered', 'merge', 'Hive decided: exact duplicate', ?, 'system')")
    .run(newId("dec"), decidedTask, iso(5000), "Close the duplicate?", JSON.stringify([{ key: "merge", label: "Close it" }]), iso(4000));
  db.query("INSERT INTO decisions (id, task_id, ts, title, options, status, answer_key, answered_at, answered_by) VALUES (?,?,?,?,?, 'answered', 'go', ?, 'director')")
    .run(newId("dec"), decidedTask, iso(5000), "Your own call", JSON.stringify([{ key: "go", label: "Go" }]), iso(4000));

  const stuck = task(db, projectId, "worktree move", "failed", { updated_at: iso(2000) });
  db.query("INSERT INTO events (id, task_id, ts, source, type, payload) VALUES (?,?,?,?,?,?)")
    .run(newId("ev"), stuck, iso(2000), "reconciler", "state_change", JSON.stringify({ from: "in_progress", to: "failed", reason: "agent silent; 3 nudges ignored" }));
  const retried = task(db, projectId, "retried", "failed", { updated_at: iso(2000) });
  task(db, projectId, "retried", "queued", { source: "requeue", parent_task_id: retried });
  task(db, projectId, "mirror of a ticket", "in_progress", { jira_key: "ABC-13", jira_link_kind: "mirror", source: "external", created_at: iso(1000) });
  const scout = task(db, projectId, "Why is search slow?", "verifying", { kind: "scout" });
  db.query("INSERT INTO events (id, task_id, ts, source, type, payload) VALUES (?,?,?,?,?,?)")
    .run(newId("ev"), scout, iso(1500), "reconciler", "state_change", JSON.stringify({ from: "in_review", to: "verifying" }));
  db.query("INSERT INTO evidence (id, task_id, ts, kind, path, url, caption, meta) VALUES (?,?,?,?,?,?,?,'{}')")
    .run(newId("ev"), scout, iso(1600), "report", "/tmp/r.md", `/evidence/${scout}/r.md`, "findings");

  const d = await buildDigest(db, { exec, nowMs: NOW });
  const p = d.projects[0];
  expect(p.shipped.map((s) => s.title)).toEqual(["ci: run on the small runner", "fix(api): count insight views"]);
  expect(p.shipped_total).toBe(2);
  expect(p.shipped.find((s) => s.url.endsWith("/2"))!.task_id).toBe(mine);
  expect(p.decided).toEqual([expect.objectContaining({ question: "Close the duplicate?", answer: "Close it", why: "Hive decided: exact duplicate" })]);
  expect(p.stuck.map((s) => [s.title, s.reason])).toEqual([["worktree move", "agent silent; 3 nudges ignored"]]);
  expect(p.working.map((w) => w.title)).toEqual(["dedupe"]);
  expect(p.queued).toBe(1);
  expect(p.new_requests.map((r) => r.key)).toEqual(["ABC-13"]);
  expect(p.reports).toEqual([{ task_id: scout, title: "Why is search slow?", url: `/evidence/${scout}/r.md`, at: iso(1500) }]);
});

test("the window runs from the last look, and always covers at least the last day", async () => {
  const { db } = setup("/repo/digest-b");
  const { exec } = gh([]);
  const first = await buildDigest(db, { exec, nowMs: NOW });
  expect(first.since).toBe(iso(DAY)); // never looked: the last day
  await buildDigest(db, { exec, nowMs: NOW, mark: true });
  expect(getSetting(db, "digest_seen_at")).toBe(new Date(NOW).toISOString());
  // Looked a minute ago: a refresh still shows the whole last day.
  expect((await buildDigest(db, { exec, nowMs: NOW + 60_000 })).since).toBe(new Date(NOW + 60_000 - DAY).toISOString());
  // Away for three days: the window reaches back to the last look.
  expect((await buildDigest(db, { exec, nowMs: NOW + 3 * DAY })).since).toBe(new Date(NOW).toISOString());
});

test("a checkout with no GitHub remote reports nothing shipped and no error; a GitHub failure says so", async () => {
  const noRemote = setup("/repo/digest-c");
  const none: Exec = async () => ({ code: 1, stdout: "", stderr: "none of the git remotes configured for this repository point to a known GitHub host" });
  const quiet = (await buildDigest(noRemote.db, { exec: none, nowMs: NOW })).projects[0];
  expect(quiet.shipped).toEqual([]);
  expect(quiet.github_error).toBeUndefined();

  const down = setup("/repo/digest-d");
  const failing: Exec = async () => ({ code: 1, stdout: "", stderr: "HTTP 502" });
  expect((await buildDigest(down.db, { exec: failing, nowMs: NOW })).projects[0].github_error).toBe("GitHub could not be read");
});
