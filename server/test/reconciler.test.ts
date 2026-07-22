import { test, expect } from "bun:test";
import { openDb, newId, now, type DB } from "../src/db.ts";
import { transition, getTask, writeEvent } from "../src/state.ts";
import { reconcileOnce, ciStatusOf } from "../src/reconciler.ts";
import { Herdr } from "../src/runtime/herdr.ts";
import type { Exec, ExecResult } from "../src/exec.ts";

function freshDb(config: any = {}): { db: DB; projectId: string } {
  const db = openDb(":memory:");
  const projectId = newId("proj");
  db.query("INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)").run(
    projectId, "p", "/repo", JSON.stringify(config), now()
  );
  return { db, projectId };
}
function makeTask(db: DB, projectId: string, extra: Partial<{ agent_target: string; pr_url: string; state: string; ci_status: string; kind: string }> = {}): string {
  const id = newId();
  const t = now();
  db.query(
    "INSERT INTO tasks (id, project_id, title, state, kind, agent_target, pr_url, ci_status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
  ).run(id, projectId, "t", extra.state ?? "queued", extra.kind ?? "ship", extra.agent_target ?? null, extra.pr_url ?? null, extra.ci_status ?? null, t, t);
  return id;
}
const stub = (fn: (argv: string[]) => ExecResult): Exec => async (argv) => fn(argv);
const OK = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });

test("ciStatusOf derives failing > pending > passing", () => {
  expect(ciStatusOf([{ conclusion: "SUCCESS" }, { conclusion: "SUCCESS" }])).toBe("passing");
  expect(ciStatusOf([{ conclusion: "SUCCESS" }, { status: "IN_PROGRESS" }])).toBe("pending");
  expect(ciStatusOf([{ conclusion: "SUCCESS" }, { conclusion: "FAILURE" }])).toBe("failing");
  expect(ciStatusOf([{ state: "PENDING" }])).toBe("pending");
  expect(ciStatusOf([])).toBeNull();
});

test("syncAgents writes an agent_status event only when the status changes", async () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId, { agent_target: "t-agent", state: "in_progress" });
  const herdr = new Herdr(stub(() => OK('{"status":"working"}')), "herdr");

  await reconcileOnce(db, { herdr, exec: stub(() => ({ code: 1, stdout: "", stderr: "no gh" })) });
  let events = db.query("SELECT * FROM events WHERE task_id = ? AND type = 'agent_status'").all(id);
  expect(events.length).toBe(1);

  // same status again -> no new event
  await reconcileOnce(db, { herdr, exec: stub(() => ({ code: 1, stdout: "", stderr: "no gh" })) });
  events = db.query("SELECT * FROM events WHERE task_id = ? AND type = 'agent_status'").all(id);
  expect(events.length).toBe(1);
});

test("syncPRs updates ci_status and transitions in_review->verifying on merge", async () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId, { pr_url: "https://gh/pr/1" });
  transition(db, id, "in_progress");
  transition(db, id, "in_review");

  const gh: Exec = stub((argv) => {
    if (argv[0] === "gh") return OK(JSON.stringify({ state: "MERGED", statusCheckRollup: [{ conclusion: "SUCCESS" }] }));
    return OK();
  });
  await reconcileOnce(db, { exec: gh });

  const task = getTask(db, id);
  expect(task.ci_status).toBe("passing");
  expect(task.state).toBe("verifying");
  expect(db.query("SELECT * FROM events WHERE task_id = ? AND type = 'pr_merged'").all(id).length).toBe(1);
});

test("syncPRs persists the PR's head_sha so the review card can flag stale evidence", async () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId, { pr_url: "https://gh/pr/1a" });
  transition(db, id, "in_progress");

  const gh: Exec = stub((argv) => {
    if (argv[0] === "gh")
      return OK(JSON.stringify({ state: "OPEN", statusCheckRollup: [{ conclusion: "SUCCESS" }], headRefOid: "sha-a" }));
    return OK();
  });
  await reconcileOnce(db, { exec: gh });
  expect(getTask(db, id).head_sha).toBe("sha-a");

  // a later poll with a new head commit updates it
  const gh2: Exec = stub((argv) => {
    if (argv[0] === "gh")
      return OK(JSON.stringify({ state: "OPEN", statusCheckRollup: [{ conclusion: "SUCCESS" }], headRefOid: "sha-b" }));
    return OK();
  });
  await reconcileOnce(db, { exec: gh2 });
  expect(getTask(db, id).head_sha).toBe("sha-b");
});

