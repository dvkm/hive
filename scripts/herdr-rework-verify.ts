// Live end-to-end verification for the herdr rework + stale recovery.
// Boots a SCRATCH hive server (temp DB/HOME, ephemeral port) against the REAL
// herdr server and a throwaway git repo, then drives a task through the whole
// new pipeline and the stale-recovery loop, printing each step so the run can be
// captured as committed evidence. Not part of the test suite (needs live herdr).
//
//   bun run scripts/herdr-rework-verify.ts 2>&1 | tee docs/evidence/herdr-rework-verification.txt
import { mkdtempSync } from "node:fs";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../server/src/db.ts";
import { makeHandler } from "../server/src/api.ts";
import { reconcileOnce } from "../server/src/reconciler.ts";
import { Herdr, FLEET_LABEL } from "../server/src/runtime/herdr.ts";
import { defaultExec } from "../server/src/exec.ts";

const BIN = process.env.HERDR_BIN || "/opt/homebrew/bin/herdr";
const repo = "/tmp/hive-rework-verify";
const HOME = mkdtempSync(join(tmpdir(), "hive-rework-home-"));
process.env.HIVE_HOME = HOME;
const herdr = new Herdr(defaultExec);
const ghNoop = async () => ({ code: 1, stdout: "", stderr: "no gh" }); // skip PR sync

const log = (...a: unknown[]) => console.log(...a);
const hr = (s: string) => log(`\n===== ${s} =====`);
const ok = (b: boolean) => (b ? "PASS" : "FAIL");
let failures = 0;
const check = (b: boolean, msg: string) => {
  if (!b) failures++;
  log(`${ok(b)} ${msg}`);
};

async function raw(argv: string[]) {
  const r = await defaultExec([BIN, ...argv]);
  return r;
}
async function git(args: string[]) {
  return defaultExec(["git", ...args]);
}

async function resetRepo() {
  await defaultExec(["bash", "-lc", `rm -rf ${repo} ${repo}-origin.git && mkdir -p ${repo}`]);
  await git(["-C", repo, "init", "-q", "-b", "main"]);
  await git(["-C", repo, "config", "user.email", "test@hive.local"]);
  await git(["-C", repo, "config", "user.name", "hive test"]);
  await defaultExec(["bash", "-lc", `echo '# throwaway' > ${repo}/README.md`]);
  await git(["-C", repo, "add", "-A"]);
  await git(["-C", repo, "commit", "-qm", "init"]);
  await git(["-C", repo, "init", "-q", "--bare", `${repo}-origin.git`]);
  await git(["-C", repo, "remote", "add", "origin", `${repo}-origin.git`]);
  await git(["-C", repo, "push", "-q", "origin", "main"]);
}

