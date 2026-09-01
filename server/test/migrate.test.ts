// Migrations are keyed by name, not array position, and every statement is
// skipped if its effect is already present. These tests pin the failure mode
// from 2026-07-09: two branches each appended a migration, the merge renumbered
// one, and the position counter both skipped a migration and re-ran a different
// one against a DB that already had its effect.
import { test, expect } from "bun:test";
import { openDb, alreadyApplied, MIGRATIONS, CREATES, ADD_COLUMN, DROPS, type DB } from "../src/db.ts";
import { saveSubscription } from "../src/push.ts";
import { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";

function tmpDb(tag: string): string {
  return join(tmpdir(), `hive-migrate-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function cleanup(path: string) {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
}

function columns(db: DB, table: string): string[] {
  return (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((r) => r.name);
}

// v24 collided this way before the check below existed, and both halves have
// long since applied on live DBs under their own names. Renaming either one now
// would re-run it, so this pair stays as the one grandfathered exception.
const GRANDFATHERED_COLLISIONS = new Set(["v24-task-resume-context"]);

// The skip-if-present machinery only works if every statement is one statement
// that alreadyApplied can recognize, and if no two migrations create the same
// object. None of that is enforceable at runtime, so enforce it here: a future
// author who glues statements together, or reuses an object name, fails CI
// rather than shipping a migration recorded as applied without its effect.
test("migrations are well-formed", () => {
  const names = new Set<string>();
  const versions = new Set<string>();
  const created = new Set<string>();
  for (const m of MIGRATIONS) {
    expect(names.has(m.name)).toBe(false);
    names.add(m.name);

    // Two branches each appending "v33-..." merge cleanly and leave two v33s.
    // The names differ, so the dup check above passes and the collision ships.
    const version = /^(v\d+)-/.exec(m.name);
    if (!version) throw new Error(`${m.name}: migration names start with vN-`);
    if (versions.has(version[1]) && !GRANDFATHERED_COLLISIONS.has(m.name)) {
      throw new Error(`${m.name}: version ${version[1]} is already taken by another migration`);
    }
    versions.add(version[1]);

    for (const stmt of m.statements) {
      const create = CREATES.exec(stmt);
      const add = ADD_COLUMN.exec(stmt);
      const drop = DROPS.exec(stmt);

      // One statement per element. A trigger body is the only legal `;`.
      const isTrigger = /^\s*CREATE\s+TRIGGER/i.test(stmt);
      if (!isTrigger && stmt.includes(";")) {
        throw new Error(`${m.name}: one statement per array element, found ';' in:\n${stmt}`);
      }

      if (create) {
        // No two migrations may create the same object: alreadyApplied would
        // skip the second and still record it applied.
        const key = `${create[1].toLowerCase()}:${create[2]}`;
        expect(created.has(key)).toBe(false);
        created.add(key);
      } else if (!add && !drop) {
        // alreadyApplied can't detect this statement's effect, so it re-runs on
        // every heal. Only a data migration may do that, and the heal tests below are
        // what prove this one is a no-op once applied.
        expect(stmt).toMatch(/^\s*(?:UPDATE|DELETE)\b/i);
      }
    }
  }
});

test("alreadyApplied asks the schema, for every statement kind", () => {
  const db = openDb(":memory:");
  expect(alreadyApplied(db, "CREATE TABLE tasks (x TEXT)")).toBe(true);
  expect(alreadyApplied(db, "CREATE TABLE brand_new (x TEXT)")).toBe(false);
  expect(alreadyApplied(db, "CREATE INDEX idx_events_ts ON events(ts)")).toBe(true);
  expect(alreadyApplied(db, "CREATE UNIQUE INDEX idx_tasks_number ON tasks(number)")).toBe(true);
  expect(alreadyApplied(db, "CREATE TRIGGER tasks_assign_number AFTER INSERT ON tasks BEGIN SELECT 1; END")).toBe(true);
  expect(alreadyApplied(db, "ALTER TABLE tasks ADD COLUMN number INTEGER")).toBe(true);
  expect(alreadyApplied(db, "ALTER TABLE tasks ADD COLUMN duplicate_of TEXT")).toBe(true);
  expect(alreadyApplied(db, "ALTER TABLE tasks ADD COLUMN not_there TEXT")).toBe(false);
  // Type is matched too: an index named after an existing table is not "applied".
  expect(alreadyApplied(db, "CREATE INDEX tasks ON events(ts)")).toBe(false);
  expect(alreadyApplied(db, "CREATE TABLE idx_events_ts (x TEXT)")).toBe(false);
  expect(alreadyApplied(db, "DROP INDEX idx_events_ts")).toBe(false);
  expect(alreadyApplied(db, "DROP INDEX IF EXISTS idx_not_there")).toBe(true);
  // Non-DDL always runs: backfills must be written re-runnable.
  expect(alreadyApplied(db, "UPDATE tasks SET number = 1 WHERE number IS NULL")).toBe(false);
  db.close();
});

test("the Jira link migration adds its columns and backfills mirrors", () => {
  const path = tmpDb("jira-link");
  try {
    const seed = openDb(path);
    seed.query("INSERT INTO projects (id, name, config, created_at) VALUES ('p','p','{}','2026-01-01T00:00:00Z')").run();
    seed.query(
      `INSERT INTO tasks (id, project_id, title, state, kind, source, source_ref, created_at, updated_at)
       VALUES ('t','p','mirror','queued','ship','external','jira:WEB-123','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`
    ).run();
    seed.exec("DROP INDEX idx_tasks_jira_key_kind");
    seed.exec("ALTER TABLE tasks DROP COLUMN jira_link_kind");
    seed.exec("ALTER TABLE tasks DROP COLUMN jira_key");
    seed.query("DELETE FROM schema_migrations WHERE name IN ('v30-task-jira-link', 'v31-task-jira-link-kind-uniqueness')").run();
    seed.close();

    const migrated = openDb(path);
    expect(columns(migrated, "tasks")).toEqual(expect.arrayContaining(["jira_key", "jira_link_kind"]));
    expect(migrated.query("SELECT jira_key, jira_link_kind FROM tasks WHERE id = 't'").get()).toEqual({
      jira_key: "WEB-123", jira_link_kind: "mirror",
    });
    migrated.query(
      `INSERT INTO tasks (id, project_id, title, state, kind, jira_key, jira_link_kind, created_at, updated_at)
       VALUES ('native','p','native','queued','ship','WEB-123','subtask','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`
    ).run();
    expect(migrated.query("SELECT count(*) AS count FROM tasks WHERE jira_key = 'WEB-123'").get()).toEqual({ count: 2 });
    expect(() => migrated.query(
      `INSERT INTO tasks (id, project_id, title, state, kind, jira_key, jira_link_kind, created_at, updated_at)
       VALUES ('duplicate','p','duplicate','queued','ship','WEB-123','subtask','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`
    ).run()).toThrow(/UNIQUE/);
    expect(() => migrated.query("UPDATE tasks SET jira_link_kind = 'invalid' WHERE id = 't'").run()).toThrow(/CHECK/);
    migrated.close();
  } finally {
    cleanup(path);
  }
});

