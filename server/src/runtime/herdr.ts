// herdr runtime adapter. A thin subprocess layer over the `herdr` CLI; every
// method builds an argv and runs it through an injectable Exec so the whole
// thing is unit-testable without a live herdr server. Integration with a
// running herdr happens later; here we only guarantee correct command
// construction + graceful failure.
//
// Reference (herdr <sub> --help):
//   herdr worktree create --cwd PATH --branch NAME [--base REF] --json
//   herdr worktree remove (--workspace ID | --cwd PATH) [--force] --json
//   herdr agent start <name> --cwd PATH [--env K=V ...] --no-focus -- <argv...>
//   herdr agent send <target> <text>
//   herdr agent wait <target> --status <idle|working|blocked|unknown> --timeout MS
//   herdr agent get <target>
import type { Exec, ExecResult } from "../exec.ts";
import { defaultExec } from "../exec.ts";

export const HERDR_BIN = process.env.HERDR_BIN || "/opt/homebrew/bin/herdr";

export class HerdrError extends Error {}

export type AgentStatus = "idle" | "working" | "blocked" | "unknown";

export interface SpawnArgs {
  taskId: string;
  repoPath: string;
  hiveUrl: string;
  briefFile: string;
  branch?: string; // default hive/<taskId>
  base?: string; // base ref for the worktree
  env?: Record<string, string>; // extra env (secrets), injected as --env K=V
  agentArgv?: string[]; // command run inside the agent; per-project configurable
}

export interface SpawnResult {
  agent_target: string;
  worktree_path: string;
  branch: string;
  workspace_id: string | null;
}

// ---- pure argv builders (the unit-tested surface) ----

export function worktreeCreateArgv(repoPath: string, branch: string, base?: string): string[] {
  const a = ["worktree", "create", "--cwd", repoPath, "--branch", branch];
  if (base) a.push("--base", base);
  a.push("--json");
  return a;
}

export function defaultAgentArgv(briefFile: string): string[] {
  return ["claude", "-p", briefFile, "--permission-mode", "acceptEdits"];
}

export function agentStartArgv(args: {
  taskId: string;
  worktreePath: string;
  hiveUrl: string;
  env?: Record<string, string>;
  agentArgv: string[];
}): string[] {
  const a = ["agent", "start", args.taskId, "--cwd", args.worktreePath];
  a.push("--env", `HIVE_TASK_ID=${args.taskId}`);
  a.push("--env", `HIVE_URL=${args.hiveUrl}`);
  for (const [k, v] of Object.entries(args.env ?? {})) a.push("--env", `${k}=${v}`);
  a.push("--no-focus", "--", ...args.agentArgv);
  return a;
}

export function agentSendArgv(target: string, message: string): string[] {
  return ["agent", "send", target, message];
}

export function agentWaitArgv(target: string, status: AgentStatus, timeoutMs: number): string[] {
  return ["agent", "wait", target, "--status", status, "--timeout", String(timeoutMs)];
}

export function agentGetArgv(target: string): string[] {
  return ["agent", "get", target];
}

export function worktreeRemoveArgv(ref: { workspaceId?: string | null; worktreePath?: string }): string[] {
  const a = ["worktree", "remove"];
  if (ref.workspaceId) a.push("--workspace", ref.workspaceId);
  else if (ref.worktreePath) a.push("--cwd", ref.worktreePath);
  a.push("--force", "--json");
  return a;
}

// Parse `herdr worktree create --json`. herdr 0.7.x wraps the payload in a
// `{"id":...,"result":{...}}` envelope whose `result.worktree` holds path/branch
// and `result.workspace.workspace_id` (also `worktree.open_workspace_id`) holds
// the workspace id used by `worktree remove --workspace`. Field names vary by
// herdr version, so probe a few plausible keys defensively.
export function parseWorktreeJson(stdout: string): { path: string | null; branch: string | null; workspaceId: string | null } {
  let obj: any = {};
  try {
    obj = JSON.parse(stdout);
  } catch {
    return { path: null, branch: null, workspaceId: null };
  }
  const r = obj.result ?? obj; // unwrap the 0.7.x CLI envelope
  const w = r.worktree ?? r.data ?? r;
  return {
    path: w.path ?? w.worktree_path ?? w.checkout_path ?? w.dir ?? w.root ?? null,
    branch: w.branch ?? w.branch_name ?? null,
    workspaceId:
      w.open_workspace_id ??
      w.workspace ??
      w.workspace_id ??
      w.workspaceId ??
      r.workspace?.workspace_id ??
      r.workspace?.id ??
      w.id ??
      null,
  };
}

