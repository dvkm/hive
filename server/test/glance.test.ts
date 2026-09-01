import { test, expect } from "bun:test";
import { openDb, newId, now, type DB } from "../src/db.ts";
import { HEADLINE_MAX, areasFromFiles, catchupCards, headline, parseNumstat } from "../src/glance.ts";
import type { ExecResult } from "../src/exec.ts";

const OK = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });

function seed(): { db: DB; projectId: string } {
  const db = openDb(":memory:");
  const projectId = newId("proj");
  db.query("INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)").run(
    projectId, "hive", "/repo", "{}", now()
  );
  return { db, projectId };
}

function shipped(db: DB, projectId: string, over: Record<string, unknown> = {}): string {
  const id = newId();
  const t = now();
  db.query(
    "INSERT INTO tasks (id, project_id, title, state, kind, pr_url, branch, summary, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
  ).run(
    id, projectId,
    (over.title as string) ?? "Ship the thing",
    (over.state as string) ?? "done",
    "ship",
    (over.pr_url as string) ?? "https://github.com/x/y/pull/1",
    "hive/x",
    (over.summary as string) ?? null,
    t, t
  );
  return id;
}

test("the headline is one line, capped, and cut at a word boundary", () => {
  const paragraph =
    "This change rewrites the review card so the director sees a picture first, " +
    "and it also moves the diff stats into the server, and then it adds a route, " +
    "and finally it wires the nav entry as well.";
  const line = headline(paragraph);
  expect(line.length).toBeLessThanOrEqual(HEADLINE_MAX + 1); // +1 for the ellipsis
  expect(line).not.toContain("\n");
  expect(line.endsWith("…")).toBe(true);
  expect(line.endsWith(" …")).toBe(false);
});

test("a first sentence that already fits is kept whole, with no ellipsis", () => {
  const line = headline("Catchup now shows a picture per change. The long page is unchanged and one click away.");
  expect(line).toBe("Catchup now shows a picture per change.");
});

test("multi-line whitespace collapses instead of rendering as prose", () => {
  expect(headline("  first\n\n  second  ")).toBe("first second");
  expect(headline(null)).toBe("");
});

test("areas roll files up to two path segments, biggest churn first", () => {
  const areas = areasFromFiles([
    { path: "web/src/views/Catchup.tsx", additions: 100, deletions: 0 },
    { path: "web/src/styles.css", additions: 40, deletions: 2 },
    { path: "server/src/glance.ts", additions: 10, deletions: 1 },
    { path: "README.md", additions: 1, deletions: 1 },
  ]);
  expect(areas).toEqual([
    { area: "web/src", churn: 142 },
    { area: "server/src", churn: 11 },
    { area: "(root)", churn: 2 },
  ]);
});

test("numstat counts a binary file as touched with no churn", () => {
  expect(parseNumstat("10\t2\tweb/src/a.ts\n-\t-\tweb/public/logo.png\n\n")).toEqual([
    { path: "web/src/a.ts", additions: 10, deletions: 2 },
    { path: "web/public/logo.png", additions: 0, deletions: 0 },
  ]);
});

test("a card carries the capped headline, the diff shape and how it shipped", async () => {
  const { db, projectId } = seed();
  const id = shipped(db, projectId);
  db.query("INSERT INTO events (id, task_id, ts, source, type, payload) VALUES (?,?,?,?,?,?)").run(
    newId(), id, now(), "agent", "review_summary",
    JSON.stringify({ understanding: { essence: "The catchup page now shows a picture per change." } })
  );
  db.query("INSERT INTO events (id, task_id, ts, source, type, payload) VALUES (?,?,?,?,?,?)").run(
    newId(), id, now(), "reconciler", "auto_merged", JSON.stringify({ ok: true })
  );
  db.query("INSERT INTO evidence (id, task_id, ts, kind, url, caption, meta) VALUES (?,?,?,?,?,?,?)").run(
    newId("ev"), id, now(), "explanation", "/evidence/x/explain.html", "why", "{}"
  );

  const files = JSON.stringify({ files: [{ path: "web/src/views/Catchup.tsx", additions: 120, deletions: 4 }] });
  const [card] = await catchupCards(db, {}, async (argv) => (argv[0] === "gh" ? OK(files) : OK()));

  expect(card.headline).toBe("The catchup page now shows a picture per change.");
  expect(card.merged_by).toBe("auto");
  expect(card.files).toBe(1);
  expect(card.additions).toBe(120);
  expect(card.deletions).toBe(4);
  expect(card.areas).toEqual([{ area: "web/src", churn: 124 }]);
  expect(card.explanation_url).toBe("/evidence/x/explain.html");
});

