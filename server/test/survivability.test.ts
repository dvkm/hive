// Restart/update survivability (#1103). Each test reproduces one way hive used
// to lose a live fleet when hive itself restarted, redeployed, or lost sight of
// herdr — never because the agents actually died.
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// attachLog writes evidence under HIVE_HOME; keep it off ~/.hive in tests.
process.env.HIVE_HOME = mkdtempSync(join(tmpdir(), "hive-surv-"));

const { openDb, newId, now, setSetting } = await import("../src/db.ts");
import type { DB } from "../src/db.ts";
const { reconcileOnce } = await import("../src/reconciler.ts");
const { reapOnce } = await import("../src/reaper.ts");
const { Herdr } = await import("../src/runtime/herdr.ts");
const { getTask } = await import("../src/state.ts");
const { teardownBlocked } = await import("../src/teardownGuard.ts");
const { computeHealth } = await import("../src/health.ts");
import type { Exec, ExecResult } from "../src/exec.ts";

const OK = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const gh: Exec = async () => ({ code: 1, stdout: "", stderr: "no gh" }); // PR sync no-op
const NOT_FOUND = OK('{"error":{"code":"agent_not_found","message":"gone"}}');
const has = (argv: string[], ...xs: string[]) => xs.every((x) => argv.includes(x));
// Large staleMs so flagStale never fires on its own; each test controls the flag.
const inert = { staleMs: 60 * 60 * 1000, exec: gh };

const WT = "/wt/hive-t1";

function freshDb(): { db: DB; projectId: string } {
  const db = openDb(":memory:");
  const projectId = newId("proj");
  db.query("INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)")
    .run(projectId, "p", "/repo", "{}", now());
  return { db, projectId };
}

function makeTask(db: DB, projectId: string, agent: string, worktree: string | null = WT): string {
  const id = newId();
  const t = now();
  db.query(
    `INSERT INTO tasks (id, project_id, title, brief, state, kind, agent_target, worktree_path, branch, created_at, updated_at)
     VALUES (?,?,?,?, 'in_progress', 'ship', ?,?,?,?,?)`
  ).run(id, projectId, "t", "do it", agent, worktree, `hive/${id}`, t, t);
  return id;
}

let seq = 0;
function putEvent(db: DB, taskId: string, type: string, payload: any = {}, atMs?: number): void {
  const ts = new Date(atMs ?? Date.now() + seq++ * 1000).toISOString();
  db.query("INSERT INTO events (id, task_id, ts, source, type, payload) VALUES (?,?,?,?,?,?)")
    .run(newId("evt"), taskId, ts, "reconciler", type, JSON.stringify(payload));
}

// A herdr whose agent registry has been WIPED — exactly what a desktop-app
// restart does: `agent get` answers agent_not_found for every target while
// `pane list` still holds every running pane. The fleet tab has TWO panes at
// the task's worktree cwd (the tab's own shell, and the agent's split), and
// with the registry gone neither carries a label to tell them apart.
function wipedRegistry(opts: { agentPaneRunsClaude?: boolean } = {}) {
  const calls: string[][] = [];
  let registered = false;
  const panes = JSON.stringify({
    result: {
      panes: [
        { pane_id: "w6:p6", tab_id: "w6:t4", workspace_id: "w6", cwd: WT, terminal_id: "term_shell" },
        { pane_id: "w6:p7", tab_id: "w6:t4", workspace_id: "w6", cwd: WT, terminal_id: "term_agent" },
      ],
    },
  });
  const procInfo = (paneId: string) => {
    const claude = { pid: 7, argv0: "claude", name: "2.1.235" };
    const shell = { pid: 7, argv0: "-zsh", name: "zsh" };
    const isAgentPane = paneId === "w6:p7" && opts.agentPaneRunsClaude !== false;
    return OK(JSON.stringify({ result: { process_info: { shell_pid: 7, foreground_processes: [isAgentPane ? claude : shell] } } }));
  };
  const exec: Exec = async (argv) => {
    calls.push(argv);
    if (has(argv, "pane", "list")) return OK(panes);
    if (has(argv, "pane", "process-info")) return procInfo(argv[argv.indexOf("--pane") + 1]);
    if (has(argv, "pane", "report-agent")) {
      registered = true;
      return OK();
    }
    if (has(argv, "agent", "get"))
      return registered
        ? OK('{"result":{"agent":{"agent_status":"working","pane_id":"w6:p7","terminal_id":"term_agent"}}}')
        : NOT_FOUND;
    return OK();
  };
  return { herdr: new Herdr(exec, "herdr"), calls };
}

