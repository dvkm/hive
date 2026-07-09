# hive HTTP API — the contract

This is the authoritative contract for the hive daemon. The web app (Phase 2)
must be built against this file. Server: `http://127.0.0.1:4700` (override
`HIVE_PORT`). No auth (localhost tool).

- All request and response bodies are JSON unless noted (evidence upload is
  `multipart/form-data`; the SSE stream is `text/event-stream`; evidence files
  and the static web app are served raw).
- Errors return `{"error": "<message>"}` with a non-2xx status:
  `400` bad input, `404` not found, `409` illegal state transition / already
  answered, `500` internal.
- CORS is fully open (`Access-Control-Allow-Origin: *`) so a Vite dev server on
  another port can call the API directly. `OPTIONS` preflight returns `204`.
- Timestamps are ISO-8601 strings (`new Date().toISOString()`).
- IDs are opaque strings. Some are prefixed (`proj_`, `evt_`, `ev_`, `dec_`,
  `pol_`); task IDs are bare 12-char hex (used in git branch names).

---

## Object shapes

### Project
```json
{
  "id": "proj_ab12...",
  "name": "acme-web",
  "repo_path": "/Users/you/code/acme-web",
  "config": { "default_branch": "main", "deploy_notes": "...", "monitors": [ ... ] },
  "created_at": "2026-07-08T12:00:00.000Z"
}
```
`config` is a free-form object (JSON column). Known keys used elsewhere:
`default_branch` (string, used as the worktree base + merge target),
`deploy_notes` (string),
`monitors` (`[{name, url, expect_status, expect_substring?, interval_s}]`),
`monitors_auto_task` (bool; a monitor failure auto-creates a `chore` task),
`smoke` (`[{name, url, expect_status, expect_substring?}]`, run once on
`verifying`), and `agent_argv` (string[], per-project override of the command
herdr runs, default `["claude","-p",<brief-file>,"--permission-mode","acceptEdits"]`).

### Task
```json
{
  "id": "9da7c5527580",
  "project_id": "proj_ab12...",
  "title": "Add dark mode toggle",
  "brief": "User-facing dark mode toggle in settings.",
  "state": "done",
  "kind": "ship",
  "agent_target": null,
  "worktree_path": null,
  "branch": null,
  "pr_url": "https://github.com/acme/web/pull/1",
  "ci_status": "passing",
  "summary": "Shipped dark mode toggle; all tests green.",
  "created_at": "...",
  "updated_at": "..."
}
```
`state ∈ {queued, in_progress, needs_decision, in_review, verifying, done, failed, cancelled}`
`kind ∈ {ship, scout, chore}`

### Event
```json
{
  "id": "evt_...",
  "task_id": "9da7c5527580",
  "ts": "...",
  "source": "agent",
  "type": "status",
  "payload": { "note": "extracting the middleware" }
}
```
`source ∈ {agent, hook, herdr, reconciler, monitor, director, system}`.
`type` is open-ended. Types the server itself writes:
- `created` — task created. `payload: {title}`
- `state_change` — every state transition. `payload: {from, to, reason}`
- `status` — an agent status note. `payload: {note}`
- `evidence` — an evidence item was attached. `payload: {evidence_id, kind, caption}`
- `needs-decision` — a decision card was opened. `payload: {decision_id, title}`
- `decision_answered` — `payload: {decision_id, answer_key, answer_note}`
- `note` — a free note (e.g. a `done` summary). `payload: {note}`
- `steer` — a steer message was dispatched to the agent. `payload: {message, target}`
- `blocked` — agent reported blocked. `payload: {note}`

Types written by the runtime layer (Phase 2b):
- `spawned` — a herdr agent was started. `payload: {agent_target, branch, worktree_path}`
- `spawn_error` — spawn failed. `payload: {error}`
- `agent_status` — herdr agent status changed (via wait loop or reconciler). `payload: {status}` (`idle|working|blocked`)
- `ci_status` — reconciler synced CI. `payload: {ci_status}` (`passing|pending|failing`)
- `pr_merged` — reconciler detected the PR merged. `payload: {pr_url}`
- `stale` — task silent beyond the threshold. `payload: {silent_ms, threshold_ms}`
- `steer_error` — `herdr agent send` failed. `payload: {error}`
- `smoke_passed` / `smoke_failed` — post-deploy smoke result. `payload: {results:[{name,ok,detail}], evidence_id?}`

