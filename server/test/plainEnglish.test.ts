// The plain-language bar (plainEnglish.ts) must reach every prompt that writes
// text a director reads, and repeats inside one review must not survive ingest.
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "hive-plain-"));
process.env.HIVE_HOME = HOME;

const { openDb, newId, now } = await import("../src/db.ts");
const { PLAIN_ENGLISH } = await import("../src/plainEnglish.ts");
const { composeBrief } = await import("../src/briefs.ts");
const { composePlannerPrompt } = await import("../src/planner.ts");
const { driftPrompt } = await import("../src/drift.ts");
const { autoReviewOnce } = await import("../src/reviewer.ts");
const { transition } = await import("../src/state.ts");
const { makeHandler } = await import("../src/api.ts");
import type { DB } from "../src/db.ts";
import type { Exec } from "../src/exec.ts";

function seed(): { db: DB; id: string } {
  const db = openDb(":memory:");
  const pid = newId("proj");
  const t = now();
  db.query("INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)").run(pid, "p", "/repo", "{}", t);
  const id = newId();
  db.query(
    "INSERT INTO tasks (id, project_id, title, brief, state, kind, pr_url, created_at, updated_at) VALUES (?,?,?,?, 'queued','ship',?,?,?)"
  ).run(id, pid, "add feature", "make it work", "https://gh/pr/5", t, t);
  return { db, id };
}

test("the agent brief and the planner prompt both carry the plain-English bar", () => {
  const { db, id } = seed();
  expect(composeBrief(db, id)).toContain(PLAIN_ENGLISH);
  expect(composePlannerPrompt(db, id)).toContain(PLAIN_ENGLISH);
});

test("the drift judge and the auto-reviewer both carry the plain-English bar", async () => {
  expect(driftPrompt({ brief: "b" }, { files: ["x.ts"], commits: ["c"] })).toContain(PLAIN_ENGLISH);

  const { db, id } = seed();
  transition(db, id, "in_progress");
  transition(db, id, "in_review");
  const shellExec: Exec = async (argv) =>
    argv.includes("diff")
      ? { code: 0, stdout: "+const y = 1;", stderr: "" }
      : { code: 0, stdout: JSON.stringify({ headRefOid: "review-head" }), stderr: "" };
  let prompt = "";
  await autoReviewOnce(db, {
    shellExec,
    exec: async (argv) => {
      prompt = argv[argv.length - 3];
      return { code: 0, stdout: JSON.stringify({ result: '{"verdict":"looks_good","summary":"s"}' }), stderr: "" };
    },
  });
  expect(prompt).toContain(PLAIN_ENGLISH);
});

test("a review summary states each fact once: repeated bullets and repeated quiz questions are dropped", async () => {
  const db = openDb(":memory:");
  const server = Bun.serve({ port: 0, fetch: makeHandler(db) });
  const base = `http://127.0.0.1:${server.port}`;
  const post = async (path: string, body: unknown) => {
    const res = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, json: await res.json() };
  };
  try {
    const p = await post("/api/projects", { name: "proj", repo_path: "/tmp/x" });
    const t = await post("/api/tasks", { project_id: p.json.id, title: "task" });
    const question = "What does the queue do when two edits land together?";
    const options = [{ key: "a", label: "The newest edit wins." }, { key: "b", label: "Both edits are dropped." }];
    const r = await post(`/api/tasks/${t.json.id}/events`, {
      type: "review_summary",
      done: ["The newest edit now wins.", "the newest edit now wins", "Offline saves retry once."],
      iffy: [{ what: "Retries only once.", why: "A second retry needs a queue." }, { what: "retries only once", why: "same shortcut, restated" }],
      understanding: {
        essence: "Two edits at once no longer lose the newer one.",
        walkthrough: ["An edit enters the queue.", "an edit enters the queue!"],
        affected_areas: ["Draft editor", "draft editor"],
        checks: [
          { question, options, answer_key: "a", explanation: "The queue keeps the newest edit." },
          { question: "What does the queue do, when two edits land together?", options, answer_key: "a", explanation: "restated" },
        ],
      },
    });
    expect(r.status).toBe(201);
    const payload = r.json.event.payload;
    expect(payload.done).toEqual(["The newest edit now wins.", "Offline saves retry once."]);
    expect(payload.iffy).toHaveLength(1);
    expect(payload.understanding.walkthrough).toEqual(["An edit enters the queue."]);
    expect(payload.understanding.affected_areas).toEqual(["Draft editor"]);
    expect(payload.understanding.checks).toHaveLength(1);
    expect(payload.understanding.checks[0].question).toBe(question);
  } finally {
    server.stop(true);
  }
});