test("a wiped herdr registry does NOT cost the agent its task: hive re-adopts the running pane", async () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId, "t1");
  putEvent(db, id, "spawned", { tab_id: "w6:t4", terminal_id: "term_agent" });
  const { herdr, calls } = wipedRegistry();

  await reconcileOnce(db, { ...inert, herdr });

  // The agent kept its task: nothing failed, nothing requeued, binding intact.
  const task = getTask(db, id);
  expect(task.state).toBe("in_progress");
  expect(task.agent_target).toBe("t1");
  expect(db.query("SELECT 1 FROM tasks WHERE parent_task_id = ? AND source = 'requeue'").get(id)).toBeFalsy();

  // It was re-registered, not merely left alone: `agent get t1` resolves again.
  const readopted: any = db.query("SELECT payload FROM events WHERE task_id = ? AND type = 'readopted'").get(id);
  expect(readopted).toBeTruthy();
  expect(JSON.parse(readopted.payload).pane_id).toBe("w6:p7");
  const report = calls.find((c) => has(c, "pane", "report-agent"))!;
  expect(report).toContain("w6:p7");
  expect(report).toContain("t1");
  // …and the durable name is pinned, so the binding survives Claude Code's own
  // integration re-reporting on that pane later.
  expect(calls.some((c) => has(c, "agent", "rename", "t1"))).toBe(true);
  // Status flows again on the very same cycle.
  const status: any = db.query("SELECT payload FROM events WHERE task_id = ? AND type = 'agent_status' ORDER BY ts DESC LIMIT 1").get(id);
  expect(JSON.parse(status.payload).status).toBe("working");
});

test("re-adoption never binds a steer to the tab's shell pane", async () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId, "t1");
  // No terminal_id recorded (a task spawned before #1103), so the only way in is
  // cwd — and both panes share it. Neither runs an agent command here.
  putEvent(db, id, "spawned", { tab_id: "w6:t4" });
  const { herdr, calls } = wipedRegistry({ agentPaneRunsClaude: false });

  await reconcileOnce(db, { ...inert, herdr });

  expect(calls.some((c) => has(c, "pane", "report-agent"))).toBe(false);
  expect(db.query("SELECT 1 FROM events WHERE task_id = ? AND type = 'readopted'").get(id)).toBeFalsy();
  // Still never torn down — an ambiguous pane is a reason to wait, not to reap.
  expect(getTask(db, id).state).toBe("in_progress");
});

// A herdr that reports the agent as really gone, with no pane left at its cwd.
function reallyDead() {
  const exec: Exec = async (argv) => {
    if (has(argv, "pane", "list")) return OK('{"result":{"panes":[{"pane_id":"w6:p1","tab_id":"w6:t1","workspace_id":"w6","cwd":"/Users/you"}]}}');
    if (has(argv, "agent", "get")) return NOT_FOUND;
    if (has(argv, "agent", "read")) return OK("... pane tail ...");
    return OK();
  };
  return new Herdr(exec, "herdr");
}

test("a self-deploy does not start a kill wave: no task is failed inside the boot grace", async () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId, "t1");
  putEvent(db, id, "spawned");
  setSetting(db, "server_started_at", now()); // the server just booted

  await reconcileOnce(db, { ...inert, herdr: reallyDead() });

  expect(getTask(db, id).state).toBe("in_progress");
  expect(db.query("SELECT 1 FROM events WHERE task_id = ? AND type = 'recovery'").get(id)).toBeFalsy();

  // Once the grace is behind us, the same verdict recovers normally.
  await reconcileOnce(db, { ...inert, herdr: reallyDead(), nowMs: () => Date.now() + 10 * 60_000 });
  expect(getTask(db, id).state).toBe("failed");
});

