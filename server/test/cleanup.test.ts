import { test, expect } from "bun:test";
import { openDb, newId, now, type DB } from "../src/db.ts";
import { transition, setTerminalHook, writeEvent, currentAttemptEvidenceCount, recoveryAttemptId, startRecoveryEpoch, type State } from "../src/state.ts";
import { cleanupTask, runStackCmd, replayCleanedUpRecovery } from "../src/cleanup.ts";
import { queuedSteers } from "../src/steer.ts";
import { Herdr, tabCloseArgv, paneCloseArgv } from "../src/runtime/herdr.ts";
import { makeHandler } from "../src/api.ts";
import type { Exec, ExecResult } from "../src/exec.ts";

const OK = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const FAIL = (stderr = "boom"): ExecResult => ({ code: 1, stdout: "", stderr });
const has = (argv: string[], ...xs: string[]) => xs.every((x) => argv.includes(x));

function stubExec(handler: (argv: string[]) => ExecResult): { exec: Exec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: Exec = async (argv) => {
    calls.push(argv);
    return handler(argv);
  };
  return { exec, calls };
}

function freshDb(): { db: DB; projectId: string } {
  const db = openDb(":memory:");
  const projectId = newId("proj");
  db.query("INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)").run(
    projectId, "p", "/repo", "{}", now()
  );
  return { db, projectId };
}
function seedTask(
  db: DB,
  projectId: string,
  extra: Partial<{ state: string; agent_target: string; worktree_path: string; branch: string }> = {}
): string {
  const id = newId();
  const t = now();
  db.query(
    `INSERT INTO tasks (id, project_id, title, state, kind, agent_target, worktree_path, branch, created_at, updated_at)
     VALUES (?,?,?,?, 'ship', ?, ?, ?, ?, ?)`
  ).run(
    id, projectId, "t", extra.state ?? "done",
    extra.agent_target ?? `agent-${id}`, extra.worktree_path ?? `/wt/hive-${id}`, extra.branch ?? `hive/${id}`, t, t
  );
  return id;
}

// ---- adapter: closeSession argv ----

const closeRequest = { caller: "test", reason: "test cleanup", taskId: "t1" };

test("closeSession closes the tab when a tab id is known", async () => {
  const { exec, calls } = stubExec(() => OK());
  const h = new Herdr(exec, "herdr");
  const r = await h.closeSession({ agentTarget: "t1", tabId: "wF:t2", request: closeRequest });
  expect(r).toEqual({ closed: true, via: "tab wF:t2" });
  expect(calls[0].slice(1)).toEqual(tabCloseArgv("wF:t2"));
  // tab close took the pane with it — no agent get / pane close needed
  expect(calls.some((c) => has(c, "agent", "get"))).toBe(false);
});

test("closeSession falls back to closing the agent's pane when no tab id", async () => {
  const { exec, calls } = stubExec((argv) => {
    if (has(argv, "agent", "get")) return OK(JSON.stringify({ result: { agent: { pane_id: "wR:p7" } } }));
    return OK();
  });
  const h = new Herdr(exec, "herdr");
  const r = await h.closeSession({ agentTarget: "t1", tabId: null, request: closeRequest });
  expect(r).toEqual({ closed: true, via: "pane wR:p7" });
  expect(calls.some((c) => c.slice(1).join(" ") === paneCloseArgv("wR:p7").join(" "))).toBe(true);
});

test("closeSession never throws and reports not-closed on failure", async () => {
  const { exec } = stubExec(() => FAIL());
  const h = new Herdr(exec, "herdr");
  expect(await h.closeSession({ agentTarget: "gone", tabId: "wF:t9", request: closeRequest })).toEqual({ closed: false, via: null });
});

// ---- adapter: cleanupWorktree (branch guard + WIP preservation) ----

test("cleanupWorktree refuses when the branch is neither pushed nor merged", async () => {
  const { exec, calls } = stubExec((argv) => {
    if (argv[0] === "git" && argv.includes("ls-remote")) return OK(""); // not pushed
    if (argv[0] === "git" && argv.includes("--merged")) return OK("* main"); // not merged
    return OK();
  });
  const h = new Herdr(exec, "herdr");
  const r = await h.cleanupWorktree({ repoPath: "/repo", branch: "hive/t1", worktreePath: "/wt", taskId: "t1" });
  expect(r.removed).toBe(false);
  expect(calls.some((c) => has(c, "worktree", "remove"))).toBe(false);
});

test("cleanupWorktree removes a merged, untracked-only worktree via force (no ghost)", async () => {
  const { exec, calls } = stubExec((argv) => {
    if (argv[0] === "git" && argv.includes("ls-remote")) return OK(""); // not pushed
    if (argv[0] === "git" && argv.includes("--merged")) return OK("  main\n  hive/t1"); // merged
    if (argv[0] === "git" && has(argv, "status", "--porcelain")) return OK("?? .serena/\n"); // untracked only
    if (argv[0] === "git" && has(argv, "worktree", "remove")) return OK();
    return OK();
  });
  const h = new Herdr(exec, "herdr");
  const r = await h.cleanupWorktree({ repoPath: "/repo", branch: "hive/t1", worktreePath: "/wt", taskId: "t1" });
  expect(r).toEqual({ removed: true, reason: "merged", ghost_branch: null });
  expect(calls.some((c) => has(c, "worktree", "remove", "--force", "/wt"))).toBe(true);
  expect(calls.some((c) => has(c, "checkout", "-b"))).toBe(false); // no ghost for untracked-only
});

test("cleanupWorktree preserves TRACKED uncommitted work to a ghost before removing", async () => {
  let present = true;
  const { exec, calls } = stubExec((argv) => {
    const git = argv[0] === "git";
    if (git && argv.includes("ls-remote")) return OK("sha\trefs/heads/hive/t1"); // pushed
    if (git && has(argv, "status", "--porcelain")) return OK(" M src/a.ts\n"); // tracked dirty
    if (git && has(argv, "worktree", "list"))
      return OK(present ? "worktree /wt\nHEAD abc\nbranch refs/heads/hive/t1\n" : "");
    if (git && has(argv, "rev-parse", "--verify")) return FAIL(""); // ghost name free
    if (git && has(argv, "commit")) return OK();
    if (git && has(argv, "worktree", "remove")) { present = false; return OK(); }
    return OK();
  });
  const h = new Herdr(exec, "herdr");
  const r = await h.cleanupWorktree({ repoPath: "/repo", branch: "hive/t1", worktreePath: "/wt", taskId: "t1" });
  expect(r.removed).toBe(true);
  expect(r.ghost_branch).toBe("ghost-t1");
  expect(calls.some((c) => has(c, "checkout", "-b", "ghost-t1"))).toBe(true);
});

