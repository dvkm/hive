import { test, expect, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// attachLog writes evidence under HIVE_HOME; keep it off ~/.hive in tests.
const HOME = mkdtempSync(join(tmpdir(), "hive-recovery-"));
process.env.HIVE_HOME = HOME;

const { openDb, newId, now } = await import("../src/db.ts");
import type { DB } from "../src/db.ts";
const { reconcileOnce } = await import("../src/reconciler.ts");
const { requeueTask } = await import("../src/api.ts");
const { Herdr } = await import("../src/runtime/herdr.ts");
const { getTask } = await import("../src/state.ts");
import type { Exec, ExecResult } from "../src/exec.ts";

const OK = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const gh: Exec = async () => ({ code: 1, stdout: "", stderr: "no gh" }); // PR sync no-op

// `pane list` answers. A dead verdict now needs POSITIVE evidence: the task's
// own pane really is gone from herdr. `panes(cwd)` puts a pane back at that cwd,
// which is what a live-but-unregistered agent looks like (herdr's agent registry
// is wiped by a desktop-app restart while the panes keep running).
const NO_TASK_PANE = OK('{"result":{"panes":[{"pane_id":"w6:p1","tab_id":"w6:t1","workspace_id":"w6","cwd":"/Users/you"}]}}');
const panes = (cwd: string) =>
  OK(`{"result":{"panes":[{"pane_id":"w6:p9","tab_id":"w6:t9","workspace_id":"w6","cwd":"${cwd}"}]}}`);
const isPaneList = (argv: string[]) => argv.includes("pane") && argv.includes("list");

// A herdr whose `agent get` verdict (dead|alive) is configurable; records sends.
// `sendLost` reproduces the herdr quirk where `agent send` to a vanished agent
// exits 0 with an agent_not_found body — the message never landed.
function herdrProbe(verdict: "dead" | "alive", status = "idle", sendLost = false) {
  const sends: { target: string; message: string }[] = [];
  const exec: Exec = async (argv) => {
    if (isPaneList(argv)) return NO_TASK_PANE;
    if (argv.includes("get")) {
      return verdict === "dead"
        ? OK('{"error":{"code":"agent_not_found","message":"gone"}}')
        : OK(`{"result":{"agent":{"agent_status":"${status}","pane_id":"w6:p9"}}}`);
    }
    if (argv.includes("read")) return OK("... last 200 lines of the dead pane ...");
    if (argv.includes("send")) {
      sends.push({ target: argv[argv.indexOf("send") + 1], message: argv[argv.indexOf("send") + 2] });
      return sendLost ? OK('{"error":{"code":"agent_not_found","message":"gone"}}') : OK();
    }
    return OK();
  };
  return { herdr: new Herdr(exec, "herdr"), sends };
}

function freshDb(): { db: DB; projectId: string } {
  const db = openDb(":memory:");
  const projectId = newId("proj");
  db.query("INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)")
    .run(projectId, "p", "/repo", "{}", now());
  return { db, projectId };
}
function makeTask(db: DB, projectId: string, extra: Partial<{ source: string; parent: string; agent: string }> = {}): string {
  const id = newId();
  const t = now();
  db.query(
    "INSERT INTO tasks (id, project_id, title, brief, state, kind, source, parent_task_id, agent_target, created_at, updated_at) VALUES (?,?,?,?, 'in_progress', 'ship', ?, ?, ?, ?, ?)"
  ).run(id, projectId, "t", "do it", extra.source ?? null, extra.parent ?? null, extra.agent ?? "a" + id.slice(0, 4), t, t);
  // Mirror requeueTask()'s own creation event so a synthetic 'requeue' row here
  // reads as trusted provenance (state.ts: verifyRequeueProvenance), same as a
  // real requeue chain would.
  if (extra.source === "requeue" && extra.parent)
    db.query("INSERT INTO events (id, task_id, ts, source, type, payload) VALUES (?,?,?,?,?,?)")
      .run(newId("evt"), id, t, "reconciler", "created", JSON.stringify({ title: "t", requeue_of: extra.parent }));
  return id;
}
// Insert an event with an explicit, ordered ts so DESC ordering is deterministic.
let seq = 0;
function putEvent(db: DB, taskId: string, type: string, payload: any = {}): void {
  const ts = new Date(Date.now() + seq++ * 1000).toISOString();
  db.query("INSERT INTO events (id, task_id, ts, source, type, payload) VALUES (?,?,?,?,?,?)")
    .run(newId("evt"), taskId, ts, "reconciler", type, JSON.stringify(payload));
}

// Large staleMs so flagStale never fires on its own; we control the stale flag.
const inert = { staleMs: 60 * 60 * 1000, nowMs: () => Date.now(), exec: gh };

test("dead agent → capture pane tail, fail, auto-requeue (attempt 1)", async () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId, { agent: "a1" });
  putEvent(db, id, "spawned");
  const { herdr } = herdrProbe("dead");

  await reconcileOnce(db, { ...inert, herdr });

  const task = getTask(db, id);
  expect(task.state).toBe("failed");
  // pane tail captured as log evidence
  const ev = db.query("SELECT * FROM evidence WHERE task_id = ? AND kind = 'log'").all(id);
  expect(ev.length).toBe(1);
  // a fresh queued requeue task, linked back to the original
  const requeue: any = db.query("SELECT * FROM tasks WHERE source = 'requeue' AND parent_task_id = ?").get(id);
  expect(requeue).toBeTruthy();
  expect(requeue.state).toBe("queued");
  const requeued: any = db.query("SELECT payload FROM events WHERE task_id = ? AND type = 'requeued'").get(id);
  expect(JSON.parse(requeued.payload).attempt).toBe(1);
});

