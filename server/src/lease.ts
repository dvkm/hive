// Single-writer lease over the hive DB. Exactly one hive server may run the
// background loops (reconciler, dispatcher, reaper, watchers) against a given
// database — they mutate shared state and drive the shared herdr socket.
//
// Why this exists: on 2026-08-19 four `bun --watch` server workers survived
// `launchctl kickstart` (the parents died, the workers re-parented to launchd)
// and kept running reconciler laps against the live DB for up to 14 hours.
// Overlapping kill cadences made fixes look ineffective. A port bind is NOT
// enough to detect them — the orphans never held 4700.
//
// Semantics: NEWEST WINS. A booting server claims the lease unconditionally
// (after its listener is up, so a server that cannot even bind never evicts a
// healthy one); every predecessor notices on its next heartbeat that the lease
// is no longer its own and exits. One heartbeat is the whole convergence time.
import type { DB } from "./db.ts";
import { getSetting, setSetting, newId, homeDbPath, now } from "./db.ts";
import { resolve } from "node:path";

export const LEASE_KEY = "server_lease";
export const LEASE_MS = Number(process.env.HIVE_LEASE_MS || 15_000);

export interface Lease {
  instance: string;
  pid: number;
  at: string;
}

export function readLease(db: DB): Lease | null {
  const raw = getSetting(db, LEASE_KEY);
  if (!raw) return null;
  try {
    const l = JSON.parse(raw);
    return typeof l?.instance === "string" ? l : null;
  } catch {
    return null;
  }
}

// Take the lease. Returns this instance's id plus whichever lease it displaced,
// so the caller can log that a predecessor was found (the deploy-time signal
// that an orphan was still running).
export function claimLease(db: DB, pid: number = process.pid): { instance: string; displaced: Lease | null } {
  const displaced = readLease(db);
  const instance = newId("srv");
  setSetting(db, LEASE_KEY, JSON.stringify({ instance, pid, at: new Date().toISOString() }));
  return { instance, displaced: displaced && displaced.instance !== instance ? displaced : null };
}

export function holdsLease(db: DB, instance: string): boolean {
  return readLease(db)?.instance === instance;
}

// Refresh our own timestamp. Never re-takes a lease someone else now holds —
// that is precisely the signal the caller is waiting for.
export function renewLease(db: DB, instance: string, pid: number = process.pid): boolean {
  if (!holdsLease(db, instance)) return false;
  setSetting(db, LEASE_KEY, JSON.stringify({ instance, pid, at: new Date().toISOString() }));
  return true;
}

// Heartbeat loop. Calls onLost() the first time the lease belongs to someone
// else, then stops — the caller exits the process, which is what actually takes
// this server's loops (and its `bun --watch` children) out of the picture.
export function startLease(
  db: DB,
  instance: string,
  onLost: (holder: Lease | null) => void,
  intervalMs: number = LEASE_MS
): () => void {
  const timer = setInterval(() => {
    // A throw here is write contention (`database is locked`), not a verdict —
    // two servers overlapping for a moment during a deploy is the normal case.
    // Skip the tick and try again. An UNCAUGHT throw would kill the server from
    // a timer, which is a crash dressed up as a stand-down.
    let held: boolean;
    try {
      held = renewLease(db, instance);
    } catch (e) {
      console.warn(`[hive] lease renew skipped: ${String((e as any)?.message ?? e)}`);
      return;
    }
    if (held) return;
    clearInterval(timer);
    onLost(readLease(db));
  }, intervalMs);
  return () => clearInterval(timer);
}

// ---------------------------------------------------------------- enforcement
//
// The lease above is an ASK: a predecessor notices it lost and exits. That is
// enough for a well-behaved server and not enough for the two ways this has
// actually gone wrong:
//
//   * A throwaway test server started on a custom port but the DEFAULT DB
//     (forgetting HIVE_DB). Its reconciler evicted live agents for 25 minutes
//     until a human killed it by hand (2026-08-19, twice). `interloperReason`
//     below stops that one before it runs a single loop.
//   * A `bun --watch` worker that survived a `launchctl kickstart` by
//     re-parenting to launchd, with no watcher left to notice anything. It
//     renews nothing and reads nothing; asking it to stand down does not work.
//     `evictContenders` terminates it.
//
// Both paths exist to remove the manual-kill step. Nothing here ever signals a
// process that did not register itself, in this table, as a hive server.