test("a before/after render_proof pair is returned in time order", async () => {
  const { db, projectId } = seed();
  const id = shipped(db, projectId, { pr_url: "" });
  const add = (phase: string, url: string) =>
    db.query("INSERT INTO evidence (id, task_id, ts, kind, url, caption, meta) VALUES (?,?,?,?,?,?,?)").run(
      newId("ev"), id, now(), "screenshot", url, phase, JSON.stringify({ render_phase: phase })
    );
  add("after", "/evidence/x/after.png");
  add("before", "/evidence/x/before.png");

  const [card] = await catchupCards(db, {}, async () => OK());
  expect(card.images.map((i) => i.phase)).toEqual(["before", "after"]);
  expect(card.images[0].url).toBe("/evidence/x/before.png");
});

test("a director merge reads as the director's, and an unmerged task as neither", async () => {
  const { db, projectId } = seed();
  const mine = shipped(db, projectId, { pr_url: "" });
  db.query("INSERT INTO events (id, task_id, ts, source, type, payload) VALUES (?,?,?,?,?,?)").run(
    newId(), mine, now(), "director", "merged", "{}"
  );
  const [card] = await catchupCards(db, {}, async () => OK());
  expect(card.merged_by).toBe("director");

  const { db: db2, projectId: p2 } = seed();
  shipped(db2, p2, { pr_url: "" });
  const [plain] = await catchupCards(db2, {}, async () => OK());
  expect(plain.merged_by).toBe(null);
});

test("only shipped tasks appear, newest first, capped by the limit", async () => {
  const { db, projectId } = seed();
  shipped(db, projectId, { pr_url: "", title: "older" });
  shipped(db, projectId, { pr_url: "", title: "newer" });
  shipped(db, projectId, { pr_url: "", title: "still open", state: "in_review" });

  const cards = await catchupCards(db, { limit: 5 }, async () => OK());
  expect(cards.map((c) => c.title).sort()).toEqual(["newer", "older"]);
  expect((await catchupCards(db, { limit: 1 }, async () => OK())).length).toBe(1);
});

test("no review_summary falls back to the task's own summary, still capped", async () => {
  const { db, projectId } = seed();
  shipped(db, projectId, { pr_url: "", summary: "x".repeat(400) });
  const [card] = await catchupCards(db, {}, async () => OK());
  expect(card.headline.length).toBe(HEADLINE_MAX + 1);
});

test("an essence too short to say anything gives way to the task title", async () => {
  const { db, projectId } = seed();
  const id = shipped(db, projectId, { pr_url: "", title: "Stop the reconciler retiring live cards" });
  db.query("INSERT INTO events (id, task_id, ts, source, type, payload) VALUES (?,?,?,?,?,?)").run(
    newId(), id, now(), "agent", "review_summary", JSON.stringify({ understanding: { essence: "Two changes." } })
  );
  const [card] = await catchupCards(db, {}, async () => OK());
  expect(card.headline).toBe("Stop the reconciler retiring live cards");
});

test("a git diff that fails reads as unavailable, not as a change with no files", async () => {
  const { db, projectId } = seed();
  shipped(db, projectId, { pr_url: "" });
  // A wrong repo_path or a branch that no longer exists: git exits non-zero.
  const fail = async (): Promise<ExecResult> => ({ code: 128, stdout: "", stderr: "fatal: bad revision" });

  const [card] = await catchupCards(db, {}, fail);
  expect(card.diff_unavailable).toBe(true);
  expect(card.files).toBe(0);

  // The failure is not cached, so the next read gets the real answer.
  const [again] = await catchupCards(db, {}, async () => OK("3\t1\tserver/src/glance.ts\n"));
  expect(again.diff_unavailable).toBe(false);
  expect(again.files).toBe(1);
});

test("an empty diff that git really reported is a 0, not an unavailable", async () => {
  const { db, projectId } = seed();
  shipped(db, projectId, { pr_url: "" });
  const [card] = await catchupCards(db, {}, async () => OK());
  expect(card.diff_unavailable).toBe(false);
  expect(card.files).toBe(0);
});