// hive-1090: a requeue used to copy only the original brief, dropping the
// failed attempt's branch/PR — a fresh agent, blind to that, could rebuild the
// whole feature as a second conflicting PR (the exact incident this closes:
// task #1123 died with PR 819 open, its auto-requeue opened PR 825 instead of
// adopting it). requeueTask now prepends a RESUME section and records the
// pointer structurally on the new row.
test("dead agent with an open PR → requeue's brief leads with the adopt-this-PR pointer, and the original keeps its pr_url (never orphaned/cleared)", async () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId, { agent: "a1" });
  const branch = `hive/${id}`;
  const prUrl = "https://github.com/acme/web/pull/819";
  const headSha = "abc819";
  db.query("UPDATE tasks SET branch = ?, worktree_path = ?, pr_url = ?, head_sha = ? WHERE id = ?").run(branch, `/tmp/wt-${id}`, prUrl, headSha, id);
  putEvent(db, id, "spawned");
  const { herdr } = herdrProbe("dead");

  await reconcileOnce(db, { ...inert, herdr });

  const requeue: any = db.query("SELECT * FROM tasks WHERE source = 'requeue' AND parent_task_id = ?").get(id);
  expect(requeue).toBeTruthy();
  expect(requeue.resume_branch).toBe(branch);
  expect(requeue.resume_pr_url).toBe(prUrl);
  expect(requeue.brief.startsWith("<!-- hive:resume -->\n**RESUME")).toBe(true); // leads the brief, not buried
  expect(requeue.brief).toContain(prUrl);
  expect(requeue.brief).toContain(branch);
  expect(requeue.brief).toContain(`- Branch to merge in: \`${branch}\`\n`);
  expect(requeue.brief).toContain(`- Open PR: ${prUrl} (last known head \`${headSha}\`)`);
  expect(requeue.brief.toLowerCase()).toContain("do not rebuild");

  // the failed predecessor's own pr_url is never cleared/orphaned by the
  // recovery it just went through — it's the thing the requeue points back at.
  expect(getTask(db, id).pr_url).toBe(prUrl);
});

test("requeue of a task whose PR already closed adopts the branch but drops the (stale) PR pointer", async () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId, { agent: "a1" });
  const branch = `hive/${id}`;
  const prUrl = "https://github.com/acme/web/pull/819";
  const headSha = "abc819";
  db.query("UPDATE tasks SET branch = ?, worktree_path = ?, pr_url = ?, head_sha = ? WHERE id = ?").run(branch, `/tmp/wt-${id}`, prUrl, headSha, id);
  putEvent(db, id, "spawned");
  putEvent(db, id, "pr_closed", { pr_url: prUrl }); // reconciler already saw it closed
  const { herdr } = herdrProbe("dead");

  await reconcileOnce(db, { ...inert, herdr });

  const requeue: any = db.query("SELECT * FROM tasks WHERE source = 'requeue' AND parent_task_id = ?").get(id);
  expect(requeue.resume_branch).toBe(branch);
  expect(requeue.resume_pr_url).toBeNull();
  expect(requeue.brief).not.toContain(prUrl);
  expect(requeue.brief).not.toContain(headSha);
});

test("a historical PR closure does not hide an open replacement PR", async () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId, { agent: "a1" });
  const branch = `hive/${id}`;
  const closedPrUrl = "https://github.com/acme/web/pull/819";
  const replacementPrUrl = "https://github.com/acme/web/pull/825";
  db.query("UPDATE tasks SET branch = ?, pr_url = ? WHERE id = ?").run(branch, closedPrUrl, id);
  putEvent(db, id, "pr_closed", { pr_url: closedPrUrl });
  db.query("UPDATE tasks SET pr_url = ? WHERE id = ?").run(replacementPrUrl, id);
  putEvent(db, id, "spawned");
  const { herdr } = herdrProbe("dead");

  await reconcileOnce(db, { ...inert, herdr });

  const requeue: any = db.query("SELECT * FROM tasks WHERE source = 'requeue' AND parent_task_id = ?").get(id);
  expect(requeue.resume_pr_url).toBe(replacementPrUrl);
  expect(requeue.brief).toContain(replacementPrUrl);
  expect(requeue.brief).not.toContain(closedPrUrl);
});

