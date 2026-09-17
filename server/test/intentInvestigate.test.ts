// A draft intent is investigated in the project's checkout before a person is
// asked anything: questions the code answers become findings, a draft with
// nothing left to decide is accepted by hive, and a real decision stays in the
// inbox as the only question.
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HIVE_HOME = mkdtempSync(join(tmpdir(), "hive-investigate-home-"));

const { openDb, newId, now } = await import("../src/db.ts");
const { insertIntent, linkIntentTask, getIntent, openQuestions, intentSection } = await import("../src/intents.ts");
const { renderIntentBody } = await import("../src/intentDraft.ts");
const { investigateOnce, investigateArgv, pendingInvestigations, READ_ONLY_TOOLS } = await import("../src/intentInvestigate.ts");
const { acceptIntent } = await import("../src/api.ts");
import type { PlannerExec } from "../src/planner.ts";

const QUESTIONS = ["Is the stage chip's Active logic a separate implementation?", "Does it reproduce in both flows?"];

function fixture(opts: { graft?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "hive-investigate-"));
  const db = openDb(join(root, "t.db"));
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  if (opts.graft) {
    mkdirSync(join(repo, "graft"), { recursive: true });
    writeFileSync(join(repo, "graft", "INDEX.md"), "# graft");
  }
  db.query("INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)").run("proj", "web", repo, "{}", now());
  const taskId = newId();
  db.query(
    "INSERT INTO tasks (id, number, project_id, title, brief, state, kind, source, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
  ).run(taskId, 1, "proj", "WEB-164 stage chip", "the chip stays inactive", "queued", "ship", "jira-sync", now(), now());
  const intent = insertIntent(db, {
    project_id: "proj",
    source: "jira",
    source_ref: "WEB-164",
    author: "jira:WEB-164",
    body_md: renderIntentBody({ problem: "The stage chip never turns Active.", proposed_outcome: "The chip matches the asset's stage.", affected: "", constraints: "", open_questions: QUESTIONS }),
  });
  linkIntentTask(db, intent.id, taskId);
  const calls: { argv: string[]; cwd?: string }[] = [];
  const stub = (reply: () => { code: number; stdout: string }): PlannerExec => async (argv, o) => {
    calls.push({ argv, cwd: o.cwd });
    return { ...reply(), stderr: "" };
  };
  const accept = (id: string) => acceptIntent(db, id, { accepted_by: "hive" }, { intentExec: async () => ({ code: 0, stdout: "{}", stderr: "" }) });
  const events = () =>
    (db.query("SELECT payload FROM events WHERE task_id = ? AND type = 'intent_investigated'").all(taskId) as { payload: string }[]).map((r) => JSON.parse(r.payload));
  return { db, repo, taskId, intent, calls, stub, accept, events };
}

const answered = JSON.stringify({
  problem: "The stage chip never turns Active.",
  proposed_outcome: "The chip matches the asset's stage.",
  affected: "web/src/asset/StageChips.tsx",
  constraints: "Reuse chipActive() from web/src/asset/chips.ts; it already handles the other two chips.",
  findings: ["chipActive() in web/src/asset/chips.ts:41 is shared; the stage chip skips it at StageChips.tsx:88", "Both the 5-stage and 4-stage flows render through StageChips, so it reproduces in both"],
  open_questions: [],
});

test("questions the code answers become findings and hive accepts the draft, once", async () => {
  const f = fixture({ graft: true });
  const ran = await investigateOnce(f.db, { exec: f.stub(() => ({ code: 0, stdout: answered })), accept: f.accept });
  expect(ran).toBe(1);

  // The agent ran in the checkout, read-only, and was pointed at graft.
  expect(f.calls[0].cwd).toBe(f.repo);
  const argv = f.calls[0].argv;
  expect(argv.slice(argv.indexOf("--allowedTools") + 1)).toEqual(READ_ONLY_TOOLS);
  expect(argv.join(" ")).not.toContain("Edit");
  expect(argv.find((a) => a.includes("## The draft"))).toContain('graft ask "<what you need>"');
  expect(argv.find((a) => a.includes("## The draft"))).toContain(QUESTIONS[0]);

  const after = getIntent(f.db, f.intent.id)!;
  expect(after.status).toBe("accepted");
  expect(after.accepted_by).toBe("hive");
  expect(openQuestions(after.body_md)).toEqual([]);
  expect(intentSection(after.body_md, "Affected users and systems")).toContain("What hive found in the code:\n- chipActive() in web/src/asset/chips.ts:41");
  expect(intentSection(after.body_md, "Constraints")).toContain("Reuse chipActive()");
  // The work task's brief is regenerated from the accepted record.
  const brief = (f.db.query("SELECT brief FROM tasks WHERE id = ?").get(f.taskId) as { brief: string }).brief;
  expect(brief).toContain("## Deliverable\nThe chip matches the asset's stage.");
  expect(f.events()).toMatchObject([{ intent_id: f.intent.id, questions_before: 2, questions_after: 0, findings: 2, graft: true }]);

  // One investigation per draft, ever.
  expect(await investigateOnce(f.db, { exec: f.stub(() => ({ code: 0, stdout: answered })), accept: f.accept })).toBe(0);
  expect(f.calls).toHaveLength(1);
});

