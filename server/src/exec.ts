// Injectable subprocess layer. Every adapter that shells out (herdr, secrets,
// gh, git, osascript) takes an `Exec` so it is fully unit-testable without
// touching the real world. Tests pass a stub; production uses `defaultExec`.
import { buildExecutablePath, isPortableAbsolutePath } from "./platform.ts";

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
function spawnEnv(): Record<string, string | undefined> {
  // Windows uses `;` and drive-letter paths contain `:`. Splitting/joining with
  // the Unix delimiter corrupts every entry (`C:\\...` became `C`, `\\...`).
  // Remove alternate-cased Path keys too: Bun/Windows treats env names as
  // case-insensitive and duplicate PATH/Path entries have ambiguous precedence.
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "path")
  );
  return { ...inherited, PATH: buildExecutablePath() };
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
  const spawn = (bin: string) => Bun.spawn([bin, ...argv.slice(1)], {
    cwd: opts.cwd,
    env: spawnEnv(),
    stdin: opts.input != null ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let proc: ReturnType<typeof spawn>;
  try {
    proc = spawn(argv[0]);
  } catch (e) {
    // Bun.spawn THROWS when the child can't start at all, instead of returning
    // a non-zero code like every other failure. Task #1667: a leftover project
    // row pointed repo_path at `/repo`, which no longer exists. posix_spawn
    // reports a missing cwd as ENOENT against argv[0], so the reconciler logged
    // "posix_spawn 'gh'" and it read as a missing gh binary. gh was installed
    // and on PATH the whole time, yet linkPRs threw on every cycle for ~10h
    // (593 consecutive errors).
    //
    // Two guards, in order:
    // 1. Retry once against the binary's ABSOLUTE path, resolved over the PATH
    //    we build above. That removes any dependence on how the spawn call
    //    itself resolves a bare name (the #1096 suspicion), so if resolution is
    //    ever the real problem the retry silently fixes it.
    // 2. If that fails too, report it as an exit code instead of throwing.
    //    Every caller already branches on `code`, so this lands in their normal
    //    skip-and-retry path. 127 is the shell's "cannot execute". The cwd is
    //    named in stderr so this never again reads as a missing binary.
    const hasPathSyntax = isPortableAbsolutePath(argv[0]) || argv[0].includes("/") || argv[0].includes("\\");
    const absolute = hasPathSyntax ? null : Bun.which(argv[0], { PATH: String(spawnEnv().PATH ?? "") });
    try {
      if (!absolute) throw e;
      proc = spawn(absolute);
    } catch (retryErr) {
      const why = String((retryErr as any)?.message ?? retryErr);
      return { code: 127, stdout: "", stderr: `${argv[0]}: ${why}${opts.cwd ? ` (cwd ${opts.cwd})` : ""}` };
    }
  }
  if (opts.input != null) {
    proc.stdin!.write(opts.input);
    await proc.stdin!.end();
  }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timedOut = Symbol("timedOut");
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<typeof timedOut>((resolve) => {
    timer = setTimeout(() => {
      proc.kill();
      resolve(timedOut);
    }, timeoutMs);
  });
  try {
    const result = await Promise.race([
      Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]),
      timeout,
    ]);
    if (result === timedOut) return { code: 124, stdout: "", stderr: `timed out after ${timeoutMs}ms: ${argv.join(" ")}` };
    const [stdout, stderr, code] = result;
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer!);
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
