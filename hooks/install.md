# hive Claude Code hooks

These hooks give hive a **zero-discipline** liveness signal: even if an agent
never calls `hive emit`, hive still sees Stop / SubagentStop / tool activity and
keeps the board current. They are the second of hive's three redundant event
paths (emit CLI, hooks, reconciler).

## What they do

`hive-hook.sh <event-label>` POSTs a `status` event (`source: "hook"`) to
`$HIVE_URL/api/tasks/$HIVE_TASK_ID/events` — but only when `$HIVE_TASK_ID` is
set. The herdr spawn adapter injects `HIVE_TASK_ID` and `HIVE_URL` into every
agent it starts (`herdr agent start ... --env HIVE_TASK_ID=<id> --env HIVE_URL=...`),
so the hooks activate automatically for hive-spawned agents and stay silent
everywhere else.

The script fails silent and fast: any error exits 0, curl is capped at 2s, and
it never blocks the agent.

## Token/cost usage (Stop hook)

On `Stop` / `SubagentStop`, `hive-hook.sh` also reports **per-model token usage**
to hive's analytics via `report-usage.ts` (run with Bun).

The finding, honestly: the Stop-hook **stdin payload does not contain token
counts** — it carries `session_id`, `transcript_path`, `cwd`, `hook_event_name`,
and `stop_hook_active`. But `transcript_path` points at the session's JSONL, and
every assistant line there has a `message.usage` block
(`input_tokens`, `output_tokens`, `cache_read_input_tokens`,
`cache_creation_input_tokens`) plus `message.model`. So the usage IS available —
one indirection away. `report-usage.ts` reads the transcript, aggregates per
model, and POSTs a `usage` event per model.

Caveat: it sums the whole transcript on each Stop. That is correct for hive's
one-shot `claude -p` agents (Stop fires once). In a long interactive session
with repeated Stops it would double-count — add a per-session line cursor if you
ever wire these hooks into interactive use. `cache_creation_input_tokens` is
folded into `input_tokens` (hive's `usage` schema has no cache-write bucket).

If you prefer not to rely on transcript parsing, drop `report-usage.ts` and have
agents report usage directly via the `usage` event on
`POST /api/tasks/:id/events` (path (a) — the primary, harness-independent path).

## Wiring (settings.json)

The spawn adapter runs `claude -p <brief>` inside the worktree, so Claude Code
reads the project (or user) `settings.json`. Add:

```json
{
  "hooks": {
    "Stop": [
      { "hooks": [ { "type": "command", "command": "/ABSOLUTE/PATH/hooks/hive-hook.sh Stop" } ] }
    ],
    "SubagentStop": [
      { "hooks": [ { "type": "command", "command": "/ABSOLUTE/PATH/hooks/hive-hook.sh SubagentStop" } ] }
    ],
    "PostToolUse": [
      { "matcher": "Bash|Write|Edit", "hooks": [ { "type": "command", "command": "/ABSOLUTE/PATH/hooks/hive-hook.sh PostToolUse" } ] }
    ]
  }
}
```

Replace `/ABSOLUTE/PATH` with the absolute path to this repo. `PostToolUse` is
scoped to the state-changing tools (`Bash|Write|Edit`) so the board sees real
progress without a flood of read-only tool calls; drop it if you only want
start/stop signals.

## Make it executable

```bash
chmod +x hooks/hive-hook.sh
```

## Verify

```bash
HIVE_TASK_ID=<some-task-id> HIVE_URL=http://127.0.0.1:4700 \
  echo '{}' | hooks/hive-hook.sh Stop
# then check the task timeline for a `status` event with source "hook".
```
