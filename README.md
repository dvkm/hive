# hive

Local-first orchestration control plane. David delegates work to AI agents and
interacts only through a kanban board and a decision inbox. hive owns durable
state (SQLite), an event-driven timeline, evidence, policies, and a
server-enforced task state machine. See [SPEC.md](./SPEC.md) for the full
product spec and [docs/API.md](./docs/API.md) for the HTTP contract.

This repo currently contains **Phase 1: the server core + CLI**. The web app,
herdr runtime adapter, Claude Code hooks, monitors, and reconciler are later
phases and are built against `docs/API.md`.

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
bin/hive open
```

## Layout

```
server/src/  db.ts state.ts briefs.ts api.ts bus.ts rows.ts index.ts
cli/hive.ts  bin/hive        CLI
scripts/     demo-seed.ts
docs/API.md  the HTTP contract (Phase 2 builds against this)
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
  and records a `decision_answered` event. Dispatching the answer to the live
  agent (`herdr agent send`) is stubbed until Phase 2.
- **`/api/tasks/:id/send`** is a stub that records a `steer` event. Real steering
  needs the herdr adapter (Phase 2).
- **CORS** is wide open so a Vite dev server on another port can call the API.
- **SSE** has no backfill on connect: load state via REST, then apply deltas.
- **Evidence** is copied into `~/.hive/evidence/<task_id>/` and served from
  `/evidence/...`; never local-path-only, never lost to gitignore.
