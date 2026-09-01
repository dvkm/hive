// herdr runtime adapter. A thin subprocess layer over the `herdr` CLI; every
// method builds an argv and runs it through an injectable Exec so the whole
// thing is unit-testable without a live herdr server.
//
// Presentation rules (SPEC.md "herdr runtime adapter", verified live against
// herdr 0.7.1): agents are VISIBLE and INTERACTIVE, never invisible one-shot
// `claude -p` processes. Every hive worker is a long-running interactive
// `claude` session in a dedicated, named fleet workspace, one labelled tab per
// task (label = task id + short title), cwd = the task worktree. The director can open
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
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix, win32 } from "node:path";
import type { Exec, ExecResult } from "../exec.ts";
import { defaultExec, isSafeRef } from "../exec.ts";
import { toShellPath } from "../platform.ts";

// Absolute path to the hive CLI (…/repo/bin/hive from server/src/runtime/),
// handed to every spawned agent as $HIVE_CLI so `"$HIVE_CLI" emit …` works from
// any worktree — without it agents fall back to raw curl and lose CLI
// auto-attribution (source=agent, parent task), seen live 2026-07-10.
// NOT injected via PATH: overriding PATH clobbers the pane shell's user PATH
// and breaks claude/cargo/pnpm resolution (broke all spawns, 2026-07-10).
export function hiveCliPath(platform: NodeJS.Platform = process.platform): string {
  return toShellPath(join(import.meta.dir, "..", "..", "..", "bin", "hive"), platform);
}
const HIVE_CLI = hiveCliPath();

export function discoverHerdrBin(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  which: (name: string) => string | null = (name) => Bun.which(name),
  exists: (path: string) => boolean = existsSync
): string {
  if (env.HERDR_BIN) return env.HERDR_BIN;
  const home = env.USERPROFILE || env.HOME || homedir();
  const local = env.LOCALAPPDATA || win32.join(home, "AppData", "Local");
  const candidates = platform === "win32"
    ? [
        which("herdr"),
        win32.join(local, "Programs", "Herdr", "bin", "herdr.exe"),
        win32.join(home, ".local", "bin", "herdr.exe"),
      ]
    : [which("herdr"), "/opt/homebrew/bin/herdr", "/usr/local/bin/herdr", join(home, ".local", "bin", "herdr")];
  return candidates.find((candidate): candidate is string => !!candidate && exists(candidate)) ?? "herdr";
}

export const HERDR_BIN = discoverHerdrBin();

// The dedicated, named herdr workspace hive spawns every worker into. NOT
// "hive": herdr auto-labels a worktree's own workspace by repo name, and this
// repo is literally named `hive`, so a plain "hive" label would collide with
// (and adopt) the hive checkout's workspace — exactly the label-collision class
// an earlier tool's 2026-07-02 self-kill incident documents. "hive-fleet" is distinct.
export const FLEET_LABEL = process.env.HIVE_FLEET_LABEL || "hive-fleet";

export class HerdrError extends Error {
  // Set only for the "another agent holds this task's name" refusal, so callers
  // can tell contention (wait for the holder) from a real failure (HIVE-568).
  constructor(message: string, readonly nameHolder?: NameHolder) {
    super(message);
  }
}

export type AgentStatus = "idle" | "done" | "working" | "blocked" | "unknown" | "gone";

export interface SpawnArgs {
  taskId: string;
  repoPath: string;
  hiveUrl: string;
  title: string; // task title, used to build the tab/agent label
  brief: string; // composed brief text; delivered as the interactive claude prompt
  branch?: string; // default hive/<taskId>
  base?: string; // base ref for the worktree
  env?: Record<string, string>; // extra env (secrets), injected as --env K=V
  model?: string; // claude --model for the default argv (ignored when agentArgv overrides)
  agentArgv?: string[]; // command run inside the agent; per-project override (verbatim)
  // Called after the worktree exists but BEFORE the agent starts, so the caller
  // can seed the worktree (e.g. write .claude hook settings) structurally.
  prepareWorktree?: (worktreePath: string) => void | Promise<void>;
  // How long the task has been silent (no agent-generated events), when the
  // caller knows. Only used if `agent start` hits agent_name_taken: it names the
  // silence in the refusal so an operator does not have to go and measure it.
  holderQuietMs?: number;
  // The caller's half of the release decision (HIVE-552). True means "nothing
  // agent-generated has happened on this task for a whole stale window", which
  // is what makes closing a FINISHED name holder safe. herdr supplies the other
  // half (its status is `done`); both must hold or the name is left alone.
  releaseFinishedName?: boolean;
  // The operator's half (HIVE-579): `hive spawn <id> --force` means "I checked,
  // it is not running". It replaces the silence proof only — a holder herdr
  // still reports as working/idle/blocked is never closed by it.
  forceReleaseName?: boolean;
}

export interface SpawnResult {
  agent_target: string;
  worktree_path: string;
  branch: string;
  workspace_id: string | null; // the WORKTREE's own workspace (used by teardown)
  fleet_workspace_id: string | null; // the shared hive-fleet workspace the tab lives in
  tab_id: string | null;
  terminal_id: string | null; // stable pane handle; tab/pane ids are reused
  pane_id: string | null;
  label: string;
}

export interface CloseRequest {
  caller: string;
  reason: string;
  taskId: string;
}