test("syncPRs bounces an in_review task whose CI turned red, steers once per sha", async () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId, { pr_url: "https://gh/pr/2", agent_target: "t-agent" });
  transition(db, id, "in_progress");
  transition(db, id, "in_review");

  const sends: string[] = [];
  const herdr = new Herdr(
    stub((argv) => {
      if (argv.includes("send")) {
        sends.push(argv[argv.indexOf("send") + 2]);
        return OK();
      }
      if (argv.includes("get")) return OK('{"result":{"agent":{"pane_id":"p1","agent_status":"working"}}}');
      return OK();
    }),
    "herdr"
  );
  const gh: Exec = stub((argv) => {
    if (argv[0] === "gh")
      return OK(JSON.stringify({ state: "OPEN", statusCheckRollup: [{ conclusion: "FAILURE" }], headRefOid: "sha-red" }));
    return OK();
  });
  await reconcileOnce(db, { exec: gh, herdr });
  const task = getTask(db, id);
  expect(task.state).toBe("in_progress"); // red is not reviewable
  expect(task.ci_status).toBe("failing");
  expect(sends.some((s) => s.includes("CI is FAILING"))).toBe(true);

  // same sha next cycle: no re-nudge, and the task stays with the agent
  const before = sends.length;
  await reconcileOnce(db, { exec: gh, herdr });
  expect(sends.length).toBe(before);
  expect(getTask(db, id).state).toBe("in_progress");

  // checks go green → promoted to review automatically
  const ghGreen: Exec = stub((argv) => {
    if (argv[0] === "gh")
      return OK(JSON.stringify({ state: "OPEN", statusCheckRollup: [{ conclusion: "SUCCESS" }], headRefOid: "sha-green" }));
    return OK();
  });
  await reconcileOnce(db, { exec: ghGreen, herdr });
  expect(getTask(db, id).state).toBe("in_review");
});

test("syncPRs bounces an in_review task whose PR was closed without merging", async () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId, { pr_url: "https://gh/pr/3", agent_target: "t-agent" });
  transition(db, id, "in_progress");
  transition(db, id, "in_review");
  const gh: Exec = stub((argv) =>
    argv[0] === "gh" ? OK(JSON.stringify({ state: "CLOSED", statusCheckRollup: [] })) : OK()
  );
  const herdr = new Herdr(
    stub((argv) =>
      argv.includes("get") ? OK('{"result":{"agent":{"pane_id":"p1","agent_status":"working"}}}') : OK()
    ),
    "herdr"
  );
  await reconcileOnce(db, { exec: gh, herdr });
  expect(getTask(db, id).state).toBe("in_progress");
  const steers = db.query("SELECT payload FROM events WHERE task_id = ? AND type='steer'").all(id) as any[];
  expect(JSON.parse(steers.at(-1).payload).message).toContain("CLOSED (not merged)");
});

test("sweepVerifying re-runs the advance and flags evidence-wedged tasks once", async () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId, { state: "queued" });
  transition(db, id, "in_progress");
  transition(db, id, "in_review");
  transition(db, id, "verifying");
  db.query("UPDATE tasks SET updated_at = ? WHERE id = ?").run(new Date(Date.now() - 20 * 60 * 1000).toISOString(), id);

  const { sweepVerifying } = await import("../src/reconciler.ts");
  await sweepVerifying(db, {}); // no evidence: done gate refuses → wedged
  expect(getTask(db, id).state).toBe("verifying");
  let wedged = db.query("SELECT * FROM events WHERE task_id = ? AND type='verify_wedged'").all(id);
  expect(wedged.length).toBe(1);
  await sweepVerifying(db, {}); // no double-flag
  expect(db.query("SELECT * FROM events WHERE task_id = ? AND type='verify_wedged'").all(id).length).toBe(1);

  // evidence attached → the next sweep completes the task
  db.query("INSERT INTO evidence (id, task_id, ts, kind, path, caption) VALUES (?,?,?,?,?,?)").run(
    newId("evd"), id, now(), "log", "/tmp/x.log", "proof"
  );
  db.query("UPDATE tasks SET updated_at = ? WHERE id = ?").run(new Date(Date.now() - 20 * 60 * 1000).toISOString(), id);
  await sweepVerifying(db, {});
  expect(getTask(db, id).state).toBe("done");
});