// Two bun:sqlite behaviours pin migrate()'s choice of executor. Both are silent
// data loss if we pick wrong, so pin them: a bun upgrade that changes either
// should fail here, not in a migration.
test("bun:sqlite: exec() swallows step-time errors unless the statement is trimmed", () => {
  const dupes = () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t (n INTEGER)");
    db.exec("INSERT INTO t VALUES (1), (1)");
    return db;
  };
  const stmt = "CREATE UNIQUE INDEX i ON t(n)";

  const loose = dupes();
  loose.exec(`  ${stmt};\n  `); // trailing whitespace: error swallowed, index not built
  expect(loose.query("SELECT count(*) AS c FROM sqlite_master WHERE name = 'i'").get()).toEqual({ c: 0 });
  loose.close();

  const tight = dupes();
  expect(() => tight.exec(stmt)).toThrow(/UNIQUE/); // what migrate() relies on
  tight.close();
});

test("bun:sqlite: prepare() runs only the first statement, exec() runs all", () => {
  const glued = "ALTER TABLE t ADD COLUMN x TEXT; CREATE INDEX i ON t(x)";
  const idxCount = (db: Database) =>
    (db.query("SELECT count(*) AS c FROM sqlite_master WHERE type = 'index'").get() as { c: number }).c;

  const viaPrepare = new Database(":memory:");
  viaPrepare.exec("CREATE TABLE t (n INTEGER)");
  viaPrepare.prepare(glued).run();
  expect(idxCount(viaPrepare)).toBe(0); // second statement silently dropped
  viaPrepare.close();

  const viaExec = new Database(":memory:");
  viaExec.exec("CREATE TABLE t (n INTEGER)");
  viaExec.exec(glued);
  expect(idxCount(viaExec)).toBe(1);
  viaExec.close();
});

