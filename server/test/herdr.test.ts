import { test, expect } from "bun:test";
import type { Exec, ExecResult } from "../src/exec.ts";
import {
  Herdr,
  worktreeCreateArgv,
  agentStartArgv,
  agentSendArgv,
  agentWaitArgv,
  agentFocusArgv,
  agentReadArgv,
  worktreeRemoveArgv,
  isWorktreeExistsError,
  parseExistingWorktreePath,
  parseWorktreeList,
  workspaceListArgv,
  workspaceCreateArgv,
  tabCreateArgv,
  defaultAgentArgv,
  fleetLabel,
  parseWorktreeJson,
  parseWorkspaceIdByLabel,
  parseCreatedWorkspaceId,
  parseTabId,
  parseAgentProbe,
  parseAgentStatus,
  paneSendKeysArgv,
  parsePaneId,
  parseStaleAgentRef,
  isAgentNameTakenError,
  isWorktreeBusyError,
  agentListArgv,
  parseAgentList,
  isWorktreeAlreadyGoneError,
  paneListArgv,
  parsePaneList,
  workspaceCloseArgv,
} from "../src/runtime/herdr.ts";

// A recording stub: canned results per matched argv, records every call.
function stubExec(handler: (argv: string[], input?: string) => ExecResult): { exec: Exec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: Exec = async (argv, opts) => {
    calls.push(argv);
    return handler(argv, opts?.input);
  };
  return { exec, calls };
}

const OK = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const FAIL = (stderr = "boom"): ExecResult => ({ code: 1, stdout: "", stderr });

test("argv builders construct the documented herdr commands", () => {
  expect(worktreeCreateArgv("/repo", "hive/abc")).toEqual([
    "worktree", "create", "--cwd", "/repo", "--branch", "hive/abc", "--json",
  ]);
  expect(worktreeCreateArgv("/repo", "hive/abc", "main")).toContain("--base");

  // INTERACTIVE claude: the brief is claude's first prompt arg, never `-p`.
  expect(defaultAgentArgv("do the thing")).toEqual(["claude", "do the thing", "--permission-mode", "auto"]);

  // Fleet workspace + labelled tab builders (JSON is default; no --json flag).
  expect(workspaceListArgv()).toEqual(["workspace", "list"]);
  expect(workspaceCreateArgv("hive-fleet")).toEqual(["workspace", "create", "--label", "hive-fleet", "--no-focus"]);
  expect(tabCreateArgv("wF", "/wt", "t1 fix bug")).toEqual([
    "tab", "create", "--workspace", "wF", "--cwd", "/wt", "--label", "t1 fix bug", "--no-focus",
  ]);

  const start = agentStartArgv({
    taskId: "t1",
    worktreePath: "/wt",
    hiveUrl: "http://h",
    env: { API_KEY: "v" },
    agentArgv: ["claude", "brief text"],
    workspaceId: "wF",
    tabId: "wF:t2",
  });
  expect(start.slice(0, 5)).toEqual(["agent", "start", "t1", "--cwd", "/wt"]);
  expect(start).toContain("--workspace");
  expect(start).toContain("wF");
  expect(start).toContain("--tab");
  expect(start).toContain("wF:t2");
  expect(start).toContain("HIVE_TASK_ID=t1");
  expect(start).toContain("HIVE_URL=http://h");
  expect(start).toContain("API_KEY=v");
  expect(start).toContain("--no-focus");
  // the agent argv comes after the `--` separator
  expect(start.slice(start.indexOf("--") + 1)).toEqual(["claude", "brief text"]);

  expect(agentSendArgv("t1", "hello")).toEqual(["agent", "send", "t1", "hello"]);
  expect(agentFocusArgv("t1")).toEqual(["agent", "focus", "t1"]);
  expect(agentReadArgv("t1")).toEqual(["agent", "read", "t1", "--source", "recent", "--lines", "200"]);
  expect(agentWaitArgv("t1", "idle", 5000)).toEqual(["agent", "wait", "t1", "--status", "idle", "--timeout", "5000"]);
  expect(worktreeRemoveArgv({ workspaceId: "w1" })).toEqual(["worktree", "remove", "--workspace", "w1", "--force", "--json"]);

  expect(fleetLabel("abc123", "Add dark mode toggle")).toBe("abc123 Add dark mode toggle");
});

test("parseWorktreeJson probes several key shapes", () => {
  expect(parseWorktreeJson('{"path":"/wt","branch":"hive/x","workspace":"w1"}')).toEqual({
    path: "/wt", branch: "hive/x", workspaceId: "w1",
  });
  expect(parseWorktreeJson('{"worktree":{"worktree_path":"/wt2","id":"w2"}}').path).toBe("/wt2");
  expect(parseWorktreeJson("not json")).toEqual({ path: null, branch: null, workspaceId: null });
});

