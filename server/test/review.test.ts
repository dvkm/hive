import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "hive-review-"));
process.env.HIVE_HOME = HOME;

const { openDb } = await import("../src/db.ts");
const { makeHandler } = await import("../src/api.ts");
const { Herdr } = await import("../src/runtime/herdr.ts");
const { parseUnifiedDiff, taskDiff, MAX_DIFF_LINES } = await import("../src/diff.ts");
import type { Exec, ExecResult } from "../src/exec.ts";

const OK = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const has = (argv: string[], ...xs: string[]) => xs.every((x) => argv.includes(x));

// ---- diff parsing (pure) ----

const SAMPLE = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@ func()
 context line
-removed line
+added line one
+added line two
diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 000..333
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,2 @@
+hello
+world
`;

test("parseUnifiedDiff splits multiple files and classifies add/del/ctx", () => {
  const r = parseUnifiedDiff(SAMPLE);
  expect(r.truncated).toBe(false);
  expect(r.files.length).toBe(2);

  const a = r.files[0];
  expect(a.path).toBe("src/a.ts");
  expect(a.additions).toBe(2);
  expect(a.deletions).toBe(1);
  expect(a.hunks.length).toBe(1);
  expect(a.hunks[0].header).toContain("@@ -1,3 +1,4 @@");
  const kinds = a.hunks[0].lines.map((l) => l.kind);
  expect(kinds).toEqual(["ctx", "del", "add", "add"]);
  expect(a.hunks[0].lines[2].text).toBe("added line one");

  const b = r.files[1];
  expect(b.path).toBe("src/new.ts"); // taken from +++ (--- is /dev/null)
  expect(b.additions).toBe(2);
  expect(b.deletions).toBe(0);
});

test("parseUnifiedDiff marks binary files and truncates past the cap", () => {
  const bin = `diff --git a/img.png b/img.png
index 1..2 100644
Binary files a/img.png and b/img.png differ
`;
  const rb = parseUnifiedDiff(bin);
  expect(rb.files[0].binary).toBe(true);
  expect(rb.files[0].hunks.length).toBe(0);

  // Build a diff with more lines than a tiny cap → truncated.
  let big = "diff --git a/big.txt b/big.txt\n--- a/big.txt\n+++ b/big.txt\n@@ -0,0 +1,50 @@\n";
  for (let i = 0; i < 50; i++) big += `+line ${i}\n`;
  const rt = parseUnifiedDiff(big, 10);
  expect(rt.truncated).toBe(true);
  expect(MAX_DIFF_LINES).toBeGreaterThan(0);
});

// ---- taskDiff source selection (injected exec) ----

test("taskDiff uses git diff base...branch for a branch task, gh for a PR task", async () => {
  const db = openDb(":memory:");
  // seed directly
  db.query("INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)")
    .run("proj1", "p", "/repo", JSON.stringify({ default_branch: "main" }), new Date().toISOString());
  const t = new Date().toISOString();
  db.query("INSERT INTO tasks (id, project_id, title, state, kind, branch, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)")
    .run("task1", "proj1", "t", "in_review", "ship", "hive/task1", t, t);

  let seen: string[] = [];
  const gitExec: Exec = async (argv) => {
    seen = argv;
    return OK(SAMPLE);
  };
  const rg = await taskDiff(db, "task1", gitExec);
  expect(rg.ok).toBe(true);
  expect(has(seen, "git", "diff", "main...hive/task1")).toBe(true);

  // now give it a PR url → gh path
  db.query("UPDATE tasks SET pr_url = ? WHERE id = ?").run("https://gh/pr/1", "task1");
  const ghExec: Exec = async (argv) => {
    seen = argv;
    return OK(SAMPLE);
  };
  const rp = await taskDiff(db, "task1", ghExec);
  expect(rp.ok).toBe(true);
  expect(has(seen, "gh", "pr", "diff", "https://gh/pr/1", "--patch")).toBe(true);
});

// ---- full server: merge / request-changes / reject / brief ----

// Build a fresh server whose git/gh + herdr are stubbed. `gitMergeCode` controls
// the local merge outcome (0 = success, non-zero = conflict).
function makeServer(opts: { gitMergeCode?: number; gitMergeStderr?: string } = {}) {
  const db = openDb(":memory:");
  const sends: { target: string; message: string }[] = [];
  const removed: string[] = [];
  const exec: Exec = async (argv) => {
    if (has(argv, "git", "merge-base", "--is-ancestor")) return { code: 0, stdout: "", stderr: "" };
    if (has(argv, "git", "merge", "--ff-only")) {
      const code = opts.gitMergeCode ?? 0;
      return { code, stdout: "", stderr: code ? opts.gitMergeStderr ?? "CONFLICT (content): merge conflict in x" : "" };
    }
    if (has(argv, "git", "diff")) return OK(SAMPLE);
    // herdr worktree/agent plumbing during spawn:
    if (has(argv, "worktree", "create"))
      return OK('{"result":{"worktree":{"path":"' + join(HOME, "wt") + '","branch":"hive/x","open_workspace_id":"w1"}}}');
    if (has(argv, "workspace", "list")) return OK('{"result":{"workspaces":[{"workspace_id":"wF","label":"hive-fleet"}]}}');
    if (has(argv, "tab", "create")) return OK('{"result":{"tab":{"tab_id":"wF:t2"}}}');
    if (has(argv, "agent", "send")) {
      sends.push({ target: argv[argv.indexOf("send") + 1], message: argv[argv.indexOf("send") + 2] });
      return OK();
    }
    if (has(argv, "worktree", "remove")) {
      removed.push("removed");
      return OK("{}");
    }
    // git branchIsSafe checks during teardown → report merged
    if (has(argv, "git", "branch", "--merged")) return OK("  hive/x\n");
    if (has(argv, "git", "ls-remote")) return OK("");
    return OK();
  };
  const herdr = new Herdr(exec, "herdr");
  const server = Bun.serve({ port: 0, fetch: makeHandler(db, { herdr, exec }) });
  const base = `http://127.0.0.1:${server.port}`;
  return { db, server, base, sends, removed };
}

