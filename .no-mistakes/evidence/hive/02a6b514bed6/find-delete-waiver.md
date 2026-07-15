# classify.ts — find with -delete/-exec sandbox waiver

Live PreToolUse hook decisions (bun hooks/classify.ts). The hook reads the
same JSON payload Claude Code sends and emits the allow/deny decision.
policy=allow so an allowed 'unknown' surfaces its reason instead of deferring silently.

```
A. delete scoped to agent's OWN worktree  -> ALLOW (allow-and-log)
  cmd: find /Users/david/.herdr/worktrees/monorepo/hive-abc -name '*.log' -delete
  -> {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"command_approval=allow: unknown command permitted"}}

B. delete against MAIN checkout           -> DENY (gated)
  cmd: find /Users/david/projects/monorepo -name '*.log' -delete
  -> {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"blocked (find with -delete/-exec); no hive task to authorize"}}

C. relative delete, UNSANDBOXED cwd       -> DENY (unprovable)
  cmd: find . -name '*.log' -delete
  -> {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"blocked (find with -delete/-exec); no hive task to authorize"}}

D. relative delete, sandboxed cwd         -> ALLOW (allow-and-log)
  cmd: find . -name '*.log' -delete
  -> {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"command_approval=allow: unknown command permitted"}}

E. parent-dir escape from worktree        -> DENY
  cmd: find /Users/david/.herdr/worktrees/monorepo/hive-abc/../other -name '*.log' -delete
  -> {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"blocked (find with -delete/-exec); no hive task to authorize"}}

F. multi-path, one outside sandbox        -> DENY
  cmd: find /Users/david/.herdr/worktrees/monorepo/hive-abc /Users/david/projects/monorepo -name '*.log' -delete
  -> {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"blocked (find with -delete/-exec); no hive task to authorize"}}

```

## Raw classify() decision + reason (proves SAFE-allowlist exclusion)
```
UNKNOWN   not on the safe allowlist          | find <WT> -name '*.log' -delete   [cwd=WT]
UNKNOWN   not on the safe allowlist          | find . -name '*.log' -delete       [cwd=WT]
DANGEROUS find with -delete/-exec            | find <main-checkout> ... -delete
DANGEROUS find with -delete/-exec            | find . -name '*.log' -delete       [cwd=main]
DANGEROUS find with -delete/-exec            | find . -name '*.log' -delete       [no cwd]
SAFE      read-only / standard dev command   | find <WT> -name '*.log'  (read-only, no delete)
```