test("workspace/tab parse helpers unwrap the herdr envelopes", () => {
  const list = '{"result":{"workspaces":[{"workspace_id":"w6","label":"firstmate"},{"workspace_id":"wF","label":"hive-fleet"}]}}';
  expect(parseWorkspaceIdByLabel(list, "hive-fleet")).toBe("wF");
  expect(parseWorkspaceIdByLabel(list, "nope")).toBeNull();
  expect(parseCreatedWorkspaceId('{"result":{"workspace":{"workspace_id":"wG"}}}')).toBe("wG");
  expect(parseTabId('{"result":{"tab":{"tab_id":"wF:t2"}}}')).toBe("wF:t2");
});

test("agentListArgv + parseAgentList: only named (hive-spawned) agents survive, David's own session is filtered out", () => {
  expect(agentListArgv()).toEqual(["agent", "list"]);
  // Real shape from docs/evidence/herdr-live-verification.txt: David's own
  // interactive session has no `name`; a hive-spawned worker does (= task id).
  const stdout = JSON.stringify({
    id: "cli:agent:list",
    result: {
      agents: [
        { agent: "claude", cwd: "/Users/david/projects/firstmate", pane_id: "w6:p1", tab_id: "w6:t1", agent_status: "working" },
        { name: "vfeabd2a", cwd: "/wt/hive-vfeabd2a", pane_id: "w6:p2C", tab_id: "w6:t1", agent_status: "unknown" },
      ],
      type: "agent_list",
    },
  });
  expect(parseAgentList(stdout)).toEqual([{ name: "vfeabd2a", tabId: "w6:t1", cwd: "/wt/hive-vfeabd2a" }]);
  expect(parseAgentList("garbage")).toEqual([]);
  expect(parseAgentList('{"result":{"agents":[]}}')).toEqual([]);
});

test("paneListArgv + workspaceCloseArgv + parsePaneList: the pty-leak sweep surface", () => {
  expect(paneListArgv()).toEqual(["pane", "list"]);
  expect(workspaceCloseArgv("w11S")).toEqual(["workspace", "close", "w11S"]);
  // Real shape from `herdr pane list` (live 0.7.1).
  const stdout = JSON.stringify({
    id: "cli:pane:list",
    result: {
      panes: [
        { pane_id: "w11S:p1", tab_id: "w11S:t1", workspace_id: "w11S", cwd: "/wt/hive-5ba4edd2f39d", agent_status: "unknown", terminal_id: "term_1" },
        { pane_id: "wR:p2", tab_id: "wR:t2", workspace_id: "wR", cwd: "/wt/hive-222a5d0a2b73", terminal_id: "term_2", label: "222a5d0a2b73", agent: "claude" },
        { agent_status: "idle" }, // no pane_id → dropped
      ],
      type: "pane_list",
    },
  });
  expect(parsePaneList(stdout)).toEqual([
    { paneId: "w11S:p1", tabId: "w11S:t1", workspaceId: "w11S", cwd: "/wt/hive-5ba4edd2f39d", terminalId: "term_1", label: null, agent: null },
    { paneId: "wR:p2", tabId: "wR:t2", workspaceId: "wR", cwd: "/wt/hive-222a5d0a2b73", terminalId: "term_2", label: "222a5d0a2b73", agent: "claude" },
  ]);
  expect(parsePaneList("garbage")).toEqual([]);
  expect(parsePaneList('{"result":{"panes":[]}}')).toEqual([]);
});

test("isWorktreeAlreadyGoneError matches a removal failure with nothing left to preserve", () => {
  expect(isWorktreeAlreadyGoneError({ code: 1, stdout: "", stderr: "fatal: '/wt/x' is not a working tree" })).toBe(true);
  expect(isWorktreeAlreadyGoneError({ code: 1, stdout: "", stderr: "No such file or directory" })).toBe(true);
  expect(isWorktreeAlreadyGoneError({ code: 1, stdout: "", stderr: "fatal: validation failed, cannot remove the current working tree" })).toBe(false);
});