test("cleanupWorktree unregisters the worktree's hive.app from LaunchServices before removing", async () => {
  const { exec, calls } = stubExec((argv) => {
    if (argv[0] === "git" && argv.includes("ls-remote")) return OK(""); // not pushed
    if (argv[0] === "git" && argv.includes("--merged")) return OK("  main\n  hive/t1"); // merged
    if (argv[0] === "git" && has(argv, "status", "--porcelain")) return OK("?? .serena/\n");
    return OK();
  });
  const h = new Herdr(exec, "herdr");
  await h.cleanupWorktree({ repoPath: "/repo", branch: "hive/t1", worktreePath: "/wt", taskId: "t1" });
  expect(
    calls.some((c) => c[0].includes("lsregister") && c[1] === "-u" && c[2] === "/wt/electron/dist/mac-arm64/hive.app")
  ).toBe(true);
});

test("a throwing lsregister never blocks worktree removal", async () => {
  const calls: string[][] = [];
  const exec = async (argv: string[]) => {
    calls.push(argv);
    if (argv[0].includes("lsregister")) throw new Error("spawn ENOENT");
    if (argv[0] === "git" && argv.includes("ls-remote")) return OK("sha\trefs/heads/hive/t1");
    return OK();
  };
  const h = new Herdr(exec as Exec, "herdr");
  const r = await h.cleanupWorktree({ repoPath: "/repo", branch: "hive/t1", worktreePath: "/wt", taskId: "t1" });
  expect(r.removed).toBe(true);
  expect(calls.some((c) => has(c, "worktree", "remove"))).toBe(true);
});

test("reclaimWorktree unregisters the worktree's hive.app before removing it", async () => {
  const { exec, calls } = stubExec((argv) =>
    has(argv, "worktree", "list") ? OK("worktree /wt\nbranch refs/heads/hive/t1\n") : OK()
  );
  const h = new Herdr(exec, "herdr");
  await h.reclaimWorktree({ repoPath: "/repo", branch: "hive/t1", taskId: "t1", hintPath: "/wt" });
  const ls = calls.findIndex((c) => c[0].includes("lsregister") && c[2] === "/wt/electron/dist/mac-arm64/hive.app");
  const rm = calls.findIndex((c) => has(c, "worktree", "remove"));
  expect(ls).toBeGreaterThanOrEqual(0);
  expect(ls).toBeLessThan(rm);
});

test("teardown unregisters the worktree's hive.app before removing it", async () => {
  const { exec, calls } = stubExec((argv) =>
    argv[0] === "git" && argv.includes("ls-remote") ? OK("sha\trefs/heads/hive/t1") : OK()
  );
  const h = new Herdr(exec, "herdr");
  const r = await h.teardown({ repoPath: "/repo", branch: "hive/t1", worktreePath: "/wt", workspaceId: "wF" });
  expect(r.removed).toBe(true);
  const ls = calls.findIndex((c) => c[0].includes("lsregister") && c[2] === "/wt/electron/dist/mac-arm64/hive.app");
  const rm = calls.findIndex((c) => has(c, "worktree", "remove"));
  expect(ls).toBeGreaterThanOrEqual(0);
  expect(ls).toBeLessThan(rm);
});

test("cleanupWorktree treats an already-gone worktree (not a working tree) as removed, not preserved", async () => {
  const { exec, calls } = stubExec((argv) => {
    if (argv[0] === "git" && argv.includes("ls-remote")) return OK("sha\trefs/heads/hive/t1"); // pushed
    if (argv[0] === "git" && has(argv, "status", "--porcelain")) return FAIL("no such file or directory"); // worktree dir gone
    if (argv[0] === "git" && has(argv, "worktree", "remove")) return FAIL("fatal: '/wt' is not a working tree");
    return OK();
  });
  const h = new Herdr(exec, "herdr");
  const r = await h.cleanupWorktree({ repoPath: "/repo", branch: "hive/t1", worktreePath: "/wt", taskId: "t1" });
  expect(r.removed).toBe(true);
  expect(r.reason).toContain("already gone from disk");
});

test("cleanupTask closes the session even when the worktree was already gone from disk", async () => {
  const { db, projectId } = freshDb();
  const branch = "hive/CT3";
  const id = seedTask(db, projectId, { state: "done", branch, worktree_path: "/wt/hive-CT3" });
  db.query("INSERT INTO events (id, task_id, ts, source, type, payload) VALUES (?,?,?,?,?,?)").run(
    newId("evt"), id, now(), "herdr", "spawned", JSON.stringify({ tab_id: "wF:t9", agent_target: `agent-${id}` })
  );
  const exec: Exec = async (argv) => {
    if (argv[0] === "git" && argv.includes("ls-remote")) return OK("sha\trefs/heads/" + branch); // pushed
    if (argv[0] === "git" && has(argv, "status", "--porcelain")) return FAIL("no such file or directory");
    if (argv[0] === "git" && has(argv, "worktree", "remove")) return FAIL("fatal: '/wt/hive-CT3' is not a working tree");
    return OK();
  };
  const herdr = new Herdr(exec, "herdr");

  const out = await cleanupTask(db, herdr, id);
  expect(out.cleaned).toBe(true);
  expect(out.worktree?.removed).toBe(true);
  expect(out.session.via).toBe("tab wF:t9"); // the session was NOT left dangling
});

// hive-1090 item 3: a requeue's resume_pr_url only means anything if the
// predecessor's pr_url survives its own teardown. cleanupTask tears down the
// worktree/session for a terminal (e.g. failed) task, and must never touch
// pr_url — the open PR needs to stay linked so the requeue can adopt it.
test("cleanupTask never clears pr_url on a failed task — its open PR stays linked, never silently orphaned", async () => {
  const { db, projectId } = freshDb();
  const branch = "hive/CT-PR";
  const prUrl = "https://github.com/acme/web/pull/819";
  const id = seedTask(db, projectId, { state: "failed", branch, worktree_path: "/wt/hive-CT-PR" });
  db.query("UPDATE tasks SET pr_url = ? WHERE id = ?").run(prUrl, id);
  const exec: Exec = async (argv) => {
    if (argv[0] === "git" && argv.includes("ls-remote")) return OK("sha\trefs/heads/" + branch); // pushed
    return OK();
  };
  const herdr = new Herdr(exec, "herdr");

  const out = await cleanupTask(db, herdr, id);
  expect(out.cleaned).toBe(true);
  expect((db.query("SELECT pr_url FROM tasks WHERE id = ?").get(id) as any).pr_url).toBe(prUrl);
});

