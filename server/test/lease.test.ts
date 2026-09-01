// Single-writer lease (#1103). The regression: on 2026-08-19 four `bun --watch`
// server workers survived a `launchctl kickstart` (their parents died, they
// re-parented to launchd) and kept running reconciler laps against the live DB
// for up to 14 hours. They never held port 4700, so a port bind could not see
// them — the lease is DB-level for exactly that reason.
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { openDb } = await import("../src/db.ts");
const { claimLease, renewLease, holdsLease, readLease } = await import("../src/lease.ts");

test("claiming the lease displaces the previous holder, who can no longer renew", () => {
  const db = openDb(":memory:");
  const a = claimLease(db, 111);
  expect(a.displaced).toBeNull();
  expect(holdsLease(db, a.instance)).toBe(true);
  expect(renewLease(db, a.instance, 111)).toBe(true);

  const b = claimLease(db, 222);
  expect(b.displaced).toMatchObject({ instance: a.instance, pid: 111 });
  expect(holdsLease(db, a.instance)).toBe(false);
  expect(renewLease(db, a.instance, 111)).toBe(false); // never steals it back
  expect(readLease(db)).toMatchObject({ instance: b.instance, pid: 222 });
});

// The real thing: two server PROCESSES against one DB. Exactly one may run the
// background loops, and it must be the new one — a deploy restarts the server,
// so the survivor has to be the freshly deployed code, not the orphan.
test("two servers on one DB: the predecessor stands down, one keeps running laps", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hive-lease-"));
  const entry = join(import.meta.dir, "..", "src", "index.ts");
  const env = {
    ...process.env,
    HIVE_DB: join(dir, "hive.db"),
    HIVE_HOME: dir,
    HIVE_PORT: "0", // ephemeral: never collides with a neighbour's server
    HIVE_LEASE_MS: "150",
    HIVE_RECONCILE_MS: "150",
    HIVE_DISPATCH_MS: "60000",
    HIVE_MONITOR_MS: "60000",
    HIVE_MANAGER_WAKE_MS: "60000",
    HIVE_REAP_MS: "600000",
  };
  const start = () => {
    const proc = Bun.spawn([process.execPath, "run", entry], { env, stdout: "pipe", stderr: "pipe" });
    let text = "";
    // Both streams: the lease messages are console.warn/error (stderr), the
    // reconciler laps are console.log (stdout).
    for (const stream of [proc.stdout, proc.stderr]) {
      (async () => {
        for await (const chunk of stream as ReadableStream<Uint8Array>) text += new TextDecoder().decode(chunk);
      })().catch(() => {});
    }
    return { proc, out: () => text };
  };
  // Every wait below polls until the condition holds, so it returns the instant
  // the lease moves — a measured handoff is ~100ms per phase on an idle machine.
  // The deadline therefore costs a healthy run nothing; it only decides how
  // loaded a runner has to be before working lease logic is reported as broken.
  // 15s was not enough on a busy linux runner (#128 flaked again on PR #130).
  // 60s is ~600x the measured handoff: a genuinely broken handoff never reaches
  // it, a merely slow runner always beats it.
  const DEADLINE_MS = 60_000;
  const until = async (fn: () => boolean, ms = DEADLINE_MS) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (fn()) return true;
      await Bun.sleep(50);
    }
    return false;
  };
  // Poll who actually holds the DB lease, instead of counting "reconciler run:"
  // lines against a fixed wall-clock budget — a slow/loaded CI runner can miss
  // laps inside a tight window even though the lease handoff itself is fine.
  const db = openDb(env.HIVE_DB);
  const holder = () => readLease(db)?.pid;

  const a = start();
  try {
    expect(await until(() => holder() === a.proc.pid)).toBe(true); // A holds the lease

    const b = start();
    try {
      expect(await until(() => holder() === b.proc.pid)).toBe(true); // B took over
      expect(b.out()).toContain("took the DB lease from a previous server");

      // A stands down on its own — it is the orphan case, so nothing external
      // kills it. Its process must be gone, not merely quiet.
      expect(await until(() => a.proc.exitCode !== null)).toBe(true);
      expect(a.out()).toContain("standing down");

      // And B is still the one holding (and renewing) the lease afterwards.
      const before = readLease(db)?.at;
      expect(await until(() => holder() === b.proc.pid && readLease(db)?.at !== before)).toBe(true);
    } finally {
      b.proc.kill();
      await b.proc.exited;
    }
  } finally {
    a.proc.kill();
    await a.proc.exited;
  }
  // The outer timeout has to cover the SUM of all four waits, not just the
  // biggest one: four slow-but-passing waits each beat their own DEADLINE_MS
  // yet add up. 4 x 60s is 240s, so 300s here. A healthy run finishes all four
  // phases in ~400ms, so this ceiling is never approached either.
}, 300_000);

// ---------------------------------------------------------------- enforcement
// The lease above is an ASK. These cover what happens when a second server does
// not honour it — the 2026-08-19/20 incident, where a throwaway test server on a
// custom port opened the LIVE db and its reconciler evicted working agents for
// 25 minutes, until a human killed it by hand.

const { interloperReason, interloperAdvice, registerInstance, listInstances, evictContenders, isHiveServerCommand } = await import(
  "../src/lease.ts"
);
const { homeDbPath } = await import("../src/db.ts");

