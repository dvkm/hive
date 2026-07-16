import { test, expect } from "bun:test";
import { openDb, newId, now, type DB } from "../src/db.ts";
import { transition, setTerminalHook, type State } from "../src/state.ts";
import { cleanupTask, runStackCmd } from "../src/cleanup.ts";
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

test("closeSession closes the tab when a tab id is known", async () => {
  const { exec, calls } = stubExec(() => OK());
  const h = new Herdr(exec, "herdr");
  const r = await h.closeSession({ agentTarget: "t1", tabId: "wF:t2" });
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
  const r = await h.closeSession({ agentTarget: "t1", tabId: null });
  expect(r).toEqual({ closed: true, via: "pane wR:p7" });
  expect(calls.some((c) => c.slice(1).join(" ") === paneCloseArgv("wR:p7").join(" "))).toBe(true);
});

test("closeSession never throws and reports not-closed on failure", async () => {
  const { exec } = stubExec(() => FAIL());
  const h = new Herdr(exec, "herdr");
  expect(await h.closeSession({ agentTarget: "gone", tabId: "wF:t9" })).toEqual({ closed: false, via: null });
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

test("cleanupTask preserves an UNMERGED worktree: cleanup_skipped, session + worktree kept", async () => {
  const { db, projectId } = freshDb();
  const branch = "hive/CT2";
  const id = seedTask(db, projectId, { state: "done", branch, worktree_path: "/wt/hive-CT2" });
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
  expect(out.session.closed).toBe(false); // tab kept so the director can push
  expect(db.query("SELECT * FROM events WHERE task_id = ? AND type = 'cleanup_skipped'").all(id).length).toBe(1);
  // nothing removed, binding intact
  expect(calls.some((c) => has(c, "worktree", "remove"))).toBe(false);
  const task = db.query("SELECT worktree_path FROM tasks WHERE id = ?").get(id) as any;
  expect(task.worktree_path).toBe("/wt/hive-CT2");
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