// ---- runStackCmd: shared setup/teardown hook runner ----

test("runStackCmd (setup) substitutes {worktree}, resolves relative argv[0], emits stack_setup ok", async () => {
  const { db, projectId } = freshDb();
  const id = seedTask(db, projectId, { state: "in_progress" });
  const { exec, calls } = stubExec(() => OK());
  await runStackCmd(db, id, ["infra/wt.sh", "up", "{worktree}"], "/repo", "/wt/hive-x", exec, {
    type: "stack_setup",
    source: "herdr",
  });
  // relative argv[0] -> repo_path prefix; {worktree} substituted
  expect(calls[0]).toEqual(["/repo/infra/wt.sh", "up", "/wt/hive-x"]);
  const ev = db.query("SELECT source, payload FROM events WHERE task_id = ? AND type = 'stack_setup'").get(id) as any;
  expect(ev.source).toBe("herdr");
  expect(JSON.parse(ev.payload).ok).toBe(true);
});

test("runStackCmd resolves a relative command against a Windows repo path", async () => {
  const { db, projectId } = freshDb();
  const id = seedTask(db, projectId, { state: "in_progress" });
  const { exec, calls } = stubExec(() => OK());
  await runStackCmd(
    db,
    id,
    ["infra\\worktree\\up.cmd", "{worktree}"],
    "C:\\src\\app",
    "C:\\worktrees\\app-task",
    exec,
    { type: "stack_setup", source: "herdr" }
  );
  expect(calls[0]).toEqual(["C:\\src\\app\\infra\\worktree\\up.cmd", "C:\\worktrees\\app-task"]);
});

test("runStackCmd records ok:false + error when the hook exits non-zero", async () => {
  const { db, projectId } = freshDb();
  const id = seedTask(db, projectId, { state: "in_progress" });
  const { exec } = stubExec(() => FAIL("stack boom"));
  await runStackCmd(db, id, ["/abs/up.sh"], "/repo", "/wt", exec, { type: "stack_setup", source: "herdr" });
  const ev = db.query("SELECT payload FROM events WHERE task_id = ? AND type = 'stack_setup'").get(id) as any;
  const p = JSON.parse(ev.payload);
  expect(p.ok).toBe(false);
  expect(p.error).toContain("stack boom");
});

test("runStackCmd is a no-op (no exec, no event) when argv is missing or empty", async () => {
  const { db, projectId } = freshDb();
  const id = seedTask(db, projectId, { state: "in_progress" });
  const { exec, calls } = stubExec(() => OK());
  await runStackCmd(db, id, undefined, "/repo", "/wt", exec, { type: "stack_setup", source: "herdr" });
  await runStackCmd(db, id, [], "/repo", "/wt", exec, { type: "stack_setup", source: "herdr" });
  expect(calls.length).toBe(0);
  expect(db.query("SELECT 1 FROM events WHERE task_id = ?").all(id).length).toBe(0);
});

test("runStackCmd honors a per-call timeoutMs (setup can outlast teardown's 120s)", async () => {
  const { db, projectId } = freshDb();
  const id = seedTask(db, projectId, { state: "in_progress" });
  // exec that resolves slower than the tiny timeout we pass -> should time out (124).
  const slowExec: Exec = async () =>
    new Promise<ExecResult>((r) => setTimeout(() => r(OK()), 50));
  await runStackCmd(db, id, ["/abs/up.sh"], "/repo", "/wt", slowExec, {
    type: "stack_setup",
    source: "herdr",
    timeoutMs: 10,
  });
  const ev = db.query("SELECT payload FROM events WHERE task_id = ? AND type = 'stack_setup'").get(id) as any;
  const p = JSON.parse(ev.payload);
  expect(p.ok).toBe(false);
  expect(p.error).toContain("timed out (0s)"); // 10ms -> "0s", proves the message uses timeoutMs not a hardcoded 120

  // Same slow exec, but a generous timeout -> completes ok.
  const id2 = seedTask(db, projectId, { state: "in_progress" });
  await runStackCmd(db, id2, ["/abs/up.sh"], "/repo", "/wt", slowExec, {
    type: "stack_setup",
    source: "herdr",
    timeoutMs: 5000,
  });
  const ev2 = db.query("SELECT payload FROM events WHERE task_id = ? AND type = 'stack_setup'").get(id2) as any;
  expect(JSON.parse(ev2.payload).ok).toBe(true);
});

// ---- cleanupTask orchestration ----

// A herdr stub whose branch is treated as merged+clean, so cleanupWorktree removes.
function mergedCleanHerdr(): { herdr: Herdr; calls: string[][] } {
  const calls: string[][] = [];
  const exec: Exec = async (argv) => {
    calls.push(argv);
    if (argv[0] === "git" && argv.includes("--merged")) return OK("  main\n  " + argv[argv.length - 1]?.replace("hive/", "hive/"));
    if (argv[0] === "git" && argv.includes("ls-remote")) return OK("");
    if (argv[0] === "git" && has(argv, "status", "--porcelain")) return OK("");
    return OK();
  };
  return { herdr: new Herdr(exec, "herdr"), calls };
}

test("cleanupTask removes a done task's worktree, closes the session, emits cleaned_up", async () => {
  const { db, projectId } = freshDb();
  const branch = "hive/CT1";
  const id = seedTask(db, projectId, { state: "done", branch, worktree_path: "/wt/hive-CT1" });
  // record the spawned event so the tab id is discoverable
  db.query("INSERT INTO events (id, task_id, ts, source, type, payload) VALUES (?,?,?,?,?,?)").run(
    newId("evt"), id, now(), "herdr", "spawned", JSON.stringify({ tab_id: "wF:t9", agent_target: `agent-${id}` })
  );
  // merged + clean branch
  const exec: Exec = async (argv) => {
    if (argv[0] === "git" && argv.includes("--merged")) return OK(`  main\n  ${branch}`);
    if (argv[0] === "git" && argv.includes("ls-remote")) return OK("");
    if (argv[0] === "git" && has(argv, "status", "--porcelain")) return OK("");
    return OK();
  };
  const herdr = new Herdr(exec, "herdr");

  const out = await cleanupTask(db, herdr, id);
  expect(out.cleaned).toBe(true);
  expect(out.worktree?.removed).toBe(true);
  expect(out.session.via).toBe("tab wF:t9");

  const ev = db.query("SELECT * FROM events WHERE task_id = ? AND type = 'cleaned_up'").all(id);
  expect(ev.length).toBe(1);
  // runtime binding cleared so a re-run is a no-op
  const task = db.query("SELECT worktree_path, agent_target FROM tasks WHERE id = ?").get(id) as any;
  expect(task.worktree_path).toBeNull();
  expect(task.agent_target).toBeNull();
});

