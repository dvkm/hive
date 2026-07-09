// herdr runtime adapter. A thin subprocess layer over the `herdr` CLI; every
// method builds an argv and runs it through an injectable Exec so the whole
// thing is unit-testable without a live herdr server.
//
// Presentation rules (SPEC.md "herdr runtime adapter", verified live against
// herdr 0.7.1): agents are VISIBLE and INTERACTIVE, never invisible one-shot
// `claude -p` processes. Every hive worker is a long-running interactive
// `claude` session in a dedicated, named fleet workspace, one labelled tab per
// task (label = task id + short title), cwd = the task worktree. David can open
// herdr any time, see the whole fleet, attach to any tab, and type into it.
//
// Reference (herdr <sub>, verified live):
//   herdr worktree create --cwd PATH --branch NAME [--base REF] --json
//   herdr worktree remove (--workspace ID | --cwd PATH) [--force] --json
//   herdr workspace list                          (JSON by default; --json is REJECTED)
//   herdr workspace create --label TEXT --no-focus (JSON by default)
//   herdr tab create --workspace ID --cwd PATH --label TEXT --no-focus
//   herdr agent start <name> --cwd PATH [--workspace ID] [--tab ID] [--env K=V] --no-focus -- <argv...>
//   herdr agent send/rename/focus/get/read/wait <target> ...
// Quirks handled: agent/workspace/tab subcommands emit JSON by DEFAULT and
// reject a `--json` flag (only worktree.* accepts it); `agent get` on a missing
// target exits 0 with `{"error":{"code":"agent_not_found"}}` — aliveness must be
// PARSED, never inferred from the exit code.
import type { Exec, ExecResult } from "../exec.ts";
import { defaultExec } from "../exec.ts";

export const HERDR_BIN = process.env.HERDR_BIN || "/opt/homebrew/bin/herdr";

// The dedicated, named herdr workspace hive spawns every worker into. NOT
// "hive": herdr auto-labels a worktree's own workspace by repo name, and this
// repo is literally named `hive`, so a plain "hive" label would collide with
// (and adopt) the hive checkout's workspace — exactly the label-collision class
// priortool's 2026-07-02 self-kill incident documents. "hive-fleet" is distinct.
export const FLEET_LABEL = process.env.HIVE_FLEET_LABEL || "hive-fleet";

export class HerdrError extends Error {}

export type AgentStatus = "idle" | "working" | "blocked" | "unknown" | "gone";

export interface SpawnArgs {
  taskId: string;
  repoPath: string;
  hiveUrl: string;
  title: string; // task title, used to build the tab/agent label
  brief: string; // composed brief text; delivered as the interactive claude prompt
  branch?: string; // default hive/<taskId>
  base?: string; // base ref for the worktree
  env?: Record<string, string>; // extra env (secrets), injected as --env K=V
  agentArgv?: string[]; // command run inside the agent; per-project override (verbatim)
  // Called after the worktree exists but BEFORE the agent starts, so the caller
  // can seed the worktree (e.g. write .claude hook settings) structurally.
  prepareWorktree?: (worktreePath: string) => void | Promise<void>;
}

export interface SpawnResult {
  agent_target: string;
  worktree_path: string;
  branch: string;
  workspace_id: string | null; // the WORKTREE's own workspace (used by teardown)
  fleet_workspace_id: string | null; // the shared hive-fleet workspace the tab lives in
  tab_id: string | null;
  label: string;
}

// Tab/agent label for a task: id + short title, kept compact for the tab bar.
export function fleetLabel(taskId: string, title: string): string {
  return `${taskId} ${(title || "").trim()}`.slice(0, 60).trim();
}

// ---- pure argv builders (the unit-tested surface) ----

export function worktreeCreateArgv(repoPath: string, branch: string, base?: string): string[] {
  const a = ["worktree", "create", "--cwd", repoPath, "--branch", branch];
  if (base) a.push("--base", base);
  a.push("--json");
  return a;
}

// INTERACTIVE claude (NOT `-p`). The brief is delivered as claude's first
// prompt argument: an interactive long-running session that submits the brief
// itself, with no fragile send-text/composer-autocomplete step (the hazard
// priortool's herdr-backend doc documents). The agent stays live afterward and
// tolerates the captain attaching and typing.
export function defaultAgentArgv(brief: string): string[] {
  return ["claude", brief, "--permission-mode", "acceptEdits"];
}

export function workspaceListArgv(): string[] {
  return ["workspace", "list"];
}

export function workspaceCreateArgv(label: string): string[] {
  return ["workspace", "create", "--label", label, "--no-focus"];
}

export function tabCreateArgv(workspaceId: string, cwd: string, label: string): string[] {
  return ["tab", "create", "--workspace", workspaceId, "--cwd", cwd, "--label", label, "--no-focus"];
}

