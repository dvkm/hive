import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "hive-pr-handoff-"));
process.env.HIVE_HOME = HOME;

const { openDb } = await import("../src/db.ts");
const { makeHandler } = await import("../src/api.ts");
import type { Exec, ExecResult } from "../src/exec.ts";

const OK = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const has = (argv: string[], ...xs: string[]) => xs.every((x) => argv.includes(x));

// gh answers `pr view` per url: a url the map does not know does not exist on
// GitHub, which is exactly what the 1847 slip looked like (HIVE-595).
function makeServer(prs: Record<string, string>, remote?: string) {
  const db = openDb(":memory:");
  const exec: Exec = async (argv) => {
    if (remote && has(argv, "git", "remote", "get-url")) return OK(remote + "\n");
    if (has(argv, "gh", "pr", "view")) {
      const url = argv[argv.indexOf("view") + 1];
      const branch = prs[url];
      if (!branch)
        return { code: 1, stdout: "", stderr: `GraphQL: Could not resolve to a PullRequest with the number of 1847` };
      return OK(JSON.stringify({ headRefName: branch, state: "OPEN", statusCheckRollup: [] }));
    }
    return OK();
  };
  const server = Bun.serve({ port: 0, fetch: makeHandler(db, { exec }) });
  return { db, server, base: `http://127.0.0.1:${server.port}` };
}

async function post(base: string, path: string, body: unknown) {
  const res = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
}

const REVIEW = {
  type: "review_summary",
  done: ["the work"],
  understanding: {
    essence: "a change",
    checks: [
      {
        question: "What does this change do?",
        options: [{ key: "a", label: "the work" }, { key: "b", label: "nothing" }],
        answer_key: "a",
        explanation: "It does the work.",
      },
    ],
  },
};

// A task in_progress on branch `hive/mine`, already linked to its real PR.
async function seed(base: string, db: any, prUrl: string, branch = "hive/mine") {
  const p = await post(base, "/api/projects", { name: "p", repo_path: "/repo" });
  const t = await post(base, "/api/tasks", { project_id: p.json.id, title: "linked task" });
  const id = t.json.id as string;
  await post(base, `/api/tasks/${id}/transition`, { to: "in_progress" });
  await post(base, `/api/tasks/${id}/events`, { type: "evidence", note: "proof", kind: "log" });
  await post(base, `/api/tasks/${id}/events`, REVIEW);
  db.query("UPDATE tasks SET pr_url = ?, branch = ? WHERE id = ?").run(prUrl, branch, id);
  return id;
}

test("a pr_url GitHub cannot resolve is refused and the good link is kept", async () => {
  const s = makeServer({ "https://github.com/dvkm/hive/pull/141": "hive/mine" });
  const id = await seed(s.base, s.db, "https://github.com/dvkm/hive/pull/141");

  const r = await post(s.base, `/api/tasks/${id}/events`, { type: "ready", pr_url: "https://github.com/dvkm/hive/pull/1847" });
  expect(r.status).toBe(200);
  expect(r.json.held).toBe(true);
  expect(r.json.reason).toBe("pr_not_found");
  expect(r.json.message).toContain("hive/mine");

  const task = s.db.query("SELECT pr_url, state FROM tasks WHERE id = ?").get(id) as any;
  expect(task.pr_url).toBe("https://github.com/dvkm/hive/pull/141"); // not replaced
  expect(task.state).toBe("in_progress");
  await s.server.stop(true);
});

test("a pr_url on someone else's branch is refused", async () => {
  const s = makeServer({
    "https://github.com/dvkm/hive/pull/141": "hive/mine",
    "https://github.com/dvkm/hive/pull/150": "hive/someone-else",
  });
  const id = await seed(s.base, s.db, "https://github.com/dvkm/hive/pull/141");

  const r = await post(s.base, `/api/tasks/${id}/events`, { type: "ready", pr_url: "https://github.com/dvkm/hive/pull/150" });
  expect(r.json.held).toBe(true);
  expect(r.json.reason).toBe("pr_branch_mismatch");
  expect(r.json.message).toContain("hive/someone-else");
  expect((s.db.query("SELECT pr_url FROM tasks WHERE id = ?").get(id) as any).pr_url).toBe(
    "https://github.com/dvkm/hive/pull/141"
  );
  await s.server.stop(true);
});