async function post(base: string, path: string, body: unknown) {
  const res = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
}
async function get(base: string, path: string) {
  const res = await fetch(base + path);
  return { status: res.status, json: await res.json() };
}

// Drive a task to in_review with a branch set (via a stubbed spawn).
async function inReviewTask(base: string, extra: Record<string, unknown> = {}) {
  const p = await post(base, "/api/projects", { name: "p", repo_path: "/repo", config: { default_branch: "main", ...extra } });
  const t = await post(base, "/api/tasks", { project_id: p.json.id, title: "review me", brief: "b" });
  await post(base, `/api/tasks/${t.json.id}/spawn`, {}); // sets branch + agent_target, → in_progress
  await post(base, `/api/tasks/${t.json.id}/transition`, { to: "in_review" });
  return { projectId: p.json.id, taskId: t.json.id };
}

test("merge success writes a merged event and moves the task to verifying", async () => {
  const s = makeServer();
  const { taskId } = await inReviewTask(s.base);
  const r = await post(s.base, `/api/tasks/${taskId}/merge`, {});
  expect(r.status).toBe(200);
  expect(r.json.state).toBe("verifying");
  const ev = await get(s.base, `/api/tasks/${taskId}/events`);
  expect(ev.json.some((e: any) => e.type === "merged")).toBe(true);
  // best-effort teardown removed the worktree
  expect(s.removed.length).toBeGreaterThan(0);
  s.server.stop(true);
});

test("merge conflict bounces the task back to the agent with rebase instructions", async () => {
  const s = makeServer({ gitMergeCode: 1 });
  const { taskId } = await inReviewTask(s.base);
  const r = await post(s.base, `/api/tasks/${taskId}/merge`, {});
  expect(r.status).toBe(409);
  expect(r.json.error).toContain("sent back to the agent");
  const task = await get(s.base, `/api/tasks/${taskId}`);
  expect(task.json.state).toBe("in_progress"); // bounced, not wedged in review
  expect(s.sends.at(-1)?.message).toContain("Rebase");
  const ev = await get(s.base, `/api/tasks/${taskId}/events`);
  const mf = ev.json.find((e: any) => e.type === "merge_failed");
  expect(mf.payload.conflict).toBe(true);
  expect(mf.payload.delivered).toBe(true);
  s.server.stop(true);
});

