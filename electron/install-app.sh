#!/bin/bash
# Installs the built hive.app to the canonical location and fixes LaunchServices.
# HIVE_APP_DEST / LSREGISTER are overridable so this is testable without touching
# /Applications or the real LaunchServices database.
set -e
src="$(cd "$(dirname "$0")" && pwd)/dist/mac-arm64/hive.app"
dest="${HIVE_APP_DEST:-/Applications/hive.app}"
lsregister="${LSREGISTER:-/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister}"
trap 'rm -rf "$dest.new"' EXIT

[ -d "$src" ] || { echo "no built app at $src — run 'bun run build' in electron/ first" >&2; exit 1; }

rm -rf "$dest.new"
ditto "$src" "$dest.new"
rm -rf "$dest"
mv "$dest.new" "$dest"
# ponytail: registration is best-effort; a stale LaunchServices db must not fail the install
"$lsregister" -f "$dest" || true
"$lsregister" -u "$src" || true
