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
import { join } from "node:path";
import type { Exec, ExecResult } from "../exec.ts";
import { defaultExec } from "../exec.ts";

// Absolute path to the hive CLI (…/repo/bin/hive from server/src/runtime/),
// handed to every spawned agent as $HIVE_CLI so `"$HIVE_CLI" emit …` works from
// any worktree — without it agents fall back to raw curl and lose CLI
// auto-attribution (source=agent, parent task), seen live 2026-07-10.
// NOT injected via PATH: overriding PATH clobbers the pane shell's user PATH
// and breaks claude/cargo/pnpm resolution (broke all spawns, 2026-07-10).
const HIVE_CLI = join(import.meta.dir, "..", "..", "..", "bin", "hive");

export const HERDR_BIN = process.env.HERDR_BIN || "/opt/homebrew/bin/herdr";

// The dedicated, named herdr workspace hive spawns every worker into. NOT
// "hive": herdr auto-labels a worktree's own workspace by repo name, and this
// repo is literally named `hive`, so a plain "hive" label would collide with
// (and adopt) the hive checkout's workspace — exactly the label-collision class
// firstmate's 2026-07-02 self-kill incident documents. "hive-fleet" is distinct.
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
// firstmate's herdr-backend doc documents). The agent stays live afterward and
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
// `--lines N` returns EMPTY for small N below the pane viewport, per firstmate's
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

    let create = await this.run(worktreeCreateArgv(args.repoPath, branch, args.base));
    // A respawn reuses the task id, and so the branch and the worktree path. A
    // worktree left behind by a dead agent (or by a spawn that created the
    // worktree and then failed at `agent start`) collides here and, without
    // this, the dispatcher retries the same task id forever. Reclaim it —
    // preserving any uncommitted work to a ghost branch — and retry once. Real
    // commits ride on `branch` and survive the recreate.
    if (create.code !== 0 && isWorktreeExistsError(create)) {
      const rec = await this.reclaimWorktree({
        repoPath: args.repoPath,
        branch,
        taskId: args.taskId,
        hintPath: parseExistingWorktreePath(`${create.stdout}\n${create.stderr}`),
      });
      if (rec.reclaimed) create = await this.run(worktreeCreateArgv(args.repoPath, branch, args.base));
    }
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
  // firstmate), else create it. `--no-focus` so a spawn never steals whatever
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

  // Steer an agent: write the text, then submit it with an explicit Enter to the
  // agent's pane (agent send alone leaves the text unsubmitted in the composer).
  //
  // The Enter is part of delivery, not a nicety: text parked in a composer was
  // never received. A pane-less agent (herdr's own signal for "dead", see
  // parseAgentProbe) or a failed send-keys therefore comes back as a FAILURE, so
  // callers queue the message instead of reporting it delivered.
  async send(target: string, message: string): Promise<ExecResult> {
    const sent = await this.run(agentSendArgv(target, message));
    if (sendFailure(sent)) return sent;
    try {
      const got = await this.run(agentGetArgv(target));
      const paneId = parsePaneId(got.stdout);
      if (!paneId)
        return { code: 1, stdout: got.stdout, stderr: "agent has no pane; steer left unsubmitted" };
      const key = await this.run(paneSendKeysArgv(paneId, "Enter"));
      if (key.code !== 0)
        return { code: 1, stdout: key.stdout, stderr: key.stderr.trim() || "send-keys Enter failed" };
    } catch (e: any) {
      return { code: 1, stdout: "", stderr: `submit failed: ${String(e?.message ?? e)}` };
    }
    // ponytail: single Enter, no composer-state verify. Add a read-back +
    // Enter-retry (firstmate's fm-send pattern) if swallowed-Enter recurs.
    return sent;
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
    // ponytail: an unregistered directory in the way is left alone — refusing
    // beats `rm -rf` on a path we cannot prove is ours. Surfaces as spawn_error.
    if (!wt) return miss("no registered worktree to reclaim", args.hintPath ?? null);

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

    const rm = await this.exec(["git", "-C", args.repoPath, "worktree", "remove", "--force", wt.path]);
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
    const safe = await this.branchIsSafe(args.repoPath, args.branch, args.defaultBranch ?? "main");
    if (!safe.safe) return { removed: false, reason: safe.reason };
    const r = await this.run(worktreeRemoveArgv({ workspaceId: args.workspaceId }));
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
    const safe = await this.branchIsSafe(args.repoPath, args.branch, args.defaultBranch ?? "main");
    if (!safe.safe) return { removed: false, reason: safe.reason, ghost_branch: null };

    const status = await this.exec(["git", "-C", args.worktreePath, "status", "--porcelain"]);
    const trackedDirty =
      status.code === 0 &&
      status.stdout.split("\n").some((l) => l.length > 0 && !l.startsWith("??"));

    if (trackedDirty) {
      // Real uncommitted work on an otherwise-safe branch: preserve, then remove.
      const rec = await this.reclaimWorktree({
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

    const rm = await this.exec(["git", "-C", args.repoPath, "worktree", "remove", "--force", args.worktreePath]);
    if (rm.code !== 0)
      return { removed: false, reason: `worktree remove failed: ${rm.stderr.trim() || rm.stdout.trim()}`, ghost_branch: null };
    return { removed: true, reason: safe.reason, ghost_branch: null };
  }

  // Close a finished task's herdr "session": the labelled tab (which takes its
  // pane + agent with it), falling back to closing the agent's pane directly.
  // Best-effort and never throws — a visibility hiccup must not break cleanup.
  async closeSession(args: {
    agentTarget?: string | null;
    tabId?: string | null;
  }): Promise<{ closed: boolean; via: string | null }> {
    try {
      if (args.tabId) {
        const r = await this.run(tabCloseArgv(args.tabId));
        if (r.code === 0) return { closed: true, via: `tab ${args.tabId}` };
      }
      if (args.agentTarget) {
        const got = await this.run(agentGetArgv(args.agentTarget));
        const paneId = parsePaneId(got.stdout);
        if (paneId) {
          const r = await this.run(paneCloseArgv(paneId));
          if (r.code === 0) return { closed: true, via: `pane ${paneId}` };
        }
      }
    } catch {
      /* best-effort */
    }
    return { closed: false, via: null };
  }
}

// A default instance for production wiring; tests construct their own with a stub exec.
export const herdr = new Herdr();
