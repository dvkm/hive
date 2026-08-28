// Live herdr verification harness. Drives the REAL Herdr adapter against a
// running herdr server and a throwaway git repo, printing each step so the run
// can be captured as evidence. Not part of the test suite (needs a live herdr).
//
//   bun run scripts/herdr-live-verify.ts /tmp/hive-herdr-verify
import { Herdr, HERDR_BIN } from "../server/src/runtime/herdr.ts";
import { defaultExec } from "../server/src/exec.ts";

const BIN = HERDR_BIN;
const repo = process.argv[2] || `${process.env.TEMP || process.env.TMPDIR || "/tmp"}/hive-herdr-verify`;
const h = new Herdr(defaultExec);

const log = (...a: unknown[]) => console.log(...a);
const hr = (s: string) => log(`\n===== ${s} =====`);
const ok = (b: boolean) => (b ? "PASS" : "FAIL");

async function raw(argv: string[]) {
  const r = await defaultExec([BIN, ...argv]);
  log(`$ herdr ${argv.join(" ")}\n  code=${r.code} stdout=${r.stdout.trim()} stderr=${r.stderr.trim()}`);
  return r;
}
async function git(args: string[]) {
  const r = await defaultExec(["git", ...args]);
  log(`$ git ${args.join(" ")}\n  code=${r.code} ${r.stderr.trim() || r.stdout.trim()}`);
  return r;
}

// Reset the throwaway repo + its bare origin to a clean single-commit state.
async function resetRepo() {
  await defaultExec(["bash", "-lc", `rm -rf ${repo} ${repo}-origin.git && mkdir -p ${repo}`]);
  await git(["-C", repo, "init", "-q", "-b", "main"]);
  await git(["-C", repo, "config", "user.email", "test@hive.local"]);
  await git(["-C", repo, "config", "user.name", "hive test"]);
  await defaultExec(["bash", "-lc", `echo '# throwaway' > ${repo}/README.md`]);
  await git(["-C", repo, "add", "-A"]);
  await git(["-C", repo, "commit", "-qm", "init"]);
  await git(["-C", `${repo}`, "init", "-q", "--bare", `${repo}-origin.git`]);
  await git(["-C", repo, "remote", "add", "origin", `${repo}-origin.git`]);
  await git(["-C", repo, "push", "-q", "origin", "main"]);
}

async function lifecycle(label: string, agentArgv: string[], full: boolean) {
  const taskId = "vf" + Math.random().toString(16).slice(2, 8);
  hr(`${label}: spawn (worktree create + agent start)`);
  const s = await h.spawn({ taskId, repoPath: repo, hiveUrl: "http://127.0.0.1:4700", title: label, brief: "verification run", agentArgv });
  log("SpawnResult:", JSON.stringify(s));
  log(ok(!!s.worktree_path && !!s.workspace_id), "worktree created + workspace_id captured");

  hr(`${label}: agent list (agent visible)`);
  const list = await raw(["agent", "list"]);
  const visible = list.stdout.includes(taskId);
  log(ok(visible), `agent '${taskId}' visible in agent list`);

  hr(`${label}: agent get (status readable)`);
  await raw(["agent", "get", s.agent_target]);
  const st = await h.status(s.agent_target);
  log("adapter status():", st, "-", ok(st !== undefined));

  hr(`${label}: agent send (deliver a steer message)`);
  const send = await h.send(s.agent_target, "echo steered by hive");
  log(ok(send.code === 0), "send delivered, code =", send.code);

  hr(`${label}: agent wait --status idle (short timeout; proves the blocking wait runs)`);
  const w = await h.wait(s.agent_target, "idle", 3000);
  log("wait code:", w.code, "stderr:", w.stderr.trim(), "-", ok(w.code === 0 || /timed out/.test(w.stderr)));

  if (full) {
    hr(`${label}: create UNPUSHED work in the worktree`);
    await git(["-C", s.worktree_path, "commit", "--allow-empty", "-m", "unpushed work"]);

    hr(`${label}: teardown BEFORE push (must REFUSE)`);
    const before = await h.teardown({ repoPath: repo, branch: s.branch, worktreePath: s.worktree_path, workspaceId: s.workspace_id ?? "", defaultBranch: "main" });
    log("teardown:", JSON.stringify(before), "-", ok(before.removed === false));

    hr(`${label}: push the branch (simulate merged/pushed)`);
    await git(["-C", s.worktree_path, "push", "-u", "origin", s.branch]);

    hr(`${label}: teardown AFTER push (must SUCCEED)`);
    const after = await h.teardown({ repoPath: repo, branch: s.branch, worktreePath: s.worktree_path, workspaceId: s.workspace_id ?? "", defaultBranch: "main" });
    log("teardown:", JSON.stringify(after), "-", ok(after.removed === true));

    hr(`${label}: verify worktree gone`);
    const wl = await raw(["worktree", "list", "--cwd", repo, "--json"]);
    log(ok(!wl.stdout.includes(taskId)), "worktree no longer listed");
  } else {
    // real-agent phase: don't wait for the model; just clean up.
    hr(`${label}: cleanup (push empty branch, teardown)`);
    await git(["-C", s.worktree_path, "commit", "--allow-empty", "-m", "cleanup"]);
    await git(["-C", s.worktree_path, "push", "-u", "origin", s.branch]);
    const after = await h.teardown({ repoPath: repo, branch: s.branch, worktreePath: s.worktree_path, workspaceId: s.workspace_id ?? "", defaultBranch: "main" });
    log("teardown:", JSON.stringify(after), "-", ok(after.removed === true));
  }
}

hr("0. context");
log("repo:", repo, " herdr:", BIN);
await raw(["status", "server"]);

await resetRepo();
await lifecycle("PHASE A [sleep script]", ["bash", "-lc", "echo hello from hive agent; sleep 600"], true);

await resetRepo();
await lifecycle("PHASE B [real claude -p]", ["claude", "-p", "Reply with exactly the text HIVE_OK and nothing else.", "--permission-mode", "acceptEdits"], false);

log("\nDONE.");
