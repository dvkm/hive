import { test, expect, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// spawnAgent writes a brief file under HIVE_HOME; point it at a scratch dir.
const HOME = mkdtempSync(join(tmpdir(), "hive-dispatch-"));
process.env.HIVE_HOME = HOME;

const { openDb, newId, now, getSetting } = await import("../src/db.ts");
import type { DB } from "../src/db.ts";
const { dispatchOnce, isReviewed, inBackoff } = await import("../src/dispatcher.ts");
const { selfAuditOnce } = await import("../src/selfAudit.ts");
const { writeEvent, getTask } = await import("../src/state.ts");
const { createDecision } = await import("../src/api.ts");
const { queuedSteers } = await import("../src/steer.ts");
const { createThread } = await import("../src/chat.ts");
const { Herdr } = await import("../src/runtime/herdr.ts");
import type { Exec, ExecResult } from "../src/exec.ts";

const OK = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });

// A real, writable worktree path so the spawn's hook-settings write succeeds.
const WT = mkdtempSync(join(tmpdir(), "hive-dispatch-wt-"));
const has = (argv: string[], ...xs: string[]) => xs.every((x) => argv.includes(x));

// A herdr stub for the full visible-fleet spawn (worktree + fleet workspace +
// labelled tab + agent start); records only real worktree spawns.
function stubHerdr(fail = false) {
  const spawns: string[] = [];
  const exec: Exec = async (argv) => {
    if (has(argv, "worktree", "create")) {
      if (fail) return { code: 1, stdout: "", stderr: "worktree create boom" };
      spawns.push(argv[argv.indexOf("--cwd") + 1]);
      return OK(`{"result":{"worktree":{"path":${JSON.stringify(WT)},"branch":"hive/x","open_workspace_id":"w1"}}}`);
    }
    if (has(argv, "workspace", "list")) return OK('{"result":{"workspaces":[{"workspace_id":"wF","label":"hive-fleet"}]}}');
    if (has(argv, "tab", "create")) return OK('{"result":{"tab":{"tab_id":"wF:t2"}}}');
    return OK(); // agent start / rename etc.
  };
  return { herdr: new Herdr(exec, "herdr"), spawns };
}

// herdr control socket down: worktree create fails with a ConnectionRefused body,
// the signature isHerdrUnreachable keys the global circuit breaker on.
function stubHerdrUnreachable() {
  const exec: Exec = async (argv) => {
    if (has(argv, "worktree", "create"))
      return { code: 1, stdout: "", stderr: 'Os { code: 61, kind: ConnectionRefused, message: "Connection refused" }' };
    return OK();
  };
  return { herdr: new Herdr(exec, "herdr") };
}

function freshDb(config: any = {}): { db: DB; projectId: string } {
  const db = openDb(":memory:");
  const projectId = newId("proj");
  db.query("INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)")
    .run(projectId, "p", "/repo", JSON.stringify(config), now());
  return { db, projectId };
}
function makeTask(db: DB, projectId: string, extra: Partial<{ kind: string; source: string; state: string; agent_target: string; depends_on: string[]; parent_task_id: string }> = {}): string {
  const id = newId();
  const t = now();
  db.query(
    "INSERT INTO tasks (id, project_id, title, state, kind, source, agent_target, depends_on, parent_task_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
  ).run(id, projectId, "t", extra.state ?? "queued", extra.kind ?? "ship", extra.source ?? null, extra.agent_target ?? null, extra.depends_on ? JSON.stringify(extra.depends_on) : null, extra.parent_task_id ?? null, t, t);
  return id;
}

test("dispatchOnce writes a last_dispatch_at liveness heartbeat even with nothing to do", async () => {
  const { db } = freshDb({});
  expect(getSetting(db, "last_dispatch_at")).toBeNull();
  await dispatchOnce(db, {});
  const ts = getSetting(db, "last_dispatch_at");
  expect(ts).not.toBeNull();
  expect(Date.now() - Date.parse(ts!)).toBeLessThan(5000);
});

test("auto_dispatch off: queued tasks are NOT spawned", async () => {
  const { db, projectId } = freshDb({}); // no auto_dispatch
  const id = makeTask(db, projectId);
  const { herdr, spawns } = stubHerdr();
  await dispatchOnce(db, { herdr });
  expect(spawns.length).toBe(0);
  expect(getTask(db, id).state).toBe("queued");
});

