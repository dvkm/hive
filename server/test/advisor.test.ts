import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HOME = mkdtempSync(join(tmpdir(), "hive-advisor-"));
const { openDb, newId, now } = await import("../src/db.ts");
import type { DB } from "../src/db.ts";
const { adviseOnce, withAdvice, advisorWillJudge, askReporters, withIntentStatus } = await import("../src/advisor.ts");
const { apiAnswerDecision } = await import("../src/api.ts");
const { herdr: defaultHerdr } = await import("../src/runtime/herdr.ts");
const { getIntent } = await import("../src/intents.ts");
const { investigationDue, requestDigest } = await import("../src/intentInvestigate.ts");
import type { PlannerExec } from "../src/planner.ts";

function freshDb(config: any = {}): { db: DB; projectId: string; taskId: string } {
  const db = openDb(":memory:");
  const projectId = newId("proj");
  db.query("INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)").run(projectId, "p", null, JSON.stringify(config), now());
  const taskId = newId();
  db.query("INSERT INTO tasks (id, project_id, title, state, kind, created_at, updated_at) VALUES (?,?,?, 'needs_decision', 'ship', ?, ?)")
    .run(taskId, projectId, "the work", now(), now());
  return { db, projectId, taskId };
}

function card(db: DB, taskId: string, over: Partial<{ risk: string; options: any[]; decision_class: string; title: string }> = {}): string {
  const id = newId("dec");
  const options = over.options ?? [{ key: "go", label: "Go", recommended: true }, { key: "no", label: "No" }];
  db.query("INSERT INTO decisions (id, task_id, ts, title, context, risk, options, status, decision_class) VALUES (?,?,?,?,?,?,?, 'open', ?)")
    .run(id, taskId, now(), over.title ?? "close the duplicate?", "context", over.risk ?? null, JSON.stringify(options), over.decision_class ?? null);
  return id;
}

// A model that answers every card with the given JSON, counting its calls.
function model(reply: object): { exec: PlannerExec; calls: () => number } {
  let n = 0;
  const exec: PlannerExec = async () => {
    n++;
    return { code: 0, stdout: JSON.stringify({ type: "result", result: JSON.stringify(reply) }), stderr: "" };
  };
  return { exec, calls: () => n };
}

const answerAs = (db: DB) => (id: string, key: string, note: string) =>
  apiAnswerDecision(db, defaultHerdr, id, { answer_key: key, answer_note: note, source: "system", actor: "hive-advisor" }).ok;

const statusOf = (db: DB, id: string) => (db.query("SELECT status, answer_key, answer_note FROM decisions WHERE id = ?").get(id) as any);
const pushes = (db: DB, id: string) =>
  (db.query("SELECT COUNT(*) AS n FROM notifications WHERE decision_id = ? AND urgency = 'urgent'").get(id) as { n: number }).n;

test("a reversible call is answered by hive with the recommendation, and nobody is pushed", async () => {
  const { db, taskId } = freshDb();
  const id = card(db, taskId);
  expect(withAdvice(db, statusOf(db, id) && (db.query("SELECT * FROM decisions WHERE id = ?").get(id) as any)).for_director).toBe(false);

  const m = model({ owner: "system", pick: "go", why: "It is an exact duplicate." });
  await adviseOnce(db, { answer: answerAs(db), exec: m.exec });

  const d = statusOf(db, id);
  expect(d.status).toBe("answered");
  expect(d.answer_key).toBe("go");
  expect(d.answer_note).toBe("Hive decided: It is an exact duplicate.");
  expect(pushes(db, id)).toBe(0);
  await adviseOnce(db, { answer: answerAs(db), exec: m.exec });
  expect(m.calls()).toBe(1); // judged once, ever
});

test("a product call goes to the director with the advisor's reason, pushed once", async () => {
  const { db, taskId } = freshDb();
  const id = card(db, taskId, { title: "should the pin show the sector?" });
  const m = model({ owner: "owner", why: "It changes what readers see on the map." });
  await adviseOnce(db, { answer: answerAs(db), exec: m.exec });
  await adviseOnce(db, { answer: answerAs(db), exec: m.exec });

  expect(statusOf(db, id).status).toBe("open");
  expect(pushes(db, id)).toBe(1);
  const advised = withAdvice(db, db.query("SELECT * FROM decisions WHERE id = ?").get(id) as any);
  expect(advised.for_director).toBe(true);
  expect(advised.advice).toBe("It changes what readers see on the map.");
});

test("high risk, prose risk, a reserved class and an option that needs input never reach the model", async () => {
  const { db, taskId } = freshDb();
  const high = card(db, taskId, { risk: "high" });
  // HIVE-527: risk is free text; a sentence is read as high, not as normal.
  const prose = card(db, taskId, { risk: "if these keys are real, anyone with repo read access can use them" });
  const classed = card(db, taskId, { decision_class: "intake_triage" });
  const needsInput = card(db, taskId, {
    options: [{ key: "creds", label: "give me admin credentials", detail: "attach a token so I can authenticate", recommended: true }, { key: "skip", label: "Skip" }],
  });
  for (const id of [high, prose, classed, needsInput])
    expect(advisorWillJudge(db, db.query("SELECT * FROM decisions WHERE id = ?").get(id) as any)).toBe(false);

  const m = model({ owner: "system", pick: "go", why: "fine" });
  await adviseOnce(db, { answer: answerAs(db), exec: m.exec });
  expect(m.calls()).toBe(0);
  for (const id of [high, prose, classed, needsInput]) expect(statusOf(db, id).status).toBe("open");
});