test("parseAgentProbe detects the two death shapes; conservative otherwise", () => {
  // shape 1: herdr reaped the agent entirely
  expect(parseAgentProbe('{"error":{"code":"agent_not_found","message":"..."}}')).toEqual({ alive: false, status: "unknown" });
  // shape 2: agent record lingers but its pane is gone (exited agent)
  expect(parseAgentProbe('{"result":{"agent":{"agent_status":"unknown"}}}')).toEqual({ alive: false, status: "unknown" });
  // some other error is NOT treated as death (transient herdr hiccup)
  expect(parseAgentProbe('{"error":{"code":"socket_error"}}')).toEqual({ alive: true, status: "unknown" });
  // a live agent has a pane
  expect(parseAgentProbe('{"result":{"agent":{"agent_status":"working","pane_id":"w6:p2"}}}')).toEqual({ alive: true, status: "working" });
  expect(parseAgentProbe("garbage")).toEqual({ alive: true, status: "unknown" });
});

test("parseAgentStatus maps herdr status onto the enum", () => {
  expect(parseAgentStatus('{"status":"blocked"}')).toBe("blocked");
  expect(parseAgentStatus("agent is working on it")).toBe("working");
  expect(parseAgentStatus("idle")).toBe("idle");
  expect(parseAgentStatus("???")).toBe("unknown");
});

test("spawn builds the visible interactive fleet: worktree, fleet workspace, labelled tab, interactive agent", async () => {
  const has = (argv: string[], ...xs: string[]) => xs.every((x) => argv.includes(x));
  const { exec, calls } = stubExec((argv) => {
    if (has(argv, "worktree", "create")) return OK('{"result":{"worktree":{"path":"/wt/hive-t1","branch":"hive/t1","open_workspace_id":"w9"}}}');
    if (has(argv, "workspace", "list")) return OK('{"result":{"workspaces":[{"workspace_id":"wF","label":"hive-fleet"}]}}');
    if (has(argv, "tab", "create")) return OK('{"result":{"tab":{"tab_id":"wF:t2"}}}');
    // spawn reads the started agent back once, to record its STABLE terminal id.
    if (has(argv, "agent", "get")) return OK('{"result":{"agent":{"pane_id":"wF:p3","terminal_id":"term_t1"}}}');
    return OK("started");
  });
  const h = new Herdr(exec, "herdr");
  let prepared: string | null = null;
  const res = await h.spawn({
    taskId: "t1",
    repoPath: "/repo",
    hiveUrl: "http://127.0.0.1:4700",
    title: "Fix the bug",
    brief: "Fix the bug. Definition of done: ...",
    env: { TOKEN: "sekret" },
    prepareWorktree: (p) => { prepared = p; },
  });
  expect(res).toEqual({
    agent_target: "t1",
    worktree_path: "/wt/hive-t1",
    branch: "hive/t1",
    workspace_id: "w9",
    fleet_workspace_id: "wF",
    tab_id: "wF:t2",
    terminal_id: "term_t1",
    pane_id: "wF:p3",
    label: "t1 Fix the bug",
  });
  // prepareWorktree ran with the created worktree path, before agent start.
  expect(prepared).toBe("/wt/hive-t1");
  // adopts the existing hive-fleet workspace (no workspace create call).
  expect(calls.some((c) => has(c, "workspace", "create"))).toBe(false);
  // creates a labelled tab in the fleet workspace at the worktree cwd.
  const tab = calls.find((c) => has(c, "tab", "create"))!;
  expect(tab).toContain("--label");
  expect(tab).toContain("t1 Fix the bug");
  // starts the agent into that workspace/tab with an INTERACTIVE claude (no -p).
  const start = calls.find((c) => has(c, "agent", "start"))!;
  expect(start).toContain("--workspace");
  expect(start).toContain("wF:t2");
  expect(start).toContain("TOKEN=sekret");
  expect(start.slice(start.indexOf("--") + 1)).toEqual(["claude", "Fix the bug. Definition of done: ...", "--permission-mode", "auto"]);
  expect(start).not.toContain("-p");
  // does NOT rename the agent: rename breaks agent_target resolution (verified
  // live), so the tab label carries the "id + title", not the agent name.
  expect(calls.some((c) => has(c, "agent", "rename"))).toBe(false);
});

test("spawn creates the fleet workspace when none exists yet", async () => {
  const has = (argv: string[], ...xs: string[]) => xs.every((x) => argv.includes(x));
  const { exec, calls } = stubExec((argv) => {
    if (has(argv, "worktree", "create")) return OK('{"result":{"worktree":{"path":"/wt/x","branch":"hive/x","open_workspace_id":"w1"}}}');
    if (has(argv, "workspace", "list")) return OK('{"result":{"workspaces":[]}}');
    if (has(argv, "workspace", "create")) return OK('{"result":{"workspace":{"workspace_id":"wNEW"}}}');
    if (has(argv, "tab", "create")) return OK('{"result":{"tab":{"tab_id":"wNEW:t1"}}}');
    return OK();
  });
  const h = new Herdr(exec, "herdr");
  const res = await h.spawn({ taskId: "x", repoPath: "/repo", hiveUrl: "u", title: "t", brief: "b" });
  expect(res.fleet_workspace_id).toBe("wNEW");
  expect(calls.some((c) => has(c, "workspace", "create"))).toBe(true);
});

