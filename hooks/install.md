# hive Claude Code hooks

These hooks give hive a **zero-discipline** liveness signal: even if an agent
never calls `hive emit`, hive still sees Stop / SubagentStop / tool activity and
keeps the board current. They are the second of hive's three redundant event
paths (emit CLI, hooks, reconciler).

## What they do

On every fire (`PostToolUse`, `Stop`, `SubagentStop`), `hive-hook.sh <event-label>`
reads the `transcript_path` from the hook's stdin payload and extracts the agent's
**new turns since a per-transcript cursor** (`report-transcript.ts`), POSTing them
to `$HIVE_URL/api/tasks/$HIVE_TASK_ID/events`:

- assistant text blocks → `assistant_text` events (the agent's actual output —
  rendered as transcript bubbles on the task timeline).
- assistant `tool_use` blocks → `tool_use` events carrying a cheap one-line
  `summary` (the command for Bash, the file_path for Read/Edit, the pattern for
  Grep — never the full input). The UI groups consecutive ones into "used N tools".

On `Stop`/`SubagentStop` it also posts a quiet `agent_turn_end` heartbeat (so the
reconciler/health still see liveness) and reports token usage (below). This all
runs only when `$HIVE_TASK_ID` is set — the herdr spawn adapter injects
`HIVE_TASK_ID` and `HIVE_URL` into every agent it starts
(`herdr agent start ... --env HIVE_TASK_ID=<id> --env HIVE_URL=...`), so the hooks
activate automatically for hive-spawned agents and stay silent everywhere else.

**Dedup / cursor**: a sibling `<transcript_path>.hive-cursor` file stores the
number of transcript lines already processed. Each fire only posts lines past the
cursor, so nothing double-posts even though `PostToolUse` and `Stop` both read the
same append-only transcript. If the transcript is truncated/rotated (line count
drops below the cursor) it resyncs from the start.

There is no more bare `status` "hook: <event>" POST — it was pure timeline noise.

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
# Point the payload at a real Claude Code transcript JSONL:
export HIVE_TASK_ID=<some-task-id> HIVE_URL=http://127.0.0.1:4700
printf '{"transcript_path":"/path/to/transcript.jsonl"}' | hooks/hive-hook.sh Stop
# then check the task timeline for `assistant_text` / `tool_use` events (source "hook").
```

## Command auto-approval (PreToolUse classifier)

`hive-approve.sh` + `classify.ts` are a **PreToolUse** hook that keeps an
autonomous worker from hanging on a Bash permission dialog. `writeHookSettings`
wires them into every spawned worktree automatically (alongside the static
`permissions.allow` list); this section documents the contract.

`classify.ts` (pure, unit-tested in `server/test/classify.test.ts`) sorts a
command into **safe** / **dangerous** / **unknown**:

- **safe** — read-only / standard-dev (`ls`, `cat`, `grep`, `git status/diff/log`,
  `bun test`, `bun run`, ...); every shell segment must match the safe allowlist,
  there must be no dangerous token anywhere, and no command substitution
  (`$(...)`, backticks) — those escalate.
- **dangerous** — a destructive denylist (`rm -rf`, `sudo`, `curl … | sh`,
  `git push --force`, `git reset --hard`, `DROP/TRUNCATE`, `DELETE`/`UPDATE`
  without `WHERE`, fork bomb, `mkfs`/`dd of=`, device/system writes, `kill`,
  `terraform apply/destroy`, `kubectl delete`, credential files, ...). Checked
  against the WHOLE command first, so a dangerous token after `;`/`&&`/`|` still
  trips it. NEVER auto-allowed.
- **unknown** — anything not provably safe. Conservative by design: when unsure, a
  command is not safe.

**PreToolUse output contract** (stdout, exit 0):
```json
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"..."}}
```
`permissionDecision` is `allow` or `deny`. No output + exit 0 = defer to Claude
Code's normal permission flow. The hook never emits exit 2; any internal error
exits 0 so the agent is never crashed.

**Routing**: safe → `allow`. dangerous + unknown → `POST guarded-action` (action
`command.dangerous` vs `command`); the response maps `200 allow`→allow,
`403 deny`→deny, `409 require_decision`→deny with `escalated to hive decision <id>`
(retry the same command once the director approves; a single-use grant lets it
through). **Fail-safe**: hive unreachable → `deny` (2s curl cap).

**`command_approval` policy** (project `config`, passed as the hook argument)
governs UNKNOWN commands only: `escalate` (default) | `allow` | `prompt`.
Dangerous always escalates.

### Wiring (settings.local.json)

```json
{
  "permissions": { "allow": ["Read", "Bash(git status:*)", "Bash(bun test:*)"], "deny": ["mcp__claude-in-chrome"] },
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [ { "type": "command", "command": "/ABSOLUTE/PATH/hooks/hive-approve.sh escalate" } ] }
    ]
  }
}
```

### Verify

```bash
chmod +x hooks/hive-approve.sh hooks/classify.ts
export HIVE_TASK_ID=<task-id> HIVE_URL=http://127.0.0.1:4700
# safe → allow:
printf '{"tool_name":"Bash","tool_input":{"command":"ls -la"}}' | hooks/hive-approve.sh escalate
# dangerous → escalates to guarded-action (deny unless a standing grant/rule allows):
printf '{"tool_name":"Bash","tool_input":{"command":"rm -rf /"}}' | hooks/hive-approve.sh escalate
```

To actually STOP dangerous commands (not just log them), seed an authority rule:
`POST /api/authority/rules {"action_pattern":"command.dangerous*","effect":"require_decision"}`.
