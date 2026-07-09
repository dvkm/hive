import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "hive-planner-"));
process.env.HIVE_HOME = HOME;

const { openDb } = await import("../src/db.ts");
const { makeHandler } = await import("../src/api.ts");
const { composePlannerPrompt, extractPlan, runPlanner } = await import("../src/planner.ts");
import type { PlannerExec } from "../src/planner.ts";

const db = openDb(":memory:");

// A planner exec stub: records the argv it was called with and returns canned
// stdout. `hang` simulates a subprocess that outlives the timeout (timedOut).
function stubExec(stdout: string, opts: { code?: number; hang?: boolean } = {}): {
  exec: PlannerExec;
  calls: string[][];
} {
  const calls: string[][] = [];
  const exec: PlannerExec = async (argv, o) => {
    calls.push(argv);
    if (opts.hang) return { code: 143, stdout: "", stderr: "killed", timedOut: true };
    return { code: opts.code ?? 0, stdout, stderr: "" };
  };
  return { exec, calls };
}

let server: any;
let BASE = "";
let projectId = "";
beforeAll(async () => {
  server = Bun.serve({ port: 0, fetch: makeHandler(db) });
  BASE = `http://127.0.0.1:${server.port}`;
  const p = await (await fetch(BASE + "/api/projects", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "acme", repo_path: "/repo",
      config: { supervisor_persona: "Pragmatic staff engineer.", playbook: "Ship small PRs." },
    }),
  })).json();
  projectId = p.id;
  // one global policy + one active learning so we can assert prompt composition
  await fetch(BASE + "/api/policies", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "No em-dashes", body: "Use commas." }),
  });
  await fetch(BASE + "/api/learnings", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project_id: projectId, title: "flaky smoke on empty list", body: "guard empty" }),
  });
});
afterAll(() => server.stop(true));