test("cleanup preserves pending attempts and invalidates every active recovery leaf", async () => {
  const { db, projectId } = freshDb();
  const predecessor = seedTask(db, projectId, { state: "failed", branch: "hive/predecessor", worktree_path: "/wt/predecessor" });
  const successors = [
    seedTask(db, projectId, { state: "in_review", agent_target: "replacement-review", branch: "hive/successor-review", worktree_path: "/wt/successor-review" }),
    seedTask(db, projectId, { state: "verifying", agent_target: "replacement-verifying", branch: "hive/successor-verifying", worktree_path: "/wt/successor-verifying" }),
  ];
  const attempts = new Map<string, string>();
  for (const successor of successors) {
    db.query("UPDATE tasks SET source = 'requeue', parent_task_id = ? WHERE id = ?").run(predecessor, successor);
    writeEvent(db, { task_id: successor, source: "reconciler", type: "created", payload: { title: "t", requeue_of: predecessor } });
    const attemptId = `pending-${successor}`;
    attempts.set(successor, attemptId);
    writeEvent(db, { task_id: successor, source: "herdr", type: "spawned", payload: { attempt_id: `completed-${successor}` } });
    startRecoveryEpoch(db, successor, "system", attemptId);
    db.query("INSERT INTO evidence (id, task_id, ts, kind, meta) VALUES (?,?,?,?,?)")
      .run(newId("ev"), successor, now(), "log", JSON.stringify({ attempt_id: attemptId }));
    writeEvent(db, { task_id: successor, source: "system", type: "auto_review", payload: { verdict: "looks_good", summary: "ready", risks: [], questions: [] } });
    expect(currentAttemptEvidenceCount(db, successor)).toBe(1);
  }
  const exec: Exec = async (argv) => {
    if (argv[0] === "git" && argv.includes("ls-remote")) return OK("sha\trefs/heads/hive/predecessor");
    if (argv[0] === "git" && has(argv, "status", "--porcelain")) return OK(" M src/recovered.ts\n");
    if (argv[0] === "git" && has(argv, "worktree", "list")) return OK("worktree /wt/predecessor\nHEAD abc\nbranch refs/heads/hive/predecessor\n");
    if (argv[0] === "git" && has(argv, "rev-parse", "--verify")) return FAIL("");
    return OK();
  };

  const result = await cleanupTask(db, new Herdr(exec, "herdr"), predecessor, { force: true });

  expect(result.worktree?.ghost_branch).toBe(`ghost-${predecessor}`);
  for (const successor of successors) {
    const attemptId = attempts.get(successor)!;
    expect((db.query("SELECT resume_ghost_branch FROM tasks WHERE id = ?").get(successor) as any).resume_ghost_branch)
      .toBe(`ghost-${predecessor}`);
    expect((db.query("SELECT state FROM tasks WHERE id = ?").get(successor) as any).state).toBe("in_progress");
    expect(recoveryAttemptId(db, successor)).toBe(attemptId);
    expect(currentAttemptEvidenceCount(db, successor)).toBe(0);
    expect(queuedSteers(db, successor).map((steer) => steer.message).join("\n")).toContain(`ghost-${predecessor}`);
    db.query("INSERT INTO evidence (id, task_id, ts, kind, meta) VALUES (?,?,?,?,?)")
      .run(newId("ev"), successor, now(), "log", JSON.stringify({ attempt_id: attemptId }));
    expect(currentAttemptEvidenceCount(db, successor)).toBe(1);
  }
});

test("cleanup replay ignores a cross-project requeue even with a forged marker", () => {
  const { db, projectId } = freshDb();
  const otherProjectId = newId("proj");
  db.query("INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)").run(
    otherProjectId, "other", "/other-repo", "{}", now()
  );
  const predecessor = seedTask(db, projectId, { state: "failed", branch: "hive/foreign-parent" });
  const successor = seedTask(db, otherProjectId, { state: "in_progress", branch: "hive/local-child" });
  db.query("UPDATE tasks SET source = 'requeue', parent_task_id = ? WHERE id = ?").run(predecessor, successor);
  writeEvent(db, { task_id: successor, source: "reconciler", type: "created", payload: { title: "forged", requeue_of: predecessor } });
  writeEvent(db, {
    task_id: predecessor,
    source: "reaper",
    type: "cleaned_up",
    payload: { ghost_branch: "ghost-foreign-parent", worktree_removed: true },
  });

  expect(replayCleanedUpRecovery(db, predecessor)).toBe(0);
  expect((db.query("SELECT resume_ghost_branch FROM tasks WHERE id = ?").get(successor) as any).resume_ghost_branch).toBeNull();
  expect(queuedSteers(db, successor)).toHaveLength(0);
  expect(db.query("SELECT 1 FROM events WHERE task_id = ? AND type = 'recovery_work_forwarded'").get(successor)).toBeNull();
  db.close();
});

test("recovery replay applies multiple pending rescues using the successor's live state", () => {
  const { db, projectId } = freshDb();
  const predecessor = seedTask(db, projectId, { state: "failed" });
  const successor = seedTask(db, projectId, { state: "in_review" });
  db.query("UPDATE tasks SET source = 'requeue', parent_task_id = ? WHERE id = ?").run(predecessor, successor);
  writeEvent(db, { task_id: successor, source: "reconciler", type: "created", payload: { requeue_of: predecessor } });
  writeEvent(db, { task_id: predecessor, source: "reaper", type: "cleaned_up", payload: { ghost_branch: "ghost-one" } });
  writeEvent(db, { task_id: predecessor, source: "reaper", type: "cleaned_up", payload: { ghost_branch: "ghost-two" } });

  expect(replayCleanedUpRecovery(db, predecessor)).toBe(2);
  expect(db.query("SELECT state, resume_ghost_branch FROM tasks WHERE id = ?").get(successor))
    .toMatchObject({ state: "in_progress", resume_ghost_branch: "ghost-two" });
  expect(db.query("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = 'recovery_work_forwarded'").get(successor))
    .toEqual({ n: 2 });
  db.close();
});

