# Hive v1 — Specification

Hive is a local-first orchestration control plane. David (the director) delegates work to AI agents and interacts only through a kanban web app and a decision inbox. Hive owns durable state, event-driven supervision, evidence, policies, and verification. It is a NEW system: it borrows ideas from firstmate (worktree isolation, evidence-gated done, option-menu decisions) and lavish (annotate/respond loop, SSE, action-only surfaces) but shares no code with them.

Decisions locked 2026-07-08: new system using herdr as agent runtime (D1), SQLite state store (D2), v1 includes smoke checks + health monitors (D3-B), build approved (D4-A).

## Non-negotiable product rules (from pain-point analysis)

1. Status is push, never pull. The board is always current (SSE). David never types "status?".
2. No task reaches Done without evidence. The state machine enforces it.
3. Every decision card carries: two-sentence what/why, options with recommendation + rationale first, risk + blast radius (prod? reversible? exact target named), inline evidence, and an explicit SUBMIT button. Drafts are saved server-side on every keystroke and never lost.
4. Standing preferences are policies stored in the DB and injected into every agent brief automatically. Nothing is repeated because a context window compacted.
5. Supervision is the daemon's job, not an LLM's. Event-driven first (herdr status waits, Claude Code hooks, `hive emit`), plus a coarse time-based reconciler as fallback. No terminal scraping, no busy-signature regexes, ever.
6. High-risk actions (prod deploys, feature flags, destructive ops) require a decision card that names the exact target before execution.
7. Action-only surfaces: resolved decisions auto-archive; the inbox only shows what needs David.
8. Future-proofness over shortcuts. Root-cause fixes, clean seams, boring durable tech. Never skip or shrink work because it "would take too long" — effort cost is not a valid argument in this project, and time estimates are never given. Push through.
9. Versions ship continuously without waiting for a go-ahead. Each version ends with evidence (green tests, screenshots, a working demo recorded as evidence rows in hive itself), then work proceeds directly to the next version. David is interrupted only by genuine decision cards.

## Architecture

