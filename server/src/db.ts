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
  // v3 — regression/learning ledger. Recurring failures become tracked learnings
  // (injected into future briefs) that can auto-spawn a root-cause chore task.
  `
  CREATE TABLE learnings (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    title TEXT NOT NULL,
    body TEXT,
    source_task_id TEXT,
    occurrences INTEGER NOT NULL DEFAULT 1,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    root_cause_task_id TEXT
  );
  CREATE INDEX idx_learnings_project ON learnings(project_id, status, last_seen);
  `,
  // v4 — notification queue. Notable events enqueue a row; urgent ones push a
  // macOS notification immediately, normal ones are batched into a digest.
  `
  CREATE TABLE notifications (
    id TEXT PRIMARY KEY,
    ts TEXT NOT NULL,
    kind TEXT NOT NULL,
    task_id TEXT,
    decision_id TEXT,
    title TEXT NOT NULL,
    body TEXT,
    urgency TEXT NOT NULL DEFAULT 'normal',
    delivered_at TEXT
  );
  CREATE INDEX idx_notifications_ts ON notifications(ts);
  `,
  // v5 — intake connectors (Google Chat first). Tasks gain a source tag so the
  // board can flag externally-sourced, unreviewed work; source_ref holds the
  // upstream resource id (Chat message name) with a unique index for dedupe.
  // intake_cursors persists the incremental poll position per source+key.
  `
  ALTER TABLE tasks ADD COLUMN source TEXT;
  ALTER TABLE tasks ADD COLUMN source_ref TEXT;
  CREATE UNIQUE INDEX idx_tasks_source_ref ON tasks(source_ref) WHERE source_ref IS NOT NULL;

  CREATE TABLE intake_cursors (
    source TEXT NOT NULL,
    key TEXT NOT NULL,
    cursor TEXT,
    PRIMARY KEY (source, key)
  );
  `,
  // v6 — standing-authority policy engine. David grants scoped authority once;
  // the server enforces it before risky actions dispatch. authority_rules match
  // an action to an effect (allow | require_decision | deny); most-specific
  // active rule wins (project over global, longer pattern over shorter).
  // authority_grants are the consumable, single-use grants minted when a
  // require_decision card is approved (scoped to action+target+task, 24h).
  `
  CREATE TABLE authority_rules (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id),   -- NULL = global
    scope TEXT NOT NULL,                        -- display label: 'global' | 'project:<id>'
    action_pattern TEXT NOT NULL,              -- glob, '*' wildcard
    effect TEXT NOT NULL,                       -- allow | require_decision | deny
    note TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_authority_rules_lookup ON authority_rules(project_id, active);

  CREATE TABLE authority_grants (
    id TEXT PRIMARY KEY,
    task_id TEXT,
    action TEXT NOT NULL,
    target TEXT NOT NULL,
    decision_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending',     -- pending | granted | denied | consumed
    created_at TEXT NOT NULL,
    expires_at TEXT,
    consumed_at TEXT
  );
  CREATE INDEX idx_authority_grants_lookup ON authority_grants(task_id, action, target, status);
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
