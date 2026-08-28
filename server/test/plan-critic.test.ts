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
const { autoAckPlans } = await import("../src/planCritic.ts");
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

// ---- HIVE-413: optional blocking plan approval ----

const BLOCKING = { kinds: ["ship"], block: true };

test("blocking on: the brief tells the agent to wait, and the ack releases it", async () => {
  const s = makeServer({ concerns: [{ severity: "note", text: "The plan skips the migration." }] });
  const { id } = await makeTask(s.base, { plan_gate: BLOCKING });
  const brief = composeBrief(s.db, id);
  expect(brief).toContain("This project BLOCKS on the plan");
  expect(brief).toContain("END YOUR TURN");
  expect(brief).not.toContain("this checkpoint never blocks you");

  await post(s.base, `/api/tasks/${id}/spawn`, {});
  const res = await post(s.base, `/api/tasks/${id}/events`, { type: "checkpoint", ...PLAN });
  expect(res.json.event.payload.blocking).toBe(true);
  // Posting the plan does not release anything on its own.
  expect((await get(s.base, `/api/tasks/${id}/events`)).json.some((e: any) => e.type === "steer")).toBe(false);

  // The Needs You card carries the plan and the critic's concerns.
  await waitForEvent(s.base, id, "plan_critique");
  const open = await get(s.base, "/api/checkpoints");
  const card = open.json.checkpoints.find((c: any) => c.id === res.json.event.id);
  expect(card.blocking).toBe(true);
  expect(card.plan.goal).toBe(PLAN.goal);
  expect(card.plan.files_expected).toEqual(PLAN.files_expected);
  expect(card.concerns).toEqual([{ severity: "note", text: "The plan skips the migration." }]);

  // Approving sends the release steer.
  await post(s.base, `/api/tasks/${id}/checkpoints/${res.json.event.id}/ack`, { verdict: "ok" });
  const release = await waitForEvent(s.base, id, "steer");
  expect(release.payload.message).toContain("APPROVED");
  expect(release.payload.message).toContain("start editing");
  s.server.stop(true);
});

test("blocking on: a flag tells the agent to re-plan and wait again", async () => {
  const s = makeServer();
  const { id } = await makeTask(s.base, { plan_gate: BLOCKING });
  // A live agent target, as a real spawn would leave it: the flag steers the
  // parked agent instead of spawning a corrective task.
  s.db.query("UPDATE tasks SET agent_target = 'sess:plan' WHERE id = ?").run(id);
  const res = await post(s.base, `/api/tasks/${id}/events`, { type: "checkpoint", ...PLAN });
  await post(s.base, `/api/tasks/${id}/checkpoints/${res.json.event.id}/ack`, {
    verdict: "flag",
    note: "wrong module",
  });
  const steer = await waitForEvent(s.base, id, "steer");
  expect(steer.payload.message).toContain("FLAGGED");
  expect(steer.payload.message).toContain("wrong module");
  expect(steer.payload.message).toContain("wait for the next ack");
  s.server.stop(true);
});

test("blocking off: nothing about the plan checkpoint changes", async () => {
  const s = makeServer();
  const { id } = await makeTask(s.base, { plan_gate: { kinds: ["ship"] } });
  expect(composeBrief(s.db, id)).toContain("this checkpoint never blocks you");
  await post(s.base, `/api/tasks/${id}/spawn`, {});
  const res = await post(s.base, `/api/tasks/${id}/events`, { type: "checkpoint", ...PLAN });
  expect(res.json.event.payload.blocking).toBeUndefined();

  const open = await get(s.base, "/api/checkpoints");
  expect(open.json.checkpoints.find((c: any) => c.id === res.json.event.id).blocking).toBeUndefined();

  // The classic ack path: an approval is silent, a flag uses the old wording.
  await post(s.base, `/api/tasks/${id}/checkpoints/${res.json.event.id}/ack`, { verdict: "ok" });
  const events = (await get(s.base, `/api/tasks/${id}/events`)).json;
  expect(events.some((e: any) => e.type === "steer")).toBe(false);
  s.server.stop(true);
});

test("auto-ack releases a plan the director never acked, and only after the window", async () => {
  const s = makeServer();
  const { id } = await makeTask(s.base, { plan_gate: { ...BLOCKING, auto_ack_hours: 4 } });
  await post(s.base, `/api/tasks/${id}/spawn`, {});
  const res = await post(s.base, `/api/tasks/${id}/events`, { type: "checkpoint", ...PLAN });
  const steer = async (_taskId: string, message: string) => {
    s.sent.push(message);
  };

  // Three hours in: still the director's call.
  expect(await autoAckPlans(s.db, { steer, nowMs: Date.now() + 3 * 3_600_000 })).toBe(0);
  expect(s.sent.filter((m) => m.includes("APPROVED")).length).toBe(0);

  // Past four hours: hive acks it and releases the agent.
  expect(await autoAckPlans(s.db, { steer, nowMs: Date.now() + 5 * 3_600_000 })).toBe(1);
  expect(s.sent.at(-1)).toContain("APPROVED");
  expect(s.sent.at(-1)).toContain("Auto-approved after 4h");
  const open = await get(s.base, "/api/checkpoints");
  expect(open.json.checkpoints.some((c: any) => c.id === res.json.event.id)).toBe(false);

  // It only fires once.
  expect(await autoAckPlans(s.db, { steer, nowMs: Date.now() + 99 * 3_600_000 })).toBe(0);
  s.server.stop(true);
});

test("auto-ack is off by default: a blocking plan waits for a human", async () => {
  const s = makeServer();
  const { id } = await makeTask(s.base, { plan_gate: BLOCKING });
  await post(s.base, `/api/tasks/${id}/spawn`, {});
  await post(s.base, `/api/tasks/${id}/events`, { type: "checkpoint", ...PLAN });
  const acked = await autoAckPlans(s.db, {
    steer: async () => {},
    nowMs: Date.now() + 1000 * 3_600_000,
  });
  expect(acked).toBe(0);
  s.server.stop(true);
});

test("plan_gate.auto_ack_hours is validated", async () => {
  const s = makeServer();
  const bad = await post(s.base, "/api/projects", {
    name: "bad",
    repo_path: "/repo",
    config: { plan_gate: { kinds: ["ship"], block: true, auto_ack_hours: "4" } },
  });
  expect(bad.status).toBe(400);
  const zero = await post(s.base, "/api/projects", {
    name: "zero",
    repo_path: "/repo",
    config: { plan_gate: { auto_ack_hours: 0 } },
  });
  expect(zero.status).toBe(400);
  s.server.stop(true);
});
