// Two gates that must both be open before hive tears anything down (fails a
// task, requeues it, removes a worktree, closes a tab). Both exist because the
// same class of accident keeps happening: hive loses VISIBILITY of a healthy
// fleet and reads it as a fleet of dead agents.
//
//   1. Boot grace — for the first few minutes after the server starts, herdr's
//      registry may still be cold (a self-deploy restarts the server; a desktop
//      -app restart wipes the registry outright). Every agent probes as gone at
//      exactly the moment hive knows least. Wait it out; the agents are running
//      processes and are not going anywhere.
//   2. Circuit breaker — N dead verdicts inside M minutes is a hive-side
//      failure, not N simultaneous agent deaths. Stop sweeping and put ONE card
//      in front of the director instead of reaping the whole fleet one lap at a
//      time (2026-08-19: 12+ live agents failed with their tabs closed).
import type { DB } from "./db.ts";
import { getSetting } from "./db.ts";

export const BOOT_GRACE_MS = Number(process.env.HIVE_BOOT_GRACE_MS || 5 * 60_000);
export const DEAD_BURST_N = Number(process.env.HIVE_DEAD_BURST_N || 3);
export const DEAD_BURST_MS = Number(process.env.HIVE_DEAD_BURST_MS || 10 * 60_000);

// `server_started_at` is written once, by index.ts, at boot. Tests (and any
// embedded use without a server process) never set it, so they get no grace.
export function withinBootGrace(db: DB, nowMs: number = Date.now()): boolean {
  const at = getSetting(db, "server_started_at");
  if (!at) return false;
  const started = Date.parse(at);
  return Number.isFinite(started) && nowMs - started < BOOT_GRACE_MS && nowMs >= started;
}

// Dead verdicts across the WHOLE fleet in the trailing window — the reconciler
// writes one `recovery {decision:"dead"}` event per agent it declares dead.
export function recentDeadVerdicts(db: DB, nowMs: number = Date.now()): number {
  const since = new Date(nowMs - DEAD_BURST_MS).toISOString();
  const r = db
    .query(
      `SELECT COUNT(*) AS n FROM events
        WHERE type = 'recovery' AND ts > ? AND json_extract(payload, '$.decision') = 'dead'`
    )
    .get(since) as { n: number };
  return r.n;
}

// The breaker is TRIPPED for exactly as long as its card is open: answering it
// (either way) is the director saying "I looked", and sweeps resume. That keeps
// the whole thing in one place — no second piece of state to expire or leak.
export function breakerTripped(db: DB): boolean {
  return !!db
    .query(
      `SELECT 1 FROM decisions d JOIN events e ON e.type = 'breaker_card'
          AND json_extract(e.payload, '$.decision_id') = d.id
        WHERE d.status = 'open' LIMIT 1`
    )
    .get();
}

// May hive tear something down right now? One call, used by every destructive
// path (stale recovery, the reaper sweep). Returns the reason it may not, so the
// caller can log something a human can act on.
export function teardownBlocked(db: DB, nowMs: number = Date.now()): string | null {
  if (withinBootGrace(db, nowMs)) return "boot grace";
  if (breakerTripped(db)) return "circuit breaker open";
  return null;
}
