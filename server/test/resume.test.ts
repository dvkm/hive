import { test, expect } from "bun:test";
import { openDb, newId, now, type DB } from "../src/db.ts";
import { writeEvent } from "../src/state.ts";
import { namedCommitment, resumeDecision, autoResumeOnTurnEnd, MAX_AUTO_RESUMES } from "../src/resume.ts";

// The exact sentence from task #976 that ended a turn with four unfinished
// next steps and then went idle. This is the fixture the feature exists for.
const INCIDENT =
  "Continuing autonomously - next the gate, then sync to the reviewed head, both suites, then the hardened canary once.";

function freshDb(): { db: DB; projectId: string } {
  const db = openDb(":memory:");
  const projectId = newId("proj");
  db.query("INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)").run(
    projectId, "p", "/repo", "{}", now()
  );
  return { db, projectId };
}
function makeTask(db: DB, projectId: string, extra: Partial<{ state: string; source: string; agent_target: string; deferred_until: string; depends_on: string }> = {}): string {
  const id = newId();
  const t = now();
  db.query(
    "INSERT INTO tasks (id, project_id, title, state, kind, source, agent_target, deferred_until, depends_on, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
  ).run(
    id, projectId, "t", extra.state ?? "in_progress", "ship", extra.source ?? "director",
    extra.agent_target ?? "t-agent", extra.deferred_until ?? null, extra.depends_on ?? null, t, t
  );
  return id;
}
function said(db: DB, taskId: string, text: string): void {
  writeEvent(db, { task_id: taskId, source: "hook", type: "assistant_text", payload: { text } });
}
// Collects what would be sent to the agent.
function recorder() {
  const sent: string[] = [];
  return { sent, steer: async (_id: string, message: string) => { sent.push(message); return true; } };
}

// ---- detection ----

test("the real #976 final message is detected as a commitment", () => {
  expect(namedCommitment(INCIDENT)).toBe(INCIDENT);
});

test("forward self-commitments are detected", () => {
  expect(namedCommitment("Next I will run both suites.")).toBe("Next I will run both suites.");
  expect(namedCommitment("Tests are green. Then I'll open the PR.")).toBe("Then I'll open the PR.");
  expect(namedCommitment("Resuming the merge now.")).toBe("Resuming the merge now.");
  expect(namedCommitment("Staying on it.")).toBe("Staying on it.");
  expect(namedCommitment("Once the canary lands I will sync to the reviewed head.")).toBeTruthy();
});

test("completion reports are NOT commitments", () => {
  expect(namedCommitment("Done. Both suites pass and the PR is open.")).toBeNull();
  expect(namedCommitment("I ran the gate, synced to the reviewed head, and pushed.")).toBeNull();
  expect(namedCommitment("I have already resumed and finished the canary.")).toBeNull();
  expect(namedCommitment("")).toBeNull();
});

test("work someone ELSE will do is not a commitment", () => {
  expect(namedCommitment("PR is up. Next the director will review it and I will merge after.")).toBeNull();
  expect(namedCommitment("Next steps for you: approve the flag flip.")).toBeNull();
  expect(namedCommitment("CI will run the suites; I'll check back after.")).toBeNull();
});

test("an agent waiting on a human or an external system is not resumed", () => {
  expect(namedCommitment("Continuing once you answer the decision card.")).toBeNull();
  expect(namedCommitment("I will merge, but I'm waiting for CI to go green first.")).toBeNull();
  expect(namedCommitment("Next I will deploy. Should I proceed?")).toBeNull();
  expect(namedCommitment("Blocked on the staging credentials. I will resume once they land.")).toBeNull();
});

test("a subject-less next-steps list is a DELIBERATE miss; first-person items still fire", () => {
  // "Next steps:" is the canonical heading of a handoff summary and never says
  // who does the work — missing it costs one timer nudge, firing on it re-prods
  // an agent that correctly finished.
  expect(namedCommitment("Next steps:\n1. Run the gate\n2. Sync to the reviewed head")).toBeNull();
  expect(namedCommitment("Next steps:\n1. I will run the gate\n2. Then I will sync")).toBe("Then I will sync");
});

