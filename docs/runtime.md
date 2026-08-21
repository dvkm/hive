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
   Exception: a queued task descended from an active chat-supervisor task is an
   explicit manager delegation and dispatches with this toggle off. It still
   passes every kind, concurrency, authority, dependency, and backoff gate.
2. **`config.dispatch_kinds`** (default `["ship","scout"]`). `chore` tasks are
   excluded by default (they are usually titled for a human).
3. **Intake review gate.** A task with `source="intake_gchat"` is skipped until
   it is reviewed. "Reviewed" = a dedicated `reviewed` event, or any `note`
   event containing the word "reviewed". The intake connector's own
   `UNREVIEWED …` note does **not** count (the token `unreviewed` is stripped
   before the substring test). The manual "dispatch now" button bypasses the
   dispatcher entirely, so clicking it *is* the human review for a one-off.
4. **`config.max_agents`** (default 3). Worker concurrency cap per project, counting
   tasks currently holding an agent (`agent_target` set and state in
   in_progress / needs_decision / in_review / verifying). The chat-supervisor
   manager session does not consume a worker slot. Review-parked agents are
   RELEASED once idle (see below), so they drop out of both counts — the `× 2`
   overhang bounds live agents, not review depth.
5. **Authority gate.** `authorize(action="task.dispatch", target=<title>)` must
   resolve to `allow`. A `deny` or `require_decision` standing-authority rule
   blocks the auto-spawn (and, for `require_decision`, opens the usual card).
6. **Dependency gate.** A task with unmet `depends_on` (any listed task not yet
   `verifying`/`done`) is not spawned; a deduped `dependency_blocked` event
   records the visible "blocked by #N …" reason. The reconciler applies the same
   gate to stage advancement, so a manually-spawned dependent is held too.
7. **Backoff.** On a spawn failure a single `spawn_error` event is written and
   the task stays queued; the next attempt waits `min(30s · 2^(n-1), 30m)` where
   `n` is the number of the task's *own* spawn_error events. No retry storm on a
   broken repo. Failures tagged `infra: "herdr_unreachable"` (see the circuit
   breaker below) are excluded from `n` — a daemon outage is not the task's
   fault, so it neither escalates the task's exponential delay nor strands it in
   backoff once herdr recovers.
8. **herdr-down circuit breaker.** A spawn can fail because the herdr control
   socket itself is unreachable (`ConnectionRefused` / `Os { code: 61 }`,
   `isHerdrUnreachable()`) rather than for a task-specific reason. Instead of
   every queued task independently pounding the dead socket (the 260× outage
   storm), the first such failure in a cycle tags its `spawn_error` event
   `infra: "herdr_unreachable"`, sets a **global** cooldown
   (`herdr_backoff_until`, `min(30s · 2^(streak-1), 5m)`), and bails the rest of
   the cycle. Subsequent cycles skip dispatch entirely while the cooldown holds
   but still write the `last_dispatch_at` heartbeat so `/api/health` reads the
   dispatcher as cooling, not wedged. A successful spawn resets the streak. The
   bound is one probe per project (concurrent in-flight spawns) in the first
   outage cycle, then fully paused.

The spawn itself is the shared `spawnAgent()` core (also used by
`POST /api/tasks/:id/spawn`), so the auto path and the manual button behave
identically: worktree create, agent start, `spawned` event, `queued→in_progress`.

**Concurrency within a pass.** Queued tasks are grouped by project and the
projects are dispatched **concurrently**; each project's own tasks stay
**serial**. `spawnAgent` runs the project's `setup_argv` hook inside the
worktree-ready callback (up to its 120s timeout, e.g. bringing up a docker
stack), so a serial across-all-projects loop let one slow setup stall dispatch
for every other project. Serial *within* a project is deliberate: herdr
serializes `worktree create` globally, so firing a project's spawns at once
would `spawn_error` on the create step; the slow `setup_argv` runs after that
lock releases, so parallelizing across projects is the safe win. The
per-project count caches (`max_agents` gate) are only ever keyed by a project's
own id, so concurrent project loops never race on shared state.

The herdr adapter also serializes create, reclaim, cleanup, and teardown for the same `(repo_path, branch)` across the dispatcher, reconciler, and reaper. This prevents those independent loops from mutating one worktree's git metadata at the same time without adding adapter-level serialization across different branches. Spawn releases this per-branch lock before worktree preparation, tab creation, and agent startup, so a slow `setup_argv` does not hold it.

## Review-parked agents: release and reattach

An `in_review` task is parked on the DIRECTOR — PR open, CI green, quiz waiting
on a human. Its agent has nothing to do, but while it lives it holds a pty and a
dispatch slot. On 2026-08-19 ten such agents held corebeat at 3 running against
19 queued, because live agents (`max_agents × 2`) were all review-parked.

