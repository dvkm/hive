// Injectable subprocess layer. Every adapter that shells out (herdr, secrets,
// gh, git, osascript) takes an `Exec` so it is fully unit-testable without
// touching the real world. Tests pass a stub; production uses `defaultExec`.
export type ExecResult = { code: number; stdout: string; stderr: string };

export type Exec = (
  argv: string[],
  opts?: { input?: string; cwd?: string; timeoutMs?: number }
) => Promise<ExecResult>;

const DEFAULT_TIMEOUT_MS = 60_000;

// Common CLI install dirs, appended to whatever PATH the process currently has.
// Task #1096: under `bun --watch` (how the server actually runs, per the
// launchd plist), Bun.spawn with no `env` override threw ENOENT for `gh` on
// every reconciler cycle, even though `ps` on the running process showed a
// correct PATH and a bare `bun -e` reproduction with that same PATH resolved
// `gh` fine — something about --watch's env handling loses PATH at the exact
// spawn call. Rather than depend on inheritance working, build PATH explicitly
// so resolution never depends on how the server process itself was started.
const FALLBACK_PATH_DIRS = ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin", `${process.env.HOME ?? ""}/.bun/bin`];
function spawnEnv(): Record<string, string | undefined> {
  const current = (process.env.PATH ?? "").split(":").filter(Boolean);
  const path = Array.from(new Set([...current, ...FALLBACK_PATH_DIRS])).join(":");
  return { ...process.env, PATH: path };
}

// Real implementation over Bun.spawn. `input` is written to stdin (used by
// `hive secret set`, which reads the value from stdin so it never hits argv).
//
// Bounded by a timeout (task #621): a stalled `gh`/`git` call — or a detached
// grandchild process inheriting the stdout/stderr pipes, which keeps them open
// even after the direct child exits — used to hang the read below forever,
// wedging whatever request awaited it (observed live: POST /merge never
// returned). `proc.kill()` is best-effort cleanup; the Promise.race is what
// actually bounds the caller, since a leaked pipe writer can outlive the kill.
export const defaultExec: Exec = async (argv, opts = {}) => {
  const proc = Bun.spawn(argv, {
    cwd: opts.cwd,
    env: spawnEnv(),
    stdin: opts.input != null ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (opts.input != null) {
    proc.stdin!.write(opts.input);
    await proc.stdin!.end();
  }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timedOut = Symbol("timedOut");
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const result = await Promise.race([
      Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]),
      new Promise<typeof timedOut>((resolve) => setTimeout(() => resolve(timedOut), timeoutMs)),
    ]);
    if (result === timedOut) return { code: 124, stdout: "", stderr: `timed out after ${timeoutMs}ms: ${argv.join(" ")}` };
    const [stdout, stderr, code] = result;
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
};

// ---------------------------------------------------------------- ref names
// Branch names sourced from project config (config.promote.{from,to},
// config.default_branch) end up as POSITIONAL git arguments. git parses a
// positional starting with `-` as an OPTION, not a ref: a config write of
// `--upload-pack=/tmp/evil` turns `git fetch origin <from>` into arbitrary
// command execution, and `--output=<path>` turns `git diff <base>...<branch>`
// into an arbitrary file write. No shell is involved — argv arrays don't help.
// So config-sourced refs are checked before they reach any exec() call.
// ponytail: regex, not `git check-ref-format` — these are short branch names
// like "staging"/"main", and spawning a process per read would be absurd.
// `..` is excluded because `<base>...<branch>` interpolation would otherwise
// let a base smuggle in its own revision range.
const REF_RE = /^[A-Za-z0-9_][A-Za-z0-9._/-]{0,254}$/;

export function isSafeRef(v: unknown): v is string {
  return typeof v === "string" && REF_RE.test(v) && !v.includes("..");
}

function warnUnsafeRef(v: unknown, fallback: string): void {
  if (v !== undefined && v !== null && v !== "") {
    console.error(`[hive] rejecting unsafe ref name ${JSON.stringify(v)}; falling back to '${fallback}'`);
  }
}

// A config-sourced branch name, or `fallback` when it is missing or unsafe.
// projectBaseBranch routes project integration-branch reads through this. Logs
// when a present-but-unsafe value is rejected, so a malformed branch doesn't
// silently select the wrong ref with no operator signal.
export const safeBranch = (v: unknown, fallback = "main"): string => {
  if (isSafeRef(v)) return v;
  warnUnsafeRef(v, fallback);
  return fallback;
};

// One authoritative integration branch for every project git operation. A
// promotion project naturally works on promote.from; requiring it to repeat
// that value as default_branch made a missing key silently cut work from main
// even while every PR targeted staging.
export function projectBaseBranch(config: any): string {
  if (config?.default_branch !== undefined && config?.default_branch !== null)
    return safeBranch(config.default_branch);
  return safeBranch(config?.promote?.from);
}

// Read-only comparisons should follow the remote-tracking integration ref.
// The local branch can be missing or lag behind origin without affecting the
// branch that GitHub actually uses as the PR base.
export function projectComparisonBase(config: any): string {
  return `origin/${projectBaseBranch(config)}`;
}

// Prefers `candidate` (e.g. a PR's live baseRefName from `gh pr view`) when it
// is a safe ref, else `fallback`. Same argv-injection risk as safeBranch even
// though candidate is GitHub-sourced rather than local config: it still lands
// as a positional git argument.
export function preferSafeRef(candidate: unknown, fallback: string): string {
  if (isSafeRef(candidate)) return candidate;
  warnUnsafeRef(candidate, fallback);
  return fallback;
}