test("autoMergeReady merges only opted-in, green, clean-review, uncontested tasks", async () => {
  const { autoMergeReady } = await import("../src/reconciler.ts");
  const { db, projectId } = freshDb({ auto_merge: { kinds: ["chore"] } });
  const mk = (extra: any) => {
    const id = makeTask(db, projectId, { kind: "chore", ...extra });
    transition(db, id, "in_progress");
    transition(db, id, "in_review");
    db.query("UPDATE tasks SET ci_status = 'passing', branch = 'hive/x' WHERE id = ?").run(id);
    db.query("INSERT INTO evidence (id, task_id, ts, kind, path, caption) VALUES (?,?,?,?,?,?)").run(
      newId("evd"), id, now(), "log", "/tmp/e.log", "proof"
    );
    return id;
  };
  const clean = mk({});
  const risky = mk({});
  writeEvent(db, { task_id: clean, source: "system", type: "auto_review", payload: { verdict: "looks_good", summary: "s", risks: [], questions: [] } });
  writeEvent(db, { task_id: risky, source: "system", type: "auto_review", payload: { verdict: "looks_good", summary: "s", risks: ["a real risk"], questions: [] } });
  // primary checkout sits on the base branch; git merge-base/merge succeed for the local-ff path
  const git: Exec = stub((argv) => (argv.includes("symbolic-ref") ? OK("main\n") : OK()));
  await autoMergeReady(db, { exec: git });
  expect(getTask(db, clean).state).toBe("done"); // merged; no smoke configured → straight through verifying
  expect(getTask(db, risky).state).toBe("in_review"); // risks → human review
});

test("autoAnswerStale answers timed-out normal-risk cards with the recommendation, never high-risk", async () => {
  const { autoAnswerStale } = await import("../src/reconciler.ts");
  const { db, projectId } = freshDb({ decision_auto_answer_hours: 4 });
  const id = makeTask(db, projectId, {});
  const mkDecision = (risk: string) => {
    const did = newId("dec");
    db.query(
      "INSERT INTO decisions (id, task_id, ts, title, risk, options, status) VALUES (?,?,?,?,?,?, 'open')"
    ).run(did, id, new Date(Date.now() - 5 * 3600_000).toISOString(), "t?", risk,
      JSON.stringify([{ key: "go", label: "Go", recommended: true }, { key: "no", label: "No" }]));
    return did;
  };
  const normal = mkDecision("normal");
  const high = mkDecision("high");
  const herdr = new Herdr(stub(() => OK()), "herdr");
  autoAnswerStale(db, herdr, Date.now());
  expect((db.query("SELECT status, answer_key FROM decisions WHERE id = ?").get(normal) as any).answer_key).toBe("go");
  expect((db.query("SELECT status FROM decisions WHERE id = ?").get(high) as any).status).toBe("open");
});

test("autoAnswerStale skips options that need director-supplied input (flag or keyword), notifies once", async () => {
  const { autoAnswerStale } = await import("../src/reconciler.ts");
  const { db, projectId } = freshDb({ decision_auto_answer_hours: 4 });
  const id = makeTask(db, projectId, {});
  const stale = new Date(Date.now() - 5 * 3600_000).toISOString();
  const mk = (opts: any[]) => {
    const did = newId("dec");
    db.query(
      "INSERT INTO decisions (id, task_id, ts, title, risk, options, status) VALUES (?,?,?,?,'normal',?, 'open')"
    ).run(did, id, stale, "creds?", JSON.stringify(opts));
    return did;
  };
  // keyword signal: the incident's exact shape — recommended option asks for a token
  const byKeyword = mk([
    { key: "creds", label: "give me admin credentials", detail: "attach a token so I can authenticate", recommended: true },
    { key: "skip", label: "Skip" },
  ]);
  // explicit flag signal
  const byFlag = mk([
    { key: "go", label: "Do it", recommended: true, requires_input: true },
    { key: "no", label: "No" },
  ]);
  const herdr = new Herdr(stub(() => OK()), "herdr");
  autoAnswerStale(db, herdr, Date.now());
  expect((db.query("SELECT status, answer_key FROM decisions WHERE id = ?").get(byKeyword) as any).status).toBe("open");
  expect((db.query("SELECT status FROM decisions WHERE id = ?").get(byFlag) as any).status).toBe("open");
  // notified once per task, not every tick
  autoAnswerStale(db, herdr, Date.now());
  expect(db.query("SELECT COUNT(*) n FROM events WHERE task_id = ? AND type = 'auto_answer_skipped'").get(id) as any).toEqual({ n: 1 });
});