test("the reaper holds its sweep during the boot grace instead of removing worktrees", async () => {
  const { db } = freshDb();
  setSetting(db, "server_started_at", now());
  const calls: string[][] = [];
  await reapOnce(db, { exec: async (argv) => (calls.push(argv), OK()) });
  expect(calls).toEqual([]); // not even a `git worktree list`
});

test("a burst of death verdicts trips the breaker: sweeps pause and ONE card is raised", async () => {
  const { db, projectId } = freshDb();
  // Three agents already declared dead in the last few minutes…
  for (let i = 0; i < 3; i++) {
    const prior = makeTask(db, projectId, `dead${i}`, null);
    putEvent(db, prior, "recovery", { decision: "dead" });
    db.query("UPDATE tasks SET state = 'failed' WHERE id = ?").run(prior); // already recovered
  }
  const id = makeTask(db, projectId, "t1");
  putEvent(db, id, "spawned");

  await reconcileOnce(db, { ...inert, herdr: reallyDead() });

  // …so the fourth is HELD, not failed.
  expect(getTask(db, id).state).toBe("needs_decision");
  expect(db.query("SELECT 1 FROM events WHERE task_id = ? AND type = 'recovery'").get(id)).toBeFalsy();
  expect(db.query("SELECT COUNT(*) AS n FROM decisions WHERE status = 'open'").get()).toMatchObject({ n: 1 });
  expect(teardownBlocked(db)).toBe("circuit breaker open");

  // A second lap adds no second card, and the reaper stays parked.
  const other = makeTask(db, projectId, "t2");
  putEvent(db, other, "spawned");
  await reconcileOnce(db, { ...inert, herdr: reallyDead() });
  expect(db.query("SELECT COUNT(*) AS n FROM decisions WHERE status = 'open'").get()).toMatchObject({ n: 1 });
  expect(getTask(db, other).state).toBe("in_progress");
  const calls: string[][] = [];
  await reapOnce(db, { exec: async (argv) => (calls.push(argv), OK()) });
  expect(calls).toEqual([]);

  // Answering the card resumes everything.
  db.query("UPDATE decisions SET status = 'answered' WHERE status = 'open'").run();
  expect(teardownBlocked(db)).toBeNull();
});

test("closeSession refuses a recycled tab id that now holds someone else", async () => {
  const calls: string[][] = [];
  const exec: Exec = async (argv) => {
    calls.push(argv);
    if (has(argv, "pane", "list"))
      return OK('{"result":{"panes":[{"pane_id":"w6:p9","tab_id":"w6:t4","workspace_id":"w6","cwd":"/wt/hive-someone-else","terminal_id":"term_other"}]}}');
    if (has(argv, "agent", "get")) return NOT_FOUND;
    return OK();
  };
  const h = new Herdr(exec, "herdr");

  const r = await h.closeSession({ agentTarget: "t1", tabId: "w6:t4", expectTerminalId: "term_agent", expectCwd: WT });

  expect(r.closed).toBe(false);
  expect(r.refused).toContain("w6:t4");
  expect(calls.some((c) => has(c, "tab", "close"))).toBe(false);
});

test("closeSession still closes the tab when it is provably ours", async () => {
  const exec: Exec = async (argv) => {
    if (has(argv, "pane", "list"))
      return OK(`{"result":{"panes":[{"pane_id":"w6:p7","tab_id":"w6:t4","workspace_id":"w6","cwd":"${WT}","terminal_id":"term_agent"}]}}`);
    return OK();
  };
  const r = await new Herdr(exec, "herdr").closeSession({ agentTarget: "t1", tabId: "w6:t4", expectTerminalId: "term_agent", expectCwd: WT });
  expect(r).toMatchObject({ closed: true, via: "tab w6:t4" });
});

// ---------------------------------------------------------------- lost auth
// The recovery that did not recover (#1149/#1156, 2026-08-20). Both tasks went
// stale → recovery:auth-lost → health:healthy, then did it AGAIN 15 minutes
// later with a byte-identical pane tail — proof no work happened in between.
// Two separate bugs met here: the recovery event reset the health clock, and
// "recovery" for lost auth was a notification and nothing else, so the frozen
// pane was never revived.
const AUTH_TAIL = "> continue\n⎿  API Error: Not logged in. Please run /login\n\n· Worked for 12m 22s";

