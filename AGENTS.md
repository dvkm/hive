# Hive repository workflow

After verified code changes are committed, run `./scripts/sync-main.sh`. Confirm that the live checkout is on the new commit and that `http://127.0.0.1:4700/api/health` returns `ok: true` before reporting completion.