test("recovery replay forwards rescued work to concurrent parent and child retries", () => {
  const { db, projectId } = freshDb();
  const parent = seedTask(db, projectId, { state: "in_progress" });
  writeEvent(db, { task_id: parent, source: "herdr", type: "spawned", payload: {} });
  const spawnedRowid = (db.query("SELECT rowid FROM events WHERE task_id = ? AND type = 'spawned'").get(parent) as any).rowid;
  writeEvent(db, { task_id: parent, source: "director", type: "state_change", payload: { from: "failed", to: "queued" } });
  const child = seedTask(db, projectId, { state: "in_progress" });
  db.query("UPDATE tasks SET source = 'requeue', parent_task_id = ? WHERE id = ?").run(parent, child);
  writeEvent(db, { task_id: child, source: "reconciler", type: "created", payload: { requeue_of: parent } });
  writeEvent(db, { task_id: parent, source: "reaper", type: "cleaned_up", payload: { ghost_branch: "ghost-shared", spawn_rowid: spawnedRowid } });

  expect(replayCleanedUpRecovery(db, parent)).toBe(2);
  for (const id of [parent, child]) {
    expect((db.query("SELECT resume_ghost_branch FROM tasks WHERE id = ?").get(id) as any).resume_ghost_branch).toBe("ghost-shared");
    expect(queuedSteers(db, id).map((steer) => steer.message).join("\n")).toContain("ghost-shared");
  }
  db.close();
});

test("recovery replay forwards late worktree reclamation ghosts", () => {
  const { db, projectId } = freshDb();
  const predecessor = seedTask(db, projectId, { state: "failed" });
  const successor = seedTask(db, projectId, { state: "in_progress" });
  db.query("UPDATE tasks SET source = 'requeue', parent_task_id = ? WHERE id = ?").run(predecessor, successor);
  writeEvent(db, { task_id: successor, source: "reconciler", type: "created", payload: { requeue_of: predecessor } });
  writeEvent(db, {
    task_id: predecessor,
    source: "reconciler",
    type: "worktree_reclaimed",
    payload: { ghost_branch: "ghost-late-reclaim" },
  });

  expect(replayCleanedUpRecovery(db, predecessor)).toBe(1);
  expect((db.query("SELECT resume_ghost_branch FROM tasks WHERE id = ?").get(successor) as any).resume_ghost_branch).toBe("ghost-late-reclaim");
  expect(queuedSteers(db, successor).map((steer) => steer.message).join("\n")).toContain("ghost-late-reclaim");
  db.close();
});

// Regression for the guard's old `COALESCE(spawn_rowid, 0)` fallback: a
// worktree_reclaimed event never used to carry spawn_rowid, so the self-forward
// EXISTS check degraded to "any failed->queued transition ever, in any order"
// instead of "a fresh generation started since THIS reclaim's spawn". An old,
// unrelated failed->queued from an earlier retry round (rowid BEFORE the
// reclaimed spawn) satisfied `rowid > 0` and could bounce a task that has since
// advanced all the way to in_review back into in_progress.
test("recovery replay ignores a worktree reclaim whose task independently reached in_review", () => {
  const { db, projectId } = freshDb();
  const task = seedTask(db, projectId, { state: "in_review" });
  // An unrelated earlier retry round on this same row — precedes the reclaimed
  // spawn below and must not count as evidence for it.
  writeEvent(db, { task_id: task, source: "director", type: "state_change", payload: { from: "failed", to: "queued" } });
  writeEvent(db, { task_id: task, source: "herdr", type: "spawned", payload: {} });
  const spawnRowid = (db.query("SELECT rowid FROM events WHERE task_id = ? AND type = 'spawned'").get(task) as any).rowid;
  writeEvent(db, {
    task_id: task,
    source: "reconciler",
    type: "worktree_reclaimed",
    payload: { ghost_branch: "ghost-stale", spawn_rowid: spawnRowid },
  });

  expect(replayCleanedUpRecovery(db, task)).toBe(0);
  expect((db.query("SELECT state, resume_ghost_branch FROM tasks WHERE id = ?").get(task) as any)).toMatchObject({
    state: "in_review",
    resume_ghost_branch: null,
  });
  expect(db.query("SELECT 1 FROM events WHERE task_id = ? AND type = 'recovery_work_forwarded'").get(task)).toBeNull();
  db.close();
});

test("recovery replay invalidates a removed clean predecessor worktree", () => {
  const { db, projectId } = freshDb();
  const predecessor = seedTask(db, projectId, { state: "failed" });
  const successor = seedTask(db, projectId, { state: "in_review" });
  db.query("UPDATE tasks SET source = 'requeue', parent_task_id = ? WHERE id = ?").run(predecessor, successor);
  writeEvent(db, { task_id: successor, source: "reconciler", type: "created", payload: { requeue_of: predecessor } });
  writeEvent(db, {
    task_id: predecessor,
    source: "reaper",
    type: "cleaned_up",
    payload: { worktree_removed: true, ghost_branch: null },
  });

  expect(replayCleanedUpRecovery(db, predecessor)).toBe(1);
  expect(db.query("SELECT state, resume_ghost_branch FROM tasks WHERE id = ?").get(successor))
    .toMatchObject({ state: "in_progress", resume_ghost_branch: null });
  expect(queuedSteers(db, successor).map((steer) => steer.message).join("\n"))
    .toContain("previously advertised kept worktree");
  const receipt = db.query(
    "SELECT payload FROM events WHERE task_id = ? AND type = 'recovery_work_forwarded' ORDER BY rowid DESC LIMIT 1"
  ).get(successor) as { payload: string };
  expect(JSON.parse(receipt.payload)).toMatchObject({ predecessor_task_id: predecessor, ghost_branch: null });
  db.close();
});

test("cleanup preserves a same-row replacement generation and forwards rescued work", async () => {
  const { db, projectId } = freshDb();
  const id = seedTask(db, projectId, { state: "failed", agent_target: "failed-agent", branch: "hive/failed", worktree_path: "/wt/failed" });
  writeEvent(db, {
    task_id: id,
    source: "herdr",
    type: "spawned",
    payload: { attempt_id: "failed-attempt", tab_id: "old-tab", terminal_id: "old-terminal", branch: "hive/failed", worktree_path: "/wt/failed" },
  });
  let replacementStarted = false;
  const calls: string[][] = [];
  const exec: Exec = async (argv) => {
    calls.push(argv);
    if (argv[0] === "git" && argv.includes("ls-remote")) {
      if (!replacementStarted) {
        replacementStarted = true;
        writeEvent(db, { task_id: id, source: "director", type: "state_change", payload: { from: "failed", to: "queued" } });
        db.query("UPDATE tasks SET state = 'in_progress', agent_target = ?, branch = ?, worktree_path = ? WHERE id = ?")
          .run("replacement-agent", "hive/replacement", "/wt/replacement", id);
        writeEvent(db, {
          task_id: id,
          source: "herdr",
          type: "spawned",
          payload: { attempt_id: "replacement-attempt", tab_id: "new-tab", terminal_id: "new-terminal", branch: "hive/replacement", worktree_path: "/wt/replacement" },
        });
      }
      return OK("sha\trefs/heads/hive/failed");
    }
    if (argv[0] === "git" && has(argv, "status", "--porcelain")) return OK(" M src/recovered.ts\n");
    if (argv[0] === "git" && has(argv, "worktree", "list")) return OK("worktree /wt/failed\nHEAD abc\nbranch refs/heads/hive/failed\n");
    if (argv[0] === "git" && has(argv, "rev-parse", "--verify")) return FAIL("");
    return OK();
  };

  const result = await cleanupTask(db, new Herdr(exec, "herdr"), id, { force: true });

  expect(result.worktree?.ghost_branch).toBe(`ghost-${id}`);
  expect(db.query("SELECT state, agent_target, branch, worktree_path, resume_ghost_branch FROM tasks WHERE id = ?").get(id)).toMatchObject({
    state: "in_progress",
    agent_target: "replacement-agent",
    branch: "hive/replacement",
    worktree_path: "/wt/replacement",
    resume_ghost_branch: `ghost-${id}`,
  });
  expect(recoveryAttemptId(db, id)).toBe("replacement-attempt");
  expect(queuedSteers(db, id).map((steer) => steer.message).join("\n")).toContain(`ghost-${id}`);
  expect(calls.some((argv) => argv.includes("new-tab"))).toBe(false);
});

