import { test, expect } from "bun:test";
import { openDb, newId, now, type DB } from "../src/db.ts";
import { getTask } from "../src/state.ts";
import { classifyRed, ciSignalKey, ciStatusProbed, ensureInfraTask, revalidateCiDecisions } from "../src/reconciler.ts";
import { createDecision, apiAnswerDecision, decisionBundle } from "../src/api.ts";
import { Herdr } from "../src/runtime/herdr.ts";
import type { Exec, ExecResult } from "../src/exec.ts";

const OK = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const stub = (fn: (argv: string[]) => ExecResult): Exec => async (argv) => fn(argv);

function freshDb(): { db: DB; projectId: string } {
  const db = openDb(":memory:");
  const projectId = newId("proj");
  db.query("INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)").run(
    projectId, "p", "/repo", "{}", now()
  );
  return { db, projectId };
}
function makeTask(db: DB, projectId: string, extra: Record<string, any> = {}): string {
  const id = newId();
  const t = now();
  db.query(
    "INSERT INTO tasks (id, project_id, title, state, kind, pr_url, ci_status, head_sha, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
  ).run(id, projectId, "t", extra.state ?? "in_review", "ship", extra.pr_url ?? null, extra.ci_status ?? null, extra.head_sha ?? null, t, t);
  return id;
}

const url = (job: string) => `https://github.com/example-org/example-repo/actions/runs/1/job/${job}`;
// One gh stub for all three probes: job 1 ran zero steps in 2s (no runner),
// job 2 is a genuine test failure, and 'parity' is already red on the base
// commit. Annotations never say "job was not started" here.
const gh = (): Exec =>
  stub((argv) => {
    const path = String(argv[2] ?? "");
    if (path.endsWith("/annotations")) return OK(JSON.stringify([{ message: "Process completed with exit code 1." }]));
    if (path.includes("/actions/jobs/1"))
      return OK(JSON.stringify({ steps: [], started_at: "2026-08-20T00:00:00Z", completed_at: "2026-08-20T00:00:02Z" }));
    if (path.includes("/actions/jobs/"))
      return OK(JSON.stringify({ steps: [{ name: "test" }], started_at: "2026-08-20T00:00:00Z", completed_at: "2026-08-20T00:04:00Z" }));
    if (path.includes("/commits/basesha/check-runs"))
      return OK(JSON.stringify({ check_runs: [{ name: "parity", conclusion: "failure" }] }));
    return OK();
  });

test("a red check that ran no steps, or is already red on the base branch, is infra — a real failure is not", async () => {
  const noSteps = { name: "syntax", conclusion: "FAILURE", detailsUrl: url("1") };
  const realRed = { name: "unit", conclusion: "FAILURE", detailsUrl: url("2") };
  const onBase = { name: "parity", conclusion: "FAILURE", detailsUrl: url("3") };

  const red = await classifyRed(gh(), [noSteps, onBase, realRed], "basesha");
  expect(red.map((c) => c.infra)).toEqual(["no-steps", "red-on-base", null]);

  // All-infra is one shared signal; one genuine failure means there is none.
  expect(ciSignalKey(red.slice(0, 2))).toBe("parity,syntax:no-steps,red-on-base");
  expect(ciSignalKey(red)).toBeNull();
  expect(await ciStatusProbed(gh(), [noSteps, onBase], "basesha")).toBe("unavailable");
  expect(await ciStatusProbed(gh(), [noSteps, realRed], "basesha")).toBe("failing");
});

test("one diagnostic task covers every PR blocked by the same signal", () => {
  const { db, projectId } = freshDb();
  const red = [{ name: "syntax", infra: "no-steps" }, { name: "parity", infra: "no-steps" }];
  const first = ensureInfraTask(db, projectId, "parity,syntax:no-steps", red, "https://gh/pr/811");
  const second = ensureInfraTask(db, projectId, "parity,syntax:no-steps", red, "https://gh/pr/833");
  expect(first).toBeTruthy();
  expect(second).toBeNull();
  expect(db.query("SELECT COUNT(*) AS n FROM tasks WHERE kind = 'chore'").get()).toEqual({ n: 1 } as any);
  // Closing the diagnostic task does not re-open one straight away — an outage
  // only a human can clear would otherwise mint a fresh task every cycle.
  db.query("UPDATE tasks SET state = 'done' WHERE id = ?").run(first!);
  expect(ensureInfraTask(db, projectId, "parity,syntax:no-steps", red, "https://gh/pr/833")).toBeNull();
  // A different outage still gets its own task.
  expect(ensureInfraTask(db, projectId, "e2e:not-started", [{ name: "e2e", infra: "not-started" }], "https://gh/pr/9")).toBeTruthy();
});

