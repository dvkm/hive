#!/bin/bash
# Local-deploy helper for a launchd-managed hive install. Optional: only
# useful if you run hive this way on your own machine.
# Keep local main <-> origin/main in sync and the live deploy on latest main.
# Runs from launchd (dev.hive.sync) every 5 min. Everything is ff-only /
# push-only: a diverged main is logged loudly and left for a human — that's
# the one state auto-resolution has burned us on (squash-merged reconcile PRs,
# eaten commits from concurrent crew merges).
set -euo pipefail

case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
    exec powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$(cygpath -w "$SCRIPT_DIR/sync-main.ps1")"
    ;;
esac

REPO="${HIVE_SYNC_REPO:-$HOME/projects/hive}"
LIVE="${HIVE_SYNC_LIVE:-$HOME/projects/hive-live}"
LOG="${HIVE_SYNC_LOG:-$HOME/.hive/logs/sync-main.log}"
mkdir -p "$(dirname "$LOG")"
exec >>"$LOG" 2>&1

cd "$REPO"
git fetch origin main --quiet
MAIN_BEFORE=$(git rev-parse refs/heads/main)
ORIGIN_MAIN=$(git rev-parse refs/remotes/origin/main)
AHEAD=$(git rev-list --count "$ORIGIN_MAIN..$MAIN_BEFORE")
BEHIND=$(git rev-list --count "$MAIN_BEFORE..$ORIGIN_MAIN")

if [ "$AHEAD" -gt 0 ] && [ "$BEHIND" -gt 0 ]; then
  echo "[$(date '+%F %T')] DIVERGED: local main +$AHEAD / origin/main +$BEHIND — not touching it; reconcile by MERGE COMMIT (never squash), see docs"
  exit 1
fi
if [ "$BEHIND" -gt 0 ]; then
  if [ "$(git branch --show-current)" = "main" ]; then
    # ff-only refuses if the working tree blocks it (untracked collisions etc.)
    git merge --ff-only "$ORIGIN_MAIN" --quiet
  elif git worktree list --porcelain | grep -qx "branch refs/heads/main"; then
    echo "[$(date '+%F %T')] main is checked out in another worktree; not updating its ref behind that checkout"
    exit 1
  else
    # The launchd job often runs while the primary checkout is on a feature
    # branch. Advance the named main ref, not whichever branch happens to be
    # checked out.
    git fetch . "$ORIGIN_MAIN:refs/heads/main" --quiet
  fi
  echo "[$(date '+%F %T')] pulled $BEHIND commit(s) from origin/main -> $(git rev-parse --short main)"
fi
if [ "$AHEAD" -gt 0 ]; then
  git push origin main --quiet
  echo "[$(date '+%F %T')] pushed $AHEAD commit(s) to origin/main -> $(git rev-parse --short main)"
fi

# Deploy: ff hive-live to main, rebuild, restart — only when it actually moved.
cd "$LIVE"
git fetch "$REPO" main --quiet
if [ "$(git rev-parse HEAD)" != "$(git rev-parse FETCH_HEAD)" ]; then
  git merge --ff-only FETCH_HEAD --quiet
  (cd server && bun install --silent >/dev/null)
  (cd web && bun install --silent >/dev/null && bun run build >/dev/null)
  # Non-fatal: a failed /Applications write must not strand the server on old
  # code — the ff-merge already happened, so a hard exit here is never retried.
  (cd electron && bun install --silent >/dev/null && bun run install-app >/dev/null) ||
    echo "[$(date '+%F %T')] WARNING: electron install-app failed; /Applications/hive.app is stale"
  # bun --watch hot reload is unreliable; always kickstart after a live merge
  launchctl kickstart -k "gui/$(id -u)/dev.hive.server"
  # kickstart -k kills the JOB, not the tree: on 2026-08-19 four `bun --watch`
  # workers survived it by re-parenting to launchd and kept running reconcilers
  # against the shared DB for 14 hours (they held no port, so nothing noticed).
  # The DB lease now makes any survivor stand down within a heartbeat once the
  # new server boots — this is the check that it actually happened. Never kills:
  # a stray that outlives the grace is a real bug and must be seen, not hidden.
  # `|| true` on every pgrep: it exits 1 when nothing matches, and pipefail
  # would take the whole deploy script down with it.
  for _ in {1..20}; do
    SERVERS=$( (pgrep -f "bun --watch server/src/index.ts" || true) | wc -l | tr -d ' ')
    [ "$SERVERS" = "1" ] && break
    sleep 1
  done
  if [ "${SERVERS:-0}" != "1" ]; then
    echo "[$(date '+%F %T')] WARNING: $SERVERS hive server processes alive 20s after kickstart (expected 1) — $( (pgrep -fl 'bun --watch server/src/index.ts' || true) | tr '\n' ';')"
  fi
  # The desktop app keeps its existing Chromium renderer across server deploys.
  # Restart it when it is already open so the user sees the deployed assets.
  APP="/Applications/hive.app"
  if pgrep -f "$APP/Contents/MacOS/hive" >/dev/null; then
    osascript -e 'tell application id "dev.hive.app" to quit' || true
    for _ in {1..50}; do
      pgrep -f "$APP/Contents/MacOS/hive" >/dev/null || break
      sleep 0.1
    done
    open "$APP"
    for _ in {1..50}; do
      pgrep -f "$APP/Contents/MacOS/hive" >/dev/null && break
      sleep 0.1
    done
    pgrep -f "$APP/Contents/MacOS/hive" >/dev/null
  fi
  echo "[$(date '+%F %T')] deployed $(git rev-parse --short HEAD) (server and open desktop app restarted)"
fi
