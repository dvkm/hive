// Intake triage (HIVE-410): ambient intake is classified before it dispatches.
// Mechanical clears the unreviewed hold itself; ambiguous raises one decision
// card and holds the task until the director picks a reading. Every classifier
// failure must fall through to mechanical — triage never wedges intake.
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "hive-triage-"));
process.env.HIVE_HOME = HOME;

const { openDb, newId, now } = await import("../src/db.ts");
const { triageIntake, triageHold, resolveIntakeTriageForDecision, extractTriage, isTriageSource } = await import(
  "../src/intake/triage.ts"
);
const { isReviewed } = await import("../src/dispatcher.ts");
const { getTask } = await import("../src/state.ts");
import type { DB } from "../src/db.ts";

function setup(config: any = { intake_triage: true }, source = "intake_gchat"): { db: DB; id: string; task: any } {
  const db = openDb(":memory:");
  const pid = newId("proj");
  const t = now();
  db.query("INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)").run(
    pid, "p", "/repo", JSON.stringify(config), t
  );
  const id = newId();
  db.query(
    "INSERT INTO tasks (id, project_id, title, brief, state, kind, source, created_at, updated_at) VALUES (?,?,?,?, 'queued','ship',?,?,?)"
  ).run(id, pid, "make the dashboard faster", "the dashboard feels slow", source, t, t);
  return { db, id, task: getTask(db, id) };
}

// A stub classifier: answers with a fixed verdict, records the argv it saw.
const stub = (verdict: any, seen: string[] = []) => async (argv: string[]) => {
  seen.push(argv.join(" "));
  return { code: 0, stdout: JSON.stringify({ result: JSON.stringify(verdict) }), stderr: "", timedOut: false };
};

const events = (db: DB, id: string, type: string) =>
  db.query("SELECT * FROM events WHERE task_id = ? AND type = ? ORDER BY ts").all(id, type).map((e: any) => ({
    ...e,
    payload: JSON.parse(e.payload),
  }));
const openCards = (db: DB, id: string) =>
  db.query("SELECT * FROM decisions WHERE task_id = ? AND status = 'open'").all(id) as any[];

const AMBIGUOUS = {
  bucket: "decision_required",
  reasoning: "faster could mean the load time or the refresh rate",
  question: "Which slowness should we fix first?",
  interpretations: [
    { key: "first-load", label: "First page load", detail: "Cut the time before anything appears." },
    { key: "refresh", label: "Live refresh", detail: "Cut the delay between updates." },
  ],
  recommendation: "first-load",
};

test("mechanical: marks the task reviewed, no card, dispatch is free", async () => {
  const { db, id, task } = setup();
  const seen: string[] = [];
  const v = await triageIntake(db, task, { exec: stub({ bucket: "mechanical", reasoning: "one clear reading" }, seen) });

  expect(v?.bucket).toBe("mechanical");
  expect(openCards(db, id).length).toBe(0);
  expect(isReviewed(db, id)).toBe(true);
  expect(triageHold(db, task)).toBe(false);
  const ev = events(db, id, "intake_triage");
  expect(ev.length).toBe(1);
  expect(ev[0].payload.bucket).toBe("mechanical");
  // sonnet, JSON output, no tools — the classifier must not go exploring.
  expect(seen[0]).toContain("--model sonnet");
  expect(seen[0]).toContain("--output-format json");
  expect(seen[0]).toContain("--disallowed-tools");
});