test("a replacement PR on this task's own branch still goes through", async () => {
  const s = makeServer({
    "https://github.com/dvkm/hive/pull/141": "hive/mine",
    "https://github.com/dvkm/hive/pull/166": "hive/mine",
  });
  const id = await seed(s.base, s.db, "https://github.com/dvkm/hive/pull/141");

  const r = await post(s.base, `/api/tasks/${id}/events`, { type: "ready", pr_url: "https://github.com/dvkm/hive/pull/166" });
  expect(r.json.held).toBeUndefined();
  expect(r.json.task.pr_url).toBe("https://github.com/dvkm/hive/pull/166");
  expect(r.json.task.state).toBe("in_review");
  await s.server.stop(true);
});

test("a broken gh does not strand the handoff", async () => {
  const db = openDb(":memory:");
  const exec: Exec = async (argv) =>
    argv[0] === "gh" ? { code: 1, stdout: "", stderr: "gh: connection refused" } : OK();
  const server = Bun.serve({ port: 0, fetch: makeHandler(db, { exec }) });
  const base = `http://127.0.0.1:${server.port}`;
  const id = await seed(base, db, "https://github.com/dvkm/hive/pull/141");

  const r = await post(base, `/api/tasks/${id}/events`, { type: "ready", pr_url: "https://github.com/dvkm/hive/pull/166" });
  expect(r.json.held).toBeUndefined();
  expect(r.json.task.pr_url).toBe("https://github.com/dvkm/hive/pull/166");
  await server.stop(true);
});

test("a pr_url that is not even a URL is refused without asking gh", async () => {
  const s = makeServer({ "https://github.com/dvkm/hive/pull/141": "hive/mine" });
  const id = await seed(s.base, s.db, "https://github.com/dvkm/hive/pull/141");

  const r = await post(s.base, `/api/tasks/${id}/events`, { type: "ready", pr_url: "1847" });
  expect(r.json.held).toBe(true);
  expect(r.json.reason).toBe("pr_url_not_a_url");
  await s.server.stop(true);
});

// The three risk findings on the first cut of this change (HIVE-595).

test("a 404 from an unauthorised token fails open instead of holding", async () => {
  const db = openDb(":memory:");
  const exec: Exec = async (argv) =>
    argv[0] === "gh"
      ? { code: 1, stdout: "", stderr: "GraphQL: Could not resolve to a Repository\nHTTP 404: Not Found (https://api.github.com/...)" }
      : OK();
  const server = Bun.serve({ port: 0, fetch: makeHandler(db, { exec }) });
  const base = `http://127.0.0.1:${server.port}`;
  const id = await seed(base, db, "https://github.com/dvkm/hive/pull/141");

  const r = await post(base, `/api/tasks/${id}/events`, { type: "ready", pr_url: "https://github.com/dvkm/hive/pull/166" });
  expect(r.json.held).toBeUndefined();
  expect(r.json.task.pr_url).toBe("https://github.com/dvkm/hive/pull/166");
  await server.stop(true);
});

test("a branch name we cannot verify links, but is marked unverified", async () => {
  const s = makeServer({ "https://github.com/dvkm/hive/pull/141": "hive/mine", "https://github.com/dvkm/hive/pull/166": "feature/oops~1" });
  const id = await seed(s.base, s.db, "https://github.com/dvkm/hive/pull/141");

  const r = await post(s.base, `/api/tasks/${id}/events`, { type: "ready", pr_url: "https://github.com/dvkm/hive/pull/166" });
  expect(r.json.held).toBeUndefined();
  expect(r.json.task.pr_url).toBe("https://github.com/dvkm/hive/pull/166");
  const linked = s.db
    .query("SELECT payload FROM events WHERE task_id = ? AND type = 'pr_linked' ORDER BY id DESC LIMIT 1")
    .get(id) as any;
  expect(JSON.parse(linked.payload).branch_unverified).toBe(true);
  await s.server.stop(true);
});

