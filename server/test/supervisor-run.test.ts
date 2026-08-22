import { beforeEach, expect, test } from "bun:test";
import { makeHandler, wakeDueManagers } from "../src/api.ts";
import { appendMessage, createThread } from "../src/chat.ts";
import { newId, now, openDb, setSetting, type DB } from "../src/db.ts";
import type { Exec, ExecResult } from "../src/exec.ts";
import { Herdr } from "../src/runtime/herdr.ts";

const OK = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const sends: string[] = [];
const exec: Exec = async (argv) => {
  if (argv[1] === "agent" && argv[2] === "get") return OK('{"result":{"agent":{"pane_id":"p1","agent_status":"working"}}}');
  if (argv[1] === "agent" && argv[2] === "send") sends.push(argv[4]);
  return OK();
};
const herdr = new Herdr(exec, "herdr");
const TOKEN = "test-token";

let db: DB;
let handle: ReturnType<typeof makeHandler>;
let projectId: string;
let managerId: string;
let threadId: string;

beforeEach(() => {
  sends.length = 0;
  db = openDb(":memory:");
  projectId = newId("proj");
  managerId = newId("task");
  const t = now();
  db.query("INSERT INTO projects (id, name, config, created_at) VALUES (?,?,?,?)").run(projectId, "acme", "{}", t);
  db.query(
    "INSERT INTO tasks (id, project_id, title, state, kind, source, agent_target, created_at, updated_at) VALUES (?,?,?, 'in_progress', 'chore', 'chat_supervisor', 'manager-agent', ?, ?)"
  ).run(managerId, projectId, "manager", t, t);
  threadId = createThread(db, { project_id: projectId, task_id: managerId, title: "Ship a reliable manager" }).id;
  setSetting(db, "api_token", TOKEN); // PUT /api/projects/:id is write-gated
  handle = makeHandler(db, { herdr });
});