test("decision_required: one card with the interpretations, task held until answered", async () => {
  const { db, id, task } = setup();
  const v = await triageIntake(db, task, { exec: stub(AMBIGUOUS) });

  expect(v?.bucket).toBe("decision_required");
  const cards = openCards(db, id);
  expect(cards.length).toBe(1);
  expect(cards[0].title).toBe("Which slowness should we fix first?");
  const options = JSON.parse(cards[0].options);
  expect(options.map((o: any) => o.key)).toEqual(["first-load", "refresh"]);
  expect(options.find((o: any) => o.key === "first-load").recommended).toBe(true);
  expect(events(db, id, "intake_triage")[0].payload.bucket).toBe("decision_required");

  // The task is created queued and held both ways: unreviewed, and card open.
  expect(getTask(db, id).state).toBe("queued");
  expect(isReviewed(db, id)).toBe(false);
  expect(triageHold(db, task)).toBe(true);

  // Answering releases it and records the chosen reading in the brief.
  expect(resolveIntakeTriageForDecision(db, cards[0].id, "refresh")).toBe(true);
  db.query("UPDATE decisions SET status = 'answered' WHERE id = ?").run(cards[0].id);
  expect(isReviewed(db, id)).toBe(true);
  expect(triageHold(db, getTask(db, id))).toBe(false);
  expect(getTask(db, id).brief).toContain("Live refresh");
});

test("resolver ignores cards it does not own", () => {
  const { db, id } = setup();
  expect(resolveIntakeTriageForDecision(db, "dec_nope", "merge")).toBe(false);
  expect(isReviewed(db, id)).toBe(false);
});

test("config off: nothing is classified, task is untouched", async () => {
  const { db, id, task } = setup({});
  let called = false;
  const v = await triageIntake(db, task, {
    exec: async () => {
      called = true;
      return { code: 0, stdout: "{}", stderr: "", timedOut: false };
    },
  });
  expect(v).toBeNull();
  expect(called).toBe(false);
  expect(events(db, id, "intake_triage").length).toBe(0);
  expect(openCards(db, id).length).toBe(0);
  expect(isReviewed(db, id)).toBe(false); // the existing unreviewed-intake hold still applies
});

test("wrong source: director-manual, agent and requeue tasks are never triaged", async () => {
  for (const source of ["agent", "requeue", null as any, "external"]) {
    const { db, task } = setup({ intake_triage: true }, source);
    expect(await triageIntake(db, task, { exec: stub(AMBIGUOUS) })).toBeNull();
    expect(openCards(db, task.id).length).toBe(0);
  }
  expect(isTriageSource("intake_braindump")).toBe(true);
  expect(isTriageSource("watch")).toBe(true);
  expect(isTriageSource("agent")).toBe(false);
});

test("fails open: every classifier failure is treated as mechanical", async () => {
  const failures: [string, any][] = [
    ["timeout", async () => ({ code: 0, stdout: "", stderr: "", timedOut: true })],
    ["nonzero exit", async () => ({ code: 1, stdout: "", stderr: "boom", timedOut: false })],
    ["unparseable output", async () => ({ code: 0, stdout: "sorry, I cannot help", stderr: "", timedOut: false })],
    ["thrown error", async () => { throw new Error("spawn failed"); }],
    // decision_required with nothing to choose between is not answerable
    ["empty decision", stub({ bucket: "decision_required", question: "which?", interpretations: [] })],
  ];
  for (const [name, exec] of failures) {
    const { db, id, task } = setup();
    const v = await triageIntake(db, task, { exec });
    expect(`${name}: ${v?.bucket}`).toBe(`${name}: mechanical`);
    expect(openCards(db, id).length).toBe(0);
    expect(isReviewed(db, id)).toBe(true); // failing open must not hold intake
  }
});

test("extractTriage reads bare JSON, fenced prose and the claude -p envelope", () => {
  expect(extractTriage('{"bucket":"mechanical"}')?.bucket).toBe("mechanical");
  expect(extractTriage('here you go:\n```json\n{"bucket":"mechanical"}\n```')?.bucket).toBe("mechanical");
  expect(extractTriage(JSON.stringify({ result: JSON.stringify(AMBIGUOUS) }))?.interpretations?.length).toBe(2);
  expect(extractTriage("not json at all")).toBeNull();
  expect(extractTriage('{"bucket":"maybe"}')).toBeNull();
});