async function post(path: string, body: unknown) {
  const res = await fetch(BASE + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
}
async function get(path: string) {
  const res = await fetch(BASE + path);
  return { status: res.status, json: await res.json() };
}
async function mkTask(title = "Build onboarding flow", brief = "New users need a guided setup.") {
  return (await post("/api/tasks", { project_id: projectId, title, brief })).json;
}

const VALID = JSON.stringify({
  proposed_tasks: [
    { title: "Design schema", brief: "users + steps tables", kind: "ship" },
    { title: "Research competitors", brief: "survey 3 tools", kind: "scout" },
  ],
  rationale: "Split design from research so they proceed in parallel.",
  questions: ["Which auth provider?"],
});

test("prompt composition includes persona, playbook, policies and learnings", async () => {
  const t = await mkTask();
  const prompt = composePlannerPrompt(db, t.id);
  expect(prompt).toContain("Pragmatic staff engineer.");
  expect(prompt).toContain("Ship small PRs.");
  expect(prompt).toContain("No em-dashes"); // policy
  expect(prompt).toContain("flaky smoke on empty list"); // learning
  expect(prompt).toContain("Build onboarding flow"); // source task
  expect(prompt).toContain("STRICT JSON");
});

test("strict JSON parses; defensive extraction handles envelope + prose", () => {
  expect(extractPlan(VALID)?.proposed_tasks.length).toBe(2);
  // claude -p --output-format json envelope: our JSON lives in .result as a string
  const envelope = JSON.stringify({ type: "result", result: VALID });
  expect(extractPlan(envelope)?.proposed_tasks[0].title).toBe("Design schema");
  // prose wrapped around the object
  const prose = "Sure! Here is the plan:\n" + VALID + "\nHope that helps.";
  expect(extractPlan(prose)?.rationale).toContain("parallel");
  // unknown kind normalizes to ship; entries without a title are dropped
  const messy = JSON.stringify({ proposed_tasks: [{ title: "x", kind: "weird" }, { brief: "no title" }] });
  const p = extractPlan(messy)!;
  expect(p.proposed_tasks.length).toBe(1);
  expect(p.proposed_tasks[0].kind).toBe("ship");
});

test("unparseable planner output records a single planner_error and stops", async () => {
  const t = await mkTask();
  const { exec } = stubExec("not json at all, no object here");
  const r = await runPlanner(db, t.id, { exec });
  expect(r.ok).toBe(false);
  const full = (await get(`/api/tasks/${t.id}`)).json;
  const errs = full.events.filter((e: any) => e.type === "planner_error");
  expect(errs.length).toBe(1);
  // no decision card was created
  expect(full.decisions.length).toBe(0);
});

test("timeout kills the planner and records planner_error", async () => {
  const t = await mkTask();
  const { exec } = stubExec("", { hang: true });
  const r = await runPlanner(db, t.id, { exec, timeoutMs: 10 });
  expect(r.ok).toBe(false);
  expect(r.error).toContain("timed out");
  const full = (await get(`/api/tasks/${t.id}`)).json;
  expect(full.events.some((e: any) => e.type === "planner_error")).toBe(true);
});

test("plan endpoint -> decision card; approve creates linked child tasks", async () => {
  const t = await mkTask();
  const handler = makeHandler(db, { plannerExec: stubExec(VALID).exec });
  const s2 = Bun.serve({ port: 0, fetch: handler });
  const base2 = `http://127.0.0.1:${s2.port}`;
  try {
    const r = await (await fetch(base2 + `/api/tasks/${t.id}/plan`, { method: "POST", body: "{}" })).json();
    expect(r.ok).toBe(true);
    expect(r.decision.title).toContain("Proposed breakdown");
    // planning + planned events present
    const full = (await get(`/api/tasks/${t.id}`)).json;
    const types = full.events.map((e: any) => e.type);
    expect(types).toContain("planning");
    expect(types).toContain("planned");

    // approve the card
    await post(`/api/decisions/${r.decision.id}/answer`, { answer_key: "approve" });
    const kids = (await get(`/api/tasks?project_id=${projectId}`)).json.filter(
      (x: any) => x.parent_task_id === t.id
    );
    expect(kids.length).toBe(2);
    expect(kids.every((k: any) => k.source === "planner")).toBe(true);
    expect(kids.every((k: any) => k.state === "queued")).toBe(true);
    expect(kids.map((k: any) => k.title).sort()).toEqual(["Design schema", "Research competitors"]);
  } finally {
    s2.stop(true);
  }
});

test("reject creates no child tasks", async () => {
  const t = await mkTask();
  const r = await runPlanner(db, t.id, { exec: stubExec(VALID).exec });
  await post(`/api/decisions/${r.decision.id}/answer`, { answer_key: "reject" });
  const kids = (await get(`/api/tasks?project_id=${projectId}`)).json.filter(
    (x: any) => x.parent_task_id === t.id
  );
  expect(kids.length).toBe(0);
});

test("auto-trigger on intake when project config.plan_intake is set", async () => {
  const { pollGchatOnce } = await import("../src/intake/gchat.ts");
  const { openDb: openDb2 } = await import("../src/db.ts");
  const idb = openDb2(":memory:");
  const pid = (function () {
    const p = { id: "proj_intake", name: "p", config: JSON.stringify({ gchat_spaces: [{ space: "spaces/A" }], plan_intake: true }), created_at: new Date().toISOString() };
    idb.query("INSERT INTO projects (id, name, config, created_at) VALUES (?,?,?,?)").run(p.id, p.name, p.config, p.created_at);
    return p.id;
  })();

  const fetchStub = (async (input: any) => {
    const u = String(input);
    if (u.includes("oauth2.googleapis.com/token"))
      return new Response(JSON.stringify({ access_token: "at", expires_in: 3600 }), { status: 200 });
    if (u.includes("/messages?"))
      return new Response(JSON.stringify({ messages: [{ name: "spaces/A/messages/M1", text: "Please add SSO", sender: { name: "users/x", type: "HUMAN" }, createTime: "2026-07-09T10:00:00Z" }] }), { status: 200 });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;

  const res = await pollGchatOnce(idb, {
    fetch: fetchStub,
    secrets: { clientId: "i", clientSecret: "s", refreshToken: "r" },
    notify: false,
    plannerExec: stubExec(VALID).exec,
  });
  expect(res.created).toBe(1);

  const intakeTask: any = idb.query("SELECT id FROM tasks WHERE project_id = ?").get(pid);
  const decisions = idb.query("SELECT * FROM decisions WHERE task_id = ?").all(intakeTask.id);
  expect(decisions.length).toBe(1);
  expect((decisions[0] as any).title).toContain("Proposed breakdown");
  idb.close();
});