function logClose(request: CloseRequest, targetType: "tab" | "pane" | "workspace", targetId: string): void {
  console.info(JSON.stringify({
    event: "herdr_close_request",
    caller: request.caller,
    reason: request.reason,
    task_id: request.taskId,
    target_type: targetType,
    target_id: targetId,
  }));
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
// an earlier herdr-backend doc documents). The agent stays live afterward and
// tolerates the captain attaching and typing.
export function defaultAgentArgv(brief: string, model?: string): string[] {
  // auto (was acceptEdits, director's call 2026-07-12): the model classifier judges each
  // action instead of prompting — nobody is at a worker's pane to answer, and
  // acceptEdits still let non-edit dialogs stall sessions. hive's PreToolUse
  // hook keeps first say on Bash (safe allowlist / authority escalation); auto
  // covers everything the hook doesn't explicitly decide. Per-project opt-out:
  // config.agent_argv (verbatim override).
  const a = ["claude", brief, "--permission-mode", "auto"];
  if (model) a.push("--model", model);
  return a;
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
  a.push("--env", `HIVE_CLI=${HIVE_CLI}`);
  for (const [k, v] of Object.entries(args.env ?? {})) a.push("--env", `${k}=${v}`);
  a.push("--no-focus", "--", ...args.agentArgv);
  return a;
}

export function agentSendArgv(target: string, message: string): string[] {
  return ["agent", "send", target, message];
}

// herdr `agent send` writes literal text into the composer but does NOT submit
// it — the Enter must be sent separately to the agent's pane (verified live
// 2026-07-09; also stated by herdr's own help: "agent send writes literal text").
// Without this a steer sits in the composer forever, which is exactly the bug.
export function paneSendKeysArgv(paneId: string, key: string): string[] {
  return ["pane", "send-keys", paneId, key];
}

// Pull the pane id out of an `agent get` payload so we can address send-keys.
export function parsePaneId(stdout: string): string | null {
  try {
    const obj = JSON.parse(stdout);
    const a = obj.result?.agent ?? obj.agent ?? obj;
    return (a?.pane_id as string) ?? null;
  } catch {
    return null;
  }
}

export function agentFocusArgv(target: string): string[] {
  return ["agent", "focus", target];
}

// Pane tail for evidence capture. Requests a generous line floor (herdr's
// `--lines N` returns EMPTY for small N below the pane viewport, per an earlier
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

// Does a failed `worktree create` mean "something is already at that path /
// on that branch"? Verified live against herdr 0.7.1: the JSON error body lands
// on STDERR with exit 1, but the `agent get` precedent (same body on STDOUT,
// exit 0) says never trust one stream — probe both. Matched narrowly: a generic
// `worktree_create_failed` (bad base ref, detached repo) must NOT trigger a
// reclaim, or an unrelated failure would tear down a live worktree.
export function isWorktreeExistsError(r: ExecResult): boolean {
  return /already exists|already used by worktree/.test(`${r.stdout}\n${r.stderr}`);
}

// `git worktree remove` refused because the checkout directory still holds
// files git does not know about — untracked build cache (web/.vite,
// node_modules, dist) an agent created. Git prints
// `error: failed to delete '<path>': Directory not empty`, drops the worktree
// registration anyway, and leaves the directory behind. That leftover is a
// landmine: every later `worktree add` on the path fails with `already exists`
// (22 recorded removals hit this between 2026-07-30 and 2026-08-28).
// Matches ONLY the leftover-cache condition, never `failed to delete` on its own:
// git prints that prefix for any deletion failure (permission denied, file busy,
// I/O error), and those are real problems to surface, not directories to wipe.
export function isWorktreeNotEmptyError(r: ExecResult): boolean {
  return /Directory not empty/.test(`${r.stdout}\n${r.stderr}`);
}

// Guard for the two places that clear a directory outright. Clearable only when
// the path is absolute, at least three levels deep, not the repo itself, and not
// an ancestor of the repo. That rules out `/`, `/Users`, `/Users/david` and any
// parent of the checkout; it does NOT prove the path is a worktree, so callers
// stay responsible for that (clearOrphanPath's three conditions, or a
// `worktree remove --force` that already authorised the deletion).
export function isClearableWorktreePath(repoPath: string, path: string): boolean {
  const trim = (s: string) => s.replace(/\/+$/, "");
  if (!path.startsWith("/")) return false;
  const p = trim(path);
  const repo = trim(repoPath);
  if (p === repo) return false;
  if (repo.startsWith(`${p}/`)) return false; // an ancestor of the repo — never ours
  return p.split("/").filter(Boolean).length >= 3;
}

// herdr serializes worktree operations globally; two near-simultaneous spawns
// (dispatcher + manual /spawn, or spawn racing the reaper) surface as
// `worktree_operation_in_progress` (seen 3× live). Transient by construction —
// retried once after a short wait in spawn().
export function isWorktreeBusyError(r: ExecResult): boolean {
  return /worktree_operation_in_progress|operation is already in progress/.test(
    `${r.stdout}\n${r.stderr}`
  );
}

// `agent start` failing because the task's previous agent (from a crashed or
// requeued run) still holds the name — the top recorded spawn failure (seen 9×
// live). The error body names the stale agent's pane/tab, so it can be closed
// and the start retried.
export function isAgentNameTakenError(r: ExecResult): boolean {
  return /agent_name_taken/.test(`${r.stdout}\n${r.stderr}`);
}

// The herdr control socket was unreachable — the daemon itself is down/refusing,
// NOT a task-specific failure (bad base, name taken, pty exhaustion). Surfaces
// as `ConnectionRefused` / `Os { code: 61 }` (260× live: 3 herdr outage episodes,
// hive-fleet-down-playbook). Callers treat this as an infra outage: back off
// globally instead of per-task so a dead daemon isn't pounded once per queued
// task, and don't let it inflate the failing task's exponential backoff.
export function isHerdrUnreachable(text: string): boolean {
  return /ConnectionRefused|Connection refused|ECONNREFUSED|Os \{ code:\s*61/.test(text);
}

// Pull the stale agent's tab/pane out of an agent_name_taken error body:
// "... candidates: terminal_id=… pane_id=wR:p7X workspace_id=wR tab_id=wR:t40 cwd=…"
export function parseStaleAgentRef(text: string): { tabId: string | null; paneId: string | null } {
  return {
    tabId: /\btab_id=([^\s"',}]+)/.exec(text)?.[1] ?? null,
    paneId: /\bpane_id=([^\s"',}]+)/.exec(text)?.[1] ?? null,
  };
}

// Git names the offending worktree inside its refusal, and it is the most
// direct evidence of what to reclaim:
//   fatal: '/path/to/wt' already exists
//   fatal: 'hive/x' is already used by worktree at '/path/to/wt'
// The second form is checked first: it also quotes the BRANCH before the path.
export function parseExistingWorktreePath(text: string): string | null {
  return (
    /already used by worktree at '([^']+)'/.exec(text)?.[1] ??
    /'([^']+)'\s+already exists/.exec(text)?.[1] ??
    null
  );
}

// `git worktree list --porcelain` → one record per blank-line-separated block:
//   worktree /path\nHEAD <sha>\nbranch refs/heads/hive/x
// A detached worktree has no `branch` line.
export function parseWorktreeList(porcelain: string): { path: string; branch: string | null }[] {
  const out: { path: string; branch: string | null }[] = [];
  for (const block of porcelain.trim().split(/\n\s*\n/)) {
    const path = /^worktree (.+)$/m.exec(block)?.[1];
    if (!path) continue;
    const ref = /^branch (.+)$/m.exec(block)?.[1];
    out.push({ path, branch: ref ? ref.replace(/^refs\/heads\//, "") : null });
  }
  return out;
}

// herdr worktree remove addresses WORKSPACES only (`--cwd` is not a valid
// flag here, verified against herdr 0.7.1). Workspace-less removal goes
// through git — see cleanupWorktree.
export function worktreeRemoveArgv(ref: { workspaceId: string }): string[] {
  return ["worktree", "remove", "--workspace", ref.workspaceId, "--force", "--json"];
}

// Close a whole tab (the one labelled tab per task): takes its pane and the
// agent inside it with it. herdr has no `agent stop`; the session is the tab.
export function tabCloseArgv(tabId: string): string[] {
  return ["tab", "close", tabId];
}

export function agentListArgv(): string[] {
  return ["agent", "list"];
}

// Every pane herdr holds open — one pty each. The pty leak (2026-07-25, 511/511
// twice) is held by PANES, and a dead pane has no agent, so `agent list` (which
// the old sweep watched) is blind to it. This is what the pane sweep and the
// health gauge count.
export function paneListArgv(): string[] {
  return ["pane", "list"];
}

// Re-register an already-running pane as an agent named `name`. This is how a
// live agent is RE-ADOPTED after herdr's agent registry is wiped (a desktop-app
// restart drops every agent record while the panes — and the claude processes
// in them — keep running; 2026-08-19). Verified live against herdr 0.7.1:
// report-agent makes `agent get <name>` resolve again, and when Claude Code's
// own integration later re-reports on the same pane it overwrites the
// agent/status fields while the NAME set by `agent rename` survives — so the
// placeholder self-corrects instead of masking the real status forever.
export function paneReportAgentArgv(paneId: string, name: string): string[] {
  return ["pane", "report-agent", paneId, "--source", "hive", "--agent", name, "--state", "unknown"];
}

export function agentRenameArgv(target: string, name: string): string[] {
  return ["agent", "rename", target, name];
}

export function paneProcessInfoArgv(paneId: string): string[] {
  return ["pane", "process-info", "--pane", paneId];
}

// A hive fleet tab holds TWO panes at the same worktree cwd: the tab's own root
// shell (`tab create --cwd`) and the agent's pane (`agent start --tab` splits a
// second one). Once the registry is wiped they are indistinguishable by cwd, and
// re-adopting the wrong one would wire every future steer into a bare zsh. This
// is the positive evidence that tells them apart: the pane's shell pid is
// running the agent command, not a login shell.
const LOGIN_SHELLS = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "tcsh", "csh", "powershell", "pwsh", "cmd", "nu"]);

// The pane's root foreground process: the entry matching herdr's shell_pid, or
// the first one listed. Two callers need it — paneRunsAgentCommand (agent pane
// or bare login shell?) and the name-holder refusal, which prints the pid an
// operator has to look at.
export function parsePaneRootProcess(stdout: string): { pid: number | null; name: string } | null {
  try {
    const info = (JSON.parse(stdout).result ?? {}).process_info;
    if (!info) return null;
    const procs: any[] = info.foreground_processes ?? [];
    const root = procs.find((x) => x.pid === info.shell_pid) ?? procs[0];
    if (!root) return null;
    const name = (String(root.argv0 ?? root.name ?? "").replace(/^-/, "").split(/[\\/]/).pop() ?? "")
      .replace(/\.exe$/i, "")
      .toLowerCase();
    return { pid: typeof root.pid === "number" ? root.pid : null, name };
  } catch {
    return null;
  }
}

export function paneRunsAgentCommand(stdout: string): boolean {
  const root = parsePaneRootProcess(stdout);
  return !!root?.name && !LOGIN_SHELLS.has(root.name);
}

// Stricter than paneRunsAgentCommand (which only asks "not a login shell"): a
// zombie pane's process is gone ENTIRELY, not just idled at a shell prompt, so
// an empty foreground_processes list is the signal. An unparseable/errored
// result returns true (alive) — a herdr hiccup must never be read as proof of
// death (same rule as Herdr.probe/confirmGone).
export function paneHasLiveProcess(stdout: string): boolean {
  try {
    const info = (JSON.parse(stdout).result ?? {}).process_info;
    if (!info) return true;
    const procs: any[] = info.foreground_processes ?? [];
    return procs.length > 0;
  } catch {
    return true;
  }
}

// Close a whole herdr workspace (its tabs + panes + ptys) WITHOUT removing the
// git worktree — verified live against 0.7.1: `workspace close` is a terminal-UI
// op, the checkout on disk is untouched (`herdr worktree open` re-attaches on
// demand). This is how the orphaned per-task worktree workspace that
// `worktree create` auto-spawns gets its pty back; NEVER use `worktree remove`
// for this (that one deletes the checkout).
export function workspaceCloseArgv(workspaceId: string): string[] {
  return ["workspace", "close", workspaceId];
}

export interface PaneInfo {
  paneId: string;
  tabId: string | null;
  workspaceId: string | null;
  cwd: string | null;
  // Stable for the pane's whole life, unlike tab_id/pane_id which herdr reuses
  // after a close — the id to record at spawn and address a pane by later.
  terminalId: string | null;
  // Present only while herdr's agent registry knows this pane: `label` is the
  // agent's name (hive writes the task id), `agent` its detected kind
  // ("claude"). Both vanish when a desktop-app restart wipes the registry.
  label: string | null;
  agent: string | null;
}

// `herdr pane list` → {"result":{"panes":[{pane_id,tab_id,workspace_id,cwd,...}]}}.
export function parsePaneList(stdout: string): PaneInfo[] {
  try {
    const obj: any = JSON.parse(stdout);
    const panes: any[] = obj.result?.panes ?? obj.panes ?? [];
    return panes
      .filter((p) => typeof p.pane_id === "string" && p.pane_id)
      .map((p) => ({
        paneId: p.pane_id as string,
        tabId: p.tab_id ?? p.tabId ?? null,
        workspaceId: p.workspace_id ?? p.workspaceId ?? null,
        cwd: p.cwd ?? null,
        terminalId: p.terminal_id ?? p.terminalId ?? null,
        label: p.label ?? null,
        agent: p.agent ?? null,
      }));
  } catch {
    return [];
  }
}

// `herdr agent list` (verified live):
// {"result":{"agents":[{"agent":"claude","cwd":...,"pane_id":"w6:p1",...},
// {"name":"<taskId>","cwd":...,"pane_id":"w6:p2C","tab_id":"w6:t1",...}]}}.
// Only hive-spawned agents carry `name` (agentStartArgv names the agent after
// the task id) — a bare interactive session (the director's own) has none; filter to
// the named ones so the orphan sweep never touches a human's own pane.
export function parseAgentList(stdout: string): { name: string; tabId: string | null; cwd: string | null }[] {
  try {
    const obj: any = JSON.parse(stdout);
    const agents: any[] = obj.result?.agents ?? obj.agents ?? [];
    return agents
      .filter((a) => typeof a.name === "string" && a.name)
      .map((a) => ({ name: a.name as string, tabId: a.tab_id ?? a.tabId ?? null, cwd: a.cwd ?? null }));
  } catch {
    return [];
  }
}

// `git worktree remove` failing because the path is no longer a registered
// working tree at all (already deleted from disk, or its worktree admin data
// already pruned) — as opposed to a real refusal over dirty/unmerged state.
// Nothing is lost by treating this as done: there is no tree left to preserve.
export function isWorktreeAlreadyGoneError(r: ExecResult): boolean {
  return /is not a working tree|no such file or directory/i.test(`${r.stdout}\n${r.stderr}`);
}

// Close a single pane directly (fallback when the tab id is unknown but the
// agent's pane can be resolved via `agent get`).
export function paneCloseArgv(paneId: string): string[] {
  return ["pane", "close", paneId];
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

// Did an `agent send` actually land? Same never-trust-the-exit-code quirk as
// `agent get`: sending to a vanished agent exits 0 with an
// `{"error":{"code":"agent_not_found"}}` body. Returns the failure reason, or
// null when the message was delivered. Every caller of Herdr.send must use this
// instead of `r.code === 0`.
export function sendFailure(r: ExecResult): string | null {
  if (r.code !== 0) return r.stderr.trim() || r.stdout.trim() || `herdr send exited ${r.code}`;
  try {
    const err = JSON.parse(r.stdout)?.error;
    if (err) return String(err.message ?? err.code ?? "herdr send failed");
  } catch {
    /* non-JSON stdout on exit 0 = delivered */
  }
  return null;
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
  if (/\bdone\b/.test(s)) return "done";
  if (/\bidle\b|\bready\b/.test(s)) return "idle";
  return "unknown";
}

function normalizeStatus(v: string): AgentStatus {
  if (v.includes("block")) return "blocked";
  if (v.includes("work") || v.includes("run") || v.includes("busy")) return "working";
  if (v.includes("done")) return "done";
  if (v.includes("idle") || v.includes("ready")) return "idle";
  return "unknown";
}

// ---- per-(repo,branch) worktree lock ----
// herdr serializes its OWN worktree create/remove calls internally (a single
// global lock over calls made *through* the herdr binary — the source of
// worktree_operation_in_progress above), but reclaimWorktree/cleanupWorktree
// remove worktrees by calling `git worktree remove` DIRECTLY (see their
// comments), bypassing that lock entirely. The dispatcher (spawn), reaper
// (cleanupWorktree) and reconciler (reclaimWorktree) run as independent
// setInterval loops in the same process and can hit the same branch's
// worktree concurrently — task #1151: 6 tasks hit spawn_error in a 5-minute
// window with TWO different error shapes on the SAME path in sequence
// ("Directory not empty" from --force racing a concurrent delete, then
// "is not a working tree" or worktree_operation_in_progress moments later).
// Every create/remove entry point below acquires this lock first, keyed on
// (repoPath, branch) — the identifier all of them share, and known before the
// worktree's filesystem path is (spawn's create call).
const worktreeLocks = new Map<string, Promise<unknown>>();

function withWorktreeLock<T>(repoPath: string, branch: string, fn: () => Promise<T>): Promise<T> {
  const key = `${repoPath}\0${branch}`;
  const prior = worktreeLocks.get(key) ?? Promise.resolve();
  const run = prior.then(fn, fn);
  const settled = run.then(
    () => {},
    () => {}
  );
  worktreeLocks.set(key, settled);
  settled.then(() => {
    if (worktreeLocks.get(key) === settled) worktreeLocks.delete(key);
  });
  return run;
}

// Who is holding a task's agent name, for the refusal message and the release
// decision (HIVE-552). Every field is best-effort: an unreadable holder reads as
// `unknown`, which never releases anything.
export interface NameHolder {
  status: AgentStatus;
  paneId: string | null;
  pid: number | null;
  command: string | null;
}

function humanDuration(ms: number): string {
  const mins = Math.round(ms / 60000);
  return mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
}

// One line an operator can act on. Every diagnosis of this failure started with
// pgrep because the old refusal named nothing — so name the pid first.
export function describeHolder(holder: NameHolder, quietMs?: number): string {
  return [
    holder.pid ? `pid ${holder.pid}${holder.command ? ` (${holder.command})` : ""}` : "pid unknown",
    holder.paneId ? `pane ${holder.paneId}` : null,
    `herdr status ${holder.status}`,
    quietMs === undefined ? null : `silent ${humanDuration(quietMs)}`,
  ]
    .filter(Boolean)
    .join(", ");
}

// Is the process holding the name still there? Signal 0 checks existence
// without touching the process. Only ever consulted for a pid herdr itself
// named, so pid recycling would have to hit that exact number in the seconds
// between the two reads.
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    // EPERM = a live process owned by somebody else. Alive, just not ours.
    return e?.code === "EPERM";
  }
}

// When may a spawn refused by a name holder be retried (HIVE-568)? Returns the
// ISO instant, or null when this is NOT a wait: no holder (some other failure),
// or a holder that already reports done and has been silent past the stale
// window — that one should have been reclaimable, so its refusal is a real
// failure a human must look at. Everything else is a live or not-yet-stale
// holder that will release the name on its own.
// ponytail: the wait is the remaining stale window, but polled at most every 5
// minutes so a holder that exits early is picked up without a full 15m sleep.
export function heldNameRetryAt(
  holder: NameHolder | undefined,
  quietMs: number | undefined,
  staleMs: number,
  nowMs: number
): string | null {
  if (!holder) return null;
  const quiet = quietMs ?? 0;
  if (holder.status === "done" && quiet > staleMs) return null;
  const wait = Math.min(Math.max(staleMs - quiet, 60_000), 5 * 60 * 1000);
  return new Date(nowMs + wait).toISOString();
}

// ---- adapter ----

export class Herdr {
  constructor(
    private exec: Exec = defaultExec,
    private bin: string = HERDR_BIN,
    private alive: (pid: number) => boolean = pidAlive
  ) {}

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

    const wt = await withWorktreeLock(args.repoPath, branch, () => this.createWorktreeLocked(args, branch));

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

    const startArgv = agentStartArgv({
      taskId: args.taskId,
      worktreePath: wt.path,
      hiveUrl: args.hiveUrl,
      env: args.env,
      agentArgv: args.agentArgv ?? defaultAgentArgv(args.brief, args.model),
      workspaceId: fleetWs,
      tabId,
    });
    let start = await this.run(startArgv);
    // The task's previous agent (crashed run, requeue) can still hold the name.
    // The error body names its pane/tab: close the stale session and retry once.
    if (start.code !== 0 && isAgentNameTakenError(start)) {
      const ref = parseStaleAgentRef(`${start.stdout}\n${start.stderr}`);
      const holder = await this.describeNameHolder(args.taskId, ref.paneId);
      // HIVE-552: a claude agent that has FINISHED does not exit — it idles at
      // its prompt forever, still holding the name. That refuses every respawn
      // AND strands every steer (send() already refuses a `done` agent), so the
      // task looks healthy while nobody reads its mailbox. Close the finished
      // holder and start fresh.
      //
      // INCIDENT HOTFIX 2026-08-25 (task b6fb44583e96): closing the name holder
      // UNCONDITIONALLY killed LIVE agents whenever recovery respawned a
      // quiet-but-alive task (turn-complete auto-respawn from PR #190 made this
      // constant). That is why the close now needs two independent proofs that
      // the holder is finished rather than busy: herdr says its turn is over
      // (`done` — never working/idle/blocked/unknown), and the caller says the
      // task has been silent for a whole stale window. Anything else is still
      // left strictly alone.
      //
      // HIVE-579: the liveness probe that hotfix comment was waiting for. A pid
      // herdr named that no longer exists is not ambiguous — that agent is gone
      // and its lease is a leak, so release it whatever its last status said.
      // (A finished claude does NOT exit, so an alive pid is not proof of busy;
      // that case still needs the status + silence pair, or the operator's
      // --force in place of the silence.)
      const holderDead = holder.pid !== null && !this.alive(holder.pid);
      const finishedAndReleasable =
        holder.status === "done" && (args.releaseFinishedName || args.forceReleaseName === true);
      if (holderDead || finishedAndReleasable) {
        await this.closeSession({
          agentTarget: args.taskId,
          tabId: ref.tabId,
          expectCwd: wt.path,
          request: {
            caller: "spawn",
            reason: holderDead
              ? "dead process still holding the task name"
              : "finished agent still holding the task name",
            taskId: args.taskId,
          },
        });
        start = await this.run(startArgv);
      }
      if (start.code !== 0 && isAgentNameTakenError(start))
        throw new HerdrError(
          `agent start refused: task ${args.taskId} already has an agent holding its name (possibly alive). ` +
          `Holder: ${describeHolder(holder, args.holderQuietMs)}. ` +
          `Verify it is dead (no panes, no worktree processes), then respawn with: hive spawn ${args.taskId} --force`,
          holder
        );
    }
    if (start.code !== 0)
      throw new HerdrError(`agent start failed: ${start.stderr.trim() || start.stdout.trim()}`);

    // NOTE: we deliberately do NOT `agent rename` the agent. Verified live
    // against herdr 0.7.1: renaming an agent changes its resolvable name, after
    // which `agent get <taskId>` returns agent_not_found — which would make the
    // reconciler read every renamed agent as DEAD and false-requeue it. The tab
    // is already labelled (tab create --label) for the visible "id + title"
    // affordance; the agent keeps its canonical taskId name so probe/send/focus
    // by agent_target keep resolving.

    // One extra `agent get` to record the pane's STABLE terminal id. tab/pane
    // ids are recycled by herdr; the terminal id is not, so it is what a later
    // re-adoption (readopt) and any teardown can safely address the pane by.
    const got = await this.run(agentGetArgv(args.taskId));
    const agent = (() => {
      try {
        return JSON.parse(got.stdout).result?.agent ?? null;
      } catch {
        return null;
      }
    })();

    return {
      agent_target: args.taskId,
      worktree_path: wt.path,
      branch: wt.branch ?? branch,
      workspace_id: wt.workspaceId,
      fleet_workspace_id: fleetWs,
      tab_id: tabId,
      terminal_id: agent?.terminal_id ?? null,
      pane_id: agent?.pane_id ?? null,
      label,
    };
  }

  // Read the process actually holding a task's agent name. Never throws: the
  // caller uses this to decide whether to close it, so an unreadable answer must
  // degrade to "unknown" (= leave it alone), never to a guess.
  private async describeNameHolder(target: string, paneIdHint: string | null): Promise<NameHolder> {
    try {
      const got = await this.run(agentGetArgv(target));
      const paneId = parsePaneId(got.stdout) ?? paneIdHint;
      const proc = paneId ? parsePaneRootProcess(await this.paneProcessInfo(paneId)) : null;
      return { status: parseAgentProbe(got.stdout).status, paneId, pid: proc?.pid ?? null, command: proc?.name ?? null };
    } catch {
      return { status: "unknown", paneId: paneIdHint, pid: null, command: null };
    }
  }

  // The worktree-create-and-reclaim sequence, run under spawn()'s worktree
  // lock. Split out so the lock's scope stops here — it must not cover
  // agent start / tab create, which can take up to the setup_argv hook's
  // 120s timeout and have nothing to do with git worktree metadata.
  private async createWorktreeLocked(
    args: SpawnArgs,
    branch: string
  ): Promise<{ path: string; branch: string | null; workspaceId: string | null }> {
    let base = args.base;
    if (base) {
      base = base.replace(/^origin\//, "");
      if (!isSafeRef(base)) throw new HerdrError(`invalid worktree base: ${JSON.stringify(args.base)}`);
      const remoteBase = `origin/${base}`;
      const fetched = await this.exec([
        "git", "-C", args.repoPath, "fetch", "--no-tags", "origin",
        `+refs/heads/${base}:refs/remotes/origin/${base}`,
      ]);
      if (fetched.code !== 0)
        throw new HerdrError(`base fetch failed: ${fetched.stderr.trim() || fetched.stdout.trim()}`);
      base = remoteBase;
    }
    let create = await this.run(worktreeCreateArgv(args.repoPath, branch, base));
    // herdr runs worktree ops one at a time; concurrent cross-project spawns
    // make this fail transiently. Retry with jittered backoff so simultaneous
    // contenders spread out instead of thundering-herding a single retry.
    for (let attempt = 1; create.code !== 0 && isWorktreeBusyError(create) && attempt < 5; attempt++) {
      await new Promise((r) => setTimeout(r, 500 * attempt + Math.random() * 400));
      create = await this.run(worktreeCreateArgv(args.repoPath, branch, base));
    }
    // A respawn reuses the task id, and so the branch and the worktree path. A
    // worktree left behind by a dead agent (or by a spawn that created the
    // worktree and then failed at `agent start`) collides here and, without
    // this, the dispatcher retries the same task id forever. Reclaim it —
    // preserving any uncommitted work to a ghost branch — and retry once. Real
    // commits ride on `branch` and survive the recreate.
    if (create.code !== 0 && isWorktreeExistsError(create)) {
      const rec = await this.reclaimWorktreeCore({
        repoPath: args.repoPath,
        branch,
        taskId: args.taskId,
        hintPath: parseExistingWorktreePath(`${create.stdout}\n${create.stderr}`),
      });
      if (rec.reclaimed) create = await this.run(worktreeCreateArgv(args.repoPath, branch, base));
    }
    if (create.code !== 0)
      throw new HerdrError(`worktree create failed: ${create.stderr.trim() || create.stdout.trim()}`);
    const wt = parseWorktreeJson(create.stdout);
    if (!wt.path) throw new HerdrError(`worktree create returned no path: ${create.stdout.trim()}`);
    return wt as { path: string; branch: string | null; workspaceId: string | null };
  }

  // Adopt the existing hive-fleet workspace (find-before-create, like an
  // earlier tool), else create it. `--no-focus` so a spawn never steals whatever
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

  // Steer an agent: first prove the pane still belongs to an active agent, then
  // write the text and submit it with an explicit Enter (agent send alone leaves
  // the text unsubmitted in the composer).
  //
  // The Enter is part of delivery, not a nicety: text parked in a composer was
  // never received. A pane-less agent (herdr's own signal for "dead", see
  // parseAgentProbe) or a failed send-keys therefore comes back as a FAILURE, so
  // callers queue the message instead of reporting it delivered.
  async send(target: string, message: string): Promise<ExecResult> {
    try {
      const got = await this.run(agentGetArgv(target));
      const probe = parseAgentProbe(got.stdout);
      if (probe.status === "done")
        return { code: 1, stdout: got.stdout, stderr: "agent turn is complete; respawn required" };
      if (!probe.alive || probe.status === "unknown")
        return { code: 1, stdout: got.stdout, stderr: "agent is not active; refusing to steer its shell pane" };
      const paneId = parsePaneId(got.stdout);
      if (!paneId)
        return { code: 1, stdout: got.stdout, stderr: "agent has no pane; steer left unsubmitted" };
      const sent = await this.run(agentSendArgv(target, message));
      if (sendFailure(sent)) return sent;
      const key = await this.run(paneSendKeysArgv(paneId, "Enter"));
      if (key.code !== 0)
        return { code: 1, stdout: key.stdout, stderr: key.stderr.trim() || "send-keys Enter failed" };
      return sent;
    } catch (e: any) {
      return { code: 1, stdout: "", stderr: `submit failed: ${String(e?.message ?? e)}` };
    }
  }

  async focus(target: string): Promise<ExecResult> {
    return this.run(agentFocusArgv(target));
  }

  // Answer an interactive dialog in the agent's pane by keystroke ("1" to
  // approve, "3"/"Escape" to deny, etc.). This is how a permission prompt that
  // froze an autonomous agent gets resolved from the hive board instead of
  // requiring a human at the tmux pane (2026-07-11: three agents sat blocked on
  // dialogs for hours and were failed as "silent").
  async answerDialog(target: string, key: string): Promise<ExecResult> {
    try {
      const got = await this.run(agentGetArgv(target));
      const paneId = parsePaneId(got.stdout);
      if (!paneId) return { code: 1, stdout: got.stdout, stderr: "agent has no pane" };
      const sent = await this.run(paneSendKeysArgv(paneId, key));
      if (sent.code !== 0) return sent;
      if (key === "Escape" || key === "Enter") return sent;
      return this.run(paneSendKeysArgv(paneId, "Enter"));
    } catch (e: any) {
      return { code: 1, stdout: "", stderr: String(e?.message ?? e) };
    }
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

  // Positive evidence that an agent is REALLY gone, for callers that would tear
  // something down. A `not found` probe is not proof: a herdr desktop-app
  // restart wipes the agent registry while the panes — and the claude processes
  // inside them — keep running. On 2026-08-19 every live agent read
  // agent_not_found for hours (`agent list` empty, `pane list` full) and 12+
  // tasks were failed with their tabs closed under them. Confirm against the
  // pane list: the task's own pane still being there means alive-but-
  // unregistered. An empty/unavailable pane list is NOT evidence of death
  // either — that is exactly what a down daemon looks like.
  async confirmGone(hint: { cwd?: string | null; tabId?: string | null; terminalId?: string | null }): Promise<boolean> {
    if (!hint.cwd && !hint.tabId && !hint.terminalId) return false;
    const panes = await this.listPanes();
    if (!panes.length) return false;
    return !panes.some(
      (p) =>
        (hint.terminalId && p.terminalId === hint.terminalId) ||
        (hint.cwd && p.cwd === hint.cwd) ||
        (hint.tabId && p.tabId === hint.tabId)
    );
  }

  // Re-adopt a live-but-unregistered agent: find its surviving pane and register
  // it back under `name`, so probe / send / focus / dialog handling all resolve
  // again without restarting the agent or losing its context. This is the repair
  // for the failure mode a6a4c70 only made safe: a desktop-app restart wipes
  // herdr's agent registry, `agent get` answers agent_not_found forever, and
  // hive loses every channel INTO an agent that is still working.
  //
  // Never guesses. It re-registers only a pane it can positively identify as the
  // agent's: the terminal id recorded at spawn, a surviving registry label, or —
  // when both are gone — the one pane at the task's cwd whose foreground process
  // is not a login shell (a fleet tab holds a shell pane at the same cwd).
  // `agentGone` in the result is POSITIVE evidence the agent process exited:
  // every pane at the task's cwd is sitting at a bare login shell. Absence of
  // evidence (unparseable process-info, no panes, herdr down) never sets it.
  async readopt(hint: {
    name: string;
    cwd?: string | null;
    tabId?: string | null;
    terminalId?: string | null;
  }): Promise<{ readopted: boolean; paneId: string | null; terminalId: string | null; reason: string; agentGone?: boolean }> {
    const miss = (reason: string, agentGone = false) => ({ readopted: false, paneId: null, terminalId: null, reason, agentGone });
    const panes = await this.listPanes();
    if (!panes.length) return miss("herdr returned no panes"); // daemon down, not a wipe

    let pane: PaneInfo | undefined;
    let how = "";
    if (hint.terminalId) {
      pane = panes.find((p) => p.terminalId === hint.terminalId);
      how = "terminal_id";
    }
    if (!pane) {
      pane = panes.find((p) => p.label === hint.name);
      if (pane) how = "label";
    }
    if (!pane) {
      const sameCwd = panes.filter((p) => hint.cwd && p.cwd === hint.cwd && (!hint.tabId || p.tabId === hint.tabId));
      const running: PaneInfo[] = [];
      let shells = 0; // panes we positively read as a bare login shell
      for (const p of sameCwd) {
        const info = await this.run(paneProcessInfoArgv(p.paneId));
        if (paneRunsAgentCommand(info.stdout)) running.push(p);
        else if (parsePaneRootProcess(info.stdout)) shells++;
      }
      if (running.length !== 1)
        return miss(
          `no unambiguous agent pane at cwd (${sameCwd.length} panes, ${running.length} running a command)`,
          running.length === 0 && shells === sameCwd.length && sameCwd.length > 0
        );
      pane = running[0];
      how = "cwd+process";
    }
    if (!pane) return miss("no matching pane");

    const report = await this.run(paneReportAgentArgv(pane.paneId, hint.name));
    if (report.code !== 0) return miss(`report-agent failed: ${report.stderr.trim() || report.stdout.trim()}`);
    // Pin the NAME too. The label alone is overwritten the moment Claude Code's
    // own integration reports on this pane again; the name set here survives
    // that (verified live), which is what keeps `agent get <taskId>` resolving.
    await this.run(agentRenameArgv(hint.name, hint.name));

    const probe = await this.probe(hint.name);
    if (!probe.alive) return miss("re-registered pane still does not resolve");
    return { readopted: true, paneId: pane.paneId, terminalId: pane.terminalId, reason: `matched by ${how}` };
  }

  // Pane tail for stale-recovery evidence and dialog diagnosis. herdr wraps
  // the text in a JSON envelope ({result:{read:{text}}}); return the TEXT —
  // diagnosis line-splits it, and a one-line JSON blob broke every pattern
  // match and produced JSON-headed decision cards (2026-07-11). Falls back to
  // the raw body when unparseable (an error body is itself useful evidence).
  async read(target: string, lines = 200): Promise<string> {
    try {
      const r = await this.run(agentReadArgv(target, lines));
      const raw = r.stdout || r.stderr || "";
      try {
        const text = JSON.parse(raw)?.result?.read?.text;
        if (typeof text === "string") return text;
      } catch {
        /* not an envelope — return as-is */
      }
      return raw;
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

  // Reclaim a leftover worktree so the branch can be checked out fresh.
  //
  // NEVER destroys work: if the worktree is dirty, the uncommitted state is
  // committed onto a `ghost-<taskId>` branch first, and any failure along that
  // rescue throws BEFORE the removal, leaving the worktree exactly as found. A
  // dead one-shot agent really can leave real work behind (2026-07-09).
  //
  // Removal goes through git, not herdr: `herdr worktree remove` takes only
  // `--workspace ID` (verified live against 0.7.1), and a worktree orphaned by
  // an agent death usually has no surviving herdr workspace to name.
  async reclaimWorktree(args: {
    repoPath: string;
    branch: string;
    taskId: string;
    hintPath?: string | null; // the path git named in its refusal, when known
  }): Promise<{ reclaimed: boolean; ghost_branch: string | null; path: string | null; reason: string }> {
    return withWorktreeLock(args.repoPath, args.branch, () => this.reclaimWorktreeCore(args));
  }

  // The actual reclaim, without acquiring the lock — called directly by
  // callers (spawn, cleanupWorktree) that already hold it for this
  // (repoPath, branch), so a second acquire here would deadlock.
  private async reclaimWorktreeCore(args: {
    repoPath: string;
    branch: string;
    taskId: string;
    hintPath?: string | null;
  }): Promise<{ reclaimed: boolean; ghost_branch: string | null; path: string | null; reason: string }> {
    const miss = (reason: string, path: string | null = null) => ({ reclaimed: false, ghost_branch: null, path, reason });

    const list = await this.exec(["git", "-C", args.repoPath, "worktree", "list", "--porcelain"]);
    if (list.code !== 0) return miss("git worktree list failed");

    // Trust the path git named; only fall back to the branch when it named none.
    // Resolving a hinted path by branch instead could remove a DIFFERENT
    // worktree and leave the offending one in place.
    const entries = parseWorktreeList(list.stdout);
    const wt = args.hintPath
      ? entries.find((e) => e.path === args.hintPath)
      : entries.find((e) => e.branch === args.branch);
    // An unregistered directory in the way is only cleared when it is PROVABLY
    // debris from a failed removal (see clearOrphanPath). Anything else is left
    // alone and surfaces as spawn_error — refusing beats `rm -rf` on a path we
    // cannot prove is ours.
    if (!wt) {
      if (args.hintPath && (await this.clearOrphanPath(args.repoPath, args.hintPath, entries)))
        return { reclaimed: true, ghost_branch: null, path: args.hintPath, reason: "orphaned directory cleared" };
      return miss("no registered worktree to reclaim", args.hintPath ?? null);
    }

    const status = await this.exec(["git", "-C", wt.path, "status", "--porcelain"]);
    if (status.code !== 0) return miss("git status failed in worktree", wt.path);

    let ghost: string | null = null;
    if (status.stdout.trim()) {
      ghost = await this.freeGhostBranch(args.repoPath, args.taskId);
      // Branch first, then commit: `hive/<taskId>` keeps pointing at whatever
      // the agent had already committed, so the recreate resumes from there
      // while the loose WIP lands on the ghost.
      const co = await this.exec(["git", "-C", wt.path, "checkout", "-b", ghost]);
      if (co.code !== 0) throw new HerdrError(`ghost branch ${ghost} checkout failed: ${co.stderr.trim() || co.stdout.trim()}`);
      const add = await this.exec(["git", "-C", wt.path, "add", "-A"]);
      if (add.code !== 0) throw new HerdrError(`ghost stage failed: ${add.stderr.trim() || add.stdout.trim()}`);
      // --no-verify: a repo pre-commit hook must not be able to block a rescue.
      const commit = await this.exec([
        "git", "-C", wt.path, "commit", "--no-verify", "-m", `hive: WIP rescued from ${args.taskId}`,
      ]);
      if (commit.code !== 0) throw new HerdrError(`ghost commit failed: ${commit.stderr.trim() || commit.stdout.trim()}`);
    }

    await this.unregisterBuiltApp(wt.path);

    const rm = await this.removeWorktreePath(args.repoPath, wt.path);
    if (rm.code !== 0) throw new HerdrError(`worktree remove failed: ${rm.stderr.trim() || rm.stdout.trim()}`);
    return {
      reclaimed: true,
      ghost_branch: ghost,
      path: wt.path,
      reason: ghost ? `dirty; WIP preserved on ${ghost}` : "clean; removed",
    };
  }

  // First unused `ghost-<taskId>[-N]`. A task id can be rescued more than once
  // (the dispatcher retries on a backoff), so the plain name will be taken.
  async freeGhostBranch(repoPath: string, taskId: string): Promise<string> {
    for (let n = 1; n <= 50; n++) {
      const name = n === 1 ? `ghost-${taskId}` : `ghost-${taskId}-${n}`;
      const r = await this.exec(["git", "-C", repoPath, "rev-parse", "--verify", "--quiet", `refs/heads/${name}`]);
      if (r.code !== 0) return name; // no such ref → free
    }
    throw new HerdrError(`too many ghost branches for ${taskId}`);
  }

  // Teardown: remove the worktree only after the branch is pushed or merged.
  // Verify with git; refuse (removed:false) otherwise. Never destroys work.
  // Requires a live herdr workspace id; for merged/finished tasks (workspace
  // usually gone) use cleanupWorktree, which removes via git.
  async teardown(args: {
    repoPath: string;
    branch: string;
    worktreePath: string;
    workspaceId: string;
    defaultBranch?: string;
  }): Promise<{ removed: boolean; reason: string }> {
    return withWorktreeLock(args.repoPath, args.branch, async () => {
      const safe = await this.branchIsSafe(args.repoPath, args.branch, args.defaultBranch ?? "main");
      if (!safe.safe) return { removed: false, reason: safe.reason };
      await this.unregisterBuiltApp(args.worktreePath);
      const r = await this.run(worktreeRemoveArgv({ workspaceId: args.workspaceId }));
      if (r.code !== 0)
        throw new HerdrError(`worktree remove failed: ${r.stderr.trim() || r.stdout.trim()}`);
      return { removed: true, reason: safe.reason };
    });
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

  // Delete a finished task's branch on origin. hive pushes task branches (to open
  // PRs) and nothing ever removed them, so origins accumulate them forever —
  // 500+ stale `hive/*` refs by 2026-08.
  //
  // Three guards, all required, none of which can be satisfied by a branch that
  // isn't hive's own finished work:
  //   1. the name is `hive/<taskId>` — never the default branch, never a human's
  //      branch, never a `ghost-*` WIP rescue (those hold unmerged work by
  //      definition);
  //   2. the ref actually exists on origin (a project that never pushes no-ops);
  //   3. the REMOTE tip is already an ancestor of the local default branch, i.e.
  //      the remote holds no commit the default branch doesn't. That is the same
  //      "merged" notion branchIsSafe uses, asked of the remote tip rather than
  //      the local one, so a branch that was pushed but never merged keeps its
  //      only upstream copy.
  // Never throws and never reports a failure as success: no network, no
  // permission, or an already-deleted ref all come back deleted:false with a
  // reason for the caller to log.
  async deleteRemoteBranch(args: {
    repoPath: string;
    branch: string;
    defaultBranch?: string;
  }): Promise<{ deleted: boolean; reason: string }> {
    const base = args.defaultBranch ?? "main";
    // Same shape reaper.taskIdFromBranch matches (duplicated rather than
    // imported: reaper.ts imports this file).
    if (!/^hive\/[^/]+$/.test(args.branch) || args.branch === base)
      return { deleted: false, reason: "not a hive task branch" };
    try {
      const ls = await this.exec(["git", "-C", args.repoPath, "ls-remote", "--heads", "origin", args.branch]);
      if (ls.code !== 0) return { deleted: false, reason: `ls-remote failed: ${ls.stderr.trim().slice(0, 200)}` };
      const sha = ls.stdout.trim().split(/\s+/)[0];
      if (!sha) return { deleted: false, reason: "no remote branch" };
      // Unknown sha (never fetched) fails here too — refusing beats deleting a
      // ref whose contents this clone cannot see.
      const merged = await this.exec(["git", "-C", args.repoPath, "merge-base", "--is-ancestor", sha, base]);
      if (merged.code !== 0) return { deleted: false, reason: `remote tip not merged into ${base}` };
      const del = await this.exec(["git", "-C", args.repoPath, "push", "origin", "--delete", args.branch]);
      if (del.code !== 0)
        return { deleted: false, reason: `push --delete failed: ${(del.stderr || del.stdout).trim().slice(0, 200)}` };
      return { deleted: true, reason: `merged into ${base}` };
    } catch (e: any) {
      return { deleted: false, reason: String(e?.message ?? e).slice(0, 200) };
    }
  }

  // Cleanup removal for a FINISHED task's worktree. Keeps teardown's guard (only
  // removes once the branch is pushed/merged, so committed work is safe upstream)
  // and additionally never drops uncommitted WORK: if the tree carries tracked
  // modifications, they are preserved to a ghost-<taskId> branch before removal
  // (reusing reclaimWorktree). Purely-untracked/ignored files (tooling artifacts
  // like .serena/ or the injected .claude/settings.local.json) are discarded by
  // the force removal. Removal goes through git, not herdr, because a finished
  // task's worktree usually has no surviving herdr workspace to name.
  async cleanupWorktree(args: {
    repoPath: string;
    branch: string;
    worktreePath: string;
    taskId: string;
    defaultBranch?: string;
  }): Promise<{ removed: boolean; reason: string; ghost_branch: string | null }> {
    return withWorktreeLock(args.repoPath, args.branch, () => this.cleanupWorktreeCore(args));
  }

  // `git worktree remove --force`, with the one recovery that keeps a failure
  // from leaving a landmine behind. Force-removal already discards untracked
  // files, so when git refuses only because the directory still holds build
  // cache it does not track, clearing the rest destroys nothing git was not
  // about to destroy — and NOT clearing it strands the path forever, because
  // git drops the registration regardless (HIVE-526). Every guard that decides
  // removal is allowed at all (branchIsSafe, the ghost-branch WIP rescue) has
  // already run in the callers; this only finishes the removal they asked for.
  private async removeWorktreePath(repoPath: string, path: string): Promise<ExecResult> {
    const rm = await this.exec(["git", "-C", repoPath, "worktree", "remove", "--force", path]);
    if (rm.code === 0 || !isWorktreeNotEmptyError(rm) || !isClearableWorktreePath(repoPath, path)) return rm;
    const wiped = await this.exec(["rm", "-rf", path]);
    if (wiped.code !== 0) return rm; // couldn't clear it — report the original refusal
    const pruned = await this.exec(["git", "-C", repoPath, "worktree", "prune"]);
    if (pruned.code !== 0) return rm;
    return { code: 0, stdout: `cleared untracked leftovers and pruned ${path}`, stderr: "" };
  }

  // Self-heal for debris left by an older failed removal: a directory sitting on
  // a worktree path that git no longer knows anything about. ALL THREE must
  // hold, or the path is left untouched:
  //   1. git has no worktree registered at it (`git worktree list`),
  //   2. it is not a git repository or worktree checkout of its own,
  //   3. it exists as a directory.
  // A live worktree fails (1) and (2), so it can never be cleared here.
  private async clearOrphanPath(repoPath: string, path: string, entries: { path: string }[]): Promise<boolean> {
    if (!isClearableWorktreePath(repoPath, path)) return false;
    if (entries.some((e) => e.path === path)) return false;
    const dir = await this.exec(["test", "-d", path]);
    if (dir.code !== 0) return false;
    const repo = await this.exec(["git", "-C", path, "rev-parse", "--git-dir"]);
    if (repo.code === 0) return false; // a real checkout — never ours to delete
    const wiped = await this.exec(["rm", "-rf", path]);
    if (wiped.code !== 0) return false;
    await this.exec(["git", "-C", repoPath, "worktree", "prune"]);
    return true;
  }

  // Best-effort: drop a worktree's built hive.app from LaunchServices before the
  // worktree disappears, so 'open -b dev.hive.app' / hive:// deeplinks stop being
  // able to resolve to a now-gone path (task #1288 / hive-313). Never throws: a
  // missing lsregister (non-macOS, sandboxed runner) must not block removal.
  private async unregisterBuiltApp(worktreePath: string): Promise<void> {
    try {
      await this.exec([
        "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
        "-u",
        posix.join(worktreePath.replaceAll("\\", "/"), "electron/dist/mac-arm64/hive.app"),
      ]);
    } catch {
      // ignored
    }
  }

  private async cleanupWorktreeCore(args: {
    repoPath: string;
    branch: string;
    worktreePath: string;
    taskId: string;
    defaultBranch?: string;
  }): Promise<{ removed: boolean; reason: string; ghost_branch: string | null }> {
    const safe = await this.branchIsSafe(args.repoPath, args.branch, args.defaultBranch ?? "main");
    if (!safe.safe) return { removed: false, reason: safe.reason, ghost_branch: null };

    await this.unregisterBuiltApp(args.worktreePath);

    const status = await this.exec(["git", "-C", args.worktreePath, "status", "--porcelain"]);
    const trackedDirty =
      status.code === 0 &&
      status.stdout.split("\n").some((l) => l.length > 0 && !l.startsWith("??"));

    if (trackedDirty) {
      // Real uncommitted work on an otherwise-safe branch: preserve, then remove.
      const rec = await this.reclaimWorktreeCore({
        repoPath: args.repoPath,
        branch: args.branch,
        taskId: args.taskId,
        hintPath: args.worktreePath,
      });
      return {
        removed: rec.reclaimed,
        reason: rec.reclaimed ? `${safe.reason}; WIP preserved on ${rec.ghost_branch}` : rec.reason,
        ghost_branch: rec.ghost_branch,
      };
    }

    const rm = await this.removeWorktreePath(args.repoPath, args.worktreePath);
    if (rm.code !== 0) {
      // Task #341: the worktree was already gone from disk (e.g. removed
      // outside hive) — there's nothing left to preserve, so this must NOT
      // read as "preserved" to the caller (cleanupTask), or the herdr session
      // is kept alive forever guarding a tree that no longer exists.
      if (isWorktreeAlreadyGoneError(rm))
        return { removed: true, reason: `${safe.reason}; worktree already gone from disk`, ghost_branch: null };
      return { removed: false, reason: `worktree remove failed: ${rm.stderr.trim() || rm.stdout.trim()}`, ghost_branch: null };
    }
    return { removed: true, reason: safe.reason, ghost_branch: null };
  }

  // Close a finished task's herdr "session": the labelled tab (which takes its
  // pane + agent with it), falling back to closing the agent's pane directly.
  // Best-effort and never throws — a visibility hiccup must not break cleanup.
  async closeSession(args: {
    agentTarget?: string | null;
    tabId?: string | null;
    request: CloseRequest;
    // Verify the tab still holds THIS task before closing it. Either is enough.
    expectTerminalId?: string | null;
    expectCwd?: string | null;
  }): Promise<{ closed: boolean; via: string | null; refused?: string }> {
    let refused: string | undefined;
    try {
      if (args.tabId) {
        // herdr REUSES tab ids after a close, so a tab id recorded at spawn can
        // by then belong to a DIFFERENT task's agent — closing it blind is how a
        // teardown kills a stranger's live session. When the caller knows what
        // the tab should hold, prove the occupant first and otherwise fall
        // through to the agent's own pane, which resolves by name.
        const expect = args.expectTerminalId || args.expectCwd;
        const held = expect ? (await this.listPanes()).filter((p) => p.tabId === args.tabId) : [];
        const stranger =
          !!expect &&
          held.length > 0 &&
          !held.every(
            (p) =>
              (args.expectTerminalId && p.terminalId === args.expectTerminalId) ||
              (args.expectCwd && p.cwd === args.expectCwd)
          );
        if (stranger) refused = `tab ${args.tabId} no longer holds ${expect}`;
        else {
          logClose(args.request, "tab", args.tabId);
          const r = await this.run(tabCloseArgv(args.tabId));
          if (r.code === 0) return { closed: true, via: `tab ${args.tabId}` };
        }
      }
      if (args.agentTarget) {
        const got = await this.run(agentGetArgv(args.agentTarget));
        const paneId = parsePaneId(got.stdout);
        if (paneId) {
          logClose(args.request, "pane", paneId);
          const r = await this.run(paneCloseArgv(paneId));
          if (r.code === 0) return { closed: true, via: `pane ${paneId}` };
        }
      }
    } catch {
      /* best-effort */
    }
    return { closed: false, via: null, ...(refused ? { refused } : {}) };
  }

  // Every hive-spawned agent herdr currently knows about, named by task id
  // (see agentStartArgv). The reaper diffs this against live DB tasks to sweep
  // sessions the worktree-branch sweep can't see — e.g. a task row that no
  // longer exists at all (task #341: 5 of 6 stale agents found manually had
  // zero corresponding DB task). Never throws: an empty list degrades to "sweep
  // found nothing this cycle", not a crash.
  async listAgents(): Promise<{ name: string; tabId: string | null }[]> {
    try {
      const r = await this.run(agentListArgv());
      return parseAgentList(r.stdout);
    } catch {
      return [];
    }
  }

  // Every pane herdr holds — one pty each. The pane sweep (reaper.ts) diffs this
  // against live DB tasks to reclaim leaked ptys that `agent list` can't see
  // (dead panes, orphaned worktree workspaces). Never throws: an empty list
  // degrades to "nothing to sweep", not a crash.
  async listPanes(): Promise<PaneInfo[]> {
    try {
      const r = await this.run(paneListArgv());
      return parsePaneList(r.stdout);
    } catch {
      return [];
    }
  }

  // Raw `pane process-info` output for one pane, for callers that judge
  // liveness themselves (paneHasLiveProcess/paneRunsAgentCommand). Never
  // throws: an empty result reads as "unknown" to those parsers, which treat
  // unparseable input as alive.
  async paneProcessInfo(paneId: string): Promise<string> {
    try {
      const r = await this.run(paneProcessInfoArgv(paneId));
      return r.stdout;
    } catch {
      return "";
    }
  }

  // Close one exact pane by id — used by the zombie-pane sweep, which already
  // has the paneId from `pane list` and has verified zero processes at it
  // (unlike closeSession, there is no tab/workspace/agentTarget to resolve).
  async closePane(paneId: string, request: CloseRequest): Promise<{ closed: boolean }> {
    try {
      logClose(request, "pane", paneId);
      const r = await this.run(paneCloseArgv(paneId));
      return { closed: r.code === 0 };
    } catch {
      return { closed: false };
    }
  }

  // Close a worktree's own herdr workspace (reclaims its pty) without touching
  // the checkout. Best-effort; a stale/already-closed id just returns non-zero.
  async closeWorkspace(args: { workspaceId: string; expectCwd: string; request: CloseRequest }): Promise<ExecResult> {
    const held = (await this.listPanes()).filter((pane) => pane.workspaceId === args.workspaceId);
    if (held.length > 0 && !held.every((pane) => pane.cwd === args.expectCwd)) {
      return { code: 1, stdout: "", stderr: `refused workspace ${args.workspaceId}: not owned by task ${args.request.taskId}` };
    }
    logClose(args.request, "workspace", args.workspaceId);
    return this.run(workspaceCloseArgv(args.workspaceId));
  }

  // Resolve the shared fleet workspace id READ-ONLY (never creates it, unlike
  // ensureFleetWorkspace). The pane sweep needs it to tell a fleet tab (close
  // the tab) from a worktree's own workspace (close the whole workspace), and to
  // guarantee it never `workspace close`s the fleet itself. null if absent.
  async fleetWorkspaceId(): Promise<string | null> {
    try {
      const list = await this.run(workspaceListArgv());
      return parseWorkspaceIdByLabel(list.stdout, FLEET_LABEL);
    } catch {
      return null;
    }
  }
}

// A default instance for production wiring; tests construct their own with a stub exec.
export const herdr = new Herdr();
