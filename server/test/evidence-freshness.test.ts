import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "hive-freshness-"));
process.env.HIVE_HOME = HOME;

const { openDb } = await import("../src/db.ts");
const { makeHandler } = await import("../src/api.ts");
const { Herdr } = await import("../src/runtime/herdr.ts");
const { evidenceAtSha } = await import("../src/state.ts");
import type { Exec, ExecResult } from "../src/exec.ts";

const OK = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const has = (argv: string[], ...xs: string[]) => xs.every((x) => argv.includes(x));

// Server whose git HEAD is a mutable closure, so a test can advance the commit
// (simulating a change-request fix push) between handoffs. gh/herdr plumbing is
// stubbed just enough to spawn and to pass the CI probe (no checks → fail open).
function makeServer(head: { sha: string; tree?: string }) {
  const db = openDb(":memory:");
  const trees = new Map<string, string>();
  const treeOf = (sha: string) => trees.get(sha) ?? sha;
  const exec: Exec = async (argv) => {
    if (has(argv, "git", "rev-parse", "HEAD")) {
      trees.set(head.sha, head.tree ?? head.sha);
      return OK(head.sha + "\n");
    }
    // `git diff --quiet A B`: 0 when the two commits hold the same tree, 1 when
    // they differ. Tests set head.tree to model a commit that rewrote history
    // without changing any file.
    if (has(argv, "git", "diff", "--quiet")) {
      const [a, b] = argv.slice(argv.indexOf("--quiet") + 1);
      return treeOf(a) === treeOf(b) ? OK() : { code: 1, stdout: "", stderr: "" };
    }
    if (has(argv, "gh", "pr", "view")) return OK(JSON.stringify({ state: "OPEN", statusCheckRollup: [] }));
    if (has(argv, "worktree", "create"))
      return OK(JSON.stringify({ result: { worktree: { path: join(HOME, "wt"), branch: "hive/x", open_workspace_id: "w1" } } }));
    if (has(argv, "agent", "get")) return OK('{"result":{"agent":{"pane_id":"p1","agent_status":"working"}}}');
    if (has(argv, "workspace", "list")) return OK('{"result":{"workspaces":[{"workspace_id":"wF","label":"hive-fleet"}]}}');
    if (has(argv, "tab", "create")) return OK('{"result":{"tab":{"tab_id":"wF:t2"}}}');
    return OK();
  };
  const herdr = new Herdr(exec, "herdr");
  const server = Bun.serve({ port: 0, fetch: makeHandler(db, { herdr, exec }) });
  return { db, server, base: `http://127.0.0.1:${server.port}` };
}

async function post(base: string, path: string, body: unknown) {
  const res = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
}