test("a decision only a person can make stays in the inbox as the only question", async () => {
  const f = fixture();
  const reply = JSON.stringify({ ...JSON.parse(answered), open_questions: ["Should the stage chip also turn Active for archived assets?"] });
  await investigateOnce(f.db, { exec: f.stub(() => ({ code: 0, stdout: reply })), accept: f.accept });
  const after = getIntent(f.db, f.intent.id)!;
  expect(after.status).toBe("draft");
  expect(openQuestions(after.body_md)).toEqual(["Should the stage chip also turn Active for archived assets?"]);
  expect(f.calls[0].argv.find((a) => a.includes("## The draft"))).not.toContain("graft ask");
  expect(f.events()[0]).toMatchObject({ questions_before: 2, questions_after: 1, graft: false });
});

test("a failed investigation leaves the draft as written and is not retried", async () => {
  const f = fixture();
  await investigateOnce(f.db, { exec: f.stub(() => ({ code: 1, stdout: "" })), accept: f.accept });
  const after = getIntent(f.db, f.intent.id)!;
  expect(after.status).toBe("draft");
  expect(openQuestions(after.body_md)).toEqual(QUESTIONS);
  expect(f.events()[0].error).toContain("investigation");
  expect(pendingInvestigations(f.db, 5)).toEqual([]);
});

test("a draft the director edited while hive was looking is left alone", async () => {
  const f = fixture();
  const exec: PlannerExec = async () => {
    f.db.query("UPDATE intents SET body_md = ? WHERE id = ?").run(f.intent.body_md.replace("- [ ] Does it", "- [x] yes, both. Does it"), f.intent.id);
    return { code: 0, stdout: answered, stderr: "" };
  };
  await investigateOnce(f.db, { exec, accept: f.accept });
  const after = getIntent(f.db, f.intent.id)!;
  expect(after.status).toBe("draft");
  expect(after.body_md).toContain("- [x] yes, both.");
  expect(f.events()[0].skipped).toContain("edited");
});

test("every prompt that writes for the director writes in English, whatever language the ticket is in", async () => {
  const { buildDraftPrompt, buildChecksPrompt } = await import("../src/intentDraft.ts");
  const { PLAIN_ENGLISH } = await import("../src/plainEnglish.ts");
  const f = fixture();
  const prompts = [
    await buildInvestigatePromptOf(f.intent),
    buildDraftPrompt({ title: "자산 상세화면 칩", description: "진행단계 칩이 비활성으로 남는다", comments: [] }),
    buildChecksPrompt(f.intent),
  ];
  expect(PLAIN_ENGLISH).toContain("Write in English");
  for (const prompt of prompts) {
    expect(prompt).toContain("Write in English");
    expect(prompt).not.toMatch(/same language/i);
  }
});

async function buildInvestigatePromptOf(intent: any): Promise<string> {
  const { buildInvestigatePrompt } = await import("../src/intentInvestigate.ts");
  return buildInvestigatePrompt(intent, null, true);
}

// ------------------------------------------------- the typed second opinion
// A draft the investigator emptied of questions is emptied by the same model
// that rewrote it; TypeSafe answers "does a person still have to decide?"
// beside that outcome, and in enforce mode holds the draft when it says yes.
const { DEFAULT_OPEN_QUESTION } = await import("../src/intentDraft.ts");

const judgeStub = (p: number | null) => async () =>
  p === null ? null : { model: "jev-1", answers: { needs_person: { type: "noul" as const, noul: p } }, usage: { input_tokens: 0, output_tokens: 0 }, ms: 7 };

