// In-run scope-drift watch (#1001): a run that grows past its brief raises a
// decision card while it is still cheap to trim, instead of surfacing at final
// review after the drifted work is already built.
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "hive-drift-"));
process.env.HIVE_HOME = HOME;

const { openDb, newId, now } = await import("../src/db.ts");
const { driftCheckOnce, extractDrift, resolveScopeDriftForDecision, startDriftWatch, directionSinceBrief, splitByDirection } =
  await import("../src/drift.ts");
const { transition } = await import("../src/state.ts");
import type { DB } from "../src/db.ts";
import type { Exec } from "../src/exec.ts";

const BRIEF = "Consolidate the supervision exclusion into one shared predicate in server/src/supervision.ts. Do NOT alter task semantics.";

function setup(config: any = {}, brief = BRIEF): { db: DB; id: string } {
  const db = openDb(":memory:");
  const pid = newId("proj");
  const t = now();
  db.query("INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)").run(
    pid, "p", "/repo", JSON.stringify(config), t
  );
  const id = newId();
  db.query(
    "INSERT INTO tasks (id, project_id, title, brief, state, kind, branch, created_at, updated_at) VALUES (?,?,?,?, 'queued','ship',?,?,?)"
  ).run(id, pid, "consolidate the exclusion", brief, "hive/abc", t, t);
  transition(db, id, "in_progress");
  return { db, id };
}

// A stub `git` for one branch state: N commits over the given files. The log
// call must ask for the branch's OWN commits — a plain `base..branch` also
// lists whatever a `git merge main` dragged in.
const git = (files: string[], commits: string[], added: Record<string, string[]> = {}): Exec => async (argv) => {
  if (argv.includes("--name-only")) return { code: 0, stdout: files.join("\n"), stderr: "" };
  if (argv.includes("--unified=0")) {
    const diff = Object.entries(added).map(([f, lines]) => [`+++ b/${f}`, ...lines.map((l) => `+${l}`)].join("\n"));
    return { code: 0, stdout: diff.join("\n"), stderr: "" };
  }
  if (argv.includes("--format=%s")) {
    expect(argv).toContain("--first-parent");
    expect(argv).toContain("--no-merges");
    return { code: 0, stdout: commits.join("\n"), stderr: "" };
  }
  return { code: 0, stdout: "", stderr: "" };
};

// A stub judge that answers with a fixed verdict and records what it was asked.
const judge = (verdict: any, seen: string[] = []) => async (argv: string[]) => {
  seen.push(argv.join(" "));
  return { code: 0, stdout: JSON.stringify({ result: JSON.stringify(verdict) }), stderr: "", timedOut: false };
};

const events = (db: DB, id: string, type: string) =>
  db.query("SELECT * FROM events WHERE task_id = ? AND type = ? ORDER BY ts").all(id, type).map((e: any) => ({ ...e, payload: JSON.parse(e.payload) }));
const openCards = (db: DB, id: string) => db.query("SELECT * FROM decisions WHERE task_id = ? AND status = 'open'").all(id) as any[];

const OVER = ["server/src/supervision.ts", "server/src/health.ts", "server/src/state.ts", "web/src/lib/needsYou.ts", "web/test/needsYou.test.ts"];
const WITHIN = ["server/src/supervision.ts", "server/test/supervision.test.ts"];

// The whole point: the card lands DURING the run, not at final review. A
// no-mistakes round lands at least one commit, so at the default step of 3 the
// first check fires by the third round.
test("an over-scope run raises the drift card before the third review round", async () => {
  const { db, id } = setup();
  const seen: string[] = [];
  const verdict = { drifting: true, beyond: ["web/src/lib/needsYou.ts", "server/src/state.ts"], why: "the brief scoped one predicate; the run also mirrored the rule into the web layer" };

  // Round 1 and 2: under the step, nothing is even judged (no model spend).
  for (const commits of [["r1"], ["r2", "r1"]]) {
    expect(await driftCheckOnce(db, { shellExec: git(OVER, commits), exec: judge(verdict, seen) })).toBeNull();
  }
  expect(seen).toHaveLength(0);
  expect(openCards(db, id)).toHaveLength(0);

  // Round 3: the step is crossed, the judge runs, the card opens.
  expect(await driftCheckOnce(db, { shellExec: git(OVER, ["r3", "r2", "r1"]), exec: judge(verdict, seen) })).toBe(id);
  expect(seen).toHaveLength(1);
  const card = openCards(db, id);
  expect(card).toHaveLength(1);
  expect(card[0].title).toContain("growing past its brief");
  expect(card[0].context).toContain("web/src/lib/needsYou.ts");
  // Trim DELETES requested work and these cards auto-answer on a timeout, so the
  // recommendation is split — it preserves the work either way (HIVE-560).
  expect(JSON.parse(card[0].options).map((o: any) => o.key)).toEqual(["split", "continue", "trim"]);
  expect(JSON.parse(card[0].options).find((o: any) => o.recommended).key).toBe("split");
  // The task is parked for the director and the drift is on the record.
  expect((db.query("SELECT state FROM tasks WHERE id = ?").get(id) as any).state).toBe("needs_decision");
  expect(events(db, id, "scope_drift")[0].payload.beyond).toContain("server/src/state.ts");
});

