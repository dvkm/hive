# Hive v1 — Specification

Hive is a local-first orchestration control plane. The director sets direction through one persistent, cross-project Chief of Staff and opens the focused Needs you queue or secondary operational views only when they need detail or must act. Hive owns durable state, event-driven supervision, evidence, policies, and verification. It is a NEW system: it borrows ideas from a prior orchestration tool (worktree isolation, evidence-gated done, option-menu decisions) and a consuming project (annotate/respond loop, SSE, action-only surfaces) but shares no code with them.

Decisions locked 2026-07-08: new system using herdr as agent runtime (D1), SQLite state store (D2), v1 includes smoke checks + health monitors (D3-B), build approved (D4-A).

## Non-negotiable product rules (from pain-point analysis)

1. Status is push, never pull. The board is always current (SSE). The director never types "status?".
2. No task reaches Done without evidence. The state machine enforces it.
3. Every decision card carries: two-sentence what/why, options with recommendation + rationale first, risk + blast radius (prod? reversible? exact target named), inline evidence, and an explicit SUBMIT button. Drafts are saved server-side on every keystroke and never lost.
4. Standing preferences are policies stored in the DB and injected into every agent brief automatically. Nothing is repeated because a context window compacted.
5. Supervision is the daemon's job, not an LLM's. Event-driven first (herdr status waits, Claude Code hooks, `hive emit`), plus a coarse time-based reconciler as fallback. No terminal scraping, no busy-signature regexes, ever.
6. High-risk actions (prod deploys, feature flags, destructive ops) require a decision card that names the exact target before execution.
7. Action-only surfaces: resolved decisions auto-archive; Needs you contains only open decisions, checkpoints, reviews, and untriaged failed or unhealthy work.
8. Future-proofness over shortcuts. Root-cause fixes, clean seams, boring durable tech. Never skip or shrink work because it "would take too long" — effort cost is not a valid argument in this project, and time estimates are never given. Push through.
9. Versions ship continuously without waiting for a go-ahead. Each version ends with evidence (green tests, screenshots, a working demo recorded as evidence rows in hive itself), then work proceeds directly to the next version. The director is interrupted only by genuine decision cards.
10. Top-level asks are loops, not queues. The director talks to one Chief of Staff whose durable conversation and run ledger persist across project switches. It restores context on re-entry, coordinates delegated work through independently verified completion, handles low-risk actions under each target project's autonomy profile, and escalates only consequential decisions. Workers coordinate directly through durable, attributed messages; consequential disagreements use a bounded propose/critique/synthesize meeting rather than serial director mediation.
11. Jira "Done" is human-only. Hive never writes it. A hive task reaching `done` leaves the Jira issue in "In Review" and posts a comment asking the reporter to check the result and close the ticket; `cancelled` pushes no status at all and only comments. An issue a human already moved to Done is never dragged back out of it, at the decision or at the write boundary. Jira → hive still pulls `Done → done`.

## Architecture

```
herdr agents (worktree-isolated)      Claude Code hooks       reconciler (timer)
        \                                    |                      /
         \-- hive emit CLI (HTTP) --->  hive-server (Bun + SQLite + SSE)
                                             |
                          web app (Chief of Staff home / Needs you / Browse)
                          monitors (URL smoke checks -> incidents)
```

- Runtime: Bun. DB: `bun:sqlite`, single file `~/.hive/hive.db` (override `HIVE_DB`). Server listens on `127.0.0.1:4700` (override `HIVE_PORT`).
- Repo layout:
  - `server/` — the daemon (`bun run server/src/index.ts`)
  - `cli/` — `hive` CLI (single-file bun script installed as `bin/hive`)
  - `web/` — Vite + React + TypeScript app, built to `web/dist`, served statically by the server
  - `hooks/` — Claude Code hook scripts + installer
  - `docs/`

## Data model (SQLite)