// The agent command (a short sleep) EXITS on its own — the exact original
// failure ("a one-shot exited without reporting; the agent vanished"). herdr
// then reports it gone and the adapter's probe detects it. No manual kill.
async function waitDead(taskId: string): Promise<boolean> {
  for (let i = 0; i < 40; i++) {
    if (!(await herdr.probe(taskId)).alive) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function main() {
  hr("0. context");
  const status = await raw(["status", "server"]);
  log(status.stdout.trim());
  if (!/status: running/.test(status.stdout)) {
    log("herdr server not running — aborting.");
    process.exit(2);
  }
  await resetRepo();

  // Boot a scratch hive server in-process against the real herdr adapter.
  const db = openDb(":memory:");
  const server = Bun.serve({ port: 0, fetch: makeHandler(db, { herdr, supervise: false }) });
  const BASE = `http://127.0.0.1:${server.port}`;
  log("scratch hive server:", BASE, " home:", HOME);

  const post = async (p: string, body: unknown) =>
    (await fetch(BASE + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json() as any;
  const get = async (p: string) => (await fetch(BASE + p)).json() as any;

  // ---- PHASE 1: real interactive claude spawns into the visible fleet ----
  hr("PHASE 1: interactive claude — visible, labelled fleet tab");
  const proj1 = await post("/api/projects", { name: "rework", repo_path: repo, config: { default_branch: "main" } });
  const t1 = await post("/api/tasks", { project_id: proj1.id, title: "verify visible fleet", brief: "Say hello.", kind: "chore" });
  const spawn1 = await post(`/api/tasks/${t1.id}/spawn`, { hive_url: BASE });
  log("spawn:", JSON.stringify(spawn1.ok ? { ok: true, agent: spawn1.agent_target } : spawn1));
  check(spawn1.ok === true, "spawn endpoint returned ok (worktree + interactive agent)");
  const full1 = await get(`/api/tasks/${t1.id}`);
  check(full1.state === "in_progress", "task moved queued → in_progress");
  check(!!full1.worktree_path && full1.branch === `hive/${t1.id}`, "worktree + hive/<id> branch recorded");

  hr("PHASE 1: dedicated fleet workspace + labelled tab");
  const wsList = await raw(["workspace", "list"]);
  const fleetWs = JSON.parse(wsList.stdout).result?.workspaces?.find((w: any) => w.label === FLEET_LABEL);
  check(!!fleetWs, `dedicated "${FLEET_LABEL}" workspace exists`);
  if (fleetWs) {
    const tabs = await raw(["tab", "list", "--workspace", fleetWs.workspace_id]);
    const labelled = (JSON.parse(tabs.stdout).result?.tabs ?? []).find((t: any) => String(t.label).startsWith(t1.id));
    check(!!labelled, `labelled tab "${t1.id} ..." present in the fleet workspace`);
  }
  // give the interactive agent a moment to register, then confirm visibility
  await new Promise((r) => setTimeout(r, 2500));
  const agents1 = await raw(["agent", "list"]);
  check(agents1.stdout.includes(t1.id), "agent visible in `herdr agent list`");

  hr("PHASE 1: structural hook wiring written into the worktree");
  const settingsPath = join(full1.worktree_path, ".claude", "settings.local.json");
  check(existsSync(settingsPath), ".claude/settings.local.json written into the worktree");
  if (existsSync(settingsPath)) {
    const s = readFileSync(settingsPath, "utf8");
    check(/hive-hook\.sh Stop/.test(s) && /SubagentStop/.test(s), "hook wires Stop / SubagentStop / PostToolUse");
    // prove the wired hook reaches hive (the zero-discipline reporting path)
    await defaultExec(["bash", "-lc", `HIVE_TASK_ID=${t1.id} HIVE_URL=${BASE} bash ${join(process.cwd(), "hooks", "hive-hook.sh")} Stop`]);
    const ev1 = await get(`/api/tasks/${t1.id}/events`);
    check(ev1.some((e: any) => e.source === "hook"), "hook event arrived at hive (source=hook)");
  }

  // ---- PHASE 2: stale recovery — dead agent → fail + auto-requeue → cap → card ----
  // Deterministic long-running interactive agent (a bash loop) via agent_argv.
  hr("PHASE 2: stale recovery loop (dead → fail → requeue → cap → decision card)");
  const proj2 = await post("/api/projects", {
    name: "recovery",
    repo_path: repo,
    // A short-lived agent that exits on its own == the original failure mode.
    config: { default_branch: "main", auto_dispatch: true, dispatch_kinds: ["chore"], agent_argv: ["bash", "-lc", "echo hive agent up; sleep 4"] },
  });

  let taskId = (await post("/api/tasks", { project_id: proj2.id, title: "recover me", brief: "loop", kind: "chore" })).id;
  const attempts: string[] = [];

  for (let cycle = 1; cycle <= 3; cycle++) {
    hr(`PHASE 2.${cycle}: spawn an interactive agent, then it EXITS (vanishes)`);
    const sp = await post(`/api/tasks/${taskId}/spawn`, { hive_url: BASE });
    check(sp.ok === true, `cycle ${cycle}: agent spawned`);
    const dead = await waitDead(taskId);
    check(dead, `cycle ${cycle}: agent exited and herdr probe reports it gone`);

    hr(`PHASE 2.${cycle}: reconciler detects death → recovery`);
    await reconcileOnce(db, { herdr, exec: ghNoop, staleMs: 60 * 60 * 1000 });

    const failed = await get(`/api/tasks/${taskId}`);
    check(failed.state === "failed", `cycle ${cycle}: task marked failed`);
    check(failed.evidence.some((e: any) => e.kind === "log"), `cycle ${cycle}: pane tail captured as log evidence`);

    const requeue = db.query("SELECT id FROM tasks WHERE source = 'requeue' AND parent_task_id = ?").get(taskId) as { id: string } | undefined;
    const card = db.query("SELECT 1 FROM events WHERE task_id = ? AND type = 'recovery_card'").get(taskId);

    if (cycle < 3) {
      check(!!requeue && !card, `cycle ${cycle}: auto-requeued a fresh task (attempt ${cycle}), no card yet`);
      attempts.push(taskId);
      taskId = requeue!.id;
    } else {
      // third death: the 2-requeue cap is reached → decision card, no requeue.
      check(!!card && !requeue, `cycle ${cycle}: requeue cap reached → decision card opened, no further auto-requeue`);
      const dec = db.query("SELECT status FROM decisions WHERE task_id = ? ORDER BY ts DESC LIMIT 1").get(taskId) as { status: string } | undefined;
      check(dec?.status === "open", `cycle ${cycle}: an open recovery decision card is waiting for the director`);
    }
  }

  hr("cleanup: close any stray fleet panes for this run");
  const finalAgents = await raw(["agent", "list"]);
  try {
    for (const a of JSON.parse(finalAgents.stdout).result?.agents ?? []) {
      const nm = String(a.name ?? a.agent ?? "");
      if ([t1.id, ...attempts, taskId].some((id) => nm.startsWith(id))) await raw(["pane", "close", a.pane_id]);
    }
  } catch {
    /* best effort */
  }

  server.stop(true);
  hr("RESULT");
  log(failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`);
  log("\nDONE.");
  process.exit(failures === 0 ? 0 : 1);
}

await main();