test("weekly self-audit dispatches through normal safeguards when auto_dispatch is off", async () => {
  const { db, projectId } = freshDb({});
  db.query("UPDATE projects SET name = 'Hive' WHERE id = ?").run(projectId);
  const id = selfAuditOnce(db)!;
  const { herdr, spawns } = stubHerdr();

  await dispatchOnce(db, { herdr });

  expect(spawns.length).toBe(1);
  expect(getTask(db, id).state).toBe("in_progress");

  const excluded = freshDb({ dispatch_kinds: ["scout"] });
  excluded.db.query("UPDATE projects SET name = 'Hive' WHERE id = ?").run(excluded.projectId);
  const excludedId = selfAuditOnce(excluded.db)!;
  const excludedHerdr = stubHerdr();
  await dispatchOnce(excluded.db, { herdr: excludedHerdr.herdr });
  expect(excludedHerdr.spawns.length).toBe(0);
  expect(getTask(excluded.db, excludedId).state).toBe("queued");
});

test("an active chat manager's delegated task dispatches even when project auto_dispatch is off", async () => {
  const { db, projectId } = freshDb({ max_agents: 1 });
  const managerId = makeTask(db, projectId, { source: "chat_supervisor", state: "in_progress", agent_target: "manager" });
  createThread(db, { project_id: projectId, task_id: managerId, title: "ship login" });
  const workerId = makeTask(db, projectId, { source: "agent", parent_task_id: managerId });
  const { herdr, spawns } = stubHerdr();

  await dispatchOnce(db, { herdr });

  expect(spawns.length).toBe(1);
  expect(getTask(db, workerId).state).toBe("in_progress");

  const closed = freshDb({});
  const closedManager = makeTask(closed.db, closed.projectId, { source: "chat_supervisor", state: "cancelled" });
  createThread(closed.db, { project_id: closed.projectId, task_id: closedManager, title: "closed" });
  const parked = makeTask(closed.db, closed.projectId, { source: "agent", parent_task_id: closedManager });
  const closedHerdr = stubHerdr();
  await dispatchOnce(closed.db, { herdr: closedHerdr.herdr });
  expect(closedHerdr.spawns.length).toBe(0);
  expect(getTask(closed.db, parked).state).toBe("queued");
});

test("auto_dispatch on: a queued ship task is spawned and moves to in_progress", async () => {
  const { db, projectId } = freshDb({ auto_dispatch: true });
  const id = makeTask(db, projectId);
  const { herdr, spawns } = stubHerdr();
  await dispatchOnce(db, { herdr });
  expect(spawns.length).toBe(1);
  expect(getTask(db, id).state).toBe("in_progress");
});

test("chores dispatch by default; config.dispatch_kinds can still exclude them", async () => {
  const { db, projectId } = freshDb({ auto_dispatch: true });
  const chore = makeTask(db, projectId, { kind: "chore" });
  const scout = makeTask(db, projectId, { kind: "scout" });
  const { herdr, spawns } = stubHerdr();
  await dispatchOnce(db, { herdr });
  expect(spawns.length).toBe(2);
  expect(getTask(db, chore).state).toBe("in_progress");
  expect(getTask(db, scout).state).toBe("in_progress");

  const excl = freshDb({ auto_dispatch: true, dispatch_kinds: ["ship", "scout"] });
  const excluded = makeTask(excl.db, excl.projectId, { kind: "chore" });
  const s2 = stubHerdr();
  await dispatchOnce(excl.db, { herdr: s2.herdr });
  expect(s2.spawns.length).toBe(0);
  expect(getTask(excl.db, excluded).state).toBe("queued");
});

test("a requeue bypasses dispatch_kinds exclusion (recovery of already-blessed work)", async () => {
  const { db, projectId } = freshDb({ auto_dispatch: true, dispatch_kinds: ["ship"] });
  const requeued = makeTask(db, projectId, { kind: "chore", source: "requeue" });
  const plainChore = makeTask(db, projectId, { kind: "chore" });
  const { herdr, spawns } = stubHerdr();
  await dispatchOnce(db, { herdr });
  expect(spawns.length).toBe(1); // only the requeue
  expect(getTask(db, requeued).state).toBe("in_progress");
  expect(getTask(db, plainChore).state).toBe("queued");
});

