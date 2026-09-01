#!/usr/bin/env bash
# Run a command against a throwaway hive server that CANNOT outlive it.
#
#   scripts/smoke-server.sh curl -sS "$HIVE_URL/api/stats/autonomy?days=7"
#
# INCIDENT 2026-08-25: two agent smoke servers (pids 29704, 86018) were started
# by hand, outlived the test that spawned them, and kept sweeping. Each ran an
# old checkout against its own scratch DB, saw no row for the live fleet, and
# closed every pane on the machine as an "orphan". The fleet died twice.
#
# Three things stop a repeat, and this script does all three:
#   1. Own process group + trap. `set -m` puts the server in its own group, so
#      the trap kills the server AND anything it spawned, on every exit path
#      (success, failure, Ctrl-C, kill). A bare `kill $pid` leaks the children.
#   2. Scratch DB, never the fleet DB. fleetDbBlocked() (server/src/teardownGuard.ts)
#      refuses every teardown from a server that is not on the fleet's own DB, so
#      even a survivor cannot reap panes. That gate is the real fix; this is belt.
#   3. Survivor check. After the command, assert nothing is still listening on
#      our port. Exits non-zero and names the pid if something outlived us.
set -euo pipefail
set -m

PORT="${SMOKE_PORT:-4799}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# SMOKE_DB lets you point at a COPY of a real DB to smoke against real data. We
# only delete a DB we created ourselves. Never pass the fleet's own DB: this
# server would then hold a lease on it and be allowed to tear the fleet down.
if [[ -n "${SMOKE_DB:-}" ]]; then DB="$SMOKE_DB"; OWN_DB=""; else DB="$(mktemp -t hive-smoke-XXXXXX).db"; OWN_DB=1; fi

cleanup() {
  local code=$?
  if [[ -n "${SERVER_PID:-}" ]]; then
    # Negative pid = the whole process group, so children die with the parent.
    kill -TERM -"$SERVER_PID" 2>/dev/null || kill -TERM "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  [[ -n "$OWN_DB" ]] && rm -f "$DB" "$DB-wal" "$DB-shm"
  rm -f "$DB.log"
  # Requirement (2) from the incident: prove no server outlived the run.
  local survivor
  survivor="$(lsof -ti tcp:"$PORT" 2>/dev/null || true)"
  if [[ -n "$survivor" ]]; then
    echo "smoke-server: LEAK - pid(s) $survivor still on port $PORT" >&2
    exit 1
  fi
  exit $code
}
trap cleanup EXIT INT TERM

HIVE_DB="$DB" HIVE_PORT="$PORT" bun run "$ROOT/server/src/index.ts" >"$DB.log" 2>&1 &
SERVER_PID=$!

export HIVE_URL="http://127.0.0.1:$PORT"
for _ in $(seq 1 50); do
  curl -sS -o /dev/null -m 1 "$HIVE_URL/api/health" 2>/dev/null && break
  kill -0 "$SERVER_PID" 2>/dev/null || { echo "smoke-server: server died on boot" >&2; cat "$DB.log" >&2; exit 1; }
  sleep 0.2
done

"$@"