// The prompt: footprint vs brief, plus a sample of the added lines.
test("the judge is asked about the brief, the files and the commit subjects", async () => {
  const { db } = setup();
  const seen: string[] = [];
  await driftCheckOnce(db, {
    shellExec: git(OVER, ["mirror the rule into web", "add the predicate", "wip"], {
      "server/src/state.ts": ["// HIVE-560: the reason this line exists"],
    }),
    exec: judge({ drifting: false, beyond: [], why: "in scope" }, seen),
  });
  expect(seen[0]).toContain("Do NOT alter task semantics");
  expect(seen[0]).toContain("web/src/lib/needsYou.ts");
  expect(seen[0]).toContain("mirror the rule into web");
  // Content, not just paths: the judge must be able to read WHY a file changed
  // instead of guessing from its name (HIVE-560).
  expect(seen[0]).toContain("// HIVE-560: the reason this line exists");
  expect(seen[0]).toContain("--disallowed-tools=");
});

test("a within-scope run raises nothing, and keeps checking as it grows", async () => {
  const { db, id } = setup();
  const seen: string[] = [];
  const clean = judge({ drifting: false, beyond: [], why: "every file traces to the brief" }, seen);

  expect(await driftCheckOnce(db, { shellExec: git(WITHIN, ["r3", "r2", "r1"]), exec: clean })).toBe(id);
  expect(openCards(db, id)).toHaveLength(0);
  expect(events(db, id, "scope_drift_check")[0].payload.drifting).toBe(false);

  // Two more commits: still under the next step, so no second judge call.
  expect(await driftCheckOnce(db, { shellExec: git(WITHIN, ["r5", "r4", "r3", "r2", "r1"]), exec: clean })).toBeNull();
  expect(seen).toHaveLength(1);

  // Step crossed again: checked again, still clean, still no card.
  const grown = [...WITHIN, "docs/API.md"];
  expect(await driftCheckOnce(db, { shellExec: git(grown, ["r6", "r5", "r4", "r3", "r2", "r1"]), exec: clean })).toBe(id);
  expect(seen).toHaveLength(2);
  expect(openCards(db, id)).toHaveLength(0);
});

test("one card per task — a drifting run is not re-carded every cycle", async () => {
  const { db, id } = setup();
  const seen: string[] = [];
  const drifting = judge({ drifting: true, beyond: ["web/src/lib/needsYou.ts"], why: "grew into the web layer" }, seen);
  await driftCheckOnce(db, { shellExec: git(OVER, ["r3", "r2", "r1"]), exec: drifting });
  expect(await driftCheckOnce(db, { shellExec: git([...OVER, "web/src/views/Task.tsx"], ["r9", "r8", "r7", "r6", "r5", "r4", "r3", "r2", "r1"]), exec: drifting })).toBeNull();
  expect(seen).toHaveLength(1);
  expect(openCards(db, id)).toHaveLength(1);
});

test("answering the card steers the agent and claims the decision", async () => {
  const { db, id } = setup();
  await driftCheckOnce(db, {
    shellExec: git(OVER, ["r3", "r2", "r1"]),
    exec: judge({ drifting: true, beyond: ["web/src/lib/needsYou.ts"], why: "grew into the web layer" }),
  });
  const decisionId = events(db, id, "scope_drift")[0].payload.decision_id;

  expect(resolveScopeDriftForDecision(db, decisionId, "split")).toBe(true);
  const steer = events(db, id, "steer").at(-1)!.payload;
  expect(steer.message).toContain("hive task create");
  expect(steer.delivery).toBe("queued");
  // A card this resolver does not own is left for the other resolvers.
  expect(resolveScopeDriftForDecision(db, "dec_someone_else", "trim")).toBe(false);
});