test("a DB ahead of the ledger heals instead of crashing", () => {
  const path = tmpDb("drift");
  try {
    // Reproduce the collision: the live DB got the *other* branch's migration
    // (number) but never got this branch's (duplicate_of), and has no ledger —
    // exactly what a position-counter DB looks like after a bad merge.
    const seed = openDb(path);
    seed.exec("ALTER TABLE tasks DROP COLUMN duplicate_of");
    seed.exec("DROP TABLE schema_migrations");
    seed.close();

    // Old code crashed here re-running `ALTER TABLE tasks ADD COLUMN number`.
    const db = openDb(path);
    const cols = columns(db, "tasks");
    expect(cols).toContain("duplicate_of"); // the skipped migration got applied
    expect(cols.filter((c) => c === "number").length).toBe(1); // the re-run one didn't duplicate
    db.close();
  } finally {
    cleanup(path);
  }
});

test("adopting a fully-migrated legacy DB is a no-op that preserves data", () => {
  const path = tmpDb("legacy");
  try {
    const db1 = openDb(path);
    db1.query("INSERT INTO projects (id, name, config, created_at) VALUES ('p','p','{}','2026-01-01T00:00:00Z')").run();
    const mk = (id: string, created_at: string) =>
      db1
        .query("INSERT INTO tasks (id, project_id, title, state, kind, created_at, updated_at) VALUES (?,'p',?, 'queued','ship',?,?)")
        .run(id, id, created_at, created_at);
    mk("a", "2026-01-01T00:00:00Z");
    mk("b", "2026-02-02T00:00:00Z");
    // Delete one so number != row count: a re-run of the v11 backfill would
    // renumber the survivors. It must not.
    db1.query("DELETE FROM tasks WHERE id = 'a'").run();
    mk("c", "2026-03-03T00:00:00Z");
    const before = db1.query("SELECT id, number FROM tasks ORDER BY id").all();
    expect(before).toEqual([
      { id: "b", number: 2 },
      { id: "c", number: 3 },
    ]);
    db1.exec("DROP TABLE schema_migrations"); // pretend it predates the ledger
    db1.close();

    const db2 = openDb(path);
    expect(db2.query("SELECT id, number FROM tasks ORDER BY id").all()).toEqual(before);
    const names = (db2.query("SELECT name FROM schema_migrations").all() as { name: string }[]).map((r) => r.name);
    expect(names).toContain("v1-initial-schema");
    expect(names).toContain("v11-task-numbers");
    db2.close();
  } finally {
    cleanup(path);
  }
});

test("push subscription cleanup removes pre-auth rows and keeps authenticated rows", () => {
  const path = tmpDb("push-auth-cleanup");
  try {
    const db1 = openDb(path);
    const insert = db1.query(
      "INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at) VALUES (?,?,?,?)"
    );
    insert.run("https://push.example/old", "old-key", "old-auth", "2026-08-24T21:58:33Z");
    insert.run("https://push.example/new", "new-key", "new-auth", "2026-08-24T21:58:35Z");
    insert.run("https://push.example/resubscribed", "old-key", "old-auth", "2026-08-24T21:58:33Z");
    saveSubscription(db1, {
      endpoint: "https://push.example/resubscribed",
      keys: { p256dh: "new-key", auth: "new-auth" },
    });
    db1.query("DELETE FROM schema_migrations WHERE name = 'v32-prune-unauthenticated-push-subscriptions'").run();
    db1.close();

    const db2 = openDb(path);
    expect(db2.query("SELECT endpoint FROM push_subscriptions").all()).toEqual([
      { endpoint: "https://push.example/new" },
      { endpoint: "https://push.example/resubscribed" },
    ]);
    db2.close();
  } finally {
    cleanup(path);
  }
});