test("cleanupTask preserves an UNMERGED worktree but still closes the session (pty released)", async () => {
  const { db, projectId } = freshDb();
  const branch = "hive/CT2";
  const id = seedTask(db, projectId, { state: "done", branch, worktree_path: "/wt/hive-CT2" });
  db.query("INSERT INTO events (id, task_id, ts, source, type, payload) VALUES (?,?,?,?,?,?)").run(
    newId("evt"), id, now(), "herdr", "spawned", JSON.stringify({ tab_id: "wF:t7", agent_target: `agent-${id}` })
  );
  const calls: string[][] = [];
  const exec: Exec = async (argv) => {
    calls.push(argv);
    if (argv[0] === "git" && argv.includes("--merged")) return OK("* main"); // not merged
    if (argv[0] === "git" && argv.includes("ls-remote")) return OK(""); // not pushed
    return OK();
  };
  const herdr = new Herdr(exec, "herdr");

  const out = await cleanupTask(db, herdr, id);
  expect(out.cleaned).toBe(false);
  expect(out.worktree?.removed).toBe(false);
  expect(out.session.closed).toBe(true); // tab closed — a kept session pins a pty forever
  expect(out.session.via).toBe("tab wF:t7");
  expect(db.query("SELECT * FROM events WHERE task_id = ? AND type = 'cleanup_skipped'").all(id).length).toBe(1);
  // worktree untouched; agent binding dropped so later sweeps skip the close
  expect(calls.some((c) => has(c, "worktree", "remove"))).toBe(false);
  const task = db.query("SELECT worktree_path, agent_target FROM tasks WHERE id = ?").get(id) as any;
  expect(task.worktree_path).toBe("/wt/hive-CT2");
  expect(task.agent_target).toBeNull();

  // Second sweep: no herdr call (agent_target cleared) and no duplicate
  // cleanup_skipped for the same reason.
  calls.length = 0;
  const again = await cleanupTask(db, herdr, id);
  expect(again.cleaned).toBe(false);
  expect(calls.some((c) => c[0] !== "git")).toBe(false); // only the git safety checks re-ran
  expect(db.query("SELECT * FROM events WHERE task_id = ? AND type = 'cleanup_skipped'").all(id).length).toBe(1);
});

// 2026-08-19: herdr answered every tab.close with an error, so agent_target was
// never cleared and the same six preserved worktrees were re-closed on every
// 5-minute reaper sweep, forever. The attempt is what counts, not its outcome.
test("cleanupTask drops the binding even when the session close FAILS (no re-close every sweep)", async () => {
  const { db, projectId } = freshDb();
  const id = seedTask(db, projectId, { state: "done", branch: "hive/CT4", worktree_path: "/wt/hive-CT4" });
  db.query("INSERT INTO events (id, task_id, ts, source, type, payload) VALUES (?,?,?,?,?,?)").run(
    newId("evt"), id, now(), "herdr", "spawned", JSON.stringify({ tab_id: "wF:t4", agent_target: `agent-${id}` })
  );
  const calls: string[][] = [];
  const exec: Exec = async (argv) => {
    calls.push(argv);
    if (argv[0] === "git" && argv.includes("--merged")) return OK("* main"); // not merged
    if (argv[0] === "git" && argv.includes("ls-remote")) return OK(""); // not pushed
    if (argv[0] !== "git") return { code: 1, stdout: "", stderr: "herdr error" }; // every close fails
    return OK();
  };
  const herdr = new Herdr(exec, "herdr");

  const out = await cleanupTask(db, herdr, id);
  expect(out.session.closed).toBe(false);
  expect((db.query("SELECT agent_target FROM tasks WHERE id = ?").get(id) as any).agent_target).toBeNull();

  calls.length = 0;
  await cleanupTask(db, herdr, id);
  expect(calls.some((c) => c[0] !== "git")).toBe(false); // no second tab.close
});

test("cleanupTask also closes the worktree's OWN herdr workspace (the auto-spawned pty), once", async () => {
  const { db, projectId } = freshDb();
  const branch = "hive/CT3";
  // Unmerged/preserved: the worktree stays on disk, but the session AND the
  // worktree's own workspace are still released (both pin a pty).
  const id = seedTask(db, projectId, { state: "done", branch, worktree_path: "/wt/hive-CT3" });
  db.query("INSERT INTO events (id, task_id, ts, source, type, payload) VALUES (?,?,?,?,?,?)").run(
    newId("evt"), id, now(), "herdr", "spawned",
    JSON.stringify({ tab_id: "wF:t3", agent_target: `agent-${id}`, workspace_id: "wKT3", fleet_workspace_id: "wR" })
  );
  const calls: string[][] = [];
  const exec: Exec = async (argv) => {
    calls.push(argv);
    if (argv[0] === "git" && argv.includes("--merged")) return OK("* main"); // not merged
    if (argv[0] === "git" && argv.includes("ls-remote")) return OK(""); // not pushed
    return OK();
  };
  const herdr = new Herdr(exec, "herdr");

  const out = await cleanupTask(db, herdr, id);
  expect(out.session.closed).toBe(true);
  // the worktree's own workspace is closed — NOT the shared fleet workspace (wR)
  expect(calls.some((c) => has(c, "workspace", "close", "wKT3"))).toBe(true);
  expect(calls.some((c) => has(c, "workspace", "close", "wR"))).toBe(false);

  // second sweep: binding cleared, so no repeat workspace/tab close
  calls.length = 0;
  await cleanupTask(db, herdr, id);
  expect(calls.some((c) => c[0] !== "git")).toBe(false);
});