test("requeueTask refreshes a stale source snapshot before creating the successor", () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId);
  const staleBranch = `hive/stale-${id}`;
  const currentBranch = `hive/current-${id}`;
  const stalePr = "https://github.com/acme/web/pull/100";
  const currentPr = "https://github.com/acme/web/pull/200";
  db.query("UPDATE tasks SET state = 'failed', agent_target = NULL, branch = ?, pr_url = ?, brief = ? WHERE id = ?")
    .run(staleBranch, stalePr, "stale brief", id);
  const stale = { ...getTask(db, id) };
  db.query("UPDATE tasks SET branch = ?, pr_url = ?, brief = ? WHERE id = ?")
    .run(currentBranch, currentPr, "current brief", id);

  const successorId = requeueTask(db, stale);
  const successor = getTask(db, successorId);

  expect(successor.parent_task_id).toBe(id);
  expect(successor.resume_branch).toBe(currentBranch);
  expect(successor.resume_pr_url).toBe(currentPr);
  expect(successor.brief).toContain("current brief");
  expect(successor.brief).toContain(currentPr);
  expect(successor.brief).not.toContain("stale brief");
  expect(successor.brief).not.toContain(stalePr);
});

test("a second requeue preserves resume pointers inherited from the original attempt", async () => {
  const { db, projectId } = freshDb();
  const original = makeTask(db, projectId);
  const branch = `hive/${original}`;
  const ghostBranch = `ghost-${original}`;
  const prUrl = "https://github.com/acme/web/pull/819";
  db.query("UPDATE tasks SET state = 'failed', agent_target = NULL, branch = ?, pr_url = ? WHERE id = ?")
    .run(branch, prUrl, original);

  const firstRequeue = makeTask(db, projectId, { source: "requeue", parent: original, agent: "a2" });
  db.query("UPDATE tasks SET resume_branch = ?, resume_ghost_branch = ?, resume_pr_url = ? WHERE id = ?")
    .run(branch, ghostBranch, prUrl, firstRequeue);
  putEvent(db, firstRequeue, "spawned");
  const { herdr } = herdrProbe("dead");

  await reconcileOnce(db, { ...inert, herdr });

  const secondRequeue: any = db.query("SELECT * FROM tasks WHERE source = 'requeue' AND parent_task_id = ?").get(firstRequeue);
  expect(secondRequeue).toBeTruthy();
  expect(secondRequeue.resume_branch).toBe(branch);
  expect(secondRequeue.resume_ghost_branch).toBe(ghostBranch);
  expect(secondRequeue.resume_pr_url).toBe(prUrl);
  expect(secondRequeue.brief).toContain(branch);
  expect(secondRequeue.brief).toContain(ghostBranch);
  expect(secondRequeue.brief).toContain(prUrl);
  expect(secondRequeue.brief).toContain("An earlier attempt also had uncommitted WIP separately rescued");
});

test("a spawned requeue surfaces its own and inherited branches", async () => {
  const { db, projectId } = freshDb();
  const original = makeTask(db, projectId);
  const inheritedBranch = `hive/${original}`;
  const inheritedPrUrl = "https://github.com/acme/web/pull/819";
  db.query("UPDATE tasks SET state = 'failed', agent_target = NULL, branch = ?, pr_url = ? WHERE id = ?")
    .run(inheritedBranch, inheritedPrUrl, original);

  const firstRequeue = makeTask(db, projectId, { source: "requeue", parent: original, agent: "a2" });
  const spawnedBranch = `hive/${firstRequeue}`;
  db.query("UPDATE tasks SET branch = ?, resume_branch = ?, resume_pr_url = ? WHERE id = ?")
    .run(spawnedBranch, inheritedBranch, inheritedPrUrl, firstRequeue);
  putEvent(db, firstRequeue, "spawned");
  const { herdr } = herdrProbe("dead");

  await reconcileOnce(db, { ...inert, herdr });

  const secondRequeue: any = db.query("SELECT * FROM tasks WHERE source = 'requeue' AND parent_task_id = ?").get(firstRequeue);
  expect(secondRequeue.resume_branch).toBe(spawnedBranch);
  expect(secondRequeue.resume_pr_url).toBe(inheritedPrUrl);
  expect(secondRequeue.brief).toContain(spawnedBranch);
  expect(secondRequeue.brief).toContain(inheritedBranch);
});

