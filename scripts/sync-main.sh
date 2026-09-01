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

# Path of the worktree that has main checked out, if any. $LIVE first: it is the
# deploy checkout and the one that matters, and a stray review worktree can hold
# main too (a --force checkout).
main_worktree() {
  if [ "$(git -C "$LIVE" branch --show-current 2>/dev/null)" = "main" ]; then
    echo "$LIVE"
    return
  fi
  git worktree list --porcelain |
    awk '/^worktree /{p=$2} /^branch refs\/heads\/main$/{print p; exit}'
}

cd "$REPO"
git fetch origin main --quiet
# Captured BEFORE the sync below, which fast-forwards $LIVE itself when main is
# checked out there. The rebuild/restart has to key off whether the live
# checkout actually moved, not off which step moved it.
LIVE_BEFORE=$(git -C "$LIVE" rev-parse HEAD)
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
  elif MAIN_WT=$(main_worktree) && [ -n "$MAIN_WT" ]; then
    # HIVE-548: this arm used to log "not updating its ref behind that
    # checkout" and exit 1 — it did that 1093 times over 5 days while the live
    # server ran 30-commit-stale code, so every hive fix merged in that window
    # was dead code. Refusing to move the REF was never the point: git only
    # blocks moving a branch out from under a checkout, and a fast-forward
    # INSIDE that checkout moves the ref and the working tree together, which
    # is exactly what the deploy wants. Still ff-only, so a dirty or diverged
    # live tree refuses loudly instead of being reset.
    if ! git -C "$MAIN_WT" merge --ff-only "$ORIGIN_MAIN" --quiet; then
      echo "[$(date '+%F %T')] STALE DEPLOY: live checkout $MAIN_WT is $BEHIND commit(s) behind origin/main and NOT being updated — fast-forward refused (dirty or diverged working tree). The running server stays on old code until a human fixes that tree."
      exit 1
    fi
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
# "HEAD != FETCH_HEAD" is true in BOTH directions. When the live checkout is
# AHEAD of main (a hotfix committed straight into it, or a manual merge commit)
# the ff-merge below is a no-op, HEAD never reaches FETCH_HEAD, and every
# 5-minute tick rebuilt and `kickstart -k`ed the server forever. On 2026-08-25
# that restarted the live server 14 times on one unchanged sha (44eb218) and 9
# more on d50db56, each restart a fresh pid and a multi-minute outage on :4700.
# Deploy only when main actually carries something live does not have; a real
# divergence still reaches the ff-merge and still fails loudly.
if ! git merge-base --is-ancestor FETCH_HEAD HEAD; then
  git merge --ff-only FETCH_HEAD --quiet
fi
# HIVE-548: the sync step above may already have fast-forwarded this checkout
# (that is how main advances when main is checked out here), so the ff-merge is
# often a no-op by the time we reach it. Gate the deploy on the sha the live
# checkout started this run with.
if [ "$(git rev-parse HEAD)" != "$LIVE_BEFORE" ]; then
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
