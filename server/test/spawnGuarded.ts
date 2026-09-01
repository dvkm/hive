// Real server processes spawned by a test have to die WITH that test — including
// when the test runner is KILLED rather than merely failing. A `finally` only
// covers the normal path, and on 2026-08-31 two hive servers from cut-short runs
// of lease.test.ts were still up the next morning, holding ports 5481 and 4791
// (HIVE-586). Nothing reaps those.
//
// So every spawn gets a watchdog: a tiny shell that reads OUR stdin pipe and does
// nothing until that pipe hits EOF. EOF happens exactly when this process dies,
// however it dies — normal exit, timeout, Ctrl-C, `kill -9` — because the kernel
// closes the write end for us. The watchdog then kills the server it guards.
export function spawnGuarded(cmd: string[], opts: Parameters<typeof Bun.spawn>[1] = {} as any) {
  const proc = Bun.spawn(cmd, opts);
  // Pid reuse: the watchdog could in principle signal a recycled pid if the
  // server exits and we are killed before kill() runs. kill() below shuts the
  // watchdog down first, so that window only exists on the abrupt path — where
  // the server is by definition still alive and is the thing we want dead.
  const guard = Bun.spawn(["sh", "-c", `cat >/dev/null; kill -9 ${proc.pid} 2>/dev/null`], {
    stdin: "pipe",
    stdout: "ignore",
    stderr: "ignore",
  });
  return {
    proc,
    // Normal path: stop the watchdog first, then the server it was guarding.
    kill: (signal?: number | NodeJS.Signals) => {
      guard.kill();
      proc.kill(signal as any);
    },
  };
}
