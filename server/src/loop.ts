// Every background loop had the same shape: `setInterval` firing a cycle whose
// duration nothing bounds. When a cycle outran its interval (2026-08-25:
// reconciler runs of 175s and 320s against a 60s interval, dispatcher runs of
// 169s against 30s) the ticks stacked up, saturated the event loop, and
// /api/health stopped answering for minutes at a time — which broke every agent
// whose command gate calls it.
//
// A tick that lands while the previous cycle is still running is DROPPED, not
// queued: the next one is at most `intervalMs` away and every cycle re-reads
// the world from the DB, so there is nothing for a catch-up run to add.
//
// `firstRunAfterMs` schedules an extra early run (some loops want one shortly
// after boot rather than waiting a full interval). It shares the same guard as
// the interval ticks, so a boot run and a tick can never overlap.
export function startLoop(
  name: string,
  intervalMs: number,
  run: () => Promise<unknown>,
  opts: { firstRunAfterMs?: number } = {},
): () => void {
  let running = false;
  const tick = () => {
    if (running) {
      console.warn(`[hive] ${name}: previous cycle still running; skipping this tick`);
      return;
    }
    running = true;
    run()
      .catch((e) => console.error(`[hive] ${name} cycle crashed:`, e))
      .finally(() => {
        running = false;
      });
  };
  const timer = setInterval(tick, intervalMs);
  const first = opts.firstRunAfterMs === undefined ? undefined : setTimeout(tick, opts.firstRunAfterMs);
  return () => {
    if (first !== undefined) clearTimeout(first);
    clearInterval(timer);
  };
}