// 2026-08-20: the sibling hole a6a4c70 left open. On the NON-preserved path the
// tab id comes from the immutable `spawned` event, so clearing agent_target
// changed nothing — six ancient terminal tasks re-closed dead tab ids and
// re-wrote `cleaned_up` on every 5-minute lap (11,458 events each).
test("cleanupTask never re-closes a tab id read from the immutable spawned event", async () => {
  const { db, projectId } = freshDb();
  // The live shape: the row lost its worktree_path/branch, so nothing here can
  // remove the checkout — only the stale spawn metadata is left.
  const id = seedTask(db, projectId, { state: "cancelled" });
  db.query("UPDATE tasks SET agent_target = NULL, worktree_path = NULL, branch = NULL WHERE id = ?").run(id);
  db.query("INSERT INTO events (id, task_id, ts, source, type, payload) VALUES (?,?,?,?,?,?)").run(
    newId("evt"), id, now(), "herdr", "spawned", JSON.stringify({ tab_id: "wR:t11", workspace_id: "wKT11" })
  );
  const { exec, calls } = stubExec(() => OK());
  const herdr = new Herdr(exec, "herdr");

  await cleanupTask(db, herdr, id, { force: true });
  expect(calls.some((c) => has(c, "tab", "close", "wR:t11"))).toBe(true); // attempted once

  calls.length = 0;
  await cleanupTask(db, herdr, id, { force: true });
  expect(calls.length).toBe(0); // ...and never again
  expect(db.query("SELECT * FROM events WHERE task_id = ? AND type = 'cleaned_up'").all(id).length).toBe(1);
});

test("a requeued task (fresh spawn after a cleanup) is torn down again", async () => {
  const { db, projectId } = freshDb();
  const id = seedTask(db, projectId, { state: "done" });
  db.query("INSERT INTO events (id, task_id, ts, source, type, payload) VALUES (?,?,?,?,?,?)").run(
    newId("evt"), id, "2026-01-01T00:00:00.000Z", "herdr", "cleaned_up", "{}"
  );
  db.query("INSERT INTO events (id, task_id, ts, source, type, payload) VALUES (?,?,?,?,?,?)").run(
    newId("evt"), id, "2026-01-02T00:00:00.000Z", "herdr", "spawned", JSON.stringify({ tab_id: "wF:t9" })
  );
  const branch = (db.query("SELECT branch FROM tasks WHERE id = ?").get(id) as any).branch;
  const { exec, calls } = stubExec((argv) => {
    if (argv[0] === "git" && argv.includes("--merged")) return OK(`  main\n  ${branch}`);
    return OK();
  });
  const out = await cleanupTask(db, new Herdr(exec, "herdr"), id, { force: true });
  expect(out.cleaned).toBe(true);
  expect(calls.some((c) => has(c, "tab", "close", "wF:t9"))).toBe(true);
});

test("cleanupTask on a NON-terminal task is a no-op unless forced", async () => {
  const { db, projectId } = freshDb();
  const id = seedTask(db, projectId, { state: "in_progress" });
  const { herdr, calls } = mergedCleanHerdr();
  const out = await cleanupTask(db, herdr, id); // not forced
  expect(out.cleaned).toBe(false);
  expect(out.worktree).toBeNull();
  expect(calls.length).toBe(0); // never even touched git
  expect(db.query("SELECT * FROM events WHERE task_id = ?").all(id).length).toBe(0);
});

// ---- remote branch deletion (origin litter: 500+ stale hive/* refs) ----

// git world for a terminal task: worktree merged+clean, and origin either holds
// the branch at `remoteSha` or doesn't. `ancestor` is whether that remote tip is
// already in the default branch.
function remoteWorld(opts: { branch: string; onOrigin?: boolean; ancestor?: boolean; pushOk?: boolean }) {
  const calls: string[][] = [];
  const exec: Exec = async (argv) => {
    calls.push(argv);
    if (argv[0] !== "git") return OK();
    if (argv.includes("--merged")) return OK(`  main\n  ${opts.branch}`); // worktree safe to remove
    if (argv.includes("ls-remote")) return opts.onOrigin ? OK(`sha1\trefs/heads/${opts.branch}\n`) : OK("");
    if (has(argv, "merge-base", "--is-ancestor")) return opts.ancestor ? OK() : FAIL("");
    if (has(argv, "push", "origin", "--delete")) return opts.pushOk === false ? FAIL("remote: permission denied") : OK();
    return OK();
  };
  return { herdr: new Herdr(exec, "herdr"), calls };
}

const cleanedUpPayload = (db: DB, id: string) =>
  JSON.parse((db.query("SELECT payload FROM events WHERE task_id = ? AND type = 'cleaned_up'").get(id) as any).payload);

test("cleanupTask deletes the task's MERGED branch on origin and records it", async () => {
  const { db, projectId } = freshDb();
  const branch = "hive/RB1";
  const id = seedTask(db, projectId, { state: "done", branch, worktree_path: "/wt/hive-RB1" });
  const { herdr, calls } = remoteWorld({ branch, onOrigin: true, ancestor: true });

  const out = await cleanupTask(db, herdr, id);
  expect(out.cleaned).toBe(true);
  expect(calls.some((c) => has(c, "push", "origin", "--delete", branch))).toBe(true);
  // the ancestry check asks about the REMOTE tip, against the default branch
  expect(calls.some((c) => has(c, "merge-base", "--is-ancestor", "sha1", "main"))).toBe(true);
  expect(cleanedUpPayload(db, id).remote_branch_deleted).toBe(true);
});

test("cleanupTask never deletes an UNMERGED origin branch (it holds the only copy)", async () => {
  const { db, projectId } = freshDb();
  const branch = "hive/RB2";
  const id = seedTask(db, projectId, { state: "cancelled", branch, worktree_path: "/wt/hive-RB2" });
  const { herdr, calls } = remoteWorld({ branch, onOrigin: true, ancestor: false });

  const out = await cleanupTask(db, herdr, id);
  expect(out.cleaned).toBe(true); // local teardown still happened
  expect(calls.some((c) => has(c, "push", "--delete"))).toBe(false);
  const p = cleanedUpPayload(db, id);
  expect(p.remote_branch_deleted).toBe(false);
  expect(p.remote_branch_reason).toContain("not merged into main");
});

