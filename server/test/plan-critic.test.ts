// HIVE-412: plan checkpoints get an automatic critic. The plan is critiqued in
// the background, the critique is linked to the checkpoint, and a veto steers
// the agent. Ordinary checkpoints are untouched.
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HIVE_HOME = mkdtempSync(join(tmpdir(), "hive-plan-critic-"));

const { openDb } = await import("../src/db.ts");
const { makeHandler } = await import("../src/api.ts");
const { composeBrief } = await import("../src/briefs.ts");
const { Herdr } = await import("../src/runtime/herdr.ts");
import type { Exec, ExecResult } from "../src/exec.ts";
import type { PlannerExec } from "../src/planner.ts";

const OK = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const has = (argv: string[], ...xs: string[]) => xs.every((x) => argv.includes(x));

const PLAN = {
  kind: "plan",
  goal: "critique plan checkpoints",
  approach: "run a sonnet one-shot on the plan and attach the result",
  files_expected: ["server/src/planCritic.ts"],
  verification_planned: "bun test server/test/plan-critic.test.ts",
};

function makeServer(opts: { concerns?: any[]; plannerCode?: number; stdout?: string } = {}) {
  const db = openDb(":memory:");
  const sent: string[] = [];
  const prompts: string[] = [];
  const exec: Exec = async (argv) => {
    if (has(argv, "agent", "send")) {
      sent.push(argv[argv.length - 1]!);
      return OK("{}");
    }
    return OK();
  };
  const plannerExec: PlannerExec = async (argv) => {
    prompts.push(argv[4] ?? "");
    if (opts.plannerCode) return { code: opts.plannerCode, stdout: "", stderr: "model unavailable" };
    return {
      code: 0,
      stdout: opts.stdout ?? JSON.stringify({ result: JSON.stringify({ concerns: opts.concerns ?? [] }) }),
      stderr: "",
    };
  };
  const herdr = new Herdr(exec, "herdr");
  const server = Bun.serve({ port: 0, fetch: makeHandler(db, { herdr, exec, plannerExec }) });
  return { db, server, base: `http://127.0.0.1:${server.port}`, sent, prompts };
}

async function post(base: string, path: string, body: unknown) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any };
}
async function get(base: string, path: string) {
  const res = await fetch(base + path);
  return { status: res.status, json: (await res.json()) as any };
}

async function makeTask(base: string, config: any = {}) {
  const p = await post(base, "/api/projects", { name: "p", repo_path: "/repo", config });
  const t = await post(base, "/api/tasks", { project_id: p.json.id, title: "do a thing", brief: "the brief" });
  return { projectId: p.json.id as string, id: t.json.id as string };
}

// The critique lands in the background, so poll for it.
async function waitForEvent(base: string, id: string, type: string) {
  for (let i = 0; i < 100; i++) {
    const events = await get(base, `/api/tasks/${id}/events`);
    const ev = events.json.find((e: any) => e.type === type);
    if (ev) return ev;
    await new Promise((r) => setTimeout(r, 20));
  }
  return null;
}

test("a plan checkpoint keeps its fields and gets a critique linked to it", async () => {
  const s = makeServer({ concerns: [{ severity: "note", text: "The plan never says how failures are logged." }] });
  const { id } = await makeTask(s.base);
  const res = await post(s.base, `/api/tasks/${id}/events`, { type: "checkpoint", ...PLAN });
  expect(res.status).toBe(201);
  expect(res.json.event.payload.goal).toBe(PLAN.goal);
  expect(res.json.event.payload.files_expected).toEqual(PLAN.files_expected);
  // A plan with no --note still reads as something in the checkpoint list.
  expect(res.json.event.payload.note).toBe(PLAN.goal);

  const critique = await waitForEvent(s.base, id, "plan_critique");
  expect(critique.payload.checkpoint_id).toBe(res.json.event.id);
  expect(critique.payload.concerns).toEqual([
    { severity: "note", text: "The plan never says how failures are logged." },
  ]);
  // The critic saw both the plan and the task brief.
  expect(s.prompts.join("\n")).toContain(PLAN.approach);
  expect(s.prompts.join("\n")).toContain("the brief");
  // A note-severity concern does not interrupt the agent.
  expect(s.sent.filter((m) => m.includes("VETO")).length).toBe(0);
  s.server.stop(true);
});

