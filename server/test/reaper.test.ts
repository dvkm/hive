import { test, expect } from "bun:test";
import { openDb, newId, now, getSetting, type DB } from "../src/db.ts";
import { reapOnce, taskIdFromBranch, taskIdFromCwd, sweepOrphanedAgents, sweepOrphanedPanes } from "../src/reaper.ts";
import { Herdr } from "../src/runtime/herdr.ts";
import type { Exec, ExecResult } from "../src/exec.ts";

const OK = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const has = (argv: string[], ...xs: string[]) => xs.every((x) => argv.includes(x));

function freshDb(): { db: DB; projectId: string } {
  const db = openDb(":memory:");
  const projectId = newId("proj");
  db.query("INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)").run(
    projectId, "p", "/repo", "{}", now()
  );
  return { db, projectId };
}
function seedTask(db: DB, projectId: string, id: string, state: string): void {
  const t = now();
  db.query(
    `INSERT INTO tasks (id, project_id, title, state, kind, agent_target, worktree_path, branch, created_at, updated_at)
     VALUES (?,?,?,?, 'ship', ?, ?, ?, ?, ?)`
  ).run(id, projectId, "t", state, `agent-${id}`, `/wt/hive-${id}`, `hive/${id}`, t, t);
}

test("reapOnce writes a last_reap_at liveness heartbeat", async () => {
  const { db } = freshDb();
  expect(getSetting(db, "last_reap_at")).toBeNull();
  const herdr = new Herdr(async () => OK(), "herdr");
  await reapOnce(db, { herdr });
  const ts = getSetting(db, "last_reap_at");
  expect(ts).not.toBeNull();
  expect(Date.now() - Date.parse(ts!)).toBeLessThan(5000);
});

test("taskIdFromBranch extracts only hive/<id>; ghosts and others are ignored", () => {
  expect(taskIdFromBranch("hive/abc123")).toBe("abc123");
  expect(taskIdFromBranch("ghost-abc123")).toBeNull();
  expect(taskIdFromBranch("main")).toBeNull();
  expect(taskIdFromBranch(null)).toBeNull();
});

// A world with three hive worktrees: DONE+merged (reap), IN_PROGRESS (skip),
// DONE+unmerged (preserve). git branch --merged returns only the merged one.
function reaperWorld() {
  const removed: string[] = [];
  const porcelain =
    "worktree /repo\nHEAD r0\nbranch refs/heads/main\n\n" +
    "worktree /wt/hive-DONE\nHEAD r1\nbranch refs/heads/hive/DONE\n\n" +
    "worktree /wt/hive-LIVE\nHEAD r2\nbranch refs/heads/hive/LIVE\n\n" +
    "worktree /wt/hive-KEEP\nHEAD r3\nbranch refs/heads/hive/KEEP\n";
  const exec: Exec = async (argv) => {
    if (argv[0] === "git" && has(argv, "worktree", "list")) return OK(porcelain);
    if (argv[0] === "git" && argv.includes("ls-remote")) return OK(""); // nothing pushed
    if (argv[0] === "git" && argv.includes("--merged")) return OK("  main\n  hive/DONE"); // only DONE merged
    if (argv[0] === "git" && has(argv, "status", "--porcelain")) return OK(""); // clean
    if (argv[0] === "git" && has(argv, "worktree", "remove")) {
      removed.push(argv[argv.length - 1]);
      return OK();
    }
    return OK();
  };
  return { herdr: new Herdr(exec, "herdr"), removed };
}

test("reapOnce reaps a terminal+merged worktree, skips a live one, preserves an unmerged one", async () => {
  const { db, projectId } = freshDb();
  seedTask(db, projectId, "DONE", "done");
  seedTask(db, projectId, "LIVE", "in_progress");
  seedTask(db, projectId, "KEEP", "done"); // terminal but branch not merged/pushed

  const { herdr, removed } = reaperWorld();
  await reapOnce(db, { herdr, exec: (herdr as any).exec });

  // only the merged, terminal worktree was removed
  expect(removed).toEqual(["/wt/hive-DONE"]);
  // DONE emitted cleaned_up; KEEP emitted cleanup_skipped; LIVE emitted nothing
  expect(db.query("SELECT * FROM events WHERE task_id = 'DONE' AND type = 'cleaned_up'").all().length).toBe(1);
  expect(db.query("SELECT * FROM events WHERE task_id = 'KEEP' AND type = 'cleanup_skipped'").all().length).toBe(1);
  expect(db.query("SELECT * FROM events WHERE task_id = 'LIVE'").all().length).toBe(0);
});

