// #1249: a task only reaches review when its CI is green AND a page explaining
// the change has been generated and stored as evidence.
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "hive-explain-"));
process.env.HIVE_HOME = HOME;
// The gate only runs where there is a checkout to read, so give the stubbed
// herdr worktree a real .git the way a live worktree has one.
const WT = join(HOME, "wt");
mkdirSync(WT, { recursive: true });
writeFileSync(join(WT, ".git"), "gitdir: /repo/.git/worktrees/x\n");

const { openDb } = await import("../src/db.ts");
const { makeHandler } = await import("../src/api.ts");
const { Herdr } = await import("../src/runtime/herdr.ts");
import type { Exec, ExecResult } from "../src/exec.ts";
import type { PlannerExec } from "../src/planner.ts";

const OK = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const has = (argv: string[], ...xs: string[]) => xs.every((x) => argv.includes(x));

const PAGE = "<!doctype html><html><body><h1>Explanation</h1><pre>diff</pre></body></html>";

function makeServer(opts: { rollup?: any[]; html?: string; plannerCode?: number } = {}) {
  const db = openDb(":memory:");
  const prompts: string[] = [];
  const exec: Exec = async (argv) => {
    if (has(argv, "gh", "pr", "diff")) return OK("diff --git a/x.ts b/x.ts\n+one line\n");
    if (has(argv, "gh", "pr", "view"))
      return OK(JSON.stringify({ state: "OPEN", statusCheckRollup: opts.rollup ?? [] }));
    if (has(argv, "worktree", "create"))
      return OK(JSON.stringify({ result: { worktree: { path: WT, branch: "hive/x", open_workspace_id: "w1" } } }));
    if (has(argv, "agent", "get")) return OK('{"result":{"agent":{"pane_id":"p1","agent_status":"working"}}}');
    if (has(argv, "workspace", "list")) return OK('{"result":{"workspaces":[{"workspace_id":"wF","label":"hive-fleet"}]}}');
    if (has(argv, "tab", "create")) return OK('{"result":{"tab":{"tab_id":"wF:t2"}}}');
    return OK();
  };
  const plannerExec: PlannerExec = async (argv) => {
    prompts.push(argv.find((a) => a.includes("Quiz")) ?? "");
    if (opts.plannerCode) return { code: opts.plannerCode, stdout: "", stderr: "model unavailable" };
    return { code: 0, stdout: JSON.stringify({ result: opts.html ?? PAGE }), stderr: "" };
  };
  const herdr = new Herdr(exec, "herdr");
  const server = Bun.serve({ port: 0, fetch: makeHandler(db, { herdr, exec, plannerExec }) });
  return { db, server, base: `http://127.0.0.1:${server.port}`, prompts };
}

async function post(base: string, path: string, body: unknown) {
  const res = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as any };
}
async function get(base: string, path: string) {
  const res = await fetch(base + path);
  return { status: res.status, json: (await res.json()) as any };
}

const CHECK = {
  question: "What does this change do to the review queue?",
  options: [{ key: "gate", label: "It holds a task until the page exists." }, { key: "none", label: "Nothing." }],
  answer_key: "gate",
  explanation: "The gate holds the handoff until the explanation is stored.",
};

async function readyTask(base: string, prUrl: string) {
  const p = await post(base, "/api/projects", { name: "p", repo_path: "/repo" });
  const t = await post(base, "/api/tasks", { project_id: p.json.id, title: "explain me", brief: "b" });
  const id = t.json.id as string;
  await post(base, `/api/tasks/${id}/spawn`, {});
  await post(base, `/api/tasks/${id}/events`, { type: "evidence", note: "proof", kind: "log" });
  await post(base, `/api/tasks/${id}/events`, {
    type: "review_summary",
    done: ["did the thing"],
    understanding: { background: "b", essence: "e", check: CHECK },
  });
  const ready = await post(base, `/api/tasks/${id}/events`, { type: "ready", pr_url: prUrl });
  return { id, ready };
}

// Poll: generation is fired in the background and hands the task off itself.
async function waitForState(base: string, id: string, state: string) {
  for (let i = 0; i < 100; i++) {
    const t = await get(base, `/api/tasks/${id}`);
    if (t.json.state === state) return t.json;
    await new Promise((r) => setTimeout(r, 20));
  }
  return (await get(base, `/api/tasks/${id}`)).json;
}

test("red CI: no explanation is generated and the task stays out of review", async () => {
  const s = makeServer({ rollup: [{ conclusion: "FAILURE" }] });
  const { id, ready } = await readyTask(s.base, "https://gh/pr/1");
  expect(ready.json.ci_status).toBe("failing");
  const task = await get(s.base, `/api/tasks/${id}`);
  expect(task.json.state).toBe("in_progress");
  const ev = await get(s.base, `/api/evidence?task=${id}`);
  expect(ev.json.evidence.some((e: any) => e.kind === "explanation")).toBe(false);
  s.server.stop(true);
});

test("green CI: the handoff is held until the explanation page exists, then it lands before in_review", async () => {
  const s = makeServer({ rollup: [{ conclusion: "SUCCESS" }] });
  const { id, ready } = await readyTask(s.base, "https://gh/pr/2");
  expect(ready.json.held).toBe(true);
  expect(ready.json.reason).toBe("explanation_pending");

  const task = await waitForState(s.base, id, "in_review");
  expect(task.state).toBe("in_review");

  const ev = await get(s.base, `/api/evidence?task=${id}`);
  const page = ev.json.evidence.find((e: any) => e.kind === "explanation");
  expect(page.url).toContain(`/evidence/${id}/`);
  expect(readFileSync(join(HOME, "evidence", id, page.url.split("/").pop()), "utf8")).toContain("<h1>Explanation</h1>");

  // The page is stored BEFORE the task enters review, never after.
  const events = await get(s.base, `/api/tasks/${id}/events`);
  const stored = events.json.findIndex((e: any) => e.type === "explanation_ready");
  const entered = events.json.findIndex((e: any) => e.type === "state_change" && e.payload?.to === "in_review");
  expect(stored).toBeGreaterThanOrEqual(0);
  expect(stored).toBeLessThan(entered);

  // The quiz comes from the review summary, not from a second set of questions.
  expect(s.prompts.join("\n")).toContain(CHECK.question);
  s.server.stop(true);
});

test("a model failure records why and hands off anyway, rather than stranding the task", async () => {
  const s = makeServer({ rollup: [{ conclusion: "SUCCESS" }], plannerCode: 1 });
  const { id } = await readyTask(s.base, "https://gh/pr/3");
  const task = await waitForState(s.base, id, "in_review");
  expect(task.state).toBe("in_review");
  const events = await get(s.base, `/api/tasks/${id}/events`);
  expect(events.json.some((e: any) => e.type === "explanation_failed")).toBe(true);
  s.server.stop(true);
});
