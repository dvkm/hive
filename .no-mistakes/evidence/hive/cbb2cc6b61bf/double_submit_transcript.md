# hive-318: brand-new-chat double-submit dedupe

Two concurrent `POST /api/chat/turn` with the same `project_id` + `text` and **no `thread_id`**
(a UI double-submit before the client has a thread id back), driven through the real HTTP handler.
`herdr` exec is stubbed; a 15ms delay on `worktree create` reproduces the race window.

Reproduce: `bun run .no-mistakes/evidence/hive/cbb2cc6b61bf/double_submit_demo.ts`

## BEFORE (base b45fe60, hive-304 lock only) — the bug

```
request A response: {"status":202,"json":{"thread_id":"thr_9c7b...","delivery":"spawned",...}}
request B response: {"status":202,"json":{"thread_id":"thr_<DIFFERENT>","delivery":"spawned",...}}

threads in DB: 2
same thread_id for both requests : false
agent spawns (agent start calls) : 2      <-- two supervisor spawns for one double-submit
persisted director messages      : 1      (per thread; two threads exist)
```

## AFTER (target f536ea3) — fixed

```
request A response: {"status":202,"json":{"thread_id":"thr_562370accf4a","delivery":"spawned","agent_target":"2afd2f45c0e4"}}
request B response: {"status":202,"json":{"thread_id":"thr_562370accf4a","delivery":"spawned","agent_target":"2afd2f45c0e4"}}

threads in DB: 1
same thread_id for both requests : true (thr_562370accf4a)
agent spawns (agent start calls) : 1      <-- exactly one spawn
persisted director messages      : 1      <-- duplicate submit did not double-post
```

Both requests ride the same in-flight promise (`pendingNewChats` keyed on `project_id + text`),
so they return the identical `thread_id` and `agent_target`, and only one thread / task / spawn happens.
The existing-thread path (`thread_id` present) is unchanged, still serialized by `withThreadLock`.
