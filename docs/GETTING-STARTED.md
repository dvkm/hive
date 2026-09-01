# Getting started with hive

hive runs coding agents against your repos and keeps the result on a board. This page teaches the model: eight ideas, five commands, and a checklist for when nothing happens. Read it once and the rest of hive is lookup.

It assumes the daemon is already running (`bin/hive serve`, see [README](../README.md)). Everything here is the CLI at `bin/hive`, talking to the daemon over HTTP.

## The eight concepts

### 1. Project

A project is a repo plus the config that governs it. Four config fields decide whether anything happens at all.

- `auto_dispatch` (default `false`): the master switch. If this is not `true`, hive never starts an agent on its own.
- `dispatch_kinds` (default `["ship","scout","chore"]`): which kinds of task auto-dispatch is allowed to start.
- `max_agents` (default `3`): how many agents this project may run at once.
- `default_branch`: the project's integration branch, defaulting to `main`. Agents branch from it, PRs target it, and hive compares against it.

Read a project's config straight from the API:

```
$ curl -sS "$HIVE_URL/api/projects" | jq -c '.[] | select(.name=="hive") | {id, repo_path, config: {auto_dispatch: .config.auto_dispatch, dispatch_kinds: .config.dispatch_kinds, max_agents: .config.max_agents, default_branch: .config.default_branch}}'
{"id":"proj_e60f3994fbf7","repo_path":"/Users/david/projects/hive","config":{"auto_dispatch":true,"dispatch_kinds":["ship","scout","chore"],"max_agents":4,"default_branch":null}}
```

A `null` `default_branch` is normal. It means the project has not overridden the default, so hive uses `main`.

### 2. Task

A task is a title plus a brief. **The brief is the entire contract with the agent.** The agent has none of your context: not this conversation, not the ticket you read, not the thing you noticed yesterday. It gets the brief, the repo, and nothing else.

A good brief says four things: what to change, where (real file paths), why, and how you will know it is done. A bad brief says "fix the caching". Write the done criterion as something runnable, like a test that must pass or a command that must exit 0.

```
$ bin/hive task create --project proj_cba979b8bb15 \
    --title "Cache the /api/projects response for 30s" \
    --brief-text "Repeated board polls hit SQLite for the same rows. Add a 30s in-memory cache in server/src/api.ts around the GET /api/projects handler, invalidated on project create/update. Done when: bun test passes and two rapid GETs show one DB read in the log." \
    --kind ship
created task 49be6df24af4  [queued]  Cache the /api/projects response for 30s
```

If `create` prints `[cancelled]` instead of `[queued]`, hive matched your task against an existing one and folded it in as a duplicate. The work is not lost, it lives on the surviving task.

### 3. Kind

Every task is one of three kinds.

- `ship`: change the code and open a pull request.
- `scout`: investigate and write a report. A scout cannot finish without a report attached as evidence.
- `chore`: maintenance and cleanup.

Kind matters because of `dispatch_kinds`. A task whose kind is not in the project's list stays queued forever, no matter how correct the brief is. That is a project setting, not a task problem.

### 4. State

```
queued -> in_progress -> in_review -> verifying -> done
```

Plus `needs_decision` when a question is parked, and `failed` or `cancelled` from anywhere.

Who moves each edge:

| Edge | Moved by |
| --- | --- |
| `queued -> in_progress` | the dispatcher, when it spawns an agent (or you, with `hive spawn`) |
| `in_progress -> needs_decision` | the agent, when it opens a decision card |
| `in_progress -> in_review` | the agent, with `hive emit <id> ready` |
| `in_review -> in_progress` | the director, when they request changes |
| `in_review -> verifying` | the reconciler, once the PR is merged |
| `verifying -> done` | the director, and only the director, after they verify the work |
| anything -> `failed` / `cancelled` | the reconciler or the director |
| `in_review` / `in_progress` -> `done` | the director, for a tracking-only task only (see Source below): hive never runs an agent on it, so there is no PR to merge and no review to pass |

Three rules the server enforces. Hive never moves a task to `done`: every merge stops in `verifying` and waits for a person, so `verifying` is the director's accept queue and not a passing phase. A task cannot reach `done` without at least one evidence item. And `failed` is not the end: a failed task can go back to `queued` for another attempt, so a chain that looks like it stopped at a failure has often already been requeued.

### 5. Source

A task records what created it: `agent` when another agent filed it, `requeue` after a retry, `intake_gchat` from a chat message, and so on. A task you filed yourself has no source at all. One value changes everything.

**`source='external'` means hive records the task but never runs it.** These are mirrored rows, a Jira issue or another team's kanban entry, tracked on your board so you can see them. The dispatcher skips them permanently. No agent will ever be spawned, and no amount of `auto_dispatch` will change that.

If a task sits queued and nothing you change makes it start, check its source first.

```
$ curl -sS "$HIVE_URL/api/tasks/<task-id>" | jq '{state, source, skip}'
```

### 6. Dispatch versus spawn

**Dispatch is automatic.** A loop runs every 30 seconds, picks up queued tasks, and starts agents for them, subject to the project settings above.

**Spawn is manual.** `hive spawn <task-id>` starts an agent right now, for one task, bypassing `auto_dispatch`, `dispatch_kinds` and the `max_agents` cap. It still checks the authority rules, and it still refuses a task hive must never run (see Source above).

A queued task might not be running for any of these reasons. Each one is recorded on the task as a `skip` reason, so you never have to guess:

