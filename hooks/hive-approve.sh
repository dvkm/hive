#!/usr/bin/env bash
# Claude Code / Codex command hook -> hive command auto-approval.
#
# Reads a PreToolUse or PermissionRequest payload on stdin and hands it to
# classify.ts, which emits the event's decision JSON on stdout. SAFE commands
# auto-approve with no dialog; DANGEROUS and (by default) UNKNOWN commands
# escalate to hive's authority engine via the guarded-action gate.
#
# Usage (from settings.local.json): hive-approve.sh <policy>
#   policy = escalate (default) | allow | prompt  — governs UNKNOWN commands.
#
# Contract: NEVER block the agent. If classification can't run, exit 0 with no
# output so Claude Code falls back to its normal permission flow.

POLICY="${1:-escalate}"
INPUT="$(cat 2>/dev/null || true)"

BUN="$(command -v bun || echo "$HOME/.bun/bin/bun")"
DIR="$(cd "$(dirname "$0")" && pwd)"

printf '%s' "$INPUT" | "$BUN" "$DIR/classify.ts" "$POLICY" 2>/dev/null || true
exit 0