test("a copied inherited PR remains independent from branch selection", async () => {
  const { db, projectId } = freshDb();
  const original = makeTask(db, projectId);
  const inheritedBranch = `hive/${original}`;
  const inheritedPrUrl = "https://github.com/acme/web/pull/819";
  db.query("UPDATE tasks SET state = 'failed', agent_target = NULL, branch = ?, pr_url = ? WHERE id = ?")
    .run(inheritedBranch, inheritedPrUrl, original);

  const firstRequeue = makeTask(db, projectId, { source: "requeue", parent: original, agent: "a2" });
  const spawnedBranch = `hive/${firstRequeue}`;
  db.query("UPDATE tasks SET branch = ?, pr_url = ?, resume_branch = ?, resume_pr_url = ? WHERE id = ?")
    .run(spawnedBranch, inheritedPrUrl, inheritedBranch, inheritedPrUrl, firstRequeue);
  putEvent(db, firstRequeue, "spawned");
  const { herdr } = herdrProbe("dead");

  await reconcileOnce(db, { ...inert, herdr });

  const secondRequeue: any = db.query("SELECT * FROM tasks WHERE source = 'requeue' AND parent_task_id = ?").get(firstRequeue);
  expect(secondRequeue.resume_branch).toBe(spawnedBranch);
  expect(secondRequeue.resume_pr_url).toBe(inheritedPrUrl);
  expect(secondRequeue.brief).toContain(spawnedBranch);
  expect(secondRequeue.brief).toContain(inheritedBranch);
});

test("a spawned requeue keeps its own PR while surfacing its inherited branch", async () => {
  const { db, projectId } = freshDb();
  const original = makeTask(db, projectId);
  const inheritedBranch = `hive/${original}`;
  const inheritedPrUrl = "https://github.com/acme/web/pull/819";
  db.query("UPDATE tasks SET state = 'failed', agent_target = NULL, branch = ?, pr_url = ? WHERE id = ?")
    .run(inheritedBranch, inheritedPrUrl, original);

  const firstRequeue = makeTask(db, projectId, { source: "requeue", parent: original, agent: "a2" });
  const ownBranch = `hive/${firstRequeue}`;
  const ownPrUrl = "https://github.com/acme/web/pull/825";
  db.query("UPDATE tasks SET branch = ?, pr_url = ?, resume_branch = ?, resume_pr_url = ? WHERE id = ?")
    .run(ownBranch, ownPrUrl, inheritedBranch, inheritedPrUrl, firstRequeue);
  putEvent(db, firstRequeue, "spawned");
  const { herdr } = herdrProbe("dead");

  await reconcileOnce(db, { ...inert, herdr });

  const secondRequeue: any = db.query("SELECT * FROM tasks WHERE source = 'requeue' AND parent_task_id = ?").get(firstRequeue);
  expect(secondRequeue.resume_branch).toBe(ownBranch);
  expect(secondRequeue.resume_pr_url).toBe(ownPrUrl);
  expect(secondRequeue.brief).toContain(ownBranch);
  expect(secondRequeue.brief).toContain(inheritedBranch);
});

test("a closed own PR falls back to a still-open inherited PR", async () => {
  const { db, projectId } = freshDb();
  const original = makeTask(db, projectId);
  const inheritedBranch = `hive/${original}`;
  const inheritedPrUrl = "https://github.com/acme/web/pull/819";
  db.query("UPDATE tasks SET state = 'failed', agent_target = NULL, branch = ?, pr_url = ? WHERE id = ?")
    .run(inheritedBranch, inheritedPrUrl, original);

  const firstRequeue = makeTask(db, projectId, { source: "requeue", parent: original, agent: "a2" });
  const ownBranch = `hive/${firstRequeue}`;
  const closedOwnPrUrl = "https://github.com/acme/web/pull/825";
  db.query("UPDATE tasks SET branch = ?, pr_url = ?, resume_branch = ?, resume_pr_url = ?, head_sha = ?, ci_status = ? WHERE id = ?")
    .run(ownBranch, closedOwnPrUrl, inheritedBranch, inheritedPrUrl, "closed-own-head", "failing", firstRequeue);
  putEvent(db, firstRequeue, "pr_closed", { pr_url: closedOwnPrUrl });
  putEvent(db, firstRequeue, "spawned");
  const { herdr } = herdrProbe("dead");

  await reconcileOnce(db, { ...inert, herdr });

  const secondRequeue: any = db.query("SELECT * FROM tasks WHERE source = 'requeue' AND parent_task_id = ?").get(firstRequeue);
  expect(secondRequeue.resume_pr_url).toBe(inheritedPrUrl);
  expect(secondRequeue.brief).toContain(inheritedPrUrl);
  expect(secondRequeue.brief).not.toContain(closedOwnPrUrl);
  expect(secondRequeue.brief).not.toContain("closed-own-head");
  expect(secondRequeue.brief).not.toContain("Last known CI status");
});