test("spawn throws when worktree create fails", async () => {
  const { exec } = stubExec(() => FAIL("no repo"));
  const h = new Herdr(exec, "herdr");
  expect(
    h.spawn({ taskId: "t1", repoPath: "/repo", hiveUrl: "u", title: "t", brief: "b" })
  ).rejects.toThrow(/worktree create failed/);
});

test("probe/read/focus wrap the herdr calls and never throw on a dead agent", async () => {
  const { exec } = stubExec((argv) => {
    if (argv.includes("get")) return OK('{"error":{"code":"agent_not_found"}}');
    if (argv.includes("read")) return OK('{"error":{"code":"agent_not_found"}}');
    if (argv.includes("focus")) return OK("focused");
    return OK();
  });
  const h = new Herdr(exec, "herdr");
  expect(await h.probe("gone")).toEqual({ alive: false, status: "unknown" });
  expect(await h.status("gone")).toBe("gone");
  expect(typeof (await h.read("gone"))).toBe("string");
  expect((await h.focus("gone")).code).toBe(0);
});

test("probe detects an exited agent whose agent_not_found lands on stderr (code 1)", async () => {
  // herdr 0.7.1: an agent that EXITED reports not-found on STDERR with code 1.
  const exec: Exec = async () => ({ code: 1, stdout: "", stderr: '{"error":{"code":"agent_not_found","message":"gone"},"id":"cli:agent:get"}' });
  const h = new Herdr(exec, "herdr");
  expect(await h.probe("exited")).toEqual({ alive: false, status: "unknown" });
  expect(await h.status("exited")).toBe("gone");
});

test("teardown refuses when the branch is neither pushed nor merged", async () => {
  const { exec, calls } = stubExec((argv) => {
    if (argv[0] === "git" && argv.includes("ls-remote")) return OK(""); // not pushed
    if (argv[0] === "git" && argv.includes("--merged")) return OK("* main\n  other"); // not merged
    return OK();
  });
  const h = new Herdr(exec, "herdr");
  const r = await h.teardown({ repoPath: "/repo", branch: "hive/t1", worktreePath: "/wt", workspaceId: "w9" });
  expect(r.removed).toBe(false);
  // it never called `worktree remove`
  expect(calls.some((c) => c.includes("remove"))).toBe(false);
});

test("teardown removes the worktree once the branch is pushed", async () => {
  const { exec, calls } = stubExec((argv) => {
    if (argv[0] === "git" && argv.includes("ls-remote")) return OK("abc123\trefs/heads/hive/t1"); // pushed
    return OK("removed");
  });
  const h = new Herdr(exec, "herdr");
  const r = await h.teardown({ repoPath: "/repo", branch: "hive/t1", worktreePath: "/wt", workspaceId: "w9" });
  expect(r.removed).toBe(true);
  expect(r.reason).toBe("pushed");
  expect(calls.some((c) => c.includes("remove"))).toBe(true);
});

test("teardown accepts a merged branch even when unpushed", async () => {
  const { exec } = stubExec((argv) => {
    if (argv[0] === "git" && argv.includes("ls-remote")) return OK(""); // not pushed
    if (argv[0] === "git" && argv.includes("--merged")) return OK("  main\n  hive/t1"); // merged
    return OK("removed");
  });
  const h = new Herdr(exec, "herdr");
  const r = await h.teardown({ repoPath: "/repo", branch: "hive/t1", worktreePath: "/wt" });
  expect(r.removed).toBe(true);
  expect(r.reason).toBe("merged");
});

test("send proves the agent is active, then writes text and submits Enter", async () => {
  const { exec, calls } = stubExec((argv) => {
    if (argv.includes("agent") && argv.includes("get"))
      return OK(JSON.stringify({ result: { agent: { pane_id: "wR:p7", agent_status: "idle" } } }));
    return OK("ok");
  });
  const h = new Herdr(exec, "herdr");
  await h.send("t1", "hello world");
  // 1) active agent resolved, 2) text written, 3) Enter submitted to that pane.
  // calls include the bin name at [0]; assert on the argv tail.
  expect(calls[0].slice(1)).toEqual(["agent", "get", "t1"]);
  expect(calls.some((c) => c[1] === "agent" && c[2] === "send" && c[3] === "t1")).toBe(true);
  const enter = calls.find((c) => c[1] === "pane" && c[2] === "send-keys");
  expect(enter?.slice(1)).toEqual(["pane", "send-keys", "wR:p7", "Enter"]);
});