test("a veto concern steers the agent, quoting the concern", async () => {
  const s = makeServer({ concerns: [{ severity: "veto", text: "This plan edits the wrong module." }] });
  const { id } = await makeTask(s.base);
  await post(s.base, `/api/tasks/${id}/spawn`, {});
  await post(s.base, `/api/tasks/${id}/events`, { type: "checkpoint", ...PLAN });

  const critique = await waitForEvent(s.base, id, "plan_critique");
  expect(critique.payload.concerns[0].severity).toBe("veto");
  const steer = await waitForEvent(s.base, id, "steer");
  expect(steer.payload.message).toContain("This plan edits the wrong module.");
  expect(steer.payload.message).toContain("VETO");
  s.server.stop(true);
});

test("an ordinary checkpoint is not critiqued", async () => {
  const s = makeServer({ concerns: [{ severity: "veto", text: "nope" }] });
  const { id } = await makeTask(s.base);
  const res = await post(s.base, `/api/tasks/${id}/events`, { type: "checkpoint", note: "assumed UTC, it is the default" });
  expect(res.json.event.payload.note).toBe("assumed UTC, it is the default");
  await new Promise((r) => setTimeout(r, 150));
  const events = await get(s.base, `/api/tasks/${id}/events`);
  expect(events.json.some((e: any) => e.type === "plan_critique")).toBe(false);
  expect(s.sent.length).toBe(0);
  // It still shows up as an open checkpoint for the director.
  const open = await get(s.base, `/api/checkpoints`);
  expect(open.json.checkpoints.some((c: any) => c.note === "assumed UTC, it is the default")).toBe(true);
  s.server.stop(true);
});

test("a critic failure attaches no concerns and never steers", async () => {
  const s = makeServer({ plannerCode: 1 });
  const { id } = await makeTask(s.base);
  await post(s.base, `/api/tasks/${id}/spawn`, {});
  await post(s.base, `/api/tasks/${id}/events`, { type: "checkpoint", ...PLAN });
  const critique = await waitForEvent(s.base, id, "plan_critique");
  expect(critique.payload.concerns).toEqual([]);
  expect(critique.payload.error).toContain("critic exited 1");
  expect(s.sent.length).toBe(0);
  s.server.stop(true);
});

test("unparseable critic output is treated as no concerns", async () => {
  const s = makeServer({ stdout: "I could not review this plan." });
  const { id } = await makeTask(s.base);
  await post(s.base, `/api/tasks/${id}/events`, { type: "checkpoint", ...PLAN });
  const critique = await waitForEvent(s.base, id, "plan_critique");
  expect(critique.payload.concerns).toEqual([]);
  s.server.stop(true);
});

test("the plan checkpoint instruction appears only for the kinds the project opts in", async () => {
  const s = makeServer();
  const off = await makeTask(s.base);
  expect(composeBrief(s.db, off.id)).not.toContain("Plan checkpoint (before your first edit)");

  const on = await makeTask(s.base, { plan_gate: { kinds: ["ship"], block: false } });
  expect(composeBrief(s.db, on.id)).toContain("Plan checkpoint (before your first edit)");
  expect(composeBrief(s.db, on.id)).toContain('"kind":"plan"');

  // A kind outside the list is not asked for a plan.
  const chore = await post(s.base, "/api/tasks", { project_id: on.projectId, title: "tidy up", kind: "chore", brief: "b" });
  expect(composeBrief(s.db, chore.json.id)).not.toContain("Plan checkpoint (before your first edit)");
  s.server.stop(true);
});

test("plan_gate config is validated", async () => {
  const s = makeServer();
  const bad = await post(s.base, "/api/projects", { name: "bad", repo_path: "/repo", config: { plan_gate: { kinds: "ship" } } });
  expect(bad.status).toBe(400);
  const worse = await post(s.base, "/api/projects", { name: "worse", repo_path: "/repo", config: { plan_gate: { kinds: [], nope: 1 } } });
  expect(worse.status).toBe(400);
  s.server.stop(true);
});
