# Fix: double-spawn race in director chat fast path (task cd63bea6f75c)

Two concurrent `/api/chat/turn` requests for the same thread, arriving before the
first supervisor spawn lands, both saw `agent_target === null` and both called
`spawnAgent` for the same task — racing worktree create/reclaim and starting
duplicate claude sessions. Fix serializes turns per thread id with an in-process
promise-chain lock (`withThreadLock`); the waiter re-reads thread/task state fresh
and delivers into the winner's live session instead of racing it.

The regression test fires two concurrent turns on a brand-new thread and asserts
exactly one spawn. The test's mock `exec` adds a 15ms delay to `worktree create`
to reproduce the real race window.

## Before the fix (pre-fix `api.ts`) — the race reproduces

Concurrent double-send produces TWO spawns for one thread:

```
=== Running concurrent double-send test against PRE-FIX api.ts ===
  expect(briefs.length).toBe(before + 1); // exactly one spawn, not two
                        ^
error: expect(received).toBe(expected)

Expected: 1
Received: 2

(fail) a concurrent double-send on the same thread spawns only once [21.50ms]
 0 pass  1 fail
```

## After the fix — exactly one spawn

```
=== Fixed api.ts: concurrent test ===
 1 pass  0 fail  6 expect() calls
```

The winner returns `delivery: "spawned"`, the serialized waiter returns
`delivery: "delivered"` (it delivers into the live session), and neither
message ("message A" / "message B") is dropped.

## Full suite

```
bun test
 422 pass  0 fail  1668 expect() calls
 Ran 422 tests across 48 files. [7.82s]
```

(The `herdr socket blew up` line in `reaper.test.ts` is a deliberately thrown
error the test asserts on, not a failure.)