test("send refuses to type into an unknown shell pane", async () => {
  const { exec, calls } = stubExec((argv) => {
    if (argv.includes("agent") && argv.includes("get"))
      return OK('{"result":{"agent":{"pane_id":"wR:p7","agent_status":"unknown"}}}');
    return OK("ok");
  });
  const h = new Herdr(exec, "herdr");
  const result = await h.send("t1", "hi");
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("not active");
  expect(calls.some((c) => c[1] === "agent" && c[2] === "send")).toBe(false);
  expect(calls.some((c) => c[1] === "pane")).toBe(false);
});

test("answerDialog sends Escape without submitting Enter", async () => {
  const { exec, calls } = stubExec((argv) => {
    if (argv.includes("agent") && argv.includes("get"))
      return OK('{"result":{"agent":{"pane_id":"wR:p7","agent_status":"done"}}}');
    return OK("ok");
  });
  const h = new Herdr(exec, "herdr");
  await h.answerDialog("t1", "Escape");
  const keys = calls.filter((c) => c[1] === "pane" && c[2] === "send-keys").map((c) => c[4]);
  expect(keys).toEqual(["Escape"]);
});

// ---- leftover-worktree reclaim (respawn on a reused task id) ----

// A tiny world: a leftover worktree for hive/t1 is in the way until something
// removes it. Models the exact herdr/git surface verified live against 0.7.1 —
// `worktree create` refusing with the offending path quoted in a JSON error on
// STDERR (exit 1), and removal going through git, not herdr.
const WT = "/wt/hive-t1";
const EXISTS: ExecResult = {
  code: 1,
  stdout: "",
  stderr: `{"error":{"code":"worktree_create_failed","message":"Preparing worktree\\nfatal: '${WT}' already exists"},"id":"cli:worktree:create"}`,
};
const has = (argv: string[], ...xs: string[]) => xs.every((x) => argv.includes(x));

function leftoverWorld(o: { dirty?: boolean; ghosts?: string[]; commitFails?: boolean } = {}) {
  const calls: string[][] = [];
  const ghosts = new Set(o.ghosts ?? []);
  let present = true; // the leftover worktree
  const exec: Exec = async (argv) => {
    calls.push(argv);
    const git = argv[0] === "git";
    if (argv[0] === "herdr" && has(argv, "worktree", "create"))
      return present ? EXISTS : OK(`{"result":{"worktree":{"path":"${WT}","branch":"hive/t1","open_workspace_id":"w1"}}}`);
    if (git && has(argv, "worktree", "list"))
      return OK(present ? `worktree ${WT}\nHEAD abc123\nbranch refs/heads/hive/t1\n` : "");
    if (git && has(argv, "status", "--porcelain")) return OK(o.dirty ? " M src/a.ts\n?? new.txt\n" : "");
    if (git && has(argv, "rev-parse", "--verify"))
      return ghosts.has(argv[argv.length - 1].replace("refs/heads/", "")) ? OK("sha") : FAIL("");
    if (git && has(argv, "commit")) return o.commitFails ? FAIL("pre-commit rejected") : OK();
    if (git && has(argv, "worktree", "remove")) {
      present = false;
      return OK();
    }
    if (has(argv, "workspace", "list")) return OK('{"result":{"workspaces":[{"workspace_id":"wF","label":"hive-fleet"}]}}');
    if (has(argv, "tab", "create")) return OK('{"result":{"tab":{"tab_id":"wF:t2"}}}');
    return OK();
  };
  return { exec, calls };
}

const spawnT1 = (h: Herdr) => h.spawn({ taskId: "t1", repoPath: "/repo", hiveUrl: "http://h", title: "T", brief: "b" });
const idx = (calls: string[][], ...xs: string[]) => calls.findIndex((c) => has(c, ...xs));

test("parses git's already-exists refusals and the porcelain worktree list", () => {
  expect(isWorktreeExistsError(EXISTS)).toBe(true);
  expect(isWorktreeExistsError(FAIL("fatal: invalid reference: nope"))).toBe(false);
  expect(parseExistingWorktreePath(EXISTS.stderr)).toBe(WT);
  // the branch-in-use form quotes the branch FIRST, then the path
  expect(parseExistingWorktreePath("fatal: 'hive/x' is already used by worktree at '/wt/other'")).toBe("/wt/other");
  expect(parseExistingWorktreePath("fatal: some other failure")).toBe(null);

  expect(parseWorktreeList("worktree /a\nHEAD s1\nbranch refs/heads/hive/x\n\nworktree /b\nHEAD s2\ndetached\n")).toEqual([
    { path: "/a", branch: "hive/x" },
    { path: "/b", branch: null },
  ]);
});

