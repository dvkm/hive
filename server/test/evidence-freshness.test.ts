import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "hive-freshness-"));
process.env.HIVE_HOME = HOME;

const { openDb } = await import("../src/db.ts");
const { makeHandler } = await import("../src/api.ts");
const { Herdr } = await import("../src/runtime/herdr.ts");
const { evidenceAtSha, startRecoveryEpoch } = await import("../src/state.ts");
import type { Exec, ExecResult } from "../src/exec.ts";

const OK = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const has = (argv: string[], ...xs: string[]) => xs.every((x) => argv.includes(x));

// Server whose git HEAD is a mutable closure, so a test can advance the commit
// (simulating a change-request fix push) between handoffs. gh/herdr plumbing is
// stubbed just enough to spawn and to pass the CI probe (no checks → fail open).
function makeServer(head: { sha: string }) {
  const db = openDb(":memory:");
  const exec: Exec = async (argv) => {
    if (has(argv, "git", "rev-parse", "HEAD")) return OK(head.sha + "\n");
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

test("evidence captured through the ordinary emit path counts toward a recovery attempt", async () => {
  const head = { sha: "cccccccccccccccccccccccccccccccccccccccc" };
  const s = makeServer(head);
  const p = await post(s.base, "/api/projects", { name: "p", repo_path: "/repo" });
  const t = await post(s.base, "/api/tasks", { project_id: p.json.id, title: "task", brief: "b" });
  const id = t.json.id;
  await post(s.base, `/api/tasks/${id}/spawn`, {});

  // A recovery epoch opens for the replacement agent's attempt, as reconciler.ts
  // does on requeue. Production evidence writes never stamp meta.attempt_id, so
  // the scoped count must not require it — only rowid > floor.
  startRecoveryEpoch(s.db, id, "reconciler", "attempt-1");

  await post(s.base, `/api/tasks/${id}/events`, { type: "evidence", note: "proof", kind: "log" });
  const r = await post(s.base, `/api/tasks/${id}/events`, { type: "ready" });
  expect(r.json.held).toBeUndefined();
  expect(r.json.task.state).toBe("in_review");

  s.server.stop(true);
});