test("a future-tense sentence about something other than the agent is not a commitment", () => {
  expect(namedCommitment("This will need a follow-up task.")).toBeNull();
  expect(namedCommitment("Merged. It will deploy on the next cycle.")).toBeNull();
  expect(namedCommitment("PR is up. I will be here if you need anything.")).toBeNull();
});

test("a commitment quoted inside a code fence does not count", () => {
  expect(namedCommitment("Here is the fixture:\n```\nContinuing autonomously - next the gate.\n```\nThat is all.")).toBeNull();
});

// ---- eligibility ----

test("in_progress agent that named next work is resumed with its own words", async () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId);
  said(db, id, INCIDENT);
  const r = recorder();

  const decision = await autoResumeOnTurnEnd(db, id, r.steer);
  expect(decision.action).toBe("resume");
  expect(r.sent.length).toBe(1);
  expect(r.sent[0]).toContain(INCIDENT);
  expect(r.sent[0]).toContain("Continue now");
});

test("the auto-resume is a visible task event carrying the quote", async () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId);
  said(db, id, INCIDENT);
  await autoResumeOnTurnEnd(db, id, recorder().steer);

  const ev = db.query("SELECT * FROM events WHERE task_id = ? AND type = 'auto_resume'").get(id) as any;
  expect(ev).toBeTruthy();
  expect(JSON.parse(ev.payload)).toMatchObject({ resumes: 1, quote: INCIDENT });
});

test("a completed turn is left alone", async () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId);
  said(db, id, "Done. Both suites pass, PR is open, evidence attached.");
  const r = recorder();

  expect((await autoResumeOnTurnEnd(db, id, r.steer)).action).toBe("none");
  expect(r.sent.length).toBe(0);
  expect(db.query("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = 'auto_resume'").get(id)).toEqual({ n: 0 });
});

test("a task parked on an open decision is not resumed", async () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId, { state: "needs_decision" });
  db.query("INSERT INTO decisions (id, task_id, ts, title, options, status) VALUES (?,?,?,?,'[]','open')").run(
    newId("dec"), id, now(), "which target?"
  );
  said(db, id, INCIDENT);
  expect(resumeDecision(db, id).action).toBe("none");

  // ...and not even once it is back in_progress, while the card is still open.
  db.query("UPDATE tasks SET state = 'in_progress' WHERE id = ?").run(id);
  expect(resumeDecision(db, id).action).toBe("none");
});

test("deferred, dependency-blocked, handed-off and tracking-only tasks are not resumed", async () => {
  const { db, projectId } = freshDb();

  const deferred = makeTask(db, projectId, { deferred_until: new Date(Date.now() + 86_400_000).toISOString() });
  said(db, deferred, INCIDENT);
  expect(resumeDecision(db, deferred).action).toBe("none");

  const dep = makeTask(db, projectId, { state: "queued" });
  const blocked = makeTask(db, projectId, { depends_on: JSON.stringify([dep]) });
  said(db, blocked, INCIDENT);
  expect(resumeDecision(db, blocked).action).toBe("none");

  const inReview = makeTask(db, projectId, { state: "in_review" });
  said(db, inReview, INCIDENT);
  expect(resumeDecision(db, inReview).action).toBe("none");

  const external = makeTask(db, projectId, { source: "external" });
  said(db, external, INCIDENT);
  expect(resumeDecision(db, external).action).toBe("none");
});

test("activity after the commitment means the agent did not stop", async () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId);
  said(db, id, INCIDENT);
  writeEvent(db, { task_id: id, source: "agent", type: "evidence", payload: { note: "suite output" } });
  expect(resumeDecision(db, id).action).toBe("none");
});

// ---- rate limit ----

