// Single-flight merge execution, keyed by the branch a merge lands ON.
//
// Four callers can land a PR: the land queue's sweep, the reconciler's
// auto-merge, the PR gardener, and the director's click on the review card.
// Nothing stopped two of them from running `gh pr merge` / a local
// fast-forward against the same base at the same moment. That is the
// concurrent-crew-merge race that once silently ate a commit: two merges
// validated against the same base tip, and the second one's reset + re-merge
// wrote over the first.
//
// The cure is order, not detection. Every merge takes a lock on its target
// branch and runs alone. Whoever waits then re-reads the PR's live base and
// head INSIDE the lock (mergeTask does this on every call), so the second
// merge validates against the base the first one just moved, and a base that
// really did move fails loudly as a transient "base branch was modified"
// instead of landing on stale state.
//
// ponytail: an in-process promise chain, because one hive server owns the
// merge path. Two servers on one repo would need a file lock; the rogue
// scratch-DB incident says that state is already broken for other reasons.

const chains = new Map<string, Promise<unknown>>();

// Run `fn` with nothing else holding `key`. Waiters run in arrival order.
export function withMergeLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  // `catch` so one caller's rejection never poisons the queue behind it.
  const run = prev.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  chains.set(key, tail);
  // Drop the entry once the chain drains, so the map doesn't grow one entry per
  // branch forever. Only the tail clears it — a later waiter already replaced it.
  void tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key);
  });
  return run;
}

// Exposed for tests / diagnostics: which target branches have a merge in flight.
export function mergeLocksHeld(): string[] {
  return [...chains.keys()];
}
