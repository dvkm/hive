# Task #243 — hive per-worktree wt.sh, exercised end-to-end

Simulating a fresh hive task worktree (`/tmp/wt-demo.gxXYWE`): a real bun project with **no node_modules**,
the exact state in which a spawned agent cannot yet build or test.

## 1. Spawn hook (up): installs the deps a fresh worktree lacks
```
==> hive worktree bootstrap: /tmp/wt-demo.gxXYWE
==> bun install
bun install v1.3.14 (0d9b296a)
Resolving dependencies
Resolved, downloaded and extracted [4]
Saved lockfile

+ left-pad@1.3.0

1 package installed [122.00ms]
```

## 2. Idempotent re-run (up): deps present -> no-op, no reinstall
```
==> hive worktree bootstrap: /tmp/wt-demo.gxXYWE
   deps present — nothing to do
```

## 3. Cleanup hook (down): best-effort no-op, exits 0 (hive has no per-worktree containers to orphan)
```
==> hive worktree teardown: /tmp/wt-demo.gxXYWE (no stack to remove)
exit=0
```

## 4. Contract: unknown subcommand -> usage + nonzero
```
usage: infra/worktree/wt.sh {up|down} [worktree-path]
exit=1
```

## 5. Contract: unresolvable worktree path fails soft (exit 0) — a bad hook never blocks a spawn
```
wt.sh: cannot resolve worktree path '/no/such/worktree/here'
exit=0
```

## 6. Config-wiring runner (runStackCmd, setup_argv/cleanup_argv) + wt.sh branch logic — bun test
```
bun test v1.3.14 (0d9b296a)

 18 pass
 0 fail
 54 expect() calls
Ran 18 tests across 2 files. [415.00ms]
```