test("evidence is stamped with the worktree HEAD sha, and the ready gate rejects stale evidence", async () => {
  const head = { sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" };
  const s = makeServer(head);
  const p = await post(s.base, "/api/projects", { name: "p", repo_path: "/repo" });
  const t = await post(s.base, "/api/tasks", { project_id: p.json.id, title: "task", brief: "b" });
  const id = t.json.id;
  await post(s.base, `/api/tasks/${id}/spawn`, {}); // sets worktree_path + in_progress

  // Evidence captured at the first commit is stamped with that sha.
  const e1 = await post(s.base, `/api/tasks/${id}/events`, { type: "evidence", note: "shot", kind: "screenshot" });
  expect(e1.json.evidence.meta.commit_sha).toBe(head.sha);
  expect(evidenceAtSha(s.db, id, head.sha)).toBe(1);

  // Ready at the same commit: evidence matches HEAD → hands off.
  const r1 = await post(s.base, `/api/tasks/${id}/events`, { type: "ready", pr_url: "https://gh/pr/1" });
  expect(r1.json.task.state).toBe("in_review");

  // Change requested: bounce back, agent pushes a fix (HEAD advances).
  await post(s.base, `/api/tasks/${id}/request-changes`, { notes: "bump the page size" });
  head.sha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

  // Ready without re-capturing: old evidence is stale → HELD in_progress.
  const r2 = await post(s.base, `/api/tasks/${id}/events`, { type: "ready" });
  expect(r2.json.held).toBe(true);
  expect(r2.json.reason).toBe("stale_evidence");
  const held = await (await fetch(`${s.base}/api/tasks/${id}`)).json();
  expect(held.state).toBe("in_progress");

  // Re-capture against the new commit → gate passes, hands off.
  await post(s.base, `/api/tasks/${id}/events`, { type: "evidence", note: "fresh shot", kind: "screenshot" });
  expect(evidenceAtSha(s.db, id, head.sha)).toBe(1);
  const r3 = await post(s.base, `/api/tasks/${id}/events`, { type: "ready" });
  expect(r3.json.task.state).toBe("in_review");

  s.server.stop(true);
});

test("a stale handoff names both commits and the action, and re-emitting after a same-tree commit clears it without an agent", async () => {
  const head = { sha: "1111111111111111111111111111111111111111", tree: "treeA" };
  const s = makeServer(head);
  const p = await post(s.base, "/api/projects", { name: "p", repo_path: "/repo" });
  const t = await post(s.base, "/api/tasks", { project_id: p.json.id, title: "task", brief: "b" });
  const id = t.json.id;
  await post(s.base, `/api/tasks/${id}/spawn`, {});
  await post(s.base, `/api/tasks/${id}/events`, { type: "evidence", note: "test run", kind: "log" });

  // The agent files its review and THEN pushes a commit that really changes the
  // code. The review is refused right there, while the agent is still on its
  // turn, instead of the handoff being refused later.
  head.sha = "2222222222222222222222222222222222222222";
  head.tree = "treeB";
  const review = await post(s.base, `/api/tasks/${id}/events`, {
    type: "review_summary",
    done: ["did the thing"],
  });
  expect(review.status).toBe(409);
  expect(review.json.reason).toBe("stale_evidence");
  expect(review.json.error).toContain("1111111");
  expect(review.json.error).toContain("2222222");
  expect(review.json.action).toContain("re-capture");

  // Held at the gate too, naming both commits and what to do.
  const r1 = await post(s.base, `/api/tasks/${id}/events`, { type: "ready" });
  expect(r1.json.held).toBe(true);
  expect(r1.json.reason).toBe("stale_evidence");
  expect(r1.json.evidence_sha).toBe("1111111111111111111111111111111111111111");
  expect(r1.json.head_sha).toBe("2222222222222222222222222222222222222222");
  expect(r1.json.message).toContain("1111111");
  expect(r1.json.message).toContain("2222222");
  expect(r1.json.action).toContain("re-capture");

  // Fresh evidence, then a commit that rewrites history but changes no file
  // (an amend). The review still describes this code, so a plain re-emit hands
  // off: no re-capture, no respawn.
  await post(s.base, `/api/tasks/${id}/events`, { type: "evidence", note: "fresh run", kind: "log" });
  head.sha = "3333333333333333333333333333333333333333";
  head.tree = "treeB";
  const r2 = await post(s.base, `/api/tasks/${id}/events`, { type: "ready" });
  expect(r2.json.task.state).toBe("in_review");
  expect(evidenceAtSha(s.db, id, head.sha)).toBe(1);

  s.server.stop(true);
});

test("a genuinely current review is recorded and hands off first time", async () => {
  const head = { sha: "4444444444444444444444444444444444444444" };
  const s = makeServer(head);
  const p = await post(s.base, "/api/projects", { name: "p", repo_path: "/repo" });
  const t = await post(s.base, "/api/tasks", { project_id: p.json.id, title: "task", brief: "b" });
  const id = t.json.id;
  await post(s.base, `/api/tasks/${id}/spawn`, {});
  await post(s.base, `/api/tasks/${id}/events`, { type: "evidence", note: "test run", kind: "log" });
  const review = await post(s.base, `/api/tasks/${id}/events`, { type: "review_summary", done: ["did the thing"] });
  expect(review.status).toBe(201);
  const ready = await post(s.base, `/api/tasks/${id}/events`, { type: "ready", pr_url: "https://gh/pr/9" });
  expect(ready.json.task.state).toBe("in_review");

  s.server.stop(true);
});

// HIVE-575: the stamp comes from the task's own worktree, not from whoever
// emitted. A director driving the task from another checkout used to stamp that
// checkout's commit, which the gate then compared against the task branch —
// two unrelated repositories, so the handoff was held forever.
test("the caller cannot decide which commit the evidence is stamped with", async () => {
  const head = { sha: "5555555555555555555555555555555555555555" };
  const s = makeServer(head);
  const p = await post(s.base, "/api/projects", { name: "p", repo_path: "/repo" });
  const t = await post(s.base, "/api/tasks", { project_id: p.json.id, title: "task", brief: "b" });
  const id = t.json.id;
  await post(s.base, `/api/tasks/${id}/spawn`, {});

  // An emit carrying some other repo's HEAD is stamped with the worktree's.
  const e = await post(s.base, `/api/tasks/${id}/events`, {
    type: "evidence",
    note: "test run",
    kind: "log",
    meta: JSON.stringify({ commit_sha: "9999999999999999999999999999999999999999" }),
  });
  expect(e.json.evidence.meta.commit_sha).toBe(head.sha);

  // So the handoff goes through instead of being held against a foreign commit.
  const ready = await post(s.base, `/api/tasks/${id}/events`, { type: "ready", pr_url: "https://gh/pr/5" });
  expect(ready.json.task.state).toBe("in_review");

  s.server.stop(true);
});

// HIVE-575: an artifact with no relationship to a commit (a production reading,
// a link, a written report) is never stamped and never gated on staleness.
test("an observation is not commit-bound, so a later commit does not hold the handoff", async () => {
  const head = { sha: "6666666666666666666666666666666666666666" };
  const s = makeServer(head);
  const p = await post(s.base, "/api/projects", { name: "p", repo_path: "/repo" });
  const t = await post(s.base, "/api/tasks", { project_id: p.json.id, title: "task", brief: "b" });
  const id = t.json.id;
  await post(s.base, `/api/tasks/${id}/spawn`, {});

  const e = await post(s.base, `/api/tasks/${id}/events`, {
    type: "evidence",
    note: "row count on prod",
    kind: "observation",
  });
  expect(e.json.evidence.meta.commit_sha).toBeUndefined();

  head.sha = "7777777777777777777777777777777777777777";
  const review = await post(s.base, `/api/tasks/${id}/events`, { type: "review_summary", done: ["ran the query"] });
  expect(review.status).toBe(201);
  const ready = await post(s.base, `/api/tasks/${id}/events`, { type: "ready", pr_url: "https://gh/pr/6" });
  expect(ready.json.task.state).toBe("in_review");

  s.server.stop(true);
});

// HIVE-575: with no worktree there is no commit to stamp. Say that at emit
// time rather than silently stamping whatever repo the caller stood in.
test("evidence filed with no worktree is stored unstamped and says so", async () => {
  const head = { sha: "8888888888888888888888888888888888888888" };
  const s = makeServer(head);
  const p = await post(s.base, "/api/projects", { name: "p", repo_path: "/repo" });
  const t = await post(s.base, "/api/tasks", { project_id: p.json.id, title: "task", brief: "b" });
  const e = await post(s.base, `/api/tasks/${t.json.id}/events`, { type: "evidence", note: "log", kind: "log" });
  expect(e.json.evidence.meta.commit_sha).toBeUndefined();
  expect(e.json.warning).toContain("no worktree");

  s.server.stop(true);
});