test("the rate limit stops repeated resumes and escalates to the director", async () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId);
  const r = recorder();

  // The agent re-commits and re-stops every turn.
  for (let i = 0; i < MAX_AUTO_RESUMES; i++) {
    said(db, id, INCIDENT);
    expect((await autoResumeOnTurnEnd(db, id, r.steer)).action).toBe("resume");
  }
  expect(r.sent.length).toBe(MAX_AUTO_RESUMES);

  said(db, id, INCIDENT);
  const capped = await autoResumeOnTurnEnd(db, id, r.steer);
  expect(capped.action).toBe("escalate");
  expect(r.sent.length).toBe(MAX_AUTO_RESUMES); // no further poking

  const notif = db.query("SELECT * FROM notifications WHERE task_id = ? AND kind = 'auto_resume'").get(id) as any;
  expect(notif).toBeTruthy();
  expect(notif.body).toContain(INCIDENT);
  const escalation = db
    .query("SELECT payload FROM events WHERE task_id = ? AND type = 'auto_resume' ORDER BY rowid DESC LIMIT 1")
    .get(id) as any;
  expect(JSON.parse(escalation.payload).escalated).toBe(true);

  // ...and the director is told ONCE. An agent that keeps re-committing must not
  // trade poking the agent for poking the director.
  said(db, id, INCIDENT);
  expect((await autoResumeOnTurnEnd(db, id, r.steer)).action).toBe("none");
  expect(r.sent.length).toBe(MAX_AUTO_RESUMES);
  expect(db.query("SELECT COUNT(*) AS n FROM notifications WHERE task_id = ? AND kind = 'auto_resume'").get(id)).toEqual({ n: 1 });
});

test("a repeated turn-end with no new message does not re-resume", async () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId);
  said(db, id, INCIDENT);
  const r = recorder();

  expect((await autoResumeOnTurnEnd(db, id, r.steer)).action).toBe("resume");
  expect((await autoResumeOnTurnEnd(db, id, r.steer)).action).toBe("none");
  expect(r.sent.length).toBe(1);
});

// ---- wiring: the Stop hook is the trigger ----

test("the Stop hook's agent_turn_end resumes the agent; SubagentStop does not", async () => {
  const { makeHandler } = await import("../src/api.ts");
  const { Herdr } = await import("../src/runtime/herdr.ts");
  const sent: string[] = [];
  const exec = async (argv: string[]) => {
    const i = argv.indexOf("send");
    if (i !== -1 && argv[i + 2] !== undefined) sent.push(argv[i + 2]);
    // A live agent has a pane; herdr.send() reads it to submit the Enter.
    if (argv.includes("get")) return { code: 0, stdout: '{"result":{"agent":{"pane_id":"p1","agent_status":"working"}}}', stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const { db, projectId } = freshDb();
  const server = Bun.serve({ port: 0, fetch: makeHandler(db, { herdr: new Herdr(exec, "herdr") }) });
  const base = `http://127.0.0.1:${server.port}`;
  const turnEnd = (id: string, hook: string) =>
    fetch(`${base}/api/tasks/${id}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "agent_turn_end", source: "hook", payload: { hook } }),
    });
  try {
    // A subagent finishing mid-turn is not the agent stopping.
    const sub = makeTask(db, projectId);
    said(db, sub, INCIDENT);
    expect((await turnEnd(sub, "SubagentStop")).status).toBe(201);
    expect(sent.length).toBe(0);

    const id = makeTask(db, projectId);
    said(db, id, INCIDENT);
    expect((await turnEnd(id, "Stop")).status).toBe(201);
    expect(sent.length).toBe(1);
    expect(sent[0]).toContain(INCIDENT);
    // The steer carries its own delivery receipt, as every hive steer does.
    const steer = db.query("SELECT payload FROM events WHERE task_id = ? AND type = 'steer'").get(id) as any;
    expect(JSON.parse(steer.payload).delivery).toBe("delivered");
  } finally {
    server.stop(true);
  }
});