### Evidence
```json
{
  "id": "ev_...",
  "task_id": "9da7c5527580",
  "ts": "...",
  "kind": "screenshot",
  "path": "/Users/you/.hive/evidence/9da7c5527580/1720440000_shot.png",
  "url": "/evidence/9da7c5527580/1720440000_shot.png",
  "caption": "Dark mode enabled",
  "meta": {}
}
```
`kind ∈ {screenshot, test_run, log, report, link}`. `path` is the local file
(null for link-only). `url` is the served path (fetch it from the same origin).

### Decision
```json
{
  "id": "dec_...",
  "task_id": "...",
  "ts": "...",
  "title": "Upgrade prod DB now or stage first?",
  "context": "PG16 upgrade is green in staging...",
  "risk": "high",
  "blast_radius": "Production DB acme-prod-db (us-east-1). Reversible via PITR.",
  "options": [
    { "key": "stage", "label": "Run in staging one more week", "detail": "Safest.", "recommended": true },
    { "key": "prod_now", "label": "Upgrade prod tonight", "detail": "2 min freeze." }
  ],
  "status": "open",
  "answer_key": null,
  "answer_note": null,
  "draft_note": null,
  "answered_at": null
}
```
`status ∈ {open, answered, expired}`. `options` is an ordered array; render the
`recommended: true` option first per product rule 3. `draft_note` is the
server-side autosaved draft.

### Policy
```json
{ "id": "pol_...", "scope": "global", "title": "No em-dashes", "body": "Use commas.", "active": true, "created_at": "...", "updated_at": "..." }
```
`scope` is `"global"` or `"project:<project_id>"`. `active` is a boolean.

### Incident
```json
{ "id": "inc_...", "project_id": "...", "monitor": "homepage", "ts": "...", "status": "open", "detail": "expected status 200, got 503" }
```
`status ∈ {open, resolved}`. Opened by a monitor failure (once per monitor while
down), resolved on recovery. See `GET /api/incidents`.

### Secret (metadata only)
```json
{ "id": "sec_...", "project_id": "...", "name": "API_KEY", "provider": "keychain", "created_at": "..." }
```
`provider ∈ {keychain, bitwarden}`. **The API never returns or accepts secret
values.** Values live only in the provider (macOS Keychain / Bitwarden); the DB
stores a reference, and the server redacts any known secret value from stored
event/evidence payloads. Set values with `hive secret set` (reads from stdin).

### Learning (regression ledger)
```json
{
  "id": "lrn_...",
  "project_id": "proj_...",
  "title": "post-merge smoke skipped when config.smoke empty",
  "body": "Root cause + workaround notes.",
  "source_task_id": "9da7c5527580",
  "occurrences": 3,
  "first_seen": "2026-07-08T12:00:00.000Z",
  "last_seen": "2026-07-09T09:00:00.000Z",
  "status": "active",
  "root_cause_task_id": "c21eef921dfd"
}
```
`status ∈ {active, resolved}`. `occurrences` counts how many times the pattern
recurred (bumped via `/recur`). `source_task_id` (the task that first hit it) and
`root_cause_task_id` (the chore task opened to fix it, if any) may be null. Active
learnings for a project are injected into composed briefs (see `/api/tasks/:id/brief`)
under a "Known failure patterns" section, 10 most recent by `last_seen`.

### Notification
```json
{
  "id": "ntf_...",
  "ts": "2026-07-09T09:00:00.000Z",
  "kind": "decision",
  "task_id": "9da7c5527580",
  "decision_id": "dec_...",
  "title": "Decision needed: ship prod?",
  "body": "Production DB acme-prod-db.",
  "urgency": "urgent",
  "delivered_at": "2026-07-09T09:00:00.000Z"
}
```
`kind ∈ {decision, done, failed, incident, stale}`. `urgency ∈ {normal, urgent}`.
`task_id` / `decision_id` may be null. `delivered_at` is set once David has been
made aware — urgent notifications push a macOS notification immediately (so it is
set on creation); normal ones are batched into a single digest every
`HIVE_DIGEST_MS` (default 30m), or marked when the header bell is opened
(`POST /api/notifications/ack`). The bell's unread count is the rows where
`delivered_at` is null.

---

## Endpoints

### Health
`GET /api/health` → `200 {"ok": true, "version": "0.1.0"}`

### Projects
- `GET /api/projects` → `200 [Project, ...]` (oldest first)
- `POST /api/projects` body `{name (required), repo_path?, config?}` → `201 Project`
- `GET /api/projects/:id` → `200 Project` | `404`