**Release** (`cleanup.releaseReviewAgent`, run every reaper sweep). For each
`in_review` task still holding an `agent_target`, herdr is probed:

- `idle` or `done` → release. Confirmed `gone` (probe says not found AND the pane list has
  no trace) → release.
- `working`, `blocked`, or an UNCONFIRMED death → leave it alone. An
  unresolvable probe is what a herdr registry wipe looks like, and closing a tab
  under a live agent is the 2026-08-19 kill wave.
- Undelivered steers pending → leave it alone; `drainSteers` gets first go.

Releasing closes the fleet tab and the worktree's own workspace, PRESERVES the
git worktree and branch (the PR still points at them), nulls `agent_target`, and
writes an `agent_released` event. Lifecycle is untouched — the task stays
`in_review`. Per-project opt-out: `config.release_review_agents: false`.

Deliberately NOT gated on the understanding quiz: a quiz is director-only
(answering or deferring it never reaches the agent), so "quiz still pending" is
exactly the state the slot would otherwise be held for.

**Reattach** (the dispatcher's first pass each cycle). Every path that hands work
back to an agent it could not reach now QUEUES a steer — a changes-request
bounce, red CI, a closed PR, a PR conflict, a failed merge, or a steer sent after
the current interactive turn completed. The reconciler releases a `done` turn
that has queued steers, preserving its task checkout. The dispatcher picks up
any `in_progress`/`in_review`/`verifying` task with no `agent_target` and queued steers,
and respawns onto the SAME branch: `worktree create` collides, `reclaimWorktree`
preserves any loose WIP on a ghost branch and removes the checkout, and the retry
re-checks out `hive/<taskId>` at its existing head, so the PR's commits are
untouched (verified live against herdr 0.7.x). The feedback rides in as the
steer preamble at the top of the fresh brief.

## Visible interactive fleet (spawn design)

hive uses herdr the way firstmate's `docs/herdr-backend.md` proved it should be used: agents are VISIBLE and INTERACTIVE, never invisible one-shot processes. A project selects Claude Code (default) or ChatGPT through the Codex CLI with `config.agent`; both stay attached to a labelled Herdr tab. `spawn()` (`server/src/runtime/herdr.ts`) does, in order:

1. Resolve the base as `config.default_branch`, otherwise `config.promote.from`,
   otherwise `main`. Fetch that branch from `origin` into its remote-tracking ref,
   then run `herdr worktree create --cwd <repo> --branch hive/<id> --base
   origin/<base> --json`. New task worktrees therefore start from the current
   integration branch instead of a possibly stale local ref.
2. **Prepare the worktree** (callback) wires Hive's Stop/SubagentStop/PostToolUse hooks before the agent starts (`.claude/settings.local.json` for Claude; per-invocation Codex hook config for ChatGPT), so lifecycle reporting is structural, not brief-dependent (`hooks/`), then runs
   the per-project spawn hook `config.setup_argv` (e.g.
   `["infra/worktree/wt.sh", "up", "{worktree}"]`) so agents don't have to
   install deps / bring up their stack themselves. It is the symmetric partner of
   `config.cleanup_argv` (teardown); both share `runStackCmd` in `cleanup.ts`,
   substitute `{worktree}`, resolve a relative `argv[0]` against `repo_path`, and
   are best-effort under a 120s timeout (a failed setup emits a `stack_setup`
   event but never blocks the spawn).
3. **Ensure the fleet workspace** — adopt-or-create a dedicated named workspace
   labelled **`hive-fleet`** (`HIVE_FLEET_LABEL` override), `--no-focus` so a
   spawn never steals the space the captain is watching. NOT `"hive"`: herdr
   auto-labels a worktree's own workspace by repo name, and this repo is named
   `hive`, so `"hive"` would adopt the hive checkout's workspace — the
   label-collision class firstmate's 2026-07-02 self-kill documents.
4. `herdr tab create --workspace <fleet> --cwd <worktree> --label "<id> <title>"`
   — one labelled tab per task (this IS the visible "id + title" affordance).
5. `herdr agent start <id> --workspace <fleet> --tab <tab> --cwd <worktree> --env HIVE_TASK_ID=<id> --env HIVE_URL=... [secrets] --no-focus -- <agent command>` starts either interactive `claude "<brief>" --permission-mode auto` or interactive `codex --sandbox workspace-write --ask-for-approval on-request ... "<brief>"`. The composed brief is the first prompt, and the agent stays live for steering or direct attachment.

**No `agent rename`.** Verified live against herdr 0.7.1: renaming an agent
changes its resolvable name, after which `agent get <taskId>` returns
`agent_not_found` — which would make the reconciler read every renamed agent as
DEAD and false-requeue it. The tab label carries the id+title; the agent keeps
its canonical `taskId` name so probe/send/focus by `agent_target` keep resolving.
Per-project `config.agent_argv` overrides the command verbatim (the operator owns
briefing in that case).

**Model selection.** Claude workers stay explicitly pinned by task kind: `ship → opus`, `scout`/`chore` → `sonnet`, overridable through `config.model` or `config.model_by_kind`. Codex workers inherit the current ChatGPT/Codex default unless `config.codex_model` or `config.codex_model_by_kind` is set. `config.agent_argv` bypasses both paths. The planner one-shot remains Claude and is pinned to `sonnet` unless `config.planner_argv` overrides it.

## Stale recovery loop (`server/src/reconciler.ts`)

`syncAgents` probes every agent-bearing task each cycle; a vanished agent is
recorded as `agent_status: gone` (so health shows `dead` within one cycle).
`recoverStale` then runs the decision tree for any task whose agent is `gone`
(recovered the SAME cycle — the SPEC requires catching a ghost within one cycle)
or whose newest meaningful event is `stale`:

- **Dead** → capture the pane tail (`herdr agent read`) as `log` evidence, mark
  the task `failed`, and auto-requeue a fresh `source="requeue"` task under a cap
  of 2 (lineage counted via `parent_task_id`); the 3rd death opens a decision
  card (`openRecoveryDecision`, answer `requeue` → another fresh task).
- **Alive but silent** → nudge via `herdr agent send`; after 3 silent cycles,
  fail + open the same decision card.

The requeue/nudge backoff is the stale threshold itself: each action writes an
event that resets the task's age, so the next step only fires one threshold
later. All actions are evented and broadcast over SSE.

Persistent chat-supervisor tasks are excluded from worker staleness and stale
recovery: idle is their normal state between director turns and manager
wakeups. A later director turn or descendant event probes the session and
respawns it if needed, preserving the thread rather than failing/requeueing the
manager as project work.

### Probe: three death shapes

`herdr agent get` reports a vanished agent inconsistently (all verified live on
0.7.1), so `Herdr.probe` treats ALL of these as dead while a transient/unparseable
result stays alive (never a false requeue):
- `agent_not_found` on **stdout**, exit 0 (a never-known target); and
- `agent_not_found` on **stderr**, exit 1 (an agent that EXITED); and
- an agent record present but with a **null `pane_id`** (a just-reaped pane).

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
  clears it. `cleanupTask` always closes the session itself once the worktree
  is gone, so this is handled in normal operation — but task #341 found it
  DOES bite when `git worktree remove` fails because the tree was already
  gone from disk: `cleanupWorktree` used to read that failure as "preserved"
  and leave the session running forever. Fixed: an "already gone" removal
  failure now reports `removed: true` (nothing was there to preserve), so the
  session still closes. The reaper also runs `sweepOrphanedAgents` every
  cycle, diffing `herdr agent list` against live DB tasks, as a backstop for
  any agent whose task row no longer exists at all.

- **The pty pool is a hard, low OS cap (macOS `kern.tty.ptmx_max`, 511) and a
  dead pane has no agent.** `agent list` is blind to a leaked pane, so it hit
  511/511 twice on 2026-07-25 (every spawn failing `openpty: Os { code: 6 }`)
  from two sources: the per-task workspace `worktree create` auto-spawns (its
  lone pane never used, since the agent runs in the shared fleet tab) and fleet
  tabs whose agent already exited. The reaper's `sweepOrphanedPanes` closes them:
  it enumerates `herdr pane list` (one pty each), maps each pane to a task by cwd
  basename `hive-<task-id>`, and reclaims the pty of any whose task is terminal
  or gone — the worktree's own workspace via `workspace close <id>` (a
  terminal-UI op that leaves the checkout on disk untouched, NOT `worktree
  remove`), a fleet tab via `pane close`. It resolves the fleet workspace id
  READ-ONLY first and bails if it can't, so it can never close the shared fleet.
  Live tasks are kept by construction (the decision reads DB state, never a herdr
  probe). Utilization surfaces on `/api/health` as `sessions` (warn at 80% of
  `HIVE_PTY_MAX`).

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

The visible-fleet + stale-recovery rework has its own end-to-end harness:

```bash
bun run scripts/herdr-rework-verify.ts 2>&1 | tee docs/evidence/herdr-rework-verification.txt
```

It boots a scratch hive server in-process against the real herdr and drives a
task through the whole new pipeline (interactive claude in the `hive-fleet`
workspace with a labelled tab, hook wiring + a live hook event) then the full
recovery loop (agent exits → reconciler fails + auto-requeues twice → the cap
opens a decision card). The committed transcript is
`docs/evidence/herdr-rework-verification.txt`.