export const FLEET_PORT = Number(process.env.HIVE_FLEET_PORT || 4700);

// May this process own this database? A non-default port is the operator saying
// "this server is a side experiment"; the live fleet's DB is not a side
// experiment. Returns the reason to refuse, or null to proceed.
// HIVE_ALLOW_SHARED_DB=1 is the deliberate override (moving the real server to
// another port), because a rule that cannot be turned off becomes the outage.
export function interloperReason(dbPath: string, port: number): string | null {
  if (process.env.HIVE_ALLOW_SHARED_DB === "1") return null;
  if (resolve(dbPath) !== resolve(homeDbPath())) return null; // scratch DB: yours to break
  if (port === FLEET_PORT) return null; // the fleet's own endpoint
  return `this is the live fleet database (${homeDbPath()}) and port ${port} is not the fleet port ${FLEET_PORT}`;
}

export interface Contender {
  instance: string;
  pid: number;
  port: number;
  registered_at: string;
  evicted_at: string | null;
}

// Called BEFORE any background loop starts, so a server that is about to
// misbehave is already identifiable by the holder.
export function registerInstance(db: DB, instance: string, pid: number, port: number): void {
  db.query(
    "INSERT INTO server_instances (instance, pid, port, registered_at) VALUES (?,?,?,?) " +
      "ON CONFLICT(instance) DO UPDATE SET pid = excluded.pid, port = excluded.port, registered_at = excluded.registered_at, evicted_at = NULL"
  ).run(instance, pid, port, now());
}

export function unregisterInstance(db: DB, instance: string): void {
  db.query("DELETE FROM server_instances WHERE instance = ?").run(instance);
}

export function listInstances(db: DB): Contender[] {
  return db.query("SELECT * FROM server_instances ORDER BY registered_at").all() as Contender[];
}

// Injected so the eviction path is testable without spawning real processes.
export interface ProcOps {
  alive(pid: number): boolean;
  command(pid: number): string;
  signal(pid: number, sig: NodeJS.Signals): void;
}

export function processCommandArgv(pid: number, platform: NodeJS.Platform = process.platform): string[] {
  if (platform === "win32") {
    return [
      "powershell.exe",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `(Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\").CommandLine`,
    ];
  }
  return ["ps", "-p", String(pid), "-o", "command="];
}

export const defaultProcOps: ProcOps = {
  alive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  },
  command(pid) {
    const r = Bun.spawnSync(processCommandArgv(pid));
    return r.success ? new TextDecoder().decode(r.stdout).trim() : "";
  },
  signal(pid, sig) {
    process.kill(pid, sig);
  },
};

// Positive identification before we signal anything. Pids are recycled, and the
// row in our table can be minutes old — by then that number may belong to the
// director's editor. Only a command line that still reads as a hive server is
// ever a target.
export function isHiveServerCommand(cmd: string): boolean {
  return /hive.*server[\\/]src[\\/]index\.ts/i.test(cmd);
}

// The lease holder's enforcement duty, run on every heartbeat. SIGTERM first;
// a contender still alive on the next lap gets SIGKILL. Returns what it killed
// so the caller can tell the director (an eviction is never routine).
export function evictContenders(
  db: DB,
  holder: string,
  ops: ProcOps = defaultProcOps,
  selfPid: number = process.pid
): { contender: Contender; signal: NodeJS.Signals }[] {
  const killed: { contender: Contender; signal: NodeJS.Signals }[] = [];
  for (const c of listInstances(db)) {
    if (c.instance === holder || c.pid === selfPid) continue;
    if (!ops.alive(c.pid) || !isHiveServerCommand(ops.command(c.pid))) {
      unregisterInstance(db, c.instance); // gone, or the pid was recycled — nothing to kill
      continue;
    }
    // Escalate rather than repeat: a process that ignored SIGTERM is wedged,
    // and a wedged reconciler is exactly the thing doing the damage.
    const signal: NodeJS.Signals = c.evicted_at ? "SIGKILL" : "SIGTERM";
    try {
      ops.signal(c.pid, signal);
    } catch {
      unregisterInstance(db, c.instance); // vanished between the check and the signal
      continue;
    }
    if (signal === "SIGKILL") unregisterInstance(db, c.instance);
    else db.query("UPDATE server_instances SET evicted_at = ? WHERE instance = ?").run(now(), c.instance);
    killed.push({ contender: c, signal });
  }
  return killed;
}
