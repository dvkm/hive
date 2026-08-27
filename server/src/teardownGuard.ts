// Three gates that must all be open before hive tears anything down (fails a
// task, requeues it, removes a worktree, closes a tab). They exist because the
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
//   3. Lease ownership — a displaced server can run one last loop before its
//      lease heartbeat exits. It must not act on its stale view of the fleet.
//   4. Fleet DB ownership — see fleetDbBlocked below.
import type { DB } from "./db.ts";
import { getSetting, defaultDbPath, homeDbPath } from "./db.ts";
import { holdsLease } from "./lease.ts";

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

// Dead verdicts across the WHOLE fleet since the latest acknowledged breaker
// card, limited to the trailing window. The reconciler writes one
// `recovery {decision:"dead"}` event per agent it declares dead.
export function recentDeadVerdicts(db: DB, nowMs: number = Date.now()): number {
  const since = new Date(nowMs - DEAD_BURST_MS).toISOString();
  const r = db
    .query(
      `SELECT COUNT(*) AS n FROM events
        WHERE type = 'recovery' AND ts > ? AND json_extract(payload, '$.decision') = 'dead'
          AND rowid > COALESCE((
            SELECT MAX(e.rowid) FROM events e JOIN decisions d
              ON e.type = 'breaker_card' AND json_extract(e.payload, '$.decision_id') = d.id
            WHERE d.status = 'answered'
          ), 0)`
    )
    .get(since) as { n: number };
  return r.n;
}

// The breaker is TRIPPED for exactly as long as its card is open. Answering it
// means "I looked": sweeps resume, and recentDeadVerdicts starts after that
// card so the acknowledged deaths cannot immediately open another one.
export function breakerTripped(db: DB): boolean {
  return !!db
    .query(
      `SELECT 1 FROM decisions d JOIN events e ON e.type = 'breaker_card'
          AND json_extract(e.payload, '$.decision_id') = d.id
        WHERE d.status = 'open' LIMIT 1`
    )
    .get();
}

// INCIDENT b6fb44583e96 (2026-08-25): the lease guards the DATABASE, but every
// hive server drives the ONE global herdr daemon. A server on a scratch DB
// (HIVE_DB=/tmp/smoke.db — precisely what index.ts tells a refused server to
// use) holds its own uncontested lease, so gates 1-3 all pass, and then its
// reaper enumerates every pane on the machine, finds no row for the live fleet
// in its own tiny DB, and closes them as "orphan task panes". An agent's leaked
// smoke server (pid 29704, HIVE_DB=.../scratchpad/smoke.db, 5 rows) reaped the
// working fleet every 5 minutes for 7 hours this way — unlogged, because its
// logClose went to a dead stdout, which is why no herdr_close_request named the
// victims. Only a server on the fleet's own DB may tear fleet resources down.
// Read at call time, not module load: `defaultDbPath` answers with whatever
// HIVE_DB the process was started with, and tests never set it in-process.
export function fleetDbBlocked(): string | null {
  return defaultDbPath() === homeDbPath() ? null : "not the fleet database";
}

// May hive tear something down right now? One call, used by every destructive
// path (stale recovery, the reaper sweep). Returns the reason it may not, so the
// caller can log something a human can act on.
export function teardownBlocked(db: DB, nowMs: number = Date.now(), instanceId?: string): string | null {
  const notFleet = fleetDbBlocked();
  if (notFleet) return notFleet;
  if (withinBootGrace(db, nowMs)) return "boot grace";
  if (breakerTripped(db)) return "circuit breaker open";
  // A server that has lost the DB lease is on its way out (it exits within one
  // heartbeat) but its 60s reconciler / reaper loops can still fire once in that
  // window. It must not reap: from a displaced server every agent looks gone
  // because the NEW server now owns herdr's registry. Only the lease holder may
  // tear anything down. (No instanceId — tests, embedded use — keeps prior behaviour.)
  if (instanceId && !holdsLease(db, instanceId)) return "not the lease holder";
  return null;
}
