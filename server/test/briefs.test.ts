import { test, expect } from "bun:test";
import { openDb, newId, now, type DB } from "../src/db.ts";
import { composeBrief } from "../src/briefs.ts";
import { playbookBody } from "../src/playbook.ts";

function setup(): { db: DB; projectId: string; taskId: string } {
  const db = openDb(":memory:");
  const projectId = newId("proj");
  db.query("INSERT INTO projects (id, name, created_at) VALUES (?,?,?)").run(projectId, "p", now());
  const taskId = newId();
  const t = now();
  db.query(
    "INSERT INTO tasks (id, project_id, title, brief, state, kind, created_at, updated_at) VALUES (?,?,?,?, 'queued', 'ship', ?, ?)"
  ).run(taskId, projectId, "Do the thing", "Detailed description here.", t, t);
  return { db, projectId, taskId };
}

function addPolicy(db: DB, scope: string, title: string, body: string, active = 1) {
  db.query(
    "INSERT INTO policies (id, scope, title, body, active, created_at, updated_at) VALUES (?,?,?,?,?,?,?)"
  ).run(newId("pol"), scope, title, body, active, now(), now());
}

test("brief includes the lifecycle contract and keeps policy bodies behind recall", () => {
  const { db, projectId, taskId } = setup();
  addPolicy(db, "global", "No em-dashes", "Use commas.");
  addPolicy(db, `project:${projectId}`, "Deploy safety", "Prod needs a decision card.");
  addPolicy(db, "global", "Inactive one", "Should not appear.", 0);

  const brief = composeBrief(db, taskId);
  expect(brief).toContain("Do the thing");
  expect(brief).toContain("Detailed description here.");
  expect(brief).toContain("Definition of done");
  expect(brief).toContain("hive emit");
  expect(brief).toContain("1 global policies");
  expect(brief).toContain("1 project policies");
  expect(brief).toContain("hive recall");
  expect(brief).not.toContain("No em-dashes");
  expect(brief).not.toContain("Use commas.");
  expect(brief).not.toContain("Deploy safety");
  expect(brief).not.toContain("Prod needs a decision card.");
  expect(brief).not.toContain("Should not appear.");
  expect(brief).not.toContain("/no-mistakes");
  expect(brief).toContain("If CI is pending, END THE TURN");
  expect(brief.length).toBeLessThan(11_000); // roughly <3k tokens plus a short task brief
});

test("stored policy growth does not grow the task prompt", () => {
  const { db, projectId, taskId } = setup();
  const body = "A long policy body that belongs behind recall. ".repeat(500);
  for (let i = 0; i < 20; i++) addPolicy(db, i % 2 ? "global" : `project:${projectId}`, `Policy ${i}`, body);

  const brief = composeBrief(db, taskId);
  expect(brief.length).toBeLessThan(11_000);
  expect(brief).toContain("10 global policies");
  expect(brief).toContain("10 project policies");
  expect(brief).not.toContain("A long policy body");
});

test("brief tells the agent to verify browsers headlessly, not via the denied MCPs", () => {
  const { db, taskId } = setup();
  const brief = composeBrief(db, taskId);
  expect(brief).toContain("Browser verification (headless only)");
  expect(brief).toContain("claude-in-chrome");
  expect(brief).toContain("--headless");
});

test("brief excludes project bookkeeping from understanding quizzes", () => {
  const { db, taskId } = setup();
  const brief = composeBrief(db, taskId);
  const prose = brief.replace(/\s+/g, " ");
  expect(prose).toContain("Every question must help them understand this specific");
  expect(prose).toContain("Never test whether the");
  expect(prose).toContain("competence belongs in internal checks");
  expect(prose).toContain("Never quiz project bookkeeping");
  expect(prose).toContain("does not improve the director's understanding of this review");
});

test("brief requires a standalone decision context", () => {
  const { db, taskId } = setup();
  const brief = composeBrief(db, taskId);
  expect(brief).toContain("--context");
  expect(brief).toContain("stand alone without opening");
});

test("scout brief has a report-based definition of done", () => {
  const { db, taskId } = setup();
  db.query("UPDATE tasks SET kind = 'scout' WHERE id = ?").run(taskId);
  expect(composeBrief(db, taskId)).toContain("report");
});

test("brief tells agents how to read Figma over REST when a token is passed through", () => {
  const { db, taskId } = setup();
  const prev = process.env.FIGMA_TOKEN;
  process.env.FIGMA_TOKEN = "figd_brieftest";
  try {
    const brief = composeBrief(db, taskId);
    expect(brief).toContain("## Figma (headless, no MCP)");
    expect(brief).toContain("X-Figma-Token: $FIGMA_TOKEN");
    expect(brief).toContain("api.figma.com/v1/images/");
    expect(brief).not.toContain("figd_brieftest");
  } finally {
    if (prev === undefined) delete process.env.FIGMA_TOKEN;
    else process.env.FIGMA_TOKEN = prev;
  }
});

// A stored playbook only helps if the crew that needs it sees it, so a brief
// whose task matches one carries its steps inline.
function addPlaybook(db: DB, projectId: string, pb: any) {
  const body = playbookBody(pb, { number: 7, title: "the source task" });
  db.query(
    `INSERT INTO learnings (id, project_id, title, body, source_task_id, occurrences, first_seen, last_seen, status, root_cause_task_id, kind)
     VALUES (?,?,?,?,NULL,1,?,?, 'active', NULL, 'reference')`
  ).run(newId("lrn"), projectId, pb.title, body, now(), now());
}

test("a matching playbook is inlined into the brief; a mismatched one is not", () => {
  const db = openDb(":memory:");
  const projectId = newId("proj");
  db.query("INSERT INTO projects (id, name, created_at) VALUES (?,?,?)").run(projectId, "p", now());
  const mkTask = (title: string, brief: string) => {
    const id = newId();
    db.query(
      "INSERT INTO tasks (id, project_id, title, brief, state, kind, created_at, updated_at) VALUES (?,?,?,?, 'queued','ship',?,?)"
    ).run(id, projectId, title, brief, now(), now());
    return id;
  };

  addPlaybook(db, projectId, {
    title: "Add a Stripe webhook endpoint",
    when_to_use: "when a task adds or changes a Stripe webhook handler",
    steps: ["Register the route in server/src/api.ts", "Verify the Stripe signature before parsing"],
    gotchas: ["Stripe retries with the same event id"],
    success_criteria: ["bun test passes"],
  });

  const hit = composeBrief(db, mkTask("Add the Stripe refund webhook", "Handle refund events from Stripe."));
  expect(hit).toContain("## Playbook: Add a Stripe webhook endpoint");
  expect(hit).toContain("when a task adds or changes a Stripe webhook handler");
  expect(hit).toContain("Verify the Stripe signature before parsing");
  expect(hit).not.toContain("Stripe retries with the same event id"); // gotchas stay behind recall

  const miss = composeBrief(db, mkTask("Rename the sidebar", "Change the label on the navigation sidebar."));
  expect(miss).not.toContain("## Playbook:");
});