test("a held handoff still records the agent's note", async () => {
  const s = makeServer({ "https://github.com/dvkm/hive/pull/141": "hive/mine" });
  const id = await seed(s.base, s.db, "https://github.com/dvkm/hive/pull/141");

  const r = await post(s.base, `/api/tasks/${id}/events`, {
    type: "ready",
    pr_url: "https://github.com/dvkm/hive/pull/1847",
    note: "rebased and reopened, here is why",
  });
  expect(r.json.reason).toBe("pr_not_found");
  const note = s.db.query("SELECT payload FROM events WHERE task_id = ? AND type = 'note' ORDER BY id DESC LIMIT 1").get(id) as any;
  expect(JSON.parse(note.payload).note).toContain("rebased and reopened");
  await s.server.stop(true);
});

test("a PR in another repo on a same-named branch is refused", async () => {
  // Both repos on this board use hive/<task-id> branches, so the branch check
  // alone would accept this one.
  const s = makeServer(
    {
      "https://github.com/dvkm/hive/pull/141": "hive/mine",
      "https://github.com/corebeatcokr/monorepo/pull/900": "hive/mine",
    },
    "git@github.com:dvkm/hive.git"
  );
  const id = await seed(s.base, s.db, "https://github.com/dvkm/hive/pull/141");

  const r = await post(s.base, `/api/tasks/${id}/events`, {
    type: "ready",
    pr_url: "https://github.com/corebeatcokr/monorepo/pull/900",
  });
  expect(r.json.held).toBe(true);
  expect(r.json.reason).toBe("pr_repo_mismatch");
  expect(r.json.message).toContain("corebeatcokr/monorepo");
  expect((s.db.query("SELECT pr_url FROM tasks WHERE id = ?").get(id) as any).pr_url).toBe(
    "https://github.com/dvkm/hive/pull/141"
  );
  await s.server.stop(true);
});

test("a PR in this task's own repo still goes through when the remote is known", async () => {
  const s = makeServer(
    { "https://github.com/dvkm/hive/pull/141": "hive/mine", "https://github.com/dvkm/hive/pull/166": "hive/mine" },
    "https://github.com/dvkm/hive.git"
  );
  const id = await seed(s.base, s.db, "https://github.com/dvkm/hive/pull/141");

  const r = await post(s.base, `/api/tasks/${id}/events`, { type: "ready", pr_url: "https://github.com/dvkm/hive/pull/166" });
  expect(r.json.held).toBeUndefined();
  expect(r.json.task.pr_url).toBe("https://github.com/dvkm/hive/pull/166");
  await s.server.stop(true);
});

test("an unverifiable check marks the link instead of leaving it silent", async () => {
  const db = openDb(":memory:");
  const exec: Exec = async (argv) => (argv[0] === "gh" ? { code: 1, stdout: "", stderr: "gh: connection refused" } : OK());
  const server = Bun.serve({ port: 0, fetch: makeHandler(db, { exec }) });
  const base = `http://127.0.0.1:${server.port}`;
  const id = await seed(base, db, "https://github.com/dvkm/hive/pull/141");

  await post(base, `/api/tasks/${id}/events`, { type: "ready", pr_url: "https://github.com/dvkm/hive/pull/166" });
  const linked = db
    .query("SELECT payload FROM events WHERE task_id = ? AND type = 'pr_linked' ORDER BY id DESC LIMIT 1")
    .get(id) as any;
  expect(JSON.parse(linked.payload).branch_unverified).toBe(true);
  await server.stop(true);
});
