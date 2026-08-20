#!/usr/bin/env bash
# Claude Code / Codex lifecycle hook -> hive.
#
# POSTs a status event to $HIVE_URL for the current task when $HIVE_TASK_ID is
# set (the herdr spawn adapter injects both env vars). This gives hive a
# zero-discipline liveness signal even if the agent never runs `hive emit`.
#
# Contract: fail silent, fail fast, NEVER block the agent. Any error -> exit 0.
# curl is capped at 2s. If $HIVE_TASK_ID is unset the hook is a no-op.
#
# Usage (from settings.json): hive-hook.sh <event-label>
#   e.g. hive-hook.sh Stop | hive-hook.sh SubagentStop | hive-hook.sh PostToolUse

[ -z "$HIVE_TASK_ID" ] && exit 0

HIVE_URL="${HIVE_URL:-http://127.0.0.1:4700}"
EVENT="${1:-Stop}"

# The agent passes hook JSON on stdin; capture it (transcript reporting + usage
# below both need it).
INPUT="$(cat 2>/dev/null || true)"

BUN="$(command -v bun || echo "$HOME/.bun/bin/bun")"
DIR="$(cd "$(dirname "$0")" && pwd)"

# Every fire: extract the agent's NEW transcript turns (assistant text +
# tool_use) since the per-transcript cursor and post them to hive. This is what
# fills the timeline; the old bare "hook: <event>" status POST is gone (noise).
printf '%s' "$INPUT" | "$BUN" "$DIR/report-transcript.ts" >/dev/null 2>&1 || true

# On (Subagent)Stop: report per-model token usage, and record a lightweight
# lifecycle heartbeat (agent_turn_end) so the reconciler/health still see agent
# activity — without the "hook: Stop" noise. The label rides along in the
# payload: only a real Stop means the AGENT's turn ended, and hive's auto-resume
# check must not fire when a subagent finishes mid-turn.
if [ "$EVENT" = "Stop" ] || [ "$EVENT" = "SubagentStop" ]; then
  printf '%s' "$INPUT" | "$BUN" "$DIR/report-usage.ts" >/dev/null 2>&1 || true
  curl -s -m 2 -X POST "$HIVE_URL/api/tasks/$HIVE_TASK_ID/events" \
    -H 'Content-Type: application/json' \
    -d "{\"type\":\"agent_turn_end\",\"source\":\"hook\",\"payload\":{\"hook\":\"$EVENT\"}}" \
    >/dev/null 2>&1 || true
fi

# Codex Stop hooks require JSON output. Claude ignores this empty decision.
[ "$HIVE_AGENT" = "codex" ] && printf '{}\n'

exit 0