test("a merged own PR does not resurrect an inherited PR", async () => {
  const { db, projectId } = freshDb();
  const original = makeTask(db, projectId);
  const inheritedBranch = `hive/${original}`;
  const inheritedPrUrl = "https://github.com/acme/web/pull/819";
  db.query("UPDATE tasks SET state = 'failed', agent_target = NULL, branch = ?, pr_url = ? WHERE id = ?")
    .run(inheritedBranch, inheritedPrUrl, original);

  const firstRequeue = makeTask(db, projectId, { source: "requeue", parent: original, agent: "a2" });
  const ownBranch = `hive/${firstRequeue}`;
  const mergedOwnPrUrl = "https://github.com/acme/web/pull/825";
  db.query("UPDATE tasks SET branch = ?, pr_url = ?, resume_branch = ?, resume_pr_url = ? WHERE id = ?")
    .run(ownBranch, mergedOwnPrUrl, inheritedBranch, inheritedPrUrl, firstRequeue);
  putEvent(db, firstRequeue, "pr_merged", { pr_url: mergedOwnPrUrl });
  putEvent(db, firstRequeue, "spawned");
  const { herdr } = herdrProbe("dead");

  await reconcileOnce(db, { ...inert, herdr });

  const secondRequeue: any = db.query("SELECT * FROM tasks WHERE source = 'requeue' AND parent_task_id = ?").get(firstRequeue);
  expect(secondRequeue.resume_pr_url).toBeNull();
  expect(secondRequeue.brief).not.toContain(mergedOwnPrUrl);
  expect(secondRequeue.brief).not.toContain(inheritedPrUrl);
});

test("a requeue with its own ghost also preserves inherited branch and ghost pointers", async () => {
  const { db, projectId } = freshDb();
  const original = makeTask(db, projectId);
  const inheritedBranch = `hive/${original}`;
  const inheritedGhost = `ghost-${original}`;
  db.query("UPDATE tasks SET state = 'failed', agent_target = NULL, branch = ? WHERE id = ?")
    .run(inheritedBranch, original);

  const firstRequeue = makeTask(db, projectId, { source: "requeue", parent: original, agent: "a2" });
  const ownBranch = `hive/${firstRequeue}`;
  const ownGhost = `ghost-${firstRequeue}`;
  db.query("UPDATE tasks SET branch = ?, resume_branch = ?, resume_ghost_branch = ? WHERE id = ?")
    .run(ownBranch, inheritedBranch, inheritedGhost, firstRequeue);
  putEvent(db, firstRequeue, "worktree_reclaimed", { ghost_branch: ownGhost });
  putEvent(db, firstRequeue, "spawned");
  const { herdr } = herdrProbe("dead");

  await reconcileOnce(db, { ...inert, herdr });

  const secondRequeue: any = db.query("SELECT * FROM tasks WHERE source = 'requeue' AND parent_task_id = ?").get(firstRequeue);
  expect(secondRequeue.resume_branch).toBe(ownBranch);
  expect(secondRequeue.resume_ghost_branch).toBe(ownGhost);
  expect(secondRequeue.brief).toContain(ownBranch);
  expect(secondRequeue.brief).toContain(ownGhost);
  expect(secondRequeue.brief).toContain(inheritedBranch);
  expect(secondRequeue.brief).toContain(inheritedGhost);
});

test("a second requeue drops an inherited PR pointer closed on the original attempt", async () => {
  const { db, projectId } = freshDb();
  const original = makeTask(db, projectId);
  const branch = `hive/${original}`;
  const prUrl = "https://github.com/acme/web/pull/819";
  db.query("UPDATE tasks SET state = 'failed', agent_target = NULL, branch = ?, pr_url = ? WHERE id = ?")
    .run(branch, prUrl, original);
  putEvent(db, original, "pr_closed", { pr_url: prUrl });

  const firstRequeue = makeTask(db, projectId, { source: "requeue", parent: original, agent: "a2" });
  db.query("UPDATE tasks SET pr_url = ?, resume_branch = ?, resume_pr_url = ? WHERE id = ?")
    .run(prUrl, branch, prUrl, firstRequeue);
  putEvent(db, firstRequeue, "spawned");
  const { herdr } = herdrProbe("dead");

  await reconcileOnce(db, { ...inert, herdr });

  const secondRequeue: any = db.query("SELECT * FROM tasks WHERE source = 'requeue' AND parent_task_id = ?").get(firstRequeue);
  expect(secondRequeue.resume_branch).toBe(branch);
  expect(secondRequeue.resume_pr_url).toBeNull();
  expect(secondRequeue.brief).not.toContain(prUrl);
});

test("a second requeue strips a prior RESUME block that references a closed PR", async () => {
  const { db, projectId } = freshDb();
  const original = makeTask(db, projectId);
  const branch = `hive/${original}`;
  const closedPrUrl = "https://github.com/acme/web/pull/819";
  db.query("UPDATE tasks SET state = 'failed', agent_target = NULL, branch = ?, pr_url = ? WHERE id = ?")
    .run(branch, closedPrUrl, original);
  putEvent(db, original, "pr_closed", { pr_url: closedPrUrl });

  const firstRequeue = makeTask(db, projectId, { source: "requeue", parent: original, agent: "a2" });
  const brief = `Director note before resume.\n<!-- hive:resume -->\n**RESUME — adopt PR ${closedPrUrl} / branch \`${branch}\`.**\n<!-- /hive:resume -->\nImplement the original request.`;
  db.query("UPDATE tasks SET brief = ?, branch = ?, resume_branch = ?, resume_pr_url = ? WHERE id = ?")
    .run(brief, `hive/${firstRequeue}`, branch, closedPrUrl, firstRequeue);
  putEvent(db, firstRequeue, "spawned");
  const { herdr } = herdrProbe("dead");

  await reconcileOnce(db, { ...inert, herdr });

  const secondRequeue: any = db.query("SELECT * FROM tasks WHERE source = 'requeue' AND parent_task_id = ?").get(firstRequeue);
  expect(secondRequeue.resume_pr_url).toBeNull();
  expect(secondRequeue.brief).not.toContain(closedPrUrl);
  expect(secondRequeue.brief).toContain("Director note before resume.");
  expect(secondRequeue.brief).toContain("Implement the original request.");
});

