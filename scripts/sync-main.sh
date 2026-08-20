#!/bin/bash
# Keep local main <-> origin/main in sync and the live deploy on latest main.
# Runs from launchd (dev.hive.sync) every 5 min. Everything is ff-only /
# push-only: a diverged main is logged loudly and left for a human — that's
# the one state auto-resolution has burned us on (squash-merged reconcile PRs,
# eaten commits from concurrent crew merges).
set -euo pipefail
REPO="$HOME/projects/hive"
LIVE="$HOME/projects/hive-live"
LOG="$HOME/.hive/logs/sync-main.log"
mkdir -p "$(dirname "$LOG")"
exec >>"$LOG" 2>&1

cd "$REPO"
git fetch origin main --quiet
AHEAD=$(git rev-list --count origin/main..main)
BEHIND=$(git rev-list --count main..origin/main)

if [ "$AHEAD" -gt 0 ] && [ "$BEHIND" -gt 0 ]; then
  echo "[$(date '+%F %T')] DIVERGED: local main +$AHEAD / origin/main +$BEHIND — not touching it; reconcile by MERGE COMMIT (never squash), see docs"
  exit 1
fi
if [ "$BEHIND" -gt 0 ]; then
  # ff-only refuses if the working tree blocks it (untracked collisions etc.)
  git merge --ff-only origin/main --quiet
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
  (cd electron && bun install --silent >/dev/null && bun run build >/dev/null)
  # bun --watch hot reload is unreliable; always kickstart after a live merge
  launchctl kickstart -k "gui/$(id -u)/dev.hive.server"
  # The desktop app keeps its existing Chromium renderer across server deploys.
  # Restart it when it is already open so the user sees the deployed assets.
  APP="$LIVE/electron/dist/mac-arm64/hive.app"
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