test("spawn removes a CLEAN leftover worktree and retries create", async () => {
  const { exec, calls } = leftoverWorld({ dirty: false });
  const r = await spawnT1(new Herdr(exec, "herdr"));

  expect(r.worktree_path).toBe(WT);
  // create ran twice: refused, reclaimed, succeeded
  expect(calls.filter((c) => c[0] === "herdr" && has(c, "worktree", "create")).length).toBe(2);
  expect(calls.some((c) => c[0] === "git" && has(c, "worktree", "remove", "--force", WT))).toBe(true);
  // nothing to preserve → no ghost branch
  expect(calls.some((c) => has(c, "checkout", "-b"))).toBe(false);
});

test("spawn preserves a DIRTY leftover worktree to a ghost branch before removing it", async () => {
  const { exec, calls } = leftoverWorld({ dirty: true });
  const r = await spawnT1(new Herdr(exec, "herdr"));

  expect(r.worktree_path).toBe(WT);
  expect(calls.some((c) => has(c, "checkout", "-b", "ghost-t1"))).toBe(true);
  expect(calls.some((c) => has(c, "commit", "--no-verify", "hive: WIP rescued from t1"))).toBe(true);
  // the rescue lands BEFORE the removal, never after
  expect(idx(calls, "commit", "--no-verify")).toBeLessThan(idx(calls, "worktree", "remove"));
});

test("a taken ghost branch does not collide: the next free name is used", async () => {
  const { exec, calls } = leftoverWorld({ dirty: true, ghosts: ["ghost-t1", "ghost-t1-2"] });
  await spawnT1(new Herdr(exec, "herdr"));
  expect(calls.some((c) => has(c, "checkout", "-b", "ghost-t1-3"))).toBe(true);
});

test("a failed WIP rescue NEVER removes the worktree", async () => {
  const { exec, calls } = leftoverWorld({ dirty: true, commitFails: true });
  await expect(spawnT1(new Herdr(exec, "herdr"))).rejects.toThrow(/ghost commit failed/);
  expect(calls.some((c) => has(c, "worktree", "remove"))).toBe(false); // work still on disk
});

test("an unrelated create failure is never treated as a leftover worktree", async () => {
  const { exec, calls } = stubExec(() => FAIL('{"error":{"code":"worktree_create_failed","message":"invalid base ref"}}'));
  await expect(spawnT1(new Herdr(exec, "herdr"))).rejects.toThrow(/worktree create failed/);
  expect(calls.some((c) => c[0] === "git")).toBe(false); // no reclaim attempted at all
});

test("reclaim refuses to touch a directory git does not track as a worktree", async () => {
  // Path in the way, but unregistered: refuse rather than rm -rf something unproven.
  const { exec, calls } = stubExec((argv) => (has(argv, "worktree", "list") ? OK("") : OK()));
  const r = await new Herdr(exec, "herdr").reclaimWorktree({ repoPath: "/repo", branch: "hive/t1", taskId: "t1", hintPath: WT });
  expect(r).toEqual({ reclaimed: false, ghost_branch: null, path: WT, reason: "no registered worktree to reclaim" });
  expect(calls.some((c) => has(c, "worktree", "remove"))).toBe(false);
});

test("defaultAgentArgv pins the model when one is given", () => {
  expect(defaultAgentArgv("b", "sonnet")).toEqual(["claude", "b", "--permission-mode", "auto", "--model", "sonnet"]);
  expect(defaultAgentArgv("b")).toEqual(["claude", "b", "--permission-mode", "auto"]); // unpinned stays unpinned
});

test("spawn passes SpawnArgs.model into the interactive claude argv", async () => {
  const has = (argv: string[], ...xs: string[]) => xs.every((x) => argv.includes(x));
  const { exec, calls } = stubExec((argv) => {
    if (has(argv, "worktree", "create")) return OK('{"result":{"worktree":{"path":"/wt/m","branch":"hive/m","open_workspace_id":"w1"}}}');
    if (has(argv, "workspace", "list")) return OK('{"result":{"workspaces":[{"workspace_id":"wF","label":"hive-fleet"}]}}');
    if (has(argv, "tab", "create")) return OK('{"result":{"tab":{"tab_id":"wF:t3"}}}');
    return OK("started");
  });
  const h = new Herdr(exec, "herdr");
  await h.spawn({ taskId: "m", repoPath: "/repo", hiveUrl: "u", title: "t", brief: "b", model: "opus" });
  const start = calls.find((c) => has(c, "agent", "start"))!;
  expect(start.slice(start.indexOf("--") + 1)).toEqual(["claude", "b", "--permission-mode", "auto", "--model", "opus"]);
});