// NOTE: this test PASSES while printing a scary "error: herdr socket blew up" stack.
// That is reaper.ts's own console.error for the item it caught, not an escaped
// rejection — bun renders logged Errors with a source excerpt. Expected output.
test("reapOnce isolates a per-item failure and keeps sweeping", async () => {
  const { db, projectId } = freshDb();
  seedTask(db, projectId, "DONE", "done");
  const porcelain =
    "worktree /wt/hive-BOOM\nHEAD r1\nbranch refs/heads/hive/BOOM\n\n" + // no task → orphan path
    "worktree /wt/hive-DONE\nHEAD r2\nbranch refs/heads/hive/DONE\n";
  let removedDone = false;
  const exec: Exec = async (argv) => {
    if (argv[0] === "git" && has(argv, "worktree", "list")) return OK(porcelain);
    if (argv[0] === "git" && argv.includes("--merged")) return OK("  main\n  hive/DONE");
    if (argv[0] === "git" && argv.includes("ls-remote")) {
      if (argv.includes("hive/BOOM")) throw new Error("herdr socket blew up"); // item failure
      return OK("");
    }
    if (argv[0] === "git" && has(argv, "status", "--porcelain")) return OK("");
    if (argv[0] === "git" && has(argv, "worktree", "remove")) { removedDone = true; return OK(); }
    return OK();
  };
  const herdr = new Herdr(exec, "herdr");
  await reapOnce(db, { herdr, exec });
  // BOOM threw, but DONE was still reaped
  expect(removedDone).toBe(true);
  expect(db.query("SELECT * FROM events WHERE task_id = 'DONE' AND type = 'cleaned_up'").all().length).toBe(1);
});

// ---- sweepOrphanedAgents: diff `herdr agent list` against live DB tasks (task #341) ----

test("sweepOrphanedAgents closes a session with NO matching task row at all", async () => {
  const { db } = freshDb();
  const calls: string[][] = [];
  const listJson = JSON.stringify({ result: { agents: [{ name: "ghost-task-id", tab_id: "wF:t7" }] } });
  const exec: Exec = async (argv) => {
    calls.push(argv);
    if (has(argv, "agent", "list")) return OK(listJson);
    return OK();
  };
  const herdr = new Herdr(exec, "herdr");
  await sweepOrphanedAgents(db, { herdr });
  expect(calls.some((c) => has(c, "tab", "close", "wF:t7"))).toBe(true);
});

test("sweepOrphanedAgents leaves a LIVE task's agent alone", async () => {
  const { db, projectId } = freshDb();
  seedTask(db, projectId, "LIVE2", "in_progress");
  const calls: string[][] = [];
  const listJson = JSON.stringify({ result: { agents: [{ name: "LIVE2", tab_id: "wF:t8" }] } });
  const exec: Exec = async (argv) => {
    calls.push(argv);
    if (has(argv, "agent", "list")) return OK(listJson);
    return OK();
  };
  const herdr = new Herdr(exec, "herdr");
  await sweepOrphanedAgents(db, { herdr });
  expect(calls.some((c) => has(c, "tab", "close"))).toBe(false);
});

// ---- taskIdFromCwd: map a herdr pane back to its task by worktree dir ----

test("taskIdFromCwd extracts hive-<hexid> from a worktree cwd; ignores non-hive dirs", () => {
  expect(taskIdFromCwd("/Users/david/.herdr/worktrees/hive/hive-5ba4edd2f39d")).toBe("5ba4edd2f39d");
  expect(taskIdFromCwd("/wt/hive-222a5d0a2b73/")).toBe("222a5d0a2b73"); // trailing slash tolerated
  expect(taskIdFromCwd("/Users/david/projects/hive")).toBeNull(); // David's own checkout
  expect(taskIdFromCwd("/Users/david/projects/notes")).toBeNull();
  expect(taskIdFromCwd("/wt/ghost-5ba4edd2f39d")).toBeNull(); // ghost branch dir, not a live session
  expect(taskIdFromCwd(null)).toBeNull();
});

// ---- sweepOrphanedPanes: the pty-leak sweep, keyed on PANES not agents ----

