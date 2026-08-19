// Test/ephemeral projects: a project an agent's own E2E/smoke run registered
// against the LIVE server instead of a throwaway instance (task #1020, seen
// 2026-08-19 — task #989's repo-validation E2E run left 4 scratch projects,
// 9 test tasks and 2 real-looking decisions on the live board). Flagged
// `config.test = true`, same free-form spot `config.archived` already uses
// (see createProject/updateProject in api.ts) — no schema migration needed.
//
// Flagged projects' tasks/decisions/checkpoints are excluded from the default
// (unfiltered) list endpoints — see notTestProjectSql below — and never push
// a notification (see notifications.ts enqueue). reaper.ts auto-archives one
// once every task it owns is terminal, so the project itself clears from the
// project list without any manual cleanup.
export function isEphemeralRepoPath(repoPath: string | null | undefined): boolean {
  if (!repoPath) return false;
  // A real project's repo_path is a durable checkout; a path living inside
  // another task's own worktree or scratchpad can only be a scratch artifact.
  return repoPath.includes("/.herdr/worktrees/") || repoPath.includes("/scratchpad");
}

// SQL fragment for JOIN queries, e.g.
// `... JOIN projects p ON p.id = t.project_id WHERE ${notTestProjectSql("p.config")}`
export function notTestProjectSql(configColumn = "config"): string {
  return `COALESCE(json_extract(${configColumn}, '$.test'), 0) = 0`;
}
