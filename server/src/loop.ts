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
export function startLoop(name: string, intervalMs: number, run: () => Promise<unknown>): () => void {
  let running = false;
  const timer = setInterval(() => {
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
  }, intervalMs);
  return () => clearInterval(timer);
}