// One fleet workspace (wR, label hive-fleet) plus worktree workspaces. Panes:
//   TERM fleet tab      -> close the tab (never the fleet workspace)
//   LIVE fleet tab      -> keep
//   TERM worktree ws    -> close the whole workspace
//   LIVE worktree ws    -> keep
//   orphan worktree ws  -> no task row -> close the whole workspace
//   David's own pane    -> cwd not hive-<hex> -> untouched
function paneWorld() {
  const closed: string[][] = [];
  const paneJson = JSON.stringify({
    result: {
      panes: [
        { pane_id: "wR:p1", tab_id: "wR:t1", workspace_id: "wR", cwd: "/wt/hive-aaaaaaaaaaaa" },
        { pane_id: "wR:p2", tab_id: "wR:t2", workspace_id: "wR", cwd: "/wt/hive-bbbbbbbbbbbb" },
        { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", cwd: "/wt/hive-cccccccccccc" },
        { pane_id: "w2:p1", tab_id: "w2:t1", workspace_id: "w2", cwd: "/wt/hive-dddddddddddd" },
        { pane_id: "w3:p1", tab_id: "w3:t1", workspace_id: "w3", cwd: "/wt/hive-eeeeeeeeeeee" },
        { pane_id: "w4:p1", tab_id: "w4:t1", workspace_id: "w4", cwd: "/Users/david/projects/foo" },
      ],
    },
  });
  const wsJson = JSON.stringify({ result: { workspaces: [{ workspace_id: "wR", label: "hive-fleet" }] } });
  const exec: Exec = async (argv) => {
    if (has(argv, "pane", "list")) return OK(paneJson);
    if (has(argv, "workspace", "list")) return OK(wsJson);
    if (has(argv, "tab", "close") || has(argv, "workspace", "close")) {
      closed.push(argv);
      return OK();
    }
    return OK();
  };
  return { herdr: new Herdr(exec, "herdr"), closed };
}

test("sweepOrphanedPanes reaps terminal + orphan panes, keeps live ones, never closes the fleet workspace", async () => {
  const { db, projectId } = freshDb();
  seedTask(db, projectId, "aaaaaaaaaaaa", "done"); // fleet tab, terminal -> close tab
  seedTask(db, projectId, "bbbbbbbbbbbb", "in_progress"); // fleet tab, live -> keep
  seedTask(db, projectId, "cccccccccccc", "failed"); // worktree ws, terminal -> close ws
  seedTask(db, projectId, "dddddddddddd", "in_progress"); // worktree ws, live -> keep
  // eeeeeeeeeeee: no task row at all -> orphan -> close ws

  const { herdr, closed } = paneWorld();
  await sweepOrphanedPanes(db, { herdr });

  // terminal fleet tab closed by TAB (not workspace)
  expect(closed.some((c) => has(c, "tab", "close", "wR:t1"))).toBe(true);
  // terminal + orphan worktree workspaces closed WHOLE
  expect(closed.some((c) => has(c, "workspace", "close", "w1"))).toBe(true);
  expect(closed.some((c) => has(c, "workspace", "close", "w3"))).toBe(true);
  // SAFETY: the shared fleet workspace is NEVER closed
  expect(closed.some((c) => has(c, "workspace", "close", "wR"))).toBe(false);
  // SAFETY: live tasks' panes are never touched (fleet tab wR:t2, worktree ws w2)
  expect(closed.some((c) => has(c, "tab", "close", "wR:t2"))).toBe(false);
  expect(closed.some((c) => has(c, "workspace", "close", "w2"))).toBe(false);
  // David's own pane (w4) untouched
  expect(closed.some((c) => c.includes("w4") || c.includes("w4:t1"))).toBe(false);
});

test("sweepOrphanedPanes closes NOTHING when the fleet workspace id can't be resolved (never risk the whole fleet)", async () => {
  const { db, projectId } = freshDb();
  seedTask(db, projectId, "cccccccccccc", "done"); // would-be reap target
  const closed: string[][] = [];
  const paneJson = JSON.stringify({
    result: { panes: [{ pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", cwd: "/wt/hive-cccccccccccc" }] },
  });
  const exec: Exec = async (argv) => {
    if (has(argv, "pane", "list")) return OK(paneJson);
    if (has(argv, "workspace", "list")) return OK("{}"); // fleet label not found → null
    if (has(argv, "tab", "close") || has(argv, "workspace", "close")) { closed.push(argv); return OK(); }
    return OK();
  };
  const herdr = new Herdr(exec, "herdr");
  await sweepOrphanedPanes(db, { herdr });
  expect(closed.length).toBe(0); // no fleet id → skip reaping entirely
  expect(getSetting(db, "herdr_pane_count")).toBe("1"); // still records the count
});

test("sweepOrphanedPanes records pre-sweep pane count for /api/health", async () => {
  const { db, projectId } = freshDb();
  seedTask(db, projectId, "aaaaaaaaaaaa", "done");
  const { herdr } = paneWorld();
  await sweepOrphanedPanes(db, { herdr });
  expect(getSetting(db, "herdr_pane_count")).toBe("6"); // all 6 live panes, counted before reaping
  expect(getSetting(db, "herdr_pane_at")).not.toBeNull();
});

test("sweepOrphanedAgents defers to cleanupTask for a TERMINAL task's lingering agent — an unmerged worktree still keeps its session", async () => {
  const { db, projectId } = freshDb();
  seedTask(db, projectId, "TERM1", "done"); // branch hive/TERM1, not merged/pushed below -> cleanupTask preserves it
  const calls: string[][] = [];
  const listJson = JSON.stringify({ result: { agents: [{ name: "TERM1", tab_id: "wF:t9" }] } });
  const exec: Exec = async (argv) => {
    calls.push(argv);
    if (has(argv, "agent", "list")) return OK(listJson);
    if (argv[0] === "git" && argv.includes("ls-remote")) return OK(""); // not pushed
    if (argv[0] === "git" && argv.includes("--merged")) return OK("* main"); // not merged
    return OK();
  };
  const herdr = new Herdr(exec, "herdr");
  await sweepOrphanedAgents(db, { herdr });
  // preserved: the sweep must NOT bypass cleanupTask's guard and close it directly
  expect(calls.some((c) => has(c, "tab", "close"))).toBe(false);
  expect(db.query("SELECT * FROM events WHERE task_id = 'TERM1' AND type = 'cleanup_skipped'").all().length).toBe(1);
});
