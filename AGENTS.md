# Hive repository workflow

After verified code changes are committed, run `./scripts/sync-main.sh`. Confirm that the live checkout is on the new commit and that `http://127.0.0.1:4700/api/health` returns `ok: true` before reporting completion.

## Electron shell version

Any PR that changes `electron/main.js` or `electron/deeplink.js` must bump the `version` in `electron/package.json`. The server exposes that version at `GET /api/shell-version`; the desktop app compares it to its own bundled version and prompts the user to restart when they differ. A PR that changes shell files without bumping the version leaves running apps unaware an update exists.

## Install

```
bun install
(cd web && bun install)
(cd electron && bun install)
```

## Test

```
bun run test
```

## Typecheck

```
bun run typecheck
```

Run this before handing off. It is the same pair of `tsc` runs CI does (`.github/workflows/ci.yml`): the root tsconfig, which covers `server/src` and `cli`, plus `web/`. A bare `tsc --noEmit` at the root never looks at `web/src`, so a type error there stays invisible until CI fails. Needs `bun install` in both the root and `web/`.

## Run

```
bun run server/src/index.ts
```

## Web dev

```
cd web && bun run dev
```
