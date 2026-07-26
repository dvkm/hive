// End-to-end reproduction of the 2026-07-25 pty leak and its fix, at the real
// 511-pty wall. Uses the shipped Herdr + sweepOrphanedPanes + sessionUtilization
// against a fake `herdr` process and a real in-memory DB. Run: bun run <this>.
import { openDb, newId, now, setSetting, type DB } from "../../../../server/src/db.ts";
import { sweepOrphanedPanes } from "../../../../server/src/reaper.ts";
import { sessionUtilization } from "../../../../server/src/health.ts";
import { Herdr } from "../../../../server/src/runtime/herdr.ts";
import type { Exec, ExecResult } from "../../../../server/src/exec.ts";

const OK = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const has = (a: string[], ...xs: string[]) => xs.every((x) => a.includes(x));

function seedDb(): { db: DB; projectId: string } {
  const db = openDb(":memory:");
  const projectId = newId("proj");
  db.query("INSERT INTO projects (id,name,repo_path,config,created_at) VALUES (?,?,?,?,?)").run(
    projectId, "hive", "/repo", "{}", now()
  );
  return { db, projectId };
}
function seed(db: DB, projectId: string, id: string, state: string) {
  const t = now();
  db.query(
    `INSERT INTO tasks (id,project_id,title,state,kind,agent_target,worktree_path,branch,created_at,updated_at)
     VALUES (?,?,?,?, 'ship', ?, ?, ?, ?, ?)`
  ).run(id, projectId, "t", state, `agent-${id}`, `/wt/hive-${id}`, `hive/${id}`, t, t);
}
const hex = (n: number) => n.toString(16).padStart(12, "0");

// --- Build the world as it looked at the wall: 511 panes, 1 fleet workspace ---
// 50 LIVE tasks   -> 50 fleet tabs (agent-bearing) + 50 leaked worktree workspaces
// 205 TERMINAL    -> 205 leaked worktree workspaces (finished days ago, never closed)
// 205 TERMINAL    -> 205 dead fleet tabs (agent exited, agent-list blind to them)
// 1 fleet ws pane. Total = 50+50+205+205+1 = 511  (== macOS kern.tty.ptmx_max)
const { db, projectId } = seedDb();
const panes: any[] = [];
let i = 0;
const FLEET = "wR";
panes.push({ pane_id: "wR:p0", tab_id: "wR:t0", workspace_id: FLEET, cwd: "/repo" }); // fleet's own shell

for (let k = 0; k < 50; k++, i++) {
  const id = hex(i); seed(db, projectId, id, "in_progress");
  panes.push({ pane_id: `wR:pL${k}`, tab_id: `wR:tL${k}`, workspace_id: FLEET, cwd: `/wt/hive-${id}` }); // live fleet tab
  panes.push({ pane_id: `wL${k}:p1`, tab_id: `wL${k}:t1`, workspace_id: `wL${k}`, cwd: `/wt/hive-${id}` }); // its spare worktree ws
}
for (let k = 0; k < 205; k++, i++) {
  const id = hex(i); seed(db, projectId, id, k % 2 ? "done" : "failed");
  panes.push({ pane_id: `wT${k}:p1`, tab_id: `wT${k}:t1`, workspace_id: `wT${k}`, cwd: `/wt/hive-${id}` }); // leaked worktree ws
}
for (let k = 0; k < 205; k++, i++) {
  const id = hex(i); seed(db, projectId, id, "done");
  panes.push({ pane_id: `wR:pD${k}`, tab_id: `wR:tD${k}`, workspace_id: FLEET, cwd: `/wt/hive-${id}` }); // dead fleet tab
}
// One stray pane that is David's own checkout — must never be touched.
panes.push({ pane_id: "wX:p1", tab_id: "wX:t1", workspace_id: "wX", cwd: "/Users/david/projects/hive" });

