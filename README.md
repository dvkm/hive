# hive

Local-first orchestration control plane built around one persistent Chief of Staff. The default web home shows a compact briefing, the current exchange, and one consequential decision at a time. Earlier conversation and detailed agent activity stay behind progressive disclosure, while search and a single Browse menu keep operational views available without competing for attention. hive owns durable state (SQLite), an event-driven timeline, evidence, policies, and a server-enforced task state machine. See [SPEC.md](./SPEC.md) for the full product spec and [docs/API.md](./docs/API.md) for the HTTP contract.

This repo contains **Phase 1** (server core + CLI) and **Phase 2b** (the runtime layer: herdr adapter, reconciler, monitors + post-deploy smoke, secrets, and Claude Code/Codex hooks). The web app is built separately against `docs/API.md`.

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
cli/hive.ts  bin/hive        CLI
hooks/       hive-hook.sh install.md   Claude Code lifecycle hooks
scripts/     demo-seed.ts
docs/API.md  the HTTP contract (the web app builds against this)
server/test/ bun test suite
```

## Phase 1 notes (where the spec was silent, the choice made)

- **IDs**: tasks use a bare 12-char hex id (clean in `hive/<id>` branch names);
  other rows use short prefixed ids (`proj_`, `evt_`, `ev_`, `dec_`, `pol_`).
- **Migrations**: name-keyed, tracked in a `schema_migrations` table, one SQL
  statement per array element. Append an entry with a fresh `name`; never rename
  or edit an applied one. (No down-migrations; not needed.) Position-keyed
  migrations were tried and lost a column: two branches each appended one, the
  merge renumbered them, and `PRAGMA user_version` both skipped a migration and
  re-ran a different one. Names survive a merge, and a statement is applied only
  if the schema is missing what it would create, so a DB that drifted ahead of
  the ledger heals on the next open instead of crashing. A DB with no ledger
  re-runs every migration idempotently, which adopts the ledger and backfills
  whatever the counter skipped. Anything that isn't a `CREATE`/`ALTER` (a
  backfill `UPDATE`) re-runs on a heal, so write it to be a no-op once applied.
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
  overrides the binary path. Projects choose `config.agent: "claude" | "codex"`; the latter launches an interactive Codex worker using the machine's ChatGPT login (`codex login`) while preserving Hive's lifecycle and command-policy hooks.
- **Teardown refuses to destroy work**: `herdr worktree remove` runs only after
  the branch is pushed to origin or merged into the default branch (verified
  with git); otherwise it returns `{removed:false}`.
- **Dispatcher** (`server/src/dispatcher.ts`, 30s; `HIVE_DISPATCH_MS`) makes hive
  self-driving: it picks up `queued` tasks and spawns agents so work created in
  the web UI actually runs instead of sitting in Queued. Opt-in per project
  (`config.auto_dispatch`, default off), except tasks explicitly delegated by an
  active chat manager; honors `dispatch_kinds`
  (default `["ship","scout"]`), `max_agents` (default 3, concurrency cap),
  skips unreviewed `intake_gchat` tasks, runs the `task.dispatch` authority gate,
  holds tasks with unmet `depends_on` (a listed task not yet merged/done, with a
  visible `dependency_blocked` reason), and backs off exponentially on spawn
  failures (per-task, plus a global circuit breaker that pauses all dispatch when
  the herdr daemon is unreachable so a dead socket isn't pounded once per queued
  task). Shares the spawn core with the
  manual `POST /api/tasks/:id/spawn`. The herdr adapter is verified against a
  live herdr server — see `docs/runtime.md` and
  `docs/evidence/herdr-live-verification.txt`.
- **Reconciler** (`server/src/reconciler.ts`, 60s; `HIVE_RECONCILE_MS`) syncs
  herdr agent status, `gh pr view` CI/merge state, and flags tasks silent past
  `HIVE_STALE_MS` (default 15m) as `stale`. Every cycle is failure-isolated and
  emits at most one `reconciler_error` per cycle; it never crashes the server.
- **Monitors** (`server/src/monitors.ts`, 60s; `HIVE_MONITOR_MS`) run per-project
  URL checks from `config.monitors`; failures open incidents + SSE + a native
  Hive notification (non-fatal if the app is unavailable) and, behind
  `config.monitors_auto_task`, an auto `chore` task. Post-deploy smoke
  (`config.smoke`) runs once on `verifying`: pass → `test_run` evidence,
  fail → back to `in_progress`.
- **Native notifications + deeplinks** (`server/src/notifications.ts`,
  `electron/main.js`). Urgent events (a decision opened, a task handed to
  review, an agent unreachable, a monitor incident) raise a real macOS
  notification through the desktop app, so it carries the hive icon and obeys
  Do Not Disturb. The app already holds an SSE connection
  (`/api/stream?client=app`), so the server delivers over that; only when no app
  is attached does it fall back to launching the app with a `hive://` URL.
  `delivered_at` is set when the app reports the notification actually rendered,
  not when the server tried. Clicking one opens the exact task or decision.
  `cd electron && bun install && bun run build` builds the app into the checkout;
  `bun run install-app` in `electron/` builds and then installs that bundle to
  `/Applications/hive.app`, the canonical copy macOS resolves `dev.hive.app` and
  `hive://` to. Everything that launches the app (`hive app`, the post-deploy
  restart) opens that installed copy, so a checkout build never re-registers
  itself as `dev.hive.app`.
  `hive://` deeplinks work from anywhere (Terminal, another app, a script):

  ```
  open "hive://task/1247"           # task by number or id
  open "hive://decision/dec_ab12"   # the decision card, scrolled to + highlighted
  open "hive://quiz/1b75826af9fb"   # the understanding check on that task
  open "hive://open?path=/inbox"    # any app route
  ```

  Check the whole chain without waiting for a real event: `hive notify --test`
  fires one urgent notification and waits up to 10s for the app to confirm
  macOS rendered it. It fails loudly if nothing did.