test("intake_gchat tasks are skipped until reviewed", async () => {
  const { db, projectId } = freshDb({ auto_dispatch: true });
  const id = makeTask(db, projectId, { source: "intake_gchat" });
  // the intake connector's own UNREVIEWED marker must NOT count as reviewed
  writeEvent(db, { task_id: id, source: "system", type: "note", payload: { note: "UNREVIEWED external input. Review before acting." } });
  expect(isReviewed(db, id)).toBe(false);
  const { herdr, spawns } = stubHerdr();
  await dispatchOnce(db, { herdr });
  expect(spawns.length).toBe(0);
  expect(getTask(db, id).state).toBe("queued");

  // once a reviewed note lands, it dispatches
  writeEvent(db, { task_id: id, source: "director", type: "note", payload: { note: "reviewed, looks safe" } });
  expect(isReviewed(db, id)).toBe(true);
  await dispatchOnce(db, { herdr });
  expect(spawns.length).toBe(1);
});

test("concurrency cap (max_agents) limits new spawns per project", async () => {
  const { db, projectId } = freshDb({ auto_dispatch: true, max_agents: 2 });
  // one agent already running -> 1 slot used, cap 2 -> only 1 more may spawn
  makeTask(db, projectId, { state: "in_progress", agent_target: "a0" });
  makeTask(db, projectId);
  makeTask(db, projectId);
  const { herdr, spawns } = stubHerdr();
  await dispatchOnce(db, { herdr });
  expect(spawns.length).toBe(1);
});

test("PR Gardener repair agents use their own capped lane", async () => {
  const full = freshDb({ max_agents: 1, pr_gardener: { enabled: true, max_gardener_agents: 1 } });
  makeTask(full.db, full.projectId, { state: "in_progress", agent_target: "feature" });
  const repair = makeTask(full.db, full.projectId, { source: "pr-gardener" });
  const queuedRepair = makeTask(full.db, full.projectId, { source: "pr-gardener" });
  const first = stubHerdr();

  await dispatchOnce(full.db, { herdr: first.herdr });

  expect(first.spawns.length).toBe(1);
  expect(getTask(full.db, repair).state).toBe("in_progress");
  expect(getTask(full.db, queuedRepair).state).toBe("queued");

  const feature = freshDb({ auto_dispatch: true, max_agents: 1, pr_gardener: { enabled: true } });
  makeTask(feature.db, feature.projectId, { source: "pr-gardener", state: "in_progress", agent_target: "repair" });
  const featureTask = makeTask(feature.db, feature.projectId);
  const second = stubHerdr();

  await dispatchOnce(feature.db, { herdr: second.herdr });

  expect(second.spawns.length).toBe(1);
  expect(getTask(feature.db, featureTask).state).toBe("in_progress");
});

test("PR Gardener decision placeholders never dispatch or consume an agent slot", async () => {
  const { db, projectId } = freshDb({ auto_dispatch: true, max_agents: 1, pr_gardener: { enabled: true } });
  makeTask(db, projectId, { source: "pr-gardener-decision", state: "in_progress", agent_target: "legacy" });
  const decision = makeTask(db, projectId, { kind: "chore", source: "pr-gardener-decision" });
  const feature = makeTask(db, projectId);
  const { herdr, spawns } = stubHerdr();

  await dispatchOnce(db, { herdr });

  expect(spawns.length).toBe(1);
  expect(getTask(db, decision).state).toBe("queued");
  expect(getTask(db, feature).state).toBe("in_progress");
});

test("review-parked agents don't consume working slots, but bound overhang at 2x cap", async () => {
  const { db, projectId } = freshDb({ auto_dispatch: true, max_agents: 2 });
  // two agents parked in review -> 0 working slots used -> dispatch proceeds
  makeTask(db, projectId, { state: "in_review", agent_target: "a0" });
  makeTask(db, projectId, { state: "in_review", agent_target: "a1" });
  makeTask(db, projectId);
  makeTask(db, projectId);
  makeTask(db, projectId);
  const { herdr, spawns } = stubHerdr();
  await dispatchOnce(db, { herdr });
  // working cap 2 allows 2 spawns; total active would hit 2*2=4 -> third stays queued
  expect(spawns.length).toBe(2);
});