test("a server on a non-fleet port refuses the live fleet database", () => {
  expect(interloperReason(homeDbPath(), 4791)).toContain("not the fleet port");
  expect(interloperReason(homeDbPath(), 4700)).toBeNull(); // the real server
  expect(interloperReason("/tmp/smoke.db", 4791)).toBeNull(); // scratch db: fine
});

// The refusal advice used to read as "use a scratch DB" with no end to it. An
// agent followed it during a smoke test on 2026-08-25 and left that server up;
// it closed the live fleet's herdr panes every 5 minutes for 7 hours. The advice
// must never again describe a second server you can walk away from.
test("the refusal advice tells the operator to stop the scratch server", () => {
  const advice = interloperAdvice(4791);
  expect(advice).toContain("HIVE_PORT=4791");
  expect(advice.toLowerCase()).toContain("smoke test");
  expect(advice).toMatch(/stop it \(Ctrl-C\)/);
  expect(advice).toContain("Never leave one running");
});

// The end-to-end shape of the incident, in a fake HOME so it can never touch the
// real fleet: custom port, HIVE_DB forgotten, so defaultDbPath lands on the
// "live" db. The process must die before it serves, leases or reconciles.
test("a throwaway server that forgets HIVE_DB exits instead of attaching to the fleet db", async () => {
  const home = mkdtempSync(join(tmpdir(), "hive-fakehome-"));
  const proc = Bun.spawn([process.execPath, "run", join(import.meta.dir, "..", "src", "index.ts")], {
    // NODE_ENV: "" — this spawns a real server process, not a test; it must hit
    // index.ts's own interloperReason refusal below, not openDb's test-only guard.
    env: { ...process.env, HOME: home, USERPROFILE: home, HIVE_DB: "", HIVE_PORT: "4791", HIVE_HOME: home, NODE_ENV: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  expect(code).toBe(1);
  expect(err).toContain("REFUSING TO START");
  expect(err).toContain("HIVE_DB=");
  // It got far enough to leave the director a note, and no further.
  const db = openDb(join(home, ".hive", "hive.db"));
  expect((db.query("SELECT kind FROM notifications").all() as { kind: string }[]).map((r) => r.kind)).toEqual([
    "server_refused",
  ]);
  expect(db.query("SELECT COUNT(*) n FROM server_instances").get()).toMatchObject({ n: 0 });
}, 30_000);

function fakeProcs(procs: Record<number, string>) {
  const signals: [number, string][] = [];
  return {
    signals,
    ops: {
      alive: (pid: number) => pid in procs,
      command: (pid: number) => procs[pid] ?? "",
      signal: (pid: number, sig: any) => {
        signals.push([pid, sig]);
      },
    },
  };
}

const SERVER_CMD = "/Users/d/.bun/bin/bun --watch /Users/d/projects/hive-live/server/src/index.ts";
const WINDOWS_SERVER_CMD = "C:\\Users\\d\\.bun\\bin\\bun.exe --watch C:\\Users\\d\\projects\\hive-live\\server\\src\\index.ts";

test("the lease holder terminates a second server that will not stand down", () => {
  const db = openDb(":memory:");
  registerInstance(db, "srv_me", 100, 4700);
  registerInstance(db, "srv_zombie", 200, 4791);
  const { ops, signals } = fakeProcs({ 100: SERVER_CMD, 200: SERVER_CMD });

  // First lap: ask nicely.
  expect(evictContenders(db, "srv_me", ops, 100)).toMatchObject([{ signal: "SIGTERM", contender: { pid: 200 } }]);
  expect(signals).toEqual([[200, "SIGTERM"]]);
  expect(listInstances(db).map((r) => r.instance).sort()).toEqual(["srv_me", "srv_zombie"]);

  // Still there next lap — a wedged reconciler is the thing doing the damage.
  expect(evictContenders(db, "srv_me", ops, 100)).toMatchObject([{ signal: "SIGKILL" }]);
  expect(signals).toEqual([
    [200, "SIGTERM"],
    [200, "SIGKILL"],
  ]);
  expect(listInstances(db).map((r) => r.instance)).toEqual(["srv_me"]); // forgotten once killed
});

// Pids are recycled, and the row can be minutes old. Signalling one that is no
// longer a hive server would mean hive killing the director's editor.
test("eviction never signals a dead or recycled pid", () => {
  const db = openDb(":memory:");
  registerInstance(db, "srv_me", 100, 4700);
  registerInstance(db, "srv_dead", 200, 4791);
  registerInstance(db, "srv_recycled", 300, 4792);
  const { ops, signals } = fakeProcs({ 100: SERVER_CMD, 300: "/Applications/Cursor.app/Contents/MacOS/Cursor" });

  expect(evictContenders(db, "srv_me", ops, 100)).toEqual([]);
  expect(signals).toEqual([]);
  expect(listInstances(db).map((r) => r.instance)).toEqual(["srv_me"]); // both rows dropped
  expect(isHiveServerCommand(SERVER_CMD)).toBe(true);
  expect(isHiveServerCommand(WINDOWS_SERVER_CMD)).toBe(true);
  expect(isHiveServerCommand("/Applications/Cursor.app/Contents/MacOS/Cursor")).toBe(false);
});
