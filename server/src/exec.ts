// Injectable subprocess layer. Every adapter that shells out (herdr, secrets,
// gh, git, osascript) takes an `Exec` so it is fully unit-testable without
// touching the real world. Tests pass a stub; production uses `defaultExec`.
export type ExecResult = { code: number; stdout: string; stderr: string };

export type Exec = (
  argv: string[],
  opts?: { input?: string; cwd?: string; timeoutMs?: number }
) => Promise<ExecResult>;

const DEFAULT_TIMEOUT_MS = 60_000;

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
