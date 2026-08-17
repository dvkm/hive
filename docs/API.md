# hive HTTP API — the contract

This is the authoritative contract for the hive daemon. The web app (Phase 2)
must be built against this file. Server: `http://127.0.0.1:4700` (override
`HIVE_PORT`). No auth (localhost tool).

- All request and response bodies are JSON unless noted (evidence upload is
  `multipart/form-data`; the SSE stream is `text/event-stream`; evidence files
  and the static web app are served raw).
- **File attachments.** `POST /api/tasks`, `PUT /api/tasks/:id` and
  `POST /api/tasks/:id/send` accept EITHER JSON or `multipart/form-data`. In the
  multipart form, text fields carry the same names as the JSON keys and any
  number of files may be sent under the field name `files`. See
  [Attachments](#attachments).
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
  "repo_path": "/Users/david/code/acme-web",
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
`verifying`), `agent_argv` (string[], per-project override of the command
herdr runs, default `["claude","-p",<brief-file>,"--permission-mode","acceptEdits"]`),
`setup_argv` / `cleanup_argv` (string[], a symmetric per-project stack hook pair —
`setup_argv` runs at spawn time once the worktree exists but before the agent
starts, `cleanup_argv` runs before the worktree is removed; relative `argv[0]`
resolves against the project repo path and `{worktree}` substitutes the task's
worktree path, e.g. `["infra/worktree/wt.sh","up","{worktree}"]` /
`[…,"down","{worktree}"]`; both best-effort with a 120s timeout, emitting a
`stack_setup` / `stack_teardown` event — see the Auto-cleanup section),
and `gchat_spaces` (`[{space, label?}]`, the Google Chat intake allowlist —
messages in each `spaces/<id>` become draft tasks in THIS project; see Intake
connectors below), and `intake_keywords` (`string[]`, domains / links / keywords
that mark a braindump as belonging to THIS project — e.g. `["coredata",
"figma.com/file/…"]`. At `POST /api/intake` the raw text is scored against every
project's name, repo basename, and these keywords, and the braindump is re-routed
to the best match when it strictly out-scores the requested project).
Domain-supervisor keys (see the Domain supervisors section):
`supervisor_persona` (string, freeform planner identity included in every planner
prompt), `plan_intake` (bool; when true, each new intake task auto-triggers a
planner breakdown), `planner_argv` (string[], the planner command, default
`["claude","-p"]`), and `playbook` (string, freeform project context injected
into planner prompts).
Dispatcher keys (see the Dispatcher section):
`auto_dispatch` (bool, default `false`; when true the dispatcher auto-spawns
agents for this project's queued tasks), `dispatch_kinds` (string[], default
`["ship","scout"]`; which task kinds the dispatcher will auto-spawn — `chore` is
excluded by default), and `max_agents` (number, default `3`; per-project cap on
concurrently-running agents).
Supervisor key: `autonomy_profile` (`"conservative" | "balanced" | "autopilot"`, default `"balanced"`). Conservative leaves every checkpoint and decision to the director. Balanced may acknowledge reversible checkpoints and use only the server's closed safe-decision allow-list. Autopilot may also answer a raiser-recommended low/normal-risk technical choice after the server excludes authority grants and production/shared blast radius. No profile bypasses standing-authority gates.
Worktree stack hooks (symmetric per-project lifecycle commands, both `string[]`,
`{worktree}` substitutes the task's worktree path, relative `argv[0]` resolves
against `repo_path`): `setup_argv` (e.g. `["infra/worktree/wt.sh","up","{worktree}"]`,
run at spawn after the worktree exists but before the agent starts, so agents
don't install deps / bring up their stack themselves; emits a `stack_setup`
event) and `cleanup_argv` (e.g. `[...,"down","{worktree}"]`, run before the
worktree is removed; emits a `stack_teardown` event). Both are best-effort with a
120s timeout — a failed hook never blocks spawn nor cleanup.
Lifecycle key: `archived` (bool, default absent/`false`; when `true` the project
is hidden from the default `GET /api/projects` list and the web Projects view —
tasks keep referencing it, there is no hard delete).
Worktree stack hooks (symmetric per-project lifecycle commands): `setup_argv`
(string[], run AFTER the worktree exists but BEFORE the agent starts — e.g.
`["infra/worktree/wt.sh", "up", "{worktree}"]` — so agents don't bring up their
stack themselves; emits a `stack_setup` event) and `cleanup_argv` (string[], run
BEFORE the worktree is removed — e.g. `[..., "down", "{worktree}"]`; emits a
`stack_teardown` event). Both: relative `argv[0]` resolves against `repo_path`,
`{worktree}` substitutes the task's worktree path, best-effort with a 120s
timeout — a failed hook never blocks spawn nor teardown.

### Task
```json
{
  "id": "9da7c5527580",
  "number": 42,
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
  "head_sha": "a1b2c3d...",
  "summary": "Shipped dark mode toggle; all tests green.",
  "source": null,
  "parent_task_id": null,
  "depends_on": [],
  "duplicate_of": null,
  "health": { "status": "healthy", "reason": null, "since": "..." },
  "created_at": "...",
  "updated_at": "..."
}
```
`state ∈ {queued, in_progress, needs_decision, in_review, verifying, done, failed, cancelled}`
When a task enters a terminal state (`done` / `failed` / `cancelled`), every
still-`open` decision on it is auto-expired (`status=expired`, a
`decision_expired` event each, broadcast) — a terminal task can no longer act on
a card, so it must not linger in the inbox. Legacy orphans are swept on startup.
`kind ∈ {ship, scout, chore}`
`head_sha` is the PR's current head commit, refreshed by the reconciler's PR
poll alongside `ci_status`; `null` until the first poll after a PR links. The
review card compares it against each evidence item's `meta.commit_sha` to flag
evidence captured against an older commit as stale.
`number` is a human-friendly, monotonic per-hive counter assigned at creation
(`MAX(number)+1`, starting at 1) and never reused — it is THE handle people and
GitHub PR markers use, while the opaque `id` stays the machine key. Assigned by a
DB trigger so every creation path gets one; existing rows were backfilled in
`created_at` order. Unique across all tasks.
`health` is a SERVER-COMPUTED dimension separate from lifecycle `state` — the
visible symptom that a task pointing at a live agent is actually fine or actually
stuck. **It is the single source of truth; clients render it, never re-derive
it.** Shape `{status, reason, since}`:
- `status ∈ {healthy, silent, stuck, dead}`; `reason` is a human string (or null
  when healthy) — usually short and fixed, but the `merge_failed` cause below
  passes through raw git/gh error text, so clients must clamp it; `since` is the
  ISO ts the current condition began.
- `null` for `queued`, `done`, `failed`, `cancelled`, and any task with no
  `agent_target`.
- Derivation (pure function of events, precedence dead > stuck > silent >
  healthy): **dead** = `agent_target` set but the reconciler's probe recorded the
  agent `gone`; **stuck** = herdr reports `blocked`, OR a stale-recovery escalation
  is in flight (newest event `stale`/`recovery_nudge`), OR the agent went `idle` on
  an `in_progress` task with no `pr_url` and no recent activity (finished-without-a-PR
  or wedged — surfaced instead of hidden), OR an unresolved `merge_failed` within
  the stale threshold on an `in_progress`/`in_review` task (resolved — and so
  cleared — by a later `merged`/`pr_merged`, or by a later re-handoff into review
  (`ready_for_review` or a `state_change` into `in_review`) that is accompanied by
  a later `pr_synchronized` carrying a head SHA that actually MOVED (the
  reconciler's first-ever observation of a PR writes one on an unchanged head, so
  that baseline write does not count); neither re-handoff path can see a base-branch
  conflict — the reconciler's PR poll fires on green CI alone and the idle backstop
  on an agent that stopped — so a re-handoff alone is not evidence the agent pushed
  a fix; `reason` carries the merge error text); **silent** = no activity events past the
  stale threshold but the agent is still alive; **healthy** otherwise. Every `task`
  SSE message carries the recomputed `health`.
`source` is null for director/agent-created tasks, `"intake_gchat"` for a task
drafted by the Google Chat intake connector (an untrusted, unreviewed external
message — the web board flags these), `"planner"` for a task created from an
approved domain-supervisor breakdown (see the Domain supervisors section), or
`"requeue"` for a fresh task the stale-recovery loop spun up after an agent died
(`parent_task_id` → the failed original; see Stale recovery). A
companion `source_ref` column (not returned) holds the upstream message resource
name and is uniquely indexed for dedupe.
`parent_task_id` is null for top-level tasks, or the id of the source task a
`"planner"` task was broken out of (links a child to its parent).
`duplicate_of` is null for normal tasks, or the id of the SURVIVOR task this one
was folded into when it was cancelled as a duplicate (see Duplicate detection
below). Set only on a `cancelled` task; the survivor keeps working. Tasks are
never deleted, so the cancelled row + this pointer preserve the full history.

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
`source ∈ {agent, hook, herdr, reconciler, reaper, monitor, director, system, chat_supervisor, unknown}`.
`type` is open-ended. Types the server itself writes:
- `created` — task created. `payload: {title}`
- `state_change` — every state transition. `payload: {from, to, reason}`
- `status` — an agent status note. `payload: {note}`
- `evidence` — an evidence item was attached. `payload: {evidence_id, kind, caption}`
- `needs-decision` — a decision card was opened. `payload: {decision_id, title}`
- `decision_answered` — `payload: {decision_id, answer_key, answer_note, answered_by, actor}`; the event `source` is the answerer identity
- `auto_approved` — the chat supervisor cleared a card itself via the auto-approve bar. `payload: {decision_id, answer_key, category, reason, note}`. `source: chat_supervisor`
- `auto_approve_declined` — the auto-approve bar rejected a card; it stays `open` for the director. `payload: {decision_id, answer_key, category, reason}`. `source: chat_supervisor`
- `decision_expired` — a decision was cleared without an answer: dismissed, or auto-expired because its task went terminal. `payload: {decision_id, reason}` (`reason` ∈ `dismissed` | `task cancelled` | `task done` | `task failed` | `task terminal (backfill)`)
- `note` — a free note (e.g. a `done` summary). `payload: {note}`
- `steer` — a steer message was dispatched to the agent. `payload: {message, target}`
- `blocked` — agent reported blocked. `payload: {note}`