### Tasks
- `GET /api/tasks?state=&project_id=` → `200 [Task, ...]` (newest `updated_at` first; both filters optional)
- `POST /api/tasks` body `{project_id (required), title (required), brief?, kind?, agent_target?}` → `201 Task` (starts in `queued`, writes a `created` event)
- `GET /api/tasks/:id` → `200 Task + {events:[Event], evidence:[Evidence], decisions:[Decision]}` | `404`
  (i.e. the full task object plus three arrays for the task page)
- `POST /api/tasks/:id/transition` body `{to (required), reason?, source?}` → `200 Task` | `409` (invalid transition or `done` without evidence) | `404`
  When `to` is `verifying`, the project's post-deploy smoke list (`config.smoke`) runs once before the response returns. A smoke failure bounces the task back to `in_progress`, so the returned Task may be `in_progress`, not `verifying`.
- `POST /api/tasks/:id/spawn` body `{hive_url?}` → `200 {"ok":true, "task": Task, "agent_target":"..."}` | `400` (project has no `repo_path`) | `404` | `502` (herdr spawn failed; a `spawn_error` event is recorded)
  Creates the herdr worktree (`hive/<task-id>`), starts the agent with `HIVE_TASK_ID`/`HIVE_URL` + the project's resolved secrets in env and the composed brief, sets `agent_target`/`worktree_path`/`branch`, transitions `queued → in_progress`, and writes a `spawned` event.
- `POST /api/tasks/:id/send` body `{message (required)}` → `200 {"ok":true, "delivered":true, "message":...}` | `404` | `400` (empty message)
  Dispatches the message to the task's live agent via `herdr agent send`. Always records a `steer` event. Degrades gracefully: if the task has no `agent_target` or herdr fails, returns `200 {"ok":false, "delivered":false, "error":"..."}` (never throws) and records a `steer_error` event when herdr itself failed.
- `GET /api/tasks/:id/brief` → `200 {"task_id":"...", "brief":"<multiline string>"}` | `404`
  (task description + definition of done + `hive emit` protocol + active global + project policies)

### Event ingestion — `POST /api/tasks/:id/events`
The `hive emit` path. Accepts **either** `application/json` **or**
`multipart/form-data` (multipart is required to upload an evidence file). All
recognized fields (JSON keys == form field names):

| field | meaning |
|-------|---------|
| `type` (required) | `status` \| `evidence` \| `needs-decision` \| `done` \| `blocked` \| any custom string |
| `source` | defaults to `agent` |
| `note` | free text; stored in the event payload / used as caption/summary |
| `kind` | evidence kind (evidence type only); defaults to `screenshot` if a file is present, else `link`/`log` |
| `caption` | evidence caption |
| `url` | evidence URL (for link evidence, no file) |
| `title`,`context`,`risk`,`blast_radius`,`options` | decision fields (needs-decision type; `options` is a JSON string in multipart) |
| `file` | (multipart only) the uploaded evidence file |

Behavior by `type`:
- `evidence` → copies the file to `~/.hive/evidence/<task_id>/`, inserts an
  Evidence row, writes an `evidence` event. → `201 {evidence: Evidence, event: Event}`
- `needs-decision` → creates a Decision (minimal; full cards use `POST /api/decisions`),
  parks the task in `needs_decision`. → `201 {decision: Decision, task: Task}`
- `done` → records the `note` as summary + `note` event, then transitions the
  task to `done` (evidence rule enforced). → `200 {task: Task}` | `409`
- `status` / `blocked` / custom → writes one event. → `201 {event: Event}`

### Decisions
- `GET /api/decisions?status=open` → `200 [Decision, ...]` (newest first; `status` defaults to `open`; `status=all` returns every decision)
- `POST /api/decisions` body `{task_id (required), title (required), context?, risk?, blast_radius?, options?}` → `201 Decision`
  (also writes a `needs-decision` event and parks the task in `needs_decision` if its current state allows it)
- `GET /api/decisions/:id` → `200 Decision` | `404`
- `PUT /api/decisions/:id/draft` body `{draft_note}` → `200 {"ok":true, "id":...}` | `404`
  (autosave; call debounced on every keystroke; overwrites `draft_note` only)
- `POST /api/decisions/:id/answer` body `{answer_key (required), answer_note?}` → `200 Decision` (now `answered`) | `400` (bad key) | `409` (already answered)
  Archives the card (`status=answered`, `answered_at` set), writes a
  `decision_answered` event, and resumes the task (`needs_decision → in_progress`).
  If `answer_note` is omitted, the saved `draft_note` is used.