test("requeue context includes answer notes, answerer identity, and section-only self-reviews", async () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId, { agent: "a1" });
  const branch = `hive/${id}`;
  db.query("UPDATE tasks SET branch = ? WHERE id = ?").run(branch, id);
  const answeredAt = now();
  db.query(
    `INSERT INTO decisions (id, task_id, ts, title, options, status, answer_key, answer_note, answered_at, answered_by)
     VALUES (?,?,?,?,?, 'answered', ?,?,?,?)`
  ).run(
    newId("dec"), id, answeredAt, "Which rollout?",
    JSON.stringify([{ key: "staged", label: "Use staged rollout" }]),
    "staged", "Keep the beta cohort isolated", answeredAt, "chat_supervisor"
  );
  putEvent(db, id, "review_summary", { testing: ["focused tests passed"], followups: ["watch rollout"] });
  putEvent(db, id, "spawned");
  const { herdr } = herdrProbe("dead");

  await reconcileOnce(db, { ...inert, herdr });

  const requeue: any = db.query("SELECT * FROM tasks WHERE source = 'requeue' AND parent_task_id = ?").get(id);
  expect(requeue.brief).toContain("Which rollout? — Use staged rollout; note: Keep the beta cohort isolated");
  expect(requeue.brief).toContain("[answered by chat_supervisor, not director]");
  expect(requeue.brief).toContain("testing, followups section(s) included");
});

test("a source=external task with agent_target set (regression guard: should be unreachable post-#996) is still recovered sanely, not stuck forever", async () => {
  // supervision.ts's neverDispatched, plus the createTask/spawnAgent guards in
  // api.ts, should make this state unreachable going forward — this guards the
  // regression the reverted #996 attempt's landmine warned about: recoverStale
  // must NOT special-case 'external' the way it does 'chat_supervisor' below,
  // or a ghost external task with a dead target it can never dispatch to would
  // sit in_progress forever instead of failing/requeuing like anything else.
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId, { source: "external", agent: "t-ghost" });
  putEvent(db, id, "spawned");
  const { herdr } = herdrProbe("dead");

  await reconcileOnce(db, { ...inert, herdr });

  expect(getTask(db, id).state).toBe("failed"); // recovered within one cycle, unlike chat_supervisor
  const requeue: any = db.query("SELECT * FROM tasks WHERE source = 'requeue' AND parent_task_id = ?").get(id);
  expect(requeue).toBeTruthy();
  expect(requeue.state).toBe("queued");
});

test("an idle or vanished chat supervisor is not failed by worker stale recovery", async () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId, { source: "chat_supervisor", agent: "manager" });
  putEvent(db, id, "spawned");
  const { herdr } = herdrProbe("dead");

  await reconcileOnce(db, { ...inert, herdr });

  expect(getTask(db, id).state).toBe("in_progress");
  expect(db.query("SELECT 1 FROM tasks WHERE parent_task_id = ? AND source = 'requeue'").get(id)).toBeFalsy();
  expect(db.query("SELECT 1 FROM events WHERE task_id = ? AND type = 'recovery'").get(id)).toBeFalsy();
});

test("requeue cap reached → decision card, no further auto-requeue", async () => {
  const { db, projectId } = freshDb();
  const orig = makeTask(db, projectId); // source null
  const req1 = makeTask(db, projectId, { source: "requeue", parent: orig });
  const req2 = makeTask(db, projectId, { source: "requeue", parent: req1, agent: "a2" }); // depth 2
  putEvent(db, req2, "spawned");
  const { herdr } = herdrProbe("dead");

  await reconcileOnce(db, { ...inert, herdr });

  expect(getTask(db, req2).state).toBe("failed");
  // a recovery decision card was opened on the failed task
  const card = db.query("SELECT * FROM events WHERE task_id = ? AND type = 'recovery_card'").all(req2);
  expect(card.length).toBe(1);
  const dec: any = db.query("SELECT * FROM decisions WHERE task_id = ? AND status = 'open'").get(req2);
  expect(dec).toBeTruthy();
  // NO third auto-requeue task was created (children of req2)
  const grand = db.query("SELECT 1 FROM tasks WHERE parent_task_id = ? AND source = 'requeue'").all(req2);
  expect(grand.length).toBe(0);
});

