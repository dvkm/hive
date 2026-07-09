# hive

Local-first orchestration control plane. David delegates work to AI agents and
interacts only through a kanban board and a decision inbox. hive owns durable
state (SQLite), an event-driven timeline, evidence, policies, and a
server-enforced task state machine. See [SPEC.md](./SPEC.md) for the full
product spec and [docs/API.md](./docs/API.md) for the HTTP contract.

This repo contains **Phase 1** (server core + CLI) and **Phase 2b** (the runtime
layer: herdr adapter, reconciler, monitors + post-deploy smoke, secrets, and
Claude Code hooks). The web app is built separately against `docs/API.md`.

## Requirements

- [Bun](https://bun.sh) (tested on 1.3.x). No other dependencies.

## Run

```bash
bun run server/src/index.ts     # start the daemon on 127.0.0.1:4700
# or via the CLI:
bin/hive serve
```

Environment:
- `HIVE_DB` — SQLite file path (default `~/.hive/hive.db`; parent dir auto-created).
- `HIVE_PORT` — server port (default `4700`).
- `HIVE_HOME` — base dir for evidence files (default `~/.hive`).
- `HIVE_URL` — base URL the CLI talks to (default `http://127.0.0.1:$HIVE_PORT`).

## Seed a demo board

```bash
bun run scripts/demo-seed.ts            # one project, a task in every state,
                                        # an open decision, evidence images
bun run scripts/demo-seed.ts --reset    # wipe all rows first
```

## Tests

```bash
bun test
```
Covers the state machine (including `done`-without-evidence rejection), event
ingestion, evidence upload round-trip, decision draft autosave + answer flow,
and brief composition.

## CLI

`bin/hive` is a bun shebang script (thin HTTP wrapper; the server is the only DB writer).

```bash
bin/hive task create --project <id> --title "..." [--brief file.md] [--kind ship|scout|chore]
bin/hive task list [--state <s>] [--project <id>]
bin/hive emit <task-id> status --note "..."
bin/hive emit <task-id> evidence --file ./shot.png --note "caption"
bin/hive emit <task-id> done --note "summary"
bin/hive decision ask <task-id> --title "..." --risk high \
    --option go:Go:"do it" --option wait:Wait:"hold" --recommend go
bin/hive policy add --title "..." --body "..." [--scope global|project:<id>]
bin/hive policy list [--scope <s>]
bin/hive spawn <task-id>                # start a herdr agent for a task
echo -n "s3cret" | bin/hive secret set --project <id> --name API_KEY
bin/hive secret list --project <id>
bin/hive secret rm --project <id> --name API_KEY
bin/hive open
```

## Layout

```
server/src/  db.ts state.ts briefs.ts api.ts bus.ts rows.ts exec.ts
             secrets.ts monitors.ts reconciler.ts runtime/herdr.ts index.ts
cli/hive.ts  bin/hive        CLI
hooks/       hive-hook.sh install.md   Claude Code lifecycle hooks
scripts/     demo-seed.ts
docs/API.md  the HTTP contract (the web app builds against this)
server/test/ bun test suite
```

## Phase 1 notes (where the spec was silent, the choice made)

- **IDs**: tasks use a bare 12-char hex id (clean in `hive/<id>` branch names);
  other rows use short prefixed ids (`proj_`, `evt_`, `ev_`, `dec_`, `pol_`).
- **Migrations**: an ordered SQL list tracked by `PRAGMA user_version`. Append a
  block to migrate; never edit an applied one. (No down-migrations; not needed.)
- **State machine edges beyond the spec's linear chain**: `verifying → in_progress`
  is allowed so a failed post-merge smoke check can bounce a task back (spec's
  monitor section calls for exactly this). `needs_decision ⇄ in_progress` per spec.
- **`hive emit blocked`** records a `blocked` event but does **not** force a state
  change (there is no `blocked` state; the director decides). `needs-decision` and
  `done` do drive transitions.
- **Answering a decision** auto-resumes the task (`needs_decision → in_progress`)
  and records a `decision_answered` event.
- **CORS** is wide open so a Vite dev server on another port can call the API.
- **SSE** has no backfill on connect: load state via REST, then apply deltas.
- **Evidence** is copied into `~/.hive/evidence/<task_id>/` and served from
  `/evidence/...`; never local-path-only, never lost to gitignore.

## Phase 2b notes (runtime layer)

- **herdr adapter** (`server/src/runtime/herdr.ts`) is a thin subprocess layer
  over the `herdr` CLI with an injectable `Exec`, so command construction and
  teardown safety are unit-tested without a live herdr server. `HERDR_BIN`
  overrides the binary path.
- **Teardown refuses to destroy work**: `herdr worktree remove` runs only after
  the branch is pushed to origin or merged into the default branch (verified
  with git); otherwise it returns `{removed:false}`.
- **Reconciler** (`server/src/reconciler.ts`, 60s; `HIVE_RECONCILE_MS`) syncs
  herdr agent status, `gh pr view` CI/merge state, and flags tasks silent past
  `HIVE_STALE_MS` (default 15m) as `stale`. Every cycle is failure-isolated and
  emits at most one `reconciler_error` per cycle; it never crashes the server.
- **Monitors** (`server/src/monitors.ts`, 60s; `HIVE_MONITOR_MS`) run per-project
  URL checks from `config.monitors`; failures open incidents + SSE + an
  `osascript` notification (non-fatal if unavailable) and, behind
  `config.monitors_auto_task`, an auto `chore` task. Post-deploy smoke
  (`config.smoke`) runs once on `verifying`: pass → `test_run` evidence,
  fail → back to `in_progress`.
- **Secrets** store names/refs only (migration v2). Values live in macOS
  Keychain (`security`) or Bitwarden (`bw`), resolved at spawn and injected as
  env; the server redacts known secret values from stored payloads. Manage with
  `hive secret set|list|rm` (`set` reads the value from stdin).
- **Hooks** (`hooks/`) POST liveness events to `$HIVE_URL` when `$HIVE_TASK_ID`
  is set; fail silent + fast (2s curl cap). See `hooks/install.md`.