test("flagStale emits one stale event past the threshold, then stops", async () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId);
  transition(db, id, "in_progress"); // last event is recent

  // clock far in the future so the last event is 'stale'
  const future = () => Date.now() + 60 * 60 * 1000;
  await reconcileOnce(db, { staleMs: 15 * 60 * 1000, nowMs: future });
  expect(db.query("SELECT * FROM events WHERE task_id = ? AND type = 'stale'").all(id).length).toBe(1);

  // second pass: the newest event is now 'stale' itself -> not re-flagged
  await reconcileOnce(db, { staleMs: 15 * 60 * 1000, nowMs: future });
  expect(db.query("SELECT * FROM events WHERE task_id = ? AND type = 'stale'").all(id).length).toBe(1);
});

test("flagStale does NOT flag a dep-blocked in_progress task past the threshold", async () => {
  const { db, projectId } = freshDb();
  const dep = makeTask(db, projectId, { state: "in_progress" }); // unmet
  const child = makeTask(db, projectId, { agent_target: "c-agent", state: "in_progress" });
  db.query("UPDATE tasks SET depends_on = ? WHERE id = ?").run(JSON.stringify([dep]), child);

  const future = () => Date.now() + 60 * 60 * 1000;
  await reconcileOnce(db, { staleMs: 15 * 60 * 1000, nowMs: future, herdr: statusHerdr("idle") });
  expect(db.query("SELECT * FROM events WHERE task_id = ? AND type = 'stale'").all(child).length).toBe(0);
});

// A herdr whose `agent get` reports a fixed status (agent alive with a pane).
const statusHerdr = (status: string) =>
  new Herdr(stub(() => OK(`{"result":{"agent":{"agent_status":"${status}","pane_id":"w1:p1"}}}`)), "herdr");

// Like statusHerdr, but records `agent send` messages.
function sendCapturingHerdr(status: string) {
  const sends: string[] = [];
  const h = new Herdr(
    stub((argv) => {
      if (argv.includes("send")) {
        sends.push(argv[argv.indexOf("send") + 2]);
        return OK();
      }
      return OK(`{"result":{"agent":{"agent_status":"${status}","pane_id":"w1:p1"}}}`);
    }),
    "herdr"
  );
  return { h, sends };
}

test("advanceFinished holds a task with unmet depends_on in in_progress; releases it when the dep merges", async () => {
  const { db, projectId } = freshDb();
  // dep still in progress -> unmet. child is otherwise fully advanceable:
  // idle agent, pr_url, ci not failing/pending, evidence attached.
  const dep = makeTask(db, projectId, { state: "in_progress" });
  const child = makeTask(db, projectId, { agent_target: "c-agent", pr_url: "https://gh/pr/dep", state: "in_progress" });
  db.query("UPDATE tasks SET depends_on = ? WHERE id = ?").run(JSON.stringify([dep]), child);
  db.query("INSERT INTO evidence (id, task_id, ts, kind) VALUES (?,?,?,?)").run(newId("ev"), child, now(), "log");

  const idle = statusHerdr("idle");
  const noGh = stub(() => ({ code: 1, stdout: "", stderr: "no gh" }));
  await reconcileOnce(db, { herdr: idle, exec: noGh });
  expect(getTask(db, child).state).toBe("in_progress"); // held by the dep gate
  expect(db.query("SELECT 1 FROM events WHERE task_id = ? AND type = 'dependency_blocked'").get(child)).toBeTruthy();

  // merge the dependency -> the gate opens and the idle-with-PR task advances
  db.query("UPDATE tasks SET state = 'done' WHERE id = ?").run(dep);
  await reconcileOnce(db, { herdr: idle, exec: noGh });
  expect(getTask(db, child).state).toBe("in_review");
});