| Reason | Meaning | Fixable by |
| --- | --- | --- |
| `auto_dispatch_off` | auto-dispatch is off for this project | project config |
| `kind_excluded` | the kind is not in `dispatch_kinds` | project config |
| `tracking_only` | `source='external'`, never dispatched | nothing, this is by design |
| `no_repo_path` | the project has no repo path | project config |
| `authority_denied` | an authority rule denies `task.dispatch` | an authority rule |
| `no_capacity` | at the project's `max_agents` cap | wait |
| `dependency_blocked` | waiting on unfinished dependencies | wait |
| `spawn_backoff` | cooling down after a spawn failure | wait, then read the `spawn_error` event |
| `intake_unreviewed` | raw intake, waiting on your review | you |
| `triage_hold` | waiting on your intake triage answer | you |
| `repo_mismatch` | the brief targets another project's repo | fix the brief |
| `authority_decision` | waiting on a dispatch decision card | answer the card |

The `skip` field on `GET /api/tasks/:id` carries the reason, a plain-English label, and whether it is `permanent`. Permanent means nothing will change until a person changes a setting. The rest just means "not yet".

### 7. Decisions

When an agent hits a question only you can answer, it opens a decision card: a question, the context behind it, two to four concrete options, and the agent's recommendation. The task parks in `needs_decision` until you answer.

Each card carries a `risk`. Set `decision_auto_answer_hours` in the project config and a card that sits unanswered past that many hours gets auto-answered with the recommended option. Two kinds never auto-answer: `risk: "high"` cards, which cover authority grants and anything touching production, and cards whose recommended option needs you to supply something like a credential or a file. Those wait for a human no matter how long they sit.

Set `decision_auto_answer_hours` to `0` (the default) to turn the timeout off entirely.

### 8. Landing

An agent opens its PR, then hands off with `hive emit <id> ready`, which links the PR and moves the task to `in_review`. From there the work needs a merge, and **a merge is the director's call.**

You mark reviewed tasks approved to land, and hive merges them in a safe order:

```
$ bin/hive land 95fd656a8ab8
1 task(s) queued to land
```

Order matters because branches collide. `hive land-graph` shows what has to wait for what:

```
$ bin/hive land-graph --project proj_e60f3994fbf7
#1504 Take-over / hand-back verb for a task worktree  conflicts with  #1503 Best-of-N task racing across Claude and Codex (docs/API.md, server/src/api.ts, server/src/db.ts, web/src/lib/api.ts, web/src/views/Task.tsx)
#1655 Priority in the UI and CLI  conflicts with  #1503 Best-of-N task racing across Claude and Codex (web/src/lib/api.ts, web/src/styles.css, web/src/views/Task.tsx)
```

Two branches that touch the same file cannot both land in one sweep, so hive lands one and leaves the other for its agent to rebase. Declared dependencies land in order. Everything else lands together.

A project can opt into merging some kinds without asking, with `auto_merge` in its config. That is still your call, made once in config instead of once per PR, and the review gates still run.

## The five commands you actually need

The CLI has a lot of verbs. These five carry almost everything.

```
hive task create --project <id> --title <t> --brief-text <s> [--kind ship|scout|chore]
hive task list [--state <s>] [--project <id>]
hive task move <task-id> <state> [--note <s>]
hive emit <task-id> <type> [--note <s>] [--file <path>]
hive land <task-id...>
```

**`emit` is how an agent reports. `move` is how a human corrects.** That pair is the one genuinely confusing thing in the CLI. `emit` writes an event, and two events (`ready` and `done`) move the task as a side effect, after the server checks that the move is earned. `hive emit <id> ready` is refused if no evidence is attached or CI is red. `move` sets the state directly, no gates, and it exists for when you look at the board and it is simply wrong.

Finding the review queue is `task list`:

```
$ bin/hive task list --state in_review
89ab50a18132  in_review      ship   A deduped create prints [cancelled] with no reason: surface the survivor and the recovery
a4efa67b2314  in_review      ship   328 high-risk decisions resolved with no recorded answerer: attribute every resolution, never auto-resolve high risk
49509cb84df6  in_review      ship   Unsatisfiable spawns retry forever: cap the attempts, and stop worktree removal leaving landmines
234d87df9f72  in_review      ship   Priority in the UI and CLI
```

And correcting the board is `task move`:

```
$ bin/hive task move 49be6df24af4 cancelled --note "demo task for docs/GETTING-STARTED.md"
task 49be6df24af4 -> [cancelled]  Cache the /api/projects response for 30s
```

## When something does not happen

A task is queued and nothing is running. Go down this list in order and stop at the first hit.

1. **Check the state.** `bin/hive task list --project <id>`. A task in `needs_decision` is waiting on you, not stuck. A task in `failed` may already have been requeued as a new task.
2. **Check the source.** `curl -sS "$HIVE_URL/api/tasks/<id>" | jq .source`. If it is `external`, hive will never run it. Stop here.
3. **Check the project's `auto_dispatch` and `dispatch_kinds`.** `curl -sS "$HIVE_URL/api/projects" | jq '.[] | select(.id=="<id>") | .config'`. Off, or the wrong kind, and it stays queued forever.
4. **Check capacity.** Count the project's `in_progress` tasks against `max_agents`. At the cap, everything else waits.
5. **Check for a spawn error.** `curl -sS "$HIVE_URL/api/tasks/<id>/events" | jq '.[] | select(.type=="spawn_error")'`. A broken repo or a down agent runtime backs off and retries, leaving the error visible.

The short version: `GET /api/tasks/:id` returns a `skip` field that answers all five at once, with a label written for a human.

## Next

- [SPEC.md](../SPEC.md), the full product spec. Every noun, every rule.
- [docs/API.md](./API.md), the HTTP contract the web app is built against.
- [docs/runtime.md](./runtime.md), how agents actually get spawned and supervised.