// "Can't tell" must never cost the director an interruption.
test("no card from a git failure, an unparseable verdict, an empty brief, or an opt-out", async () => {
  const gitDown: Exec = async () => ({ code: 128, stdout: "", stderr: "fatal: bad revision" });
  const never = async () => {
    throw new Error("the judge must not run");
  };
  const a = setup();
  expect(await driftCheckOnce(a.db, { shellExec: gitDown, exec: never as any })).toBeNull();
  expect(events(a.db, a.id, "scope_drift_check")).toHaveLength(0);

  const b = setup();
  expect(await driftCheckOnce(b.db, {
    shellExec: git(OVER, ["r3", "r2", "r1"]),
    exec: async () => ({ code: 0, stdout: "I could not decide, sorry", stderr: "", timedOut: false }),
  })).toBe(b.id);
  expect(openCards(b.db, b.id)).toHaveLength(0);
  expect(events(b.db, b.id, "scope_drift_check")[0].payload.error).toContain("unparseable");

  const c = setup({}, "   ");
  expect(await driftCheckOnce(c.db, { shellExec: git(OVER, ["r3", "r2", "r1"]), exec: never as any })).toBeNull();

  const d = setup({ scope_drift: false });
  expect(await driftCheckOnce(d.db, { shellExec: git(OVER, ["r3", "r2", "r1"]), exec: never as any })).toBeNull();
});

test("scope_drift_commits tunes how often a run is checked", async () => {
  const { db, id } = setup({ scope_drift_commits: 6 });
  const seen: string[] = [];
  const clean = judge({ drifting: false, beyond: [], why: "in scope" }, seen);
  expect(await driftCheckOnce(db, { shellExec: git(WITHIN, ["c3", "c2", "c1"]), exec: clean })).toBeNull();
  expect(await driftCheckOnce(db, { shellExec: git(WITHIN, ["c6", "c5", "c4", "c3", "c2", "c1"]), exec: clean })).toBe(id);
  expect(seen).toHaveLength(1);
});

test("extractDrift reads bare JSON, the claude -p envelope, and prose-wrapped JSON", () => {
  const want = { drifting: true, beyond: ["a.ts"], why: "grew" };
  expect(extractDrift(JSON.stringify(want))).toEqual(want);
  expect(extractDrift(JSON.stringify({ result: JSON.stringify(want) }))).toEqual(want);
  expect(extractDrift(JSON.stringify({ result: "Here is my verdict:\n" + JSON.stringify(want) }))).toEqual(want);
  expect(extractDrift('{"beyond":[],"why":"no verdict field"}')).toBeNull();
  expect(extractDrift("no json here")).toBeNull();
});

// A judge call outlasts the 60s interval, so the loop must not start a second
// check on the same task before the first records its result.
test("the watch loop never runs two checks at once", async () => {
  const { db, id } = setup();
  let inFlight = 0;
  let overlapped = false;
  let calls = 0;
  const slow = async () => {
    calls++;
    if (++inFlight > 1) overlapped = true;
    await new Promise((r) => setTimeout(r, 40));
    inFlight--;
    return { code: 0, stdout: JSON.stringify({ drifting: false, beyond: [], why: "in scope" }), stderr: "", timedOut: false };
  };
  const stop = startDriftWatch(db, { intervalMs: 5, shellExec: git(WITHIN, ["r3", "r2", "r1"]), exec: slow });
  await new Promise((r) => setTimeout(r, 120));
  stop();
  await new Promise((r) => setTimeout(r, 60));
  expect(overlapped).toBe(false);
  expect(calls).toBeGreaterThan(0);
  expect(events(db, id, "scope_drift_check").length).toBe(calls);
});


// Drift is not always a new file: #974's own brief-forbidden change ("make the
// exclusion agent_target-aware") lived inside a file the brief already named.
test("a later check still runs when the branch grew commits but no new files", async () => {
  const { db, id } = setup();
  const seen: string[] = [];
  const clean = judge({ drifting: false, beyond: [], why: "in scope" }, seen);
  expect(await driftCheckOnce(db, { shellExec: git(WITHIN, ["r3", "r2", "r1"]), exec: clean })).toBe(id);
  const same = git(WITHIN, ["r6", "r5", "r4", "r3", "r2", "r1"]);
  expect(await driftCheckOnce(db, { shellExec: same, exec: clean })).toBe(id);
  expect(seen).toHaveLength(2);
});