// A partially-numbered DB (number column + trigger present, backfill never ran)
// would make the v11 backfill mint duplicates. The UNIQUE index must reject the
// migration rather than let openDb commit corrupt numbers.
test("a partially-numbered DB fails the migration instead of committing duplicates", () => {
  const path = tmpDb("partial");
  try {
    const db1 = openDb(path);
    db1.query("INSERT INTO projects (id, name, config, created_at) VALUES ('p','p','{}','2026-01-01T00:00:00Z')").run();
    const mk = (id: string, created_at: string) =>
      db1
        .query("INSERT INTO tasks (id, project_id, title, state, kind, created_at, updated_at) VALUES (?,'p',?, 'queued','ship',?,?)")
        .run(id, id, created_at, created_at);
    mk("a", "2026-01-01T00:00:00Z");
    mk("b", "2026-02-02T00:00:00Z");
    // Strip the guard rails and null out one number: numbered and un-numbered rows coexist.
    db1.exec("DROP INDEX idx_tasks_number");
    db1.query("UPDATE tasks SET number = NULL WHERE id = 'a'").run();
    db1.exec("DELETE FROM schema_migrations WHERE name = 'v11-task-numbers'");
    db1.close();

    // Backfill gives 'a' number 1, colliding with nothing... but 'b' keeps 2 and
    // 'a' would rank 1, so seed a real collision: two rows ranked the same.
    const raw = new Database(path);
    raw.query("UPDATE tasks SET number = 1 WHERE id = 'b'").run();
    raw.close();

    expect(() => openDb(path)).toThrow(/UNIQUE/);
    // Nothing committed: the ledger still lacks v11.
    const after = new Database(path);
    const names = (after.query("SELECT name FROM schema_migrations").all() as { name: string }[]).map((r) => r.name);
    expect(names).not.toContain("v11-task-numbers");
    after.close();
  } finally {
    cleanup(path);
  }
});

// hive-1864: --track is retired. The migration parks the tracking-only rows it
// leaves behind and hands them back to the normal machinery, without touching
// Jira mirrors (which also carry source='external' and must stay undispatchable).
test("v39 retires source='external' on non-mirror tasks and parks the live ones", () => {
  const path = tmpDb("v39");
  try {
    const db = openDb(path);
    const mk = (id: string, state: string, sourceRef: string | null) =>
      db
        .query(
          "INSERT INTO tasks (id, project_id, title, state, kind, source, source_ref, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)"
        )
        .run(id, "p1", id, state, "ship", "external", sourceRef, "2026-01-01", "2026-01-01");
    db.query("INSERT INTO projects (id, name, config, created_at) VALUES (?,?,?,?)").run("p1", "p", "{}", "2026-01-01");
    mk("parked", "queued", null);
    mk("gone", "cancelled", null);
    mk("mirror", "queued", "jira:WEB-1");

    const m = MIGRATIONS.find((x) => x.name === "v39-retire-tracking-only-source")!;
    for (const pass of [1, 2]) for (const stmt of m.statements) db.query(stmt).run(); // re-runnable

    const row = (id: string) =>
      db.query("SELECT source, deferred_until FROM tasks WHERE id = ?").get(id) as { source: string | null; deferred_until: string | null };
    expect(row("parked")).toEqual({ source: null, deferred_until: "9999-12-31T00:00:00.000Z" });
    expect(row("gone")).toEqual({ source: null, deferred_until: null }); // terminal: nothing to park
    expect(row("mirror")).toEqual({ source: "external", deferred_until: null }); // mirrors untouched
    db.close();
  } finally {
    cleanup(path);
  }
});