function authLostHerdr() {
  const calls: string[][] = [];
  const exec: Exec = async (argv) => {
    calls.push(argv);
    if (has(argv, "agent", "get")) return OK('{"result":{"agent":{"agent_status":"idle","pane_id":"w6:p7"}}}');
    if (has(argv, "agent", "read")) return OK(JSON.stringify({ result: { read: { text: AUTH_TAIL } } }));
    if (has(argv, "worktree", "create")) return { code: 1, stdout: "", stderr: "worktree busy" }; // spawn fails
    return OK();
  };
  return { herdr: new Herdr(exec, "herdr"), calls };
}

function authLostTask(db: DB, projectId: string): string {
  const id = makeTask(db, projectId, "t1");
  putEvent(db, id, "spawned");
  putEvent(db, id, "stale", { reason: "no activity" }); // what drives recoverSilent
  return id;
}

const attempts = (db: DB, id: string) =>
  (
    db
      .query(
        `SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = 'recovery'
           AND json_extract(payload, '$.decision') = 'auth-lost'
           AND json_extract(payload, '$.respawned') IS NOT NULL`
      )
      .get(id) as { n: number }
  ).n;

test("a frozen auth-lost pane never reads as healthy again", async () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId, "t1");
  // The steady state the director actually saw: an agent that last did anything
  // 40 minutes ago, already idle, already retried once (so this lap is inside
  // the respawn cooldown and writes nothing but the diagnosis).
  const long = Date.now() - 40 * 60_000;
  putEvent(db, id, "spawned", {}, long);
  putEvent(db, id, "agent_status", { status: "idle" }, long + 1000);
  putEvent(db, id, "recovery", { decision: "auth-lost", respawned: false }, Date.now() - 2 * 60_000);
  putEvent(db, id, "stale", { reason: "no activity" }, Date.now() - 60_000);
  // Already notified, so this lap attaches no fresh pane tail either — the same
  // quiet steady state the director was looking at.
  db.query("INSERT INTO notifications (id, ts, kind, title, urgency) VALUES (?,?,?,?,?)")
    .run(newId("ntf"), now(), "auth_lost", "auth", "urgent");

  await reconcileOnce(db, { ...inert, herdr: authLostHerdr().herdr });

  // The diagnosis ran and wrote its row…
  expect(attempts(db, id)).toBe(1); // still the seeded one: cooldown held
  const recoveries = db.query("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = 'recovery'").get(id);
  expect(recoveries).toMatchObject({ n: 2 });
  // …and that row must not make a frozen pane look freshly alive. This is the
  // whole bug: hive counted its OWN bookkeeping as agent activity, so the task
  // flipped back to healthy on every lap with a byte-identical pane tail.
  const health = computeHealth(db, getTask(db, id));
  expect(health?.status).not.toBe("healthy");
});

test("lost auth triggers a real respawn, rate-limited so a broken login is not a spawn storm", async () => {
  const { db, projectId } = freshDb();
  const id = authLostTask(db, projectId);

  await reconcileOnce(db, { ...inert, herdr: authLostHerdr().herdr });
  expect(attempts(db, id)).toBe(1); // notifying is not reviving — it actually tried

  // Same lap cadence, still inside the cooldown: no second attempt. (The stale
  // flag is re-armed each time so the auth-lost branch is reached every lap.)
  for (let i = 0; i < 3; i++) {
    putEvent(db, id, "stale", { reason: "no activity" });
    await reconcileOnce(db, { ...inert, herdr: authLostHerdr().herdr });
  }
  expect(attempts(db, id)).toBe(1);

  // Past the cooldown it tries again — which is also how the fleet comes back on
  // its own once the director restores the login: hive has no other signal.
  putEvent(db, id, "stale", { reason: "no activity" });
  await reconcileOnce(db, { ...inert, herdr: authLostHerdr().herdr, nowMs: () => Date.now() + 16 * 60_000 });
  expect(attempts(db, id)).toBe(2);

  // And it never requeues: a fresh task would throw away the worktree and the
  // context over a problem that has nothing to do with the work.
  expect(getTask(db, id).state).toBe("in_progress");
  expect(db.query("SELECT 1 FROM events WHERE task_id = ? AND type = 'requeued'").get(id)).toBeFalsy();
});