```
herdr agents (worktree-isolated)      Claude Code hooks       reconciler (timer)
        \                                    |                      /
         \-- hive emit CLI (HTTP) --->  hive-server (Bun + SQLite + SSE)
                                             |
                          web app (kanban board / task pages / decision inbox)
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
- `tasks(id TEXT pk, project_id, title, brief, state, kind, agent_target, worktree_path, branch, pr_url, ci_status, summary, created_at, updated_at)`
  - `state ∈ {queued, in_progress, needs_decision, in_review, verifying, done, failed, cancelled}`
  - `kind ∈ {ship, scout, chore}` (scout = knowledge only, done requires a report as evidence)
- `events(id, task_id, ts, source ∈ {agent, hook, herdr, reconciler, monitor, director, system}, type, payload JSON)` — append-only timeline; every state change writes an event.
- `evidence(id, task_id, ts, kind ∈ {screenshot, test_run, log, report, link}, path, url, caption, meta JSON)` — files copied into `~/.hive/evidence/<task_id>/`, served at `/evidence/...`. Never local-path-only, never gitignored-and-lost.
- `decisions(id, task_id, ts, title, context, risk, blast_radius, options JSON [{key,label,detail,recommended}], status ∈ {open, answered, expired}, answer_key, answer_note, draft_note, answered_at)`
- `policies(id, scope ∈ {global, project:<id>}, title, body, active, created_at, updated_at)` — injected into briefs; editable in the web UI.
- `incidents(id, project_id, monitor, ts, status ∈ {open, resolved}, detail)` — monitor failures; open incidents can auto-create tasks.

State machine (server-enforced):
- `queued → in_progress` (agent spawned) → `needs_decision ⇄ in_progress` → `in_review` (PR open) → `verifying` (post-merge checks) → `done`.
- Transition to `done` REJECTED unless ≥1 evidence row exists for the task (scouts: kind=report).
- Any state → `failed`/`cancelled` allowed, with reason event.

## Event ingestion (three redundant paths)

1. `hive emit` CLI → `POST /api/tasks/:id/events` — semantic events from agents: `status`, `evidence` (with file upload), `needs-decision` (creates decision row), `done`, `blocked`. Briefs instruct agents to use it.
2. Claude Code hooks (`hooks/`) — Stop/SubagentStop/PostToolUse hooks that POST lifecycle events when `HIVE_TASK_ID` is set in the agent's env. Zero agent discipline required.
3. Reconciler (in-server, every 60s): `herdr agent list` + `herdr agent get` to sync live agent status; `gh pr view --json` for tasks with a PR to sync CI/merge state; flags tasks silent > configurable threshold with a `stale` event and a director notification.

## herdr runtime adapter (`server/src/runtime/herdr.ts`)

- Spawn: `herdr worktree create --cwd <repo> --branch hive/<task-id> --json` then `herdr agent start <task-id> --cwd <worktree> --env HIVE_TASK_ID=<id> --env HIVE_URL=... --no-focus -- claude -p <brief-file> --permission-mode acceptEdits` (exact argv per-project configurable).
- Brief composition (`server/src/briefs.ts`): task brief = task description + definition of done + `hive emit` protocol instructions + ALL active global policies + project policies + project playbook. Composed fresh at spawn time.
- Watch: after spawn, the server runs `herdr agent wait <target> --status blocked|idle|done --timeout <ms>` in a supervised loop (each wait completion re-arms; errors fall back to reconciler polling). Status changes become events.
- Steer: `POST /api/tasks/:id/send` → `herdr agent send`.
- Teardown on done/cancelled: `herdr worktree remove` only after PR merged or branch pushed (verify with git; refuse otherwise).

## Web app (the product)

Views (React + Vite + TS; no UI framework dependency heavier than needed; SSE via EventSource to `/api/stream`):
1. **Board** — 6 columns (Queued, In Progress, Needs Decision, In Review, Verifying, Done — Done shows last 10). Cards: title, project chip, agent status dot, last-event age, PR + CI badge, evidence count, one-line summary. Click → task page. Live reorder via SSE. A prominent **"+ New task"** control (header and/or top of Queued column): project select, title, brief, kind — David queues work directly from the board; it must never require the CLI.
2. **Task page** — brief, live event timeline, evidence gallery (inline images, test-run summaries, links), decisions (open + history), PR/CI panel, final summary. Actions: send steer message, cancel, approve merge.
3. **Decision inbox** — open decision cards per product rule 3, newest first, badge count in nav. Radio options + note textarea (draft autosaved via debounced PUT) + Submit button. Submitting dispatches an event to the owning task's agent via `herdr agent send` and archives the card.
4. **Policies** — list/add/edit/deactivate policies, global and per-project.
5. **Monitors** — per-project monitor status, incident history, open incidents highlighted.

Design: dark, calm, dense-but-readable. Localhost tool, no auth. Desktop-first.

## Monitors (D3-B)

- Per-project config: list of `{name, url, expect_status, expect_substring?, interval_s}`.
- Runner in the server; failure → incident row + SSE + macOS notification (`osascript`) + optional auto-task creation (config flag).
- Post-deploy smoke: a task entering `verifying` runs the project's smoke list once; pass → evidence row (test_run) + eligible for done; fail → back to `in_progress` with event.

## CLI (`bin/hive`)

`hive serve` (start daemon), `hive task create --project X --title ... [--brief file]`, `hive task list`, `hive emit <task-id> <type> [--note ...] [--file path]`, `hive decision ask <task-id> --title ... --context ... --risk ... --option key:label:detail --recommend key`, `hive policy add|list`, `hive open` (open board in browser). All thin HTTP wrappers; server is the only writer to the DB.

## Secrets management

Hive never invents crypto. A pluggable secrets provider interface with two backends:
- `keychain` (default): macOS Keychain via the `security` CLI, service-namespaced `hive/<project>/<name>`.
- `bitwarden`: via `bw` CLI (David's existing vault) for secrets that should live in Bitwarden.

Behavior:
- `secrets(id, project_id, name, provider, ref, created_at)` — the DB stores ONLY references/names, never values.
- Injection: at agent spawn, secrets configured for the project are resolved and passed as env vars to `herdr agent start --env`; briefs list available secret NAMES so agents know what exists without seeing where it came from.
- CLI: `hive secret set|list|rm` (set reads the value from stdin or prompt, writes to the provider, stores the ref).
- Web UI: secrets page shows names, provider, project scope — values are never displayed nor retrievable through the web app or API. No secret value ever appears in events, evidence, logs, or briefs; the server redacts known secret values from any payload it stores.

## Roadmap (versions ship continuously, evidence-gated, no go-ahead needed)

- **v1** — everything above: server core, state machine, board, task pages, decision inbox (with Submit), policies, herdr runtime, reconciler, hooks, monitors + post-deploy smoke, secrets management, CLI.
- **v2** — regression/learning ledger (recurring failures become tracked learnings + auto root-cause tasks; "unblock now, root-cause later" as a first-class flow); intake connectors (Google Chat first: stakeholder messages become draft tasks for triage); notification digests (batched, urgent-decision override, macOS push).
- **v3** — scoped standing-authority policy engine (staging autonomous / prod requires exact-target decision card, enforced server-side before risky actions dispatch); domain supervisors (persistent planner agents per project that triage intake and propose task breakdowns); cost/token analytics per task and per model.
- **v4** — migrate a real project off firstmate end to end (dogfood exit criteria); remote access (tailscale-friendly bind + minimal auth); UI polish pass driven by David's annotations on the live board.

Each version's definition of done: tests green, evidence rows (screenshots + test runs) attached to that version's tracking task in hive itself, then the next version starts immediately.

## Verification of hive itself

- `bun test` covering: state machine (done-without-evidence rejected; all transitions), decision draft persistence, brief composition includes policies, event ingestion endpoints, monitor failure → incident.
- A `scripts/demo-seed.ts` that seeds a fake project + tasks in every state + an open decision + evidence images so the board is reviewable without live agents.
- Definition of done for the build itself: server tests green, web app builds, board renders seeded data live over SSE, decision submit round-trips, `hive emit` works end-to-end.
