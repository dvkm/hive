#!/usr/bin/env bun
// Command classifier for the PreToolUse hook (the auto-approval SAFETY BOUNDARY).
//
// classify() is a PURE function: given a Bash command string it returns
//   "safe"      — provably read-only / standard dev; auto-approve, no dialog.
//   "dangerous" — matches a destructive denylist; NEVER auto-allow, always
//                 escalate to the authority engine (deny beats allow).
//   "unknown"   — not provably safe; default policy escalates it too.
//
// A false "safe" on `rm -rf` is a real incident, so the rules bias hard toward
// escalation: DANGEROUS is checked against the WHOLE command first (so a
// dangerous token smuggled after `;`/`&&`/`|` still trips it), and "safe"
// requires EVERY shell segment to match the safe allowlist. Anything unrecognized
// falls to "unknown", never "safe".
//
// The import.meta.main runner reads a Claude Code PreToolUse payload on stdin and
// emits the PreToolUse decision JSON (allow/deny), calling hive's guarded-action
// gate for anything not provably safe. See hooks/install.md.

export type Decision = "safe" | "dangerous" | "unknown";
export interface Classification {
  decision: Decision;
  reason: string;
}

// Destructive / high-blast patterns. Matched against the whole command string,
// so chaining (`ok; rm -rf /`) or piping into a shell can't hide them.
const DANGEROUS: [RegExp, string][] = [
  [/(^|[\s;&|(])rm\s+(-[a-z]*\s+)*-[a-z]*[rf]/i, "recursive/forced rm"],
  [/(^|[\s;&|(])(sudo|doas)\b/i, "privilege escalation"],
  [/(curl|wget|fetch)\b[^|]*\|\s*(sudo\s+)?(sh|bash|zsh|python|perl|ruby|node)\b/i, "pipe-to-shell from network"],
  [/git\s+push\b[^\n]*(--force\b|--force-with-lease\b|(^|\s)-f(\s|$))/i, "force push"],
  [/git\s+reset\s+--hard\b/i, "hard reset (discards uncommitted work)"],
  [/git\s+clean\s+-[a-z]*[fd]/i, "git clean (deletes untracked files)"],
  [/git\s+branch\s+-[a-z]*D/i, "force-delete branch"],
  [/\bmkfs\b/i, "filesystem format"],
  [/\bdd\s+[^\n]*\bof=/i, "raw disk write (dd)"],
  [/>\s*\/dev\/(?!null\b|stdout\b|stderr\b|tty\b|zero\b|urandom\b|random\b)/i, "write to device node"],
  [/>\s*\/(etc|usr|bin|sbin|boot|sys|lib|var|opt)\//i, "write to system path"],
  [/\b(shutdown|reboot|halt|poweroff|init\s+0|init\s+6)\b/i, "power/session control"],
  [/\bchmod\s+(-[a-z]*R[a-z]*\s+)?[0-7]*777\b/i, "world-writable chmod"],
  [/\bchown\s+-[a-z]*R\b/i, "recursive chown"],
  [/\b(kill(all)?|pkill)\b/i, "process kill"],
  [/:\s*\(\s*\)\s*\{.*:\s*\|\s*:.*&\s*\}\s*;\s*:/, "fork bomb"],
  // Types/clicks into whatever has focus on the HUMAN's desktop — seen live
  // 2026-07-10 (an agent probing Korean IME via System Events keystroke).
  [/osascript\b[\s\S]*System Events/i, "desktop UI scripting (osascript)"],
  // Agents answering their own decision cards / minting authority rules defeats
  // the whole escalation model — attempted live 2026-07-10 (dec_c698522e5c30).
  [/\/api\/decisions\/[^\s"']+\/(answer|dismiss)/i, "hive decision tampering"],
  [/\/api\/authority\/rules/i, "hive authority-rule tampering"],
  [/find\b[^\n]*-(delete|exec(dir)?)\b/i, "find with -delete/-exec"],
  [/\b(drop|truncate)\s+(table|database|schema)\b/i, "SQL drop/truncate"],
  [/\bdelete\s+from\b(?![\s\S]*\bwhere\b)/i, "SQL DELETE without WHERE"],
  [/\bupdate\b[\s\S]*\bset\b(?![\s\S]*\bwhere\b)/i, "SQL UPDATE without WHERE"],
  [/\bterraform\s+(apply|destroy)\b/i, "terraform apply/destroy"],
  [/\bkubectl\s+delete\b/i, "kubectl delete"],
  [/\bhelm\s+(delete|uninstall)\b/i, "helm delete/uninstall"],
  [/(id_rsa|id_ed25519|id_ecdsa)\b/i, "private SSH key"],
  [/\.aws\/credentials\b/i, "AWS credentials file"],
  [/\.ssh\/(?!known_hosts\b|config\b)/i, "SSH key material"],
];

// Read-only / standard-dev commands. A command is "safe" only if EVERY segment
// (split on shell operators) matches one of these anchored at the segment start.
const SAFE: RegExp[] = [
  /^(ls|pwd|cat|head|tail|wc|stat|file|tree|echo|printf|date|whoami|hostname|uname|id|groups|df|du|ps|uptime|cd|dirname|basename|realpath|readlink|env)\b/,
  /^(which|type|command\s+-v)\b/,
  /^(grep|egrep|fgrep|rg|ag|find|sort|uniq|cut|nl|diff|comm|jq|column|tr|xxd|md5|md5sum|sha1sum|sha256sum)\b/,
  /^git\s+(status|diff|log|show|blame|rev-parse|ls-files|ls-tree|describe|shortlog|reflog|cat-file|for-each-ref|symbolic-ref|--version|version)\b/,
  /^git\s+(branch|tag|remote|stash|config|worktree)\s+(-v|--list|-l|--verbose|list|show|--get|--get-all)\b/,
  /^(bun|npm|pnpm|yarn|deno)\s+(test|run|--version)\b/,
  /^(node|python|python3|ruby|go|cargo|rustc|tsc|deno)\s+(--version|-v|version)\b/,
  /^(pytest|jest|vitest|mocha|tap)\b/,
  /^go\s+(test|vet|build|version|env)\b/,
  /^cargo\s+(test|build|check|clippy|--version)\b/,
  /^(make|just)\s+(test|check|build|lint)\b/,
  /^python[0-9.]*\s+-m\s+(pytest|unittest)\b/,
  /^\S+\s+(--version|--help|-h)\s*$/, // any single `<tool> --version|--help`
  /^(true|false|:)\s*$/,
];

// Split a command into segments on shell chaining/pipe operators. Naive (does
// not honour quoting), which only ever makes a safe command look UNsafe — never
// the reverse — so it stays conservative. `&` is intentionally NOT a delimiter:
// it collides with redirection syntax (`2>&1`), and a dangerous token after a
// backgrounding `&` is already caught by the whole-string DANGEROUS scan.
function segments(command: string): string[] {
  return command
    .split(/\|\||&&|;|\||\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---- sandbox waiver -------------------------------------------------------
// Destructive ops provably confined to the agent's OWN sandbox (its scratchpad
// under /tmp, macOS temp dirs, herdr worktrees) are routine cleanup, not
// incidents — every one used to open a decision card and stall the agent until
// David answered (4 cards on 2026-07-10 alone, all scratchpad rm / headless-
// chrome pkill). A waived match downgrades to "unknown", which the authority
// engine allows-and-logs — never silently, never "safe".

function sandboxRoots(env: Record<string, string | undefined>): string[] {
  const roots = ["/tmp/", "/private/tmp/", "/var/folders/"];
  if (env.HOME) roots.push(`${env.HOME}/.herdr/worktrees/`);
  return roots;
}

// Substitute $VAR / ${VAR} from a map; unknown vars stay verbatim (and later
// fail the "no unresolved $" check, keeping the command dangerous).
function subst(s: string, map: Record<string, string>): string {
  return s.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (all, a, b) => map[a ?? b] ?? all
  );
}

// Variables resolvable statically: HOME/TMPDIR from the hook's env (the agent's
// own env) plus `VAR=value` assignments made in this same command string.
function varMap(cmd: string, env: Record<string, string | undefined>): Record<string, string> {
  const map: Record<string, string> = {};
  if (env.HOME) map.HOME = env.HOME;
  if (env.TMPDIR) map.TMPDIR = env.TMPDIR;
  for (const seg of segments(cmd)) {
    const m = seg.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=("([^"]*)"|'([^']*)'|\S+)/);
    if (m) map[m[1]] = subst(m[3] ?? m[4] ?? m[2], map);
  }
  return map;
}

// True iff every target of every `rm` segment resolves to an absolute path
// inside a sandbox root — no unresolved substitution, no `..`, no relative
// paths. `rm` reached via xargs/env/etc. never waives (segment must start with rm).
function rmTargetsSandboxed(cmd: string, env: Record<string, string | undefined>): boolean {
  const map = varMap(cmd, env);
  const roots = sandboxRoots(env);
  const rmSegs = segments(cmd).filter((s) => /^rm\b/.test(s));
  if (!rmSegs.length) return false;
  // The whole-string DANGEROUS scan can also fire on an rm hidden in a non-rm
  // segment (e.g. `xargs rm -rf`); only waive when every firing segment is a
  // plain rm we can inspect.
  const rmish = segments(cmd).filter((s) => /(^|[\s;&|(])rm\s+(-[a-z]*\s+)*-[a-z]*[rf]/i.test(s));
  if (rmish.some((s) => !/^rm\b/.test(s))) return false;
  for (const seg of rmSegs) {
    const body = seg.split(/\s+[\d&]*[<>]/)[0]; // drop redirections
    for (let tok of body.split(/\s+/).slice(1)) {
      if (tok.startsWith("-")) continue;
      tok = subst(tok.replace(/["']/g, ""), map);
      if (!tok) continue;
      if (/[$`]/.test(tok)) return false; // unresolved substitution
      if (tok.includes("..")) return false; // path escape
      if (!tok.startsWith("/")) return false; // relative: can't prove
      if (!roots.some((r) => tok.startsWith(r))) return false;
    }
  }
  return true;
}

// True iff every kill/pkill segment targets the agent's own tooling: its shell
// jobs (`kill %1`), a pidfile in its sandbox (`pkill -F $SCRATCHPAD/x.pid`), a
// headless browser it launched (--headless / remote-debugging-port), or a
// process whose match pattern names a sandbox path.
// ponytail: pattern-based, so `pkill -f remote-debugging-port` could hit a
// human's debug Chrome too; scope to the agent's own port/profile if that bites.
function killTargetsSandboxed(cmd: string, env: Record<string, string | undefined>): boolean {
  const map = varMap(cmd, env);
  const roots = sandboxRoots(env);
  const killSegs = segments(cmd).filter((s) => /\b(kill(all)?|pkill)\b/i.test(s));
  if (!killSegs.length) return false;
  return killSegs.every((seg) => {
    const s = subst(seg.replace(/["']/g, ""), map);
    if (/remote-debugging-port|--headless/.test(s)) return true;
    if (roots.some((r) => s.includes(r))) return true; // pidfile or pattern in sandbox
    // `kill %1 [%2 …]` — the shell's own background jobs, nothing else.
    const body = s.split(/\s+[\d&]*[<>]/)[0];
    const targets = body.split(/\s+/).slice(1).filter((t) => !t.startsWith("-"));
    return targets.length > 0 && targets.every((t) => /^%\d+$/.test(t));
  });
}

// SQL dangerous rules (DROP/DELETE/UPDATE heuristics) are waived when the only
// SQL client in the command is sqlite3 operating on a sandboxed DB file — the
// scratchpad-copy workflow. psql/mysql (server-backed) never waive.
// ponytail: binds SQL text to the sqlite3 target only by co-occurrence in one
// command; good enough while psql/mysql are excluded.
function sqlTargetsSandboxed(cmd: string, env: Record<string, string | undefined>): boolean {
  if (/\b(psql|mysql)\b/i.test(cmd)) return false;
  const map = varMap(cmd, env);
  const roots = sandboxRoots(env);
  const sqliteSegs = segments(cmd).filter((s) => /^sqlite3\b/.test(s));
  if (!sqliteSegs.length) return false;
  return sqliteSegs.every((seg) => {
    const file = seg
      .split(/\s+/)
      .slice(1)
      .map((t) => subst(t.replace(/["']/g, ""), map))
      .find((t) => t && !t.startsWith("-"));
    return !!file && file.startsWith("/") && !file.includes("..") && !/[$`]/.test(file) &&
      roots.some((r) => file.startsWith(r));
  });
}

export function classify(
  command: string,
  env: Record<string, string | undefined> = process.env
): Classification {
  const cmd = command.trim();
  if (!cmd) return { decision: "safe", reason: "empty command" };

  for (const [rx, reason] of DANGEROUS) {
    if (!rx.test(cmd)) continue;
    if (reason === "recursive/forced rm" && rmTargetsSandboxed(cmd, env)) continue;
    if (reason === "process kill" && killTargetsSandboxed(cmd, env)) continue;
    if (reason.startsWith("SQL ") && sqlTargetsSandboxed(cmd, env)) continue;
    return { decision: "dangerous", reason };
  }

  // Command/process substitution runs code the segment scan can't see, so it
  // can never be "safe" — let it escalate.
  const hasSubshell = /\$\(|`|<\(/.test(cmd);
  const segs = segments(cmd);
  const allSafe = !hasSubshell && segs.every((seg) => SAFE.some((rx) => rx.test(seg)));
  if (allSafe) return { decision: "safe", reason: "read-only / standard dev command" };

  return { decision: "unknown", reason: "not on the safe allowlist" };
}

// ------------------------------------------------------------------ PreToolUse runner

function preToolUseOutput(permissionDecision: "allow" | "deny", reason: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision,
      permissionDecisionReason: reason,
    },
  });
}

// Ask hive's authority engine to decide a not-safe command. Fail-safe: any
// unreachability or error DENIES (never auto-allows an unclassified command).
async function escalate(
  hiveUrl: string,
  taskId: string,
  command: string,
  decision: Decision,
  reason: string
): Promise<string> {
  // Distinct action namespace so a standing rule can gate destructive commands
  // (`command.dangerous`) without touching merely-unrecognized ones (`command`).
  // Seed `command.dangerous* → require_decision` (or `deny`) to make dangerous
  // commands stop; unknown commands default-allow (logged) until a rule exists.
  const action = decision === "dangerous" ? "command.dangerous" : "command";
  try {
    const res = await fetch(`${hiveUrl}/api/tasks/${taskId}/guarded-action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, target: command, detail: `command approval (${decision}): ${reason}` }),
      signal: AbortSignal.timeout(2000),
    });
    const body: any = await res.json().catch(() => ({}));
    if (res.status === 200 && body.effect === "allow")
      return preToolUseOutput("allow", "authority engine: standing grant/rule");
    if (res.status === 403)
      return preToolUseOutput("deny", body.error || "denied by standing authority");
    if (res.status === 409)
      return preToolUseOutput(
        "deny",
        `escalated to hive decision ${body.decision_id} — waiting on the director; retry this command once approved`
      );
    return preToolUseOutput("deny", `unexpected guarded-action response (${res.status})`);
  } catch (e: any) {
    return preToolUseOutput("deny", `hive unreachable, denying for safety: ${String(e?.message ?? e)}`);
  }
}

if (import.meta.main) {
  // policy: escalate (default) | allow | prompt — governs UNKNOWN commands only.
  const policy = (process.argv[2] || "escalate") as "escalate" | "allow" | "prompt";
  let payload: any = {};
  try {
    payload = JSON.parse((await Bun.stdin.text()) || "{}");
  } catch {
    process.exit(0); // unparseable → defer to normal flow, never crash the agent
  }
  const command = payload?.tool_input?.command;
  if (typeof command !== "string") process.exit(0); // not a Bash command → defer

  const { decision, reason } = classify(command);

  if (decision === "safe") {
    console.log(preToolUseOutput("allow", reason));
    process.exit(0);
  }

  // unknown under `allow` → auto-approve; under `prompt` → defer to normal dialog.
  // DANGEROUS is never eligible for either shortcut — it always escalates.
  if (decision === "unknown") {
    if (policy === "allow") {
      console.log(preToolUseOutput("allow", "command_approval=allow: unknown command permitted"));
      process.exit(0);
    }
    if (policy === "prompt") process.exit(0); // defer to Claude Code's own prompt
  }

  const taskId = process.env.HIVE_TASK_ID;
  const hiveUrl = process.env.HIVE_URL || `http://127.0.0.1:${process.env.HIVE_PORT || 4700}`;
  if (!taskId) {
    // No hive task to escalate to: fail safe. Dangerous → deny; unknown → defer.
    if (decision === "dangerous") console.log(preToolUseOutput("deny", `blocked (${reason}); no hive task to authorize`));
    process.exit(0);
  }
  console.log(await escalate(hiveUrl, taskId, command, decision, reason));
  process.exit(0);
}