test("a project that never pushes no-ops gracefully (no branch on origin, no push)", async () => {
  const { db, projectId } = freshDb();
  const branch = "hive/RB3";
  const id = seedTask(db, projectId, { state: "done", branch, worktree_path: "/wt/hive-RB3" });
  const { herdr, calls } = remoteWorld({ branch, onOrigin: false });

  expect((await cleanupTask(db, herdr, id)).cleaned).toBe(true);
  expect(calls.some((c) => has(c, "push", "--delete"))).toBe(false);
  expect(cleanedUpPayload(db, id).remote_branch_reason).toBe("no remote branch");
});

test("config.delete_remote_branches = false opts a project out entirely", async () => {
  const { db, projectId } = freshDb();
  db.query("UPDATE projects SET config = ? WHERE id = ?").run(JSON.stringify({ delete_remote_branches: false }), projectId);
  const branch = "hive/RB4";
  const id = seedTask(db, projectId, { state: "done", branch, worktree_path: "/wt/hive-RB4" });
  const { herdr, calls } = remoteWorld({ branch, onOrigin: true, ancestor: true });

  expect((await cleanupTask(db, herdr, id)).cleaned).toBe(true);
  expect(calls.some((c) => has(c, "push", "--delete"))).toBe(false);
  const p = cleanedUpPayload(db, id);
  expect(p.remote_branch_deleted).toBe(false);
  expect(p.remote_branch_reason).toBeUndefined(); // not attempted at all
});

test("a failing remote deletion never blocks the rest of cleanup", async () => {
  const { db, projectId } = freshDb();
  const branch = "hive/RB5";
  const id = seedTask(db, projectId, { state: "done", branch, worktree_path: "/wt/hive-RB5" });
  db.query("INSERT INTO events (id, task_id, ts, source, type, payload) VALUES (?,?,?,?,?,?)").run(
    newId("evt"), id, now(), "herdr", "spawned", JSON.stringify({ tab_id: "wF:t5" })
  );
  const { herdr, calls } = remoteWorld({ branch, onOrigin: true, ancestor: true, pushOk: false });

  const out = await cleanupTask(db, herdr, id);
  expect(out.cleaned).toBe(true);
  expect(out.worktree?.removed).toBe(true);
  expect(out.session.via).toBe("tab wF:t5");
  expect(calls.some((c) => has(c, "worktree", "remove"))).toBe(true);
  expect(cleanedUpPayload(db, id).remote_branch_reason).toContain("permission denied");
});

test("a PRESERVED (unmerged) worktree keeps its origin branch untouched", async () => {
  const { db, projectId } = freshDb();
  const branch = "hive/RB6";
  const id = seedTask(db, projectId, { state: "done", branch, worktree_path: "/wt/hive-RB6" });
  const calls: string[][] = [];
  const exec: Exec = async (argv) => {
    calls.push(argv);
    if (argv[0] === "git" && argv.includes("--merged")) return OK("* main"); // not merged
    if (argv[0] === "git" && argv.includes("ls-remote")) return OK(""); // not pushed
    return OK();
  };
  const out = await cleanupTask(db, new Herdr(exec, "herdr"), id);
  expect(out.cleaned).toBe(false);
  expect(calls.some((c) => has(c, "push", "--delete"))).toBe(false);
});

test("deleteRemoteBranch refuses any branch hive did not name", async () => {
  const { exec, calls } = stubExec(() => OK("sha1\trefs/heads/x"));
  const h = new Herdr(exec, "herdr");
  for (const branch of ["main", "ghost-t1", "hive/t1/extra", "release/1.2"]) {
    expect(await h.deleteRemoteBranch({ repoPath: "/repo", branch })).toEqual({
      deleted: false,
      reason: "not a hive task branch",
    });
  }
  expect(calls.length).toBe(0); // never even asked origin
});

test("deleteRemoteBranch reports, rather than throws, when git blows up", async () => {
  const exec: Exec = async () => {
    throw new Error("spawn ENOENT");
  };
  const h = new Herdr(exec, "herdr");
  expect(await h.deleteRemoteBranch({ repoPath: "/repo", branch: "hive/t1" })).toEqual({
    deleted: false,
    reason: "spawn ENOENT",
  });
});

// ---- terminal transition hook: fires on done/cancelled, NOT on retriable failed ----

test("the terminal hook fires on done and cancelled but never on failed", () => {
  const { db, projectId } = freshDb();
  const fired: Array<{ id: string; to: State }> = [];
  setTerminalHook((_db, taskId, to) => fired.push({ id: taskId, to }));
  try {
    // done needs evidence
    const d = seedTask(db, projectId, { state: "in_progress" });
    db.query("INSERT INTO evidence (id, task_id, ts, kind, meta) VALUES (?,?,?,?, '{}')").run(newId("ev"), d, now(), "log");
    transition(db, d, "in_review");
    transition(db, d, "verifying");
    transition(db, d, "done");

    const c = seedTask(db, projectId, { state: "in_progress" });
    transition(db, c, "cancelled");

    const f = seedTask(db, projectId, { state: "in_progress" });
    transition(db, f, "failed");

    expect(fired.map((x) => x.to).sort()).toEqual(["cancelled", "done"]);
    expect(fired.some((x) => x.to === "failed")).toBe(false);
  } finally {
    setTerminalHook(null);
  }
});

// ---- manual endpoint: POST /api/tasks/:id/cleanup ----

test("POST /cleanup: 404 unknown, 409 on a live task, 200 forces teardown on a terminal one", async () => {
  const { db, projectId } = freshDb();
  const exec: Exec = async (argv) => {
    if (argv[0] === "git" && argv.includes("--merged")) return OK("  main\n  hive/EP1");
    if (argv[0] === "git" && argv.includes("ls-remote")) return OK("");
    if (argv[0] === "git" && has(argv, "status", "--porcelain")) return OK("");
    return OK();
  };
  const handle = makeHandler(db, { herdr: new Herdr(exec, "herdr") });
  const call = (id: string) =>
    handle(new Request(`http://x/api/tasks/${id}/cleanup`, { method: "POST" }));

  expect((await call("nope")).status).toBe(404);

  const live = seedTask(db, projectId, { state: "in_progress" });
  expect((await call(live)).status).toBe(409);

  const done = seedTask(db, projectId, { state: "done", branch: "hive/EP1", worktree_path: "/wt/hive-EP1" });
  const res = await call(done);
  expect(res.status).toBe(200);
  const body = (await res.json()) as any;
  expect(body.ok).toBe(true);
  expect(body.worktree.removed).toBe(true);
  expect(db.query("SELECT * FROM events WHERE task_id = ? AND type = 'cleaned_up'").all(done).length).toBe(1);
});