test("agent_name_taken error parsing", () => {
  const body = '{"error":{"code":"agent_name_taken","message":"agent name x is already used; candidates: terminal_id=term_1 pane_id=wR:p7X workspace_id=wR tab_id=wR:t40 cwd=/x"}}';
  expect(isAgentNameTakenError({ code: 1, stdout: "", stderr: body })).toBe(true);
  expect(isAgentNameTakenError({ code: 1, stdout: "", stderr: "boom" })).toBe(false);
  expect(parseStaleAgentRef(body)).toEqual({ tabId: "wR:t40", paneId: "wR:p7X" });
  expect(parseStaleAgentRef("no ids here")).toEqual({ tabId: null, paneId: null });
});

test("spawn closes the stale agent's tab and retries once on agent_name_taken", async () => {
  const has = (argv: string[], ...xs: string[]) => xs.every((x) => argv.includes(x));
  let starts = 0;
  const { exec, calls } = stubExec((argv) => {
    if (has(argv, "worktree", "create")) return OK('{"result":{"worktree":{"path":"/wt/x","branch":"hive/x","open_workspace_id":"w1"}}}');
    if (has(argv, "workspace", "list")) return OK('{"result":{"workspaces":[{"workspace_id":"wF","label":"hive-fleet"}]}}');
    if (has(argv, "tab", "create")) return OK('{"result":{"tab":{"tab_id":"wF:t9"}}}');
    if (has(argv, "agent", "start")) {
      starts++;
      if (starts === 1)
        return FAIL('{"error":{"code":"agent_name_taken","message":"agent name x is already used; candidates: terminal_id=term_1 pane_id=wR:p7X workspace_id=wR tab_id=wR:t40 cwd=/x"}}');
      return OK("started");
    }
    return OK();
  });
  const h = new Herdr(exec, "herdr");
  const res = await h.spawn({ taskId: "x", repoPath: "/repo", hiveUrl: "u", title: "t", brief: "b" });
  expect(res.agent_target).toBe("x");
  expect(starts).toBe(2);
  expect(calls.some((c) => has(c, "tab", "close", "wR:t40"))).toBe(true);
});

test("spawn retries once when herdr's worktree op lock is busy", async () => {
  const has = (argv: string[], ...xs: string[]) => xs.every((x) => argv.includes(x));
  let creates = 0;
  const { exec } = stubExec((argv) => {
    if (has(argv, "worktree", "create")) {
      creates++;
      if (creates === 1) return FAIL('{"error":{"code":"worktree_operation_in_progress","message":"worktree operation is already in progress"}}');
      return OK('{"result":{"worktree":{"path":"/wt/y","branch":"hive/y","open_workspace_id":"w1"}}}');
    }
    if (has(argv, "workspace", "list")) return OK('{"result":{"workspaces":[{"workspace_id":"wF","label":"hive-fleet"}]}}');
    if (has(argv, "tab", "create")) return OK('{"result":{"tab":{"tab_id":"wF:t4"}}}');
    return OK("started");
  });
  const h = new Herdr(exec, "herdr");
  const res = await h.spawn({ taskId: "y", repoPath: "/repo", hiveUrl: "u", title: "t", brief: "b" });
  expect(res.worktree_path).toBe("/wt/y");
  expect(creates).toBe(2);
  expect(isWorktreeBusyError({ code: 1, stdout: "", stderr: "boom" })).toBe(false);
}, 10_000);

// ---- task #1151: per-(repo,branch) worktree lock ----
// reclaimWorktree/cleanupWorktree remove a worktree via raw `git worktree
// remove`, bypassing herdr's own create/remove serialization. Two callers
// (e.g. dispatcher spawn retry + reconciler dead-agent reclaim) racing the
// SAME worktree produced the incident's two-different-errors-in-sequence
// signature. These tests prove the fix's actual invariant: `git worktree
// remove` for the same (repoPath, branch) never runs concurrently, while
// unrelated branches are never needlessly serialized against each other.

