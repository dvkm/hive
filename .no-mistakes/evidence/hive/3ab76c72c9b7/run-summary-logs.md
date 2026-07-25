# hive-681: per-run structured logging for reconciler & dispatcher

New '[hive] <component> run:' summary lines emitted on every return path,
captured from the actual test suite (bun test) plus a manual offline drive.

## reconciler.reconcileOnce  (steps counted via step() wrapper)
```
  18 [hive] reconciler run: duration_ms=0 steps=15 errors=0 outcome=ok
   4 [hive] reconciler run: duration_ms=0 steps=15 errors=1 outcome=error
  11 [hive] reconciler run: duration_ms=1 steps=15 errors=0 outcome=ok
   2 [hive] reconciler run: duration_ms=1 steps=15 errors=1 outcome=error
   3 [hive] reconciler run: duration_ms=2 steps=15 errors=0 outcome=ok
   1 [hive] reconciler run: duration_ms=3 steps=15 errors=0 outcome=ok
# offline early-return path (manual drive, offline=1):
[hive] reconciler run: duration_ms=1 steps=7 errors=0 outcome=offline
```

## dispatcher.dispatchOnce  (steps = queued.length, errors from per-task catch)
```
   1 [hive] dispatcher run: duration_ms=0 steps=0 errors=0 outcome=offline
   1 [hive] dispatcher run: duration_ms=0 steps=0 errors=0 outcome=ok
  10 [hive] dispatcher run: duration_ms=0 steps=1 errors=0 outcome=ok
   2 [hive] dispatcher run: duration_ms=0 steps=2 errors=0 outcome=ok
   3 [hive] dispatcher run: duration_ms=1 steps=1 errors=0 outcome=ok
   2 [hive] dispatcher run: duration_ms=1 steps=2 errors=0 outcome=ok
   1 [hive] dispatcher run: duration_ms=1 steps=3 errors=0 outcome=ok
   1 [hive] dispatcher run: duration_ms=12 steps=1 errors=0 outcome=ok
   1 [hive] dispatcher run: duration_ms=2 steps=1 errors=0 outcome=ok
```

Outcomes observed: ok, error, offline. Fields: duration_ms, steps, errors, outcome.
