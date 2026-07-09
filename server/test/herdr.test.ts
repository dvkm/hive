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
  expect(defaultAgentArgv("do the thing")).toEqual(["claude", "do the thing", "--permission-mode", "acceptEdits"]);

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
  expect(worktreeRemoveArgv({ worktreePath: "/wt" })).toEqual(["worktree", "remove", "--cwd", "/wt", "--force", "--json"]);

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
  expect(start.slice(start.indexOf("--") + 1)).toEqual(["claude", "Fix the bug. Definition of done: ...", "--permission-mode", "acceptEdits"]);
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