Transcript events (written by the Claude Code hooks, `source: hook` — these fill
the task timeline with the agent's actual work; see `hooks/install.md`):
- `assistant_text` — a block of the agent's actual output text. `payload: {text}` (rendered as a transcript bubble)
- `tool_use` — the agent invoked a tool. `payload: {tool, summary}` where `summary` is a cheap one-line description (the command for Bash, the file_path for Read/Edit, the pattern for Grep — never the full input). The UI groups consecutive `tool_use` events into one "used N tools" row.
- `agent_turn_end` — a quiet Stop/SubagentStop liveness heartbeat. `payload: {}` (kept for health/reconciler; the timeline hides it)

Types written by the runtime layer (Phase 2b):
- `checkpoint` — a live build-time judgment call from a working agent (`payload: {note}`; `hive emit <id> checkpoint --note "..."`). Non-blocking. Acknowledgment uses `POST /api/tasks/:id/checkpoints/:eventId/ack` body `{verdict: "ok"|"flag", note?, source?: "director"|"chat_supervisor", actor?}` → `200 {ok, delivered, followup_task_id}` | `400` | `404`; `checkpoint_ack` events (`payload: {checkpoint_id, verdict, note, actor}`) record the outcome and their event source records who acted. A `flag` steers a live agent immediately; a flag on a finished/agentless task queues a corrective follow-up task instead (`source="checkpoint_flag"`, parent → the flagged task). `GET /api/checkpoints[?project_id=<id>]` → `200 {checkpoints: [{id, task_id, ts, task_number, task_title, task_state, project_id, note}]}` lists un-acked checkpoints, optionally scoped to one project. They survive task completion (only `cancelled` drops them) so judgment calls stay reviewable after fast agents finish.
- `review_summary` — the agent's structured self-review, submitted before `ready`. `payload: {done?: string[], iffy?: (string|{what,why})[], decisions?: string[], testing?: string[], followups?: string[]}`. The review card renders the latest one as the primary review surface (prose `summary` collapses behind a toggle).
- `spawned` — a herdr agent was started. `payload: {agent_target, branch, worktree_path, tab_id, label, fleet_workspace_id}`
- `spawn_error` — spawn failed. `payload: {error, infra?}`. `infra: "herdr_unreachable"` marks a herdr-daemon-down failure (`ConnectionRefused` / `Os { code: 61 }`) rather than a task-specific fault; the dispatcher excludes these from a task's per-task backoff and handles them with a global circuit breaker instead (see `docs/runtime.md`)
- `stack_setup` — the per-project spawn hook (`config.setup_argv`) ran while preparing the worktree, before the agent started (`source: herdr`). `payload: {argv, ok, error?}` (`error` = first 300 chars of stderr/stdout on failure; best-effort, a failure never blocks the spawn).
- `stack_teardown` — the per-project teardown hook (`config.cleanup_argv`) ran before the worktree was removed (`source: reaper`). `payload: {argv, ok, error?}` (best-effort, a failure never blocks worktree/session cleanup). Both share `runStackCmd` (`server/src/cleanup.ts`).
- `agent_status` — herdr agent status changed (via wait loop or reconciler). `payload: {status}` (`idle|working|blocked|gone` — `gone` = the reconciler's probe found the agent missing from herdr)
- `focus_agent` — the director focused the agent's herdr tab ("view agent"). `payload: {target}`
- `recovery` — a stale-recovery decision was taken. `payload: {decision:"dead"|"silent-escalate", attempts?|nudges?}`
- `recovery_nudge` — a status nudge was sent to an alive-but-silent agent. `payload: {nudge, delivered}`
- `requeued` — a failed task was auto-requeued as a fresh task. `payload: {new_task_id, attempt?}`
- `recovery_card` — a recovery escalation opened a decision card. `payload: {decision_id, source_task_id}`
- `ci_status` — reconciler synced CI. `payload: {ci_status}` (`passing|pending|failing`)
- `pr_merged` — reconciler detected the PR merged. `payload: {pr_url}`
- `pr_conflict` — reconciler saw the PR CONFLICTING with its base and nudged the agent to resolve (once per head SHA; lifecycle untouched). `payload: {pr_url, head_sha, delivered}`
- `ready_for_review` — the task was handed off `in_progress → in_review`: by the agent's `ready` emit, by the herdr supervise loop's push signal (`source: herdr`, the moment herdr reports the agent idle), or by the reconciler's idle/gone poll backstop. `payload: {pr_url, via, kind}` (`via ∈ {emit, idle, gone}`)
- `pr_linked` — a marked PR was matched back to this task and its `pr_url` set (by the reconciler's scan or `POST /api/tasks/link-pr`). `payload: {pr_url, via}` (`via ∈ {id, number}` — which half of the marker matched)
- `pr_synchronized` — the reconciler observed the PR head SHA change (hive's stand-in for GitHub's synchronize webhook). `payload: {head_sha}`. Emitted only when the head differs from the prior `pr_synchronized` (the first observation is a baseline). Used to tell "the agent pushed a fix" from "CI is still green on the same old head" — by the re-queue guard after a `changes_requested`, and by `health` to decide whether a re-handoff clears a `merge_failed` reason.
- `stale` — task silent beyond the threshold. `payload: {silent_ms, threshold_ms}`
- `deferred` — task parked pending an offline human action; `deferred_until` set (nudges suppressed while future-dated). `payload: {until, note}`
- `undeferred` — a deferred task was resumed; `deferred_until` cleared. `payload: {note}`
- `steer_error` — `herdr agent send` failed. `payload: {error}`
- `smoke_passed` / `smoke_failed` — post-deploy smoke result. `payload: {results:[{name,ok,detail}], evidence_id?}`
- `cleaned_up` — a finished task's runtime was torn down: worktree removed (when its branch was pushed/merged) and herdr session (tab/pane) closed. `payload: {worktree_path, branch, worktree_removed, ghost_branch, session_closed, session_via, tab_id}` (`ghost_branch` non-null when tracked uncommitted work was preserved before removal). Fired on the `done`/`cancelled` transition and by the reaper.
- `cleanup_skipped` — teardown was refused because the branch is neither pushed nor merged; the worktree and its session are left fully intact so no unmerged work is lost. `payload: {reason, worktree_path, branch}`
- `stack_setup` / `stack_teardown` — a per-project worktree stack hook ran (`config.setup_argv` at spawn, `source: herdr`; `config.cleanup_argv` at teardown, `source: reaper`). `payload: {argv, ok, error?}` (`error` is the trimmed stderr/stdout on failure or a timeout note).

Review events (written by the director path, `source: director`):
- `merged` — an in-review task was approved & merged. `payload: {method, base, branch, pr_url}`
- `merge_failed` — a merge attempt failed (conflict / not a fast-forward / gh refused). `payload: {reason, conflict, delivered, send_error?}` — `conflict` = the reason looks like the agent's to fix, which bounces the task back to `in_progress` with rebase instructions (a best-effort send; `delivered` records whether it landed, `send_error` the failure). A non-conflict failure leaves the task `in_review` with `delivered: false`.
- `changes_requested` — the captain requested changes; the task returns to `in_progress`. `payload: {notes, delivered, head_sha}` (`head_sha` = the PR head at request time, read from the latest `pr_synchronized`; the baseline the re-queue guard compares against, `null` when no `pr_synchronized` existed yet)

Domain-supervisor events (written by the planner, `source: system`):
- `planning` — a planner run started for the task. `payload: {title}`
- `planned` — the planner produced a breakdown and opened a decision card.
  `payload: {decision_id, source_task_id, proposed_tasks:[{title,brief,kind}], rationale, questions:[], reason}`
- `planner_error` — the planner failed (spawn error, non-zero exit, timeout, or
  unparseable output). A single diagnostic; no retry. `payload: {error}`

Duplicate-detection events (written by the dedup path, `source: system`):
- `duplicate_merged` — a task was folded into another. Written on BOTH tasks: on
  the survivor `payload: {duplicate_task_id, title, note?}` (`note` carries the
  folded brief when it added anything); on the folded task `payload: {duplicate_of}`.
- `duplicate_suspected` — a near-duplicate opened a decision card on the NEW task.
  `payload: {decision_id, survivor_id, tier, score}`.

Standing-authority events (written by the policy engine, `source: system` unless noted):
- `authority_logged` — an action was allowed (matched an `allow` rule, defaulted to allow when unmatched, or passed by consuming a grant). `payload: {action, target, effect:"allow", rule_id?, via_grant?}`
- `authority_denied` — an action was blocked by a `deny` rule. `payload: {action, target, rule_id}`
- `dependency_blocked` — a task's `depends_on` isn't all merged/done, so the dispatcher held its spawn (or the reconciler held its stage). `payload: {note, blocked_by}` (`blocked_by`: `["#<n> <title>", ...]`). Deduped: re-written only when the blocking set changes.
- `authority_required` — a `require_decision` rule opened a card gating the action. `payload: {action, target, decision_id, rule_id}`
- `authority_granted` — the director approved the card; a single-use 24h grant was minted (`source: director`). `payload: {action, target, decision_id, expires_at}`

### Evidence
```json
{
  "id": "ev_...",
  "task_id": "9da7c5527580",
  "ts": "...",
  "kind": "screenshot",
  "path": "/Users/david/.hive/evidence/9da7c5527580/1720440000_shot.png",
  "url": "/evidence/9da7c5527580/1720440000_shot.png",
  "caption": "Dark mode enabled",
  "meta": {}
}
```
`kind ∈ {screenshot, test_run, log, report, link}`. `path` is the local file
(null for link-only). `url` is the served path (fetch it from the same origin).
`meta.commit_sha`, when present, is the git HEAD of the agent's worktree at
capture time — `hive emit ... evidence` fills it in automatically via `git
rev-parse HEAD` in the CLI's cwd. The review card compares it to the task's
`head_sha` and marks the item stale when they differ.

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
  "answered_at": null,
  "answered_by": null,
  "answered_actor": null,
  "bundle": {
    "task_number": 262,
    "pr_url": "https://github.com/dvkm/hive/pull/42",
    "branch": "hive/rich-cards",
    "spend_usd": 3.2,
    "prior_decisions": [
      { "id": "dec_...", "title": "Merge strategy?", "answer": "Fast-forward", "answered_at": "..." }
    ]
  },
  "plan": null
}
```
`status ∈ {open, answered, expired}`. `options` is an ordered, **non-empty**
array; render the `recommended: true` option first per product rule 3.
`draft_note` is the server-side autosaved draft. A decision is `expired` once it
was dismissed, or its task went terminal (`done`/`failed`/`cancelled`) — expired
cards leave the inbox and can no longer be answered. `answered_by` is the caller
identity recorded on answer (`director|chat_supervisor|agent|system|unknown`) and
`answered_actor` an optional free label; both are `null` until the card is answered.

`bundle` is server-**derived** (never stored) context attached to each card as
it's returned, so the director can decide in one pass without opening the task:
the affected `pr_url`/`branch`, task `spend_usd` so far, and `prior_decisions` —
the last 3 answered cards on the same project, each with the option `label` the
director chose. Computed at fetch/broadcast time so it stays fresh; absent on
older SSE payloads and terminal-card broadcasts.

`plan` is likewise derived (from the `planned` event, keyed by `decision_id`) —
non-null only for a planner breakdown card produced by
`POST /api/tasks/:id/plan` or an intake trigger:
```json
"plan": {
  "proposed_tasks": [{ "title": "Design schema", "brief": "users + steps tables", "kind": "ship" }],
  "rationale": "Split design from research so they proceed in parallel.",
  "questions": ["Which auth provider?"],
  "reason": "Multiple independent workstreams need director approval."
}
```
It exposes the proposal and scoring reason without requiring clients to parse
the flattened text in `context` (which still carries the same content for
search/notification consumers). See `selected_indices` on
`POST /api/decisions/:id/answer` below.

**Options are never empty.** An optionless card is un-answerable (nothing to
click, no key to validate). The direct `POST /api/decisions` rejects an empty
array with `400`; the agent `needs-decision` emit path instead defaults to
`[{key:"proceed",label:"Proceed",recommended:true},{key:"dismiss",label:"Dismiss"}]`
so an agent's signal is surfaced rather than silently dropped.

### Policy
```json
{ "id": "pol_...", "scope": "global", "title": "No em-dashes", "body": "Use commas.", "active": true, "created_at": "...", "updated_at": "..." }
```
`scope` is `"global"` or `"project:<project_id>"`. `active` is a boolean.

### Authority rule (standing-authority policy engine)
```json
{ "id": "aur_...", "project_id": null, "scope": "global", "action_pattern": "deploy.prod*", "effect": "require_decision", "note": "confirm exact target", "active": true, "created_at": "..." }
```
`project_id` is null for a global rule or a project id for a project-scoped one;
`scope` is the derived display label (`"global"` | `"project:<id>"`). `effect ∈
{allow, require_decision, deny}`. `action_pattern` is a glob (`*` wildcard, whole
string anchored, e.g. `deploy.prod` or `flag.*`). Evaluation for an action:
most-specific active rule wins (project over global, then longer literal pattern
over shorter); an unmatched action defaults to `allow` (log-only). See the
Authority section below.

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
  "root_cause_task_id": "c21eef921dfd",
  "kind": "failure"
}
```
`status ∈ {active, resolved}`. `occurrences` counts how many times the pattern
recurred (bumped via `/recur`). `source_task_id` (the task that first hit it) and
`root_cause_task_id` (the chore task opened to fix it, if any) may be null.
`kind ∈ {failure, reference, decision}` — required (no default) on create, which
accepts `failure` or `reference` only; `decision` rows are written by the server
itself. A misfiled `failure`/`reference` is correctable later via `PUT`. The
learnings table doubles as the project knowledge store:
- `failure` — the regression ledger. Active ones inject into composed briefs (see
  `/api/tasks/:id/brief`) under a "Known failure patterns" section, 10 most recent
  by `last_seen`.
- `reference` — durable facts, pinned into every brief under a "References" section.
- `decision` — the answer to a resolved decision card, written back automatically
  when the director answers a card no resolver claimed (a genuine
  product/preference question), deduped by `(project_id, title)` so re-asking the
  same question bumps `occurrences` and refreshes the answer. Active ones inject
  into briefs under a "Decisions already made (don't re-ask)" section and surface
  in `hive recall`, so a crew consults the prior ruling before re-raising the card.

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
`kind ∈ {decision, done, failed, incident, stale, intake, planned}`. `urgency ∈ {normal, urgent}`.
(`intake` is a new Google-Chat draft task; `planned` is an approved planner
breakdown — both always `normal`, batched into the digest.)
`task_id` / `decision_id` may be null. `delivered_at` is set once David has been
made aware — urgent notifications push a macOS notification immediately (so it is
set on creation); normal ones are batched into a single digest every
`HIVE_DIGEST_MS` (default 30m), or marked when the header bell is opened
(`POST /api/notifications/ack`). The bell's unread count is the rows where
`delivered_at` is null.

### Usage (cost/token analytics)
```json
{
  "id": "use_...",
  "task_id": "9da7c5527580",
  "ts": "2026-07-09T09:00:00.000Z",
  "model": "claude-sonnet-4-5",
  "input_tokens": 12000,
  "output_tokens": 3400,
  "cache_read_tokens": 88000,
  "cache_write_tokens": 4200,
  "cost_usd": 0.0774,
  "source": "agent"
}
```
One row per reported LLM call. `input_tokens` is fresh (uncached) input;
`cache_read_tokens` is cache-hit input and `cache_write_tokens` is input written
to the cache. The three are priced differently — a cache read costs 0.1x fresh
input and a cache write 1.25x — so they are never summed before pricing.
`source` tags the ingest path (`agent` via the `usage` event, `hook` from
the Stop-hook transcript reporter). `cost_usd` is computed server-side from the
price table (`server/src/pricing.ts`, $/MTok per model family, overridable per
project via `config.pricing`) when the caller doesn't supply it; it is **null**
for an unpriced (unknown) model — ingestion is never blocked on an unknown model,
and unpriced rows surface as `"unpriced"` in rollups. Analytics rollups expose
`totals` shaped `{input_tokens, output_tokens, cache_read_tokens,
cache_write_tokens, total_tokens, cost_usd, calls, unpriced}` (summed cost counts
priced rows only).

### ChatThread / ChatMessage (director chat)
```json
{
  "id": "thr_...",
  "project_id": null,
  "task_id": "9da7c5527580",
  "title": "ship the dark mode toggle",
  "created_at": "2026-07-09T09:00:00.000Z",
  "updated_at": "2026-07-09T09:05:00.000Z"
}
```
```json
{
  "id": "msg_...",
  "thread_id": "thr_...",
  "ts": "2026-07-09T09:05:00.000Z",
  "role": "director",
  "text": "ship the dark mode toggle",
  "actions": []
}
```
`project_id` is a project id for a project-scoped supervisor thread or `null` for the single portfolio-wide Chief of Staff thread. `task_id` is the thread's backing supervisor task (null until the session first spawns; re-pointed to a fresh task if the thread is closed and later reopened). A Chief of Staff task runs from the active Hive project repository when one exists, otherwise from the earliest active project with a repository.
`role` is `director` (operator) or `assistant` (the supervisor session's reply).
`actions` is empty unless an assistant reply attaches open decisions. Each attached decision is `{type:"decision", decision_id, label}`; the web app renders the referenced open decision as an answerable card. See the Director chat endpoints below.

---

## Endpoints

### Health
`GET /api/health` → `200 {"ok": true, "version": "0.1.0", "dispatcher": {"last_run": "<iso>|null", "stale": bool}, "reaper": {"last_run": "<iso>|null", "stale": bool}, "herdr_outage": {"paused_until": "<iso>", "streak": int} | null, "sessions": {"panes": int, "max": int, "pct": float, "warn": bool, "at": "<iso>|null"} | null}`

`dispatcher`/`reaper` report the last time each background loop's cycle completed (heartbeat, written on every completion path — including the offline-drain no-op and the herdr-down cooldown skip — so a wedged cycle ages toward stale instead of a fresh tick re-marking it fresh). `stale` flags when a loop has missed ~3 cycles (floored at 5min) — the signal for "loop stopped ticking" vs. "process is up but a background loop silently died" (incident 2026-07-17).

`herdr_outage` surfaces a sustained herdr-daemon outage. When the dispatcher's circuit breaker is backing off it keeps refreshing `last_dispatch_at`, so `dispatcher` reads healthy even though nothing is spawning for the whole cooldown; this field makes the outage observable instead. It is non-null (`paused_until` = end of the backoff window, `streak` = consecutive outage count) ONLY while the backoff window is still in the future, and `null` otherwise (no outage, or the window has passed).

`sessions` surfaces PTY / herdr-session utilization — the pty pool is a hard, low OS cap (macOS `kern.tty.ptmx_max`, 511) whose exhaustion is otherwise SILENT (it hit 511/511 twice on 2026-07-25 and every spawn failed with `openpty: Os { code: 6 }`). `panes` is the live pane count the reaper records each sweep (one pty each), `max` the cap (`HIVE_PTY_MAX`, default 511), `pct` the ratio, and `warn` flips true at ≥80% (`HIVE_PTY_WARN_PCT`) so a leak is visible before it hits the wall. `null` until the first pane sweep has run.

### Projects
- `GET /api/projects[?archived=all]` → `200 [Project, ...]` (oldest first)
  Archived projects (`config.archived === true`) are hidden by default; pass
  `?archived=all` to include them. There is no project delete (tasks reference
  projects) — set `config.archived: true` to hide one and back to `false`/absent
  to restore it.
- `POST /api/projects` body `{name (required), repo_path?, config?}` → `201 Project`
- `GET /api/projects/:id` → `200 Project` | `404`
- `PUT /api/projects/:id` body `{name?, repo_path?, config?}` → `200 Project` | `404`
  Updates mutable fields. `config` is REPLACED wholesale when present (read the
  project, edit keys like `auto_dispatch`, write the object back). Used by the
  Policies-page auto-dispatch toggle.

### Tasks
- `GET /api/tasks?state=&project_id=` → `200 [Task, ...]` (newest `updated_at` first; both filters optional)
- `POST /api/tasks` body `{project_id (required), title (required), brief?, kind?, agent_target?, source?, parent_task_id?, depends_on?}` → `201 Task` (starts in `queued`, assigned the next `number`, writes a `created` event). `depends_on` is a list of task ids this task waits on (also accepts a comma-separated string; CLI: `hive task create --depends-on <id,id>`); each id is validated to exist (unknown id → `400`). The dispatcher won't spawn — and the reconciler won't advance — the task until every dependency is merged/done (`verifying`/`done`), writing a deduped `dependency_blocked` event with the visible reason. `source`/`parent_task_id` let a spawned agent file follow-up tasks attributed to it (`source="agent"`, parent → the spawning task; the CLI sets both automatically when `HIVE_TASK_ID` is in env). Unknown `parent_task_id` → `400`. `source="external"` (CLI: `hive task create --track`) marks a TRACKING-ONLY task: another agent using hive as its kanban — never auto-dispatched, never staleness-supervised, exempt from the done-evidence gate, moved freely via transitions (`hive task move <id> <state>`); the board shows a `tracked` chip. Also accepts multipart (same fields + `files`); attachments are stored under the new task's id and their absolute paths appended to the `brief`.
- `GET /api/tasks/:id` → `200 Task + {events:[Event], evidence:[Evidence], decisions:[Decision]}` | `404`
  (i.e. the full task object plus three arrays for the task page)
- `POST /api/tasks/:id/transition` body `{to (required), reason?, source?}` → `200 Task` | `409` (invalid transition or `done` without evidence) | `404`
  When `to` is `verifying`, the project's post-deploy smoke list (`config.smoke`) runs once before the response returns. A smoke failure bounces the task back to `in_progress`, so the returned Task may be `in_progress`, not `verifying`.
- `POST /api/tasks/:id/spawn` body `{hive_url?}` → `200 {"ok":true, "task": Task, "agent_target":"..."}` | `400` (project has no `repo_path`) | `404` | `502` (herdr spawn failed; a `spawn_error` event is recorded)
  Creates the herdr worktree (`hive/<task-id>`), starts the agent with `HIVE_TASK_ID`/`HIVE_URL` + the project's resolved secrets in env and the composed brief, sets `agent_target`/`worktree_path`/`branch`, transitions `queued → in_progress`, and writes a `spawned` event.
- `POST /api/tasks/:id/send` body `{message (required), from_task_id?}` (or multipart: `message` + `files` + `from_task_id?`) → `200 {"ok", "delivered", "delivery", "message", "attachments":[abs paths], "error"?}` | `404` | `400` (empty message, unknown sender, or cross-project teammate)
  Dispatches the message to the task's live agent via `herdr agent send`, and always records one `steer` event (`payload: {message, target, attachments, delivery, ...}`) carrying a **delivery receipt**. Attached files are saved and their absolute paths appended to the delivered message under an `## Attachments` heading; because the paths live in the stored `message`, they ride along when a queued steer is redelivered. `delivery` is one of:
  When `from_task_id` is present (the CLI supplies `$HIVE_TASK_ID` for `hive task send`), the sender must exist in the same project. The delivered text names the teammate task and includes an exact reply command; the event is attributed to `source:"agent"` with `from_task_id`, `from_task_number`, and the unwrapped `original_message` for UI display. Peer messages under a managed chat ancestry also wake the owning supervisor, except for messages the supervisor itself sent.
  - `delivered` — herdr accepted it **and** the agent's pane took the submitting Enter (payload also gets `delivered_at`). Two silent drops count as failures, not deliveries: a send that exits 0 with an `{"error":{"code":"agent_not_found"}}` body, and a pane-less agent, whose composer would hold the text unsubmitted.
  - `queued` — no `agent_target`, or herdr refused it twice (one automatic retry). The steer is **not dropped**; it is redelivered by whichever of these comes first, and the event's payload then flips to `delivered` with a `delivered_via` recording how:
    - `delivered_via:"drain"` — the reconciler, on any cycle, finds a queued steer on a task whose agent still probes **alive** and re-sends it. This covers the common case of a herdr socket blip while the agent is alive and working: no respawn is coming, so waiting for one would strand the message until the task ended. Delivery is re-attempted every cycle until it lands; a dead agent is skipped (its steers wait for the next spawn), and a partial drain stops at the first failure so the remainder stay queued **in order**.
    - `delivered_via:"respawn"` — the next `POST /spawn` of the task prepends every still-queued steer to the agent's brief under "## Steers waiting for you".
  - `failed` — the task is terminal, so no spawn will ever carry it.

  Never throws. A herdr failure additionally records a `steer_error` event. The timeline renders the receipt (`✓` / `⏳ queued` / `⚠ undelivered`) so a steer never has to be re-sent blind. Besides the respawn drain, the reconciler re-attempts every queued steer each cycle against any still-alive agent (receipt flips with `delivered_via:"drain"`); a successful drain writes no event of its own — the receipt flip is the record, and a fresh event would reset the task's silence clock and mask a mute agent from `stale` detection.
- `PUT /api/tasks/:id` body `{title?, brief?}` (or multipart: same fields + `files`) → `200 Task` | `404`
  Attached files are appended to the resulting `brief` under an `## Attachments` heading.
  Updates a task's editable fields. Used by the attention tray's "edit & requeue"
  flow before it re-queues a failed task.
- `POST /api/tasks/:id/focus-agent` body `{}` → `200 {"ok":true, "focused":true, "target":"..."}` | `404`
  The board's "view agent" affordance: focuses the task's herdr tab via
  `herdr agent focus` so David can watch/attach. Records a `focus_agent` event.
  Degrades gracefully (never throws): `200 {"ok":false, "focused":false, "error":"..."}`
  when the task has no agent or herdr fails.
- `POST /api/tasks/:id/requeue` body `{}` → `200 {"ok":true, "new_task_id":"..."}` | `404`
  The recovery banner's manual "fail + requeue": fails the task if still live,
  then creates a FRESH queued copy (`source="requeue"`, `parent_task_id` → the
  original). Distinct from the attention tray's in-place requeue of an
  already-failed task (`POST /transition {to:"queued"}`, which reactivates the
  SAME task and clears its runtime binding).
- `POST /api/tasks/:id/cleanup` body `{}` → `200 {"ok":true, "cleaned":bool, "worktree":{removed,reason,ghost_branch}|null, "session":{closed,via}}` | `404` | `409` (task not terminal)
  Manual force-teardown for a **terminal** task (`done`/`cancelled`/`failed`): removes its git worktree and closes its herdr session. Refuses (`409`) on a live task so an in-flight worktree is never pulled out from under a working agent. Keeps every safety guard: the worktree is removed only when its branch is pushed/merged (else `cleanup_skipped`), and any tracked uncommitted work is preserved to a `ghost-<task-id>` branch first. Backstop for the auto-teardown that fires on the `done`/`cancelled` transition and the periodic reaper sweep.
- `POST /api/tasks/:id/merge-into` body `{target_id (required)}` → `200 Task` (now `cancelled`) | `400` (missing/self `target_id`) | `404` (task or target missing) | `409` (source is already terminal)
  Manual duplicate merge: fold this task into `target_id` and cancel it as a
  duplicate. Writes a `duplicate_merged` event on both tasks, sets this task's
  `duplicate_of` to the target, and cancels it (reason `duplicate of <target>`).
  Never deletes. **Distinct from `POST /merge`** (the PR/branch approve-and-merge).
- `GET /api/tasks/duplicates` → `200 {"clusters": [{project_id, tasks:[{id,title,project_id,state,created_at}]}]}`
  Detected duplicate CLUSTERS among the current non-terminal tasks (queued /
  in_progress / needs_decision / in_review / verifying), grouped within a project
  by the same exact/near-title rule the on-create detector uses (union-find; only
  clusters of size ≥ 2 are returned). For a backfill/triage UI over dups that
  already exist.
- `GET /api/tasks/:id/brief` → `200 {"task_id":"...", "brief":"<multiline string>"}` | `404`
  (task description + definition of done + `hive emit` protocol + active global + project policies + standing-authority section + project knowledge: References, "Decisions already made", Known failure patterns)
- `POST /api/tasks/:id/guarded-action` body `{action (required), target (required), detail?}` → see below | `404` | `400`
  The gate agents call BEFORE any externally-risky operation they run themselves
  (prod deploy, feature-flag flip, destructive op). The server evaluates the
  standing-authority rules for the task's project:
  - `allow` → `200 {"ok":true, "effect":"allow"}` + an `authority_logged` event. Proceed.
  - `deny` → `403 {"ok":false, "effect":"deny", "error":"..."}` + an `authority_denied` event. Stop.
  - `require_decision` → `409 {"ok":false, "effect":"require_decision", "decision_id":"..."}`.
    A decision card is opened naming the EXACT target (risk `high`, options
    `approve`/`deny`) and the task is parked in `needs_decision`. The agent waits,
    then retries the SAME call. Retrying while the card is still open returns the
    same `decision_id` (no duplicate cards). Once the director answers `approve`,
    a single-use grant scoped to that exact `action` + `target` + task (expiring
    24h) is minted; the next identical call passes with `200 allow` and spends the
    grant. Answering `deny` blocks it. Internal risky paths (`spawn`, `send`,
    transitions into `verifying`/`done`) run through the same gate and return the
    same `403` / `409 {decision_id}` shapes when a rule matches.

- `POST /api/tasks/:id/plan` body `{}` → `200 {"ok":true, "decision": Decision}` | `404` | `502 {"ok":false, "error":"..."}`
  Manually triggers the domain-supervisor planner for any task (see Domain
  supervisors). Records a `planning` event, runs the planner subprocess, and on
  success opens a decision card titled `Proposed breakdown: <title>` with
  `approve`/`reject` options plus a `planned` event carrying the structured
  proposal. On any planner failure returns `502` and records a single
  `planner_error` event (no card). The request blocks for the planner run
  (timeout-capped by `HIVE_PLANNER_TIMEOUT_MS`, default 120000).

  The card's `risk` is computed, not hardcoded, by `classifyEscalation()`
  (`server/src/policy.ts`) — the same auto-handle-vs-escalate policy the
  reconciler's `autoMergeReady` consumes for its own opt-in merge gate, so a
  plan is judged the same way everywhere instead of per-call-site guesswork:
  `high` if the proposed work reads as irreversible or prod-facing, `normal`
  if the planner itself flagged open `questions` (ambiguous) or the project
  has no active policy for this kind of change (preference unknown), `low`
  otherwise. The flattened context ends with a `Risk: <level> (<reason>)` line
  for non-structured consumers; `plan.reason` supplies the web card's risk
  detail.

### PR ↔ task marker (the linking contract)
Every PR a hive agent opens MUST carry a marker that links it back to its task.
This is THE contract; the brief instructs agents to it and `hive pr-marker <id>`
prints it:
- The PR **title** MUST start with the prefix `[hive-<number>] ` (trailing space
  included), e.g. `[hive-42] Add dark mode toggle`.
- The PR **body** MUST include the footer line `hive-task: <id>` on its own line,
  e.g. `hive-task: 9da7c5527580`.

The `hive-task: <id>` footer is the primary link (the stable, unique machine
key); the `[hive-<number>]` title is a human-readable fallback matched only when
the footer is absent. hive links a PR to its task by reading these:
- **Reconciler scan** (every cycle): for each project with a `repo_path`, runs
  `gh pr list --state open --json number,title,body,url` in the repo and links any
  PR carrying a marker to its task — but only when the task has no `pr_url` yet, so
  an agent-reported PR is never clobbered and re-scanning is idempotent. Writes a
  `pr_linked` event. Isolated in its own try/catch; a `gh` failure is skipped.
- **`POST /api/tasks/link-pr`** body `{pr_url (required)}` → `200 {"ok":true, "task_id":"...", "number":42, "linked":<bool>}` | `400` (missing `pr_url`) | `422` (PR carries no hive marker) | `502` (`gh pr view` failed/unparseable)
  Reads the PR's title/body via `gh pr view <url> --json title,body,url` and links
  it to the matched task by the same marker rules. `linked` is `false` when the
  task was already linked (idempotent no-op).

`hive pr-marker <task-id>` (CLI) prints the two marker lines (`title-prefix:` and
`body-footer:`) for a task so agents don't hand-format them.

### Review experience (in-review tasks)
An `in_review` task means the agent finished and opened a PR (or pushed/created a branch) and is **awaiting the captain's review & merge**: not busy work. The captain reviews the diff and approves/merges, requests changes, or rejects, entirely from hive (the task page, the `/review` queue, and the Needs you view all render the same review card).

**How a task reaches `in_review` (the finished-handoff, `in_progress → in_review`):**
- **Explicit signal (preferred):** the agent emits `ready` (`POST .../events`
  `{type:"ready", pr_url?}`, i.e. `hive emit <id> ready --pr-url <url>`) once its PR
  is open (or, for a scout, its report is written). Records `pr_url` when supplied
  and not already linked, then advances the task. Idempotent — a duplicate `ready`
  on an already-advanced task just acks (`200`). Writes a `ready_for_review` event.
- **Reconciler backstop (safety net):** every cycle, an `in_progress` task whose
  agent is **idle or gone** (NOT `working`/`blocked` — an agent that opened a PR and
  kept working still reports `working`) and that has a real work product (a `pr_url`,
  or a scout `report` evidence) is auto-advanced to `in_review` (`ready_for_review`
  event, `via: idle|gone`). Advancing on a single idle read is safe because mid-work
  reads `working`; this runs before stale-recovery, so a handed-off task with a gone
  agent is moved to review rather than failed/requeued. This unsticks finished tasks
  regardless of whether the agent emitted `ready`.
- **Finished with NO PR:** an `in_progress` task whose agent went idle with no PR and
  no recent activity is not auto-advanced (nothing to review) but is made VISIBLE:
  its `health` becomes `stuck` (reason `finished or stuck: agent idle, no PR`), which
  surfaces it in the attention tray for the director instead of sitting silently.

**Changes-requested re-queue guard:** once the captain requests changes, the task
must NOT bounce straight back into review until the agent has actually acted. Both
auto-advance paths (the reconciler's CI-green poll / link-pr handoff and the idle
backstop) skip a task whose latest `changes_requested` is still unaddressed. "Addressed"
is a UNION signal recorded after the request: a pushed commit (a `pr_synchronized` on a
DIFFERENT head than the one stamped into the `changes_requested`), fresh evidence, or a
fresh `review_summary`. Any one clears the block; commit-only would strand an
evidence-only request (the director said "there are no evidences") forever. The agent's
explicit `ready` emit is intentionally NOT guarded — it can legitimately race ahead of
the reconciler recording `pr_synchronized`.

- `GET /api/tasks/:id/diff` → `200 DiffResult` | `400` (no branch & no `pr_url`, or project has no `repo_path`) | `404` | `502` (gh/git failed)
  The task branch's changes. When `pr_url` is set, `gh pr diff <url> --patch`;
  otherwise `git -C <repo> diff <default_branch>...<branch>` in the project repo.
  The unified diff is parsed into:
  ```json
  {
    "files": [
      { "path": "src/a.ts", "additions": 2, "deletions": 1, "binary": false,
        "hunks": [ { "header": "@@ -1,3 +1,4 @@ ctx", "lines": [
          { "kind": "ctx", "text": " line1" },
          { "kind": "del", "text": "line2" },
          { "kind": "add", "text": "line2 changed" }
        ] } ] }
    ],
    "truncated": false
  }
  ```
  `kind ∈ {add, del, ctx}`. Total parsed lines are capped at 20000; past that
  `truncated` is `true` and the remaining diff is omitted (view the PR for the
  full patch). Binary files carry `binary: true` and no hunks.

- `POST /api/tasks/:id/merge` body `{merge_strategy?: "local_ff", override_destructive_check?: boolean}` → `200 Task` (now `verifying`) | `409` (not `in_review`, or the merge failed: conflict / not a fast-forward / gh refused / **destructive auto-rebase**) | `403` (denied by a `task.merge` authority rule) | `404` | `400` (local merge but no `repo_path`/`branch`)
  Approve & merge. When `pr_url` is set: `gh pr merge <url> <method>` where
  `method` is the project's `config.merge_method` (`squash` default, or `merge` /
  `rebase`). Otherwise a **local fast-forward**: the default branch is
  fast-forwarded to the task branch tip (`git merge --ff-only`); it is refused
  with `409`, no working tree touched, if the primary checkout's `HEAD` is not on
  the default branch (that merge lands on `HEAD`, wherever it points) or the merge
  is not a fast-forward (diverged/conflicting — rebase the branch or open a PR for
  a squash merge).

  **Stale-base fallback.** GitHub decides mergeability against `origin/<base>`,
  which can sit behind the primary checkout's local `<base>`. So when `gh pr merge`
  fails with a conflict-shaped reason *and* the PR's own state blames the base
  comparison (`mergeStateStatus` is `DIRTY`/`BEHIND`/`UNKNOWN`, no blocking
  `reviewDecision`, no failing or running required check) and the project has a
  `repo_path` and the task a `branch`, hive retries as a local fast-forward onto
  local `<base>` instead of bouncing the task to the agent — rebasing onto a stale
  `origin/<base>` would only pull in unrelated history. Branch protection wears the
  same opaque "not mergeable" reason, so this gate never fires on a protection
  block. When the gate does not open, the normal `409` / bounce-to-agent behaviour
  below applies with the `gh pr merge` reason alone; when it opens but the local ff
  is then refused, the message carries both reasons.

  **`merge_strategy: "local_ff"`** forces the local fast-forward for a PR-backed
  task, skipping `gh pr merge` and the fallback's review/check gate — an explicit
  override for a PR whose base comparison is stale while the branch is still a
  clean ff onto local `<base>`. The PR state probe still runs: a `CLOSED` (not
  merged) PR is refused, a `MERGED` one just advances the task. The review card
  surfaces this as a **Force local merge** button next to a failed merge on a
  PR-backed task, so the escape hatch needs no raw API call.

  **Destructive auto-rebase guard.** no-mistakes' CI monitor can auto-rebase a
  stale branch onto base, "resolve" the conflicts by dropping the intervening
  commits, and still report green CI (task #314: it reverted an unrelated shipped
  task's work). Green CI does not catch this. Before merging, hive compares the
  branch's current authored file-set against a `branch_scope` snapshot the
  reconciler captured at first sight (pre-rebase); if the branch now authors a
  file it did not originally *and* base advanced that file since, the merge is
  refused with `409`, a `merge_blocked_destructive` event is recorded, and the
  task is bounced to `in_progress` with a steer to re-cut off current base.
  **`override_destructive_check: true`** skips this guard when the reverts are
  intentional. The guard is a no-op when no pre-rebase snapshot exists (hive
  first saw the branch already rebased).

  On success: writes
  a `merged` event, transitions `in_review → verifying` (which runs the project's
  post-deploy smoke once), and best-effort removes the task worktree (a teardown
  failure never fails the merge). On failure: `409` with the reason and a
  `merge_failed` event; a **conflict** (the reason matches conflict / not
  mergeable / not an ancestor / fast-forward — the agent's to fix) additionally
  bounces the task `in_review → in_progress` with best-effort rebase
  instructions, while any other failure leaves the task `in_review`. Either way
  the reason stays on the card as `health.stuck` until it is resolved or ages out
  (see `health`). Guarded by the standing-authority gate with action `task.merge`.

- `POST /api/tasks/:id/request-changes` body `{notes (required)}` → `200 {"ok":true, "delivered":<bool>, "task": Task}` (now `in_progress`) | `409` (not `in_review`) | `400` (blank notes) | `404`
  Bounce the task back to `in_progress` for another pass. Delivers `notes` to the
  live agent via `herdr agent send` when one is alive (`delivered` reports
  whether the send landed); either way a `changes_requested` event records the
  notes so a respawned agent has them. **Reject** is not a separate endpoint — it
  is `POST /transition {to:"cancelled", reason}` (allowed from `in_review`).

`GET /api/brief[?since=<iso>]` returns `{since, done, director_required_task_ids, failed_or_attention, decisions, fleet, incidents, intake, to_review, spend, learnings_new}`. `director_required_task_ids` is the unique set of task ids for open decisions the target project's autonomy profile does not allow a supervisor to answer, plus open checkpoints in conservative projects. `done` excludes `chat_supervisor` infrastructure tasks. `to_review` contains the current `in_review` tasks as full Task objects with `health`; `done`, incidents, spend, and learnings are windowed by `since`, while action-state sections remain current.

### Search — `GET /api/search?q=&limit=`
Global text search across the five text-bearing entities, for the web command
palette. → `200 {"hits": [SearchHit, ...]}`.

```json
{ "type": "task", "id": "9da7c5527580", "title": "Add dark mode toggle",
  "snippet": "User-facing dark mode toggle in settings.",
  "task_state": "done", "project_id": "proj_ab12..." }
```
- `type ∈ {task, decision, learning, policy, project}`. `task_state` and
  `project_id` are present only on `task` hits; other types omit them.
- Fields searched per type: task (title, brief, summary), decision (title,
  context), learning (title, body), policy (title, body), project (name).
- `snippet` is a ~120-char window around the first body match (empty for
  project hits, which have no body).
- Ranking (per entity): exact title match > title prefix > title substring >
  body-only match; ties break alphabetically by title.
- `q` is matched case-insensitively; `%`/`_`/`\` are treated literally (not SQL
  wildcards). An empty/whitespace `q` returns `{"hits": []}`.
- `limit` defaults to 50 and is capped at 50 (the total returned across all
  types). Implementation is LIKE-based (no FTS5), suitable for a local
  single-user DB.

### Event ingestion — `POST /api/tasks/:id/events`
The `hive emit` path. Accepts **either** `application/json` **or**
`multipart/form-data` (multipart is required to upload an evidence file). All
recognized fields (JSON keys == form field names):

| field | meaning |
|-------|---------|
| `type` (required) | `status` \| `evidence` \| `needs-decision` \| `ready` \| `done` \| `blocked` \| `deferred` \| `undefer` \| `usage` \| `assistant_text` \| `tool_use` \| `agent_turn_end` \| any custom string |
| `source` | defaults to `agent` |
| `note` | free text; stored in the event payload / used as caption/summary |
| `pr_url` | (`ready` type) the opened PR URL; recorded on the task if not already linked |
| `payload` | structured event payload object, passed through verbatim for `assistant_text` / `tool_use` / `agent_turn_end` (JSON body) |
| `kind` | evidence kind (evidence type only); defaults to `screenshot` if a file is present, else `link`/`log` |
| `caption` | evidence caption |
| `url` | evidence URL (for link evidence, no file) |
| `meta` | (evidence type) JSON string merged into the Evidence row's `meta`; `hive emit ... evidence` auto-fills `{commit_sha}` from `git rev-parse HEAD` in its cwd |
| `title`,`context`,`risk`,`blast_radius`,`options` | decision fields (needs-decision type; `options` is a JSON string in multipart) |
| `until`,`days` | (deferred type) auto-resume horizon: an ISO timestamp (`until`) or an integer number of days from now (`days`); neither = indefinite |
| `model`,`input_tokens`,`output_tokens`,`cache_read_tokens`,`cache_write_tokens`,`cost_usd` | usage fields (usage type; numbers, or numeric strings in multipart; `cost_usd` optional) |
| `file` | (multipart only) the uploaded evidence file |

Behavior by `type`:
- `evidence` → copies the file to `~/.hive/evidence/<task_id>/`, inserts an
  Evidence row, writes an `evidence` event. → `201 {evidence: Evidence, event: Event}`
- `needs-decision` → creates a Decision (minimal; full cards use `POST /api/decisions`),
  parks the task in `needs_decision`. Missing/empty `options` default to
  `proceed`/`dismiss` (the emit path defaults rather than dropping the agent's
  signal). → `201 {decision: Decision, task: Task}`
- `ready` → the finished-handoff signal. Records `pr_url` (when supplied and not
  already linked, writing a `pr_linked` event), then advances `in_progress →
  in_review` with a `ready_for_review` event. Idempotent: on a task that isn't
  `in_progress` (already advanced) it acks without transitioning. → `200 {task: Task}`
- `done` → records the `note` as summary + `note` event, then transitions the
  task to `done` (evidence rule enforced). → `200 {task: Task}` | `409`
- `usage` → inserts a Usage row (cost computed server-side when `cost_usd` is
  omitted; null for unpriced models) and broadcasts a `usage` SSE message. Writes
  no timeline event. → `201 {usage: Usage}` | `400` (missing `model`)
- `assistant_text` / `tool_use` / `agent_turn_end` → writes one event with the
  supplied `payload` preserved verbatim (the transcript hooks' path). → `201 {event: Event}`
- `deferred` → parks a task waiting on an OFFLINE human action (e.g. sudo). Sets
  `deferred_until` (from `until`/`days`, else a far-future sentinel = indefinite)
  and writes a `deferred` event; the task **stays `in_progress`** (no state hop).
  While `deferred_until` is in the future the stale/nudge machinery skips it, so
  the "gone quiet" nudge and the director stale notification stop firing. Once
  the horizon passes, normal staleness resumes (the deadline is the check-back).
  → `201 {task: Task}`
- `undefer` → clears `deferred_until` and writes an `undeferred` event; if the
  task was still deferred, queues a resume steer to the (possibly idle) agent.
  → `201 {task: Task}`
- `status` / `blocked` / custom → writes one event. → `201 {event: Event}`

### Attachments

Steer messages and task briefs can carry files (screenshots, mockups, a creds
JSON). Send the request as `multipart/form-data` instead of JSON: text fields
keep their JSON key names, and every file goes under the field name `files`
(repeat it for several). A JSON body still works and attaches nothing.

    curl -X POST "$HIVE_URL/api/tasks/$ID/send" \
      -F 'message=match this mockup' -F 'files=@mockup.png' -F 'files=@notes.txt'

    curl -X POST "$HIVE_URL/api/tasks" \
      -F project_id=proj_x -F title='Rebuild the header' \
      -F 'brief=match the design' -F 'files=@mockup.png'

Files are stored under `$HIVE_HOME/evidence/<task_id>/` (name-collision safe).
The **absolute path** of each is appended to the steer message / brief under an
`## Attachments` heading, because agents read files off disk rather than over
HTTP:

    ## Attachments
    These files are on disk; read them with the Read tool.
    - /Users/me/.hive/evidence/tsk_abc/1720598400000_mockup.png

Attachments deliberately do **not** create `Evidence` rows. Evidence gates the
`done` transition, and a file the director attached as *input* is not proof of
work. Use `POST /api/tasks/:id/events` with `type=evidence` for that.

### Analytics (cost/token)
- `GET /api/analytics/summary?since=` → `200 {since, totals, by_model, by_project, top_tasks}`
  Rollups over the usage table. `since` is an optional ISO timestamp lower bound
  (`ts >= since`); omitted = all time. `totals` is the aggregate totals object
  (see the Usage shape). `by_model` is `[{model, ...totals}]` and `by_project` is
  `[{project_id, project_name, ...totals}]`, both ordered by cost then tokens
  descending. `top_tasks` is the 10 most expensive tasks:
  `[{task_id, title, project_id, ...totals}]`.
- `GET /api/tasks/:id/usage` → `200 {task_id, usage:[Usage], totals}` | `404`
  All usage rows for a task (oldest first) plus the totals object.

### Decisions
- `GET /api/decisions?status=open[&project_id=<id>]` → `200 [Decision, ...]` (newest first; `status` defaults to `open`; `status=all` returns every decision; `project_id` optionally scopes the list)
- `POST /api/decisions` body `{task_id (required), title (required), context?, risk?, blast_radius?, options (required, non-empty)}` → `201 Decision` | `400` (missing/empty `options`)
  (also writes a `needs-decision` event and parks the task in `needs_decision` if its current state allows it)
- `GET /api/decisions/:id` → `200 Decision` | `404`
- `PUT /api/decisions/:id/draft` body `{draft_note}` → `200 {"ok":true, "id":...}` | `404`
  (autosave; call debounced on every keystroke; overwrites `draft_note` only)
- `POST /api/decisions/:id/answer` body `{answer_key (required), answer_note?, selected_indices?, source?, actor?}` → `200 Decision` (now `answered`) | `400` (bad key/source, malformed note/selection, or empty planner selection) | `409` (already answered)
  Archives the card (`status=answered`, `answered_at` set), writes a
  `decision_answered` event (`source: "director"`, `payload.answered_by: "director"`),
  and resumes the task (`needs_decision → in_progress`).
  If `answer_note` is omitted, the saved `draft_note` is used. When approving a
  planner breakdown, a non-empty answer note is appended to every created task's
  brief under `Director notes:`; the web card includes answered open questions
  in this note.
  `selected_indices` only applies to a planner-breakdown card (one with `plan`,
  see below) answered `approve`: an array of indices into `plan.proposed_tasks`
  to create, allowing a subset instead of all-or-nothing. Omit it to create every
  proposed task (unchanged behavior for non-UI callers). Duplicate, non-integer,
  and out-of-range indices are ignored; if no valid tasks remain, approval
  returns `400` and the card stays open so the caller can answer `reject`
  instead.
  `source` is the caller identity for the audit trail: `director|chat_supervisor|agent|system|unknown`
  (a present-but-invalid source is `400`; a missing source is recorded as `unknown` — the web
  inbox sends `source:"director"` explicitly). `actor` is an optional free label. Both are
  recorded on the decision (`answered_by`, `answered_actor`) and the `decision_answered` event.
  This is identity only — it grants nothing and triggers no auto-approval.
- `POST /api/decisions/:id/auto-answer` body `{answer_key (required), answer_note?}` → `200 Decision` (now `answered`) | `400` (missing key or malformed answer payload) | `403 {effect:"escalate", category, reason}` | `404` | `409` (already answered)
  The chat supervisor's self-approval path. Runs a **server-enforced** safety bar
  (`evaluateAutoApprove`) before doing anything — the bar, not the caller's
  identity, is the gate, so a worker hitting this endpoint on loopback gets the
  same verdict. The bar is a CLOSED allow-list of three intrinsically-reversible
  mechanical categories: reference capture (`Save recurring link…` → `save`),
  high-confidence duplicate merge (a `duplicate_suspected` card → `merge`), and
  task requeue (a `recovery_card` → `requeue`). It clears only when the chosen key
  is the raiser's own `recommended` option (also the confidence gate), `risk` is
  low/normal, and the blast radius names no prod/shared target; a pending
  standing-authority command grant is a hard structural exclusion (never
  auto-approvable). On clear it writes an `auto_approved` audit event
  (`source: "chat_supervisor"`, carrying `category` + `reason`) and then answers
  the card exactly as `/answer` would, tagged `source: "chat_supervisor"`. On
  decline it answers NOTHING, leaves the card `open`, writes an
  `auto_approve_declined` event, and returns `403` so the caller escalates to the
  director. Everything outside the allow-list (cost caps, PR merges, deny-guardrail
  policy changes, blocked-pane relays, plain product questions) always declines.
- `POST /api/decisions/:id/dismiss` → `200 Decision` (now `expired`) | `404` | `409` (already closed). Dismissing the task's LAST open card resumes a `needs_decision` task to `in_progress` (a parked task with nothing to wait on is stranded); no resolver hooks fire.
  Clears a card without answering it (the human escape hatch for a card that is
  no longer relevant, or that somehow has no usable options). Sets
  `status=expired`, writes a `decision_expired` event (`reason: "dismissed"`),
  and broadcasts so the inbox clears live. Runs no resolvers — dismissing is
  explicitly "take no action".

  Answering also runs the standing-authority and domain-supervisor resolvers: if
  the card was an authority request, `approve` mints a single-use grant; if it was
  a planner breakdown proposal, `approve` creates the selected proposed tasks as
  `queued` tasks with `source="planner"` and `parent_task_id` set to the source
  task (each gets a `created` event), while `reject` creates nothing (event only).

### Director chat (persistent supervisors and Chief of Staff)
A chat thread is backed by a **persistent supervisor session**, a long-lived herdr agent (an interactive `claude` session, same runtime as a task agent), not a per-turn subprocess. A project-scoped thread coordinates one project. The single thread with `project_id: null` is the portfolio-wide Chief of Staff used by the default web home and drawer; it retains the same conversation across project switches and receives manager wakeups across the portfolio. Its coordination actions (creating tasks, answering decisions, reading status) go through the same `$HIVE_CLI` + API + standing-authority gates every hive agent uses. Merges, guarded operations, and destructive operations are gated identically, and the session has no privileged path around them. It may clear a narrow set of mechanical decision cards itself via
`POST /api/decisions/:id/auto-answer` (server-enforced allow-list, see Decisions
above), and may answer low/normal-risk reversible technical choices through the
normal audited answer endpoint after reasoning or a team discussion when the
project uses the `autopilot` profile. The Chief of Staff evaluates the target project's current profile before every action. `balanced` is limited to the safe
auto-answer endpoint; `conservative` leaves both decisions and checkpoints to
the director. It must
escalate unknown director intent or product preference, meaningful cost,
prod/shared destructive state, safety-policy changes, dangerous-command grants,
and inputs only the director can supply.
Conversation history persists in `chat_threads` / `chat_messages` (append-only,
same shape as `events`); each thread's `task_id` is its backing supervisor task
(`source='chat_supervisor'`, kept out of the dispatcher and the board lanes). The thread is also the durable run ledger: `objective`, `acceptance_criteria[]`, `phase`, `next_action`, `waiting_on`, `wakeup_at`, `outcome`, and `completed_at` survive supervisor restarts.

The supervisor task is also the root of an automatic management loop. Tasks it
creates inherit `parent_task_id=$HIVE_TASK_ID`; nested agent follow-ups preserve
the chain. Hive walks that ancestry for meaningful events, batches synchronous
transition bursts, and pushes one `[hive manager wakeup]` steer into the current
supervisor session. When an active Chief of Staff exists, it takes priority over project-scoped fallback managers for otherwise unowned worker events and inbox sweeps. The wake set covers blockers, decisions, peer messages,
review handoffs, CI/merge/smoke results, recovery, failures, and terminal state
changes. An explicitly closed thread is not respawned by a child event. The
manager brief requires it to act on each wakeup, use bounded proposal → critique
→ synthesis meetings where useful, and independently verify the integrated
top-level outcome before reporting completion. The Chief works silently between
director turns: routine wakeup replies are suppressed after its first response.
It may send one additional message only for newly surfaced decision cards or a
newly completed outcome.

- `POST /api/chat/turn` body `{text (required), thread_id?, project_id?, scope?: "chief"}` → `202 {thread_id, delivery, agent_target?, error?}` | `400` (empty text, missing project scope, or no active project repository for Chief of Staff) | `404` (unknown `thread_id`)
  Director → supervisor. **Non-blocking by design**: it persists the director
  message, makes sure the thread's supervisor session is live (spawning it on the
  first message — `delivery:"spawned"` — or delivering into the running one —
  `delivery:"delivered"`), and returns immediately. `project_id` is required to
  start a new project-scoped thread (the session runs in that project's repo). The message is
  broadcast over SSE as `{type:"chat_message", message}`. The session thinks/acts
  asynchronously and posts its reply via the `/reply` endpoint below — the
  director never blocks on the model. `delivery` is `spawned` | `delivered` |
  `failed`. With `scope:"chief"`, `project_id` is ignored and the existing global
  thread is reused or created with `project_id:null`; the session requires at
  least one unarchived project with a repository and uses the Hive project first
  when available. Without `scope:"chief"`, `project_id` remains required to
  start a new project-scoped thread.
- `POST /api/chat/threads/:id/reply` body `{text (required), decision_ids?: string[]}` → `200 {ok, message}` or `200 {ok, suppressed:true}` | `403` (decision outside a project-scoped thread) | `404` (unknown thread or decision) | `400` (empty text or more than five decisions)
  Supervisor → director. The session calls this (via `hive chat reply <thread>
  "..." [--decision <id> ...]`) to post its reply. Open, in-scope decision ids
  become structured message actions rendered as full decision cards in chat.
  The Chief deduplicates already surfaced cards and suppresses routine replies
  after an assistant message unless the run has newly completed. Appended
  messages stream over SSE as `{type:"chat_message", message}`. Loopback in
  practice (agents run on localhost).
- `GET /api/chat/threads?project_id=` → `200 [ChatThread, ...]` (newest first; `project_id` filter optional). An unfiltered response includes the global Chief of Staff thread; the query parameter filters to an exact project id.
- `GET /api/chat/threads/:id` → `200 {...ChatThread, messages:[ChatMessage], meetings:[ManagerMeeting], verifications:[ManagerVerification], retrospectives:[ManagerRetrospective]}` | `404`. Messages are oldest first. Management records are newest first; repeated meeting stages collapse to the latest card for each `meeting_id`.
- `PUT /api/chat/threads/:id/run` body `{objective?, acceptance_criteria?: string[], phase?, next_action?, waiting_on?, wakeup_at?, outcome?, source?}` → `200 ChatThread` | `400` | `404` | `409`. `phase` is `intake|planning|executing|waiting|verifying|complete|stopped`. Completing a run is rejected unless the newest verification passed and a retrospective exists. A successful update writes a `manager_update` event on the supervisor task. Waiting runs with a due `wakeup_at` are resumed by the daemon (`HIVE_MANAGER_WAKE_MS`, 30 seconds by default).
- `POST /api/chat/threads/:id/meetings` body `{stage: "proposal"|"critique"|"decided", meeting_id?, topic?, participants?: string[], summary?, decision?}` → `201/200 ManagerMeeting` | `400` | `404` | `409`. Proposal requires a topic and 2 to 3 worker task ids owned by this manager. Hive sends the agenda to each participant. Critique sends the competing-proposal summary back once. Decided records and broadcasts the conclusion, ending the meeting.
- `POST /api/chat/threads/:id/verifications` body `{status: "started"|"passed"|"failed", method, result?, target_task_ids?: string[], evidence_ids?: string[], replay_of?}` → `201 ManagerVerification` | `400` | `404` | `409`. A passing result requires a concrete result plus evidence ids from the run's project. This validation is still project-scoped: because a Chief of Staff thread has `project_id:null`, it cannot currently accept project task targets or evidence for a passing verification. Failure moves the ledger back to executing with corrective work as the next action.
- `POST /api/chat/threads/:id/verifications/:eventId/replay` body `{}` → `202 {verification, delivery, agent_target?, error?}` | `404` | `409`. It records a fresh started attempt, wakes the persistent supervisor with the prior method/result and current acceptance criteria, and asks it to compare the current integrated state.
- `POST /api/chat/threads/:id/retrospectives` body `{summary, worked?: string[], problems?: string[], lessons?: string[]}` → `201 ManagerRetrospective` | `400` | `404` | `409`. The record is append-only and is required before completing the run.
- `POST /api/chat/threads/:id/close` → `200 {ok, thread_id}` | `404` (unknown thread)
  Ends the thread's live session: cancels its backing supervisor task, which
  immediately tears down the worktree + herdr session (same terminal-hook path
  as any other task reaching `cancelled`; the reaper sweep is just the backstop).
  Idempotent. The thread and its message history are untouched — a later
  message to the same thread spawns a fresh supervisor task rather than
  resurrecting the closed one.

CLI: `hive chat send`, `reply`, and `close` handle the conversation lifecycle. `hive chat update` maintains the run ledger; `meeting` records and dispatches bounded proposal, critique, and decision stages; `verify` records evidence-backed attempts; `retrospect` records the completion review.

### Policies
- `GET /api/policies?scope=` → `200 [Policy, ...]` (oldest first; `scope` filter optional)
- `POST /api/policies` body `{title (required), body (required), scope?, active?}` → `201 Policy` (scope defaults to `global`)
- `GET /api/policies/:id` → `200 Policy` | `404`
- `PUT /api/policies/:id` body `{title?, body?, scope?, active?}` → `200 Policy` | `404`
- `DELETE /api/policies/:id` → `200 {"ok":true}`

### Authority rules (standing-authority policy engine)
Scoped rules that the server enforces before risky actions dispatch (see the
`guarded-action` endpoint above and the event types). Grants are internal
(single-use, minted on card approval); there is no grant endpoint.
- `GET /api/authority/rules?project_id=` → `200 [AuthorityRule, ...]` (oldest first; `project_id` filter optional)
- `POST /api/authority/rules` body `{action_pattern (required), effect?, project_id?, note?, active?}` → `201 AuthorityRule` | `400` (bad `effect` / unknown `project_id`)
  `effect` defaults to `allow`; `scope` is derived from `project_id` (`global` when null).
- `PUT /api/authority/rules/:id` body `{action_pattern?, effect?, note?, active?}` → `200 AuthorityRule` | `400` (bad `effect`) | `404` (deactivate = `active:false`)
- `DELETE /api/authority/rules/:id` → `200 {"ok":true}`

### Command auto-approval (spawned agents)
A spawned worker has no human at its pane, so a Bash permission dialog hangs it
forever. Three layers keep safe commands flowing and route risky ones through the
same authority engine (`writeHookSettings` in `api.ts`; `hooks/classify.ts` +
`hooks/hive-approve.sh`; wired into each worktree's `.claude/settings.local.json`):

1. **Static allowlist** — `permissions.allow` lists clearly-safe tools that never
   prompt: `Read`, `Grep`, `Glob`, and read-only `Bash(...)` patterns
   (`ls`, `cat`, `grep`, `git status/diff/log/show/branch`, `bun test`, `bun run`,
   `npm test/run`, ...). `permissions.deny` (browser MCPs) still wins over allow.
2. **PreToolUse classifier hook** (`Bash` matcher → `hive-approve.sh <policy>`).
   `classify.ts` (pure, unit-tested) sorts each command:
   - **safe** (read-only / standard dev, no dangerous tokens, no `$(...)`/backtick
     substitution) → emits the PreToolUse **allow** decision, no dialog.
   - **dangerous** (`rm -rf`, `sudo`, `curl|wget … | sh`, `git push --force`,
     `git reset --hard`, `find … -delete/-exec`, `DROP/TRUNCATE`,
     `DELETE FROM`/`UPDATE … SET` without `WHERE`, fork bomb, `mkfs`/`dd of=`,
     device/system-path writes, `kill`, `terraform apply/destroy`,
     `kubectl delete`, SSH/AWS credential files, …) → escalates via
     `POST guarded-action {action:"command.dangerous", target:<cmd>}`.
     Never auto-allowed, even under `command_approval:"allow"`.
     **Sandbox waiver**: a destructive command PROVEN to act only inside the
     agent's own sandbox (its herdr worktree or a tmp scratchpad) is first
     downgraded out of `dangerous` to **unknown** (allow-and-log) — this covers
     `rm -rf`, `kill`/`pkill`, `git reset --hard`/`git clean`, `git push --force`,
     `find … -delete/-exec`, and sandboxed SQL. Anything unresolvable (a shell
     var, a `..` escape, an un-sandboxed or unknown path) stays dangerous.
   - **unknown** (not provably safe) → escalates via `{action:"command", …}`, or is
     allowed / deferred per the `command_approval` policy below.

   The PreToolUse output schema (stdout, exit 0): `{"hookSpecificOutput":
   {"hookEventName":"PreToolUse","permissionDecision":"allow"|"deny",
   "permissionDecisionReason":"..."}}`. On escalation the hook maps the
   guarded-action result: `200 allow` → allow; `403 deny` → deny (with reason);
   `409 require_decision` → **deny-for-now** with reason `escalated to hive
   decision <id>` (a card opens; re-running the same command after the director
   approves passes once, spending the single-use grant). **Fail-safe**: if hive is
   unreachable the hook DENIES (2s curl cap) — an unclassified dangerous command
   is never auto-allowed.
3. **`command_approval`** (project `config` field) governs UNKNOWN commands only:
   `"escalate"` (default) → guarded-action; `"allow"` → auto-approve; `"prompt"` →
   defer to Claude Code's normal dialog. Dangerous always escalates regardless.

**Deny-safe by default**: the authority engine defaults unmatched actions to
`allow` (log-only), *except* `command.dangerous*`, which requires a decision even
with no rule in the DB — safety does not depend on seed state. The daemon also
bootstraps the matching `command.dangerous* → require_decision` rule on first
boot (idempotent), so it is visible and editable in the Authority UI. Override it
like any other rule: `POST /api/authority/rules {"action_pattern":"command.dangerous*","effect":"deny"}`
for a hard block, or `"effect":"allow"` to deliberately opt out. Because dangerous
commands carry the distinct `command.dangerous` action, this gates them without
touching ordinary `command` escalations.

### Incidents
- `GET /api/incidents?status=` → `200 {"incidents": [Incident, ...]}` (newest first; `status` filter optional, e.g. `open` / `resolved`)

### Learnings (regression ledger)
- `GET /api/learnings?project_id=&status=` → `200 [Learning, ...]` (newest `last_seen` first; both filters optional)
- `POST /api/learnings` body `{project_id (required), title (required), kind (required: "failure" | "reference"), body?, source_task_id?, create_root_cause_task?}` → `201 Learning` | `400` (unknown `project_id`, or missing/invalid `kind` — no silent default)
  With `create_root_cause_task: true` (only valid for `kind:"failure"`, else `400`), a queued `chore` task is auto-created (brief prefilled from the learning) and its id is set as `root_cause_task_id` — the "unblock now, root-cause later" flow. Broadcasts a `learning` (and, for the auto task, a `task`) SSE message.
- `GET /api/learnings/:id` → `200 Learning` | `404`
- `PUT /api/learnings/:id` body `{title?, body?, status?, kind?, root_cause_task_id?}` → `200 Learning` | `400` (bad `status`; `kind` outside `"failure" | "reference"`; or any `kind` change on a `"decision"` row, which the decision path owns) | `404` (resolve = `status:"resolved"`; `kind` is correctable here — e.g. a misfiled `failure` reclassified to `reference`. A `kind` equal to the stored one is a no-op, not an error)
  Correcting `kind` off `"failure"` cancels the linked root-cause task and clears `root_cause_task_id` — but only a still-`queued` task that hive auto-spawned for this learning; one already dispatched, or one linked by hand via `root_cause_task_id`, is left untouched.
- `DELETE /api/learnings/:id` → `200 {"ok":true}`
  Same retraction as above: an auto-spawned root-cause task still sitting `queued` is cancelled with the learning that justified it.
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
| usage | `{"type":"usage","usage": Usage}` | a usage row is ingested (cost/token analytics) |
| chat_message | `{"type":"chat_message","message": ChatMessage}` | a director-chat message is appended (director turn or supervisor reply) |
| notification | `{"type":"notification","notification": Notification}` | a notification is enqueued (urgent ones arrive already `delivered_at`) |
| reconciler_error | `{"type":"reconciler_error","error":"...","where":"..."}` | a reconciler cycle hit an error (at most once per cycle; no DB row) |

A state change therefore produces both an `event` message (`type:"state_change"`)
and a `task` message. The client should upsert by `id`. There is no replay/backfill
on connect; load current state via the REST endpoints, then apply stream deltas.

### Braindump intake — `POST /api/intake`
Body `{project_id (required), text (required)}` → `202 {"ok":true, "task": Task}`
| `400` (blank text, unknown `project_id`).

The director's braindump path: dump unstructured text instead of hand-writing a
task. The text is stored verbatim as a `chore` task (state `queued`,
`source: "intake_braindump"`, title `[braindump] <first line, elided at 72 chars>`,
full text in the brief) and the domain-supervisor planner is triggered on it, so
the flow is: braindump → proposed breakdown decision card → `approve` → the
checked proposed tasks are queued. All start checked, and nothing is queued as
work until the card is answered.

The planner runs out-of-band (it is a `claude -p` subprocess taking tens of
seconds), so the response returns `202` immediately and the decision card arrives
over SSE. A planner failure records a `planner_error` event on the braindump task
and leaves it `queued` for another `POST /api/tasks/:id/plan`.

On `approve`, the braindump task is transitioned to `cancelled`
(reason `planned into N task(s)`) — it is a container, not work, and the child
tasks carry it. Like every `source="intake_*"` task it is never auto-dispatched
(see Dispatcher) and the board hides its manual "dispatch now" affordance.

### Intake connectors (Google Chat)
No HTTP endpoints — the connector is a server-internal poller plus a local CLI
command. It reads an allowlist of Chat spaces (`config.gchat_spaces` per project)
and drafts a `ship` task (state `queued`, `source: "intake_gchat"`, title
`[intake:gchat] <first line>`, full message in the brief) for each new message,
with a `note` event marking it UNREVIEWED and image attachments (png/jpg/gif/webp,
≤5MB) attached as `screenshot` evidence. Message text is untrusted: stored
verbatim, never executed or shell-inlined. Self-authored (`GCHAT_SELF_ID`) and
bot messages are skipped; each message is deduped by its resource name (unique
`tasks.source_ref`). Every new intake task enqueues a `normal` notification.

- Poll interval: `HIVE_GCHAT_POLL_MS` (default 60000). Hard no-op until at least
  one project sets `config.gchat_spaces`.
- Cursor: `intake_cursors(source, key, cursor)` persists the incremental
  `createTime` position per `("gchat", <space>)`.
- Secrets (values in the macOS keychain under `hive/gchat/*`, never in the DB):
  `GCHAT_CLIENT_ID`, `GCHAT_CLIENT_SECRET`, `GCHAT_REFRESH_TOKEN`, and optional
  `GCHAT_SELF_ID`. Set them once with `hive gchat auth` (interactive OAuth
  consent; scope `chat.messages.readonly`).
- Errors (token expiry, list failure) emit a single diagnostic then stay quiet,
  recovering on the next successful poll — no spam.

### Domain supervisors (on-demand planners)
A per-project planner that triages a task and proposes a breakdown. hive's core
design REJECTS long-running LLM supervisor sessions (firstmate's failure mode):
the supervisor is "persistent" only in that its ROLE and CONTEXT live in the DB
(the `supervisor_persona`, `playbook`, `plan_intake`, `planner_argv` config
keys). The LLM itself runs as a short-lived, on-demand subprocess:
`<planner_argv> <prompt> --output-format json` (default binary `claude -p`,
timeout-capped by `HIVE_PLANNER_TIMEOUT_MS`, default 120000; the process is
killed on timeout). Injectable exec for tests.

- Prompt composition (`server/src/planner.ts`, pure function of DB state): the
  supervisor persona + project playbook + active global/project policies + active
  learnings + the source task's title/brief + a fixed instruction to return
  STRICT JSON `{proposed_tasks:[{title,brief,kind}], rationale, questions:[]}`.
  The source task's text is treated as data, never as instructions to the planner.
- Parsing is defensive: the JSON object is extracted whether returned raw, inside
  the claude `--output-format json` envelope (`{result:"..."}`), or wrapped in
  prose. Unknown `kind` normalizes to `ship`; entries without a title are dropped.
  Unparseable output records ONE `planner_error` event and stops (no retry storm).
- Triggers: `POST /api/tasks/:id/plan` (manual, any task), `POST /api/intake`
  (always, the director's braindump), and auto on Google Chat intake task
  creation when the owning project sets `config.plan_intake: true`.
- Result: a policy-scored decision card on the source task titled `Proposed
  breakdown: <title>` with options `approve` (recommended) / `reject`, plus a
  `planned` event carrying the structured proposal and scoring reason. The
  structured proposal is returned as `Decision.plan`, while the flattened
  context remains available to non-UI consumers. On `approve` the selected tasks
  are created `queued` with `source="planner"` and `parent_task_id` → the source
  task, and question answers plus any optional note are appended to their briefs.
  All tasks are checked by default, including for callers that omit
  `selected_indices`. A `normal` `planned` notification is enqueued. On `reject`
  nothing is created (the `decision_answered` event is the only record).

### Blocked agents (dialog handling)
When herdr reports an agent `blocked`, the reconciler reads the pane immediately
(no stale-threshold wait). Interactive dialogs from read-shaped MCP tools
(`get_*`/`list_*`/`search_*`/`read_*`/`whoami`) are auto-approved with
"don't ask again" and logged as a `dialog_auto_approved` event; projects extend
the allowlist with `config.dialog_auto_approve` (array of regex strings matched
against the dialog text). Anything else opens an URGENT decision card whose
Approve/Deny answer sends the keystroke to the pane remotely
(`blocked_card`/`dialog_answered` events); the task parks in `needs_decision`.
Silent-path diagnosis (auth lost, context exhausted, transient API errors) is
described in `server/src/diagnose.ts`.

### Promoter (continuous promote-to-main evaluation)
No HTTP endpoints — a server-internal loop (`server/src/promoter.ts`, every
`HIVE_PROMOTE_MS`, default 30m, plus one run ~30s after boot). Projects opt in
with `config.promote = {from: "staging", to: "main"}`. Whenever `origin/<from>`
has commits `origin/<to>` lacks, it queues ONE evaluation task
(`source="promoter"`, `source_ref` = the evaluated head SHA, kind `ship`) that
the dispatcher spawns like any other. The agent judges readiness — CI green,
test comprehensiveness for the promoted range (uncovered bug fixes or gaps in
auth/billing/data-integrity paths BLOCK promotion; the agent spawns a gap task
per missing test), half-shipped features, pending migrations — and either opens
the Promote PR with a per-PR "Test coverage" verdict section (base `<to>`,
head `<from>`; the DIRECTOR merges) or attaches a not-ready report and finishes. Dedup: one in-flight evaluation per project, a given head
SHA is evaluated at most once, and an already-open promote PR suppresses new
evaluations until it's merged/closed.

### Dispatcher (self-driving spawn loop)
No HTTP endpoints — the dispatcher is a server-internal loop (`server/src/dispatcher.ts`,
default every 30s, `HIVE_DISPATCH_MS`). It picks up `queued` tasks and spawns a
herdr agent for each (the same path as `POST /api/tasks/:id/spawn`), gated by:
project `config.auto_dispatch: true` (default off), `config.dispatch_kinds`
(default `["ship","scout"]`), `config.max_agents` (default 3, per-project cap on
WORKING agents — `in_progress`/`needs_decision`; review-parked agents
(`in_review`/`verifying`) don't consume working slots but bound total live
agents at `max_agents × 2` so a full review queue slows, not freezes, dispatch),
an intake-review gate (any `source="intake_*"` task — gchat
messages, director braindumps — is skipped until a `reviewed` event or a `note`
event containing "reviewed" exists), and the standing-authority gate. The authority gate calls
`authorize(action="task.dispatch", target=<title>)`; a `deny` rule blocks the
auto-spawn (`authority_denied` event) and a `require_decision` rule opens a card
and parks the task, exactly like the other guarded actions. Spawn failures write
a single `spawn_error` event and back off exponentially per task
(`min(30s·2^(n-1), 30m)`, counting only the task's own non-infra failures); the
task stays `queued` with the error visible. Herdr-daemon-down failures
(`infra: "herdr_unreachable"`) instead trip a global circuit breaker that pauses
all dispatch on a cooldown (see `docs/runtime.md`).
Manual dispatch (the web "dispatch now" button → `POST /api/tasks/:id/spawn`)
bypasses these policy gates but still runs the `task.spawn` authority gate. See
`docs/runtime.md`.

### Duplicate detection & auto-merge (`server/src/dedup.ts`)
Ghost-task recreation and repeated asks produce real duplicate tasks (e.g. two
"intake form" tasks). Every `POST /api/tasks` runs detection against the existing
NON-TERMINAL tasks in the SAME project (keyed on task `id`/`title`, never on the
`number` column). The survivor is always the OLDER task.

- **Normalization / similarity.** Exact = normalized titles equal (trim,
  lowercase, collapse whitespace, strip trailing punctuation). Near =
  `titleSimilarity(a,b)` ≥ `0.6`, a pure word-set Jaccard (|A∩B|/|A∪B|) over the
  normalized title words — no dependencies. `0.8` is the "very strong" mark that
  flips the decision card's recommended option to *merge*.
- **Exact duplicate of a brand-new task (queued, no `agent_target`) → auto-merge,
  no interruption.** The new task is folded into the survivor and cancelled with
  `duplicate_of` set; both get a `duplicate_merged` event (the survivor's carries
  the folded brief when it adds anything). The `POST /api/tasks` response is the
  new task in its resulting `cancelled` state.
- **Near duplicate (or an exact dup of a task that has already started) → a
  decision card on the NEW task**, titled `Possible duplicate of "<survivor>"`,
  options `merge` / `keep-separate` (a `duplicate_suspected` event links it). The
  new task stays `queued`; nothing is auto-cancelled. Answering `merge` runs the
  same fold+cancel; `keep-separate` records the decision and leaves both.
- **Safety.** A task with an `agent_target` or past `queued` is NEVER
  auto-cancelled — only a brand-new queued task is auto-merged; everything with
  work in flight goes through the decision card (or the manual `/merge-into`,
  which still refuses to cancel an already-terminal task).

### Auto-cleanup & the reaper (finished-task teardown)
Finished tasks get their runtime torn down automatically so orphan worktrees and
herdr sessions never pile up (`server/src/cleanup.ts`, `server/src/reaper.ts`).

- **On the transition (immediate).** When a task reaches `done` or `cancelled`,
  the server fires `cleanupTask`: runs the per-project teardown hook
  (`config.cleanup_argv`, e.g. `wt.sh down {worktree}`) BEFORE removal so it can
  still see the worktree's files (best-effort, `stack_teardown` event), then
  removes its git worktree and closes its herdr session (the labelled tab, or the
  agent's pane) plus the worktree's OWN herdr workspace — the spare pane
  `worktree create` auto-spawns but the agent never uses (it runs in the fleet
  tab), recorded on the `spawned` event as `workspace_id` and closed once here
  (never the shared fleet workspace). It leaked a pty per task until this closed
  it (2026-07-25). `failed` is deliberately
  **excluded** — a failed task may still be auto-requeued/retried, so tearing it
  down there would race the retry; the dead-agent recovery path already reclaims
  its worktree, and the reaper is the backstop.
- **The reaper (backstop, periodic).** `server/src/reaper.ts`, default every 5
  min (`HIVE_REAP_MS`). Enumerates hive worker worktrees (`git worktree list`
  across every project repo) and, for each on a `hive/<task-id>` branch whose
  task id maps to a **terminal** task or to **no task at all**, tears it down.
  A non-terminal task keeps its worktree (never touched). Isolated try/catch per
  item; a failure never crashes the server. The same cycle also runs
  `sweepOrphanedAgents` (diffs `herdr agent list` against live DB tasks, reaping
  any agent whose task row is gone) and `sweepOrphanedPanes` — the pty-leak
  backstop: it enumerates every herdr PANE (one pty each), maps each to a task by
  its cwd basename `hive-<task-id>`, and reclaims the pty of any whose task is
  terminal or gone by closing the worktree's own workspace or its fleet tab. A
  pane is kept whenever its task is non-terminal (reads authoritative DB state,
  not a herdr probe, so a live agent is never closed), and the sweep bails
  without reaping if the fleet workspace id can't be resolved (so it can never
  close the whole fleet). It also records the pre-sweep pane count for the
  `sessions` health gauge.

**Safety (never destroys work).** Removal keeps `teardown`'s guard: a worktree is
removed only when its branch is pushed to origin **or** merged into the default
branch (else the worktree + session are left fully intact and a `cleanup_skipped`
event records the reason). Even on a safe branch, tracked uncommitted changes are
first committed to a `ghost-<task-id>` branch (`cleaned_up.ghost_branch`); only
purely-untracked/ignored artifacts (e.g. `.serena/`, the injected
`.claude/settings.local.json`) are discarded by the force removal. Ghost branches
(`ghost-<task-id>`) are never themselves reaped. After a successful removal the
task's `agent_target`/`worktree_path` are cleared so a re-run is a no-op.

### Stale recovery & the attention tray
The reconciler (`docs/runtime.md`) turns an observed agent death into action.
Two kinds of failure, deliberately kept distinct:

- **Infra failure (auto-recovered, bounded).** An agent that vanishes (herdr
  reports it gone, or it goes stale-and-dead) is auto-recovered: the pane tail is
  captured as `log` evidence, the task is marked `failed`, and a FRESH
  `source="requeue"` task is queued (`parent_task_id` → the failed one). This is
  capped at **2 auto-requeues** per lineage; the third death opens a decision
  card instead (`recovery_card` event). An alive-but-silent agent is nudged up to
  3 times, then also escalates to a card.
- **Terminal failure (human triage).** A task that failed PAST the auto-requeue
  cap, was cancelled/failed for work reasons, or that the director failed
  manually, STAYS `failed`. `failed` is not a board column, so these surface ONLY
  in the web **"needs attention" tray** (failed tasks awaiting triage + live
  tasks whose health is `dead`/`stuck`). The **dispatcher never picks up `failed`
  tasks** (it only spawns `queued`), so nothing auto-runs a task a human hasn't
  re-queued.

Attention-tray actions map to endpoints: **requeue** = `POST /transition
{to:"queued"}` (reactivates the SAME task, clearing `agent_target`/`worktree_path`/`branch`
so the next spawn is clean; writes a `state_change` with the reason), **edit &
requeue** = `PUT /api/tasks/:id` then the same transition, **cancel** = `POST
/transition {to:"cancelled"}` (a `failed` task may be dismissed to `cancelled`).
Unhealthy live rows reuse view-agent / send / requeue. State-machine edges added
for this: `failed → queued` and `failed → cancelled`. The review experience adds
`in_review → in_progress` (the captain requesting changes; see the Review
experience section).

### Static assets
- `GET /evidence/<task_id>/<file>` → the raw evidence file (`404` if missing; path traversal rejected `403`).
- `GET /` and any non-`/api/` path → serves `web/dist` if built (SPA fallback to `index.html`), otherwise `404 "web app not built"` (text/plain).