test("a slow setup_argv on project A does not delay spawning a queued task on project B", async () => {
  const db = openDb(":memory:");
  const projA = newId("proj");
  const projB = newId("proj");
  db.query("INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)")
    .run(projA, "A", "/repoA", JSON.stringify({ auto_dispatch: true, setup_argv: ["slow.sh", "up", "{worktree}"] }), now());
  db.query("INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)")
    .run(projB, "B", "/repoB", JSON.stringify({ auto_dispatch: true }), now());
  const a = makeTask(db, projA); // created first: under the old serial loop, A's stuck setup blocked B
  const b = makeTask(db, projB);

  // A's setup_argv hook blocks until we release it; B has no setup and spawns fast.
  let releaseSetup!: () => void;
  const setupGate = new Promise<void>((res) => { releaseSetup = res; });
  let setupStartedResolve!: () => void;
  const setupStarted = new Promise<void>((res) => { setupStartedResolve = res; });

  const herdr = stubHerdr().herdr; // handles worktree/workspace/tab/agent-start
  // deps.exec runs the setup_argv hook; A's blocks until released, B has none.
  const exec: Exec = async (argv) => {
    if (argv[0].endsWith("/slow.sh")) { setupStartedResolve(); await setupGate; return OK(); }
    return OK();
  };

  const done = dispatchOnce(db, { herdr, exec });
  await setupStarted; // project A is now stuck inside its setup_argv
  // Give project B's spawn chain a chance to finish while A stays blocked.
  for (let i = 0; i < 50 && getTask(db, b).state !== "in_progress"; i++) await new Promise((r) => setTimeout(r, 0));

  expect(getTask(db, b).state).toBe("in_progress"); // B spawned despite A being stuck in setup
  expect(getTask(db, a).state).toBe("queued"); // A hasn't finished spawning yet (setup still running)

  releaseSetup();
  await done;
  expect(getTask(db, a).state).toBe("in_progress"); // A completes once its setup returns
});

test("a failing setup_argv aborts the spawn: no agent start, task stays queued, steers stay queued", async () => {
  const { db, projectId } = freshDb({ auto_dispatch: true, setup_argv: ["wt.sh", "up", "{worktree}"] });
  const id = makeTask(db, projectId);
  // A steer waiting for the agent: it must survive an aborted spawn so the
  // retry re-delivers it (the abort happens before markSteersDelivered).
  writeEvent(db, { task_id: id, source: "director", type: "steer", payload: { message: "hi", delivery: "queued" } });

  const { herdr } = stubHerdr();
  // deps.exec runs ONLY the setup_argv hook; make it fail.
  const exec: Exec = async () => ({ code: 1, stdout: "", stderr: "docker compose up: port 5432 already in use" });

  await dispatchOnce(db, { herdr, exec });

  expect(getTask(db, id).state).toBe("queued"); // not in_progress
  expect(db.query("SELECT 1 FROM events WHERE task_id = ? AND type = 'spawned'").get(id)).toBeFalsy();

  const err = db.query("SELECT payload FROM events WHERE task_id = ? AND type = 'spawn_error'").get(id) as { payload: string };
  expect(err).toBeTruthy();
  expect(JSON.parse(err.payload).error).toContain("stack setup failed");
  expect(JSON.parse(err.payload).error).toContain("port 5432 already in use");

  // the failure itself is on the record for the director...
  const setup = db.query("SELECT payload FROM events WHERE task_id = ? AND type = 'stack_setup'").get(id) as { payload: string };
  expect(JSON.parse(setup.payload).ok).toBe(false);
  // ...and the steer is still queued for the retry.
  expect(queuedSteers(db, id).length).toBe(1);
});

test("a setup_argv that times out aborts the spawn too", async () => {
  const { db, projectId } = freshDb({ auto_dispatch: true, setup_argv: ["wt.sh", "up"], stack_setup_timeout_ms: 10 });
  const id = makeTask(db, projectId);
  const { herdr } = stubHerdr();
  const exec: Exec = () => new Promise(() => {}); // hangs forever -> hits the timeout race

  await dispatchOnce(db, { herdr, exec });

  expect(getTask(db, id).state).toBe("queued");
  const err = db.query("SELECT payload FROM events WHERE task_id = ? AND type = 'spawn_error'").get(id) as { payload: string };
  expect(JSON.parse(err.payload).error).toContain("timed out");
});

