import { test, expect, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HIVE_HOME = mkdtempSync(join(tmpdir(), "hive-autoapprove-"));

const { openDb, newId, now } = await import("../src/db.ts");
const { evaluateAutoApprove } = await import("../src/autoapprove.ts");
const { createDecision, apiAutoAnswerDecision } = await import("../src/api.ts");
const { listReferences } = await import("../src/learn.ts");
const { Herdr } = await import("../src/runtime/herdr.ts");
const herdr = new Herdr(async () => ({ code: 0, stdout: "", stderr: "" }), "herdr");

const db = openDb(":memory:");
const projectId = newId("proj");
const taskId = newId("task");

beforeAll(() => {
  db.query("INSERT INTO projects (id, name, config, created_at) VALUES (?,?,?,?)").run(projectId, "p", "{}", now());
  db.query(
    "INSERT INTO tasks (id, project_id, title, state, kind, created_at, updated_at) VALUES (?,?,?,?,?,?,?)"
  ).run(taskId, projectId, "t", "in_progress", "ship", now(), now());
});

// Insert a decision row directly (bypassing createDecision's task transition).
function seedDecision(opts: { title: string; risk?: string; blast?: string; options: any[] }): string {
  const id = newId("dec");
  db.query(
    `INSERT INTO decisions (id, task_id, ts, title, context, risk, blast_radius, options, status, answer_key, answer_note, draft_note, answered_at)
     VALUES (?,?,?,?,?,?,?,?, 'open', NULL, NULL, NULL, NULL)`
  ).run(id, taskId, now(), opts.title, null, opts.risk ?? null, opts.blast ?? null, JSON.stringify(opts.options));
  return id;
}
function marker(type: string, decisionId: string, extra: any = {}) {
  db.query("INSERT INTO events (id, task_id, ts, source, type, payload) VALUES (?,?,?,?,?,?)").run(
    newId("evt"), taskId, now(), "system", type, JSON.stringify({ decision_id: decisionId, ...extra })
  );
}
const REC = (key: string, extra: any = {}) => ({ key, label: key, recommended: true, ...extra });

test("reference capture: save is auto-approved", () => {
  const id = seedDecision({
    title: "Save recurring link as a project reference? https://x.io",
    risk: "normal",
    options: [REC("save"), { key: "ignore", label: "ignore" }],
  });
  const v = evaluateAutoApprove(db, db.query("SELECT * FROM decisions WHERE id=?").get(id), "save");
  expect(v.allow).toBe(true);
  expect(v.category).toBe("ref_capture");
});

test("high-confidence duplicate merge is auto-approved; a non-recommended merge is not", () => {
  const strong = seedDecision({
    title: 'Possible duplicate of "x"',
    risk: "normal",
    options: [REC("merge"), { key: "keep-separate", label: "keep" }],
  });
  marker("duplicate_suspected", strong, { score: 0.9, tier: "near" });
  expect(evaluateAutoApprove(db, db.query("SELECT * FROM decisions WHERE id=?").get(strong), "merge").allow).toBe(true);

  // Weak match: dedup would NOT mark merge recommended → escalate.
  const weak = seedDecision({
    title: 'Possible duplicate of "y"',
    risk: "normal",
    options: [{ key: "merge", label: "merge" }, REC("keep-separate")],
  });
  marker("duplicate_suspected", weak, { score: 0.4, tier: "weak" });
  expect(evaluateAutoApprove(db, db.query("SELECT * FROM decisions WHERE id=?").get(weak), "merge").allow).toBe(false);
});

test("task requeue is auto-approved", () => {
  const id = seedDecision({
    title: "Recover failed task: t",
    risk: "normal",
    options: [REC("requeue"), { key: "abandon", label: "abandon" }],
  });
  marker("recovery_card", id, { source_task_id: taskId });
  expect(evaluateAutoApprove(db, db.query("SELECT * FROM decisions WHERE id=?").get(id), "requeue").allow).toBe(true);
});

test("a pending standing-authority grant is a hard exclusion even if recommended + low risk", () => {
  const id = seedDecision({
    title: "Authorize: command.dangerous.process-kill",
    risk: "low", // even mis-rated low, the grant check wins
    options: [REC("approve"), { key: "deny", label: "deny" }],
  });
  db.query(
    "INSERT INTO authority_grants (id, task_id, action, target, decision_id, status, created_at) VALUES (?,?,?,?,?, 'pending', ?)"
  ).run(newId("agr"), taskId, "command.dangerous.process-kill", "pkill x", id, now());
  const v = evaluateAutoApprove(db, db.query("SELECT * FROM decisions WHERE id=?").get(id), "approve");
  expect(v.allow).toBe(false);
  expect(v.category).toBe("authority");
});

test("denying a pending standing-authority command is fail-closed and auto-answerable", () => {
  const id = seedDecision({
    title: "Authorize: command.dangerous.force-delete-branch",
    risk: "high",
    options: [{ key: "approve", label: "approve" }, REC("deny")],
  });
  db.query(
    "INSERT INTO authority_grants (id, task_id, action, target, decision_id, status, created_at) VALUES (?,?,?,?,?, 'pending', ?)"
  ).run(newId("agr"), taskId, "command.dangerous.force-delete-branch", "git branch -D tmp", id, now());
  const v = evaluateAutoApprove(db, db.query("SELECT * FROM decisions WHERE id=?").get(id), "deny");
  expect(v.allow).toBe(true);
  expect(v.category).toBe("authority_deny");
});

test("apiAutoAnswerDecision resolves a recommended authority deny without granting the command", async () => {
  const d = createDecision(db, {
    task_id: taskId,
    title: "command approval (dangerous): force-delete branch",
    risk: "high",
    options: [{ key: "approve", label: "Approve" }, { key: "deny", label: "Deny", recommended: true }],
  });
  db.query(
    "INSERT INTO authority_grants (id, task_id, action, target, decision_id, status, created_at) VALUES (?,?,?,?,?, 'pending', ?)"
  ).run(newId("agr"), taskId, "command.dangerous.force-delete-branch", "git branch -D tmp", d.id, now());
  const res = apiAutoAnswerDecision(db, herdr as any, d.id, { answer_key: "deny", answer_note: "leave the harmless ref" });
  expect(res.status).toBe(200);
  expect((db.query("SELECT status FROM authority_grants WHERE decision_id=?").get(d.id) as any).status).toBe("denied");
});

test("agent-dialog deny only closes a stale card from the current agent generation", async () => {
  const released = seedDecision({
    title: "Agent blocked on a dialog: permission prompt",
    risk: "medium",
    options: [{ key: "approve", label: "Approve" }, { key: "deny", label: "Deny" }],
  });
  marker("blocked_card", released);
  marker("agent_released", released);
  expect(apiAutoAnswerDecision(db, herdr as any, released, { answer_key: "deny" }).status).toBe(200);

  const done = seedDecision({
    title: "Agent blocked on a dialog: permission prompt",
    risk: "medium",
    options: [{ key: "approve", label: "Approve" }, { key: "deny", label: "Deny" }],
  });
  marker("blocked_card", done);
  marker("agent_status", done, { status: "done" });
  expect(apiAutoAnswerDecision(db, herdr as any, done, { answer_key: "deny" }).status).toBe(200);

  const live = seedDecision({
    title: "Agent blocked on a dialog: permission prompt",
    risk: "medium",
    options: [{ key: "approve", label: "Approve" }, { key: "deny", label: "Deny" }],
  });
  marker("blocked_card", live);
  expect(apiAutoAnswerDecision(db, herdr as any, live, { answer_key: "deny" }).status).toBe(403);

  const respawned = seedDecision({
    title: "Agent blocked on a dialog: permission prompt",
    risk: "medium",
    options: [{ key: "approve", label: "Approve" }, { key: "deny", label: "Deny" }],
  });
  marker("blocked_card", respawned);
  marker("agent_released", respawned);
  marker("spawned", respawned);
  expect(apiAutoAnswerDecision(db, herdr as any, respawned, { answer_key: "deny" }).status).toBe(403);

  const approve = seedDecision({
    title: "Agent blocked on a dialog: permission prompt",
    risk: "medium",
    options: [{ key: "approve", label: "Approve" }, { key: "deny", label: "Deny" }],
  });
  marker("blocked_card", approve);
  marker("agent_released", approve);
  expect(apiAutoAnswerDecision(db, herdr as any, approve, { answer_key: "approve" }).status).toBe(403);

  const unrelated = seedDecision({
    title: "Choose a launch segment",
    risk: "normal",
    options: [{ key: "deny", label: "Deny" }],
  });
  const response = apiAutoAnswerDecision(db, herdr as any, unrelated, { answer_key: "deny" });
  expect(response.status).toBe(403);
  expect((await response.json() as any).reason).toBe("only the raiser's recommended option can be auto-approved");
});

test("high risk, prod blast radius, and non-recommended options each escalate", () => {
  const highRisk = seedDecision({ title: "Save recurring link as a project reference? https://x", risk: "high", options: [REC("save")] });
  expect(evaluateAutoApprove(db, db.query("SELECT * FROM decisions WHERE id=?").get(highRisk), "save").allow).toBe(false);

  const prod = seedDecision({ title: "Recover failed task: t", risk: "normal", blast: "deploy to prod", options: [REC("requeue")] });
  marker("recovery_card", prod, { source_task_id: taskId });
  expect(evaluateAutoApprove(db, db.query("SELECT * FROM decisions WHERE id=?").get(prod), "requeue").allow).toBe(false);

  const notRec = seedDecision({ title: "Save recurring link as a project reference? https://x", risk: "normal", options: [{ key: "save", label: "save" }] });
  expect(evaluateAutoApprove(db, db.query("SELECT * FROM decisions WHERE id=?").get(notRec), "save").allow).toBe(false);

  // An unrated (null risk) card is not "low or normal" → escalate, even for an
  // otherwise-allow-listed category.
  const noRisk = seedDecision({ title: "Save recurring link as a project reference? https://x", options: [REC("save")] });
  expect(evaluateAutoApprove(db, db.query("SELECT * FROM decisions WHERE id=?").get(noRisk), "save").allow).toBe(false);
});

test("apiAutoAnswerDecision: safe card is answered, resolver runs, audit trail records the supervisor", async () => {
  const d = createDecision(db, {
    task_id: taskId,
    title: "Save recurring link as a project reference? https://ref.example",
    risk: "normal",
    options: [{ key: "save", label: "Save as reference", recommended: true }, { key: "ignore", label: "ignore" }],
  });
  const res = apiAutoAnswerDecision(db, herdr as any, d.id, { answer_key: "save", answer_note: "the dashboard", actor: "supervisor-session-a" });
  expect(res.status).toBe(200);

  // Card is answered and the resolver ran (reference stored).
  expect((db.query("SELECT status FROM decisions WHERE id=?").get(d.id) as any).status).toBe("answered");
  expect(listReferences(db, projectId).some((r) => r.body === "https://ref.example")).toBe(true);

  // Audit: an auto_approved event + a supervisor-sourced decision_answered.
  const audit = db.query("SELECT source, payload FROM events WHERE type='auto_approved' AND json_extract(payload,'$.decision_id')=?").get(d.id) as any;
  expect(audit.source).toBe("chat_supervisor");
  expect(JSON.parse(audit.payload)).toMatchObject({ category: "ref_capture", actor: "supervisor-session-a" });
  const answered = db.query("SELECT source, payload FROM events WHERE type='decision_answered' AND json_extract(payload,'$.decision_id')=?").get(d.id) as any;
  expect(answered.source).toBe("chat_supervisor");
  expect(JSON.parse(answered.payload)).toMatchObject({ answered_by: "chat_supervisor", actor: "supervisor-session-a" });
});

test("apiAutoAnswerDecision: malformed body is rejected before audit", async () => {
  const d = createDecision(db, {
    task_id: taskId,
    title: "Save recurring link as a project reference? https://invalid.example",
    risk: "normal",
    options: [{ key: "save", label: "Save as reference", recommended: true }, { key: "ignore", label: "ignore" }],
  });
  const note = apiAutoAnswerDecision(db, herdr as any, d.id, { answer_key: "save", answer_note: 123 });
  expect(note.status).toBe(400);
  expect(await note.json() as any).toEqual({ error: "answer_note must be a string" });
  const indices = apiAutoAnswerDecision(db, herdr as any, d.id, { answer_key: "save", selected_indices: "[]" });
  expect(indices.status).toBe(400);
  expect(await indices.json() as any).toEqual({ error: "selected_indices must be an array of indices" });
  expect((db.query("SELECT status FROM decisions WHERE id=?").get(d.id) as any).status).toBe("open");
  expect(db.query("SELECT 1 FROM events WHERE type='auto_approved' AND json_extract(payload,'$.decision_id')=?").get(d.id)).toBeFalsy();
});

test("apiAutoAnswerDecision: unsafe card is left OPEN and escalated with a reason", async () => {
  const d = createDecision(db, {
    task_id: taskId,
    title: "Task #9 passed its cost cap ($5) — wrap up or keep spending?",
    risk: "normal",
    options: [{ key: "wrap_up", label: "Wrap up", recommended: true }, { key: "continue", label: "continue" }],
  });
  db.query("INSERT INTO events (id, task_id, ts, source, type, payload) VALUES (?,?,?,?,?,?)").run(
    newId("evt"), taskId, now(), "system", "cost_cap", JSON.stringify({ decision_id: d.id })
  );
  const res = apiAutoAnswerDecision(db, herdr as any, d.id, { answer_key: "wrap_up" });
  expect(res.status).toBe(403);
  const body = await res.json() as any;
  expect(body.effect).toBe("escalate");
  expect(body.reason).toBeTruthy();

  // The card must remain OPEN for the director.
  expect((db.query("SELECT status FROM decisions WHERE id=?").get(d.id) as any).status).toBe("open");
  expect(db.query("SELECT 1 FROM events WHERE type='auto_approve_declined' AND json_extract(payload,'$.decision_id')=?").get(d.id)).toBeTruthy();
});

test("categories outside the allow-list (cost cap, deny guardrail, plain question) escalate", () => {
  const cost = seedDecision({ title: "Task #3 passed its cost cap ($5) — wrap up or keep spending?", risk: "normal", options: [REC("wrap_up"), { key: "continue", label: "continue" }] });
  marker("cost_cap", cost, { spent_usd: 6, cap_usd: 5 });
  expect(evaluateAutoApprove(db, db.query("SELECT * FROM decisions WHERE id=?").get(cost), "wrap_up").allow).toBe(false);

  const guardrail = seedDecision({ title: "Always block 'command.dangerous.process-kill'? Denied 3× in this project", risk: "normal", options: [REC("block"), { key: "keep_asking", label: "keep" }] });
  expect(evaluateAutoApprove(db, db.query("SELECT * FROM decisions WHERE id=?").get(guardrail), "block").allow).toBe(false);

  const question = seedDecision({ title: "Ship the redesign to which segment first?", risk: "normal", options: [REC("beta"), { key: "all", label: "all" }] });
  expect(evaluateAutoApprove(db, db.query("SELECT * FROM decisions WHERE id=?").get(question), "beta").allow).toBe(false);
});