- **Secrets** store names/refs only (migration v2). Values live in macOS
  Keychain (`security`) or Bitwarden (`bw`), resolved at spawn and injected as
  env; the server redacts known secret values from stored payloads. Manage with
  `hive secret set|list|rm` (`set` reads the value from stdin).
- **Hooks** (`hooks/`) POST liveness events to `$HIVE_URL` when `$HIVE_TASK_ID`
  is set; fail silent + fast (2s curl cap). See `hooks/install.md`.

## v2 notes (intake connector)

- **Google Chat intake** (`server/src/intake/gchat.ts`, migration v5) schedules checks of each project's `config.gchat_spaces` (`[{space, label?}]`) via `HIVE_GCHAT_POLL_MS` (default 60s) and drafts a `queued` ship task per new message, tagged `source: intake_gchat` and marked UNREVIEWED. Message text is untrusted (stored verbatim, never executed). Images (≤5MB, png/jpg/gif/webp) become evidence; messages dedupe by resource name; self/bot messages skip. OAuth (scope `chat.messages.readonly`) is set up once with `hive gchat auth`; the connector is a hard no-op until a space is configured. Simplest durable home for the allowlist: the existing per-project `config` column (the owning project is the target), so no new table or endpoint.

- **JIRA bidirectional sync** (`server/src/intake/jira.ts`). Mirrors one Jira
  Cloud project onto the board, links native tasks to Jira sub-tasks, and keeps `status` in step BOTH ways, on
  a `HIVE_JIRA_SYNC_MS` (default 60s) cycle. Two independent switches, both off
  by default: `config.jira.enabled` turns the connector on at all, and
  `config.jira.write` releases outbound writes — with `enabled` on and `write`
  off it runs in SHADOW mode, computing and logging every outbound call ("would
  have transitioned WEB-3 to In Review") without sending it, so a dry cycle is
  readable before hive edits a real ticket.

  ```jsonc
  "jira": { "site": "https://example.atlassian.net", "email": "jira@example.com",
            "project_key": "WEB", "enabled": false, "write": false,
            "write_scope": { "create_subtask": false },
            "status_notes_to_comments": false,
            "jql": "labels = sync" }   // optional, ANDed with project = <key>
  ```

  `site`, `email` and `project_key` must match a compiled-in allowlist
  (`credentialTargetAllowed` in `server/src/intake/jira.ts`) or the connector
  is a silent no-op; config alone can't repoint it elsewhere, since
  `projects.config` is writable over hive's unauthenticated loopback API and a
  config-supplied site would otherwise be able to send `JIRA_API_TOKEN`
  anywhere. Changing the allowed target is a code change, not a config edit.

  Auth is HTTP Basic (`email:api_token`) — a personal API token sent as `Bearer`
  is rejected as an unparseable Connect JWT. The token is the project secret
  `JIRA_API_TOKEN` (keychain; never in the DB). Note `/rest/api/3/search` is
  removed (410); this uses `/search/jql`.

  Conflicts resolve by newest status-change time, read from the issue CHANGELOG
  and never from `fields.updated` (which also moves for comments and label edits,
  so it would let an unrelated edit win a status tiebreak). Every overwrite
  writes a `jira_sync` event carrying both sides, both timestamps and the winner.

  Hive creates only explicitly requested sub-tasks for native work through
  `hive jira link <task-id> --parent WEB-7`. The project must set
  `write_scope.create_subtask: true`; the default is false. Mirror tasks never
  create issues. Imported issues are
  tracking-only (`source: external`), so the dispatcher never auto-spawns agents
  on them and the done-gate evidence requirement is skipped (a ticket a human
  closed upstream has no hive PR). Because hive binds loopback with no public
  ingress, inbound is polling rather than a Jira webhook; that also makes loop
  prevention structural, since a cycle writes only when the two sides differ and
  a completed write leaves them agreeing.

## v3 notes (domain supervisors)

- **On-demand planners** (`server/src/planner.ts`, migration v7). A per-project
  planner triages a task and proposes a breakdown. hive rejects long-running LLM
  supervisor sessions (priortool's failure mode): "persistent" means the ROLE +
  CONTEXT live in the DB (project config `supervisor_persona`, `playbook`,
  `plan_intake`, `planner_argv`), while the LLM runs as a short-lived subprocess
  `claude -p <prompt> --output-format json` (timeout-capped by
  `HIVE_PLANNER_TIMEOUT_MS`, default 120s; killed on timeout; injectable exec).
- Triggered by `POST /api/tasks/:id/plan` (manual), every director braindump, or
  connector intake when the project sets `config.plan_intake: true`. The result
  is a risk-scored decision card (`approve`/`reject`) with proposed tasks as a
  checklist, open questions as answer fields, and the scoring reason in the risk
  detail. Every task starts checked; on approve only the checked tasks are
  created `queued` with
  `source="planner"` and `parent_task_id` linking to the source task. Question
  answers and the optional note are copied into each created task's brief.
  Output is parsed defensively; unparseable output records one `planner_error`
  event and stops. New event types: `planning`, `planned`, `planner_error`. See
  `docs/API.md` for the API contract.

## v4 notes (director chat)

- **Persistent Chief of Staff chat** (`server/src/chat.ts`, migration v18). The web home and global drawer reuse one portfolio-wide thread whose conversation and run ledger survive project switches and session respawns. A long-lived herdr agent holds the live context and coordinates worker agents across projects. Project-scoped supervisor threads remain available through the API and CLI. Neither kind owns a privileged path: coordination goes through the same `$HIVE_CLI` + API + standing-authority gates every hive agent uses. See `docs/API.md` for the session contract.
- The backing task (`source="chat_supervisor"`) is kept out of the dispatcher and
  board lanes. `POST /api/chat/turn` is non-blocking (persist → ensure session
  live → return); the session replies asynchronously via `POST
  /api/chat/threads/:id/reply`. `POST /api/chat/threads/:id/close` cancels the
  backing task so the terminal-hook cleanup reclaims its worktree/session; a
  later message to the same thread spawns a fresh session. See `docs/API.md`.
- **Automatic manager loop.** Tasks created by the supervisor are linked to its backing task, and nested follow-ups preserve that ancestry. Meaningful worker events (blockers, decisions, peer messages, review handoffs, failures, verification, and completion) are batched and pushed into the global Chief of Staff when it is active, so it can re-plan and act without another director turn. It applies each target project's autonomy profile before handling low-risk work or escalating a consequential decision. Workers use `hive task send <task-id> "..."` for attributed, durable peer messages. The manager keeps a source-linked commitment ledger separate from worker tasks, and bounded meetings end in one compact memo containing the recommendation, rationale, dissent, evidence, and risk. Independent integrated verification is required before it reports the top-level ask complete.
- **Autonomy benchmark.** `bun run benchmark:autonomy` creates a disposable release-planning repository, registers it as an isolated Hive project, and gives its supervisor a clear top-level ask plus a bounded two-scout design meeting. `bun run benchmark:score <workspace>` gates on implementation, evaluator integrity, run completion, verification, retrospective, no extra human turns, no open decisions, completed commitments, and a final decision memo.
- **Supervisor auto-approve** (`server/src/autoapprove.ts`, task #364). The
  supervisor may clear a narrow set of safe decision cards itself instead of
  always waiting on the director, via `hive decision auto-answer <id> --key <opt>`
  / `POST /api/decisions/:id/auto-answer`. The safety bar is enforced
  server-side (a worker on loopback gets the same verdict): a CLOSED allow-list
  of three intrinsically-reversible categories (reference capture,
  high-confidence duplicate merge, task requeue), gated on the raiser's own
  `recommended` option, low/normal risk, and a non-prod/shared blast radius. A
  pending standing-authority command grant is never auto-approvable, but its
  recommended `deny` is fail-closed and may be cleared automatically. Cleared
  cards write an `auto_approved` audit event tagged `source="chat_supervisor"`;
  declined cards stay open, log `auto_approve_declined`, and return `403` so the
  supervisor escalates. Everything else routes to the director as before.

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
- **Field ownership.** Jira owns `summary`, `description`, `issue type`, `priority`, and all labels except `hive:needs-decision`. Hive's generated write scope is `status`, `comments` and evidence receipts, `attachments` (up to 3 screenshots hive already holds as evidence, on UI work only), and `hive:needs-decision` label; everything else flows Jira → hive only. Creating a Jira sub-task is a separate, default-off project opt-in through `write_scope.create_subtask`. **hive never writes the assignee at all.** It reads the field to display it and stops there because Jira Cloud has no compare-and-swap across the separate check and write requests, so "a human's assignment is never touched" only holds absolutely if hive never touches it (dec_234877ea4617). `GET /api/tasks/:id/jira` exposes the same registry as `write_scope`. `needs_decision` has no Jira status, `verifying` maps to In Review, and `failed` never moves Jira. A linked native task maps `cancelled` to Done and posts a cancellation comment.
<!-- END GENERATED JIRA WRITE SCOPE -->
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
- **Credential gate.** `config` is writable through the loopback API, so the site
  and email are pinned to compiled-in constants (`credentialTargetAllowed`),
  matched EXACTLY — https only, no userinfo, no suffix match, since Atlassian
  Cloud sites are self-serve and `*.atlassian.net` would be free for an attacker
  to register. The gate runs before secret resolution and before any auth header
  exists; a mismatch yields `null` (hard no-op). Adding a site is a PR.
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