test("tracking-only (source=external) tasks are never auto-dispatched", async () => {
  const { db, projectId } = freshDb({ auto_dispatch: true });
  const id = makeTask(db, projectId, { source: "external" });
  const { herdr, spawns } = stubHerdr();
  await dispatchOnce(db, { herdr });
  expect(spawns.length).toBe(0);
  expect(getTask(db, id).state).toBe("queued");
});

test("authority deny blocks auto-dispatch", async () => {
  const { db, projectId } = freshDb({ auto_dispatch: true });
  const id = makeTask(db, projectId);
  db.query("INSERT INTO authority_rules (id, project_id, scope, action_pattern, effect, active, created_at) VALUES (?,?,?,?,?,1,?)")
    .run(newId("aur"), null, "global", "task.dispatch", "deny", now());
  const { herdr, spawns } = stubHerdr();
  await dispatchOnce(db, { herdr });
  expect(spawns.length).toBe(0);
  expect(getTask(db, id).state).toBe("queued");
  expect(db.query("SELECT 1 FROM events WHERE task_id = ? AND type = 'authority_denied'").get(id)).toBeTruthy();
});

test("unmet depends_on blocks spawn (visible 'blocked by'), met deps let it through", async () => {
  const { db, projectId } = freshDb({ auto_dispatch: true });
  const dep = makeTask(db, projectId, { state: "in_progress" }); // not merged/done
  const child = makeTask(db, projectId, { depends_on: [dep] });
  const { herdr, spawns } = stubHerdr();

  await dispatchOnce(db, { herdr });
  expect(spawns.length).toBe(0);
  expect(getTask(db, child).state).toBe("queued");
  expect(db.query("SELECT 1 FROM events WHERE task_id = ? AND type = 'dependency_blocked'").get(child)).toBeTruthy();

  // re-running while still blocked does NOT write a second identical event (dedup)
  await dispatchOnce(db, { herdr });
  const blocks = db.query("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = 'dependency_blocked'").get(child) as { n: number };
  expect(blocks.n).toBe(1);

  // once the dependency reaches a merged state, the child spawns
  db.query("UPDATE tasks SET state = 'done' WHERE id = ?").run(dep);
  await dispatchOnce(db, { herdr });
  expect(spawns.length).toBe(1);
  expect(getTask(db, child).state).toBe("in_progress");
});

test("spawn failure records one spawn_error and backs off (no retry storm)", async () => {
  const { db, projectId } = freshDb({ auto_dispatch: true });
  const id = makeTask(db, projectId);
  const { herdr } = stubHerdr(true); // worktree create fails
  // spawn_error events are stamped with the real now(), so anchor the fake clock
  // to wall time and advance it to cross the backoff window.
  let t = Date.now();
  const clock = () => t;

  await dispatchOnce(db, { herdr, nowMs: clock });
  expect(getTask(db, id).state).toBe("queued");
  let errs = db.query("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = 'spawn_error'").get(id) as { n: number };
  expect(errs.n).toBe(1);

  // immediately re-running does NOT retry (still in 30s backoff)
  expect(inBackoff(db, id, t)).toBe(true);
  await dispatchOnce(db, { herdr, nowMs: clock });
  errs = db.query("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = 'spawn_error'").get(id) as { n: number };
  expect(errs.n).toBe(1); // no new error -> no retry

  // after the backoff window elapses, it retries (a second error appears)
  t += 31_000;
  expect(inBackoff(db, id, t)).toBe(false);
  await dispatchOnce(db, { herdr, nowMs: clock });
  errs = db.query("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = 'spawn_error'").get(id) as { n: number };
  expect(errs.n).toBe(2);
});