### Policies
- `GET /api/policies?scope=` → `200 [Policy, ...]` (oldest first; `scope` filter optional)
- `POST /api/policies` body `{title (required), body (required), scope?, active?}` → `201 Policy` (scope defaults to `global`)
- `GET /api/policies/:id` → `200 Policy` | `404`
- `PUT /api/policies/:id` body `{title?, body?, scope?, active?}` → `200 Policy` | `404`
- `DELETE /api/policies/:id` → `200 {"ok":true}`

### Incidents
- `GET /api/incidents?status=` → `200 {"incidents": [Incident, ...]}` (newest first; `status` filter optional, e.g. `open` / `resolved`)

### Learnings (regression ledger)
- `GET /api/learnings?project_id=&status=` → `200 [Learning, ...]` (newest `last_seen` first; both filters optional)
- `POST /api/learnings` body `{project_id (required), title (required), body?, source_task_id?, create_root_cause_task?}` → `201 Learning` | `400` (unknown `project_id`)
  With `create_root_cause_task: true`, a queued `chore` task is auto-created (brief prefilled from the learning) and its id is set as `root_cause_task_id` — the "unblock now, root-cause later" flow. Broadcasts a `learning` (and, for the auto task, a `task`) SSE message.
- `GET /api/learnings/:id` → `200 Learning` | `404`
- `PUT /api/learnings/:id` body `{title?, body?, status?, root_cause_task_id?}` → `200 Learning` | `400` (bad `status`) | `404` (resolve = `status:"resolved"`)
- `DELETE /api/learnings/:id` → `200 {"ok":true}`
- `POST /api/learnings/:id/recur` → `200 Learning` | `404`
  Bumps `occurrences` + refreshes `last_seen` and re-activates the learning (`status:"active"`); the same failure pattern happened again. Broadcasts a `learning` SSE message.

### Notifications
- `GET /api/notifications?since=` → `200 {"notifications": [Notification, ...], "unread": <n>}` (newest first; `since` is an ISO timestamp filter, else the 100 most recent; `unread` counts rows with `delivered_at` null)
- `POST /api/notifications/ack` → `200 {"ok":true, "acked": <n>}`
  Marks all currently-undelivered notifications as seen (`delivered_at` set to now). Called when the header bell dropdown is opened, so those events are not re-pushed by the next digest.

### Secrets (metadata only)
Values are never accepted or returned here. Set them with `hive secret set`
(writes to the provider locally, then registers the reference via `POST`).
- `GET /api/projects/:id/secrets` → `200 {"secrets": [Secret, ...]}` (by name) | `404`
- `POST /api/projects/:id/secrets` body `{name (required), provider?, ref (required)}` → `201 Secret` | `404`
  Stores a reference only (upserts by `(project_id, name)`). `provider` defaults to `keychain`.
- `DELETE /api/projects/:id/secrets/:name` → `200 {"ok":true, "deleted": <n>}`

### SSE stream — `GET /api/stream`
`Content-Type: text/event-stream`. Each message is one SSE `data:` line whose
payload is a JSON object with a `type` discriminator. On connect the server
sends a headline immediately:

```
data: {"type":"hello","version":"0.1.0"}
```

Subsequent messages (broadcast to all clients on every change):

| message | shape | when |
|---------|-------|------|
| event | `{"type":"event","event": Event}` | any event row is written (includes every state change, which also emits a `state_change` event) |
| task | `{"type":"task","task": Task}` | a task is created or its state changes |
| evidence | `{"type":"evidence","evidence": Evidence}` | an evidence row is added |
| decision | `{"type":"decision","decision": Decision}` | a decision is created or answered |
| incident | `{"type":"incident","incident": Incident}` | a monitor incident opens or resolves |
| learning | `{"type":"learning","learning": Learning}` | a learning is created, updated, or recurs |
| notification | `{"type":"notification","notification": Notification}` | a notification is enqueued (urgent ones arrive already `delivered_at`) |
| reconciler_error | `{"type":"reconciler_error","error":"...","where":"..."}` | a reconciler cycle hit an error (at most once per cycle; no DB row) |

A state change therefore produces both an `event` message (`type:"state_change"`)
and a `task` message. The client should upsert by `id`. There is no replay/backfill
on connect; load current state via the REST endpoints, then apply stream deltas.

### Static assets
- `GET /evidence/<task_id>/<file>` → the raw evidence file (`404` if missing; path traversal rejected `403`).
- `GET /` and any non-`/api/` path → serves `web/dist` if built (SPA fallback to `index.html`), otherwise `404 "web app not built"` (text/plain).