test("non-conflict merge failure returns 409 and does not change state", async () => {
  const s = makeServer({ gitMergeCode: 128, gitMergeStderr: "fatal: unable to write new index file" });
  const { taskId } = await inReviewTask(s.base);
  const sendsBefore = s.sends.length;
  const r = await post(s.base, `/api/tasks/${taskId}/merge`, {});
  expect(r.status).toBe(409);
  expect(r.json.error).toContain("unable to write");
  const task = await get(s.base, `/api/tasks/${taskId}`);
  expect(task.json.state).toBe("in_review"); // unchanged, no bounce
  expect(s.sends.length).toBe(sendsBefore); // agent not pinged
  s.server.stop(true);
});

test("merge is blocked by a task.merge deny rule (authority gate)", async () => {
  const s = makeServer();
  const { projectId, taskId } = await inReviewTask(s.base);
  await post(s.base, "/api/authority/rules", { project_id: projectId, action_pattern: "task.merge", effect: "deny", note: "no auto-merge" });
  const r = await post(s.base, `/api/tasks/${taskId}/merge`, {});
  expect(r.status).toBe(403);
  const task = await get(s.base, `/api/tasks/${taskId}`);
  expect(task.json.state).toBe("in_review");
  s.server.stop(true);
});

test("merge refuses a task that is not in_review", async () => {
  const s = makeServer();
  const p = await post(s.base, "/api/projects", { name: "p", repo_path: "/repo" });
  const t = await post(s.base, "/api/tasks", { project_id: p.json.id, title: "queued task" });
  const r = await post(s.base, `/api/tasks/${t.json.id}/merge`, {});
  expect(r.status).toBe(409);
  expect(r.json.error).toContain("in_review");
  s.server.stop(true);
});

test("request-changes returns the task to in_progress, sends notes, records an event", async () => {
  const s = makeServer();
  const { taskId } = await inReviewTask(s.base);
  const r = await post(s.base, `/api/tasks/${taskId}/request-changes`, { notes: "tighten the error handling" });
  expect(r.status).toBe(200);
  expect(r.json.ok).toBe(true);
  expect(r.json.delivered).toBe(true);
  expect(r.json.task.state).toBe("in_progress");
  expect(s.sends.at(-1)?.message).toContain("tighten the error handling");
  const ev = await get(s.base, `/api/tasks/${taskId}/events`);
  const cr = ev.json.find((e: any) => e.type === "changes_requested");
  expect(cr.payload.notes).toBe("tighten the error handling");
  s.server.stop(true);
});

test("request-changes requires notes", async () => {
  const s = makeServer();
  const { taskId } = await inReviewTask(s.base);
  const r = await post(s.base, `/api/tasks/${taskId}/request-changes`, { notes: "  " });
  expect(r.status).toBe(400);
  s.server.stop(true);
});

test("reject path: an in_review task can be cancelled with a reason", async () => {
  const s = makeServer();
  const { taskId } = await inReviewTask(s.base);
  const r = await post(s.base, `/api/tasks/${taskId}/transition`, { to: "cancelled", reason: "not the approach we want" });
  expect(r.status).toBe(200);
  expect(r.json.state).toBe("cancelled");
  const ev = await get(s.base, `/api/tasks/${taskId}/events`);
  const sc = ev.json.find((e: any) => e.type === "state_change" && e.payload.to === "cancelled");
  expect(sc.payload.reason).toBe("not the approach we want");
  s.server.stop(true);
});

test("brief.to_review derivation lists in_review tasks", async () => {
  const s = makeServer();
  const { taskId } = await inReviewTask(s.base);
  const b = await get(s.base, `/api/brief`);
  expect(Array.isArray(b.json.to_review)).toBe(true);
  expect(b.json.to_review.some((t: any) => t.id === taskId)).toBe(true);
  // a fresh, still-queued task is NOT in the review list
  const p = await post(s.base, "/api/projects", { name: "p2", repo_path: "/r" });
  const q = await post(s.base, "/api/tasks", { project_id: p.json.id, title: "queued" });
  const b2 = await get(s.base, `/api/brief`);
  expect(b2.json.to_review.some((t: any) => t.id === q.json.id)).toBe(false);
  s.server.stop(true);
});

test("diff endpoint returns the structured shape for a branch task", async () => {
  const s = makeServer();
  const { taskId } = await inReviewTask(s.base);
  const r = await get(s.base, `/api/tasks/${taskId}/diff`);
  expect(r.status).toBe(200);
  expect(r.json.files.length).toBe(2);
  expect(r.json.files[0].path).toBe("src/a.ts");
  expect(r.json.truncated).toBe(false);
  s.server.stop(true);
});

afterAll(() => {});