- `projects(id, name, repo_path, created_at)` — plus JSON config column: monitor URLs, default branch, deploy notes.
- `tasks`: durable task records. `server/src/db.ts` owns the canonical SQLite schema; [docs/API.md](./docs/API.md#task) owns the public Task shape and field semantics.
  - `state ∈ {queued, in_progress, needs_decision, in_review, verifying, done, failed, cancelled}`
  - `kind ∈ {ship, scout, chore}` (scout = knowledge only, done requires a report as evidence)
- `events(id, task_id, ts, source ∈ {agent, hook, herdr, reconciler, monitor, director, system, chat_supervisor, unknown}, type, payload JSON)` — append-only timeline; every state change writes an event.
- `evidence(id, task_id, ts, kind ∈ {screenshot, test_run, log, report, link}, path, url, caption, meta JSON)` — files copied into `~/.hive/evidence/<task_id>/`, served at `/evidence/...`. Never local-path-only, never gitignored-and-lost.
- `decisions(id, task_id, ts, title, context, risk, blast_radius, options JSON [{key,label,detail,recommended}], status ∈ {open, answered, expired}, answer_key, answer_note, draft_note, answered_at, answered_by, answered_actor)` — `answered_by` is the caller identity (`director|chat_supervisor|agent|system|unknown`) and `answered_actor` an optional free label, both recorded for audit-trail integrity.
- `commitments(id, thread_id, project_id, title, owner_task_id, source_message_id, source_task_id, status ∈ {open, in_progress, blocked, done, dropped}, due_at, depends_on JSON, created_at, updated_at)` stores the outcomes a supervisor owes. Commitments are source-linked promises, not duplicate worker tasks.
- `policies(id, scope ∈ {global, project:<id>}, title, body, active, created_at, updated_at)` — injected into briefs; editable in the web UI.
- `incidents(id, project_id, monitor, ts, status ∈ {open, resolved}, detail)` — monitor failures; open incidents can auto-create tasks.

State machine (server-enforced):
- `queued → in_progress` (agent spawned) → `needs_decision ⇄ in_progress` → `in_review` (PR open) → `verifying` (merged; post-merge checks) → `done` (the DIRECTOR accepts it; hive never makes this move itself).
- Transition to `done` REJECTED unless ≥1 evidence row exists for the task (scouts: kind=report).
- Any state → `failed`/`cancelled` allowed, with reason event.

## Event ingestion (three redundant paths)

1. `hive emit` CLI → `POST /api/tasks/:id/events` — semantic events from agents: `status`, `evidence` (with file upload), `needs-decision` (creates decision row), `done` (refused with `409` for ordinary work: hive never closes a task, so agents hand off with `ready`; the one exception is a report-only self-audit, which moves to `verifying` for the director), `blocked`, `deferred`/`undefer` (park a task waiting on an offline human action, suppressing "gone quiet" nudges; task stays `in_progress`, and its `health.status` reads `deferred` so a consumer that only looks at health knows it is parked; `hive task move <id> deferred` does the same thing), `unmergeable` (HIVE-314: the task's own PR has nothing left to merge, such as when GitHub refuses to reopen it because head==base, but the work already landed via a different PR/commit; the agent supplies `landing_commit`, hive verifies it's on the base branch with `git fetch` + `merge-base --is-ancestor`, then transitions to `verifying`, bypassing the normal in_review → merge step; the director still accepts it from there). Briefs instruct agents to use it.
2. Claude Code hooks (`hooks/`) — Stop/SubagentStop/PostToolUse hooks that POST lifecycle events when `HIVE_TASK_ID` is set in the agent's env. Zero agent discipline required.
3. Reconciler (in-server, every 60s): `herdr agent list` + `herdr agent get` to sync live agent status; `gh pr view --json` for tasks with a PR to sync CI/merge state; flags tasks silent > configurable threshold with a `stale` event and a director notification.

## herdr runtime adapter (`server/src/runtime/herdr.ts`)

Non-negotiable presentation rules (2026-07-09, the director): hive uses herdr the way a prior orchestration tool proved it should be used — agents are VISIBLE and INTERACTIVE, never invisible one-shot processes. Reference: AGENTS.md herdr sections.
- Workers spawn as long-running INTERACTIVE agent sessions (never bare `claude -p` one-shots) in a dedicated, named herdr session/workspace for hive, one labeled tab per task (label = task id + short title), cwd = the task worktree.
- The director can open herdr at any time and see the whole fleet at a glance, attach to any agent, and type into it; hive must tolerate and absorb manual captain interventions (they surface as events).
- The board links each in-progress task to its agent (a "view agent" affordance that focuses the herdr tab via `herdr agent focus`); agent liveness/status shown on the card comes from herdr integration-reported status.
- Agent exit is an observable event: the wait/reconcile loop must detect a vanished agent within one cycle and run stale-recovery (below), never leaving a task pointing at a ghost.

## Stale recovery (observed → acted on)

On a stale flag: probe the agent (exists? integration status? pane tail). Dead → mark task failed with reason + captured pane tail as evidence, requeue under backoff (max 2 auto-requeues, then decision card). Fresh requeues must adopt the failed attempt's working state instead of rebuilding it; [the Task resume contract](./docs/API.md#task) owns the structural fields and dispatch guard. Alive but silent → send a status nudge via `herdr agent send`; still silent after N cycles (default 3) → decision card. Spawn also auto-installs hive's Claude Code hook wiring into the spawned agent's env so lifecycle reporting is structural, not brief-dependent.

- No progress (hive-1951): an agent that is alive but has stopped working is covered by none of the above. It still holds its name, so reattach skips it and the reaper leaves it alone, and the stale flag fires only once. The clock counts only AGENT-generated events (source `agent` or `hook`, plus a fresh `spawned`): every row hive writes about a task, and every human steer or poke, is excluded, because a refused respawn writing `spawn_error` + `authority_logged` once made a task frozen for 2.5h drop off the stall list. Health and the board card age read the same clock. If the agent itself has written nothing for 4x the stale threshold, the reconciler writes a `hung` event and raises one urgent notification per silence window, quoting the last thing the agent said. It never kills the agent: a slow build and a wedged one look identical from here, so a human decides.
- Spawn: `herdr worktree create --cwd <repo> --branch hive/<task-id> --json` then `herdr agent start <task-id> --cwd <worktree> --env HIVE_TASK_ID=<id> --env HIVE_URL=... --no-focus -- claude -p <brief-file> --permission-mode acceptEdits` (exact argv per-project configurable).
- Brief composition (`server/src/briefs.ts`): task brief = task description + definition of done + `hive emit` protocol instructions + ALL active global policies + project policies + project playbook. Composed fresh at spawn time.
- Watch: after spawn, the server runs `herdr agent wait <target> --status blocked|idle|done --timeout <ms>` in a supervised loop (each wait completion re-arms; errors fall back to reconciler polling). Status changes become events.
- Steer: `POST /api/tasks/:id/send` → `herdr agent send`.
- Teardown on done/cancelled: `herdr worktree remove` only after PR merged or branch pushed (verify with git; refuse otherwise).

## Restart survivability (hive restarts must not cost agents or their context)

Agents are long-lived processes in herdr panes; hive restarting, self-deploying or updating must never end them. Four mechanisms, all of them refusing to act on absence of evidence:

- **Re-adoption** (`Herdr.readopt`, driven from the reconciler's probe): a desktop-app restart wipes herdr's agent registry while every pane keeps running, so `agent get` answers `agent_not_found` for a fleet that is entirely alive. Hive finds the task's surviving pane (stable `terminal_id` recorded at spawn, else a registry label, else the one pane at the task worktree cwd whose foreground process is not a login shell — a fleet tab also holds a shell pane there) and re-registers it with `pane report-agent` + `agent rename`. Probe, steer, focus and dialog handling resume on the same cycle; the pinned name survives Claude Code's own integration re-reporting later.
- **Boot grace** (`server/src/teardownGuard.ts`, `HIVE_BOOT_GRACE_MS`, default 5 min): nothing is failed, requeued or reaped in the first minutes after boot, when herdr may still be cold and every agent probes as gone.
- **Circuit breaker**: `HIVE_DEAD_BURST_N` death verdicts (default 3) inside `HIVE_DEAD_BURST_MS` (default 10 min) is hive losing sight of herdr, not a fleet dying. All teardown pauses and ONE decision card is raised; answering it resumes.
- **Single-writer DB lease** (`server/src/lease.ts`): exactly one server may run the loops against a DB. A booting server claims the lease after its listener is up; predecessors — including `bun --watch` workers that survived a `launchctl kickstart` by re-parenting to launchd, holding no port — notice on their next heartbeat and exit. The lease is ENFORCED, not merely announced, because a second server's reconciler evicts working agents:
  - A server whose port is not the fleet port (`HIVE_FLEET_PORT`, default 4700) refuses to open the live fleet DB at all and exits 1 before it serves, leases or reconciles — that is the exact shape of a throwaway smoke server that forgot `HIVE_DB` (override with `HIVE_ALLOW_SHARED_DB=1`).
  - Every server registers its pid in `server_instances` BEFORE starting a loop, and the lease holder SIGTERMs (then SIGKILLs) any registered contender still alive after losing the lease — the case a stand-down request cannot reach. Only a pid whose command line still reads as a hive server is ever signalled.
  - Both paths notify the director. Nobody has to kill a rogue server by hand.

Recovery must actually recover: a diagnosis is not a revival. Lost worker auth respawns the agent on the same task and worktree (rate-limited per task by `HIVE_AUTH_RESPAWN_MS`, default 15 min, counting attempts rather than successes), which is also the only way hive learns the login was restored. And no row hive writes ABOUT an agent (`stale`, `recovery`, `recovery_nudge`, `spawn_error`) counts as agent activity — otherwise diagnosing a frozen pane resets its own silence clock and the task reads healthy forever.

Teardown also proves its target: `closeSession` refuses a recycled `tab_id` that demonstrably holds a different worktree, and every pane hint prefers the stable `terminal_id` over reusable tab/pane ids.

## Auto-resume (the agent's own words)

Orthogonal to the timer above and much stronger: when an agent's turn ENDS (the Stop hook's `agent_turn_end` event, not a subagent finishing), hive reads the agent's own final message. If it named unfinished work it committed to itself ("Continuing…", "next I will…", "resuming…"), the task is `in_progress` with nothing blocking it (not deferred, no open decision card, no unmet dependency, not tracking-only), and nothing has happened since that message, hive steers the agent by quoting that exact sentence back at it. Quoting the agent means hive needs no opinion about what should happen next. Deliberately conservative: a message that reports completion, describes someone else's next step, or says it is waiting on a human or an external system is left alone. Capped at 3 auto-resumes per task, then one escalation to the director; every resume is a visible `auto_resume` task event (`server/src/resume.ts`).

## Web app (the product)

Views (React + Vite + TS; no UI framework dependency heavier than needed; SSE via EventSource to `/api/stream`):
1. **Chief of Staff home**: the default route restores one durable conversation across every project, with a short re-entry briefing above the current director/Chief exchange. Earlier messages collapse behind a history control, detailed agent activity stays under an "Activity and agent details" disclosure, and each consequential question appears as one answerable decision card instead of a prose checklist.
2. **Board**: the Work view has 5 columns (Queued, Working, Needs You, Ready to Merge, Done; Done shows the last 10). `verifying` is the director's accept queue: merged work waits there until a person verifies it, and it appears in the needs-you list with a one-click Accept. Tracking-only tasks live in a separate Tracked view with their external status and logical Hive subtasks; Jira-keyed retry chains collapse to the latest attempt. Jira mirrors are tracking-only and are never dispatched: the work task under a mirror is filed by jira-sync when `config.jira.auto_file` is on, and by hand otherwise. Cards show the title, project chip, agent status dot, last-event age, PR + CI badge, evidence count, and one-line summary. Click → task page. Live reorder via SSE. A prominent **"+ New task"** control (header and/or top of Queued column) has two modes: **Braindump** (default: project select + one textarea; the planner drafts a breakdown that the director approves on a decision card before anything is queued) and **Manual** (project select, title, brief, kind; queues directly). The director queues work directly from the board; it must never require the CLI.
3. **Task page** — brief, live event timeline, evidence gallery (inline images, test-run summaries, links), decisions (open + history), PR/CI panel, final summary. Actions: send steer message, cancel, approve merge.
4. **Needs you**: one shared action queue for open decisions, unacknowledged checkpoints, tasks awaiting review, failed tasks awaiting triage, and dead or stuck work. A project chip row scopes the queue, the backlogs lists, and the activity summary to one project; the top bar and mobile navigation count honours the same filter. A task parked in review or decision state is not counted or rendered again as an agent-health issue. Decisions, checkpoints, reviews, and attention issues are each presented one at a time, with review evidence and diffs behind a disclosure. The same page keeps completions, fleet status, incidents, intake, spend, and learnings under an activity-summary disclosure. Decision notes autosave via debounced PUT; submitting dispatches an event to the owning task's agent via `herdr agent send` and archives the card.
5. **Policies** — list/add/edit/deactivate policies, global and per-project.
6. **Monitors** — per-project monitor status, incident history, open incidents highlighted.

Navigation: a universal search/command trigger, a concise Needs you indicator, and one Browse menu keep every operational view available without placing them beside the current conversation.

Design: dark, calm, conversational, and focused. Localhost tool, no auth except config/secret writes (project settings and secrets ask for the API token once, then remember it). Desktop-first.

## Monitors (D3-B)

- Per-project config: list of `{name, url, expect_status, expect_substring?, interval_s}`.
- Runner in the server; failure → incident row + SSE + native Hive notification + optional auto-task creation (config flag).
- Post-deploy smoke: a task entering `verifying` runs the project's smoke list once; pass → evidence row (test_run), and the task waits for the director; fail → back to `in_progress` with event. Smoke never closes a task.

## CLI (`bin/hive`)

`hive serve` (start daemon), `hive task create --project X --title ... [--brief file]`, `hive task list`, `hive emit <task-id> <type> [--note ...] [--file path]`, `hive decision ask <task-id> --title ... --context ... --risk ... --option key:label:detail --recommend key`, `hive policy add|list`, `hive open` (open board in browser). All thin HTTP wrappers; server is the only writer to the DB.

## Secrets management

Hive never invents crypto. A pluggable secrets provider interface with two backends:
- `keychain` (default): macOS Keychain via the `security` CLI, service-namespaced `hive/<project>/<name>`.
- `bitwarden`: via `bw` CLI (the director's existing vault) for secrets that should live in Bitwarden.

Behavior:
- `secrets(id, project_id, name, provider, ref, created_at)` — the DB stores ONLY references/names, never values.
- Injection: at agent spawn, secrets configured for the project are resolved and passed as env vars to `herdr agent start --env`; briefs list available secret NAMES so agents know what exists without seeing where it came from.
- CLI: `hive secret set|list|rm` (set reads the value from stdin or prompt, writes to the provider, stores the ref).
- Web UI: secrets page shows names, provider, project scope — values are never displayed nor retrievable through the web app or API. No secret value ever appears in events, evidence, logs, or briefs; the server redacts known secret values from any payload it stores.

## Roadmap (versions ship continuously, evidence-gated, no go-ahead needed)

- **v1**: everything above: server core, state machine, board, task pages, Needs you queue (with decision Submit), policies, herdr runtime, reconciler, hooks, monitors + post-deploy smoke, secrets management, CLI.
- **v2** — regression/learning ledger (recurring failures become tracked learnings + auto root-cause tasks; "unblock now, root-cause later" as a first-class flow); intake connectors (Google Chat first: stakeholder messages become draft tasks for triage); notification digests (batched, urgent-decision override, macOS push).
- **v3** — scoped standing-authority policy engine (staging autonomous / prod requires exact-target decision card, enforced server-side before risky actions dispatch); domain supervisors (persistent planner agents per project that triage intake and propose task breakdowns); cost/token analytics per task and per model.
- **v4** — migrate a real project off a prior orchestration tool end to end (dogfood exit criteria); remote access (tailscale-friendly bind + minimal auth); UI polish pass driven by the director's annotations on the live board.

Each version's definition of done: tests green, evidence rows (screenshots + test runs) attached to that version's tracking task in hive itself, then the next version starts immediately.

## Verification of hive itself

- `bun test` covering: state machine (done-without-evidence rejected; all transitions), decision draft persistence, brief composition includes policies, event ingestion endpoints, monitor failure → incident.
- A `scripts/demo-seed.ts` that seeds a fake project + tasks in every state + an open decision + evidence images so the board is reviewable without live agents.
- Definition of done for the build itself: server tests green, web app builds, board renders seeded data live over SSE, decision submit round-trips, `hive emit` works end-to-end.
