// Injectable subprocess layer. Every adapter that shells out (herdr, secrets,
// gh, git, osascript) takes an `Exec` so it is fully unit-testable without
// touching the real world. Tests pass a stub; production uses `defaultExec`.
export type ExecResult = { code: number; stdout: string; stderr: string };

export type Exec = (
  argv: string[],
  opts?: { input?: string; cwd?: string }
) => Promise<ExecResult>;

// Real implementation over Bun.spawn. `input` is written to stdin (used by
// `hive secret set`, which reads the value from stdin so it never hits argv).
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
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
};
