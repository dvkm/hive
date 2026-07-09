# hive runtime — dispatcher + live herdr behavior

This documents the self-driving dispatcher and the herdr adapter's verified
behavior against a live herdr server (client + server 0.7.1, protocol 14). The
adapter was exercised end to end against a throwaway git repo; the captured
transcript is `docs/evidence/herdr-live-verification.txt`.

## Dispatcher (`server/src/dispatcher.ts`)

A coarse loop (default every 30s, `HIVE_DISPATCH_MS`) that picks up `queued`
tasks and spawns a herdr agent for each. It is the reason a task created in the
web UI now runs instead of sitting in Queued forever. Every gate below must pass:

1. **`config.auto_dispatch: true`** on the owning project. Default **off** — so
   intake drafts, planner setup tasks, and anything queued for triage never
   auto-spawn. Toggle per project on the Policies page (writes project config).
2. **`config.dispatch_kinds`** (default `["ship","scout"]`). `chore` tasks are
   excluded by default (they are usually titled for a human).
3. **Intake review gate.** A task with `source="intake_gchat"` is skipped until
   it is reviewed. "Reviewed" = a dedicated `reviewed` event, or any `note`
   event containing the word "reviewed". The intake connector's own
   `UNREVIEWED …` note does **not** count (the token `unreviewed` is stripped
   before the substring test). The manual "dispatch now" button bypasses the
   dispatcher entirely, so clicking it *is* the human review for a one-off.
4. **`config.max_agents`** (default 3). Concurrency cap per project, counting
   tasks currently holding an agent (`agent_target` set and state in
   in_progress / needs_decision / in_review / verifying).
5. **Authority gate.** `authorize(action="task.dispatch", target=<title>)` must
   resolve to `allow`. A `deny` or `require_decision` standing-authority rule
   blocks the auto-spawn (and, for `require_decision`, opens the usual card).
6. **Backoff.** On a spawn failure a single `spawn_error` event is written and
   the task stays queued; the next attempt waits `min(30s · 2^(n-1), 30m)` where
   `n` is the number of spawn_error events. No retry storm on a broken repo.

The spawn itself is the shared `spawnAgent()` core (also used by
`POST /api/tasks/:id/spawn`), so the auto path and the manual button behave
identically: worktree create, agent start, `spawned` event, `queued→in_progress`.

## herdr adapter — verified behavior & quirks

Verified live: worktree create, agent start, `agent list` visibility,
`agent get` status read, `agent send` delivery, `agent wait --status`, and
teardown (refuses on unpushed work, succeeds once the branch is pushed/merged).
Both a harmless `bash … sleep` agent and a real `claude -p` agent were spawned.

Quirks found and handled:

- **`--json` output is enveloped.** herdr 0.7.x wraps every JSON payload as
  `{"id":"cli:worktree:create","result":{…}}`. `worktree create` puts the
  worktree under `result.worktree` (`path`, `branch`) and the workspace id under
  `result.worktree.open_workspace_id` (also `result.workspace.workspace_id`).
  `agent get` returns `result.agent.agent_status`. The adapter's
  `parseWorktreeJson` / `parseAgentStatus` now unwrap `result` before probing
  keys. (Before this fix, spawn threw "worktree create returned no path".)

- **`worktree remove` only accepts `--workspace ID`.** It does *not* accept
  `--cwd PATH` (unlike `worktree create`/`list`). Teardown therefore relies on
  the `workspace_id` captured at spawn time, which the create envelope now
  provides. The adapter's `--cwd` fallback in `worktreeRemoveArgv` is dead
  against live herdr 0.7.1 and only fires if no workspace id was captured.

- **Subcommand `--help` prints the top-level help**, not the subcommand's usage.
  Discover real flags by running the subcommand bare (e.g. `herdr agent`) — it
  prints the command list with signatures.

- **Removing a worktree does not close its agent pane.** After
  `worktree remove`, the agent's terminal pane can linger in `agent list` as an
  orphan (cwd pointing at the deleted worktree). `herdr pane close <pane_id>`
  clears it. hive does not need this in normal operation (teardown runs on
  done/cancelled), but test harnesses should tidy up.

- **A freshly-created branch with no commits is "merged"** into its base (it
  points at the same commit), so teardown considers it safe to remove — correct,
  since there is no work to lose. The refuse path triggers only once the agent
  has made an unpushed commit.

`HERDR_BIN` overrides the binary path (default `/opt/homebrew/bin/herdr`).

## Re-running the live verification

```bash
bun run scripts/herdr-live-verify.ts /tmp/hive-herdr-verify
```

Requires a running herdr server (`herdr status` → running) and a git repo with
an `origin` remote at the given path. The script resets the repo between phases
and prints a PASS/FAIL line per checked behavior.
