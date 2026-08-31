# hive

Local-first orchestration control plane built around one persistent Chief of Staff. The default web home shows a compact briefing, the current exchange, and one consequential decision at a time. Earlier conversation and detailed agent activity stay behind progressive disclosure, while search and a single Browse menu keep operational views available without competing for attention. hive owns durable state (SQLite), an event-driven timeline, evidence, policies, and a server-enforced task state machine. See [SPEC.md](./SPEC.md) for the full product spec and [docs/API.md](./docs/API.md) for the HTTP contract.

This repo contains **Phase 1** (server core + CLI) and **Phase 2b** (the runtime layer: herdr adapter, reconciler, monitors + post-deploy smoke, secrets, and Claude Code/Codex hooks). The web app is built separately against `docs/API.md`.

New here? Start with **[docs/GETTING-STARTED.md](./docs/GETTING-STARTED.md)**: the eight concepts, the five commands you actually need, and what to check when a task will not run.

## Requirements

- [Bun](https://bun.sh) (tested on 1.3.x and 1.4.x).
- [Git](https://git-scm.com/) and [Herdr](https://herdr.dev/) — **Herdr is a
  hard prerequisite for running agents.** Without it installed and running,
  hive's server and web UI still work and you can browse the board, but no
  agents will spawn. GitHub CLI (`gh`) is optional but required for
  pull-request review and merge automation.
- The [Claude Code](https://claude.com/product/claude-code) or
  [Codex](https://developer.openai.com/codex/cli/) CLI — these are the agent
  binaries workers run through Herdr, selected per project by
  `config.agent`.
- On Windows, install Git for Windows. Hive automatically supplies its
  `bash.exe` location to native Claude Code through
  `CLAUDE_CODE_GIT_BASH_PATH`.

## Install

```bash
bun install                    # root: server + CLI deps
(cd web && bun install)        # web app deps
(cd electron && bun install)   # desktop app deps
```

## Run

```bash
bun run server/src/index.ts     # start the daemon on 127.0.0.1:4700
# or via the CLI:
bin/hive serve
```

Native Windows PowerShell/cmd:

```powershell
bun run server/src/index.ts
bin\hive.cmd serve
```

### Web app

The server serves `web/dist` statically once built. For development:

```bash
cd web
bun run dev      # Vite dev server with hot reload
bun run build    # production build to web/dist
```

For deployments, `scripts\sync-main.ps1` is the native Windows counterpart to
`scripts/sync-main.sh`; invoking the shell script from Git Bash dispatches to it
automatically. It syncs `main`, rebuilds and installs the desktop app, restarts
the Hive server, and verifies `/api/health`.

Repository paths may use the host's normal absolute syntax: `/Users/me/repo`,
`C:\Users\me\repo`, `D:/src/repo`, or a UNC path such as
`\\server\share\repo`. Relative paths and drive-relative forms such as
`C:repo` are rejected.

Environment:
- `HIVE_DB` — SQLite file path (default `~/.hive/hive.db`; parent dir auto-created).
- `HIVE_PORT` — server port (default `4700`).
- `HIVE_HOME` — base dir for evidence files (default `~/.hive`).
- `HIVE_URL` — base URL the CLI talks to (default `http://127.0.0.1:$HIVE_PORT`).

Claude Code accounts can be routed by original project path with the
machine-local `$HIVE_HOME/claude-profiles.json` file. Hive applies the selected
`CLAUDE_CONFIG_DIR` to planners, reviewers, critics, and Herdr workers; matching
uses the original repository path even though workers run in separate
worktrees. The longest containing root wins. Projects outside every route use
`default_config_dir` when provided; omitting it preserves Claude's normal
personal default with no `CLAUDE_CONFIG_DIR` override:

```json
{
  "default_config_dir": "/Users/me/.claude",
  "routes": [
    { "root": "/Users/me/work/company", "config_dir": "/Users/me/.claude-company" }
  ]
}
```

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
bin/hive task send <task-id> "..."    # attributed peer message when run by an agent
bin/hive task list [--state <s>] [--project <id>]
bin/hive emit <task-id> status --note "..."
bin/hive emit <task-id> evidence --file ./shot.png --note "caption"
bin/hive emit <task-id> done --note "summary"
bin/hive decision ask <task-id> --title "..." --risk high \
    --option go:Go:"do it" --option wait:Wait:"hold" --recommend go
bin/hive decision auto-answer <decision-id> --key <option> [--reason "..."]
    # supervisor self-approval; answers only if the server safety bar clears,
    # else exits 3 and leaves the card open for the director
bin/hive policy add --title "..." --body "..." [--scope global|project:<id>]
bin/hive policy list [--scope <s>]
bin/hive learning add --project <id> --title "..." --kind failure|reference [--body "..."] [--root-cause]
bin/hive learning list [--project <id>] [--status active|resolved]
bin/hive learning recur <learning-id>   # bump occurrences when the pattern recurs
bin/hive spawn <task-id>                # start a herdr agent for a task
bin/hive chat send [--project <id>|--thread <id>] "..."  # message the persistent chat supervisor
bin/hive chat close <thread-id>         # end a thread's live session (reclaims its worktree/agent)
bin/hive gchat auth                     # one-time Google Chat OAuth consent (intake connector)
echo -n "s3cret" | bin/hive secret set --project <id> --name API_KEY
bin/hive secret list --project <id>
bin/hive secret rm --project <id> --name API_KEY
bin/hive open
```

## Layout

```
server/src/  db.ts state.ts briefs.ts api.ts bus.ts rows.ts exec.ts
             secrets.ts monitors.ts reconciler.ts runtime/herdr.ts index.ts
cli/hive.ts  bin/hive bin/hive.cmd     CLI
hooks/       hive-hook.ts hive-hook.sh install.md   Claude Code/Codex lifecycle hooks
scripts/     demo-seed.ts
docs/API.md  the HTTP contract (the web app builds against this)
docs/design-history.md  per-phase/version design decisions and incidents
server/test/ bun test suite
```

## Design history

Per-phase/version design decisions and incident-driven changes (Phase 1, Phase 2b, v2, v3, v4) have moved to [docs/design-history.md](./docs/design-history.md).

## v5 notes (JIRA bidirectional sync)

- **JIRA sync** (`server/src/intake/jira.ts`) mirrors one Atlassian Jira project,
  discovers native task links, and keeps `status` in step BOTH ways, every
  `HIVE_JIRA_SYNC_MS` (default 60s). `tasks.jira_key` is the shared issue link,
  `tasks.jira_link_kind` distinguishes inbound mirrors from outbound sub-tasks,
  and `intake_cursors` holds the distinct
  direct-missing and scope-absence streaks. Per-project `config.jira`:
  `{site, email, project_key, enabled, write, jql?, write_scope?, status_notes_to_comments?}`. Two independent gates —
  `enabled` (master switch) and `write` (shadow mode) — both default to **false**,
  so the connector is a hard no-op until opted in, and read-only until opted in
  again. Under `write: false` every outbound call is computed and LOGGED but never
  sent, including on the first cycle, so a director can read one full
  "would have done X" pass before hive touches a real issue.
- **Native task links.** `hive jira link <task-id> --parent WEB-7` creates one
  Jira sub-task with a `hive-task: <id>` description marker, an issue property,
  and remote links to Hive and the task PR. This requires
  `write_scope.create_subtask: true`. Each cycle also finds Jira issues with the
  marker or property and fills an empty `jira_key`, so manually created sub-tasks
  self-link without Jira custom fields or site-admin access. Linked native task
  states map to To Do, In Progress, In Review, or Done. With
  `status_notes_to_comments: true`, `hive emit <id> status` notes become Jira
  comments through the existing at-most-once delivery ledger. The default is false.
<!-- BEGIN GENERATED JIRA WRITE SCOPE -->
- **Field ownership.** Jira owns `summary`, `description`, `issue type`, `priority`, and all labels except `hive:needs-decision`. Hive's generated write scope is `status`, `comments` and evidence receipts, `attachments` (up to 3 screenshots on UI work only: evidence hive already holds, or one it renders at review when the task has none), and `hive:needs-decision` label; everything else flows Jira → hive only. Creating a Jira sub-task is a separate, default-off project opt-in through `write_scope.create_subtask`. **hive never writes the assignee at all.** It reads the field to display it and stops there because Jira Cloud has no compare-and-swap across the separate check and write requests, so "a human's assignment is never touched" only holds absolutely if hive never touches it (dec_234877ea4617). `GET /api/tasks/:id/jira` exposes the same registry as `write_scope`. `needs_decision` has no Jira status, `verifying` maps to In Review, and `failed` never moves Jira. A linked native task maps `cancelled` to Done and posts a cancellation comment.
<!-- END GENERATED JIRA WRITE SCOPE -->
- **Rendered screenshots are opt-in and sandboxed.** A UI task that attached no
  screenshot can have one rendered at review time with the target repo's own
  Playwright harness. That runs the PR branch's own config, so it is off unless
  the project config sets `render_proof: true`, and the run happens inside a
  macOS seatbelt that may write only to the task's worktree and the temp dirs.
  On any host without seatbelt, or any repo whose harness cannot boot the app
  itself, nothing is rendered and the reason is logged.
- **Idempotent comments and receipts with contained unknowns.** Jira comments
  become timeline entries; hive-side comments are an outbox drained on the next
  cycle; and hive's reports and evidence reach the ticket with links back into
  hive. Every comment hive writes carries a Jira comment *property* naming the
  local row that produced it. A later cycle can recover a missing local receipt
  when that property is visible. Jira does not enforce property uniqueness, so
  there is a real late-arrival window where a timed-out request may still land
  after hive checked the ticket. Hive contains that unknown instead of retrying:
  it remains visibly unresolved until the property appears or a human checks Jira
  and resolves it. Hive therefore never knowingly posts twice and never silently
  drops an ambiguous delivery, but it does not claim atomic uniqueness.
- **Visible sync state.** Every attempt records last success, last error,
  consecutive failures and next due (`intake_cursors`, source `jira-state`), so
  the board can answer "did it run?" without anyone guessing. A failure stays
  visible until a later attempt actually succeeds. `GET /api/tasks/:id/jira`
  serves that plus what is still unresolved; `POST /api/tasks/:id/jira/sync`
  is the manual retry and runs the SAME per-project cycle the timer runs, so it
  can never succeed while the automatic path keeps failing.
- **Converging reconciler, not webhooks.** hive binds loopback and has no public
  ingress, so Jira Cloud cannot reach it. Polling is also the safer design: a
  cycle writes only when the two sides actually differ, so a sync-driven write
  leaves them agreeing and the next cycle finds nothing to do. Loop prevention is
  structural rather than a marker every code path must remember to check. The
  agreement test compares JIRA-STATUS space, not hive-state space, because the
  mapping is 2:1 (`in_review` and `verifying` both show as "In Review").
- **Credential gate.** `config` is writable through the loopback API, so the
  target's SHAPE is validated before anything else (`credentialTargetValid`):
  https only, no userinfo, a real hostname, a valid email, an uppercase project
  key, and the site rebuilt from parsed components so no remnant of the config
  string reaches `fetch()` or the auth header. The gate runs before secret
  resolution and before any auth header exists; a malformed target yields `null`
  (hard no-op).
- **Eventual consistency.** Jira's enhanced search is treated as DISCOVERY-ONLY:
  it returns candidate keys, and every per-issue action derives from one fresh,
  strongly-consistent read (status and its timestamp taken from the same
  changelog record, via the paginated changelog endpoint — search's
  `expand=changelog` truncates at 20 entries). Every Jira write re-reads
  immediately before acting and aborts visibly if the premise moved. Scope that
  cannot be CONFIRMED blocks writes. A linked issue omitted by search is
  strong-read before either absence streak changes. A direct issue-read 404
  advances only the missing streak; a coherent out-of-scope observation
  advances only the separate scope streak; an in-scope observation resets both;
  and an operational failure leaves both unchanged while failing the cycle
  visibly. Neither signal deletes or terminally transitions the task. After
  `ABSENT_STREAK_LIMIT` consecutive observations of one kind it earns one
  visible `sync_stopped` event and then goes quiet. Auth is HTTP Basic (`email:api_token`);
  bearer is rejected by this site with a Connect-JWT parse error.
