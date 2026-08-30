# hive HTTP API — the contract

This is the authoritative contract for the hive daemon. The web app (Phase 2)
must be built against this file. Server: `http://127.0.0.1:4700` (override
`HIVE_PORT`). Loopback is trustless except for config/secret writes (below).

- All request and response bodies are JSON unless noted (evidence upload is
  `multipart/form-data`; the SSE stream is `text/event-stream`; evidence files
  and the static web app are served raw).
- **File attachments.** `POST /api/tasks`, `PUT /api/tasks/:id` and
  `POST /api/tasks/:id/send` accept EITHER JSON or `multipart/form-data`. In the
  multipart form, text fields carry the same names as the JSON keys and any
  number of files may be sent under the field name `files`. See
  [Attachments](#attachments).
- **Auth.** Requests from off-box (a phone on the LAN / Tailscale) must present
  the API token as `Authorization: Bearer <t>` or `?token=<t>` (the SSE stream
  has no headers, hence the query form); `hive remote` prints it. Loopback
  callers need no token EXCEPT on the config- and secret-store writes
  `PUT /api/projects/:id`, `POST /api/projects/:id/secrets` and
  `DELETE /api/projects/:id/secrets/:name`, which require the token from any
  caller and answer `401` without it. Those two stores are where a
  caller-supplied value gets paired with a credential, so they are gated even
  on localhost (`WRITE_AUTH_ROUTES` in `server/src/api.ts` — a future
  config-plus-secret store belongs on that list). The `hive` CLI and the web app
  present the token for you; reads and the whole task flow stay trustless.
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
`config` is a JSON column, but NOT free-form: it is validated at the API
boundary (`POST`/`PUT /api/projects`) against the schema in
`server/src/projectConfig.ts`, which is the authoritative list of accepted keys
and their types. A malformed value or an unrecognised top-level key is a `400`,
because several of these keys become subprocess argv or network destinations
downstream (see `agent_argv` below). Keys used elsewhere:
`default_branch` (string, used as the worktree base + merge target; when omitted it inherits `promote.from`, then falls back to `main`; spawn refreshes and cuts from `origin/<branch>`, and read-only comparisons use that remote-tracking ref rather than a potentially stale local branch),
`deploy_notes` (string),
`monitors` (`[{name, url, expect_status, expect_substring?, interval_s}]`),
`monitors_auto_task` (bool; a monitor failure auto-creates a `chore` task),
`smoke` (`[{name, url, expect_status, expect_substring?}]`, run once on
`verifying`),
`deployments` (object; opts the project into the production release model and
the Deployments tab — see [Deployments](#deployments-production-releases)),
`agent` (`"claude" | "codex"`, default `"claude"`; `"codex"` runs the interactive Codex CLI using the machine's ChatGPT login), `codex_model` / `codex_model_by_kind` (optional Codex model overrides; omitted means the current Codex default), `codex_reasoning_effort` / `codex_reasoning_effort_by_kind` (optional Codex reasoning overrides; defaults are `medium` for ship and `low` for scout/chore), `codex_auto_compact_token_limit` (default `64000`), `codex_tool_output_token_limit` (default `6000`), `processed_token_warn` / `processed_token_cap` (defaults `75000000` / `200000000`), `wait_call_warn` / `wait_call_cap` (defaults `25` / `100`; `0` disables a threshold), `agent_argv` (string[], advanced per-project override of the complete command herdr runs; verbatim and responsible for its own briefing),
`setup_argv` / `cleanup_argv` (string[], a symmetric per-project stack hook pair —
`setup_argv` runs at spawn time once the worktree exists but before the agent
starts, `cleanup_argv` runs before the worktree is removed; relative `argv[0]`
resolves against the project repo path and `{worktree}` substitutes the task's
worktree path, e.g. `["bun","infra/worktree/wt.ts","up","{worktree}"]` /
`[…,"down","{worktree}"]`; both best-effort with a 120s timeout, emitting a
`stack_setup` / `stack_teardown` event — see the Auto-cleanup section),
and `gchat_spaces` (`[{space, label?}]`, the Google Chat intake allowlist —
messages in each `spaces/<id>` become draft tasks in THIS project; see Intake
connectors below), and `intake_keywords` (`string[]`, domains / links / keywords
that mark a braindump as belonging to THIS project — e.g. `["coredata",
"figma.com/file/…"]`. At `POST /api/intake` the raw text is scored against every
project's name, repo basename, and these keywords, and the braindump is re-routed
to the best match when it strictly out-scores the requested project).
`intake_triage` (bool, default `false`; when true, each new ambient intake task
— source `intake_*` or `watch` — is classified by one `claude -p` sonnet call
before it can dispatch. A request with one clear reading is marked reviewed and
proceeds. A request that reads two or more ways opens a decision card asking
which reading to build, and the dispatcher holds the task until you answer. Every
classifier failure falls through to "mechanical", so triage can never wedge
intake. Classification runs in the background, so a slow one never delays the
next message or watcher. The card it raises carries `decision_class:
"intake_triage"`, which every automatic answering path refuses: the standing CI
ruling, the chat supervisor, and the `decision_auto_answer_hours` timeout. Only
you can answer it. Answering appends your chosen option to the task's brief under
a `## Director's answer` heading and marks the task reviewed, so it dispatches on
the next cycle and the agent builds the reading you picked. Braindumps
(`POST /api/intake`, source `intake_braindump`) are exempt: you typed that text
yourself and it already raises a planner breakdown card. Jira import creates only
tracking-only mirrors, which never dispatch, so nothing there is triaged either.)
Domain-supervisor keys (see the Domain supervisors section):
`supervisor_persona` (string, freeform planner identity included in every planner
prompt), `plan_intake` (bool; when true, each new intake task auto-triggers a
planner breakdown), `planner_argv` (string[], the planner command, default
`["claude","-p"]`), and `playbook` (string, freeform project context injected
into planner prompts).
Plan-gate key: `plan_gate` (`{kinds?: string[], block?: boolean,
auto_ack_hours?: number}`, default `{}`). Tasks whose kind is listed in `kinds`
are told in their brief to post a plan checkpoint before their first edit, which
hive then critiques (see the `checkpoint` event). With `block: true` that
checkpoint also parks the agent: the brief tells it to post the plan and end its
turn, and the director's ack sends the steer that releases it.
`auto_ack_hours` (positive number, default off) acks a waiting plan on the
director's behalf once it has waited that long, so away-mode never strands an
agent.
Dispatcher keys (see the Dispatcher section):
`auto_dispatch` (bool, default `false`; when true the dispatcher auto-spawns
agents for this project's queued tasks), `dispatch_kinds` (string[], default
`["ship","scout"]`; which task kinds the dispatcher will auto-spawn — `chore` is
excluded by default), and `max_agents` (number, default `3`; per-project cap on
concurrently-running agents).
Supervisor key: `autonomy_profile` (`"conservative" | "balanced" | "autopilot"`, default `"balanced"`). Conservative leaves every checkpoint and decision to the director. Balanced may acknowledge reversible checkpoints and use only the server's closed safe-decision allow-list. Autopilot may also answer a raiser-recommended low/normal-risk technical choice after the server excludes authority grants and production/shared blast radius. No profile bypasses standing-authority gates.
Worktree stack hooks (symmetric per-project lifecycle commands, both `string[]`,
`{worktree}` substitutes the task's worktree path, relative `argv[0]` resolves
against `repo_path`): `setup_argv` (e.g. `["bun","infra/worktree/wt.ts","up","{worktree}"]`,
run at spawn after the worktree exists but before the agent starts, so agents
don't install deps / bring up their stack themselves; emits a `stack_setup`
event) and `cleanup_argv` (e.g. `[...,"down","{worktree}"]`, run before the
worktree is removed; emits a `stack_teardown` event). Both are best-effort with a
120s timeout — a failed hook never blocks spawn nor cleanup.
Scope-drift keys (see the Scope-drift watch section): `scope_drift` (bool,
default `true`; set `false` to disable the in-run scope check for this project),
`scope_drift_commits` (number, default `3`; how many new commits on a task's
branch trigger the next check) and `model_by_kind.drift` (string, default
`"sonnet"`; the model that judges footprint against brief).
Lifecycle key: `archived` (bool, default absent/`false`; when `true` the project
is hidden from the default `GET /api/projects` list and the web Projects view —
tasks keep referencing it, there is no hard delete).
Lifecycle key: `test` (bool, default absent/`false`; marks a scratch/ephemeral
project — e.g. an agent's own E2E run registered it against the live server
instead of a throwaway instance). Auto-set at `POST /api/projects` time when
`repo_path` lives inside a task's own worktree/scratchpad, unless the caller
already passed `config.test` explicitly. Hides the project (same as
`archived`) and its tasks/decisions/checkpoints from the default
`GET /api/projects` / `/api/tasks` / `/api/decisions` / `/api/checkpoints`
lists — pass `?test=all` to include them — and its tasks never push a
notification. The reaper auto-sets `archived: true` on a `test` project once
every task it owns is terminal.
Worktree stack hooks (symmetric per-project lifecycle commands): `setup_argv`
(string[], run AFTER the worktree exists but BEFORE the agent starts — e.g.
`["bun", "infra/worktree/wt.ts", "up", "{worktree}"]` — so agents don't bring up their
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
  "ci_checked_at": "...",
  "head_sha": "a1b2c3d...",
  "summary": "Shipped dark mode toggle; all tests green.",
  "source": null,
  "parent_task_id": null,
  "resume_branch": null,
  "resume_ghost_branch": null,
  "resume_pr_url": null,
  "depends_on": [],
  "verification_cmds": null,
  "priority": "normal",
  "duplicate_of": null,
  "health": { "status": "healthy", "reason": null, "since": "..." },
  "sidecar": { "sha": "a1b2c3d...", "ok": false, "findings": [{ "tool": "tsc", "summary": "src/a.ts(3,1): error TS2345" }] },
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
`ci_status ∈ {passing, pending, failing, unavailable}`. `unavailable` means every
red check is INFRA-red — GitHub never started the job, the job ran zero steps and
ended in seconds, or the same check is already red on the base branch without
this PR. Infra-red never holds a handoff and is never steered at the agent: the
reconciler opens ONE `chore` task for the signal itself (deduped fleet-wide on a
`ci-signal: <key>` line in its brief) and every PR hitting that signal shares it.
Code-red (anything a commit could plausibly have caused) still steers the PR's
own agent to fix forward, once per pushed head SHA.
`sidecar` is the latest background check on the task's OWN commits
(`server/src/sidecar.ts`): hive runs `tsc --noEmit` and the project's `lint`
script in a working agent's worktree whenever its HEAD moves. `null` until the
first check. It is advisory — the board and review cards show it as a chip, and
a broken build (a `tsc` finding) queues ONE non-blocking FYI steer per commit to
that task's agent. CI on the PR is still the merge gate.
`ci_checked_at` is when hive last LOOKED at the checks — `ci_status` only moves
when the answer moves, so this is the timestamp a decision card cites.
`head_sha` is the PR's current head commit, refreshed by the reconciler's PR
poll alongside `ci_status`; `null` until the first poll after a PR links. The
review card compares it against each evidence item's `meta.commit_sha` to flag
evidence captured against an older commit as stale.
`resume_branch`/`resume_ghost_branch`/`resume_pr_url` are set only on a `source="requeue"` task whose failed predecessor left a branch behind (see `requeueTask`): the branch to adopt, the ghost branch holding any rescued uncommitted WIP, and the predecessor's still-open PR, if any. The same pointers are prepended as a RESUME section at the top of `brief`. When available on the failed predecessor, that section also carries the open PR's last-known head and CI status, answered decisions, and a one-line self-review summary; PRs with a recorded closed or merged event are omitted. `spawnAgent` refuses to dispatch a task with `resume_pr_url` set if that exact URL isn't present in `brief`, so an edited brief can't silently drop the "adopt, don't rebuild" instruction and spawn an agent that opens a second, conflicting PR.
`display_id` is the human-facing project identifier, for example `HIVE-247` or `CORE-82`. Its numeric half is the task's immutable `project_number`, assigned from a per-project sequence and never reused; its prefix is the first four alphanumeric characters of the project name, uppercased. The older global `number` remains unique across Hive for PR-marker and API compatibility; the opaque `id` stays the machine key. Both numbers are assigned by DB triggers so every creation path gets them, and existing rows are backfilled in `created_at` order.
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
`parent_task_id` is null for top-level tasks, or the id of the source task for a derived task such as a planner child, agent follow-up, or requeue.
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
- `evidence` — an evidence item was attached. `payload: {evidence_id, kind, caption, verify_name?}` (`verify_name`: the task `verification_cmds` entry this artifact came from, from `hive emit ... --verify-name <name>`)
- `needs-decision` — a decision card was opened. `payload: {decision_id, title}`
- `decision_answered` — `payload: {decision_id, answer_key, answer_note, answered_by, actor}`; the event `source` is the answerer identity
- `auto_approved` — the chat supervisor cleared a card itself via the auto-approve bar. `payload: {decision_id, answer_key, category, reason, note}`. `source: chat_supervisor`
- `auto_approve_declined` — the auto-approve bar rejected a card; it stays `open` for the director. `payload: {decision_id, answer_key, category, reason}`. `source: chat_supervisor`
- `decision_expired` — a decision was cleared without an answer: dismissed, or auto-expired because its task went terminal. `payload: {decision_id, reason}` (`reason` ∈ `dismissed` | `task cancelled` | `task done` | `task failed` | `task terminal (backfill)`)
- `verification_missing` — the review handoff was refused because the task's `verification_cmds` had no matching evidence. `payload: {names}` (the missing contract entries). Written once per distinct set of missing names, so a polling caller records the gap once.
- `note` — a free note (e.g. a `done` summary). `payload: {note}`
- `steer` — a steer message was dispatched to the agent. Director calls, including broadcasts, may include an optional session label: `payload: {message, target, actor}`.
- `blocked` — agent reported blocked. `payload: {note}`

Transcript events (written by the Claude Code hooks, `source: hook` — these fill
the task timeline with the agent's actual work; see `hooks/install.md`):
- `assistant_text` — a block of the agent's actual output text. `payload: {text}` (rendered as a transcript bubble)
- `tool_use` — the agent invoked a tool. `payload: {tool, summary}` where `summary` is a cheap one-line description (the command for Bash, the file_path for Read/Edit, the pattern for Grep — never the full input). The UI groups consecutive `tool_use` events into one "used N tools" row.
- `agent_turn_end` — a quiet Stop/SubagentStop liveness heartbeat. `payload: {}` (kept for health/reconciler; the timeline hides it)

Types written by the runtime layer (Phase 2b):
- `checkpoint` — a live build-time judgment call from a working agent (`payload: {note}`; `hive emit <id> checkpoint --note "..."`). Non-blocking. Acknowledgment uses `POST /api/tasks/:id/checkpoints/:eventId/ack` body `{verdict: "ok"|"flag", note?, source?: "director"|"chat_supervisor", actor?}` → `200 {ok, delivered, followup_task_id}` | `409 {stale:true, resolution:{source, actor, at, verdict, note}}` when another actor already acknowledged it | `400` | `404`. `checkpoint_ack` events (`payload: {checkpoint_id, verdict, note, actor}`) record the outcome and their event source records who acted. A `flag` steers a live agent immediately; a flag on a finished/agentless task queues a corrective follow-up task instead (`source="checkpoint_flag"`, parent → the flagged task). `GET /api/checkpoints[?project_id=<id>][?test=all]` → `200 {checkpoints: [{id, task_id, ts, task_number, task_title, task_state, project_id, note, blocking?, plan?, concerns?}]}` lists un-acked checkpoints, optionally scoped to one project. They survive task completion (only `cancelled` drops them) so judgment calls stay reviewable after fast agents finish. Checkpoints under a test/ephemeral project (`config.test === true`) are hidden by default; pass `?test=all` to include them.
  A PLAN checkpoint is the same event with structured fields instead of a bare note: `payload: {kind: "plan", goal, approach, files_expected: string[], verification_planned, note}` (`hive emit <id> checkpoint --json plan.json`; `note` defaults to `goal` so it still lists like any other checkpoint). Agents are asked for one before their first edit when the project sets `config.plan_gate.kinds` and the task's kind is in that list. Hive critiques it in the background with one sonnet one-shot (60s cap) and attaches a `plan_critique` event (`payload: {checkpoint_id, concerns: [{severity: "note"|"veto", text}], error?}`). A critic that fails, times out, or returns unparseable output attaches `concerns: []` with `error` and logs — it never blocks the agent. Each `veto` concern also steers the agent, quoting the concern. Ordinary note-only checkpoints are not critiqued.
  A plan checkpoint listed by `GET /api/checkpoints` also carries `plan: {goal, approach, files_expected, verification_planned}` and `concerns` (the critic's verdict, `[]` until the critique lands), so the Needs You card can be approved without opening the task.
  BLOCKING plans (`config.plan_gate.block === true`): the checkpoint payload also carries `blocking: true`, and the brief tells the agent to post the plan and end its turn instead of editing. The `ack` endpoint is what restarts it — `verdict: "ok"` steers "Your plan is APPROVED …", `verdict: "flag"` steers "Your plan was FLAGGED …" and asks for a corrected plan. A flag on a blocking plan always steers (queued if no agent is live) rather than queueing a corrective follow-up task, because nothing has shipped yet. With `config.plan_gate.auto_ack_hours` set, a reconciler step (`autoAckPlans`) acks any blocking plan that has waited that long, writing `checkpoint_ack` with `source: "hive"`, `actor: "auto_ack"`, `auto: true` and sending the same release steer.
- `review_summary`: the agent's structured self-review, submitted before `ready`. `payload: {done?: string[], iffy?: (string|{what,why})[], decisions?: string[], testing?: string[], followups?: string[], understanding?: {background?: string, essence?: string, walkthrough?: string[], participate?: string, check?: {question: string, options: {key: string, label: string}[], answer_key: string, explanation?: string}}}`. Judgment-class changes require a 2-4 option understanding check (see the understanding gate below); mechanical ones may omit `understanding.checks` entirely. The review card presents the mental model before the technical audit, then uses the check as the approval gate. Questions must teach the director about the specific change or report and may not test agent procedures, debugging, merging, tools, or policy.
- `understanding_quiz_attempt`, `understanding_quiz_passed`, `understanding_quiz_deferred`: director-only quiz outcomes tied to the latest `review_summary` by `payload.review_event_id`. Their payload includes the optional director `actor`. A new review summary creates a new check. Passing removes it from the backlog. Deferring unlocks an urgent merge but deliberately leaves the quiz open after the task finishes. `understanding_quiz_deferred` is also written with `source: "system"` when a merge auto-defers a required check for a task kind listed in the project's `config.auto_merge.kinds`.

Understanding quiz API:

- `GET /api/understanding-quizzes[?project_id=<id>]` returns `{quizzes}` for required and deferred checks on each task's latest review. Each quiz includes an opaque, review-specific `version` for stale-read detection. Correct answers and explanations are omitted.
- `POST /api/tasks/:id/understanding-quiz/answer` body `{answer_key, version?, source: "director", actor?}` returns `{ok, correct, explanation}`. Incorrect answers remain blocked and do not reveal the correct option. When `version` is stale, it returns `409 {stale:true, resolution:{source, actor, at, answer_key, answer_label, correct}}` instead of applying the old answer to the next question. Omitting `version` preserves the legacy behavior.
- `POST /api/tasks/:id/understanding-quiz/defer` body `{confirm: "quiz_later", source: "director"}` is the explicit urgent escape hatch. It is accepted only while the task is in review.
- `POST /api/tasks/:id/understanding-quiz/require` body `{source: "director", actor?}` flags a task as judgment-class, so its checks are required even when everything else about it looks mechanical. It writes one `understanding_required` event and is idempotent.
- `spawned` — a herdr agent was started. `payload: {agent_target, branch, worktree_path, tab_id, label, fleet_workspace_id}`
- `spawn_error` — spawn failed. `payload: {error, infra?}`. `infra: "herdr_unreachable"` marks a herdr-daemon-down failure (`ConnectionRefused` / `Os { code: 61 }`) rather than a task-specific fault; the dispatcher excludes these from a task's per-task backoff and handles them with a global circuit breaker instead (see `docs/runtime.md`)
- `stack_setup` — the per-project spawn hook (`config.setup_argv`) ran while preparing the worktree, before the agent started (`source: herdr`). `payload: {argv, ok, error?}` (`error` = first 300 chars of stderr/stdout on failure; best-effort, a failure never blocks the spawn).
- `stack_teardown` — the per-project teardown hook (`config.cleanup_argv`) ran before the worktree was removed (`source: reaper`). `payload: {argv, ok, error?}` (best-effort, a failure never blocks worktree/session cleanup). Both share `runStackCmd` (`server/src/cleanup.ts`).
- `agent_status` — herdr agent status changed (via wait loop or reconciler). `payload: {status}` (`idle|done|working|blocked|gone`; `done` means the interactive turn completed, while `gone` means the reconciler's probe found the agent missing from herdr)
- `focus_agent` — the director focused the agent's herdr tab ("view agent"). `payload: {target}`
- `recovery` — a stale-recovery decision was taken. `payload: {decision:"dead"|"silent-escalate", attempts?|nudges?}`
- `recovery_nudge` — a status nudge was sent to an alive-but-silent agent. `payload: {nudge, delivered}`
- `queued_input_recovered` — a queued-input recovery attempt. `payload: {delivered: boolean|null, excerpt}` (`null` while the pane write is pending). See "Blocked agents (dialog handling)" for the recovery and retry contract.
- `requeued` — a failed task was auto-requeued as a fresh task. `payload: {new_task_id, attempt?}`
- `recovery_card` — a recovery escalation opened a decision card. `payload: {decision_id, source_task_id, scout_task_id?, scout_report_url?}`
- `scout_spawned` — a park after at least one requeue filed the lineage's one root-cause scout. Always written on the ORIGINAL task of the lineage, which is what makes it the "exactly one, ever" guard. `payload: {scout_task_id, parked_task_id, failed_task_ids}`
- `ci_status` — reconciler synced CI. `payload: {ci_status}` (`passing|pending|failing|unavailable`)
- `ci_infra` — the red checks on this PR are all infra-red, not the diff. `payload: {signal, checks: [{name, infra}], head_sha}`. One event per (head, signal); the signal keys the shared diagnostic task and the director's one ruling.
- `pr_merged` — reconciler detected the PR merged. `payload: {pr_url}`
- `pr_conflict` — reconciler saw the PR CONFLICTING with its base and nudged the agent to resolve (once per head SHA; lifecycle untouched). `payload: {pr_url, head_sha, delivered}`
- `ready_for_review` — records an `in_progress → in_review` handoff. `payload: {pr_url, via, kind}` (`via ∈ {emit, idle, done, gone}`). See "Review experience" for the explicit and automatic handoff contracts.
- `pr_linked` — a marked PR was matched back to this task and its `pr_url` set (by the reconciler's scan or `POST /api/tasks/link-pr`). `payload: {pr_url, via}` (`via ∈ {id, number}` — which half of the marker matched)
- `pr_synchronized` — the reconciler observed the PR head SHA change (hive's stand-in for GitHub's synchronize webhook). `payload: {head_sha}`. Emitted only when the head differs from the prior `pr_synchronized` (the first observation is a baseline). Used to tell "the agent pushed a fix" from "CI is still green on the same old head" — by the re-queue guard after a `changes_requested`, and by `health` to decide whether a re-handoff clears a `merge_failed` reason.
- `stale` — task silent beyond the threshold. `payload: {silent_ms, threshold_ms}`
- `deferred` — task parked pending an offline human action; `deferred_until` set (nudges suppressed while future-dated). `payload: {until, note}`
- `undeferred` — a deferred task was resumed; `deferred_until` cleared. `payload: {note}`
- `taken_over` — the director took the worktree over by hand; the agent was stopped and its slot freed. `payload: {worktree_path, branch, base, agent_stopped}`
- `handed_back` — the worktree was handed back; a steer summarising the director's changes is queued for the next agent. `payload: {branch, base, summary, note}`
- `steer_error` — `herdr agent send` failed. `payload: {error}`
- `smoke_passed` / `smoke_failed` — post-deploy smoke result. `payload: {results:[{name,ok,detail}], evidence_id?}`
- `cleaned_up` — a finished task's runtime was torn down: worktree removed (when its branch was pushed/merged) and herdr session (tab/pane) closed. `payload: {worktree_path, branch, worktree_removed, ghost_branch, session_closed, session_via, tab_id}` (`ghost_branch` non-null when tracked uncommitted work was preserved before removal). Fired on the `done`/`cancelled` transition and by the reaper.
- `cleanup_skipped` — teardown was refused because the branch is neither pushed nor merged; the worktree and its session are left fully intact so no unmerged work is lost. `payload: {reason, worktree_path, branch}`
- `stack_setup` / `stack_teardown` — a per-project worktree stack hook ran (`config.setup_argv` at spawn, `source: herdr`; `config.cleanup_argv` at teardown, `source: reaper`). `payload: {argv, ok, error?}` (`error` is the trimmed stderr/stdout on failure or a timeout note).

Review events (normally written by the director path with `source: director`):
- `merged` — an in-review task was approved & merged. `payload: {method, base, branch, pr_url}`
- `merge_failed` — a merge attempt failed (conflict / not a fast-forward / gh refused). `payload: {reason, conflict, delivered, send_error?}` — `conflict` = the reason looks like the agent's to fix, which bounces the task back to `in_progress` with rebase instructions (a best-effort send; `delivered` records whether it landed, `send_error` the failure). A non-conflict failure leaves the task `in_review` with `delivered: false`.
- `changes_requested` — follow-up work was requested; the task returns to `in_progress`. This is written either when the captain requests changes or, with `source: system`, when a queued steer reaches an `in_review` task. `payload: {notes, delivered, head_sha, delivery_via?}` (`head_sha` = the PR head at request time, read from the latest `pr_synchronized`; the baseline the re-queue guard compares against, `null` when no `pr_synchronized` existed yet; `delivery_via` is `drain` or `respawn` on the queued-steer path)

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
- `dispatch_hold_overlap` — the dispatcher held a queued task because its predicted file scope overlaps a task already running, and started a non-overlapping task instead. `payload: {note, held_by, held_by_number, files}`. Deduped on the note: the dispatcher runs every 30s and must not write one per cycle. This is ORDERING only, never a block.
- `dispatch_overlap_override` — a held task was started anyway because nothing else in the project was dispatchable. `payload: {note}`. An idle fleet is worse than a predicted conflict.
- `dispatch_scope` — the file scope guessed for a task when it was dispatched, from paths named in its brief and (for a requeue) the files its predecessor's branch touched. `payload: {files, dirs, from}` (`from`: `["brief", "predecessor"]`). Written by the dispatcher only when the guess is non-empty.
- `scope_prediction_scored` — once the branch exists, the dispatch-time guess is compared with what it really touched, so the heuristic can be tuned or dropped on evidence. Written once per task by the reconciler. `payload: {note, predicted, hits, actual_count, precision, recall, from}`
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
  "path": "/Users/you/.hive/evidence/9da7c5527580/1720440000_shot.png",
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
    "pr_url": "https://github.com/example-org/example-repo/pull/42",
    "branch": "hive/rich-cards",
    "spend_usd": 3.2,
    "ci": {
      "at_card": "unavailable",
      "status": "unavailable",
      "checked_at": "...",
      "changed": false,
      "outage": { "signal": "parity,syntax:no-steps", "fix_task_number": 1261 }
    },
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
cards leave the inbox and can no longer be answered. `answered_by` names who
resolved the card and is never null once it leaves `open`: the caller identity on
answer (`director|chat_supervisor|agent|system|unknown`), `director` or
`reconciler` on a dismissal, `system` on a task-terminal expiry, and
`unattributed` on the 414 legacy rows resolved before hive recorded answerers at
all (everything before 2026-07-22). `answered_actor` is an optional free label.

**A high-risk card is only ever answered by the director.** `POST
/api/decisions/:id/answer` returns `403 {"effect":"escalate","category":"risk_high"}`
for any other `source`, including a bare call with no `source` (which is
`unknown`, not the director). The one exception is a `deny` on a pending
standing-authority grant: refusing an unexecuted command is fail-closed and stops
the work rather than releasing it. The timeout sweep
(`decision_auto_answer_hours`) never answers a high-risk card either; past the
window it writes one `decision_escalated` event and raises one urgent
notification, and the card stays open. Risk is matched on the leading level word,
so a `risk` field that reads `"high — leaked prod key"` counts as high, and free
prose with no level word at all is treated as high rather than auto-answerable.

`bundle` is server-**derived** (never stored) context attached to each card as
it's returned, so the director can decide in one pass without opening the task:
the affected `pr_url`/`branch`, task `spend_usd` so far, and `prior_decisions` —
the last 3 answered cards on the same project, each with the option `label` the
director chose. Computed at fetch/broadcast time so it stays fresh; absent on
older SSE payloads and terminal-card broadcasts.

`bundle.ci` is present only on a card raised on a task whose checks are actually
red or unavailable AND whose own title or context is about those checks — the
words alone are not enough, since "red", "green" and "check" are ordinary
English. It is what keeps such a card honest: `at_card` is the CI status when
the card was written, `status` and `checked_at` are the live re-check, and
`changed` says the two disagree. When the checks turn green under a card that
cited red, the reconciler closes the card itself (`status=expired`, reason
`ci_signal_changed`) and tells the agent — a moot question is never shown.
`outage` is non-null when the card was blocked by an infra outage, naming the
signal and the task hive dispatched to fix it. Answering ONE such card settles
it: a later card blocked by the same signal on the same project is auto-answered
with that ruling (`answered_by: "system"`, actor `ci-outage-ruling`) and raises
no notification, provided the earlier answer's key is one of its own options.
The ruling holds only while the outage does: once the diagnostic task hive
dispatched for that signal is closed, the next card asks the director again.

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
- `failure`: the regression ledger. Briefs carry only the active count; `hive recall <keywords>` retrieves matching bodies.
- `reference`: durable facts retrieved on demand with `hive recall`; briefs carry only the count.
- `decision` — the answer to a resolved decision card, written back automatically
  when the director answers a card no resolver claimed (a genuine
  product/preference question), deduped by `(project_id, title)` so re-asking the
  same question bumps `occurrences` and refreshes the answer. Briefs carry only the active count and direct the crew to `hive recall`, so prior rulings are retrieved without replaying the full store on every task.

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
`kind ∈ {decision, review, done, failed, incident, stale, intake, planned, test}`. `urgency ∈ {normal, urgent}`.
(`intake` is a new Google-Chat draft task; `planned` is an approved planner
breakdown — both always `normal`, batched into the digest. `review` is a task
handed to the director for approval, always `urgent`.)
`task_id` / `decision_id` may be null. `delivered_at` is set once the director has been
made aware — for an urgent notification that means the desktop app reported that
macOS actually rendered it (`POST /api/notifications/:id/shown`), NOT that the
server tried to send it; normal ones are batched into a single digest every
`HIVE_DIGEST_MS` (default 30m), or marked when the header bell is opened
(`POST /api/notifications/ack`). The bell's unread count is the rows where
`delivered_at` is null. A `task_id`'d notification whose task belongs to a
test/ephemeral project (`config.test === true`) is never created at all — no
row, no push, no digest entry, no bell count. Unlike the list endpoints above,
there is no override for this; see the `test` lifecycle key above.

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
priced rows only). `total_tokens` is a compatibility field meaning **processed
tokens**: fresh input + cached input + cache writes + output. The web labels it
that way and shows those components separately; it is not a billable-token
estimate. Every usage ingest also checks processed-token guardrails, and every
recorded `wait`/`wait_agent` tool call checks wait-call guardrails. Warnings steer
once; caps park an in-progress task behind a wrap-up-or-continue decision. A
`continue` answer doubles that task's effective cap.

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
- `GET /api/projects[?archived=all][?test=all]` → `200 [Project, ...]` (oldest first)
  Archived projects (`config.archived === true`) are hidden by default; pass
  `?archived=all` to include them. There is no project delete (tasks reference
  projects) — set `config.archived: true` to hide one and back to `false`/absent
  to restore it. Test/ephemeral projects (`config.test === true`, see the
  `test` lifecycle key above) are hidden the same way; pass `?test=all` to
  include them.
- `POST /api/projects` body `{name (required), repo_path?, config?}` → `201 Project`
  Auto-sets `config.test = true` when `repo_path` lives inside a task's own
  worktree/scratchpad, unless `config.test` was passed explicitly.
- `GET /api/projects/:id` → `200 Project` | `404`
- `PUT /api/projects/:id` body `{name?, repo_path?, config?}` → `200 Project` | `404` | `401` without the API token (see Auth)
  Updates mutable fields. `config` is REPLACED wholesale when present (read the
  project, edit keys like `auto_dispatch`, write the object back). Used by the
  Policies-page auto-dispatch toggle.

### Deployments (production releases)

The one-branch deploy model: merging into the project's integration branch
deploys staging, and production is a GitHub workflow the director runs by hand.
That workflow stamps an immutable tag `prod-YYYY-MM-DD-<short sha>`, so the
NEWEST such tag is what is live. There is no branch that means "production".

Opt-in per project through `config.deployments`. Without that key these routes
404 and the project does not appear on the Deployments tab. Every field is
optional:

| Key | Default | Meaning |
|---|---|---|
| `deploy_workflow` | `prod-deploy.yml` | Workflow dispatched to deploy |
| `rollback_workflow` | `prod-rollback.yml` | Workflow dispatched to roll back |
| `tag_prefix` | `prod-` | Release tags are read and validated against this |
| `workflow_ref` | the project's integration branch | Ref the workflow file is read from |
| `health_url` | none | Probed on each read (same checker as `config.monitors`) |
| `health_substring` | none | Required in the health response body |
| `flags` | `[]` | Feature-flag keys to show, in order |
| `posthog_project` | none | With a `POSTHOG_API_KEY` secret, resolves live flag states |
| `posthog_host` | `https://us.posthog.com` | PostHog API base |
| `history` | `15` | Releases listed |

- `GET /api/projects/:id/deployments` → `200 DeploymentsStatus` | `404` when the project or its `deployments` config is missing
  `{branch, head:{sha,short,subject}|null, current:Release|null, releases:[Release], ahead:number|null, health:{ok,detail,url}|null, flags:{available,reason,items:[{key,name,active,rollout}]}, runs:[WorkflowRun], errors:[string]}`.
  `Release` is `{tag, sha, short, subject, created_at, current}`, where `sha` is
  the release tag's DEREFERENCED commit (the workflow writes annotated tags).
  `ahead` counts commits on `branch` that production does not have. A section
  that could not be read degrades to null/`[]` and appends to `errors` rather
  than failing the whole response.
- `POST /api/projects/:id/deployments/deploy` body `{commit?}` → `200 {ok, workflow, ref}` | `400` | `401` without the API token | `502` when `gh` refuses
  Blank `commit` means the workflow's own default (the current head of the
  branch). Anything that is not a commit SHA → `400`.
- `POST /api/projects/:id/deployments/rollback` body `{tag?}` → `200 {ok, workflow, ref}` | `400` | `401` without the API token | `502` when `gh` refuses
  Blank `tag` means the workflow's own default (the release before the current
  one). A tag outside `tag_prefix` → `400`, so production can never be pointed
  at a commit that was never live.

Both writes are token-gated (see Auth). Hive has no user accounts, so the API
token IS the super-admin check: it is read out of hive's own DB, which an
agent's HTTP socket cannot reach. The GitHub credential stays server-side —
hive shells out to `gh`, and the browser only ever names a commit or a tag.

### Tasks
- `GET /api/tasks?state=&project_id=&test=&compact=` → `200 [Task + {evidence_count, spawn_error, overlap_hold, needs_you_since}, ...]` (newest `updated_at` first; all filters optional). `needs_you_since` is the latest entry into `in_review` or `failed`, and stays fixed when CI or metadata updates the task. `overlap_hold` is `{number, files}` when a queued task is waiting because the dispatcher thinks it edits the same files as a task that is still running, and `null` otherwise (including once that task finishes). `compact=1` omits task briefs and empty/default properties for list/bootstrap clients, and is gzip-compressed when accepted; fetch `GET /api/tasks/:id` when full task data is needed. Tasks under a test/ephemeral project (`config.test === true`) are hidden by default; pass `?test=all` to include them.
- `POST /api/tasks` body `{project_id (required), title (required), brief?, kind?, agent_target?, source?, parent_task_id?, depends_on?, verification_cmds?, priority?}` → `201 Task` (starts in `queued`, assigned the next `number`, writes a `created` event). `depends_on` is a list of task ids this task waits on (also accepts a comma-separated string; CLI: `hive task create --depends-on <id,id>`); each id is validated to exist (unknown id → `400`). The dispatcher and reconciler won't advance the task until every dependency is merged/done (`verifying`/`done`), writing a deduped `dependency_blocked` event with the visible reason. `source`/`parent_task_id` let a spawned agent file follow-up tasks attributed to it (`source="agent"`, parent → the spawning task; the CLI sets both automatically when `HIVE_TASK_ID` is in env). Unknown `parent_task_id` → `400`. `source="external"` marks a TRACKING-ONLY task: another agent using hive as its kanban. It is never auto-dispatched or staleness-supervised, is exempt from the done-evidence gate, and moves freely via transitions (`hive task move <id> <state>`). The `--track` CLI flag that used to set it is retired (it only ever produced tasks nobody could dispatch); the Jira mirror path still sets it. To park a normal task, defer it: `hive emit <id> deferred` keeps it out of the dispatcher until `hive emit <id> undefer`. The board keeps these tasks in its separate Tracked view with the external state visible. Jira-keyed Hive work is grouped beneath the matching tracked card, with requeue chains collapsed to their latest attempt. `verification_cmds` is the task's verification contract: an array of `{name, cmd}` the agent must run before handing off (`name`: 1-32 chars of `a-z0-9-`, unique within the task; `cmd`: a non-empty string). Anything else → `400`. The agent brief renders it as a "Verification contract" section, and `hive emit <id> evidence --verify-name <name>` tags an artifact with the entry it came from (stored as `verify_name` on the `evidence` event). The contract is enforced at the review handoff: `in_progress` -> `in_review` is refused with `409` until every named command has a matching evidence event, and the refusal lists exactly the missing names (see the `verification_missing` event). `priority` is one of `now`, `next`, `normal`, `later`; anything else → `400`, and a non-director `source` asking for `now` → `403`. Omit it and the task inherits its parent's priority, or starts at `next` when the title/brief reads as security work, else `normal`. It is ORDERING only, never preemption — see [Priority](#priority) for the full inheritance and authority rules. Also accepts multipart (same fields + `files`); attachments are stored under the new task's id and their absolute paths appended to the `brief`.
- `GET /api/tasks/:id` → `200 Task + {events:[Event], evidence:[Evidence], decisions:[Decision]}` | `404`
  (i.e. the full task object plus three arrays for the task page)
- `POST /api/tasks/:id/jira/link` body `{parent_key (required)}` → `201 {jira_key, browse_url, warnings}` | `400` | `404`
  Creates a Jira sub-task for a Hive-native task, then stores `jira_key` with
  `jira_link_kind: "subtask"`. The summary is `<display_id> · <title>`. The
  description and issue property carry `hive-task: <id>`, and Jira remote links
  point to the Hive task and its PR when present. This requires Jira writes plus
  the default-off `config.jira.write_scope.create_subtask` permission. External
  mirror tasks cannot use this route. CLI: `hive jira link <task-id> --parent WEB-7`.
- `GET /api/tasks/:id/jira` → `200` sync state | `404`
  Returns the linked Jira key, browse URL, write scope, delivery state, and any
  native sub-tasks linked beneath a mirror. A sync cycle discovers an empty
  `jira_key` from a Jira `hive-task: <id>` description marker or `hive.task_id`
  issue property. No Jira custom field or site-admin setup is required. Linked
  native task states push as `queued → To Do`, `in_progress → In Progress`,
  `in_review` or `verifying → In Review`, and `done` or `cancelled → Done`.
  Cancellation also posts a comment. When
  `config.jira.status_notes_to_comments` is true, status notes emitted with
  `hive emit <id> status` use the same at-most-once comment ledger as mirrors.
  The setting defaults to false.
- `POST /api/tasks/:id/jira/sync` body `{}` → `200` sync result | `404`
  Runs the same project Jira cycle used by the scheduler.
- `POST /api/tasks/:id/transition` body `{to (required), reason?, source?}` → `200 Task` | `409` (invalid transition or `done` without evidence) | `404`
  When `to` is `verifying`, the project's post-deploy smoke list (`config.smoke`) runs once before the response returns. A smoke failure bounces the task back to `in_progress`, so the returned Task may be `in_progress`, not `verifying`.
- `POST /api/tasks/:id/spawn` body `{hive_url?}` → `200 {"ok":true, "task": Task, "agent_target":"..."}` | `400` (project has no `repo_path`) | `404` | `502` (dispatch refused or herdr spawn failed; a `spawn_error` event is recorded)
  Creates the herdr worktree (`hive/<task-id>`), starts the agent with `HIVE_TASK_ID`/`HIVE_URL` + the project's resolved secrets in env and the composed brief, sets `agent_target`/`worktree_path`/`branch`, transitions `queued → in_progress`, and writes a `spawned` event.
- `POST /api/tasks/:id/send` body `{message (required), from_task_id?, actor?}` (or multipart: `message` + `files` + `from_task_id?` + `actor?`) → `200 {"ok", "delivered", "delivery", "message", "attachments":[abs paths], "error"?}` | `404` | `400` (empty message, unknown sender, cross-project teammate, or a `source="external"` tracking-only task that isn't Jira-linked AND has never been spawned even once — nothing has ever been, or automatically will be, dispatched to read it. An external task that WAS spawned before is unaffected and delivers normally)
  Dispatches the message to the task's live agent via `herdr agent send`, and always records one `steer` event (`payload: {message, target, attachments, delivery, ...}`) carrying a **delivery receipt**. Attached files are saved and their absolute paths appended to the delivered message under an `## Attachments` heading; because the paths live in the stored `message`, they ride along when a queued steer is redelivered. `delivery` is one of:
  When `from_task_id` is present (the CLI supplies `$HIVE_TASK_ID` for `hive task send`), the sender must exist in the same project. The delivered text names the teammate task and includes an exact reply command; the event is attributed to `source:"agent"` with `from_task_id`, `from_task_number`, and the unwrapped `original_message` for UI display. Peer messages under a managed chat ancestry also wake the owning supervisor, except for messages the supervisor itself sent.
  - `delivered` — herdr accepted it **and** the agent's pane took the submitting Enter (payload also gets `delivered_at`). Two silent drops count as failures, not deliveries: a send that exits 0 with an `{"error":{"code":"agent_not_found"}}` body, and a pane-less agent, whose composer would hold the text unsubmitted.
  - `queued` — no `agent_target`, or herdr refused it twice (one automatic retry). The steer is **not dropped**; it is redelivered by whichever of these comes first, and the event's payload then flips to `delivered` with a `delivered_via` recording how:
    - `delivered_via:"drain"` — the reconciler, on any cycle, finds a queued steer on a task whose agent still has an active turn and re-sends it. This covers the common case of a herdr socket blip while the agent is alive and working: no respawn is coming, so waiting for one would strand the message until the task ended. Delivery is re-attempted every cycle until it lands; a dead agent or a completed (`done`) turn is skipped, and a partial drain stops at the first failure so the remainder stay queued **in order**.
    - `delivered_via:"respawn"` — the next `POST /spawn` or automatic dispatcher reattach of the task prepends every still-queued steer to the agent's brief under "## Steers waiting for you". When a steer reaches a completed (`done`) turn, hive queues it, releases that terminal session, and reattaches a fresh turn to the same task, branch, and worktree.

    When either path delivers queued work to an `in_review` task, hive records `changes_requested` and resumes it in `in_progress` before it can merge.
  - `failed` — the task is terminal, so no spawn will ever carry it.

  Never throws. A herdr failure additionally records a `steer_error` event. The timeline renders the receipt (`✓` / `⏳ queued` / `⚠ undelivered`) so a steer never has to be re-sent blind. Besides the respawn drain, the reconciler re-attempts every queued steer each cycle against any agent with an active turn (receipt flips with `delivered_via:"drain"`); a successful drain writes no event of its own — the receipt flip is the record, and a fresh event would reset the task's silence clock and mask a mute agent from `stale` detection.
- `PUT /api/tasks/:id` body `{title?, brief?, depends_on?, verification_cmds?, priority?, source?}` (or multipart: same fields + `files`) → `200 Task` | `404` | `400` (unknown/self-referencing `depends_on` id, an invalid `verification_cmds`, or an invalid `priority`) | `403` (a non-director `source` setting `priority: "now"` — see [Priority](#priority))
  Attached files are appended to the resulting `brief` under an `## Attachments` heading.
  Updates a task's editable fields. Used by the attention tray's "edit & requeue"
  flow before it re-queues a failed task, and by `hive task update <id> --depends-on <id,id>` —
  the way an agent declares a dependency it discovers mid-task (`depends_on` is
  otherwise only settable at creation, see `POST /api/tasks` above). Omit
  `depends_on` to leave it alone; when sent, it's a full replace (same
  validation as creation: each id must exist, and a task may not depend on
  itself), so pass every id the task should still wait on, not just the new one.
  `verification_cmds` is full-replace the same way: omit it to leave it alone,
  send `[]` or `null` to clear it. `priority` is a plain scalar: omit it to leave
  it alone, send one of `now`/`next`/`normal`/`later` to change it. A rejected
  value changes nothing.
- `POST /api/tasks/:id/focus-agent` body `{}` → `200 {"ok":true, "focused":true, "target":"..."}` | `404`
  The board's "view agent" affordance: focuses the task's herdr tab via
  `herdr agent focus` so the director can watch/attach. Records a `focus_agent` event.
  Degrades gracefully (never throws): `200 {"ok":false, "focused":false, "error":"..."}`
  when the task has no agent or herdr fails.
- `POST /api/tasks/:id/takeover` body `{}` → `200 {"ok":true, "worktree_path":"...", "branch":"...", "base":"<sha>", "agent_stopped":true}` | `404` | `409`
  The director takes the worktree over by hand. Stops the agent (the same
  close-the-session sequence cleanup uses), clears `agent_target` — which is what
  frees the project's agent slot, since every dispatcher capacity count keys on
  it — and parks the task by setting `deferred_until` far into the future, so the
  dispatcher and the "gone quiet" nudges leave it alone. No state hop: an
  `in_progress` task stays `in_progress`. `parked_for_director` is the timestamp,
  and `takeover_base` is a `git stash create` commit capturing the tree at that
  moment (a dangling object; it never touches the shared stash stack), which is
  what lets hand-back report the director's edits alone rather than whatever the
  agent had left uncommitted. Writes a `taken_over` event. `409` when the task is
  terminal, has no worktree, is not a hive worker task, or is already taken over.
  While parked, `spawnAgent` refuses — two writers on one checkout is the thing
  this endpoint exists to prevent.
- `POST /api/tasks/:id/handback` body `{note?}` → `200 {"ok":true, "steer_queued":true, "summary":"...", "branch":"..."}` | `404` | `409`
  Hands the worktree back. Queues ONE steer describing what changed while the
  task was parked (new commits, `git diff --stat` against `takeover_base`, and
  untracked files that were not already there at take-over, each capped at 40
  lines), plus the optional `note`, then clears
  `parked_for_director` and lifts the park. The park is lifted only when
  `deferred_until` still holds the take-over sentinel, so a deferral the director
  set separately survives. Nothing respawns here: the dispatcher's existing
  reattach pass sees a live task with no agent and queued steers and puts a fresh
  agent on the SAME branch with those steers at the top of its brief. `summary` is
  `null` when git could not be read (the steer then tells the agent to check git
  itself) and `""` when nothing changed. Writes a `handed_back` event.
- `POST /api/tasks/:id/requeue` body `{}` → `200 {"ok":true, "new_task_id":"..."}` | `404`
  The recovery banner's manual "fail + requeue": reclaims a still-live task's worktree, fails it, then creates a FRESH queued copy (`source="requeue"`, `parent_task_id` → the original) with the [Task resume context](#task) whenever the original left a branch. Reclaim matches dead-agent and context-full auto-requeue: uncommitted state is preserved to a `ghost-<task-id>` branch and recorded as a `worktree_reclaimed` event. Distinct from the attention tray's in-place requeue of an already-failed task (`POST /transition {to:"queued"}`, which reactivates the SAME task and clears its runtime binding).
  A `source="requeue"` row is only ever trusted lineage once its `created`
  event (the one this endpoint, and every other auto-requeue path, writes) is
  verified against `parent_task_id`. Startup and every reconciler cycle run
  an indexed sweep (`requeue_provenance_verified`) that quarantines any row
  it can't verify — a hand-inserted or otherwise provenance-less row flips to
  `source="requeue_quarantined"` and loses its `parent_task_id` — so nothing
  downstream ever follows an untrusted parent chain. A verified row is never
  rechecked, so the sweep never scans every historical `requeue` task.
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
  (task description + compact lifecycle contract + standing-authority section + counts for active policies, references, decisions, and failure patterns; matching bodies are retrieved with `hive recall`)
- `POST /api/tasks/:id/guarded-action` body `{action (required), target (required), detail?, summary?}` → see below | `404` | `400`
  The gate agents call BEFORE any externally-risky operation they run themselves
  (prod deploy, feature-flag flip, destructive op). The server evaluates the
  standing-authority rules for the task's project:

  `summary` is the caller's one-line stated intent. When a new approval card would be required for a `command.*` action, a missing, null, empty, or whitespace-only `summary` returns `403 deny` with retry guidance and creates no card.

  - `allow` → `200 {"ok":true, "effect":"allow"}` + an `authority_logged` event. Proceed.
  - `deny` → `403 {"ok":false, "effect":"deny", "error":"..."}`. Stop. Denials from a standing-authority rule also write an `authority_denied` event.
  - `require_decision` → `409 {"ok":false, "effect":"require_decision", "decision_id":"..."}`.
    A decision card is opened naming the EXACT target (risk `high`, options
    `approve`/`deny`, plus `approve_always` for `command.*`) and the task is parked
    in `needs_decision`. The agent waits,
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

### Review experience (Hive-owned in-review tasks)
An `in_review` task owned by Hive means the agent finished and opened a PR (or pushed/created a branch) and is **awaiting the captain's review & merge**: not busy work. The captain reviews the diff and approves/merges, requests changes, or rejects, entirely from hive (the task page, the `/review` queue, and the Needs you view all render the same review card). Tracking-only external and Jira-linked tasks may also mirror an external `in_review` state, but they are excluded from Hive review queues, diffs, PR/CI controls, and review actions.

**How a task reaches `in_review` (the finished-handoff, `in_progress → in_review`):**
- **Explicit signal (preferred):** the agent emits `ready` (`POST .../events` `{type:"ready", pr_url?}`, i.e. `hive emit <id> ready --pr-url <url>`) once its PR is open (or, for a scout, its report is written). Records or replaces `pr_url` when supplied, clearing the prior PR's `ci_status` and `head_sha` on replacement, then advances the task. Idempotent: a duplicate `ready` on an already-advanced task just acks (`200`). Writes a `ready_for_review` event.
- **Automatic idle/done/gone handoff (safety net):** the herdr supervise loop and the reconciler's per-cycle poll both route an `in_progress` task whose agent is **idle, done, or gone** (NOT `working`/`blocked` — an agent that opened a PR and kept working still reports `working`) and that has a real work product (a `pr_url`, or a scout `report` evidence) through the same auto-advance to `in_review` (`ready_for_review` event, `via: idle|done|gone`). Advancing on a completed or idle read is safe because mid-work reads `working`; after a queued-input recovery attempt, however, automatic handoff waits at least two minutes so the recovered turn can start (`delivered: null` also holds handoff until the pane write resolves). The reconciler checks this before stale recovery, so a handed-off task with a gone agent is moved to review rather than failed/requeued. This unsticks finished tasks regardless of whether the agent emitted `ready`.
- **Finished with NO PR:** an `in_progress` task whose agent went idle or completed with no PR and
  no recent activity is not auto-advanced (nothing to review) but is made VISIBLE:
  its `health` becomes `stuck` (reason `finished or stuck: agent <idle|done>, no PR`), which
  surfaces it in the attention tray for the director instead of sitting silently.

**Changes-requested re-queue guard:** once follow-up work is delivered, whether
through the captain's request-changes action or a queued steer, the task
must NOT bounce straight back into review until the agent has actually acted. Both
auto-advance paths (the reconciler's CI-green poll / link-pr handoff and the idle
backstop) skip a task whose latest `changes_requested` is still unaddressed. "Addressed"
is a UNION signal recorded after the request: a pushed commit (a `pr_synchronized` on a
DIFFERENT head than the one stamped into the `changes_requested`), fresh evidence, or a
fresh `review_summary`. Any one clears the block; commit-only would strand an
evidence-only request (the director said "there are no evidences") forever. The agent's
explicit `ready` emit is intentionally NOT guarded — it can legitimately race ahead of
the reconciler recording `pr_synchronized`.

**Queued-work auto-merge guard:** the opt-in auto-merge pass does not merge while
a steer is still queued or a queued-input recovery is pending. It rechecks the
task state, passing CI, queued work, recovery state, and changes-request history
immediately before each GitHub merge, local merge, or local ref update, so work
that arrives during earlier merge checks still prevents the mutation.

- `GET /api/tasks/:id/diff` → `200 DiffResult` | `400` (no branch & no `pr_url`, or project has no `repo_path`) | `404` | `409` (tracking-only task) | `502` (gh/git failed)
  The task branch's changes. When `pr_url` is set, `gh pr diff <url> --patch`;
  otherwise `git -C <repo> diff origin/<base>...<branch>` in the project repo, using the `default_branch` base selection described above.
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

- `GET /api/tasks/:id/branch-check` → `200 {unmet_deps, embedded_tasks}` | `404` (task #1000)
  Live dependency + stacked-branch status for the review UI, recomputed on
  every call rather than trusted from the agent's evidence prose. `unmet_deps`
  is `unmetDeps(db, task)` (state.ts) — the same live gate the dispatcher
  checks before spawning and merge now checks before landing. `embedded_tasks`
  flags a **stacked PR**: another currently open task (same project, non-terminal,
  has a branch) whose branch shares commit history with this one beyond their
  common base with the remote-tracking integration branch (`origin/<base>`, using
  the `default_branch` selection described above; `git merge-base` pairwise comparison,
  server/src/branchContents.ts) — meaning this branch was cut from, or had
  merged into it, that task's in-flight work, so a later rewrite of that task's
  branch (e.g. a scope trim) won't be reflected here. Informational only, not
  merge-blocking: stacked branches are sometimes intentional. Both arrays are
  `[]` when clean; a git read failure silently skips that candidate rather than
  flagging it (can't tell ≠ blocked).

### Land queue (task #1257)

The director marks a set of in-review tasks approved-to-land in one call; the
reconciler's `landOnce` sweep merges them in graph order instead of the director
hand-ordering PRs. `from` lands before `to` on every edge.

- `POST /api/tasks/land-queue` body `{task_ids: [...], queued?: true}` → `200 {changed: [ids], queued}` | `400` (empty `task_ids`).
  Stamps `tasks.land_queued_at`. Only `in_review` tasks can be marked; unmarking
  (`queued: false`) works from any state. A task that leaves review loses the
  mark — the approval was for that diff, so it needs a fresh one.

- `GET /api/tasks/land-graph[?project=<id>]` → `200 {nodes, edges}`.
  Nodes are the project's `in_review` tasks. An edge is either
  `{from, to, kind: "depends"}` — `to` declares `from` in `depends_on`, or its
  brief says "lands after #N" / "depends on #N" — or
  `{from, to, kind: "conflict", files: [...]}`, inferred from two branches whose
  `git diff --name-only <base>...<branch>` sets overlap (server/src/rebaseGuard.ts
  `authoredFiles`). Nothing is stored; a git read failure means that branch just
  gets no conflict edges, never a blocked merge.

Each sweep lands every marked task whose edges are satisfied. Among the tasks
that are ready in a sweep, the higher `priority` goes first and the task number
breaks the remaining ties. A `depends` edge holds a task until its predecessor has actually merged.
A `conflict` edge only holds it when the peer lands in the SAME sweep — merging
one moves the base out from under the other, so the second waits for its agent
to rebase, and a peer that is not landing (red CI, unmarked) holds nothing.
Failing or pending CI holds a task in the queue; `unavailable` (no CI at all)
does not. A merge that actually fails drops out of the queue and the whole sweep
raises ONE notification naming what stopped, so a broken PR is not retried every
cycle.

**Merges are single-flight per target branch (HIVE-348).** The edges decide who
MAY land; the queue then lands them one at a time. Every caller goes through
`mergeTask`, which takes a lock keyed on the repo plus the branch being merged
into, so the land sweep, the reconciler's auto-merge, the PR gardener and the
director's own click can never run two merges against one base at once — the
race that once dropped a commit through a reset and re-merge. Independent repos
and independent target branches still land in parallel. Everything that
validates a merge (the PR metadata probe, the destructive-rebase guard, the
live-head match, `beforeMutation`) runs inside the lock, so a queued merge
validates against the base its predecessor just moved. The queue also re-reads
the approved-to-land mark immediately before each merge, so unmarking a PR
mid-sweep stops the merges still waiting behind the one in flight.

### Divergence radar (HIVE-348)

Conflicts used to surface at merge time, after a review was already done. This
shows them while the work is still in flight.

- `GET /api/tasks/divergence[?project=<id>]` → `200 {projects: [{project_id, base, rows}], rows}`.
  Rows cover every task in `in_progress`, `in_review` or `needs_decision` that
  has a branch. Each row is `{id, number, title, state, branch, behind, files,
  overlaps}`: `behind` is `git rev-list --count <branch>..<base>` (commits the
  target branch has that this one does not, `null` when git could not tell,
  never 0), `files` is how many files the branch authors, and `overlaps` lists
  the sibling branches touching the same files as `{task_id, number, files}`
  (capped at 5 files, symmetric so each side sees the other). Overlap reuses the
  land graph's own detector (`authoredFiles`), not a second one. Nothing is
  stored, and a project with no `repo_path` returns no rows without shelling out.

  The board shows this as two chips on in-flight cards: "N behind" (only from 5
  commits behind, since every branch in an active repo trails by one or two) and
  "same files as DEMO-2", whose tooltip names the shared files.

- `POST /api/tasks/:id/merge` body `{merge_strategy?: "local_ff", override_destructive_check?: boolean, actor?}` → `200 Task` (now `verifying`) | `409` (not `in_review`, missing/unpassed understanding check on a kind outside `config.auto_merge.kinds`, or the merge failed: conflict / not a fast-forward / gh refused / **destructive auto-rebase**) | `403` (denied by a `task.merge` authority rule) | `404` | `400` (local merge but no `repo_path`/`branch`). The optional director `actor` is recorded on `merged`, `merge_failed`, and `merge_blocked_destructive` events.
  Approve & merge. When `pr_url` is set: `gh pr merge <url> <method>` where
  `method` is the project's `config.merge_method` (`squash` default, or `merge` /
  `rebase`). Otherwise a **local fast-forward**: the default branch is
  fast-forwarded to the task branch tip (`git merge --ff-only`); it is refused
  with `409`, no working tree touched, if the primary checkout's `HEAD` is not on
  the default branch (that merge lands on `HEAD`, wherever it points) or the merge
  is not a fast-forward (diverged/conflicting — rebase the branch or open a PR for
  a squash merge).

  **Understanding gate.** The latest review must include a valid multiple-choice understanding check. The director must pass it before merge. The explicit `quiz_later` defer endpoint temporarily unlocks the merge while keeping the quiz in Needs You until it is eventually passed. Supervisors cannot answer or defer it.

  **Judgment-class only.** A task needs an understanding check at all only when it is judgment-class: the latest `auto_review` verdict is not `looks_good` (missing, errored or skipped counts), the reviewed diff touches a sensitive path (`auth`, `security`, `payment`, `billing`, `migration`, `secret`, `credential`, `password` by default, overridable with `config.understanding_checks.sensitive_paths`), the task kind is outside `config.auto_merge.kinds`, or the director flagged the task. Everything else merges with no check, mints no quiz, and never appears in `GET /api/understanding-quizzes`.

  For task kinds a project opted into with `config.auto_merge.kinds`, the check never gates the merge: a missing check is ignored, and a required-but-unpassed one is deferred automatically (an `understanding_quiz_deferred` event with `source: "system"`, written only after the merge succeeds) so it stays in Needs You. Kinds outside the allow-list keep the `409`.

  **Dependency gate (task #1000).** Recomputed live via `unmetDeps` (state.ts) right
  before merging, not trusted from the agent's evidence prose about what a
  dependency contains — mirrors the dispatcher's own spawn-time gate. If any
  `depends_on` task hasn't reached `verifying`/`done`, the merge is refused
  (`409`, naming the blocking task(s)); there is no override, since the only
  fix is for the dependency to actually land.

  **Stale-base fallback.** GitHub decides mergeability against the PR's remote
  base, which can sit behind the primary checkout's local `<base>`. So when `gh pr merge`
  fails with a conflict-shaped reason *and* the PR's own state blames the base
  comparison (`mergeStateStatus` is `DIRTY`/`BEHIND`/`UNKNOWN`, no blocking
  `reviewDecision`, no failing or running required check) and the project has a
  `repo_path` and the task a `branch`, hive may retry as a local fast-forward onto
  local `<base>` instead of bouncing the task to the agent. The fallback first
  requires the local task branch to resolve to the PR's current head SHA and to
  contain the PR's current base SHA. This prevents a stale local ref from bypassing
  a real remote-base conflict or merging code other than the reviewed PR head.
  Branch protection wears the
  same opaque "not mergeable" reason, so this gate never fires on a protection
  block. When the gate does not open, the normal `409` / bounce-to-agent behaviour
  below applies with the `gh pr merge` reason alone; when it opens but the local ff
  is then refused, the message carries both reasons.

  **`merge_strategy: "local_ff"`** forces the local fast-forward for a PR-backed
  task, skipping `gh pr merge` and the fallback's review/check gate — an explicit
  override for a PR whose base comparison is stale while the branch is still a
  clean ff onto local `<base>`. It still requires the local branch to match the
  PR head and contain the current PR base. The PR state probe still runs: a
  `CLOSED` (not merged) PR is refused, a `MERGED` one just advances the task. The review card
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
  task is bounced to `in_progress` with a steer to re-cut off current base. The
  comparison uses the PR's exact GitHub base commit (falling back to the
  project's configured default only for non-PR work), so stale local refs and
  moving base branches cannot produce false positives. An explicitly replaced
  PR starts a new branch lineage, so snapshots from the rejected PR do not carry
  into the replacement branch.
  **`override_destructive_check: true`** skips this guard when the reverts are
  intentional. The guard is a no-op when no pre-rebase snapshot exists (hive
  first saw the branch already rebased).

  **Scope-drift watch.** The same class of runaway, caught earlier: task #974's
  brief was a consolidation with an explicit "do NOT alter task semantics"
  boundary, and the run grew ~9 rounds of adjacent hardening before anyone saw
  it — 5.5h and $36.76 in, at final review, when the only remaining option was
  to pay to undo the work. A background loop watches every live branch: each
  time it has gained `config.scope_drift_commits` commits (default 3) relative
  to the remote-tracking integration branch (`origin/<base>`), so the
  first check lands before a third no-mistakes review round) hive collects the
  branch's authored file list and commit subjects and asks a one-shot
  `claude -p` (default `sonnet`, override with `config.model_by_kind.drift`)
  whether the run has grown past its brief. Every check writes a
  `scope_drift_check` event; a `drifting` verdict additionally writes
  `scope_drift` and opens a decision card — **trim** (recommended: drop the
  extra, finish the brief), **split** (queue the extra as follow-up tasks) or
  **continue** (the wider scope is wanted). Answering steers the live agent; a
  task gets at most one card, and the check stops once it has one. Advisory,
  never blocking: the agent keeps working while the card is open. A git read
  failure, an empty brief or an unparseable verdict never raises a card, and
  `config.scope_drift = false` turns the watch off per project. The judge is
  given the brief, the file list and the commit subjects — no diff — so a check
  is small; it does not replace the final pre-review, it just stops a run from
  paying for eight rounds of out-of-scope work first.

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

`GET /api/brief[?since=<iso>][?project=<id>]` returns `{since, done, director_required_task_ids, failed_or_attention, decisions, fleet, incidents, intake, to_review, spend, learnings_new}`. `director_required_task_ids` is the unique set of task ids for open decisions the target project's autonomy profile does not allow a supervisor to answer, plus open checkpoints in conservative projects. `done` excludes `chat_supervisor` infrastructure tasks. `to_review` contains the current Hive-owned `in_review` tasks as full Task objects with `health`; tracking-only external and Jira-linked tasks are excluded. `done`, incidents, spend, and learnings are windowed by `since`, while action-state sections remain current. `project` scopes only the `spend` rollup (joined from `usage` through `tasks`), because spend arrives pre-summed; every other section carries `project_id` and is filtered by the web against the shared project filter.

### Search — `GET /api/search?q=&limit=`
Global text search across the five text-bearing entities, for the web command
palette. → `200 {"hits": [SearchHit, ...]}`.

```json
{ "type": "task", "id": "9da7c5527580", "title": "Add dark mode toggle",
  "snippet": "User-facing dark mode toggle in settings.",
  "task_state": "done", "project_id": "proj_ab12...", "display_id": "ACME-7" }
```
- `type ∈ {task, decision, learning, policy, project}`. `task_state` and
  `project_id` and `display_id` are present only on `task` hits; other types omit them.
- An exact project task identifier such as `HIVE-247` resolves directly.
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
| `type` (required) | `status` \| `evidence` \| `needs-decision` \| `ready` \| `done` \| `unmergeable` \| `blocked` \| `deferred` \| `undefer` \| `usage` \| `assistant_text` \| `tool_use` \| `agent_turn_end` \| any custom string |
| `source` | defaults to `agent` |
| `note` | free text; stored in the event payload / used as caption/summary |
| `pr_url` | (`ready` type) the opened PR URL; recorded on the task, replacing its prior PR link when different |
| `landing_commit` (or `commit_sha`) | (`unmergeable` type) the git SHA (7-40 hex chars) that actually carries the work on the base branch |
| `payload` | structured event payload object, passed through verbatim for `assistant_text` / `tool_use` / `agent_turn_end` (JSON body) |
| `kind` | evidence kind (evidence type only); defaults to `screenshot` if a file is present, else `link`/`log` |
| `caption` | evidence caption |
| `url` | evidence URL (for link evidence, no file) |
| `meta` | (evidence type) JSON string merged into the Evidence row's `meta`; `hive emit ... evidence` auto-fills `{commit_sha}` from `git rev-parse HEAD` in its cwd |
| `title`,`context`,`risk`,`blast_radius`,`options` | decision fields (needs-decision type; `options` is a JSON string in multipart) |
| `until`,`days` | (deferred type) auto-resume horizon: an ISO timestamp (`until`) or an integer number of days from now (`days`); neither = indefinite |
| `model`,`input_tokens`,`output_tokens`,`cache_read_tokens`,`cache_write_tokens`,`cost_usd` | usage fields (usage type; numbers, or numeric strings in multipart; `cost_usd` optional) |
| `verify_name` | (evidence type) the task `verification_cmds` entry this artifact came from; recorded on the `evidence` event payload (CLI: `--verify-name <name>`) |
| `file` | (multipart only) the uploaded evidence file |

Behavior by `type`:
- `evidence` → copies the file to `~/.hive/evidence/<task_id>/`, inserts an
  Evidence row, writes an `evidence` event. → `201 {evidence: Evidence, event: Event}`
- `needs-decision` → creates a Decision (minimal; full cards use `POST /api/decisions`),
  parks the task in `needs_decision`. Missing/empty `options` default to
  `proceed`/`dismiss` (the emit path defaults rather than dropping the agent's
  signal). → `201 {decision: Decision, task: Task}`
- `ready` → the finished-handoff signal. Records or replaces `pr_url` when supplied (writing a `pr_linked` event, refreshing `branch` from the pull request head when available, and clearing prior `ci_status`/`head_sha` on replacement), then advances `in_progress → in_review` with a `ready_for_review` event. Idempotent: on a task that isn't `in_progress` (already advanced) it acks without transitioning. → `200 {task: Task}`
- `done` → records the `note` as summary + `note` event, then transitions the
  task to `done` (evidence rule enforced). → `200 {task: Task}` | `409`
- `unmergeable` (HIVE-314) → self-service terminal path for a task whose own PR
  has nothing left to merge (e.g. GitHub refuses `reopenPullRequest` because
  head==base) but the work already landed via a different PR/commit. Fetches
  the project's base branch and verifies `landing_commit` is an ancestor of it
  (`git merge-base --is-ancestor`); on success writes an `unmergeable` event and
  transitions straight to `done`, bypassing the normal in_review → verifying
  merge step (evidence rule still enforced). → `200 {task: Task}` | `400`
  (bad/missing `landing_commit`) | `409` (commit not verifiable on the base
  branch, or task not eligible)
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

### Autonomy scoreboard
- `GET /api/stats/autonomy?days=<n>&project_id=<id>&reverts=0` → `200 {window, auto_merge_precision, inbox_load, recovery, agreement}`
  Read-only. Four questions about whether hive's own automation is earning trust. `days` defaults to 30 (clamped 1..365) and the window snaps to whole UTC days; `project_id` scopes every section; `reverts=0` turns off the git revert scan (file-overlap detection still runs).
  `auto_merge_precision` is `{merges, measurable, clean, fixed, precision, revert_detection, cases}`. `precision` is `clean / measurable`, and it is `null` when nothing was measurable — a merge with no recorded `merged_files` and no PR number could only ever come back clean, so it is excluded rather than counted as good. `cases` carries one row per auto-merge with its `fix_signal` (`file_overlap` or `revert`, else `null`).
  `inbox_load` is `{by_day, totals, per_day}`. `by_day` has one row per calendar day in the window with a count per attention class (`decision`, `quiz`, `checkpoint`, `dialog`, `stale`) plus `total`.
  `recovery` is `{auto_respawns, one_cap_parks, scouts_spawned}`.
  `agreement` is `{auto_answered, contradictions, auto_contradicted, agreement_rate}`. `agreement_rate` is `null` when hive answered no decisions itself.
  The signals are heuristics with named ceilings (see `server/src/autonomyStats.ts`); read them as trends. `hive stats` prints the same numbers as an `AUTONOMY` section, and the web Needs-you activity summary shows them as a compact grid. Neither surface applies a threshold or raises an alert.

### Decisions
- `GET /api/decisions?status=open[&project_id=<id>][&test=all]` → `200 [Decision, ...]` (newest first; `status` defaults to `open`; `status=all` returns every decision; `project_id` optionally scopes the list). Decisions under a test/ephemeral project (`config.test === true`) are hidden by default; pass `?test=all` to include them.
- `POST /api/decisions` body `{task_id (required), title (required), context (required), risk?, blast_radius?, options (required, non-empty)}` → `201 Decision` | `400` (missing context or missing/empty `options`)
  (also writes a `needs-decision` event and parks the task in `needs_decision` if its current state allows it)
- `GET /api/decisions/:id` → `200 Decision` | `404`
- `PUT /api/decisions/:id/draft` body `{draft_note}` → `200 {"ok":true, "id":...}` | `404`
  (autosave; call debounced on every keystroke; overwrites `draft_note` only)
- `POST /api/decisions/:id/answer` body `{answer_key (required), answer_note?, selected_indices?, source?, actor?}` → `200 Decision` (now `answered`) | `400` (bad key/source, malformed note/selection, or empty planner selection) | `409 {stale:true, resolution:{status, source, actor, at, answer_key, answer_label, answer_note, reason}}` when the card was already answered or expired
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
- `POST /api/decisions/:id/auto-answer` body `{answer_key (required), answer_note?, actor?}` → `200 Decision` (now `answered`) | `400` (missing key or malformed answer payload) | `403 {effect:"escalate", category, reason}` | `404` | `409 {stale:true, resolution}` when another actor already resolved it
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
and inputs only the director can supply. Denying a pending guarded command is
fail-closed and may use the safe auto-answer endpoint; approving one always
remains a director action. Report-only scout handoffs are accepted by moving
the task through `verifying`, never through the merge endpoint.
Conversation history persists in `chat_threads` / `chat_messages` (append-only,
same shape as `events`); each thread's `task_id` is its backing supervisor task
(`source='chat_supervisor'`, kept out of the dispatcher and the board lanes). The thread is also the durable run ledger: `objective`, `acceptance_criteria[]`, `phase`, `next_action`, `waiting_on`, `wakeup_at`, `outcome`, and `completed_at` survive supervisor restarts.

The supervisor task is also the root of an automatic management loop. Tasks it
creates inherit `parent_task_id=$HIVE_TASK_ID`; nested agent follow-ups preserve
the chain. Hive walks that ancestry for meaningful events, keeps the latest event per task during a 45-second debounce window, and pushes one `[hive manager wakeup]` steer into the owning supervisor session. Unowned project events do not fall back to the Chief of Staff or another manager. Inbox sweeps remain separate. The wake set covers blockers, decisions, peer messages,
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
- `GET /api/chat/threads/:id` → `200 {...ChatThread, messages:[ChatMessage], commitments:[Commitment], meetings:[ManagerMeeting], verifications:[ManagerVerification], retrospectives:[ManagerRetrospective]}` | `404`. Messages are oldest first. Commitments put active items first and carry their source message or task, current worker owner, dependencies, and due date. Management records are newest first; repeated meeting stages collapse to the latest card for each `meeting_id`.
- `PUT /api/chat/threads/:id/run` body `{objective?, acceptance_criteria?: string[], phase?, next_action?, waiting_on?, wakeup_at?, outcome?, source?}` → `200 ChatThread` | `400` | `404` | `409`. `phase` is `intake|planning|executing|waiting|verifying|complete|stopped`. Completing a run is rejected unless the newest verification passed and a retrospective exists. A successful update writes a `manager_update` event on the supervisor task. Waiting runs with a due `wakeup_at` are resumed by the daemon (`HIVE_MANAGER_WAKE_MS`, 30 seconds by default).
- `POST /api/chat/threads/:id/commitments` body `{project_id?, title, owner_task_id?, source_message_id?, source_task_id?, status?, due_at?, depends_on?: string[]}` → `201 Commitment` | `400` | `404` | `409`. A portfolio commitment requires `project_id`; a project thread infers it. Every commitment must point to a source message or managed source task. Owners and dependencies must belong to the same supervising thread.
- `PUT /api/chat/threads/:id/commitments/:commitmentId` body `{title?, owner_task_id?, status?, due_at?, depends_on?: string[], source?}` → `200 Commitment` | `400` | `404` | `409`. Status is `open|in_progress|blocked|done|dropped`. Create and update operations write `manager_commitment` audit events.
- `POST /api/chat/threads/:id/meetings` body `{stage: "proposal"|"critique"|"decided", meeting_id?, topic?, participants?: string[], summary?, recommendation?, dissent?: string[], evidence?: string[], risks?: string[]}` → `201/200 ManagerMeeting` | `400` | `404` | `409`. Proposal requires a topic and 2 to 3 worker task ids owned by this manager. Hive sends the agenda to each participant. Critique sends the competing-proposal summary back once. Decided requires a recommendation and records one compact decision memo before ending the meeting. The legacy `decision` field remains accepted as the recommendation.
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

CLI: `hive chat send`, `reply`, and `close` handle the conversation lifecycle. `hive chat update` maintains the run ledger; `commit` and `commit-update` maintain accountable outcomes; `meeting` records and dispatches bounded proposal, critique, and decision stages; `verify` records evidence-backed attempts; `retrospect` records the completion review.

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
     `POST guarded-action {action:"command.dangerous.<category>", target:<cmd>, summary:<Bash description>}`. The hook forwards the Bash tool's one-line description as the stated intent; see the `guarded-action` contract above for missing-summary behavior.
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
Notification click targets and the `hive://` URL scheme: a notification's
destination is `/decisions#dcard-<decision_id>` when it names a decision, else
`/tasks/<task_id>`, else `/`. The desktop app registers the `hive` scheme, so the
same destinations are reachable from anywhere: `hive://task/<number-or-id>`,
`hive://decision/<id>`, `hive://quiz/<task-id>`, `hive://open?path=/<route>`.
Task routes accept a task NUMBER as well as an id (`hive://task/1247`).

[Apple documents Mobile Web Push](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers) on iOS and iPadOS 16.4 or later after Hive is added to the Home Screen and notification permission is requested from a user action. This standards-based path uses Apple's push service but does not require Apple Developer Program membership or native app plumbing. An open decision uses the decision title as the notification question. Browsers that expose Web Notification action buttons can answer a fixed option without opening Hive. Tapping the notification body, a free-text answer, or a failed inline answer opens `/decisions#dcard-<decision_id>` instead. The answer request carries a token that can answer only the named decision. Apple documents Home Screen Web Push support, but not notification action buttons. Verify whether actions appear on the director's installed PWA. If iOS shows only View, the decision deep link is the supported fallback.

`POST /api/push/subscribe` requires the API token from every caller, including loopback. The PWA sends its saved token and prompts for one after a `401` response. `POST /api/push/unsubscribe` remains available to remove an existing endpoint.

- `GET /api/notifications?since=` → `200 {"notifications": [Notification, ...], "unread": <n>, "last_delivery_error": {"id","error","at"}|null}` (newest first; `since` is an ISO timestamp filter, else the 100 most recent; `unread` counts rows with `delivered_at` null)
- `POST /api/notifications/:id/delivery` → `200 {"ok": <bool>}`
  The desktop app reports what macOS did. `{"shown": true}` sets `delivered_at` (`ok:false` means it was already delivered, or the id is a digest, not a row). `{"error": "..."}` records the refusal instead — the common one is `UNErrorDomain error 1`, meaning notifications are switched off for hive. The latest refusal comes back as `last_delivery_error` on `GET /api/notifications`. Nothing else should call this: it is the only honest signal that a native notification appeared.
- `POST /api/notifications/test` → `201 {"id": "ntf_...", "app_clients": <n>}`
  Fires one urgent test notification down the live delivery path. `app_clients` is how many desktop apps are attached to the stream; zero means delivery falls back to launching the app. Behind `hive notify --test`, which then polls for `delivered_at`.
- `POST /api/notifications/ack` → `200 {"ok":true, "acked": <n>}`
  Marks all currently-undelivered notifications as seen (`delivered_at` set to now). Called when the header bell dropdown is opened, so those events are not re-pushed by the next digest.

### Away mode
Holds low-urgency phone pushes overnight and batches them into one summary.

Every urgent notification pushes to the phone the moment it happens. Away mode
classifies each outgoing push and holds the ones that can wait. The class comes
from the notification `kind` (`decision`, `decision_nag`, `review` → `decision`;
`quiz_digest` → `quiz-digest`; `circuit_breaker`, `agent_unreachable`,
`auth_lost`, `incident` → `fleet_down`; everything else → `info`), and an `enqueue` can override it with an explicit
`class`. A class listed in `always_through` is pushed immediately even while
away; everything else is appended to a held list.

Config lives in the `away_mode` settings key, the held list in `away_held`, and
the latched schedule state in `away_active`. The reconciler step `syncAway`
flips the latch by the schedule. On waking it sends ONE push,
`While you were away: N items`, deep-linking `/inbox`, then clears the list.
The manual `on` switch takes effect on the very next push, not at the next tick.

- `GET /api/away` → `200 {"on": <bool>, "schedule": {"start","end","tz"}|null, "always_through": [...], "active": <bool>, "held": <n>}`
  `active` is away RIGHT NOW (manual switch, or the schedule latch). `held` is how many pushes are waiting.
- `POST /api/away` body `{on?, schedule?, always_through?}` → `200 {..., "active": <bool>, "flushed": <n>, "held": <n>}`
  Any omitted field keeps its current value; `"schedule": null` clears the schedule. Turning away mode off flushes the held list immediately, so the summary push does not wait for the next reconciler tick. `flushed` is how many held pushes that summary covered.

`schedule.start` is inclusive and `schedule.end` exclusive, both wall clock in
`schedule.tz` (an IANA zone). A window that wraps midnight (`23:00` → `08:00`)
is the normal case. An unparsable time or timezone never holds anything.
`always_through` defaults to `["security","spend","fleet_down","second_failure"]`.

### Secrets (metadata only)
`POST` and `DELETE` here require the API token from every caller, loopback
included (`401` without it — see Auth); `GET` does not.
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

**`project_id` on frames.** Every frame that belongs to a project carries a
top-level `project_id`, so a client never has to join task → project itself. It
comes from one of three places:

- the task the frame names, looked up once and cached: `task`, `event`,
  `decision`, `evidence`, `notification`, `usage`
- a `project_id` already on the row itself: `incident`, `learning`
- the parent chat thread: `chat_message`. A chat message row has no task and no
  project of its own, so the server stamps the scope of its `chat_threads` row.
  Messages on the portfolio-wide Chief of Staff thread have no project, so they
  carry `"project_id": null` and are treated as fleet-wide.

Fleet-wide frames have no project scope and carry no `project_id`: `hello`,
`offline`, `chat_thread`, `chat_delivery`, `notify`, `reconciler_error`, and the
reaper frames.

**Query parameters (all optional).** With none, the stream behaves exactly as it
always has: every frame, to every client. Filtering happens per client, so a
filtered subscriber costs nothing extra for anyone else.

| param | meaning |
|-------|---------|
| `client=app` | marks the Electron desktop client, which is the only client that can raise a native notification |
| `project=<project_id>` | drop frames belonging to other projects. Frames with no project scope always pass |
| `classes=<comma list>` | keep only these frame types, e.g. `classes=decision,event,task`. The `hello` headline is always sent |

Example: `GET /api/stream?project=proj_e60f3994fbf7&classes=decision,event`

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

- Poll schedule: `HIVE_GCHAT_POLL_MS` (default 60000). Each started loop runs at most one cycle at a time; ticks during a slow cycle are logged and skipped, not queued. Token refresh, message/space listing, and attachment downloads each time out after 20 seconds. The connector is a hard no-op until at least one project sets `config.gchat_spaces`.
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
design REJECTS long-running LLM supervisor sessions (a prior orchestration tool's failure mode):
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
against the dialog text).

Projects that set `config.auto_answer_dialogs: true` also let the server answer
codex file-write confirmations ("Would you like to make the following edits?")
by itself. It sends `1` (yes, proceed — this edit only, never "don't ask again")
and logs a `dialog_auto_answered` event with the files touched, source
`supervisor`. Every file must be the task's own: inside its `worktree_path`, or a
`/tmp`, `/private/tmp` or `/var/folders` path whose name carries the task id or
`-<number>-`. A `..` escape, a relative path, a file outside those, or any other
dialog shape (a shell-command approval such as `rm -rf` is a different prompt and
never matches) parks for the director as before. `GET /api/brief` returns
`auto_answered_dialogs`, the count over the `since` window (default 24h), so the
director sees one number instead of a card per write.

Anything else opens an URGENT decision card whose
Approve/Deny answer sends the keystroke to the pane remotely
(`blocked_card`/`dialog_answered` events); the task parks in `needs_decision`.
Silent-path diagnosis (auth lost, context exhausted, transient API errors) is
described in `server/src/diagnose.ts`.

Whenever the same `idle`/`blocked`/`done` sweep sees Claude Code's own "…to edit queued messages" footer, a message was queued but Claude Code went idle without consuming it (task #1098). The reconciler records a `queued_input_recovered` event, sends `Up` then `Enter` to the pane (the sequence verified live to move the queued message into the editable input and submit it), and updates the event's `delivered` field from `null` to whether the pane write succeeded in the DB row only — it is not re-broadcast over SSE under the same event id, so the live feed keeps showing the pending row until its next full fetch (same tradeoff as `steer.ts`'s `markSteersDelivered`). While the footer persists, it makes at most three consecutive attempts; `agent_status` and `stale` events do not reset that count, but other activity starts a new episode. It then stops sending keystrokes and enqueues one `queued_input_stuck` notification (`urgency: "urgent"`) for the episode.

Every automatic transition that could act on a task mid-recovery — idle/done/gone handoff to review (`advanceIfFinished`, `handOffToReview`), `autoMergeReady`, and `releaseReviewAgent` — shares one guard (`state.ts`'s `queuedInputRecoveryPending`, task #1234): it holds for two minutes after the latest `queued_input_recovered` event (giving the redelivered turn time to start, and letting a crash-orphaned `delivered: null` reservation age out instead of blocking forever), and beyond that window it keeps holding only while an unresolved `queued_input_stuck` notification exists with no other task activity since — so a genuinely stuck task can't slip through once the flat window passes, and a task that's actually fine isn't held any longer than necessary.

### Promoter (continuous promote-to-main evaluation)
No HTTP endpoints — a server-internal loop (`server/src/promoter.ts`, scheduled by `HIVE_PROMOTE_MS`, default 30m, plus one run ~30s after boot). Each started loop runs at most one cycle at a time; ticks during a slow cycle are logged and skipped, not queued. Projects opt in with `config.promote = {from: "staging", to: "main"}`. Whenever `origin/<from>` has commits `origin/<to>` lacks, it queues ONE evaluation task (`source="promoter"`, `source_ref` = the evaluated head SHA, kind `ship`) that the dispatcher spawns like any other. The agent judges readiness — CI green, test comprehensiveness for the promoted range (uncovered bug fixes or gaps in auth/billing/data-integrity paths BLOCK promotion; the agent spawns a gap task per missing test), half-shipped features, pending migrations — and either opens the Promote PR with a per-PR "Test coverage" verdict section (base `<to>`, head `<from>`; the DIRECTOR merges) or attaches a not-ready report and finishes. Dedup: one in-flight evaluation per project, a given head SHA is evaluated at most once, and an already-open promote PR suppresses new evaluations until it's merged/closed.

### Priority
Every task carries `priority`: one of `now`, `next`, `normal` (the default) or
`later`. It is ORDERING only. Nothing is ever preempted — a running agent is
never stopped and a merged PR is never rolled back to make room for a
higher-priority task. Set it at creation (`POST /api/tasks`) or later
(`PUT /api/tasks/:id`); an unknown value is a `400` and changes nothing.

**Who may set what.** Only the director may set `now`. Attribution is the task
`source` on the request: the web UI and the CLI send none (or `"director"`),
a spawned agent sends `"agent"`, the chat supervisor sends `"chat_supervisor"`.
Any attributed non-director source asking for `now` gets a `403` and nothing
changes; `next`, `normal` and `later` are open to everyone. This is because
`now` is the one level that can borrow a slot past `max_agents`, so a
supervisor or an agent granting itself one would spend the fleet's headroom on
its own work.

Authority applies to the value the caller asks for, not to an inherited one. An
agent filing a follow-up under a director's `now` task keeps `now`: it is
staying with work the director already ranked, not granting itself a level.

**Where priority comes from when the caller does not say.** First match wins:

1. An explicit `priority` in the request.
2. The parent's, when `parent_task_id` is set. A follow-up matters as much as
   the work that spawned it.
3. `next`, when the title or brief reads as security work. The words are the
   same list the understanding-quiz gate applies to changed paths (`auth`,
   `token`, `security`, `payment`, `billing`, `migration`, `secret`,
   `credential`, `password`), matched as whole words so "author" does not count.
4. `normal`.

Nothing auto-assigns `now`, and nothing auto-assigns `later`.

**Inheritance elsewhere:**

- A **requeue** (recovery, or a director answering a recovery card) copies the
  failed original's priority to its successor. Without this, a `now` task would
  fall to the back of the queue on every retry.
- The **root-cause scout** filed on a lineage's second failure inherits that
  lineage's priority, so it does not queue behind the work it is meant to
  unblock.
- **Monitor auto-tasks** (`config.monitors_auto_task`) are created at `next`:
  something is already down.
- **Watcher tasks** and **Jira-imported mirrors** are created at `normal`, the
  default. They are inbound material, not an emergency.
- Tasks created **together in a `depends_on` chain do NOT inherit from the head
  of the chain.** `depends_on` is an ordering edge, not a lineage. Pass
  `priority` on each task in the chain you want it on (`hive task create
  --priority <p>`).

It changes three things:

- **Which queued task is picked up first.** The dispatcher orders its queue by
  priority, then by age. A `later` task never beats a `normal` one, however old
  it is. The reattach pass keeps its own ordering (oldest feedback first) —
  that is resumed work, not new work.
- **Which item Focus shows first.** Every day in Focus promotes an item by one priority level, capped at `now`, then FIFO breaks ties. Age starts when a decision or checkpoint is created, a task enters review or failure, or its current stuck/dead health condition begins. CI and metadata updates do not reset it.
- **Which approved PR lands first.** The land queue's dependency and conflict
  edges still decide the order; priority only breaks the tie among the PRs that
  are all ready in the same sweep.

One extra rule, the **borrowed slot**: when a project is exactly at its
`max_agents` cap, a single `now` task may start anyway, at `cap + 1`. At most
ONE borrowed slot per project at a time — a second `now` task waits until the
borrower is no longer in flight. The `max_agents × 2` overhang on total live
agents still applies. This is the only way the cap is ever exceeded, and it adds
an agent rather than taking one away.

### Dispatcher (self-driving spawn loop)
No HTTP endpoints — the dispatcher is a server-internal loop (`server/src/dispatcher.ts`,
default every 30s, `HIVE_DISPATCH_MS`). It picks up `queued` tasks in
[priority](#priority) then age order and spawns a
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

Each cycle also runs a **reattach** pass BEFORE the queued pass: a live task
(`in_progress`/`in_review`/`verifying`) with no `agent_target` but with QUEUED steers gets an
agent respawned onto its existing branch and worktree, with that feedback at the
top of the fresh brief. For an `in_review` task, the queued-work guard described
under Review experience records `changes_requested` and resumes work. This is the return leg of releasing review-parked agents
(below): the release frees the slot, the reattach brings an agent back when
review talks back (a changes-request, red CI, a closed PR, a merge conflict).
It skips `auto_dispatch`, `dispatch_kinds`, intake review and the authority gate
— the task was already authorized when it first dispatched, and the alternative
is feedback nobody ever reads — but `max_agents` and the per-task spawn backoff
still apply.

### Releasing review-parked agents

A task in `in_review` is parked on the director: its PR is open, CI is green, and
nothing asks its agent to act again until a human (or a red check) does. Every
reaper sweep (`server/src/cleanup.ts` → `releaseReviewAgent`) therefore closes the
session of any `in_review` agent herdr reports **idle** or **done** — or confirmed gone —
and drops `agent_target`, so it stops counting toward `max_agents`. The git
worktree and branch are PRESERVED (the PR still needs them); an `agent_released`
event records it. An agent that is still `working`, one with undelivered steers,
and one whose death cannot be positively confirmed against the pane list are all
left alone. Per-project opt-out: `config.release_review_agents: false` (default
on).

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
  A terminal task whose row has lost `worktree_path`/`branch` (cleared by an
  earlier successful removal) can no longer name its own checkout, so it takes
  the same orphan path and is torn down with the path and branch git enumerated.
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

- **Infra failure (auto-recovered, bounded).** An agent that vanishes (herdr reports it gone, or it goes stale-and-dead) is auto-recovered: the pane tail is captured as `log` evidence, the task is marked `failed`, and a FRESH `source="requeue"` task is queued (`parent_task_id` → the failed one). This is capped at **2 auto-requeues** per lineage; the third death opens a decision card instead (`recovery_card` event). An alive-but-silent agent is nudged up to 3 times, then also escalates to a card. Every auto-requeue (and the manual `POST /api/tasks/:id/requeue`) runs through `requeueTask`, which prepends the [Task resume context](#task) whenever the failed task left a branch. This is never optional: it prevents a requeue from silently restarting near-complete work or opening a second PR next to a predecessor's still-open one. A park that follows at least one requeue also files ONE `kind=scout`, `source="recovery-scout"` task ("Why does <title> keep failing?") whose brief carries every failed task id, its worktree, its saved pane tails, and its recovery timeline, and asks for an explanation plus the one change that would make the next attempt succeed. Exactly one per lineage: the `scout_spawned` marker is written on the lineage's ORIGINAL task, so later parks find it and add nothing. Once that scout has a `report` evidence row, the next recovery card links it.
- **Terminal failure (human triage).** A task that failed PAST the auto-requeue
  cap, was cancelled/failed for work reasons, or that the director failed
  manually, STAYS `failed`. `failed` is not a board column, so these surface ONLY
  in the web **"needs attention" tray** (failed tasks awaiting triage + live
  `dead`/`stuck` tasks not parked in review or decision state). The **dispatcher never picks up `failed`
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
