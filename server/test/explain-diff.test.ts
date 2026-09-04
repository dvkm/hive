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

// Call the handler directly instead of standing up a real HTTP server. See
// thinBriefVsMirror.test.ts: bun's fetch pool can hand a later Bun.serve a
// socket still wired to an earlier, dead server.
function makeApi(opts: { rollup?: any[]; html?: string; plannerCode?: number } = {}) {
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
  const argvs: string[][] = [];
  const plannerExec: PlannerExec = async (argv) => {
    argvs.push(argv);
    prompts.push(argv.find((a) => a.includes("Quiz")) ?? "");
    if (opts.plannerCode) return { code: opts.plannerCode, stdout: "", stderr: "model unavailable" };
    return { code: 0, stdout: JSON.stringify({ result: opts.html ?? PAGE }), stderr: "" };
  };
  const herdr = new Herdr(exec, "herdr");
  const handler = makeHandler(db, { herdr, exec, plannerExec });
  return { db, handler, prompts, argvs };
}

type Handler = ReturnType<typeof makeHandler>;

async function post(handler: Handler, path: string, body: unknown) {
  const res = await handler(new Request("http://127.0.0.1" + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
  return { status: res.status, json: (await res.json()) as any };
}
async function get(handler: Handler, path: string) {
  const res = await handler(new Request("http://127.0.0.1" + path));
  return { status: res.status, json: (await res.json()) as any };
}

const CHECK = {
  question: "What does this change do to the review queue?",
  options: [{ key: "gate", label: "It holds a task until the page exists." }, { key: "none", label: "Nothing." }],
  answer_key: "gate",
  explanation: "The gate holds the handoff until the explanation is stored.",
};

async function readyTask(handler: Handler, prUrl: string) {
  const p = await post(handler, "/api/projects", { name: "p", repo_path: "/repo" });
  const t = await post(handler, "/api/tasks", { project_id: p.json.id, title: "explain me", brief: "b" });
  const id = t.json.id as string;
  await post(handler, `/api/tasks/${id}/spawn`, {});
  await post(handler, `/api/tasks/${id}/events`, { type: "evidence", note: "proof", kind: "log" });
  await post(handler, `/api/tasks/${id}/events`, {
    type: "review_summary",
    done: ["did the thing"],
    understanding: { background: "b", essence: "e", check: CHECK },
  });
  const ready = await post(handler, `/api/tasks/${id}/events`, { type: "ready", pr_url: prUrl });
  return { id, ready };
}

// Poll: generation is fired in the background and hands the task off itself.
async function waitForState(handler: Handler, id: string, state: string) {
  for (let i = 0; i < 100; i++) {
    const t = await get(handler, `/api/tasks/${id}`);
    if (t.json.state === state) return t.json;
    await new Promise((r) => setTimeout(r, 20));
  }
  return (await get(handler, `/api/tasks/${id}`)).json;
}

test("red CI: no explanation is generated and the task stays out of review", async () => {
  const s = makeApi({ rollup: [{ conclusion: "FAILURE" }] });
  const { id, ready } = await readyTask(s.handler, "https://gh/pr/1");
  expect(ready.json.ci_status).toBe("failing");
  const task = await get(s.handler, `/api/tasks/${id}`);
  expect(task.json.state).toBe("in_progress");
  const ev = await get(s.handler, `/api/evidence?task=${id}`);
  expect(ev.json.evidence.some((e: any) => e.kind === "explanation")).toBe(false);
});

test("green CI: the handoff is held until the explanation page exists, then it lands before in_review", async () => {
  const s = makeApi({ rollup: [{ conclusion: "SUCCESS" }] });
  const { id, ready } = await readyTask(s.handler, "https://gh/pr/2");
  expect(ready.json.held).toBe(true);
  expect(ready.json.reason).toBe("explanation_pending");

  const task = await waitForState(s.handler, id, "in_review");
  expect(task.state).toBe("in_review");

  const ev = await get(s.handler, `/api/evidence?task=${id}`);
  const page = ev.json.evidence.find((e: any) => e.kind === "explanation");
  expect(page.url).toContain(`/evidence/${id}/`);
  expect(readFileSync(join(HOME, "evidence", id, page.url.split("/").pop()), "utf8")).toContain("<h1>Explanation</h1>");

  // The page is stored BEFORE the task enters review, never after.
  const events = await get(s.handler, `/api/tasks/${id}/events`);
  const stored = events.json.findIndex((e: any) => e.type === "explanation_ready");
  const entered = events.json.findIndex((e: any) => e.type === "state_change" && e.payload?.to === "in_review");
  expect(stored).toBeGreaterThanOrEqual(0);
  expect(stored).toBeLessThan(entered);

  // The quiz comes from the review summary, not from a second set of questions.
  expect(s.prompts.join("\n")).toContain(CHECK.question);
});

test("the explanation run cannot write files, so the page has to come back on stdout", async () => {
  const s = makeApi({ rollup: [{ conclusion: "SUCCESS" }] });
  const { id } = await readyTask(s.handler, "https://gh/pr/4");
  await waitForState(s.handler, id, "in_review");
  const argv = s.argvs.find((a) => a.some((x) => x.includes("Write a rich, interactive explanation")));
  expect(argv).toBeDefined();
  expect(argv).toContain("--disallowed-tools=Write,Edit,NotebookEdit");
});

test("a model failure records why and hands off anyway, rather than stranding the task", async () => {
  const s = makeApi({ rollup: [{ conclusion: "SUCCESS" }], plannerCode: 1 });
  const { id } = await readyTask(s.handler, "https://gh/pr/3");
  const task = await waitForState(s.handler, id, "in_review");
  expect(task.state).toBe("in_review");
  const events = await get(s.handler, `/api/tasks/${id}/events`);
  expect(events.json.some((e: any) => e.type === "explanation_failed")).toBe(true);
});
