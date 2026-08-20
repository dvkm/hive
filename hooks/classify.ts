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
// The import.meta.main runner reads a Claude Code or Codex PreToolUse /
// PermissionRequest payload on stdin and emits the matching decision JSON,
// calling hive's guarded-action gate for anything not provably safe.

export type Decision = "safe" | "dangerous" | "unknown";
export interface Classification {
  decision: Decision;
  reason: string;
}

// Destructive / high-blast patterns. Matched against the whole command string,
// so chaining (`ok; rm -rf /`) or piping into a shell can't hide them.
const DANGEROUS: [RegExp, string][] = [
  [/(^|[\s;&|("'])rm\s+(-[a-z]*\s+)*-[a-z]*[rf]/i, "recursive/forced rm"],
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
  [/find\b[^\n]*-(delete|exec(dir)?)\b/i, "find with -delete/-exec"],
  [/\b(drop|truncate)\s+(table|database|schema)\b/i, "SQL drop/truncate"],
  [/\bdelete\s+from\b(?![\s\S]*\bwhere\b)/i, "SQL DELETE without WHERE"],
  [/\bupdate\b[\s\S]*\bset\b(?![\s\S]*\bwhere\b)/i, "SQL UPDATE without WHERE"],
  [/\bterraform\s+(apply|destroy)\b/i, "terraform apply/destroy"],
  [/\bkubectl\s+delete\b/i, "kubectl delete"],
  [/\bhelm\s+(delete|uninstall)\b/i, "helm delete/uninstall"],
];

// Rules whose evidence is an ARGUMENT (a URL, a file path) rather than
// executable shell text — matched against the RAW command, never the
// data-stripped scan target (the argument is usually quoted).
const DANGEROUS_RAW: [RegExp, string][] = [
  // Agents answering their own decision cards / minting authority rules defeats
  // the whole escalation model — attempted live 2026-07-10 (dec_c698522e5c30).
  [/\/api\/decisions\/[^\s"']+\/(answer|dismiss)/i, "hive decision tampering"],
  [/\/api\/authority\/rules/i, "hive authority-rule tampering"],
  [/(id_rsa|id_ed25519|id_ecdsa)\b/i, "private SSH key"],
  [/\.aws\/credentials\b/i, "AWS credentials file"],
  [/\.ssh\/(?!known_hosts\b|config\b)/i, "SSH key material"],
];

// Read-only / standard-dev commands. A command is "safe" only if EVERY segment
// (split on shell operators) matches one of these anchored at the segment start.
const SAFE: RegExp[] = [
  /^(ls|pwd|cat|head|tail|wc|stat|file|tree|echo|printf|date|whoami|hostname|uname|id|groups|df|du|ps|uptime|cd|dirname|basename|realpath|readlink|env)\b/,
  /^(which|type|command\s+-v)\b/,
  /^(grep|egrep|fgrep|rg|ag|sort|uniq|cut|nl|diff|comm|jq|column|tr|xxd|md5|md5sum|sha1sum|sha256sum)\b/,
  // `find` alone is read-only; -delete/-exec is caught by DANGEROUS above and
  // must never fall through to "safe" even when the sandbox waiver applies —
  // a waived match still needs to land on "unknown" (allow-and-log).
  /^find\b(?![\s\S]*-(delete|exec(dir)?)\b)/,
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
  // gh: read-only subcommands only (never merge/close/create/comment/edit/run/etc).
  /^gh\s+pr\s+(view|list|diff|checks|status)\b/,
  /^gh\s+issue\s+(view|list|status)\b/,
  /^gh\s+run\s+(view|list)\b/,
  /^gh\s+workflow\s+(view|list)\b/,
  /^gh\s+release\s+(view|list)\b/,
  /^gh\s+(repo\s+view|auth\s+status)\b/,
  // git: bare listing forms (no trailing args, so `-D`/`add`/`push` etc. can't hide here).
  /^git\s+(branch|tag|remote|stash)\s*$/,
  // hive/herdr CLI: emit is always a data-only POST to hive's own board (see
  // isHiveEmitDataOnly below, which already waives it from the DANGEROUS scan);
  // the rest are read-only list/search calls. Mutating calls (task create/move,
  // decision ask, spawn, secret, authority/policy/learning add, offline, …)
  // are deliberately NOT here — those still escalate.
  /^("?\$HIVE_CLI"?|(bun|bunx)\s+\S*hive(\.ts)?|(\.\/)?bin\/hive|hive)\s+emit\b/,
  /^("?\$HIVE_CLI"?|(bun|bunx)\s+\S*hive(\.ts)?|(\.\/)?bin\/hive|hive)\s+(task\s+list|pr-marker|recall|stats|learning\s+list|authority\s+list|policy\s+list|watch\s+list)\b/,
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

// True iff every target of every `rm` segment resolves inside a sandbox root —
// no unresolved substitution, no `..`. Absolute paths must sit under a root;
// relative paths count only when the hook's reported cwd is itself sandboxed
// (an agent cleaning a temp file in its own worktree, seen live 2026-07-10,
// dec_04e587de3ee0). `rm` reached via xargs/env/etc. never waives.
function rmTargetsSandboxed(
  cmd: string,
  env: Record<string, string | undefined>,
  cwd?: string
): boolean {
  const map = varMap(cmd, env);
  const roots = sandboxRoots(env);
  const cwdSandboxed = !!cwd && roots.some((r) => (cwd + "/").startsWith(r));
  const rmSegs = segments(cmd).filter((s) => /^rm\b/.test(s));
  if (!rmSegs.length) return false;
  // The whole-string DANGEROUS scan can also fire on an rm hidden in a non-rm
  // segment (e.g. `xargs rm -rf`); only waive when every firing segment is a
  // plain rm we can inspect.
  const rmish = segments(cmd).filter((s) => /(^|[\s;&|(])rm\s+(-[a-z]*\s+)*-[a-z]*[rf]/i.test(s));
  if (rmish.some((s) => !/^rm\b/.test(s))) return false;
  // An in-command `cd` changes what relative targets mean; keep it provable.
  if (cwdSandboxed && /(^|[\s;&|(])cd\s/.test(cmd)) return false;
  for (const seg of rmSegs) {
    const body = seg.split(/\s+[\d&]*[<>]/)[0]; // drop redirections
    for (let tok of body.split(/\s+/).slice(1)) {
      if (tok.startsWith("-")) continue;
      // $$ is the shell PID — digits, can't escape a directory prefix.
      tok = subst(tok.replace(/["']/g, "").replace(/\$\$/g, "PID"), map);
      if (!tok) continue;
      if (/[$`]/.test(tok)) return false; // unresolved substitution
      if (tok.includes("..")) return false; // path escape
      if (tok.startsWith("~")) return false; // unexpanded home
      if (!tok.startsWith("/")) {
        if (!cwdSandboxed) return false; // relative: only provable via sandboxed cwd
        continue;
      }
      if (!roots.some((r) => tok.startsWith(r))) return false;
    }
  }
  return true;
}

// True iff the find TARGET (its first non-flag argument, i.e. the search path —
// not the -name/-exec pattern) resolves inside a sandbox root for every
// find-with-delete/-exec segment. Mirrors rmTargetsSandboxed's resolution
// rules exactly: no unresolved substitution, no `..` escape, no unexpanded
// `~`, relative only when cwd itself is sandboxed.
function findDeleteTargetsSandboxed(
  cmd: string,
  env: Record<string, string | undefined>,
  cwd?: string
): boolean {
  const map = varMap(cmd, env);
  const roots = sandboxRoots(env);
  const cwdSandboxed = !!cwd && roots.some((r) => (cwd + "/").startsWith(r));
  const findSegs = segments(cmd).filter((s) => /^find\b/.test(s));
  if (!findSegs.length) return false;
  const findish = segments(cmd).filter((s) => /find\b[^\n]*-(delete|exec(dir)?)\b/i.test(s));
  if (findish.some((s) => !/^find\b/.test(s))) return false;
  if (cwdSandboxed && /(^|[\s;&|(])cd\s/.test(cmd)) return false;
  for (const seg of findSegs) {
    const body = seg.split(/\s+[\d&]*[<>]/)[0]; // drop redirections
    // find [paths...] [expression]: every non-flag token before the first
    // `-flag` is a search path; find deletes under all of them. Tokens after
    // the first flag (e.g. -name's pattern) are expression values, not paths.
    const rest = body.split(/\s+/).slice(1).filter(Boolean);
    // find's global options legally precede the path list; skip them so the
    // real search paths still get validated. `-f <path>` is special: its
    // argument IS a search root and must be collected.
    const NOARG_GLOBAL = new Set(["-H", "-L", "-P", "-E", "-X", "-d", "-s", "-x"]);
    const VALUE_GLOBAL = new Set(["-D", "-O"]);
    const paths: string[] = [];
    for (let i = 0; i < rest.length; ) {
      const t = rest[i];
      if (NOARG_GLOBAL.has(t)) { i += 1; continue; }
      if (VALUE_GLOBAL.has(t)) { i += 2; continue; }
      if (t === "-f") { if (rest[i + 1] !== undefined) paths.push(rest[i + 1]); i += 2; continue; }
      if (t.startsWith("-")) break; // first expression predicate
      paths.push(t);
      i += 1;
    }
    // `find -delete` (or global-flags-only) with no leading path targets `.`.
    if (!paths.length) paths.push(".");
    for (const target of paths) {
      const tok = subst(target.replace(/["']/g, ""), map);
      if (!tok) return false;
      if (/[$`]/.test(tok)) return false; // unresolved substitution
      if (tok.includes("..")) return false; // path escape
      if (tok.startsWith("~")) return false; // unexpanded home
      if (!tok.startsWith("/")) {
        if (!cwdSandboxed) return false; // relative: only provable via sandboxed cwd
        continue;
      }
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

// `git reset --hard` and `git clean` discard work in the checkout they run in.
// In the agent's OWN worktree (every ~/.herdr/worktrees/* dir is agent-created
// and disposable) that's routine branch-syncing — resetting to origin/<branch>
// before re-checking a PR. The MAIN checkout (~/projects/…) is NOT under a
// sandbox root, so a reset there stays gated. Provable only when the effective
// working directory of every such git segment resolves inside a sandbox root:
// the hook's cwd, updated by any absolute `cd`, or an explicit `git -C <path>`.
// A relative cd, an unresolved variable, command substitution, or an unknown
// cwd all fail closed. Force-push is deliberately NOT covered — it mutates a
// shared remote, a different blast radius.
export function gitResetInSandbox(
  cmd: string,
  env: Record<string, string | undefined>,
  cwd?: string
): boolean {
  if (/\$\(|`|<\(/.test(cmd)) return false; // substitution can move the cwd unseen
  const map = varMap(cmd, env);
  const roots = sandboxRoots(env);
  const isDangerGit = (s: string) =>
    /^git\s+(-C\s+\S+\s+)?(reset\s+--hard|clean\s+(-[a-z]*\s+)*-[a-z]*[fd])/.test(s);
  const inSandbox = (dir: string | null | undefined) =>
    !!dir && dir.startsWith("/") && !dir.includes("..") && !/[$`]/.test(dir) &&
    roots.some((r) => (dir + "/").startsWith(r));
  const gitSegs = segments(cmd).filter(isDangerGit);
  if (!gitSegs.length) return false;
  let eff = cwd ? subst(cwd, map) : null; // effective cwd, tracked across cd
  for (const seg of segments(cmd)) {
    const cd = seg.match(/^cd\s+(\S+)/);
    if (cd) {
      const d = subst(cd[1].replace(/["']/g, ""), map);
      if (!d.startsWith("/")) return false; // relative cd: unresolvable
      eff = d;
      continue;
    }
    if (!isDangerGit(seg)) continue;
    const c = seg.match(/^git\s+-C\s+(\S+)/); // -C overrides cwd for this call
    const dir = c ? subst(c[1].replace(/["']/g, ""), map) : eff;
    if (!inSandbox(dir)) return false;
  }
  return true;
}

// The agent's OWN per-worktree docker DB (wt.sh up creates `<slug>-mariadb`
// where slug = the worktree directory name) is a sandbox: seeded from a dump,
// torn down on cleanup, no shared state. Destructive SQL there is routine
// harness work — but only when EVERY sql-client segment is a `docker exec`
// into a container named `<own-slug>-…`. A mismatched slug (another agent's
// stack, the human's `monorepo-mariadb`), a bare mysql, or an unresolvable
// container token all stay gated.
export function dockerDbTargetsSandboxed(
  cmd: string,
  env: Record<string, string | undefined>,
  cwd?: string
): boolean {
  const m = cwd ? /\/worktrees\/[^/]+\/([A-Za-z0-9._-]+)/.exec(cwd) : null;
  if (!m) return false;
  const slug = m[1].toLowerCase();
  const map = varMap(cmd, env);
  const sqlSegs = segments(cmd).filter((s) => /\b(mysql|mariadb|psql)\b/i.test(s));
  if (!sqlSegs.length) return false;
  // Flags that consume the next token, so the container name is found reliably.
  const VALUE_FLAGS = new Set(["-u", "--user", "-e", "--env", "-w", "--workdir", "--env-file", "--detach-keys"]);
  return sqlSegs.every((seg) => {
    const s = subst(seg.replace(/["']/g, ""), map);
    if (/[$`]/.test(s)) return false; // unresolved substitution
    const toks = s.trim().split(/\s+/);
    if (toks[0] !== "docker" || toks[1] !== "exec") return false;
    let i = 2;
    while (i < toks.length && toks[i].startsWith("-")) {
      i += VALUE_FLAGS.has(toks[i]) && !toks[i].includes("=") ? 2 : 1;
    }
    const container = toks[i]?.toLowerCase() ?? "";
    return container.startsWith(`${slug}-`);
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

// SQL dangerous rules must never fire on a pure read-only search/inspection
// pipeline (grep/rg/sed/cat/awk/…) whose argument text merely CONTAINS
// SQL-looking words — the string being searched FOR is not a statement being
// executed. Task 1022: `grep -rn "UPDATE tasks SET" src | grep -i source`
// classified dangerous because the bare word "source" (an EXECUTOR name) in
// the second grep's search pattern disabled data-text stripping for the
// whole command, so the SQL regex matched the first grep's quoted argument.
// Reuses the SAFE allowlist rather than a second list of read-only tools —
// a command this waives is, by construction, a command SAFE would already
// allow once the SQL false-positive stops hiding that.
function sqlKeywordIsSearchData(cmd: string): boolean {
  if (/\$\(|`|<\(/.test(cmd)) return false; // subshell: can't prove read-only
  const segs = segments(cmd);
  return segs.length > 0 && segs.every((seg) => SAFE.some((rx) => rx.test(seg)));
}

// A lone `hive emit …` (any invocation form, optionally preceded by VAR=
// assignments) only POSTs its arguments to hive as JSON — the text is data,
// never executed. Without this, a status note that MENTIONS a destructive
// command trips the whole-string scan (seen live 2026-07-10, dec_95135b1837e9,
// dec_358dc21a6e8f). Requires: no substitution anywhere.
function isHiveEmitDataOnly(cmd: string): boolean {
  if (/\$\(|`|<\(/.test(cmd)) return false;
  const emitRe = /^("?\$HIVE_CLI"?|(bun|bunx)\s+\S*hive(\.ts)?|(\.\/)?bin\/hive|hive)\s+emit\b/;
  const assignRe = /^(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*=/;
  let sawEmit = false;
  for (const s of segments(cmd)) {
    if (emitRe.test(s)) sawEmit = true;
    else if (!assignRe.test(s)) return false;
  }
  return sawEmit;
}

// ---- data-text stripping --------------------------------------------------
// Quoted strings and heredoc bodies are DATA to the receiving command (a commit
// message, a PR comment, a grep pattern) unless something in the command can
// EXECUTE text (sh -c, eval, xargs, python -c, …). Scanning data as if it were
// shell caused a steady stream of false decision cards (git commit -F- <<MSG
// mentioning rm; gh pr comment bodies; grep "rm "). So: when no executor is
// present, the DANGEROUS scan runs on the command with data text stripped.
// False executor hits only disable stripping — conservative by construction.
// ponytail: write-file-then-run-it still evades any Bash-only scan (the Write
// tool is ungated); this closes the data-text class, not file-mediated exec.
// Includes the SQL clients and osascript: they EXECUTE their quoted argument,
// so their commands must be scanned unstripped.
const EXECUTOR = new RegExp(
  String.raw`\b(sh|bash|zsh|ksh|dash|eval|source|exec|xargs|sqlite3|psql|mysql|osascript)\b` +
    String.raw`|\bpython3?\b[^\n|;&]*\s-c\s|\bnode\b[^\n|;&]*\s(-e|--eval)\s|\b(perl|ruby)\b[^\n|;&]*\s-e\s`
);

// A subshell trigger ($(...), `...`, <(...)) executes even inside double
// quotes or an unquoted heredoc, so a region containing one must stay raw for
// the DANGEROUS scan to see. A single-quoted string or a heredoc with a QUOTED
// delimiter (<<'TAG'/<<"TAG") never expands at all — real shells treat their
// contents as 100% literal regardless of what punctuation is inside — so those
// always strip, keeping the decision scoped to the region that actually risks
// executing instead of flipping stripping off for the whole command (the
// classify.ts hasSubshell/EXECUTOR gate gotcha, task 320).
const SUBSHELL = /\$\(|`|<\(/;

export function stripDataText(cmd: string): string {
  return cmd
    // heredoc bodies: <<TAG / <<-TAG / <<'TAG' … TAG (start-of-line terminator)
    .replace(/<<-?\s*(['"]?)(\w+)\1([\s\S]*?)\n\2(?=\n|$)/g, (full, quote, _tag, body) =>
      !quote && SUBSHELL.test(body) ? full : "<<HEREDOC_STRIPPED"
    )
    .replace(/'[^']*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, (full) => (SUBSHELL.test(full) ? full : '""'));
}

// Force-push is only catastrophic on SHARED refs. An agent force-pushing its
// OWN task branch (hive/<HIVE_TASK_ID>) is routine PR iteration after a rebase
// — gating it produced a 5-card storm on one task (2026-07-13, #151: the agent
// carded four alternate push-recovery plans nobody would answer). Waive when
// EVERY git-push segment names the agent's own branch; anything else escalates.
function forcePushOwnBranch(cmd: string, env: Record<string, string | undefined>): boolean {
  const tid = env.HIVE_TASK_ID;
  if (!tid) return false;
  const own = `hive/${tid}`;
  const pushes = segments(cmd).filter((s) => /git\s+push\b/.test(s));
  return pushes.length > 0 && pushes.every((s) => s.includes(own));
}

// `docker rm` / `podman rm` remove containers, `git rm` stages recoverable
// deletions — none touch the filesystem the way `rm` does. Waive the rm rule
// when every rm-matching segment is one of those commands.
function isContainerOrVcsRm(cmd: string): boolean {
  const rmish = segments(cmd).filter((s) => /(^|[\s;&|(])rm\s+(-[a-z]*\s+)*-[a-z]*[rf]/i.test(s));
  return rmish.length > 0 && rmish.every((s) => /^(docker|podman|git)\b/.test(s));
}

export function classify(
  command: string,
  env: Record<string, string | undefined> = process.env,
  cwd?: string
): Classification {
  const cmd = command.trim();
  if (!cmd) return { decision: "safe", reason: "empty command" };

  // Argument-evidence rules always see the raw command (their match is
  // usually inside quotes). No waivers apply to them.
  for (const [rx, reason] of DANGEROUS_RAW) {
    if (rx.test(cmd)) return { decision: "dangerous", reason };
  }

  const emitDataOnly = isHiveEmitDataOnly(cmd);
  // No executor and no command substitution → quoted strings / heredoc bodies
  // are data; scan with them stripped so text ABOUT rm (or find -exec) isn't
  // treated AS the command. Test EXECUTOR against the STRIPPED text: an executor
  // word appearing only inside quotes (a commit message mentioning `-exec`,
  // `bash`, `eval`, …) is prose, not a real executor, so it must not disable
  // stripping and let the whole-string DANGEROUS scan hit the quoted data.
  // Substitution ($(…), backticks, <(…)) executes even inside double quotes;
  // stripDataText already keeps any region containing one raw (see SUBSHELL
  // above), scoped to that region — no need to force the WHOLE command raw
  // just because a trigger appears somewhere in it.
  const stripped = stripDataText(cmd);
  const scanTarget = EXECUTOR.test(stripped) ? cmd : stripped;
  for (const [rx, reason] of DANGEROUS) {
    if (!rx.test(scanTarget)) continue;
    if (emitDataOnly) continue; // arguments are data, not executed
    if (reason === "recursive/forced rm" && (rmTargetsSandboxed(cmd, env, cwd) || isContainerOrVcsRm(cmd)))
      continue;
    if (reason === "process kill" && killTargetsSandboxed(cmd, env)) continue;
    if (reason === "find with -delete/-exec" && findDeleteTargetsSandboxed(cmd, env, cwd)) continue;
    if (reason === "force push" && forcePushOwnBranch(cmd, env)) continue;
    if ((reason.startsWith("hard reset") || reason.startsWith("git clean")) && gitResetInSandbox(cmd, env, cwd))
      continue;
    if (
      reason.startsWith("SQL ") &&
      (sqlTargetsSandboxed(cmd, env) || dockerDbTargetsSandboxed(cmd, env, cwd) || sqlKeywordIsSearchData(cmd))
    )
      continue;
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

function hookOutput(
  event: "PreToolUse" | "PermissionRequest",
  permissionDecision: "allow" | "deny",
  reason: string,
  codex = false
): string {
  if (event === "PermissionRequest") {
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: event,
        decision: permissionDecision === "allow"
          ? { behavior: "allow" }
          : { behavior: "deny", message: reason },
      },
    });
  }
  if (codex && permissionDecision === "allow") return "";
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: event,
      permissionDecision,
      permissionDecisionReason: reason,
    },
  });
}

// Action string for the authority engine. Dangerous commands carry their
// classifier category as a stable sub-action ("command.dangerous.process-kill")
// so a standing rule can allow ONE category forever ("Approve & always allow"
// on the decision card) without relaxing the rest — the deny-safe default
// `command.dangerous*` still matches every sub-action.
export function actionFor(decision: Decision, reason: string): string {
  if (decision !== "dangerous") return "command";
  const slug = reason.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return slug ? `command.dangerous.${slug}` : "command.dangerous";
}

// Ask hive's authority engine to decide a not-safe command. Fail-safe: any
// unreachability or error DENIES (never auto-allows an unclassified command).
async function escalate(
  hiveUrl: string,
  taskId: string,
  command: string,
  decision: Decision,
  reason: string,
  event: "PreToolUse" | "PermissionRequest",
  codex: boolean,
  summary?: string
): Promise<string> {
  // Distinct action namespace so a standing rule can gate destructive commands
  // (`command.dangerous.*`, category-specific) without touching merely-
  // unrecognized ones (`command`). `command.dangerous*` is deny-safe by default
  // IN CODE — it requires a decision with no rule present; unknown commands
  // default-allow (logged).
  const action = actionFor(decision, reason);
  try {
    const res = await fetch(`${hiveUrl}/api/tasks/${taskId}/guarded-action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action,
        target: command,
        detail: `command approval (${decision}): ${reason}`,
        // The Bash tool's own description: the card title reads as intent.
        summary: summary || undefined,
      }),
      signal: AbortSignal.timeout(2000),
    });
    const body: any = await res.json().catch(() => ({}));
    if (res.status === 200 && body.effect === "allow")
      return hookOutput(event, "allow", "authority engine: standing grant/rule", codex);
    if (res.status === 403)
      return hookOutput(event, "deny", body.error || "denied by standing authority");
    if (res.status === 409)
      return hookOutput(
        event,
        "deny",
        `escalated to hive decision ${body.decision_id} — waiting on the director; retry this command once approved`
      );
    return hookOutput(event, "deny", `unexpected guarded-action response (${res.status})`);
  } catch (e: any) {
    return hookOutput(event, "deny", `hive unreachable, denying for safety: ${String(e?.message ?? e)}`);
  }
}

function emit(output: string): void {
  if (output) console.log(output);
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
  const event = payload?.hook_event_name === "PermissionRequest" ? "PermissionRequest" : "PreToolUse";
  const codex = process.env.HIVE_AGENT === "codex";
  const command = payload?.tool_input?.command;
  if (typeof command !== "string") process.exit(0); // not a Bash command → defer

  const { decision, reason } = classify(
    command,
    process.env,
    typeof payload?.cwd === "string" ? payload.cwd : undefined
  );

  if (decision === "safe") {
    emit(hookOutput(event, "allow", reason, codex));
    process.exit(0);
  }

  // unknown under `allow` → auto-approve; under `prompt` → defer to normal dialog.
  // DANGEROUS is never eligible for either shortcut — it always escalates.
  if (decision === "unknown") {
    if (policy === "allow") {
      emit(hookOutput(event, "allow", "command_approval=allow: unknown command permitted", codex));
      process.exit(0);
    }
    if (policy === "prompt") process.exit(0); // defer to the agent's own prompt
  }

  const taskId = process.env.HIVE_TASK_ID;
  const hiveUrl = process.env.HIVE_URL || `http://127.0.0.1:${process.env.HIVE_PORT || 4700}`;
  if (!taskId) {
    // No hive task to escalate to: fail safe. Dangerous → deny; unknown → defer.
    if (decision === "dangerous") console.log(hookOutput(event, "deny", `blocked (${reason}); no hive task to authorize`));
    process.exit(0);
  }
  const summary = typeof payload?.tool_input?.description === "string" ? payload.tool_input.description : undefined;
  emit(await escalate(hiveUrl, taskId, command, decision, reason, event, codex, summary));
  process.exit(0);
}
