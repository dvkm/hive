import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point evidence storage at a throwaway dir before importing anything that reads it.
const HOME = mkdtempSync(join(tmpdir(), "hive-test-"));
process.env.HIVE_HOME = HOME;

const { openDb, setSetting } = await import("../src/db.ts");
const { makeHandler } = await import("../src/api.ts");
const { createThread } = await import("../src/chat.ts");
import type { Fetcher } from "../src/monitors.ts";

const db = openDb(":memory:");
const server = Bun.serve({ port: 0, fetch: makeHandler(db) });
const BASE = `http://127.0.0.1:${server.port}`;

afterAll(() => server.stop(true));

async function post(path: string, body: unknown) {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}
async function get(path: string) {
  const res = await fetch(BASE + path);
  return { status: res.status, json: await res.json() };
}
async function put(path: string, body: unknown) {
  const res = await fetch(BASE + path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

let projectId = "";
let taskId = "";

beforeAll(async () => {
  const p = await post("/api/projects", { name: "test-proj", repo_path: "/tmp/x" });
  projectId = p.json.id;
  const t = await post("/api/tasks", { project_id: projectId, title: "test task" });
  taskId = t.json.id;
});

test("health endpoint", async () => {
  const { json } = await get("/api/health");
  expect(json.ok).toBe(true);
});

test("health endpoint reports dispatcher/reaper liveness, stale before any cycle has run", async () => {
  const { json } = await get("/api/health");
  expect(json.dispatcher).toEqual({ last_run: null, stale: true });
  expect(json.reaper).toEqual({ last_run: null, stale: true });
});

test("health endpoint surfaces herdr_outage only during an active backoff window", async () => {
  // No backoff set → absent (null).
  expect((await get("/api/health")).json.herdr_outage).toBeNull();

  // Backoff in the future → the outage indicator appears with its streak.
  setSetting(db, "herdr_outage_streak", "3");
  setSetting(db, "herdr_backoff_until", new Date(Date.now() + 60_000).toISOString());
  const active = (await get("/api/health")).json.herdr_outage;
  expect(active.streak).toBe(3);
  expect(Date.parse(active.paused_until)).toBeGreaterThan(Date.now());

  // Backoff in the past (daemon recovered) → gone again.
  setSetting(db, "herdr_backoff_until", new Date(Date.now() - 1_000).toISOString());
  expect((await get("/api/health")).json.herdr_outage).toBeNull();
});

// task #1096: the reconciler errored every cycle (gh ENOENT) for ~27min live
// with /health reporting ok:true the whole time, because nothing recorded its
// outcome anywhere /health could read. consecutive_errors is the signal; a
// fresh boot (never run yet, 0 errors) must NOT itself flip ok false.
test("health endpoint surfaces reconciler heartbeat and flips ok false once failures cross the sustained threshold (task #1096)", async () => {
  let h = (await get("/api/health")).json;
  expect(h.ok).toBe(true);
  expect(h.reconciler).toEqual({ last_run: null, stale: true, consecutive_errors: 0, last_error: null });

  // Below the sustained-failure threshold: visible, but ok stays true.
  setSetting(db, "last_reconcile_at", new Date().toISOString());
  setSetting(db, "reconciler_error_streak", "2");
  setSetting(db, "reconciler_last_error", "linkPRs: posix_spawn gh ENOENT (-2)");
  h = (await get("/api/health")).json;
  expect(h.ok).toBe(true);
  expect(h.reconciler.stale).toBe(false);
  expect(h.reconciler.consecutive_errors).toBe(2);
  expect(h.reconciler.last_error).toContain("ENOENT");

  // Sustained failure (3+ consecutive cycles): ok flips false.
  setSetting(db, "reconciler_error_streak", "3");
  h = (await get("/api/health")).json;
  expect(h.ok).toBe(false);

  // Recovery: a clean cycle resets the streak, ok recovers.
  setSetting(db, "reconciler_error_streak", "0");
  expect((await get("/api/health")).json.ok).toBe(true);
});

test("health endpoint exposes pty/session utilization once the reaper has counted", async () => {
  // Absent until the first pane sweep records a count.
  expect((await get("/api/health")).json.sessions).toBeNull();

  // Healthy working set: below the warn threshold.
  setSetting(db, "herdr_pane_count", "60");
  setSetting(db, "herdr_pane_at", new Date().toISOString());
  const ok = (await get("/api/health")).json.sessions;
  expect(ok.panes).toBe(60);
  expect(ok.max).toBe(511);
  expect(ok.warn).toBe(false);

  // Approaching the wall: warn flips on past 80% of the cap.
  setSetting(db, "herdr_pane_count", "450");
  const hot = (await get("/api/health")).json.sessions;
  expect(hot.panes).toBe(450);
  expect(hot.warn).toBe(true);
});

test("task create + list + get", async () => {
  const list = await get("/api/tasks");
  expect(list.json.some((t: any) => t.id === taskId)).toBe(true);
  const one = await get(`/api/tasks/${taskId}`);
  expect(one.json.id).toBe(taskId);
  expect(one.json.project_number).toBe(1);
  expect(one.json.display_id).toBe("TEST-1");
  expect(Array.isArray(one.json.events)).toBe(true);
});

test("every unrecorded task action failure gets a durable receipt", async () => {
  const failed = await post(`/api/tasks/${taskId}/transition`, { to: "queued" });
  expect(failed.status).toBe(409);
  const events = (await get(`/api/tasks/${taskId}/events`)).json;
  const receipt = events.findLast((event: any) => event.type === "action_failed");
  expect(receipt.payload).toMatchObject({ action: "POST /transition", status: 409 });
  expect(receipt.payload.reason).toContain("already in state");
});

test("agent-created task carries source + parent_task_id", async () => {
  const r = await post("/api/tasks", {
    project_id: projectId,
    title: "follow-up from agent",
    source: "agent",
    parent_task_id: taskId,
  });
  expect(r.status).toBe(201);
  expect(r.json.source).toBe("agent");
  expect(r.json.parent_task_id).toBe(taskId);
  const bad = await post("/api/tasks", {
    project_id: projectId,
    title: "bad parent",
    parent_task_id: "nope",
  });
  expect(bad.status).toBe(400);
});

test("HIVE-299: follow-up task auto-depends on a parent whose PR hasn't merged yet", async () => {
  const parent = await post("/api/tasks", { project_id: projectId, title: "parent with open PR" });
  const child = await post("/api/tasks", {
    project_id: projectId,
    title: "follow-up describing parent's unmerged code",
    source: "agent",
    parent_task_id: parent.json.id,
  });
  expect(child.json.depends_on).toEqual([parent.json.id]);

  const { unmetDeps } = await import("../src/state.ts");
  expect(unmetDeps(db, child.json).map((d: any) => d.id)).toEqual([parent.json.id]);

  // once the parent's PR has merged (state -> verifying/done), a NEW follow-up
  // should not be auto-blocked on it.
  await db.query("UPDATE tasks SET state = 'verifying' WHERE id = ?").run(parent.json.id);
  const child2 = await post("/api/tasks", {
    project_id: projectId,
    title: "follow-up filed after parent merged",
    source: "agent",
    parent_task_id: parent.json.id,
  });
  expect(child2.json.depends_on).toEqual([]);

  // an explicit depends_on isn't duplicated
  await db.query("UPDATE tasks SET state = 'queued' WHERE id = ?").run(parent.json.id);
  const child3 = await post("/api/tasks", {
    project_id: projectId,
    title: "follow-up with explicit dep on unmerged parent",
    source: "agent",
    parent_task_id: parent.json.id,
    depends_on: parent.json.id,
  });
  expect(child3.json.depends_on).toEqual([parent.json.id]);
});

test("PUT /api/tasks/:id can declare a dependency after creation, mid-task", async () => {
  const a = await post("/api/tasks", { project_id: projectId, title: "blocker PR" });
  const b = await post("/api/tasks", { project_id: projectId, title: "depends on blocker, discovered mid-task" });
  expect(b.json.depends_on).toEqual([]);

  const updated = await put(`/api/tasks/${b.json.id}`, { depends_on: a.json.id });
  expect(updated.status).toBe(200);
  expect(updated.json.depends_on).toEqual([a.json.id]);

  // unmetDeps (the mechanism hive-1027's Needs You "waiting" classification
  // reads) picks it up live — no further plumbing needed.
  const { unmetDeps } = await import("../src/state.ts");
  expect(unmetDeps(db, updated.json).map((d: any) => d.id)).toEqual([a.json.id]);

  // unknown dep id -> 400, task untouched
  const badDep = await put(`/api/tasks/${b.json.id}`, { depends_on: "nope" });
  expect(badDep.status).toBe(400);

  // a task cannot depend on itself
  const selfDep = await put(`/api/tasks/${b.json.id}`, { depends_on: b.json.id });
  expect(selfDep.status).toBe(400);

  // omitting depends_on entirely leaves it alone (only title/brief change)
  const titleOnly = await put(`/api/tasks/${b.json.id}`, { title: "renamed" });
  expect(titleOnly.status).toBe(200);
  expect(titleOnly.json.depends_on).toEqual([a.json.id]);
});

test("tracking-only tasks cannot mint direct, checkpoint, or learning work", async () => {
  const tracking = await post("/api/tasks", {
    project_id: projectId,
    title: "Jira ownership boundary",
    source: "external",
  });
  const child = await post("/api/tasks", {
    project_id: projectId,
    title: "forbidden child",
    parent_task_id: tracking.json.id,
  });
  expect(child.status).toBe(409);

  const prebound = await post("/api/tasks", {
    project_id: projectId,
    title: "forbidden binding",
    source: "external",
    agent_target: "legacy-agent",
  });
  // Rejected by createTask's own source=external + agent_target guard (400),
  // which lands before the tracking-only ownership check would (hive-996).
  expect(prebound.status).toBe(400);

  const checkpoint = await post(`/api/tasks/${tracking.json.id}/events`, { type: "checkpoint", note: "needs agent follow-up" });
  const flagged = await post(`/api/tasks/${tracking.json.id}/checkpoints/${checkpoint.json.event.id}/ack`, { verdict: "flag" });
  expect(flagged.status).toBe(409);

  const learning = await post("/api/learnings", {
    project_id: projectId,
    title: "tracking-only failure",
    kind: "failure",
    source_task_id: tracking.json.id,
    create_root_cause_task: true,
  });
  expect(learning.status).toBe(409);
  expect(db.query("SELECT COUNT(*) AS n FROM tasks WHERE parent_task_id = ?").get(tracking.json.id)).toEqual({ n: 0 });
});

test("hive-1264 gap B: a plain external tracking task accepts director brief edits; a Jira mirror does not", async () => {
  const log = await post("/api/tasks", {
    project_id: projectId,
    title: "director-owned observations log",
    source: "external",
  });
  const edited = await put(`/api/tasks/${log.json.id}`, { brief: "item 20: appended by the director" });
  expect(edited.status).toBe(200);
  expect(edited.json.brief).toBe("item 20: appended by the director");

  const mirror = await post("/api/tasks", { project_id: projectId, title: "WEB-1", source: "agent" });
  db.query("UPDATE tasks SET source_ref = ? WHERE id = ?").run("jira:WEB-1", mirror.json.id);
  const blocked = await put(`/api/tasks/${mirror.json.id}`, { brief: "trying to edit a mirror" });
  expect(blocked.status).toBe(409);
  expect(blocked.json.error).toContain("jira:WEB-1");
});

test("the shared spawn boundary rejects external and Jira-linked tasks", async () => {
  const external = await post("/api/tasks", {
    project_id: projectId,
    title: "external tracking only",
    source: "external",
  });
  const linked = await post("/api/tasks", {
    project_id: projectId,
    title: "Jira-linked tracking only",
    source: "agent",
  });
  db.query("UPDATE tasks SET source_ref = ? WHERE id = ?").run("jira:WEB-9999", linked.json.id);

  // Both are refused at the shared spawn core, for DIFFERENT and both-correct
  // reasons: the plain external task has never been dispatched (hive-996), the
  // Jira-linked one mirrors someone else's ticket and never gets an agent at
  // all. Asserting the specific reason keeps the two rules distinguishable.
  for (const [id, reason] of [
    [external.json.id, "never been spawned"],
    [linked.json.id, "mirrors a Jira issue"],
  ] as const) {
    const result = await post(`/api/tasks/${id}/spawn`, {});
    expect(result.status).toBe(502);
    expect(result.json.error).toContain(reason);
    expect((await get(`/api/tasks/${id}`)).json.state).toBe("queued");
    const events = (await get(`/api/tasks/${id}/events`)).json;
    expect(events.some((event: any) => ["spawned", "spawn_error"].includes(event.type))).toBe(false);
  }
});

test("review_summary keeps its structured sections; empty submission is rejected", async () => {
  const t = await post("/api/tasks", { project_id: projectId, title: "rs task" });
  const longQuestion = "cms-e2e.yml requires VITE_CMS_URL to use host.docker.internal:5175 rather than localhost:5175, even though both names can sound like the same Vite server. Given the reasoning that made this task's WEB_URL override safe, why would replacing host.docker.internal with localhost break this suite when the browser runs from a separate Docker container?";
  const longOption = "Because localhost is resolved by the process using it. From the Playwright container it points back to that container, not to the host machine running Vite, while host.docker.internal provides the route back to the host. The WEB_URL override compared two host-reachable preview endpoints, so it did not cross that container boundary.";
  expect(longQuestion.length).toBeGreaterThan(300);
  expect(longOption.length).toBeGreaterThan(300);
  const r = await post(`/api/tasks/${t.json.id}/events`, {
    type: "review_summary",
    done: ["fixed the save flow"],
    iffy: [{ what: "used a global lock", why: "simplest correct option" }],
    testing: ["bun test green"],
    understanding: {
      background: "Saves used one shared queue.",
      scope: "The editor queue and offline-save path were examined.",
      essence: "The queue now preserves the newest edit.",
      walkthrough: ["An edit enters the queue.", 42, "The newest edit wins."],
      affected_areas: ["Draft editor", 42, "Offline saves"],
      risk_assessment: "The queue is covered, but browser shutdown can still interrupt a save.",
      participate: "We can now consider offline saves.",
      check: {
        question: "Which edit wins?",
        options: [{ key: "old", label: "The oldest one." }, { key: "new", label: "The newest one." }, { key: "bad" }],
        answer_key: "new",
        explanation: "The queue preserves the latest accepted edit.",
      },
      checks: [
        {
          question: longQuestion,
          options: [{ key: "old", label: longOption }, { key: "new", label: "The newest one." }],
          answer_key: "new",
          explanation: "The queue preserves the latest accepted edit.",
        },
        {
          question: "What happens after a newer edit arrives?",
          options: [{ key: "replace", label: "It replaces the queued edit." }, { key: "ignore", label: "It is ignored." }],
          answer_key: "replace",
        },
      ],
    },
  });
  expect(r.status).toBe(201);
  expect(r.json.event.payload.done).toEqual(["fixed the save flow"]);
  expect(r.json.event.payload.iffy[0].what).toBe("used a global lock");
  expect(r.json.event.payload.understanding.walkthrough).toEqual(["An edit enters the queue.", "The newest edit wins."]);
  expect(r.json.event.payload.understanding.scope).toBe("The editor queue and offline-save path were examined.");
  expect(r.json.event.payload.understanding.affected_areas).toEqual(["Draft editor", "Offline saves"]);
  expect(r.json.event.payload.understanding.risk_assessment).toBe("The queue is covered, but browser shutdown can still interrupt a save.");
  expect(r.json.event.payload.understanding.checks).toHaveLength(2);
  expect(r.json.event.payload.understanding.checks[0].question).toBe(longQuestion);
  expect(r.json.event.payload.understanding.checks[0].options[0].label).toBe(longOption);
  expect(r.json.event.payload.understanding.checks[1].answer_key).toBe("replace");
  expect(r.json.event.payload.understanding.check).toBeUndefined();
  expect(r.json.event.payload.note).toBeUndefined();

  const legacyBank = await post(`/api/tasks/${t.json.id}/events`, {
    type: "review_summary",
    understanding: {
      check: [
        { question: "First angle?", options: [{ key: "yes", label: "Yes." }, { key: "no", label: "No." }], answer_key: "yes" },
        { question: "Second angle?", options: [{ key: "yes", label: "Yes." }, { key: "no", label: "No." }], answer_key: "yes" },
      ],
    },
  });
  expect(legacyBank.json.event.payload.understanding.checks).toHaveLength(2);
  expect(legacyBank.json.event.payload.understanding.check).toBeUndefined();

  const bad = await post(`/api/tasks/${t.json.id}/events`, { type: "review_summary", note: "hi" });
  expect(bad.status).toBe(400);

  for (const question of [
    "You find that a shared resource is blocking your task. What should you do?",
    "A PR is green, but merge keeps failing. Where else could the actual blocker live?",
    "Your branch needs new base commits, but force-pushing is denied. What's the correct move?",
  ]) {
    const agentTraining = await post(`/api/tasks/${t.json.id}/events`, {
      type: "review_summary",
      done: ["reviewed the change"],
      understanding: {
        checks: [{
          question,
          options: [{ key: "inspect", label: "Inspect the worker environment." }, { key: "ignore", label: "Ignore it." }],
          answer_key: "inspect",
        }],
      },
    });
    expect(agentTraining.status).toBe(400);
    expect(agentTraining.json.error).toContain("teach the director");
  }
});

test("checkpoints: emit -> listed open -> ack removes; flag steers; bad verdict 400", async () => {
  const t = await post("/api/tasks", { project_id: projectId, title: "cp task" });
  await post(`/api/tasks/${t.json.id}/transition`, { to: "in_progress" });
  const e1 = await post(`/api/tasks/${t.json.id}/events`, { type: "checkpoint", note: "assuming KST for defaults" });
  expect(e1.status).toBe(201);
  const cpId = e1.json.event.id;

  let open = await get("/api/checkpoints");
  expect(open.json.checkpoints.some((c: any) => c.id === cpId && c.note.includes("KST"))).toBe(true);

  const bad = await post(`/api/tasks/${t.json.id}/checkpoints/${cpId}/ack`, { verdict: "maybe" });
  expect(bad.status).toBe(400);
  const missing = await post(`/api/tasks/${t.json.id}/checkpoints/evt_nope/ack`, { verdict: "ok" });
  expect(missing.status).toBe(404);

  const ok = await post(`/api/tasks/${t.json.id}/checkpoints/${cpId}/ack`, { verdict: "ok", actor: "director-tab-a" });
  expect(ok.status).toBe(200);
  const stale = await post(`/api/tasks/${t.json.id}/checkpoints/${cpId}/ack`, { verdict: "flag", actor: "director-tab-b" });
  expect(stale.status).toBe(409);
  expect(stale.json).toMatchObject({
    stale: true,
    resolution: { source: "director", actor: "director-tab-a", verdict: "ok" },
  });
  expect(stale.json.error).toContain("director-tab-a");
  open = await get("/api/checkpoints");
  expect(open.json.checkpoints.some((c: any) => c.id === cpId)).toBe(false);

  // flag while the task is live but agentless: recorded, and (no delivery
  // possible) routed to a corrective follow-up task
  const e2 = await post(`/api/tasks/${t.json.id}/events`, { type: "checkpoint", note: "global lock for saves" });
  const flag = await post(`/api/tasks/${t.json.id}/checkpoints/${e2.json.event.id}/ack`, { verdict: "flag", note: "per-account locks please" });
  expect(flag.status).toBe(200);
  const evs = await get(`/api/tasks/${t.json.id}/events`);
  expect(evs.json.some((e: any) => e.type === "checkpoint_ack" && e.payload.verdict === "flag" && e.payload.note === "per-account locks please")).toBe(true);
  expect(flag.json.followup_task_id).toBeTruthy();
  const fu = await get(`/api/tasks/${flag.json.followup_task_id}`);
  expect(fu.json.source).toBe("checkpoint_flag");
  expect(fu.json.parent_task_id).toBe(t.json.id);
  expect(fu.json.brief).toContain("per-account locks please");

  const e3 = await post(`/api/tasks/${t.json.id}/events`, { type: "checkpoint", note: "kept the existing route shape" });
  const checkpointManager = createThread(db, { project_id: projectId });
  const supervisorAck = await post(`/api/tasks/${t.json.id}/checkpoints/${e3.json.event.id}/ack`, {
    verdict: "ok",
    source: "chat_supervisor",
    actor: checkpointManager.id,
  });
  expect(supervisorAck.status).toBe(200);
  const afterSupervisorAck = await get(`/api/tasks/${t.json.id}/events`);
  const audit = afterSupervisorAck.json.find((e: any) => e.type === "checkpoint_ack" && e.payload.checkpoint_id === e3.json.event.id);
  expect(audit.source).toBe("chat_supervisor");
  expect(audit.payload.actor).toBe(checkpointManager.id);

  const e4 = await post(`/api/tasks/${t.json.id}/events`, { type: "checkpoint", note: "still open after invalid caller" });
  const invalidSource = await post(`/api/tasks/${t.json.id}/checkpoints/${e4.json.event.id}/ack`, {
    verdict: "ok",
    source: "impersonator",
  });
  expect(invalidSource.status).toBe(400);
  open = await get(`/api/checkpoints?project_id=${projectId}`);
  expect(open.json.checkpoints.some((c: any) => c.id === e4.json.event.id)).toBe(true);

  const otherProject = await post("/api/projects", { name: "checkpoint filter", repo_path: "/tmp/filter" });
  const otherTask = await post("/api/tasks", { project_id: otherProject.json.id, title: "other project checkpoint" });
  const otherCheckpoint = await post(`/api/tasks/${otherTask.json.id}/events`, { type: "checkpoint", note: "other project" });
  open = await get(`/api/checkpoints?project_id=${projectId}`);
  expect(open.json.checkpoints.some((c: any) => c.id === otherCheckpoint.json.event.id)).toBe(false);
});

test("tracking-only tasks move freely without automatic smoke advancement", async () => {
  const t = await post("/api/tasks", { project_id: projectId, title: "tracked by another agent", source: "external" });
  expect(t.json.source).toBe("external");
  await post(`/api/tasks/${t.json.id}/transition`, { to: "in_progress" });
  await post(`/api/tasks/${t.json.id}/transition`, { to: "in_review" });
  const verifying = await post(`/api/tasks/${t.json.id}/transition`, { to: "verifying" });
  expect(verifying.json.state).toBe("verifying");
  const done = await post(`/api/tasks/${t.json.id}/transition`, { to: "done" });
  expect(done.json.state).toBe("done");
});

test("checkpoints survive task completion; cancelled tasks drop out", async () => {
  const t = await post("/api/tasks", { project_id: projectId, title: "cp survive" });
  await post(`/api/tasks/${t.json.id}/transition`, { to: "in_progress" });
  const e1 = await post(`/api/tasks/${t.json.id}/events`, { type: "checkpoint", note: "kept a shortcut" });
  // finish the task (evidence so done passes the gate)
  await post(`/api/tasks/${t.json.id}/events`, { type: "evidence", kind: "log", note: "proof" });
  await post(`/api/tasks/${t.json.id}/transition`, { to: "in_review" });
  await post(`/api/tasks/${t.json.id}/transition`, { to: "verifying" }); // auto-advances to done
  let open = await get("/api/checkpoints");
  const mine = open.json.checkpoints.find((c: any) => c.id === e1.json.event.id);
  expect(mine).toBeTruthy();
  expect(mine.task_state).toBe("done");

  // cancelled task's checkpoints disappear
  const t2 = await post("/api/tasks", { project_id: projectId, title: "cp cancel" });
  await post(`/api/tasks/${t2.json.id}/transition`, { to: "in_progress" });
  const e2 = await post(`/api/tasks/${t2.json.id}/events`, { type: "checkpoint", note: "x" });
  await post(`/api/tasks/${t2.json.id}/transition`, { to: "cancelled" });
  open = await get("/api/checkpoints");
  expect(open.json.checkpoints.some((c: any) => c.id === e2.json.event.id)).toBe(false);
});

test("event ingestion: status event is recorded", async () => {
  const r = await post(`/api/tasks/${taskId}/events`, { type: "status", note: "working" });
  expect(r.status).toBe(201);
  const events = await get(`/api/tasks/${taskId}/events`);
  expect(events.json.some((e: any) => e.type === "status" && e.payload.note === "working")).toBe(true);
});

test("transition endpoint enforces the state machine", async () => {
  const bad = await post(`/api/tasks/${taskId}/events`, { type: "done" });
  expect(bad.status).toBe(409); // no evidence yet
  await post(`/api/tasks/${taskId}/transition`, { to: "in_progress" });
  const bad2 = await post(`/api/tasks/${taskId}/transition`, { to: "done" });
  expect(bad2.status).toBe(409);
});

test("in_review task with a PR refuses a direct move to verifying (must use /merge)", async () => {
  const t = await post("/api/tasks", { project_id: projectId, title: "pr bypass task" });
  const id = t.json.id;
  await post(`/api/tasks/${id}/transition`, { to: "in_progress" });
  await post(`/api/tasks/${id}/events`, { type: "evidence", note: "proof", kind: "log" });
  await post(`/api/tasks/${id}/events`, { type: "ready", pr_url: "https://gh/pr/99" });

  const r = await post(`/api/tasks/${id}/transition`, { to: "verifying" });
  expect(r.status).toBe(409);
  expect(r.json.error).toContain("/merge");
  expect((await get(`/api/tasks/${id}`)).json.state).toBe("in_review");
});

test("ready emit records the pr_url and advances in_progress -> in_review", async () => {
  const t = await post("/api/tasks", { project_id: projectId, title: "ready task" });
  const id = t.json.id;
  await post(`/api/tasks/${id}/transition`, { to: "in_progress" });
  await post(`/api/tasks/${id}/events`, { type: "evidence", note: "proof", kind: "log" });

  const r = await post(`/api/tasks/${id}/events`, { type: "ready", pr_url: "https://gh/pr/42", note: "PR up" });
  expect(r.status).toBe(200);
  expect(r.json.task.state).toBe("in_review");
  expect(r.json.task.pr_url).toBe("https://gh/pr/42");

  const events = await get(`/api/tasks/${id}/events`);
  expect(events.json.some((e: any) => e.type === "ready_for_review")).toBe(true);

  // Idempotent: a second ready (task already in_review) acks without erroring.
  const again = await post(`/api/tasks/${id}/events`, { type: "ready" });
  expect(again.status).toBe(200);
  expect(again.json.task.state).toBe("in_review");
});

test("ready emit refreshes stale branch metadata for an already-linked PR", async () => {
  const db2 = openDb(":memory:");
  const exec = async (argv: string[]) => {
    const fields = argv[argv.indexOf("--json") + 1];
    if (fields === "headRefName")
      return { code: 0, stdout: JSON.stringify({ headRefName: "hive/task-recut" }), stderr: "" };
    return { code: 1, stdout: "", stderr: "not needed" };
  };
  const srv = Bun.serve({ port: 0, fetch: makeHandler(db2, { exec }) });
  const call = async (path: string, body: unknown) => {
    const response = await fetch(`http://127.0.0.1:${srv.port}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, json: await response.json() };
  };

  try {
    const project = await call("/api/projects", { name: "replacement-pr", repo_path: "/tmp/x" });
    const task = await call("/api/tasks", { project_id: project.json.id, title: "replace stale PR" });
    await call(`/api/tasks/${task.json.id}/transition`, { to: "in_progress" });
    await call(`/api/tasks/${task.json.id}/events`, { type: "evidence", note: "proof", kind: "log" });
    db2.query("UPDATE tasks SET branch = ?, pr_url = ? WHERE id = ?").run(
      "hive/task-rejected",
      "https://github.com/example/repo/pull/2",
      task.json.id
    );

    const ready = await call(`/api/tasks/${task.json.id}/events`, {
      type: "ready",
      pr_url: "https://github.com/example/repo/pull/2",
    });
    expect(ready.status).toBe(200);
    expect(ready.json.task.pr_url).toBe("https://github.com/example/repo/pull/2");
    expect(ready.json.task.branch).toBe("hive/task-recut");
  } finally {
    srv.stop(true);
  }
});

// HIVE-314: a task's own PR closed with nothing left to merge (head==base),
// but the work actually landed via a different PR/commit on the base branch.
// `unmergeable` is the agent's self-service terminal path: hive verifies the
// cited commit against the base branch (via a real `git fetch` + `merge-base
// --is-ancestor`) before granting `done` without the normal merge step.
test("unmergeable emit closes the task once the landing commit is verified on the base branch", async () => {
  const { execFileSync } = await import("node:child_process");
  const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });

  const origin = mkdtempSync(join(tmpdir(), "hive-test-origin-"));
  git(origin, ["init", "--bare", "-q"]);

  const cloneA = mkdtempSync(join(tmpdir(), "hive-test-clonea-"));
  git(cloneA, ["clone", "-q", origin, "."]);
  git(cloneA, ["checkout", "-q", "-b", "main"]);
  git(cloneA, ["-c", "user.email=a@a.com", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "init"]);
  git(cloneA, ["push", "-q", "-u", "origin", "main"]);

  // A second clone lands a commit on main that cloneA (the project's repo_path)
  // has not fetched yet. This is the "work landed via a different PR" case.
  const cloneB = mkdtempSync(join(tmpdir(), "hive-test-cloneb-"));
  git(cloneB, ["clone", "-q", origin, "."]);
  git(cloneB, ["-c", "user.email=b@b.com", "-c", "user.name=b", "commit", "-q", "--allow-empty", "-m", "landed elsewhere"]);
  git(cloneB, ["push", "-q", "origin", "main"]);
  const landingCommit = git(cloneB, ["rev-parse", "HEAD"]).trim();

  const p = await post("/api/projects", { name: "unmergeable-proj", repo_path: cloneA, config: { default_branch: "main" } });
  const t = await post("/api/tasks", { project_id: p.json.id, title: "unmergeable task" });
  const id = t.json.id;
  await post(`/api/tasks/${id}/transition`, { to: "in_progress" });
  await post(`/api/tasks/${id}/events`, { type: "evidence", note: "proof", kind: "log" });
  db.query("UPDATE tasks SET pr_url = ? WHERE id = ?").run("https://github.com/example/repo/pull/1", id);

  const invalidState = await post(`/api/tasks/${id}/events`, { type: "unmergeable", landing_commit: landingCommit });
  expect(invalidState.status).toBe(409);
  expect((await get(`/api/tasks/${id}`)).json.state).toBe("in_progress");

  await post(`/api/tasks/${id}/transition`, { to: "in_review" });

  const bogus = await post(`/api/tasks/${id}/events`, { type: "unmergeable", landing_commit: "deadbeef", note: "nope" });
  expect(bogus.status).toBe(409);
  expect((await get(`/api/tasks/${id}`)).json.state).toBe("in_review");

  git(cloneA, ["remote", "set-url", "origin", join(origin, "missing")]);
  const failedFetch = await post(`/api/tasks/${id}/events`, { type: "unmergeable", landing_commit: landingCommit });
  expect(failedFetch.status).toBe(409);
  expect((await get(`/api/tasks/${id}`)).json.state).toBe("in_review");
  git(cloneA, ["remote", "set-url", "origin", origin]);

  const r = await post(`/api/tasks/${id}/events`, {
    type: "unmergeable",
    landing_commit: landingCommit,
    note: "PR had nothing left to merge; work landed via a different PR",
  });
  expect(r.status).toBe(200);
  expect(r.json.task.state).toBe("done");

  const events = await get(`/api/tasks/${id}/events`);
  expect(events.json.some((e: any) => e.type === "unmergeable" && e.payload.landing_commit === landingCommit)).toBe(true);
});

// POST /merge used to hang forever when the project's post-merge smoke check
// hit an unreachable/stalled URL: mergeTask awaits smokeThenAdvance
// synchronously before responding, and the default fetcher had no timeout
// (task #641, separate from the exec() timeout fixed in #621). deps.fetch was
// also never threaded through to smokeThenAdvance, so tests/callers had no way
// to override it either. This proves both are fixed: deps.fetch reaches the
// smoke check, and a failing check returns promptly rather than hanging.
test("POST /merge returns instead of hanging when the post-merge smoke check fails", async () => {
  const OK = (stdout = "") => ({ code: 0, stdout, stderr: "" });
  const exec = async (argv: string[]) =>
    argv.includes("gh") && argv.includes("pr") && argv.includes("view")
      ? OK(JSON.stringify({ state: "MERGED", baseRefName: "main", baseRefOid: "base-sha" }))
      : OK();
  const smokeFetch: Fetcher = async () => ({ status: 500, body: "down" });
  const db2 = openDb(":memory:");
  const srv = Bun.serve({ port: 0, fetch: makeHandler(db2, { exec, fetch: smokeFetch }) });
  const base2 = `http://127.0.0.1:${srv.port}`;
  const post2 = async (path: string, body: unknown) => {
    const res = await fetch(base2 + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, json: await res.json() };
  };
  try {
    const p = await post2("/api/projects", {
      name: "smoke-proj",
      repo_path: "/tmp/x",
      config: { smoke: [{ name: "root", url: "http://127.0.0.1:1/", expect_status: 200 }] },
    });
    const t = await post2("/api/tasks", { project_id: p.json.id, title: "merge task" });
    const id = t.json.id;
    await post2(`/api/tasks/${id}/transition`, { to: "in_progress" });
    await post2(`/api/tasks/${id}/events`, { type: "evidence", note: "proof", kind: "log" });
    await post2(`/api/tasks/${id}/events`, {
      type: "review_summary",
      done: ["implemented"],
      understanding: {
        essence: "The smoke check validates the merged result.",
        check: {
          question: "What validates the merged result?",
          options: [{ key: "smoke", label: "The smoke check." }, { key: "none", label: "Nothing." }],
          answer_key: "smoke",
        },
      },
    });
    await post2(`/api/tasks/${id}/events`, { type: "ready", pr_url: "https://gh/pr/1" });
    await post2(`/api/tasks/${id}/understanding-quiz/answer`, { answer_key: "smoke", source: "director" });

    const start = Date.now();
    const merged = await post2(`/api/tasks/${id}/merge`, {});
    expect(Date.now() - start).toBeLessThan(3000);
    expect(merged.status).toBe(200);
    expect(merged.json.state).toBe("in_progress"); // bounced back by the failing smoke check
  } finally {
    srv.stop(true);
  }
});

test("evidence upload round-trips through /evidence", async () => {
  const form = new FormData();
  form.set("type", "evidence");
  form.set("kind", "screenshot");
  form.set("caption", "a shot");
  form.set("file", new File([new Uint8Array([1, 2, 3, 4])], "shot.png", { type: "image/png" }));
  const res = await fetch(`${BASE}/api/tasks/${taskId}/events`, { method: "POST", body: form });
  expect(res.status).toBe(201);
  const data = await res.json();
  expect(data.evidence.url).toStartWith(`/evidence/${taskId}/`);

  const fetched = await fetch(BASE + data.evidence.url);
  expect(fetched.status).toBe(200);
  const bytes = new Uint8Array(await fetched.arrayBuffer());
  expect(Array.from(bytes)).toEqual([1, 2, 3, 4]);
});

test("evidence ingestion rejects malformed URLs", async () => {
  const before = (await get(`/api/tasks/${taskId}`)).json.evidence.length;
  const result = await post(`/api/tasks/${taskId}/events`, {
    type: "evidence",
    kind: "link",
    url: "http://[",
    note: "bad link",
  });

  expect(result.status).toBe(400);
  expect(result.json.error).toContain("valid HTTP(S) URL or path");
  expect((await get(`/api/tasks/${taskId}`)).json.evidence).toHaveLength(before);
});

test("evidence kind is inferred from the uploaded file's extension", async () => {
  const t = await post("/api/tasks", { project_id: projectId, title: "ev kinds" });
  const up = async (name: string, type: string) => {
    const form = new FormData();
    form.set("type", "evidence");
    form.set("note", name);
    form.set("file", new File([new Uint8Array([1])], name, { type }));
    const res = await fetch(`${BASE}/api/tasks/${t.json.id}/events`, { method: "POST", body: form });
    return (await res.json()).evidence.kind;
  };
  expect(await up("shot.png", "image/png")).toBe("screenshot");
  expect(await up("report.md", "text/markdown")).toBe("report");
  expect(await up("data.tsv", "text/tab-separated-values")).toBe("log");
  // explicit --kind still wins
  const form = new FormData();
  form.set("type", "evidence");
  form.set("kind", "report");
  form.set("file", new File([new Uint8Array([1])], "notes.txt", { type: "text/plain" }));
  const res = await fetch(`${BASE}/api/tasks/${t.json.id}/events`, { method: "POST", body: form });
  expect((await res.json()).evidence.kind).toBe("report");
});

test("task reaches done once evidence exists (verifying auto-advances: no smoke configured)", async () => {
  await post(`/api/tasks/${taskId}/transition`, { to: "in_review" });
  // verifying with evidence attached and no smoke configured auto-advances
  // straight to done (smokeThenAdvance) — no separate done transition needed.
  const done = await post(`/api/tasks/${taskId}/transition`, { to: "verifying" });
  expect(done.status).toBe(200);
  expect(done.json.state).toBe("done");
});

test("decision: create, draft autosave, answer flow", async () => {
  const t = await post("/api/tasks", { project_id: projectId, title: "decision task" });
  const dtask = t.json.id;
  await post(`/api/tasks/${dtask}/transition`, { to: "in_progress" });

  const d = await post("/api/decisions", {
    task_id: dtask,
    title: "Ship it?",
    context: "ctx",
    risk: "high",
    blast_radius: "prod: acme-db",
    options: [
      { key: "yes", label: "Yes", detail: "do it", recommended: true },
      { key: "no", label: "No", detail: "wait" },
    ],
  });
  expect(d.status).toBe(201);
  const decisionId = d.json.id;

  // creating a decision parks the task in needs_decision
  const parked = await get(`/api/tasks/${dtask}`);
  expect(parked.json.state).toBe("needs_decision");

  // it appears in the open list
  const open = await get("/api/decisions?status=open");
  expect(open.json.some((x: any) => x.id === decisionId)).toBe(true);

  const otherProject = await post("/api/projects", { name: "decision filter", repo_path: "/tmp/decision-filter" });
  const otherTask = await post("/api/tasks", { project_id: otherProject.json.id, title: "other project decision" });
  const otherDecision = await post("/api/decisions", {
    task_id: otherTask.json.id,
    title: "Other project choice",
    context: "Other project decision context.",
    options: [{ key: "yes", label: "Yes" }],
  });
  const projectOpen = await get(`/api/decisions?status=open&project_id=${projectId}`);
  expect(projectOpen.json.some((x: any) => x.id === decisionId)).toBe(true);
  expect(projectOpen.json.some((x: any) => x.id === otherDecision.json.id)).toBe(false);
  await post(`/api/decisions/${otherDecision.json.id}/dismiss`, {});

  // draft autosave
  const draft = await fetch(`${BASE}/api/decisions/${decisionId}/draft`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ draft_note: "leaning yes" }),
  });
  expect(draft.status).toBe(200);
  const afterDraft = await get(`/api/decisions/${decisionId}`);
  expect(afterDraft.json.draft_note).toBe("leaning yes");

  // answer / submit
  const ans = await post(`/api/decisions/${decisionId}/answer`, { answer_key: "yes", answer_note: "go" });
  expect(ans.status).toBe(200);
  expect(ans.json.status).toBe("answered");
  expect(ans.json.answer_key).toBe("yes");

  // archived: no longer in open list
  const open2 = await get("/api/decisions?status=open");
  expect(open2.json.some((x: any) => x.id === decisionId)).toBe(false);

  // task resumed and an event was recorded
  const resumed = await get(`/api/tasks/${dtask}`);
  expect(resumed.json.state).toBe("in_progress");
  expect(resumed.json.decisions.some((x: any) => x.status === "answered")).toBe(true);
});

test("answer records the caller identity (source + actor) on row and event", async () => {
  const p = await post("/api/projects", { name: "autopilot identity", repo_path: "/tmp/identity", config: { autonomy_profile: "autopilot" } });
  const manager = createThread(db, { project_id: p.json.id });
  const t = await post("/api/tasks", { project_id: p.json.id, title: "who answered" });
  await post(`/api/tasks/${t.json.id}/transition`, { to: "in_progress" });
  const d = await post("/api/decisions", {
    task_id: t.json.id,
    title: "ship?",
    context: "Choose whether to ship this task.",
    risk: "low",
    blast_radius: "one local task",
    options: [{ key: "yes", label: "Yes", recommended: true }],
  });
  const ans = await post(`/api/decisions/${d.json.id}/answer`, {
    answer_key: "yes",
    source: "chat_supervisor",
    actor: manager.id,
  });
  expect(ans.status).toBe(200);
  expect(ans.json.answered_by).toBe("chat_supervisor");
  expect(ans.json.answered_actor).toBe(manager.id);

  // the audit event carries the identity too (not the old hardcoded director)
  const detail = await get(`/api/tasks/${t.json.id}`);
  const ev = detail.json.events.find((e: any) => e.type === "decision_answered");
  expect(ev.source).toBe("chat_supervisor");
  expect(ev.payload.answered_by).toBe("chat_supervisor");
  expect(ev.payload.actor).toBe(manager.id);
});

test("a stale decision answer returns the winning actor, time, and option", async () => {
  const t = await post("/api/tasks", { project_id: projectId, title: "decision race" });
  const d = await post("/api/decisions", {
    task_id: t.json.id,
    title: "ship?",
    context: "Choose whether to ship.",
    options: [{ key: "yes", label: "Ship now" }, { key: "no", label: "Hold" }],
  });
  expect((await post(`/api/decisions/${d.json.id}/answer`, {
    answer_key: "yes",
    source: "director",
    actor: "director-tab-a",
  })).status).toBe(200);

  const stale = await post(`/api/decisions/${d.json.id}/answer`, {
    answer_key: "no",
    source: "director",
    actor: "director-tab-b",
  });
  expect(stale.status).toBe(409);
  expect(stale.json).toMatchObject({
    stale: true,
    resolution: {
      status: "answered",
      source: "director",
      actor: "director-tab-a",
      answer_key: "yes",
      answer_label: "Ship now",
    },
  });
  expect(stale.json.resolution.at).toBeTruthy();
  expect(stale.json.error).toContain("director-tab-a");
  expect(stale.json.error).toContain("Ship now");

  const staleAuto = await post(`/api/decisions/${d.json.id}/auto-answer`, { answer_key: "yes" });
  expect(staleAuto.status).toBe(409);
  expect(staleAuto.json.resolution).toMatchObject({ actor: "director-tab-a", answer_label: "Ship now" });
});

test("an expired decision answer returns what resolved the card", async () => {
  const t = await post("/api/tasks", { project_id: projectId, title: "expired decision race" });
  const d = await post("/api/decisions", {
    task_id: t.json.id,
    title: "continue?",
    context: "Choose whether to continue.",
    options: [{ key: "yes", label: "Continue" }],
  });
  await post(`/api/tasks/${t.json.id}/transition`, { to: "cancelled", reason: "work superseded" });

  const stale = await post(`/api/decisions/${d.json.id}/answer`, {
    answer_key: "yes",
    source: "director",
    actor: "director-tab-b",
  });
  expect(stale.status).toBe(409);
  expect(stale.json).toMatchObject({
    stale: true,
    resolution: { status: "expired", source: "system", reason: "task cancelled" },
  });
  expect(stale.json.resolution.at).toBeTruthy();
  expect(stale.json.error).toContain("task cancelled");
});

test("answer without a source is recorded as unknown, not director", async () => {
  const t = await post("/api/tasks", { project_id: projectId, title: "no source" });
  const d = await post("/api/decisions", {
    task_id: t.json.id,
    title: "pick",
    context: "Choose an option for this task.",
    options: [{ key: "a", label: "A" }],
  });
  const ans = await post(`/api/decisions/${d.json.id}/answer`, { answer_key: "a" });
  expect(ans.status).toBe(200);
  expect(ans.json.answered_by).toBe("unknown");
  expect(ans.json.answered_actor).toBe(null);
});

test("answer with an invalid source is rejected 400", async () => {
  const t = await post("/api/tasks", { project_id: projectId, title: "bad source" });
  const d = await post("/api/decisions", {
    task_id: t.json.id,
    title: "pick",
    context: "Choose an option for this task.",
    options: [{ key: "a", label: "A" }],
  });
  const bad = await post(`/api/decisions/${d.json.id}/answer`, { answer_key: "a", source: "root" });
  expect(bad.status).toBe(400);
  // rejected before it mutates the card
  const still = await get(`/api/decisions/${d.json.id}`);
  expect(still.json.status).toBe("open");
});

test("rejecting an answer_key not in options", async () => {
  const t = await post("/api/tasks", { project_id: projectId, title: "d2" });
  const d = await post("/api/decisions", {
    task_id: t.json.id,
    title: "pick",
    context: "Choose an option for this task.",
    options: [{ key: "a", label: "A" }],
  });
  const bad = await post(`/api/decisions/${d.json.id}/answer`, { answer_key: "zzz" });
  expect(bad.status).toBe(400);
});

test("direct POST /api/decisions rejects empty/missing options with 400", async () => {
  const t = await post("/api/tasks", { project_id: projectId, title: "d-empty" });
  const missing = await post("/api/decisions", { task_id: t.json.id, title: "no opts", context: "Test missing options." });
  expect(missing.status).toBe(400);
  const empty = await post("/api/decisions", { task_id: t.json.id, title: "no opts", context: "Test empty options.", options: [] });
  expect(empty.status).toBe(400);
});

test("direct POST /api/decisions requires context", async () => {
  const t = await post("/api/tasks", { project_id: projectId, title: "d-no-context" });
  const missing = await post("/api/decisions", { task_id: t.json.id, title: "contextless", options: [{ key: "a", label: "A" }] });
  expect(missing.status).toBe(400);
  expect(missing.json.error).toBe("context is required");
});

test("needs-decision emit path requires context and defaults options", async () => {
  const t = await post("/api/tasks", { project_id: projectId, title: "d-emit" });
  await post(`/api/tasks/${t.json.id}/transition`, { to: "in_progress" });
  const missing = await post(`/api/tasks/${t.json.id}/events`, { type: "needs-decision", title: "should I proceed?" });
  expect(missing.status).toBe(400);
  const r = await post(`/api/tasks/${t.json.id}/events`, { type: "needs-decision", title: "should I proceed?", context: "Choose whether this task should continue." });
  expect(r.status).toBe(201);
  const opts = r.json.decision.options;
  expect(opts.length).toBe(2);
  expect(opts.map((o: any) => o.key)).toEqual(["proceed", "dismiss"]);
  // The defaulted card is answerable.
  const ans = await post(`/api/decisions/${r.json.decision.id}/answer`, { answer_key: "proceed" });
  expect(ans.status).toBe(200);
  expect(ans.json.status).toBe("answered");
});

test("dismiss endpoint expires an open decision and 409s on re-dismiss", async () => {
  const t = await post("/api/tasks", { project_id: projectId, title: "d-dismiss" });
  const d = await post("/api/decisions", { task_id: t.json.id, title: "dismiss me", context: "Test dismissing a decision.", options: [{ key: "a", label: "A" }] });
  const dis = await post(`/api/decisions/${d.json.id}/dismiss`, {});
  expect(dis.status).toBe(200);
  expect(dis.json.status).toBe("expired");
  // no longer in the open inbox
  const open = await get("/api/decisions?status=open");
  expect(open.json.some((x: any) => x.id === d.json.id)).toBe(false);
  // a decision_expired event was written
  const evs = await get(`/api/tasks/${t.json.id}/events`);
  expect(evs.json.some((e: any) => e.type === "decision_expired" && e.payload.decision_id === d.json.id)).toBe(true);
  // re-dismiss / answer a closed card is rejected
  const again = await post(`/api/decisions/${d.json.id}/dismiss`, {});
  expect(again.status).toBe(409);
});

test("dismissing the last open decision resumes a needs_decision task", async () => {
  const t = await post("/api/tasks", { project_id: projectId, title: "d-resume" });
  await post(`/api/tasks/${t.json.id}/transition`, { to: "in_progress" });
  const d1 = await post("/api/decisions", { task_id: t.json.id, title: "gate 1", context: "First test gate.", options: [{ key: "a", label: "A" }] });
  const d2 = await post("/api/decisions", { task_id: t.json.id, title: "gate 2", context: "Second test gate.", options: [{ key: "a", label: "A" }] });
  await post(`/api/tasks/${t.json.id}/transition`, { to: "needs_decision" });
  // one card still open → stays parked
  await post(`/api/decisions/${d1.json.id}/dismiss`, {});
  let cur = await get(`/api/tasks/${t.json.id}`);
  expect(cur.json.state).toBe("needs_decision");
  // last card dismissed → resumes
  await post(`/api/decisions/${d2.json.id}/dismiss`, {});
  cur = await get(`/api/tasks/${t.json.id}`);
  expect(cur.json.state).toBe("in_progress");
});

test("cancelling a task clears its open decisions from the inbox (SSE broadcast + expiry)", async () => {
  const t = await post("/api/tasks", { project_id: projectId, title: "d-cancel" });
  const d = await post("/api/decisions", { task_id: t.json.id, title: "orphan?", context: "Test cancelling a task with an open decision.", options: [{ key: "a", label: "A" }] });
  await post(`/api/tasks/${t.json.id}/transition`, { to: "cancelled" });
  const one = await get(`/api/decisions/${d.json.id}`);
  expect(one.json.status).toBe("expired");
  const open = await get("/api/decisions?status=open");
  expect(open.json.some((x: any) => x.id === d.json.id)).toBe(false);
});

test("policies CRUD", async () => {
  const p = await post("/api/policies", { title: "P1", body: "always test", scope: "global" });
  expect(p.status).toBe(201);
  const list = await get("/api/policies?scope=global");
  expect(list.json.some((x: any) => x.id === p.json.id)).toBe(true);

  const upd = await fetch(`${BASE}/api/policies/${p.json.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ active: false }),
  });
  expect((await upd.json()).active).toBe(false);

  const del = await fetch(`${BASE}/api/policies/${p.json.id}`, { method: "DELETE" });
  expect(del.status).toBe(200);
});

test("brief endpoint counts policies and retrieves their bodies through recall", async () => {
  await post("/api/policies", { title: "GlobalRule", body: "no em-dashes", scope: "global" });
  const b = await get(`/api/tasks/${taskId}/brief`);
  expect(b.json.brief).toContain("1 global policies");
  expect(b.json.brief).toContain("hive recall");
  expect(b.json.brief).not.toContain("GlobalRule");
  expect(b.json.brief).not.toContain("no em-dashes");
  expect(b.json.brief).toContain("hive emit");
});

test("SSE stream sends a hello headline", async () => {
  const res = await fetch(BASE + "/api/stream");
  const reader = res.body!.getReader();
  const { value } = await reader.read();
  const text = new TextDecoder().decode(value);
  expect(text).toContain('"type":"hello"');
  await reader.cancel();
});

// ---- test/ephemeral projects (#1020): a project whose repo_path lives
// inside a task's own worktree/scratchpad can only be a scratch artifact from
// an agent's own E2E run. It auto-flags config.test = true and its tasks,
// decisions, checkpoints and notifications are hidden from the default
// (unfiltered) list endpoints — see testProjects.ts.
test("a repo_path inside a worktree/scratchpad auto-flags the project test; a normal path does not", async () => {
  const wt = await post("/api/projects", {
    name: "auto-flagged",
    repo_path: "/private/tmp/claude-501/some-session/scratchpad/acme",
  });
  expect(wt.json.config.test).toBe(true);

  const worktreePath = await post("/api/projects", {
    name: "auto-flagged-2",
    repo_path: "/Users/you/.herdr/worktrees/hive/hive-abc123",
  });
  expect(worktreePath.json.config.test).toBe(true);

  const normal = await post("/api/projects", { name: "normal", repo_path: "/Users/you/projects/hive" });
  expect(normal.json.config.test).toBeUndefined();

  // an explicit config.test always wins over the heuristic
  const explicit = await post("/api/projects", {
    name: "explicit-false",
    repo_path: "/tmp/scratchpad/whatever",
    config: { test: false },
  });
  expect(explicit.json.config.test).toBe(false);
});

test("test projects, their tasks, decisions and checkpoints are hidden by default and shown with ?test=all", async () => {
  const tp = await post("/api/projects", { name: "hidden", repo_path: "/x/scratchpad/y" });
  const testProjectId = tp.json.id;
  const tt = await post("/api/tasks", { project_id: testProjectId, title: "scratch task" });
  const testTaskId = tt.json.id;
  await post(`/api/tasks/${testTaskId}/transition`, { to: "in_progress" });
  const cp = await post(`/api/tasks/${testTaskId}/events`, { type: "checkpoint", note: "scratch checkpoint" });
  const d = await post("/api/decisions", {
    task_id: testTaskId,
    title: "scratch decision",
    context: "ctx",
    options: [{ key: "a", label: "A" }],
  });
  expect(d.status).toBe(201);

  // project list
  const projects = await get("/api/projects");
  expect(projects.json.some((p: any) => p.id === testProjectId)).toBe(false);
  const projectsAll = await get("/api/projects?test=all");
  expect(projectsAll.json.some((p: any) => p.id === testProjectId)).toBe(true);

  // task list
  const tasks = await get("/api/tasks");
  expect(tasks.json.some((t: any) => t.id === testTaskId)).toBe(false);
  const tasksAll = await get("/api/tasks?test=all");
  expect(tasksAll.json.some((t: any) => t.id === testTaskId)).toBe(true);

  // decision list
  const decisions = await get("/api/decisions?status=all");
  expect(decisions.json.some((x: any) => x.id === d.json.id)).toBe(false);
  const decisionsAll = await get("/api/decisions?status=all&test=all");
  expect(decisionsAll.json.some((x: any) => x.id === d.json.id)).toBe(true);

  // checkpoint list
  const checkpoints = await get("/api/checkpoints");
  expect(checkpoints.json.checkpoints.some((c: any) => c.id === cp.json.event.id)).toBe(false);
  const checkpointsAll = await get("/api/checkpoints?test=all");
  expect(checkpointsAll.json.checkpoints.some((c: any) => c.id === cp.json.event.id)).toBe(true);

  // a direct-by-id fetch is never filtered
  const directTask = await get(`/api/tasks/${testTaskId}`);
  expect(directTask.status).toBe(200);
  const directDecision = await get(`/api/decisions/${d.json.id}`);
  expect(directDecision.status).toBe(200);
});

test("a test project never pushes a notification, even for a high-risk decision", async () => {
  const tp = await post("/api/projects", { name: "hidden-notif", repo_path: "/x/scratchpad/z" });
  const tt = await post("/api/tasks", { project_id: tp.json.id, title: "scratch task" });
  await post(`/api/tasks/${tt.json.id}/transition`, { to: "in_progress" });
  const before = await get("/api/notifications");
  await post("/api/decisions", {
    task_id: tt.json.id,
    title: "scratch high-risk decision",
    context: "ctx",
    risk: "high",
    options: [{ key: "a", label: "A" }],
  });
  const after = await get("/api/notifications");
  expect(after.json.notifications.length).toBe(before.json.notifications.length);
});