// Map herdr's free-form agent status text onto our small enum. herdr 0.7.x
// returns `agent get` as {"result":{"agent":{"agent_status":"working",...}}}.
export function parseAgentStatus(stdout: string): AgentStatus {
  const s = stdout.toLowerCase();
  try {
    const obj = JSON.parse(stdout);
    const a = obj.result?.agent ?? obj.agent ?? obj;
    const v = String(a.agent_status ?? a.status ?? a.state ?? "").toLowerCase();
    if (v) return normalizeStatus(v);
  } catch {
    /* not JSON; fall through to substring probing */
  }
  if (/\bblocked\b/.test(s)) return "blocked";
  if (/\bworking\b|\brunning\b|\bbusy\b/.test(s)) return "working";
  if (/\bidle\b|\bdone\b|\bready\b/.test(s)) return "idle";
  return "unknown";
}

function normalizeStatus(v: string): AgentStatus {
  if (v.includes("block")) return "blocked";
  if (v.includes("work") || v.includes("run") || v.includes("busy")) return "working";
  if (v.includes("idle") || v.includes("done") || v.includes("ready")) return "idle";
  return "unknown";
}

// ---- adapter ----

export class Herdr {
  constructor(private exec: Exec = defaultExec, private bin: string = HERDR_BIN) {}

  private run(argv: string[], opts?: { input?: string }): Promise<ExecResult> {
    return this.exec([this.bin, ...argv], opts);
  }

  // worktree create + agent start. Throws HerdrError on any non-zero exit.
  async spawn(args: SpawnArgs): Promise<SpawnResult> {
    const branch = args.branch || `hive/${args.taskId}`;
    const create = await this.run(worktreeCreateArgv(args.repoPath, branch, args.base));
    if (create.code !== 0)
      throw new HerdrError(`worktree create failed: ${create.stderr.trim() || create.stdout.trim()}`);
    const wt = parseWorktreeJson(create.stdout);
    if (!wt.path) throw new HerdrError(`worktree create returned no path: ${create.stdout.trim()}`);

    const start = await this.run(
      agentStartArgv({
        taskId: args.taskId,
        worktreePath: wt.path,
        hiveUrl: args.hiveUrl,
        env: args.env,
        agentArgv: args.agentArgv ?? defaultAgentArgv(args.briefFile),
      })
    );
    if (start.code !== 0)
      throw new HerdrError(`agent start failed: ${start.stderr.trim() || start.stdout.trim()}`);

    return {
      agent_target: args.taskId,
      worktree_path: wt.path,
      branch: wt.branch ?? branch,
      workspace_id: wt.workspaceId,
    };
  }

  async send(target: string, message: string): Promise<ExecResult> {
    return this.run(agentSendArgv(target, message));
  }

  async wait(target: string, status: AgentStatus, timeoutMs: number): Promise<ExecResult> {
    return this.run(agentWaitArgv(target, status, timeoutMs));
  }

  // Current agent status via `herdr agent get`. Returns "unknown" on any error
  // so callers (the reconciler) degrade instead of throwing.
  async status(target: string): Promise<AgentStatus> {
    try {
      const r = await this.run(agentGetArgv(target));
      if (r.code !== 0) return "unknown";
      return parseAgentStatus(r.stdout);
    } catch {
      return "unknown";
    }
  }

  // Teardown: remove the worktree only after the branch is pushed or merged.
  // Verify with git; refuse (removed:false) otherwise. Never destroys work.
  async teardown(args: {
    repoPath: string;
    branch: string;
    worktreePath: string;
    workspaceId?: string | null;
    defaultBranch?: string;
  }): Promise<{ removed: boolean; reason: string }> {
    const safe = await this.branchIsSafe(args.repoPath, args.branch, args.defaultBranch ?? "main");
    if (!safe.safe) return { removed: false, reason: safe.reason };
    const r = await this.run(
      worktreeRemoveArgv({ workspaceId: args.workspaceId, worktreePath: args.worktreePath })
    );
    if (r.code !== 0)
      throw new HerdrError(`worktree remove failed: ${r.stderr.trim() || r.stdout.trim()}`);
    return { removed: true, reason: safe.reason };
  }

  // Safe to remove iff the branch is pushed to origin OR merged into the default
  // branch. Uses git directly through the same injectable exec.
  async branchIsSafe(
    repoPath: string,
    branch: string,
    defaultBranch: string
  ): Promise<{ safe: boolean; reason: string }> {
    const remote = await this.exec(["git", "-C", repoPath, "ls-remote", "--heads", "origin", branch]);
    if (remote.code === 0 && remote.stdout.trim()) return { safe: true, reason: "pushed" };

    const merged = await this.exec(["git", "-C", repoPath, "branch", "--merged", defaultBranch]);
    if (merged.code === 0) {
      const names = merged.stdout
        .split("\n")
        .map((l) => l.replace(/^[*+]?\s*/, "").trim())
        .filter(Boolean);
      if (names.includes(branch)) return { safe: true, reason: "merged" };
    }
    return { safe: false, reason: "branch not pushed to origin nor merged; refusing to remove worktree" };
  }
}

// A default instance for production wiring; tests construct their own with a stub exec.
export const herdr = new Herdr();
