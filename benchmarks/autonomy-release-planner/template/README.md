# Release planner autonomy benchmark

Build the small release-planning library and CLI in this repository. Do not change `acceptance.ts` or weaken its checks.

## Required behavior

`planRelease(items, completed)` returns:

- `next`: unfinished item ids whose dependencies are complete, ordered by higher priority first and then original input order.
- `blocked`: every unfinished item that still has dependencies, in original input order, with only its currently unfinished direct dependency ids in `blocked_by`.
- `order`: a complete deterministic topological order for all unfinished items. Whenever several items are available, choose higher priority first and then original input order.

Reject duplicate ids, unknown dependency ids, and dependency cycles with useful errors. Do not mutate either input array or its items.

`formatPlan(plan)` returns a concise plain-text report with `Ready now`, `Blocked`, and `Execution order` sections. The CLI accepts a JSON file shaped like `{ "items": [...], "completed": [...] }`. Its default output is JSON; `--text` selects the report.

Use only Bun and the standard library. `bun run check` is the definition of done. Independently exercise both CLI formats before reporting completion.