function withMode<T>(mode: string, fn: () => Promise<T>): Promise<T> {
  const key = process.env.TYPESAFE_API_KEY, m = process.env.HIVE_TYPESAFE_MODE;
  process.env.TYPESAFE_API_KEY = "k";
  process.env.HIVE_TYPESAFE_MODE = mode;
  return fn().finally(() => {
    if (key === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = key;
    if (m === undefined) delete process.env.HIVE_TYPESAFE_MODE; else process.env.HIVE_TYPESAFE_MODE = m;
  });
}

test("shadow mode records the typed judgment beside the outcome and still accepts", async () => {
  const f = fixture();
  await withMode("shadow", () =>
    investigateOnce(f.db, { exec: f.stub(() => ({ code: 0, stdout: answered })), accept: f.accept, judge: judgeStub(0.9) as any })
  );
  expect(getIntent(f.db, f.intent.id)!.status).toBe("accepted");
  expect(f.events()[0]).toMatchObject({ questions_after: 0, typesafe: { needs_person: 0.9, model: "jev-1", ms: 7 } });
});

test("enforce mode holds a draft TypeSafe says still needs a person", async () => {
  const f = fixture();
  await withMode("enforce", () =>
    investigateOnce(f.db, { exec: f.stub(() => ({ code: 0, stdout: answered })), accept: f.accept, judge: judgeStub(0.9) as any })
  );
  const after = getIntent(f.db, f.intent.id)!;
  expect(after.status).toBe("draft");
  expect(openQuestions(after.body_md)).toEqual([DEFAULT_OPEN_QUESTION]);
  // The investigation's findings are still recorded on the held draft.
  expect(intentSection(after.body_md, "Affected users and systems")).toContain("What hive found in the code:");
  expect(f.events()[0]).toMatchObject({ questions_after: 1, typesafe: { needs_person: 0.9 } });
});

test("enforce mode accepts when TypeSafe agrees nothing is left to decide", async () => {
  const f = fixture();
  await withMode("enforce", () =>
    investigateOnce(f.db, { exec: f.stub(() => ({ code: 0, stdout: answered })), accept: f.accept, judge: judgeStub(0.1) as any })
  );
  expect(getIntent(f.db, f.intent.id)!.status).toBe("accepted");
  expect(f.events()[0]).toMatchObject({ questions_after: 0, typesafe: { needs_person: 0.1 } });
});

test("a null judgment fails open: enforce accepts exactly as today", async () => {
  const f = fixture();
  await withMode("enforce", () =>
    investigateOnce(f.db, { exec: f.stub(() => ({ code: 0, stdout: answered })), accept: f.accept, judge: judgeStub(null) as any })
  );
  expect(getIntent(f.db, f.intent.id)!.status).toBe("accepted");
  expect(f.events()[0].typesafe).toBeUndefined();
});

const setConfig = (f: ReturnType<typeof fixture>, config: Record<string, unknown>) =>
  f.db.query("UPDATE projects SET config = ? WHERE id = 'proj'").run(JSON.stringify(config));

// Nothing a project writes into config.typesafe reaches Jev without a key in
// the server env: both runs produce the same outcome and the judge never runs.
test("without TYPESAFE_API_KEY a project config.typesafe=enforce changes nothing", async () => {
  let judged = 0;
  const spy = (async () => {
    judged++;
    return judgeStub(0.9)();
  }) as any;
  const run = async (config: Record<string, unknown>) => {
    const f = fixture();
    setConfig(f, config);
    await investigateOnce(f.db, { exec: f.stub(() => ({ code: 0, stdout: answered })), accept: f.accept, judge: spy });
    const after = getIntent(f.db, f.intent.id)!;
    return { status: after.status, questions: openQuestions(after.body_md), event: f.events()[0] };
  };
  const off = await run({});
  const enforce = await run({ typesafe: { mode: "enforce", needs_person_at: 0.1 } });
  expect(judged).toBe(0);
  expect(enforce.status).toBe(off.status);
  expect(enforce.questions).toEqual(off.questions);
  expect(enforce.event.typesafe).toBeUndefined();
  expect(off.event.typesafe).toBeUndefined();
});

test("a project needs_person_at holds a draft the default threshold would accept", async () => {
  const held = fixture();
  setConfig(held, { typesafe: { needs_person_at: 0.3 } });
  await withMode("enforce", () =>
    investigateOnce(held.db, { exec: held.stub(() => ({ code: 0, stdout: answered })), accept: held.accept, judge: judgeStub(0.35) as any })
  );
  expect(getIntent(held.db, held.intent.id)!.status).toBe("draft");

  const dflt = fixture();
  await withMode("enforce", () =>
    investigateOnce(dflt.db, { exec: dflt.stub(() => ({ code: 0, stdout: answered })), accept: dflt.accept, judge: judgeStub(0.35) as any })
  );
  expect(getIntent(dflt.db, dflt.intent.id)!.status).toBe("accepted");
});

test("argv pins the read-only tool list and the JSON envelope", () => {
  const argv = investigateArgv("look", "sonnet");
  expect(argv.slice(1, 6)).toEqual(["-p", "--model", "sonnet", "look", "--output-format"]);
  expect(argv).toContain("--max-turns");
  expect(argv).toContain("--strict-mcp-config");
});
