import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "hive-planner-"));
process.env.HIVE_HOME = HOME;

const { openDb } = await import("../src/db.ts");
const { makeHandler } = await import("../src/api.ts");
const { composePlannerPrompt, extractPlan, runPlanner } = await import("../src/planner.ts");
const { isReviewed } = await import("../src/dispatcher.ts");
const { addClient, removeClient } = await import("../src/bus.ts");
const { writeEvent } = await import("../src/state.ts");
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
    body: JSON.stringify({ project_id: projectId, title: "flaky smoke on empty list", body: "guard empty", kind: "failure" }),
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
    expect(r.decision.plan.proposed_tasks.length).toBe(2);
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
    expect(kids.find((k: any) => k.title === "Design schema").brief).toBe("users + steps tables");
  } finally {
    s2.stop(true);
  }
});

test("decision exposes structured plan for the UI checklist", async () => {
  const t = await mkTask();
  const messages: any[] = [];
  const client = { id: "planner-test", send: (data: string) => messages.push(JSON.parse(data)) };
  addClient(client);
  const r = await runPlanner(db, t.id, { exec: stubExec(VALID).exec }).finally(() => removeClient(client));
  expect(r.decision!.plan.proposed_tasks.map((p: any) => p.title)).toEqual(["Design schema", "Research competitors"]);
  const published = messages.filter((m) => m.type === "decision" && m.decision.id === r.decision!.id);
  expect(published[published.length - 1].decision.plan.questions).toEqual(["Which auth provider?"]);
  const unrelated = await mkTask("Unrelated plan");
  const foreignEvent = writeEvent(db, {
    task_id: unrelated.id,
    source: "system",
    type: "planned",
    payload: { decision_id: r.decision!.id, proposed_tasks: [{ title: "Wrong task", brief: "", kind: "chore" }] },
  });
  db.query("UPDATE events SET ts = ? WHERE id = ?").run("9999-12-31T23:59:59.999Z", foreignEvent.id);
  const decision = (await get(`/api/decisions/${r.decision!.id}`)).json;
  expect(decision.plan.proposed_tasks.map((p: any) => p.title)).toEqual(["Design schema", "Research competitors"]);
  expect(decision.plan.questions).toEqual(["Which auth provider?"]);
  expect(decision.plan.rationale).toContain("parallel");
  expect(decision.plan.reason).toBeTruthy();
  const notification = db.query("SELECT body FROM notifications WHERE decision_id = ?").get(r.decision!.id) as { body: string };
  expect(notification.body).toContain("Proposed tasks");
  // a non-planner card has no plan
  const other = await post("/api/decisions", { task_id: t.id, title: "unrelated", options: [{ key: "ok", label: "OK" }] });
  expect(other.json.plan).toBeNull();
});

test("selected_indices on approve creates each valid checked task once", async () => {
  const t = await mkTask();
  const r = await runPlanner(db, t.id, { exec: stubExec(VALID).exec });
  await post(`/api/decisions/${r.decision!.id}/answer`, {
    answer_key: "approve",
    answer_note: "Q: Which auth provider?\nA: Use Clerk",
    selected_indices: [1, 1, -1, 2, 0.5, "0"],
  });
  const kids = (await get(`/api/tasks?project_id=${projectId}`)).json.filter(
    (x: any) => x.parent_task_id === t.id
  );
  expect(kids.length).toBe(1);
  expect(kids[0].title).toBe("Research competitors");
  expect(kids[0].brief).toBe("survey 3 tools\n\nDirector notes:\nQ: Which auth provider?\nA: Use Clerk");
});

test("approve rejects malformed inputs or empty planner selections", async () => {
  const t = await mkTask();
  const r = await runPlanner(db, t.id, { exec: stubExec(VALID).exec });
  const malformedNote = await post(`/api/decisions/${r.decision!.id}/answer`, { answer_key: "approve", answer_note: 123 });
  expect(malformedNote.status).toBe(400);
  expect(malformedNote.json.error).toContain("answer_note must be a string");
  expect((await get(`/api/decisions/${r.decision!.id}`)).json.status).toBe("open");
  const malformed = await post(`/api/decisions/${r.decision!.id}/answer`, { answer_key: "approve", selected_indices: "[]" });
  expect(malformed.status).toBe(400);
  expect(malformed.json.error).toContain("array of indices");
  expect((await get(`/api/decisions/${r.decision!.id}`)).json.status).toBe("open");
  const answer = await post(`/api/decisions/${r.decision!.id}/answer`, { answer_key: "approve", selected_indices: [] });
  expect(answer.status).toBe(400);
  expect(answer.json.error).toContain("reject");
  expect((await get(`/api/decisions/${r.decision!.id}`)).json.status).toBe("open");
  const kids = (await get(`/api/tasks?project_id=${projectId}`)).json.filter(
    (x: any) => x.parent_task_id === t.id
  );
  expect(kids.length).toBe(0);
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

test("braindump intake -> queued chore + decision card; approve queues children and retires the braindump", async () => {
  const handler = makeHandler(db, { plannerExec: stubExec(VALID).exec });
  const s2 = Bun.serve({ port: 0, fetch: handler });
  const base2 = `http://127.0.0.1:${s2.port}`;
  try {
    const res = await fetch(base2 + "/api/intake", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: projectId, text: "sso login is a mess\nalso the docs lie" }),
    });
    expect(res.status).toBe(202);
    const { task } = await res.json();
    expect(task.state).toBe("queued");
    expect(task.kind).toBe("chore");
    expect(task.source).toBe("intake_braindump");
    expect(task.title).toBe("[braindump] sso login is a mess");
    expect(task.brief).toContain("also the docs lie"); // raw text preserved verbatim

    // the planner runs out-of-band but resolves before the next round-trip
    const full = (await get(`/api/tasks/${task.id}`)).json;
    expect(full.decisions.length).toBe(1);
    const decision = full.decisions[0];
    expect(decision.title).toContain("Proposed breakdown");

    // never auto-dispatched while the breakdown is unapproved
    expect(isReviewed(db, task.id)).toBe(false);

    await post(`/api/decisions/${decision.id}/answer`, { answer_key: "approve" });
    const kids = (await get(`/api/tasks?project_id=${projectId}`)).json.filter(
      (x: any) => x.parent_task_id === task.id
    );
    expect(kids.length).toBe(2);
    expect(kids.every((k: any) => k.state === "queued")).toBe(true);
    // the braindump container is retired off the board once its plan is approved
    expect((await get(`/api/tasks/${task.id}`)).json.state).toBe("cancelled");
  } finally {
    s2.stop(true);
  }
});

test("braindump intake rejects empty text and unknown projects", async () => {
  expect((await post("/api/intake", { project_id: projectId, text: "   " })).status).toBe(400);
  expect((await post("/api/intake", { project_id: "nope", text: "hi" })).status).toBe(400);
});

test("a long braindump first line is elided into the title", async () => {
  // via the stubbed handler: the default one would spawn a real `claude -p`
  const s2 = Bun.serve({ port: 0, fetch: makeHandler(db, { plannerExec: stubExec(VALID).exec }) });
  try {
    const long = "a".repeat(200);
    const res = await fetch(`http://127.0.0.1:${s2.port}/api/intake`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: projectId, text: long }),
    });
    const { task } = await res.json();
    expect(task.title).toBe(`[braindump] ${"a".repeat(71)}…`);
    expect(task.brief).toBe(long); // the full text is never truncated
  } finally {
    s2.stop(true);
  }
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
