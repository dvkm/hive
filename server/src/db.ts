// SQLite schema + tiny migration mechanism for hive.
// DB path from HIVE_DB env, default ~/.hive/hive.db. Directory is created if missing.
import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";

export function defaultDbPath(): string {
  return process.env.HIVE_DB || join(homedir(), ".hive", "hive.db");
}

export function hiveHome(): string {
  return process.env.HIVE_HOME || join(homedir(), ".hive");
}

export function evidenceDir(): string {
  return join(hiveHome(), "evidence");
}

// Migrations are an ordered list of SQL blocks. PRAGMA user_version tracks the
// highest applied index. Add a new entry to append a migration; never edit old ones.
const MIGRATIONS: string[] = [
  // v1 — full initial schema.
  `
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    repo_path TEXT,
    config TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );

  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    title TEXT NOT NULL,
    brief TEXT,
    state TEXT NOT NULL DEFAULT 'queued',
    kind TEXT NOT NULL DEFAULT 'ship',
    agent_target TEXT,
    worktree_path TEXT,
    branch TEXT,
    pr_url TEXT,
    ci_status TEXT,
    summary TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE events (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    ts TEXT NOT NULL,
    source TEXT NOT NULL,
    type TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX idx_events_task ON events(task_id, ts);

  CREATE TABLE evidence (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    ts TEXT NOT NULL,
    kind TEXT NOT NULL,
    path TEXT,
    url TEXT,
    caption TEXT,
    meta TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX idx_evidence_task ON evidence(task_id, ts);

  CREATE TABLE decisions (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    ts TEXT NOT NULL,
    title TEXT NOT NULL,
    context TEXT,
    risk TEXT,
    blast_radius TEXT,
    options TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'open',
    answer_key TEXT,
    answer_note TEXT,
    draft_note TEXT,
    answered_at TEXT
  );
  CREATE INDEX idx_decisions_status ON decisions(status);

  CREATE TABLE policies (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE incidents (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    monitor TEXT NOT NULL,
    ts TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    detail TEXT
  );
  `,
  // v2 — secrets: names/refs only, never values. Values live in the provider
  // (Keychain / Bitwarden) and are resolved at spawn time.
  `
  CREATE TABLE secrets (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    name TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT 'keychain',
    ref TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (project_id, name)
  );
  `,
];

export type DB = Database;

export function openDb(path: string = defaultDbPath()): DB {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

function migrate(db: DB): void {
  const current = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      // user_version can't be parameterized; index+1 is a trusted integer.
      db.exec(`PRAGMA user_version = ${v + 1}`);
    })();
  }
}

export function newId(prefix = ""): string {
  const s = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  return prefix ? `${prefix}_${s}` : s;
}

export function now(): string {
  return new Date().toISOString();
}
