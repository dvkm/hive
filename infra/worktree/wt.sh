#!/usr/bin/env bash
# Per-worktree bootstrap for hive task agents. Unlike Corebeat's stack, hive is a
# bun server + SQLite with NO docker stack, so "up" just makes a fresh worktree
# buildable/testable by installing its deps; "down" is a best-effort no-op —
# removing the worktree IS the whole teardown, there are no per-worktree
# containers to orphan (the 256-orphaned-container class of bug can't happen here).
#
# Wired via the project's spawn/cleanup hooks (projects.config in hive.db):
#   config.setup_argv   = ["infra/worktree/wt.sh", "up",   "{worktree}"]
#   config.cleanup_argv = ["infra/worktree/wt.sh", "down", "{worktree}"]
# The hook (runStackCmd, server/src/cleanup.ts) runs with cwd = the MAIN checkout
# and passes the target worktree path as $2, so this script MUST cd into it. It is
# best-effort with a hard 120s timeout upstream, idempotent, and never fails a
# spawn or a teardown — mirroring Corebeat's infra/worktree/wt.sh arg contract.
#
#   wt.sh up   [worktree]   install deps into the worktree (idempotent, ~no-op if present)
#   wt.sh down [worktree]   no-op today; the home for teardown if hive ever grows a stack
set -uo pipefail

TARGET="$(cd "${2:-$(git rev-parse --show-toplevel 2>/dev/null)}" 2>/dev/null && pwd || true)"
[ -n "${TARGET:-}" ] || { echo "wt.sh: cannot resolve worktree path '${2:-}'" >&2; exit 0; }

up() {
  echo "==> hive worktree bootstrap: $TARGET"
  if [ -d "$TARGET/node_modules" ]; then
    echo "   deps present — nothing to do"
    return 0
  fi
  echo "==> bun install"
  # ponytail: bun only; hive has no other install step. Best-effort — a failed
  # install warns but never blocks the spawn (the agent can re-run it by hand).
  ( cd "$TARGET" && bun install ) || echo "   WARNING: bun install failed; run it manually in the worktree" >&2
}

down() {
  # ponytail: nothing to tear down — hive spins up no per-worktree containers, so
  # worktree removal is the whole teardown. Kept so cleanup_argv has a valid,
  # symmetric target and a home if hive ever grows a stack.
  echo "==> hive worktree teardown: $TARGET (no stack to remove)"
}

case "${1:-up}" in
  up)   up ;;
  down) down ;;
  *) echo "usage: $0 {up|down} [worktree-path]"; exit 1 ;;
esac