// A judge that errors must not be retried every cycle.
test("a failed check backs off by a full step instead of retrying immediately", async () => {
  const { db, id } = setup();
  let calls = 0;
  const broken = async () => {
    calls++;
    return { code: 1, stdout: "", stderr: "boom", timedOut: false };
  };
  expect(await driftCheckOnce(db, { shellExec: git(WITHIN, ["r3", "r2", "r1"]), exec: broken })).toBe(id);
  expect(await driftCheckOnce(db, { shellExec: git(WITHIN, ["r5", "r4", "r3", "r2", "r1"]), exec: broken })).toBeNull();
  expect(await driftCheckOnce(db, { shellExec: git(WITHIN, ["r6", "r5", "r4", "r3", "r2", "r1"]), exec: broken })).toBe(id);
  expect(calls).toBe(2);
  expect(events(db, id, "scope_drift_check").every((e) => e.payload.error.includes("exited 1"))).toBe(true);
});
// The card is left to age out on a project with decision_auto_answer_hours, so
// its recommended option has to be one the reconciler can actually act on —
// an option that asks the director to hand something over is skipped instead.
test("the recommended option is safe for the stale auto-answer path", async () => {
  const { optionNeedsDirectorInput } = await import("../src/policy.ts");
  const { db, id } = setup();
  await driftCheckOnce(db, {
    shellExec: git(OVER, ["r3", "r2", "r1"]),
    exec: judge({ drifting: true, beyond: ["web/src/lib/needsYou.ts"], why: "grew into the web layer" }),
  });
  const card = openCards(db, id)[0];
  expect(card.risk).toBe("normal"); // 'high' is never auto-answered
  for (const opt of JSON.parse(card.options)) expect(optionNeedsDirectorInput(opt)).toBe(false);
});

// Argument injection (task #1024). config.default_branch reaches git as a
// POSITIONAL argument here (`git diff --name-only <base>...<branch>`, `git log
// <base>..<branch>`), and git reads a leading `-` as an option — `--output=…`
// writes an arbitrary file as the local user. config is caller-writable via PUT
// /api/projects, so the poisoned value must never appear in argv at all.
test("a config.default_branch starting with `-` never reaches git argv (task #1024)", async () => {
  const payload = "--output=/tmp/pwn";
  const { db } = setup({ default_branch: payload });
  const argvs: string[][] = [];
  const recording: Exec = async (argv) => {
    argvs.push(argv);
    if (argv.includes("--name-only")) return { code: 0, stdout: WITHIN.join("\n"), stderr: "" };
    return { code: 0, stdout: "r3\nr2\nr1", stderr: "" };
  };
  await driftCheckOnce(db, { shellExec: recording, exec: judge({ drifting: false, beyond: [], why: "" }) });

  expect(argvs.length).toBeGreaterThan(0);
  for (const argv of argvs) expect(argv.join(" ")).not.toContain(payload);
  // and it fell back to the default base, so the check still ran normally
  expect(argvs.some((a) => a.some((x) => x.startsWith("origin/main.")))).toBe(true);
});

