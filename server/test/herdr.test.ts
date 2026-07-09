import { test, expect } from "bun:test";
import type { Exec, ExecResult } from "../src/exec.ts";
import {
  Herdr,
  worktreeCreateArgv,
  agentStartArgv,
  agentSendArgv,
  agentWaitArgv,
  worktreeRemoveArgv,
  defaultAgentArgv,
  parseWorktreeJson,
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

  expect(defaultAgentArgv("/b.md")).toEqual(["claude", "-p", "/b.md", "--permission-mode", "acceptEdits"]);

  const start = agentStartArgv({
    taskId: "t1",
    worktreePath: "/wt",
    hiveUrl: "http://h",
    env: { API_KEY: "v" },
    agentArgv: ["claude", "-p", "/b.md"],
  });
  expect(start.slice(0, 5)).toEqual(["agent", "start", "t1", "--cwd", "/wt"]);
  expect(start).toContain("HIVE_TASK_ID=t1");
  expect(start).toContain("HIVE_URL=http://h");
  expect(start).toContain("API_KEY=v");
  expect(start).toContain("--no-focus");
  // the agent argv comes after the `--` separator
  expect(start.slice(start.indexOf("--") + 1)).toEqual(["claude", "-p", "/b.md"]);

  expect(agentSendArgv("t1", "hello")).toEqual(["agent", "send", "t1", "hello"]);
  expect(agentWaitArgv("t1", "idle", 5000)).toEqual(["agent", "wait", "t1", "--status", "idle", "--timeout", "5000"]);
  expect(worktreeRemoveArgv({ workspaceId: "w1" })).toEqual(["worktree", "remove", "--workspace", "w1", "--force", "--json"]);
  expect(worktreeRemoveArgv({ worktreePath: "/wt" })).toEqual(["worktree", "remove", "--cwd", "/wt", "--force", "--json"]);
});

test("parseWorktreeJson probes several key shapes", () => {
  expect(parseWorktreeJson('{"path":"/wt","branch":"hive/x","workspace":"w1"}')).toEqual({
    path: "/wt", branch: "hive/x", workspaceId: "w1",
  });
  expect(parseWorktreeJson('{"worktree":{"worktree_path":"/wt2","id":"w2"}}').path).toBe("/wt2");
  expect(parseWorktreeJson("not json")).toEqual({ path: null, branch: null, workspaceId: null });
});

test("parseAgentStatus maps herdr status onto the enum", () => {
  expect(parseAgentStatus('{"status":"blocked"}')).toBe("blocked");
  expect(parseAgentStatus("agent is working on it")).toBe("working");
  expect(parseAgentStatus("idle")).toBe("idle");
  expect(parseAgentStatus("???")).toBe("unknown");
});

test("spawn creates worktree then starts the agent with injected env", async () => {
  const { exec, calls } = stubExec((argv) => {
    if (argv.includes("create")) return OK('{"path":"/wt/hive-t1","branch":"hive/t1","workspace":"w9"}');
    return OK("started");
  });
  const h = new Herdr(exec, "herdr");
  const res = await h.spawn({
    taskId: "t1",
    repoPath: "/repo",
    hiveUrl: "http://127.0.0.1:4700",
    briefFile: "/briefs/t1.md",
    env: { TOKEN: "sekret" },
  });
  expect(res).toEqual({ agent_target: "t1", worktree_path: "/wt/hive-t1", branch: "hive/t1", workspace_id: "w9" });
  // two herdr invocations, both prefixed by the bin
  expect(calls[0][0]).toBe("herdr");
  expect(calls[0]).toContain("create");
  expect(calls[1]).toContain("start");
  expect(calls[1]).toContain("TOKEN=sekret");
});

test("spawn throws when worktree create fails", async () => {
  const { exec } = stubExec(() => FAIL("no repo"));
  const h = new Herdr(exec, "herdr");
  expect(
    h.spawn({ taskId: "t1", repoPath: "/repo", hiveUrl: "u", briefFile: "/b.md" })
  ).rejects.toThrow(/worktree create failed/);
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