// The card the director actually complained about: one ruling per outage, not
// one question per PR.
test("a second PR blocked by the same outage inherits the director's ruling instead of asking", () => {
  const { db, projectId } = freshDb();
  const options = [{ key: "hold", label: "Hold" }, { key: "merge", label: "Merge anyway", recommended: true }];
  const signalled = (taskId: string) =>
    db.query("INSERT INTO events (id, task_id, ts, source, type, payload) VALUES (?,?,?,?,?,?)").run(
      newId("ev"), taskId, now(), "reconciler", "ci_infra", JSON.stringify({ signal: "parity,syntax:no-steps", head_sha: "abc" })
    );

  // The outage's own diagnostic task: the ruling stands only while this is open.
  ensureInfraTask(db, projectId, "parity,syntax:no-steps", [{ name: "syntax", infra: "no-steps" }], "https://gh/pr/811");

  const a = makeTask(db, projectId, { pr_url: "https://gh/pr/811", ci_status: "unavailable", head_sha: "abc" });
  signalled(a);
  const first = createDecision(db, { task_id: a, title: "Merge PR #811 with CI red?", context: "two checks are red", options });
  expect(first.status).toBe("open");
  apiAnswerDecision(db, new Herdr(), first.id, { answer_key: "merge", source: "director" });

  const b = makeTask(db, projectId, { pr_url: "https://gh/pr/833", ci_status: "unavailable", head_sha: "abc" });
  signalled(b);
  const second = createDecision(db, { task_id: b, title: "Merge PR #833 with CI red?", context: "same two checks are red", options });
  expect(second.status).toBe("answered");
  expect(second.answer_key).toBe("merge");
  // No second interruption for the same outage.
  expect(db.query("SELECT COUNT(*) AS n FROM notifications WHERE kind = 'decision'").get()).toEqual({ n: 1 } as any);

  // Once the outage's diagnostic task is closed, the ruling has expired with
  // it: the next PR asks the director again instead of inheriting a stale call.
  db.query("UPDATE tasks SET state = 'done' WHERE kind = 'chore'").run();
  const c = makeTask(db, projectId, { pr_url: "https://gh/pr/900", ci_status: "unavailable", head_sha: "abc" });
  signalled(c);
  const third = createDecision(db, { task_id: c, title: "Merge PR #900 with CI red?", context: "same two checks are red", options });
  expect(third.status).toBe("open");
});

// The false positive two reviewers caught: ordinary English words like "red",
// "green" and "check" must not tag an unrelated question as a CI card.
test("a card on a task whose checks are passing is never treated as a CI card", () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId, { pr_url: "https://gh/pr/1", ci_status: "passing", head_sha: "abc" });
  const d = createDecision(db, {
    task_id: id,
    title: "Keep the red icon or switch to green?",
    context: "the failing state uses red today",
    options: [{ key: "a", label: "Red" }, { key: "b", label: "Green" }],
  });
  expect(d.bundle.ci).toBeNull();
  expect((db.query("SELECT ci_status_at_card, ci_signal FROM decisions WHERE id = ?").get(d.id) as any)).toEqual(
    { ci_status_at_card: null, ci_signal: null } as any
  );
});

test("a card citing red checks closes itself once the checks are green, and shows how fresh it is", () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId, { pr_url: "https://gh/pr/1", ci_status: "failing", state: "in_progress" });
  const d = createDecision(db, {
    task_id: id,
    title: "Merge with CI red?",
    context: "checks are failing",
    options: [{ key: "yes", label: "Yes" }, { key: "no", label: "No" }],
  });
  expect(d.bundle.ci).toEqual({ at_card: "failing", status: "failing", checked_at: null, changed: false, outage: null });

  db.query("UPDATE tasks SET ci_status = 'passing', ci_checked_at = ? WHERE id = ?").run(now(), id);
  expect(decisionBundle(db, id, d.id).ci.changed).toBe(true);
  expect(revalidateCiDecisions(db)).toBe(1);
  expect((db.query("SELECT status FROM decisions WHERE id = ?").get(d.id) as any).status).toBe("expired");
  expect(getTask(db, id)!.state).toBe("in_progress");
});

test("a card that is not about CI is never stamped with a CI signal", () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId, { pr_url: "https://gh/pr/1", ci_status: "unavailable", head_sha: "abc" });
  const d = createDecision(db, { task_id: id, title: "Rename the settings page?", context: "two names are in use", options: [{ key: "a", label: "A" }, { key: "b", label: "B" }] });
  expect(d.bundle.ci).toBeNull();
  expect((db.query("SELECT ci_signal FROM decisions WHERE id = ?").get(d.id) as any).ci_signal).toBeNull();
});