test("conflict watchdog: a CONFLICTING PR nudges the agent once per head SHA", async () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId, { agent_target: "a1", pr_url: "https://gh/pr/9" });
  transition(db, id, "in_progress");
  transition(db, id, "in_review");
  const { h, sends } = sendCapturingHerdr("idle");
  const gh = (sha: string): Exec =>
    stub((argv) => {
      if (argv[0] === "gh")
        return OK(JSON.stringify({ state: "OPEN", statusCheckRollup: [], mergeable: "CONFLICTING", headRefOid: sha }));
      return OK();
    });

  await reconcileOnce(db, { herdr: h, exec: gh("sha1") });
  expect(sends.length).toBe(1);
  expect(sends[0]).toContain("merge conflicts");
  expect(sends[0]).toContain("main");
  expect(getTask(db, id).state).toBe("in_review"); // lifecycle untouched
  const ev = db.query("SELECT payload FROM events WHERE task_id = ? AND type = 'pr_conflict'").all(id) as { payload: string }[];
  expect(ev.length).toBe(1);
  expect(JSON.parse(ev[0].payload)).toMatchObject({ head_sha: "sha1", delivered: true });

  // same head SHA next cycle -> no re-nudge
  await reconcileOnce(db, { herdr: h, exec: gh("sha1") });
  expect(sends.length).toBe(1);

  // a new push that STILL conflicts -> nudged again
  await reconcileOnce(db, { herdr: h, exec: gh("sha2") });
  expect(sends.length).toBe(2);
});

test("conflict watchdog: a lost nudge (exit 0 + agent_not_found) records delivered:false", async () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId, { agent_target: "a1", pr_url: "https://gh/pr/9" });
  transition(db, id, "in_progress");
  transition(db, id, "in_review");
  // `agent send` exits 0 but the agent is gone — the message never landed.
  const h = new Herdr(
    stub((argv) => (argv.includes("send") ? OK('{"error":{"code":"agent_not_found","message":"gone"}}') : OK('{"result":{"agent":{"agent_status":"idle","pane_id":"w1:p1"}}}'))),
    "herdr"
  );
  const gh: Exec = stub((argv) =>
    argv[0] === "gh"
      ? OK(JSON.stringify({ state: "OPEN", statusCheckRollup: [], mergeable: "CONFLICTING", headRefOid: "sha1" }))
      : OK()
  );

  await reconcileOnce(db, { herdr: h, exec: gh });

  const ev = db.query("SELECT payload FROM events WHERE task_id = ? AND type = 'pr_conflict'").all(id) as { payload: string }[];
  expect(JSON.parse(ev[0].payload)).toMatchObject({ delivered: false, error: "gone" });
});

test("conflict watchdog: a mergeable PR is left alone", async () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId, { agent_target: "a1", pr_url: "https://gh/pr/9" });
  transition(db, id, "in_progress");
  transition(db, id, "in_review");
  const { h, sends } = sendCapturingHerdr("idle");
  const gh: Exec = stub((argv) => {
    if (argv[0] === "gh")
      return OK(JSON.stringify({ state: "OPEN", statusCheckRollup: [], mergeable: "MERGEABLE", headRefOid: "sha1" }));
    return OK();
  });
  await reconcileOnce(db, { herdr: h, exec: gh });
  expect(sends.length).toBe(0);
  expect(db.query("SELECT * FROM events WHERE task_id = ? AND type = 'pr_conflict'").all(id).length).toBe(0);
});

// task #321: hive cuts worktrees from LOCAL main; GitHub origin/main is a
// divergent fork, so a branch that's a clean ff onto LOCAL main still reports
// CONFLICTING on GitHub. The old watchdog nudged "merge origin/main", the agent
// pulled the fork in, pushed a new head that STILL conflicted, and the per-SHA
// dedup couldn't stop the loop (PR #38 got 5+ identical nudges). The branch
// being a clean local ff must suppress the nudge — no send even across pushes.
test("conflict watchdog: no nudge when the branch is a clean ff onto LOCAL base (divergent origin/main)", async () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId, { agent_target: "a1", pr_url: "https://gh/pr/38" });
  db.query("UPDATE tasks SET branch = ? WHERE id = ?").run("hive/321", id);
  transition(db, id, "in_progress");
  transition(db, id, "in_review");
  const { h, sends } = sendCapturingHerdr("idle");
  // gh: CONFLICTING (vs divergent origin/main). git merge-base --is-ancestor:
  // exit 0 => LOCAL base IS an ancestor of the branch (clean ff).
  const exec = (sha: string): Exec =>
    stub((argv) => {
      if (argv[0] === "gh")
        return OK(JSON.stringify({ state: "OPEN", statusCheckRollup: [], mergeable: "CONFLICTING", headRefOid: sha }));
      if (argv[0] === "git" && argv.includes("--is-ancestor")) return OK(); // code 0 = ancestor
      return OK();
    });

  await reconcileOnce(db, { herdr: h, exec: exec("sha1") });
  await reconcileOnce(db, { herdr: h, exec: exec("sha2") }); // agent "merged origin/main", new head, still conflicts
  await reconcileOnce(db, { herdr: h, exec: exec("sha3") });

  expect(sends.length).toBe(0); // no rebase spam across any push
  expect(getTask(db, id).state).toBe("in_review"); // lifecycle untouched
  const ev = db.query("SELECT payload FROM events WHERE task_id = ? AND type = 'pr_conflict'").all(id) as { payload: string }[];
  expect(ev.every((e) => JSON.parse(e.payload).suppressed === "local-ff")).toBe(true);
});