test("worktree lock: two concurrent reclaims of the SAME worktree never overlap on git worktree remove", async () => {
  const has = (argv: string[], ...xs: string[]) => xs.every((x) => argv.includes(x));
  let removeInFlight = 0;
  let maxRemoveInFlight = 0;
  let present = true;
  const exec: Exec = async (argv) => {
    const git = argv[0] === "git";
    if (git && has(argv, "worktree", "list")) return OK(present ? `worktree ${WT}\nHEAD s1\nbranch refs/heads/hive/t1\n` : "");
    if (git && has(argv, "status", "--porcelain")) return OK("");
    if (git && has(argv, "worktree", "remove")) {
      removeInFlight++;
      maxRemoveInFlight = Math.max(maxRemoveInFlight, removeInFlight);
      await new Promise((r) => setTimeout(r, 20)); // widen the race window
      present = false;
      removeInFlight--;
      return OK();
    }
    return OK();
  };
  const h = new Herdr(exec, "herdr");
  const [a, b] = await Promise.all([
    h.reclaimWorktree({ repoPath: "/repo", branch: "hive/t1", taskId: "t1", hintPath: WT }),
    h.reclaimWorktree({ repoPath: "/repo", branch: "hive/t1", taskId: "t1", hintPath: WT }),
  ]);
  expect(maxRemoveInFlight).toBe(1); // never two `git worktree remove` calls in flight together
  // exactly one caller actually found and removed it; the other, running after
  // the lock frees, sees it already gone and no-ops gracefully instead of
  // racing git's metadata mid-removal.
  expect([a.reclaimed, b.reclaimed].filter(Boolean).length).toBe(1);
});

test("worktree lock: reclaims of DIFFERENT branches are not serialized against each other", async () => {
  const has = (argv: string[], ...xs: string[]) => xs.every((x) => argv.includes(x));
  let removeInFlight = 0;
  let maxRemoveInFlight = 0;
  const exec: Exec = async (argv) => {
    const git = argv[0] === "git";
    if (git && has(argv, "worktree", "list"))
      return OK("worktree /wt/a\nHEAD s1\nbranch refs/heads/hive/a\n\nworktree /wt/b\nHEAD s2\nbranch refs/heads/hive/b\n");
    if (git && has(argv, "status", "--porcelain")) return OK("");
    if (git && has(argv, "worktree", "remove")) {
      removeInFlight++;
      maxRemoveInFlight = Math.max(maxRemoveInFlight, removeInFlight);
      await new Promise((r) => setTimeout(r, 20));
      removeInFlight--;
      return OK();
    }
    return OK();
  };
  const h = new Herdr(exec, "herdr");
  const [a, b] = await Promise.all([
    h.reclaimWorktree({ repoPath: "/repo", branch: "hive/a", taskId: "a", hintPath: "/wt/a" }),
    h.reclaimWorktree({ repoPath: "/repo", branch: "hive/b", taskId: "b", hintPath: "/wt/b" }),
  ]);
  expect(maxRemoveInFlight).toBe(2); // different branches run concurrently, not queued behind each other
  expect(a.reclaimed).toBe(true);
  expect(b.reclaimed).toBe(true);
});

test("worktree lock: a spawn's own leftover-reclaim never overlaps a concurrent reconciler reclaim on the same branch", async () => {
  const has = (argv: string[], ...xs: string[]) => xs.every((x) => argv.includes(x));
  let removeInFlight = 0;
  let maxRemoveInFlight = 0;
  let present = true;
  const exec: Exec = async (argv) => {
    const git = argv[0] === "git";
    if (argv[0] === "herdr" && has(argv, "worktree", "create"))
      return present ? EXISTS : OK(`{"result":{"worktree":{"path":"${WT}","branch":"hive/t1","open_workspace_id":"w1"}}}`);
    if (git && has(argv, "worktree", "list")) return OK(present ? `worktree ${WT}\nHEAD abc\nbranch refs/heads/hive/t1\n` : "");
    if (git && has(argv, "status", "--porcelain")) return OK("");
    if (git && has(argv, "worktree", "remove")) {
      removeInFlight++;
      maxRemoveInFlight = Math.max(maxRemoveInFlight, removeInFlight);
      await new Promise((r) => setTimeout(r, 20));
      present = false;
      removeInFlight--;
      return OK();
    }
    if (has(argv, "workspace", "list")) return OK('{"result":{"workspaces":[{"workspace_id":"wF","label":"hive-fleet"}]}}');
    if (has(argv, "tab", "create")) return OK('{"result":{"tab":{"tab_id":"wF:t1"}}}');
    return OK("started");
  };
  const h = new Herdr(exec, "herdr");
  // spawnT1 hits the leftover and reclaims it internally; a concurrent
  // reconciler-style reclaimWorktree call for the same branch races it —
  // exactly #1151's shape (dispatcher retry vs. reaper/reconciler).
  await Promise.all([
    spawnT1(h),
    h.reclaimWorktree({ repoPath: "/repo", branch: "hive/t1", taskId: "t1", hintPath: WT }).catch(() => null),
  ]);
  expect(maxRemoveInFlight).toBe(1);
});