export function agentStartArgv(args: {
  taskId: string;
  worktreePath: string;
  hiveUrl: string;
  env?: Record<string, string>;
  agentArgv: string[];
  workspaceId?: string | null;
  tabId?: string | null;
}): string[] {
  const a = ["agent", "start", args.taskId, "--cwd", args.worktreePath];
  if (args.workspaceId) a.push("--workspace", args.workspaceId);
  if (args.tabId) a.push("--tab", args.tabId);
  a.push("--env", `HIVE_TASK_ID=${args.taskId}`);
  a.push("--env", `HIVE_URL=${args.hiveUrl}`);
  for (const [k, v] of Object.entries(args.env ?? {})) a.push("--env", `${k}=${v}`);
  a.push("--no-focus", "--", ...args.agentArgv);
  return a;
}

export function agentSendArgv(target: string, message: string): string[] {
  return ["agent", "send", target, message];
}

export function agentFocusArgv(target: string): string[] {
  return ["agent", "focus", target];
}

// Pane tail for evidence capture. Requests a generous line floor (herdr's
// `--lines N` returns EMPTY for small N below the pane viewport, per priortool's
// verified bug); the caller keeps whatever comes back.
export function agentReadArgv(target: string, lines = 200): string[] {
  return ["agent", "read", target, "--source", "recent", "--lines", String(lines)];
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

// Find a workspace id by label from `herdr workspace list` JSON:
// {"result":{"workspaces":[{"workspace_id":"wJ","label":"hive-fleet",...}]}}.
export function parseWorkspaceIdByLabel(stdout: string, label: string): string | null {
  try {
    const obj: any = JSON.parse(stdout);
    const list: any[] = obj.result?.workspaces ?? obj.workspaces ?? [];
    const w = list.find((x) => (x.label ?? x.custom_name) === label);
    return w ? w.workspace_id ?? w.id ?? null : null;
  } catch {
    return null;
  }
}

// Extract the workspace id from a `workspace create` response.
export function parseCreatedWorkspaceId(stdout: string): string | null {
  try {
    const r = (JSON.parse(stdout).result ?? JSON.parse(stdout)) as any;
    return r.workspace?.workspace_id ?? r.workspace?.id ?? r.workspace_id ?? null;
  } catch {
    return null;
  }
}

// Extract the tab id from a `tab create` response
// ({"result":{"tab":{"tab_id":"wJ:t2",...}}}).
export function parseTabId(stdout: string): string | null {
  try {
    const r = (JSON.parse(stdout).result ?? JSON.parse(stdout)) as any;
    return r.tab?.tab_id ?? r.tab?.id ?? r.tab_id ?? null;
  } catch {
    return null;
  }
}

// Probe result: is the agent still registered with herdr, and what is its
// status. `agent get` on a missing target exits 0 with an
// `{"error":{"code":"agent_not_found"}}` body, so aliveness is parsed, not
// inferred from the exit code. Only an explicit `agent_not_found` is treated as
// DEAD; any other error (socket hiccup, unparseable output) is treated as alive
// so a transient herdr failure never triggers a false requeue.
export function parseAgentProbe(stdout: string): { alive: boolean; status: AgentStatus } {
  let obj: any = null;
  try {
    obj = JSON.parse(stdout);
  } catch {
    return { alive: true, status: "unknown" };
  }
  if (obj?.error) {
    if (obj.error.code === "agent_not_found") return { alive: false, status: "unknown" };
    return { alive: true, status: "unknown" };
  }
  // A registered agent whose pane is gone is dead — an exited agent (the exact
  // failure this rework fixes) is reported by herdr 0.7.1 as an agent record
  // with a null pane_id, NOT always as agent_not_found. Verified live.
  const agent = obj.result?.agent;
  if (agent && !agent.pane_id) return { alive: false, status: "unknown" };
  return { alive: true, status: parseAgentStatus(stdout) };
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

  // Full spawn: worktree create -> caller worktree prep (hooks) -> ensure the
  // shared hive-fleet workspace -> labelled tab in it at the worktree cwd ->
  // start the INTERACTIVE agent into that tab -> rename the agent to match.
  // Throws HerdrError on any hard failure (worktree/agent start). Workspace/tab
  // steps degrade: if they can't be established the agent still starts (it just
  // lands in the focused workspace) so a visibility hiccup never blocks work.
  async spawn(args: SpawnArgs): Promise<SpawnResult> {
    const branch = args.branch || `hive/${args.taskId}`;
    const label = fleetLabel(args.taskId, args.title);

    const create = await this.run(worktreeCreateArgv(args.repoPath, branch, args.base));
    if (create.code !== 0)
      throw new HerdrError(`worktree create failed: ${create.stderr.trim() || create.stdout.trim()}`);
    const wt = parseWorktreeJson(create.stdout);
    if (!wt.path) throw new HerdrError(`worktree create returned no path: ${create.stdout.trim()}`);

    // Seed the worktree (hive hook settings) before the agent starts, so
    // lifecycle reporting is structural rather than brief-dependent.
    if (args.prepareWorktree) await args.prepareWorktree(wt.path);

    // Adopt-or-create the dedicated fleet workspace, then a labelled tab in it.
    const fleetWs = await this.ensureFleetWorkspace();
    let tabId: string | null = null;
    if (fleetWs) {
      const tab = await this.run(tabCreateArgv(fleetWs, wt.path, label));
      if (tab.code === 0) tabId = parseTabId(tab.stdout);
    }

    const start = await this.run(
      agentStartArgv({
        taskId: args.taskId,
        worktreePath: wt.path,
        hiveUrl: args.hiveUrl,
        env: args.env,
        agentArgv: args.agentArgv ?? defaultAgentArgv(args.brief),
        workspaceId: fleetWs,
        tabId,
      })
    );
    if (start.code !== 0)
      throw new HerdrError(`agent start failed: ${start.stderr.trim() || start.stdout.trim()}`);

    // NOTE: we deliberately do NOT `agent rename` the agent. Verified live
    // against herdr 0.7.1: renaming an agent changes its resolvable name, after
    // which `agent get <taskId>` returns agent_not_found — which would make the
    // reconciler read every renamed agent as DEAD and false-requeue it. The tab
    // is already labelled (tab create --label) for the visible "id + title"
    // affordance; the agent keeps its canonical taskId name so probe/send/focus
    // by agent_target keep resolving.

    return {
      agent_target: args.taskId,
      worktree_path: wt.path,
      branch: wt.branch ?? branch,
      workspace_id: wt.workspaceId,
      fleet_workspace_id: fleetWs,
      tab_id: tabId,
      label,
    };
  }

  // Adopt the existing hive-fleet workspace (find-before-create, like
  // priortool), else create it. `--no-focus` so a spawn never steals whatever
  // space the captain is watching. Returns null if it can't be established.
  async ensureFleetWorkspace(): Promise<string | null> {
    try {
      const list = await this.run(workspaceListArgv());
      const id = parseWorkspaceIdByLabel(list.stdout, FLEET_LABEL);
      if (id) return id;
    } catch {
      /* fall through to create */
    }
    try {
      const create = await this.run(workspaceCreateArgv(FLEET_LABEL));
      return parseCreatedWorkspaceId(create.stdout);
    } catch {
      return null;
    }
  }

  async send(target: string, message: string): Promise<ExecResult> {
    return this.run(agentSendArgv(target, message));
  }

  async focus(target: string): Promise<ExecResult> {
    return this.run(agentFocusArgv(target));
  }

  async wait(target: string, status: AgentStatus, timeoutMs: number): Promise<ExecResult> {
    return this.run(agentWaitArgv(target, status, timeoutMs));
  }

  // Probe: is the agent still registered, and its status. Never throws.
  // herdr 0.7.1 reports a vanished agent inconsistently — verified live, an
  // exited agent yields `agent_not_found` on STDERR with exit code 1, while a
  // missing target yields it on STDOUT with exit code 0, and a just-reaped pane
  // yields a pane-less agent record. All three are death; a transient/unparseable
  // result is treated as alive so a herdr hiccup never triggers a false requeue.
  async probe(target: string): Promise<{ alive: boolean; status: AgentStatus }> {
    let r: ExecResult;
    try {
      r = await this.run(agentGetArgv(target));
    } catch {
      return { alive: true, status: "unknown" }; // herdr call failed → don't assume death
    }
    if (/"agent_not_found"/.test(r.stdout) || /"agent_not_found"/.test(r.stderr))
      return { alive: false, status: "unknown" };
    return parseAgentProbe(r.stdout);
  }

  // Pane tail for stale-recovery evidence. Returns whatever herdr produced
  // (including an error body, which is itself useful evidence of the dead pane).
  async read(target: string, lines = 200): Promise<string> {
    try {
      const r = await this.run(agentReadArgv(target, lines));
      return r.stdout || r.stderr || "";
    } catch (e) {
      return `(pane read failed: ${String((e as any)?.message ?? e)})`;
    }
  }

  // Current agent status via `herdr agent get`. Returns "unknown" on any error
  // so callers (the reconciler) degrade instead of throwing.
  async status(target: string): Promise<AgentStatus> {
    const { alive, status } = await this.probe(target);
    return alive ? status : "gone";
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