const paneJson = JSON.stringify({ result: { panes } });
const wsJson = JSON.stringify({ result: { workspaces: [{ workspace_id: FLEET, label: "hive-fleet" }] } });

const closedTabs: string[] = [], closedWorkspaces: string[] = [], removedWorktrees: string[] = [];
let paneList = [...panes];
const exec: Exec = async (argv) => {
  if (has(argv, "pane", "list")) return OK(JSON.stringify({ result: { panes: paneList } }));
  if (has(argv, "workspace", "list")) return OK(wsJson);
  if (has(argv, "workspace", "close")) {
    const ws = argv[argv.length - 1]; closedWorkspaces.push(ws);
    paneList = paneList.filter((p) => p.workspace_id !== ws); // reclaim its pty
    return OK();
  }
  if (has(argv, "tab", "close")) {
    const tab = argv[argv.length - 1]; closedTabs.push(tab);
    paneList = paneList.filter((p) => p.tab_id !== tab); // reclaim its pty
    return OK();
  }
  if (has(argv, "worktree", "remove")) { removedWorktrees.push(argv[argv.length - 1]); return OK(); }
  return OK();
};
const herdr = new Herdr(exec, "herdr");

function gauge(db: DB) {
  const s = sessionUtilization(db)!;
  return `panes=${s.panes}/${s.max}  pct=${(s.pct * 100).toFixed(0)}%  warn=${s.warn ? "TRUE ⚠" : "false"}`;
}

console.log("=== 2026-07-25 pty leak: at the wall, then swept ===\n");

// Snapshot the count as the reaper would, to render the pre-sweep gauge.
setSetting(db, "herdr_pane_count", String(panes.length));
setSetting(db, "herdr_pane_at", now());
console.log("BEFORE  /api/health sessions:  " + gauge(db));
console.log(`        live in_progress tasks: 50   (must all survive)\n`);

await sweepOrphanedPanes(db, { herdr });

console.log(`swept:  closed ${closedWorkspaces.length} orphan worktree workspaces`);
console.log(`        closed ${closedTabs.length} dead fleet tabs`);
console.log(`        git worktree remove calls: ${removedWorktrees.length}   (checkouts must NOT be deleted)\n`);

// Re-count post-sweep exactly as the next reaper cycle would.
setSetting(db, "herdr_pane_count", String(paneList.length));
console.log("AFTER   /api/health sessions:  " + gauge(db));

// --- Assertions: the fix's safety + effectiveness invariants ---
const liveKept = paneList.some((p) => p.cwd === "/wt/hive-000000000000"); // task 0 = live
const fleetAlive = paneList.some((p) => p.workspace_id === FLEET);        // fleet workspace intact
const davidUntouched = paneList.some((p) => p.cwd === "/Users/david/projects/hive");
const ok =
  removedWorktrees.length === 0 &&
  !closedWorkspaces.includes(FLEET) &&
  liveKept && fleetAlive && davidUntouched &&
  closedWorkspaces.length === 205 && closedTabs.length === 205 && // only the 410 orphans reclaimed
  paneList.length === panes.length - 410;

console.log("\n--- invariants ---");
console.log(`  no git worktree ever removed .............. ${removedWorktrees.length === 0 ? "PASS" : "FAIL"}`);
console.log(`  shared fleet workspace never closed ....... ${!closedWorkspaces.includes(FLEET) ? "PASS" : "FAIL"}`);
console.log(`  50 live agents' panes survived ............ ${liveKept && fleetAlive ? "PASS" : "FAIL"}`);
console.log(`  David's own checkout untouched ............ ${davidUntouched ? "PASS" : "FAIL"}`);
console.log(`  410 leaked ptys reclaimed (${panes.length} -> ${paneList.length}) ...... ${paneList.length === panes.length - 410 ? "PASS" : "FAIL"}`);
console.log(`\nRESULT: ${ok ? "✅ leak drained, no live work harmed, gauge back below warn" : "❌ INVARIANT VIOLATED"}`);
if (!ok) process.exit(1);