async function call(path: string, method = "GET", body?: unknown) {
  const res = await handle(new Request(`http://localhost${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
  return { status: res.status, json: await res.json() as any };
}

function worker(title: string): string {
  const id = newId("task");
  const t = now();
  db.query(
    "INSERT INTO tasks (id, project_id, title, state, kind, source, parent_task_id, agent_target, created_at, updated_at) VALUES (?,?,?, 'in_progress', 'ship', 'agent', ?, ?, ?, ?)"
  ).run(id, projectId, title, managerId, `agent-${id}`, t, t);
  return id;
}

test("run ledger is durable and completion is gated by verification plus retrospective", async () => {
  const update = await call(`/api/chat/threads/${threadId}/run`, "PUT", {
    phase: "executing",
    objective: "Ship the manager loop",
    acceptance_criteria: ["delegates work", "proves the outcome"],
    next_action: "wait for workers",
  });
  expect(update.status).toBe(200);
  expect(update.json.acceptance_criteria).toEqual(["delegates work", "proves the outcome"]);

  const early = await call(`/api/chat/threads/${threadId}/run`, "PUT", { phase: "complete", outcome: "done" });
  expect(early.status).toBe(409);

  const taskId = worker("verification target");
  const evidenceId = newId("ev");
  db.query("INSERT INTO evidence (id, task_id, ts, kind, caption, meta) VALUES (?,?,?,?,?,?)")
    .run(evidenceId, taskId, now(), "test_run", "tests pass", "{}");
  const verified = await call(`/api/chat/threads/${threadId}/verifications`, "POST", {
    status: "passed",
    method: "run the full test suite",
    result: "all tests passed",
    target_task_ids: [taskId],
    evidence_ids: [evidenceId],
  });
  expect(verified.status).toBe(201);

  const stillEarly = await call(`/api/chat/threads/${threadId}/run`, "PUT", { phase: "complete" });
  expect(stillEarly.status).toBe(409);
  expect((await call(`/api/chat/threads/${threadId}/retrospectives`, "POST", {
    summary: "Independent verification prevented a premature completion.",
    worked: ["evidence gate"],
    lessons: ["keep the verifier separate"],
  })).status).toBe(201);
  const complete = await call(`/api/chat/threads/${threadId}/run`, "PUT", { phase: "complete", outcome: "Manager loop shipped" });
  expect(complete.status).toBe(200);
  expect(complete.json.phase).toBe("complete");
  expect(complete.json.completed_at).toBeTruthy();

  const detail = await call(`/api/chat/threads/${threadId}`);
  expect(detail.json.verifications[0].status).toBe("passed");
  expect(detail.json.retrospectives[0].summary).toContain("verification");
});

test("bounded meetings notify only workers managed by the thread and keep the latest stage", async () => {
  const first = worker("first proposal");
  const second = worker("second proposal");
  const started = await call(`/api/chat/threads/${threadId}/meetings`, "POST", {
    stage: "proposal",
    topic: "Choose the state model",
    participants: [first, second],
  });
  expect(started.status).toBe(201);
  expect(started.json.delivered).toBe(2);
  expect(sends).toHaveLength(2);

  const decided = await call(`/api/chat/threads/${threadId}/meetings`, "POST", {
    stage: "decided",
    meeting_id: started.json.meeting_id,
    recommendation: "Reuse task events",
    summary: "It preserves one source of truth.",
    dissent: ["A dedicated table would be easier to query"],
    evidence: ["The event projection already powers the run ledger"],
    risks: ["Event payload changes need backward compatibility"],
  });
  expect(decided.status).toBe(200);
  const detail = await call(`/api/chat/threads/${threadId}`);
  expect(detail.json.meetings).toHaveLength(1);
  expect(detail.json.meetings[0].stage).toBe("decided");
  expect(detail.json.meetings[0].decision).toBe("Reuse task events");
  expect(detail.json.meetings[0].recommendation).toBe("Reuse task events");
  expect(detail.json.meetings[0].dissent).toEqual(["A dedicated table would be easier to query"]);
});

test("commitments stay source-linked and separate from worker tasks", async () => {
  const source = appendMessage(db, threadId, "director", "Ship the manager and do not drop verification.");
  const owner = worker("implement the manager");
  const unlinked = await call(`/api/chat/threads/${threadId}/commitments`, "POST", {
    title: "Ship the manager",
  });
  expect(unlinked.status).toBe(400);

  const parent = await call(`/api/chat/threads/${threadId}/commitments`, "POST", {
    title: "Ship the manager",
    source_message_id: source.id,
    owner_task_id: owner,
  });
  expect(parent.status).toBe(201);
  expect(parent.json.owner_title).toBe("implement the manager");
  expect(parent.json.source_message_text).toContain("do not drop verification");

  const followup = await call(`/api/chat/threads/${threadId}/commitments`, "POST", {
    title: "Verify the integrated result",
    source_message_id: source.id,
    depends_on: [parent.json.id],
  });
  expect(followup.status).toBe(201);
  expect(followup.json.depends_on).toEqual([parent.json.id]);

  const cycle = await call(`/api/chat/threads/${threadId}/commitments/${parent.json.id}`, "PUT", {
    depends_on: [followup.json.id],
  });
  expect(cycle.status).toBe(409);

  const updated = await call(`/api/chat/threads/${threadId}/commitments/${parent.json.id}`, "PUT", {
    status: "done",
  });
  expect(updated.status).toBe(200);
  expect(updated.json.status).toBe("done");

  const detail = await call(`/api/chat/threads/${threadId}`);
  expect(detail.json.commitments.map((item: any) => item.title)).toEqual([
    "Verify the integrated result",
    "Ship the manager",
  ]);
});

test("autonomy profiles enforce supervisor decision and checkpoint boundaries", async () => {
  const taskId = worker("needs a call");
  const checkpoint = await call(`/api/tasks/${taskId}/events`, "POST", { type: "checkpoint", note: "keep the current route" });

  await call(`/api/projects/${projectId}`, "PUT", { config: { autonomy_profile: "conservative" } });
  const deniedCheckpoint = await call(`/api/tasks/${taskId}/checkpoints/${checkpoint.json.event.id}/ack`, "POST", {
    verdict: "ok", source: "chat_supervisor", actor: threadId,
  });
  expect(deniedCheckpoint.status).toBe(403);

  await call(`/api/projects/${projectId}`, "PUT", { config: { autonomy_profile: "balanced" } });
  const decision = await call("/api/decisions", "POST", {
    task_id: taskId,
    title: "Use the existing route?",
    context: "Choose whether this task should reuse the existing local handler.",
    risk: "low",
    blast_radius: "one local handler",
    options: [{ key: "yes", label: "Yes", recommended: true }, { key: "no", label: "No" }],
  });
  const balanced = await call(`/api/decisions/${decision.json.id}/answer`, "POST", {
    answer_key: "yes", source: "chat_supervisor", actor: threadId,
  });
  expect(balanced.status).toBe(403);

  await call(`/api/projects/${projectId}`, "PUT", { config: { autonomy_profile: "autopilot" } });
  const autopilot = await call(`/api/decisions/${decision.json.id}/answer`, "POST", {
    answer_key: "yes", source: "chat_supervisor", actor: threadId,
  });
  expect(autopilot.status).toBe(200);
  expect(autopilot.json.answered_by).toBe("chat_supervisor");
});

test("verification replay records a new attempt and wakes the persistent manager", async () => {
  const taskId = worker("verified target");
  const evidenceId = newId("ev");
  db.query("INSERT INTO evidence (id, task_id, ts, kind, caption, meta) VALUES (?,?,?,?,?,?)")
    .run(evidenceId, taskId, now(), "test_run", "pass", "{}");
  const prior = await call(`/api/chat/threads/${threadId}/verifications`, "POST", {
    status: "passed",
    method: "bun test",
    result: "green",
    target_task_ids: [taskId],
    evidence_ids: [evidenceId],
  });
  const replay = await call(`/api/chat/threads/${threadId}/verifications/${prior.json.event_id}/replay`, "POST", {});
  expect(replay.status).toBe(202);
  expect(replay.json.verification.replay_of).toBe(prior.json.verification_id);
  expect(sends.some((message) => message.includes("Replay verification requested"))).toBe(true);

  const blockedCompletion = await call(`/api/chat/threads/${threadId}/run`, "PUT", { phase: "complete" });
  expect(blockedCompletion.status).toBe(409);
});

test("a portfolio thread (project_id null) can verify tasks and evidence from any project it supervises", async () => {
  const portfolioThreadId = createThread(db, { project_id: null, task_id: managerId, title: "Chief of Staff" }).id;
  const otherProjectId = newId("proj");
  const t = now();
  db.query("INSERT INTO projects (id, name, config, created_at) VALUES (?,?,?,?)").run(otherProjectId, "corebeat", "{}", t);
  const crossTaskId = newId("task");
  db.query(
    "INSERT INTO tasks (id, project_id, title, state, kind, source, created_at, updated_at) VALUES (?,?,?, 'in_progress', 'ship', 'agent', ?, ?)"
  ).run(crossTaskId, otherProjectId, "cross-project work", t, t);
  const crossEvidenceId = newId("ev");
  db.query("INSERT INTO evidence (id, task_id, ts, kind, caption, meta) VALUES (?,?,?,?,?,?)")
    .run(crossEvidenceId, crossTaskId, t, "test_run", "independently verified", "{}");

  const started = await call(`/api/chat/threads/${portfolioThreadId}/verifications`, "POST", {
    status: "started",
    method: "independently re-run the corebeat test suite",
    target_task_ids: [crossTaskId],
  });
  expect(started.status).toBe(201);

  // Evidence attached to the manager task itself (not the target task) counts too.
  const managerEvidenceId = newId("ev");
  db.query("INSERT INTO evidence (id, task_id, ts, kind, caption, meta) VALUES (?,?,?,?,?,?)")
    .run(managerEvidenceId, managerId, t, "test_run", "manager-recorded proof", "{}");

  const passed = await call(`/api/chat/threads/${portfolioThreadId}/verifications`, "POST", {
    status: "passed",
    method: "independently re-run the corebeat test suite",
    result: "all green on corebeat",
    target_task_ids: [crossTaskId, managerId],
    evidence_ids: [crossEvidenceId, managerEvidenceId],
  });
  expect(passed.status).toBe(201);
  expect(passed.json.target_task_ids).toEqual([crossTaskId, managerId]);
});

test("a project-scoped thread still cannot cite tasks or evidence from another project", async () => {
  const otherProjectId = newId("proj");
  const t = now();
  db.query("INSERT INTO projects (id, name, config, created_at) VALUES (?,?,?,?)").run(otherProjectId, "other", "{}", t);
  const otherTaskId = newId("task");
  db.query(
    "INSERT INTO tasks (id, project_id, title, state, kind, source, created_at, updated_at) VALUES (?,?,?, 'in_progress', 'ship', 'agent', ?, ?)"
  ).run(otherTaskId, otherProjectId, "other project work", t, t);
  const otherEvidenceId = newId("ev");
  db.query("INSERT INTO evidence (id, task_id, ts, kind, caption, meta) VALUES (?,?,?,?,?,?)")
    .run(otherEvidenceId, otherTaskId, t, "test_run", "not this project's proof", "{}");

  const rejectedTask = await call(`/api/chat/threads/${threadId}/verifications`, "POST", {
    status: "started",
    method: "check the other project",
    target_task_ids: [otherTaskId],
  });
  expect(rejectedTask.status).toBe(409);

  const ownTaskId = worker("in-project target");
  const rejectedEvidence = await call(`/api/chat/threads/${threadId}/verifications`, "POST", {
    status: "passed",
    method: "check the other project",
    result: "borrowed evidence",
    target_task_ids: [ownTaskId],
    evidence_ids: [otherEvidenceId],
  });
  expect(rejectedEvidence.status).toBe(400);
});

test("a due run wakeup clears the wait cursor and resumes the manager once", async () => {
  await call(`/api/chat/threads/${threadId}/run`, "PUT", {
    phase: "waiting",
    waiting_on: "CI retry window",
    wakeup_at: new Date(Date.now() - 1_000).toISOString(),
  });
  expect(await wakeDueManagers(db, herdr, {})).toBe(1);
  expect(await wakeDueManagers(db, herdr, {})).toBe(0);
  const detail = await call(`/api/chat/threads/${threadId}`);
  expect(detail.json.phase).toBe("executing");
  expect(detail.json.wakeup_at).toBeNull();
  expect(sends.some((message) => message.includes("scheduled wait has ended"))).toBe(true);
});