test("herdr unreachable: one probe per cycle (not per task) + global cooldown pauses dispatch", async () => {
  const { db, projectId } = freshDb({ auto_dispatch: true });
  makeTask(db, projectId);
  makeTask(db, projectId);
  makeTask(db, projectId); // 3 queued tasks, same project (serial)
  const { herdr } = stubHerdrUnreachable();
  let t = Date.now();
  const clock = () => t;

  await dispatchOnce(db, { herdr, nowMs: clock });
  // Only the FIRST task probes the dead daemon; the breaker skips the other two.
  let errs = db.query("SELECT COUNT(*) AS n FROM events WHERE type = 'spawn_error'").get() as { n: number };
  expect(errs.n).toBe(1);
  const infra = db.query("SELECT payload FROM events WHERE type = 'spawn_error'").get() as { payload: string };
  expect(JSON.parse(infra.payload).infra).toBe("herdr_unreachable");
  expect(getSetting(db, "herdr_backoff_until")).toBeTruthy();

  // Next cycle within the cooldown: dispatch is skipped entirely (no new probe),
  // but the liveness heartbeat still advances — a cooling dispatcher isn't wedged.
  t += 1000;
  await dispatchOnce(db, { herdr, nowMs: clock });
  errs = db.query("SELECT COUNT(*) AS n FROM events WHERE type = 'spawn_error'").get() as { n: number };
  expect(errs.n).toBe(1); // still just the one probe
  expect(getSetting(db, "last_dispatch_at")).toBeTruthy();

  // After the cooldown elapses, it probes again (streak grows -> longer cooldown).
  t += 31_000;
  await dispatchOnce(db, { herdr, nowMs: clock });
  errs = db.query("SELECT COUNT(*) AS n FROM events WHERE type = 'spawn_error'").get() as { n: number };
  expect(errs.n).toBe(2);
});

test("herdr recovers: a successful spawn clears the outage cooldown/streak", async () => {
  const { db, projectId } = freshDb({ auto_dispatch: true });
  makeTask(db, projectId);
  const t = Date.now();
  const clock = () => t;

  await dispatchOnce(db, { herdr: stubHerdrUnreachable().herdr, nowMs: clock });
  expect(getSetting(db, "herdr_backoff_until")).toBeTruthy();

  // Cooldown passes, daemon is back: the spawn succeeds and clears the outage.
  await dispatchOnce(db, { herdr: stubHerdr().herdr, nowMs: () => t + 31_000 });
  expect(getSetting(db, "herdr_backoff_until")).toBeFalsy();
  expect(getSetting(db, "herdr_outage_streak")).toBe("0");
});

test("inBackoff ignores infra-tagged (herdr-down) spawn_errors", async () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId);
  const t = Date.now();

  // An infra failure alone does NOT put the task in backoff (not its fault).
  writeEvent(db, { task_id: id, source: "herdr", type: "spawn_error", payload: { error: "ConnectionRefused", infra: "herdr_unreachable" } });
  expect(inBackoff(db, id, t)).toBe(false);

  // A genuine (untagged) failure still does.
  writeEvent(db, { task_id: id, source: "herdr", type: "spawn_error", payload: { error: "bad base ref" } });
  expect(inBackoff(db, id, t)).toBe(true);
});

// #989: a task whose brief edits another project's files must not reach a
// worktree it cannot do the work in. The open card is the hold.
test("an unanswered repo-mismatch card holds dispatch; answering it releases the task", async () => {
  const { db, projectId } = freshDb({ auto_dispatch: true });
  const id = makeTask(db, projectId);
  const decision = createDecision(db, {
    task_id: id,
    title: "Wrong target repo?",
    context: "brief edits another project's files",
    options: [{ key: "keep", label: "Keep" }, { key: "cancel", label: "Cancel" }],
  });
  writeEvent(db, {
    task_id: id,
    source: "system",
    type: "repo_mismatch",
    payload: { decision_id: decision.id, note: "held", paths: ["server/src/intake/jira.ts"] },
  });

  const held = stubHerdr();
  await dispatchOnce(db, { herdr: held.herdr });
  expect(held.spawns.length).toBe(0);
  expect(getTask(db, id).state).toBe("queued");

  db.query("UPDATE decisions SET status = 'answered', answer_key = 'keep' WHERE id = ?").run(decision.id);
  const released = stubHerdr();
  await dispatchOnce(db, { herdr: released.herdr });
  expect(released.spawns.length).toBe(1);
  expect(getTask(db, id).state).toBe("in_progress");
});