test("alive but silent → status nudge via herdr agent send", async () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId, { agent: "a3" });
  putEvent(db, id, "status", { note: "working" });
  putEvent(db, id, "stale", { silent_ms: 999 }); // latest meaningful event = stale
  const { herdr, sends } = herdrProbe("alive", "idle");

  await reconcileOnce(db, { ...inert, herdr });

  expect(sends.length).toBe(1);
  expect(sends[0].target).toBe("a3");
  const nudge: any = db.query("SELECT payload FROM events WHERE task_id = ? AND type = 'recovery_nudge'").get(id);
  expect(JSON.parse(nudge.payload).nudge).toBe(1);
  expect(getTask(db, id).state).toBe("in_progress"); // not failed yet
});

test("a lost nudge (exit 0 + agent_not_found) records delivered:false and doesn't count", async () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId, { agent: "a3b" });
  putEvent(db, id, "status", { note: "working" });
  putEvent(db, id, "stale", { silent_ms: 999 });
  const { herdr } = herdrProbe("alive", "idle", true);

  await reconcileOnce(db, { ...inert, herdr });

  const nudge: any = db.query("SELECT payload FROM events WHERE task_id = ? AND type = 'recovery_nudge'").get(id);
  expect(JSON.parse(nudge.payload)).toMatchObject({ nudge: 1, delivered: false, error: "gone" });
});

test("undelivered nudges never trip the cap: three lost nudges still nudge, never fail", async () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId, { agent: "a4b" });
  putEvent(db, id, "status", { note: "working" });
  for (const n of [1, 2, 3]) putEvent(db, id, "recovery_nudge", { nudge: n, delivered: false });
  putEvent(db, id, "stale", { silent_ms: 999 });
  const { herdr, sends } = herdrProbe("alive", "idle", true);

  await reconcileOnce(db, { ...inert, herdr });

  expect(sends.length).toBe(1); // still trying, not escalating on nudges that never landed
  expect(getTask(db, id).state).toBe("in_progress");
  expect(db.query("SELECT * FROM events WHERE task_id = ? AND type = 'recovery_card'").all(id).length).toBe(0);
});

test("silent past the nudge cap → fail + decision card", async () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId, { agent: "a4" });
  putEvent(db, id, "status", { note: "working" });
  putEvent(db, id, "recovery_nudge", { nudge: 1 });
  putEvent(db, id, "recovery_nudge", { nudge: 2 });
  putEvent(db, id, "recovery_nudge", { nudge: 3 });
  putEvent(db, id, "stale", { silent_ms: 999 }); // latest meaningful = stale
  const { herdr, sends } = herdrProbe("alive", "idle");

  await reconcileOnce(db, { ...inert, herdr });

  expect(sends.length).toBe(0); // no more nudging
  expect(getTask(db, id).state).toBe("failed");
  const card = db.query("SELECT * FROM events WHERE task_id = ? AND type = 'recovery_card'").all(id);
  expect(card.length).toBe(1);
});

// ---- worktree reclaim at death-detection time ----

// A dead agent whose worktree is still on disk with uncommitted work in it.
function herdrDeadWithWorktree(dirty: boolean) {
  const calls: string[][] = [];
  const has = (argv: string[], ...xs: string[]) => xs.every((x) => argv.includes(x));
  const exec: Exec = async (argv) => {
    calls.push(argv);
    if (argv[0] === "git") {
      if (has(argv, "worktree", "list")) return OK("worktree /wt/x\nHEAD abc\nbranch refs/heads/hive/x\n");
      if (has(argv, "status", "--porcelain")) return OK(dirty ? "?? rescued.txt\n" : "");
      if (has(argv, "rev-parse", "--verify")) return { code: 1, stdout: "", stderr: "" }; // ghost name free
      return OK();
    }
    if (isPaneList(argv)) return NO_TASK_PANE;
    if (argv.includes("get")) return OK('{"error":{"code":"agent_not_found","message":"gone"}}');
    if (argv.includes("read")) return OK("pane tail");
    return OK();
  };
  return { herdr: new Herdr(exec, "herdr"), calls };
}

function taskWithWorktree(db: DB, projectId: string): string {
  const id = makeTask(db, projectId, { agent: "aw" });
  db.query("UPDATE tasks SET branch = 'hive/x', worktree_path = '/wt/x' WHERE id = ?").run(id);
  return id;
}

const reclaimEvent = (db: DB, id: string, type: string) =>
  db.query("SELECT payload FROM events WHERE task_id = ? AND type = ?").get(id, type) as { payload: string } | undefined;

test("dead agent → its dirty worktree is reclaimed, WIP preserved on a ghost branch", async () => {
  const { db, projectId } = freshDb();
  const id = taskWithWorktree(db, projectId);
  putEvent(db, id, "spawned");
  const { herdr, calls } = herdrDeadWithWorktree(true);

  await reconcileOnce(db, { ...inert, herdr });

  const ev = reclaimEvent(db, id, "worktree_reclaimed");
  expect(ev).toBeTruthy();
  expect(JSON.parse(ev!.payload).ghost_branch).toBe(`ghost-${id}`);
  expect(calls.some((c) => c.includes("checkout") && c.includes(`ghost-${id}`))).toBe(true);
  expect(calls.some((c) => c[0] === "git" && c.includes("remove") && c.includes("/wt/x"))).toBe(true);
  // recovery still ran its normal course
  expect(getTask(db, id).state).toBe("failed");
});