// HIVE-291 / #1095 (dec_46a0c8614067): local main pinned at an old commit while
// origin/main advanced past it. A task branch correctly rebased onto origin/main
// (zero commits of its own ahead of it) must not have origin/main's own commits
// — landed by unrelated PRs since local main last moved — counted as its footprint.
test("a branch rebased onto an ahead-of-local-main origin/main shows zero footprint (HIVE-291)", async () => {
  const foreignCommits = [
    "fix(reconciler): resolve gh PATH, health surfacing (#126)",
    "fix(reconciler): recover agents with queued input (#129)",
  ];
  const foreignFiles = ["server/src/reconciler.ts", "server/src/health.ts"];
  const { branchFootprint } = await import("../src/drift.ts");

  // A stale local `main` sees the branch as having "accumulated" everything
  // origin/main gained since local main last fast-forwarded — the bug.
  const staleLocalMain: Exec = async (argv) => {
    if (argv.includes("--name-only")) return { code: 0, stdout: foreignFiles.join("\n"), stderr: "" };
    if (argv.includes("--format=%s")) return { code: 0, stdout: foreignCommits.join("\n"), stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const staleFp = await branchFootprint(staleLocalMain, "/repo", "main", "hive/abc");
  expect(staleFp?.commits).toEqual(foreignCommits); // demonstrates the bug against a stale local ref

  // Measured against origin/main (what projectComparisonBase resolves to), the
  // rebased branch has zero real commits and zero files of its own.
  const originMain: Exec = async (argv) => {
    if (argv.includes("--name-only")) return { code: 0, stdout: "", stderr: "" };
    if (argv.includes("--format=%s")) return { code: 0, stdout: "", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const fixedFp = await branchFootprint(originMain, "/repo", "origin/main", "hive/abc");
  expect(fixedFp?.commits).toEqual([]);
  expect(fixedFp?.files).toEqual([]);
  for (const c of foreignCommits) expect(fixedFp?.commits).not.toContain(c);

  // End to end: driftCheckOnce resolves the base itself, and must use
  // origin/main (via projectComparisonBase), never the bare local branch name.
  const { db, id } = setup();
  const argvs: string[][] = [];
  const recording: Exec = async (argv) => {
    argvs.push(argv);
    const usedOrigin = argv.some((a) => a.startsWith("origin/main"));
    if (argv.includes("--name-only")) return { code: 0, stdout: usedOrigin ? "" : foreignFiles.join("\n"), stderr: "" };
    if (argv.includes("--format=%s")) return { code: 0, stdout: usedOrigin ? "" : foreignCommits.join("\n"), stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  expect(await driftCheckOnce(db, { shellExec: recording, exec: judge({ drifting: false, beyond: [], why: "" }) })).toBeNull();
  expect(argvs.some((a) => a.some((x) => x.startsWith("main.")))).toBe(false);
  expect(openCards(db, id)).toHaveLength(0);
});

// HIVE-560. The checker compared work against the BRIEF alone, so any direction
// given mid-run read as scope creep — three tasks in one night, all answered
// "continue", and the recommended answer would have deleted correct work.
const steerTask = (db: DB, id: string, message: string) =>
  db.query("INSERT INTO events (id, task_id, ts, source, type, payload) VALUES (?,?,?,?,?,?)").run(
    newId("ev"), id, now(), "director", "steer", JSON.stringify({ message, delivery: "delivered" })
  );

const answerCard = (db: DB, id: string, title: string, label: string) =>
  db.query(
    "INSERT INTO decisions (id, task_id, ts, title, options, status, answer_key, answered_at) VALUES (?,?,?,?,?, 'answered', 'a', ?)"
  ).run(newId("dec"), id, now(), title, JSON.stringify([{ key: "a", label }]), now());

test("a steer and an answered decision are part of the ask, not scope creep (HIVE-560)", async () => {
  const { db, id } = setup();
  steerTask(db, id, "also mirror the rule into web/src/lib/needsYou.ts while you are in there");
  answerCard(db, id, "one table or two?", "merge onto one table — write the schema migration");
  const seen: string[] = [];

  // The judge sees the direction alongside the brief...
  expect(await driftCheckOnce(db, {
    shellExec: git(OVER, ["r3", "r2", "r1"]),
    exec: judge({ drifting: true, beyond: ["web/src/lib/needsYou.ts mirrors the rule"], why: "grew into the web layer" }, seen),
  })).toBe(id);
  expect(seen[0]).toContain("also mirror the rule into web/src/lib/needsYou.ts");
  expect(seen[0]).toContain("merge onto one table");

  // ...and even when it flags that work anyway, a path the direction named is
  // not carded. No card means no auto-answered "trim" deleting requested work.
  expect(openCards(db, id)).toHaveLength(0);
  const check = events(db, id, "scope_drift_check")[0].payload;
  expect(check.covered_by_direction).toEqual(["web/src/lib/needsYou.ts mirrors the rule"]);
});

test("real scope creep — a file nobody mentioned — still raises the card (HIVE-560)", async () => {
  const { db, id } = setup();
  steerTask(db, id, "also mirror the rule into web/src/lib/needsYou.ts");
  expect(await driftCheckOnce(db, {
    shellExec: git(OVER, ["r3", "r2", "r1"]),
    exec: judge({
      drifting: true,
      beyond: ["web/src/lib/needsYou.ts mirrors the rule", "server/src/health.ts rewritten"],
      why: "health.ts was rewritten and nobody asked",
    }),
  })).toBe(id);
  const card = openCards(db, id);
  expect(card).toHaveLength(1);
  expect(card[0].context).toContain("server/src/health.ts");
  expect(card[0].context).not.toContain("needsYou");
});

test("directionSinceBrief reads director steers and answered decisions, not hive's own steers", () => {
  const { db, id } = setup();
  steerTask(db, id, "unlink 비고 from the homepage too");
  answerCard(db, id, "one table or two?", "merge onto one table");
  db.query("INSERT INTO events (id, task_id, ts, source, type, payload) VALUES (?,?,?,?,?,?)").run(
    newId("ev"), id, now(), "system", "steer", JSON.stringify({ message: "do not retry the land", delivery: "queued" })
  );
  const direction = directionSinceBrief(db, id);
  expect(direction.map((d) => d.kind).sort()).toEqual(["decision", "steer"]);
  expect(direction.find((d) => d.kind === "steer")!.text).toContain("unlink 비고");
  expect(direction.find((d) => d.kind === "decision")!.text).toContain("merge onto one table");
  expect(JSON.stringify(direction)).not.toContain("do not retry");
});

test("splitByDirection only clears items the direction actually names", () => {
  const direction = [{ kind: "steer" as const, ts: now(), text: "please also touch server/src/health.ts and web/src/views/" }];
  const { flag, covered } = splitByDirection(
    ["server/src/health.ts hardened", "web/src/views/Task.tsx rewritten", "server/src/state.ts refactored"],
    direction
  );
  expect(covered).toEqual(["server/src/health.ts hardened", "web/src/views/Task.tsx rewritten"]);
  expect(flag).toEqual(["server/src/state.ts refactored"]);
  // No direction at all: nothing is cleared.
  expect(splitByDirection(["server/src/state.ts refactored"], []).flag).toHaveLength(1);
});

// The judge's confident-but-false claim (HIVE-511): a test for THIS task's own
// feature, added to an existing test file, was called unrelated "with no stated
// reason" — from the filename alone, because the prompt never showed content.
test("the judge is shown the added lines of every file it is judging (HIVE-560)", async () => {
  const { db } = setup();
  const seen: string[] = [];
  await driftCheckOnce(db, {
    shellExec: git(["server/src/supervision.ts", "server/test/jira.test.ts"], ["r3", "r2", "r1"], {
      "server/test/jira.test.ts": ["// HIVE-511: the catchup card shows a before/after pair, so a rendered proof", "// has to say which side it is."],
    }),
    exec: judge({ drifting: false, beyond: [], why: "in scope" }, seen),
  });
  expect(seen[0]).toContain("HIVE-511: the catchup card shows a before/after pair");
  expect(seen[0]).toContain("Judge by CONTENT, never by a file's NAME");
});

// A steer arriving mid-run must not be a reason to check less carefully: the
// footprint sampling is bounded, so a huge diff cannot blow up the prompt.
test("the added-line sample is bounded per file and overall", async () => {
  const { addedLineSamples } = await import("../src/drift.ts");
  const many = Object.fromEntries(
    Array.from({ length: 40 }, (_, i) => [`server/src/f${i}.ts`, Array.from({ length: 30 }, (_, j) => `line ${j} ` + "x".repeat(400))])
  );
  const samples = await addedLineSamples(git([], [], many), "/repo", "origin/main", "hive/abc");
  const lines = Object.values(samples).flat();
  expect(lines.length).toBeLessThanOrEqual(200);
  for (const [, ls] of Object.entries(samples)) expect(ls.length).toBeLessThanOrEqual(8);
  for (const l of lines) expect(l.length).toBeLessThanOrEqual(160);
});

// The brief itself can be rewritten mid-run (the director rewrote WEB-118's).
// The check reads tasks.brief, which the edit endpoint updates in place, so it
// already measures against the CURRENT brief.
test("the check measures against the current brief, not the original (HIVE-560)", async () => {
  const { db, id } = setup();
  db.query("UPDATE tasks SET brief = ? WHERE id = ?").run("Rewritten: unlink 비고 from the public reader UI.", id);
  const seen: string[] = [];
  await driftCheckOnce(db, { shellExec: git(WITHIN, ["r3", "r2", "r1"]), exec: judge({ drifting: false, beyond: [], why: "in scope" }, seen) });
  expect(seen[0]).toContain("Rewritten: unlink 비고");
  expect(seen[0]).not.toContain("Do NOT alter task semantics");
});
