#!/usr/bin/env bash
# Claude Code lifecycle hook -> hive.
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

# Claude Code passes hook JSON on stdin; drain it, we only need a coarse signal.
cat >/dev/null 2>&1 || true

curl -s -m 2 -X POST "$HIVE_URL/api/tasks/$HIVE_TASK_ID/events" \
  -H 'Content-Type: application/json' \
  -d "{\"type\":\"status\",\"source\":\"hook\",\"note\":\"hook: $EVENT\"}" \
  >/dev/null 2>&1 || true

exit 0