test("a model failure or a pick other than the recommendation leaves the card to the director", async () => {
  const { db, taskId } = freshDb();
  const broken = card(db, taskId);
  const failing: PlannerExec = async () => ({ code: 1, stdout: "", stderr: "boom" });
  await adviseOnce(db, { answer: answerAs(db), exec: failing });
  expect(statusOf(db, broken).status).toBe("open");
  expect(pushes(db, broken)).toBe(1);

  const other = card(db, taskId);
  const m = model({ owner: "system", pick: "no", why: "I prefer the other one." });
  await adviseOnce(db, { answer: answerAs(db), exec: m.exec });
  expect(statusOf(db, other).status).toBe("open");
  expect(pushes(db, other)).toBe(1);
});

// A Jira ask hive has read the code for, with questions left for the reporter.
function jiraAsk(questions = ["What is missing from the tracker?"]) {
  const { db, projectId } = freshDb({ jira: { enabled: true, write: true, site: "https://acme.atlassian.net", project_key: "ABC", email: "d@acme.dev" } });
  const mirror = newId();
  db.query("INSERT INTO tasks (id, project_id, title, state, kind, source, source_ref, jira_key, jira_link_kind, created_at, updated_at) VALUES (?,?,?, 'queued', 'ship', 'external', 'jira:ABC-12', 'ABC-12', 'mirror', ?, ?)")
    .run(mirror, projectId, "[ABC-12] tracker", now(), now());
  const intentId = newId("int");
  db.query("INSERT INTO intents (id, project_id, task_id, source, source_ref, status, body_md, created_at, updated_at) VALUES (?,?,?, 'jira', 'ABC-12', 'draft', ?, ?, ?)")
    .run(intentId, projectId, mirror, `## Problem\nempty ticket\n\n## Open questions\n${questions.map((q) => `- [ ] ${q}`).join("\n")}\n`, now(), now());
  // What the investigator records after reading the ticket as it stands now.
  const investigated = () =>
    db.query("INSERT INTO events (id, task_id, ts, source, type, payload) VALUES (?,?,?,?,?,?)")
      .run(newId("ev"), mirror, now(), "system", "intent_investigated", JSON.stringify({ intent_id: intentId, request: requestDigest(db, getIntent(db, intentId)!) }));
  investigated();
  return { db, mirror, intentId, investigated };
}

test("a ticket filled in after hive read it is read again before its reporter is asked anything", async () => {
  const { db, mirror, intentId } = jiraAsk();
  db.query("UPDATE tasks SET brief = ? WHERE id = ?").run("Add a fifth option to the category dropdown.", mirror);

  const m = model({ comment: "Could you tell me what is missing?" });
  expect(await askReporters(db, { answer: () => false, exec: m.exec })).toBe(0);
  expect(m.calls()).toBe(0);
  expect(investigationDue(db, getIntent(db, intentId)!)).toBe(true);
});

test("a fresh read's new questions are asked; the same questions never twice", async () => {
  const { db, mirror, intentId, investigated } = jiraAsk();
  const m = model({ comment: "Could you tell me?" });
  expect(await askReporters(db, { answer: () => false, exec: m.exec })).toBe(1);

  // The reporter edits the ticket; hive reads it again and has a different question.
  db.query("UPDATE tasks SET brief = ? WHERE id = ?").run("The tracker needs a new column.", mirror);
  db.query("UPDATE intents SET body_md = ? WHERE id = ?").run("## Problem\nA column is missing.\n\n## Open questions\n- [ ] Which column?\n", intentId);
  expect(withIntentStatus(db, getIntent(db, intentId)!).waiting_on).toBeNull();
  investigated();
  expect(await askReporters(db, { answer: () => false, exec: m.exec })).toBe(1);
  expect(withIntentStatus(db, getIntent(db, intentId)!).waiting_on).toBe("reporter");

  // Read again with the same question left: nothing new to ask.
  db.query("UPDATE tasks SET brief = ? WHERE id = ?").run("The tracker needs a new column, soon.", mirror);
  investigated();
  expect(await askReporters(db, { answer: () => false, exec: m.exec })).toBe(0);
  expect(m.calls()).toBe(2);
});

test("a Jira ask with questions left is asked of its reporter once, and waits for them", async () => {
  const { db, mirror, intentId } = jiraAsk();

  const m = model({ comment: "Hi! Could you tell me what is missing from the tracker? Thank you!" });
  expect(await askReporters(db, { answer: () => false, exec: m.exec })).toBe(1);
  expect(await askReporters(db, { answer: () => false, exec: m.exec })).toBe(0);

  const comment: any = db.query("SELECT payload FROM events WHERE task_id = ? AND type = 'jira_comment'").get(mirror);
  expect(JSON.parse(comment.payload).text).toContain("what is missing from the tracker");
  expect(withIntentStatus(db, getIntent(db, intentId)!).waiting_on).toBe("reporter");

  // The reporter answers on the ticket: the ask comes back, and hive reads the code again first.
  db.query("INSERT INTO events (id, task_id, ts, source, type, payload) VALUES (?,?,?,?,?,?)")
    .run(newId("ev"), mirror, new Date(Date.now() + 1000).toISOString(), "jira", "jira_comment", JSON.stringify({ direction: "inbound", author: "Sam", text: "The status column" }));
  const after = withIntentStatus(db, getIntent(db, intentId)!);
  expect(after.waiting_on).toBeNull();
  expect(after.hive_working).toBe(true);
});