test("dead agent → a clean worktree is removed with no ghost branch", async () => {
  const { db, projectId } = freshDb();
  const id = taskWithWorktree(db, projectId);
  putEvent(db, id, "spawned");
  const { herdr, calls } = herdrDeadWithWorktree(false);

  await reconcileOnce(db, { ...inert, herdr });

  expect(JSON.parse(reclaimEvent(db, id, "worktree_reclaimed")!.payload).ghost_branch).toBe(null);
  expect(calls.some((c) => c.includes("checkout"))).toBe(false);
});

// 2026-08-19: a herdr desktop-app restart wiped the agent registry, so every
// LIVE agent probed as agent_not_found. 12+ tasks were failed and had their tabs
// closed under them. A not-found probe is only death when the pane is gone too.
test("agent_not_found with the task's pane still alive is NOT death", async () => {
  const { db, projectId } = freshDb();
  const id = taskWithWorktree(db, projectId);
  putEvent(db, id, "spawned");
  const calls: string[][] = [];
  const exec: Exec = async (argv) => {
    calls.push(argv);
    if (isPaneList(argv)) return panes("/wt/x"); // the agent's pane is still running
    if (argv.includes("get")) return OK('{"error":{"code":"agent_not_found"}}');
    return OK();
  };

  await reconcileOnce(db, { ...inert, herdr: new Herdr(exec, "herdr") });

  expect(getTask(db, id).state).toBe("in_progress"); // never failed
  expect(calls.some((c) => c.includes("close"))).toBe(false); // never closed
  expect(calls.some((c) => c[0] === "git" && c.includes("remove"))).toBe(false); // worktree intact
  const rec = db.query("SELECT payload FROM events WHERE task_id = ? AND type = 'recovery'").get(id) as any;
  expect(JSON.parse(rec.payload).decision).toBe("unconfirmed-dead");
});

// herdr itself unreachable (pane list comes back empty) is no evidence either.
test("agent_not_found with no pane list at all is NOT death", async () => {
  const { db, projectId } = freshDb();
  const id = taskWithWorktree(db, projectId);
  putEvent(db, id, "spawned");
  const exec: Exec = async (argv) => {
    if (isPaneList(argv)) return { code: 1, stdout: "", stderr: "connection refused" };
    if (argv.includes("get")) return OK('{"error":{"code":"agent_not_found"}}');
    return OK();
  };

  await reconcileOnce(db, { ...inert, herdr: new Herdr(exec, "herdr") });

  expect(getTask(db, id).state).toBe("in_progress");
});

// Three laps of "cannot tell" puts it in front of the director, once.
test("repeated unconfirmed deaths notify the director instead of tearing down", async () => {
  const { db, projectId } = freshDb();
  const id = taskWithWorktree(db, projectId);
  putEvent(db, id, "spawned");
  const exec: Exec = async (argv) => {
    if (isPaneList(argv)) return panes("/wt/x");
    if (argv.includes("get")) return OK('{"error":{"code":"agent_not_found"}}');
    return OK();
  };
  const herdr = new Herdr(exec, "herdr");

  for (let i = 0; i < 4; i++) await reconcileOnce(db, { ...inert, herdr });

  expect(getTask(db, id).state).toBe("in_progress");
  expect(db.query("SELECT 1 FROM notifications WHERE kind = 'agent_unreachable' AND task_id = ?").all(id).length).toBe(1);
});

test("a reclaim failure never derails recovery", async () => {
  const { db, projectId } = freshDb();
  const id = taskWithWorktree(db, projectId);
  putEvent(db, id, "spawned");
  // dirty, but the ghost commit is rejected → reclaimWorktree throws
  const exec: Exec = async (argv) => {
    if (argv[0] === "git") {
      if (argv.includes("list")) return OK("worktree /wt/x\nHEAD abc\nbranch refs/heads/hive/x\n");
      if (argv.includes("--porcelain") && argv.includes("status")) return OK("?? a.txt\n");
      if (argv.includes("commit")) return { code: 1, stdout: "", stderr: "hook rejected" };
      if (argv.includes("rev-parse")) return { code: 1, stdout: "", stderr: "" };
      return OK();
    }
    if (isPaneList(argv)) return NO_TASK_PANE;
    if (argv.includes("get")) return OK('{"error":{"code":"agent_not_found"}}');
    return OK();
  };

  await reconcileOnce(db, { ...inert, herdr: new Herdr(exec, "herdr") });

  expect(reclaimEvent(db, id, "worktree_reclaim_failed")).toBeTruthy();
  expect(getTask(db, id).state).toBe("failed"); // recovery completed anyway
  expect(db.query("SELECT 1 FROM tasks WHERE parent_task_id = ? AND source = 'requeue'").all(id).length).toBe(1);
});