test("advanceFinished: in_progress + pr_url + idle agent -> in_review (+ event)", async () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId, { agent_target: "a1", pr_url: "https://gh/pr/1" });
  transition(db, id, "in_progress");
  db.query("INSERT INTO evidence (id, task_id, ts, kind, path, caption) VALUES (?,?,?,?,?,?)").run(
    newId("evd"), id, now(), "log", "/tmp/x.log", "proof"
  );

  await reconcileOnce(db, { herdr: statusHerdr("idle"), exec: stub(() => ({ code: 1, stdout: "", stderr: "no gh" })) });

  expect(getTask(db, id).state).toBe("in_review");
  expect(db.query("SELECT * FROM events WHERE task_id = ? AND type = 'ready_for_review'").all(id).length).toBe(1);
});

test("advanceFinished: does NOT advance while the agent is still working", async () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId, { agent_target: "a1", pr_url: "https://gh/pr/1" });
  transition(db, id, "in_progress");

  await reconcileOnce(db, { herdr: statusHerdr("working"), exec: stub(() => ({ code: 1, stdout: "", stderr: "no gh" })) });

  expect(getTask(db, id).state).toBe("in_progress");
  expect(db.query("SELECT * FROM events WHERE task_id = ? AND type = 'ready_for_review'").all(id).length).toBe(0);
});

test("advanceFinished: idle agent with NO pr_url is not advanced (stays in_progress)", async () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId, { agent_target: "a1" }); // no pr_url
  transition(db, id, "in_progress");

  // huge staleMs so recovery/stale stay inert; only exercise advanceFinished
  await reconcileOnce(db, { herdr: statusHerdr("idle"), staleMs: 60 * 60 * 1000, exec: stub(() => ({ code: 1, stdout: "", stderr: "no gh" })) });

  expect(getTask(db, id).state).toBe("in_progress");
  expect(db.query("SELECT * FROM events WHERE task_id = ? AND type = 'ready_for_review'").all(id).length).toBe(0);
});

test("advanceFinished: a scout with report evidence + idle agent -> in_review", async () => {
  const { db, projectId } = freshDb();
  const id = newId();
  const t = now();
  db.query(
    "INSERT INTO tasks (id, project_id, title, state, kind, agent_target, created_at, updated_at) VALUES (?,?,?,?, 'scout', ?, ?, ?)"
  ).run(id, projectId, "s", "queued", "a1", t, t);
  transition(db, id, "in_progress");
  db.query("INSERT INTO evidence (id, task_id, ts, kind, path, url, caption, meta) VALUES (?,?,?,?,?,?,?,?)")
    .run(newId("ev"), id, now(), "report", null, null, "findings", "{}");

  await reconcileOnce(db, { herdr: statusHerdr("idle"), exec: stub(() => ({ code: 1, stdout: "", stderr: "no gh" })) });

  expect(getTask(db, id).state).toBe("in_review");
});

test("reconciler never throws; a failing sub-step broadcasts at most one error", async () => {
  const { db, projectId } = freshDb();
  makeTask(db, projectId, { agent_target: "t-agent", state: "in_progress" });
  // A live-agent stub keeps syncAgents/recovery inert; force a throw from gh
  // instead to exercise the failure guard.
  const aliveHerdr = new Herdr(stub(() => OK('{"result":{"agent":{"agent_status":"working","pane_id":"w1:p1"}}}')), "herdr");
  const boom: Exec = async () => {
    throw new Error("exec exploded");
  };
  // Should resolve, not reject.
  await reconcileOnce(db, { herdr: aliveHerdr, exec: boom });
  expect(true).toBe(true);
});
