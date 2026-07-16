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

// Migrations are keyed by a stable `name`, never by array position: two branches
// that each append a migration renumber each other at merge time, and a
// position-keyed counter then skips one forever while re-running the other
// (this happened, 2026-07-09). The applied set lives in `schema_migrations`.
//
// One statement per array element — do not glue several into one string. Each is
// executed individually so `alreadyApplied` can skip the ones whose effect the
// schema already has, which is what lets a drifted DB heal on open.
//
// Add an entry with a fresh name; never rename or edit an applied one. Anything
// that is not a CREATE/ALTER (an UPDATE backfill, say) re-runs on a heal, so
// write it to be re-runnable.
export const MIGRATIONS: { name: string; statements: string[] }[] = [
  {
    name: "v1-initial-schema",
    statements: [
      `CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        repo_path TEXT,
        config TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE tasks (
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
      )`,
      `CREATE TABLE events (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        ts TEXT NOT NULL,
        source TEXT NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}'
      )`,
      `CREATE INDEX idx_events_task ON events(task_id, ts)`,
      `CREATE TABLE evidence (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        ts TEXT NOT NULL,
        kind TEXT NOT NULL,
        path TEXT,
        url TEXT,
        caption TEXT,
        meta TEXT NOT NULL DEFAULT '{}'
      )`,
      `CREATE INDEX idx_evidence_task ON evidence(task_id, ts)`,
      `CREATE TABLE decisions (
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
      )`,
      `CREATE INDEX idx_decisions_status ON decisions(status)`,
      `CREATE TABLE policies (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE incidents (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        monitor TEXT NOT NULL,
        ts TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        detail TEXT
      )`,
    ],
  },
  // secrets: names/refs only, never values. Values live in the provider
  // (Keychain / Bitwarden) and are resolved at spawn time.
  {
    name: "v2-secrets",
    statements: [
      `CREATE TABLE secrets (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        name TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT 'keychain',
        ref TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (project_id, name)
      )`,
    ],
  },
  // regression/learning ledger. Recurring failures become tracked learnings
  // (injected into future briefs) that can auto-spawn a root-cause chore task.
  {
    name: "v3-learnings",
    statements: [
      `CREATE TABLE learnings (
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
      )`,
      `CREATE INDEX idx_learnings_project ON learnings(project_id, status, last_seen)`,
    ],
  },
  // notification queue. Notable events enqueue a row; urgent ones push a
  // macOS notification immediately, normal ones are batched into a digest.
  {
    name: "v4-notifications",
    statements: [
      `CREATE TABLE notifications (
        id TEXT PRIMARY KEY,
        ts TEXT NOT NULL,
        kind TEXT NOT NULL,
        task_id TEXT,
        decision_id TEXT,
        title TEXT NOT NULL,
        body TEXT,
        urgency TEXT NOT NULL DEFAULT 'normal',
        delivered_at TEXT
      )`,
      `CREATE INDEX idx_notifications_ts ON notifications(ts)`,
    ],
  },
  // intake connectors (Google Chat first). Tasks gain a source tag so the board
  // can flag externally-sourced, unreviewed work; source_ref holds the upstream
  // resource id (Chat message name) with a unique index for dedupe.
  // intake_cursors persists the incremental poll position per source+key.
  {
    name: "v5-intake",
    statements: [
      `ALTER TABLE tasks ADD COLUMN source TEXT`,
      `ALTER TABLE tasks ADD COLUMN source_ref TEXT`,
      `CREATE UNIQUE INDEX idx_tasks_source_ref ON tasks(source_ref) WHERE source_ref IS NOT NULL`,
      `CREATE TABLE intake_cursors (
        source TEXT NOT NULL,
        key TEXT NOT NULL,
        cursor TEXT,
        PRIMARY KEY (source, key)
      )`,
    ],
  },
  // standing-authority policy engine. David grants scoped authority once; the
  // server enforces it before risky actions dispatch. authority_rules match an
  // action to an effect (allow | require_decision | deny); most-specific active
  // rule wins (project over global, longer pattern over shorter).
  // authority_grants are the consumable, single-use grants minted when a
  // require_decision card is approved (scoped to action+target+task, 24h).
  {
    name: "v6-authority",
    statements: [
      `CREATE TABLE authority_rules (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id),
        scope TEXT NOT NULL,
        action_pattern TEXT NOT NULL,
        effect TEXT NOT NULL,
        note TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      )`,
      `CREATE INDEX idx_authority_rules_lookup ON authority_rules(project_id, active)`,
      `CREATE TABLE authority_grants (
        id TEXT PRIMARY KEY,
        task_id TEXT,
        action TEXT NOT NULL,
        target TEXT NOT NULL,
        decision_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        expires_at TEXT,
        consumed_at TEXT
      )`,
      `CREATE INDEX idx_authority_grants_lookup ON authority_grants(task_id, action, target, status)`,
    ],
  },
  // domain supervisors (on-demand planners). A planner proposes a task breakdown
  // for a source task; on approval the proposed tasks are created with
  // source='planner' and parent_task_id linking back to the source task.
  {
    name: "v7-planner-parent",
    statements: [
      `ALTER TABLE tasks ADD COLUMN parent_task_id TEXT`,
      `CREATE INDEX idx_tasks_parent ON tasks(parent_task_id) WHERE parent_task_id IS NOT NULL`,
    ],
  },
  // cost/token analytics. One row per reported LLM call. cost_usd is NULL when
  // the model is unpriced (surfaced as "unpriced"); otherwise computed
  // server-side from the pricing table (server/src/pricing.ts). source tags the
  // ingest path ('agent' via hive emit, 'hook' from the Stop-hook transcript).
  {
    name: "v8-usage",
    statements: [
      `CREATE TABLE usage (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        ts TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL,
        source TEXT NOT NULL DEFAULT 'agent'
      )`,
      `CREATE INDEX idx_usage_task ON usage(task_id, ts)`,
      `CREATE INDEX idx_usage_ts ON usage(ts)`,
    ],
  },
  // activity feed. A global reverse-chronological projection over events needs an
  // index on ts alone (idx_events_task is (task_id, ts), useless for a cross-task
  // ORDER BY ts).
  {
    name: "v9-events-ts-index",
    statements: [`CREATE INDEX idx_events_ts ON events(ts)`],
  },
  // duplicate-task detection & auto-merge. A task cancelled as a duplicate keeps
  // a pointer to the survivor it was folded into (never deleted, so history is
  // preserved). NULL for every non-duplicate task.
  {
    name: "v10-duplicate-of",
    statements: [`ALTER TABLE tasks ADD COLUMN duplicate_of TEXT`],
  },
  // human-friendly task numbers. A monotonic per-hive counter assigned at
  // creation (the opaque `id` stays the machine key; `number` is the handle
  // people and GitHub PR markers use). Backfilled in created_at order (id
  // tiebreak). An AFTER INSERT trigger assigns MAX(number)+1 to any row inserted
  // without one, so every insert path gets a number for free. UNIQUE guards
  // against collisions.
  //
  // The backfill is scoped to `number IS NULL` so a re-run on a fully-numbered DB
  // is a no-op and can never renumber live tasks. It ranks over ALL tasks, which
  // is only collision-free when no row is numbered yet — the sole state a real DB
  // reaches, since the trigger numbers every insert. A partially-numbered DB
  // would produce duplicates, and the UNIQUE index below is what catches that:
  // it fails the migration transaction and openDb throws rather than committing
  // corrupt numbers. Loud beats silent.
  {
    name: "v11-task-numbers",
    statements: [
      `ALTER TABLE tasks ADD COLUMN number INTEGER`,
      `UPDATE tasks SET number = (
        SELECT COUNT(*) FROM tasks t2
        WHERE t2.created_at < tasks.created_at
           OR (t2.created_at = tasks.created_at AND t2.id <= tasks.id)
      ) WHERE number IS NULL`,
      `CREATE UNIQUE INDEX idx_tasks_number ON tasks(number)`,
      `CREATE TRIGGER tasks_assign_number AFTER INSERT ON tasks
      WHEN NEW.number IS NULL
      BEGIN
        UPDATE tasks SET number = (SELECT COALESCE(MAX(number), 0) + 1 FROM tasks)
        WHERE id = NEW.id;
      END`,
    ],
  },
  // cache-write tokens get their own bucket. They were folded into input_tokens
  // and billed at 1x input, but a cache write costs 1.25x. Pre-existing rows keep
  // the fold-in (0 here); scripts/reprice-usage.ts recomputes their cost_usd
  // against the corrected price table.
  {
    name: "v12-cache-write-tokens",
    statements: [`ALTER TABLE usage ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0`],
  },
  // Global key/value settings (first user: offline mode — drain the fleet and
  // resume later). Kept generic; anything hive-wide and toggleable lives here.
  {
    name: "v13-settings",
    statements: [
      `CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
    ],
  },
  // Learnings split into kinds: 'failure' (gotchas, occurrence-aged, brief shows
  // 10 most recent) and 'reference' (durable project facts — design files, URLs,
  // glossary; ALL pinned into briefs + planner, never truncated). The Figma link
  // the planner kept asking for is a 'reference', not a rule or a failure.
  {
    name: "v14-learning-kind",
    statements: [`ALTER TABLE learnings ADD COLUMN kind TEXT NOT NULL DEFAULT 'failure'`],
  },
  // Web-push subscriptions for the mobile PWA (native notifications). Keyed by
  // the push endpoint (unique per device+browser); replacing a stale one is an
  // upsert on that key.
  {
    name: "v15-push-subscriptions",
    statements: [
      `CREATE TABLE IF NOT EXISTS push_subscriptions (
        endpoint TEXT PRIMARY KEY,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_ok TEXT
      )`,
    ],
  },
  // The PR's current head commit, refreshed by the reconciler's PR poll
  // alongside ci_status. Lets the review card flag evidence captured against
  // an older commit as stale (task #226).
  {
    name: "v16-task-head-sha",
    statements: [`ALTER TABLE tasks ADD COLUMN head_sha TEXT`],
  },
  // Task dependencies: a JSON array of task ids this task waits on. The
  // dispatcher won't spawn — and the reconciler won't advance — a task until
  // every listed dependency is merged/done (see unmetDeps in state.ts).
  {
    name: "v17-task-depends-on",
    statements: [`ALTER TABLE tasks ADD COLUMN depends_on TEXT`],
  },
  // Director chat: a conversational surface backed by a PERSISTENT supervisor
  // session. A thread is scoped to a project; task_id is the thread's backing
  // supervisor task (its herdr agent IS the session). Messages are an
  // append-only log (same shape as `events`) so history persists in the state
  // store. No FK on project_id/task_id — set structurally by the chat handlers.
  {
    name: "v18-chat",
    statements: [
      `CREATE TABLE chat_threads (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        task_id TEXT,
        title TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE chat_messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES chat_threads(id),
        ts TEXT NOT NULL,
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        actions TEXT NOT NULL DEFAULT '[]'
      )`,
      `CREATE INDEX idx_chat_messages_thread ON chat_messages(thread_id, ts)`,
      `CREATE INDEX idx_chat_threads_project ON chat_threads(project_id, updated_at)`,
    ],
  },
];

// -------------------------------------------------------------- settings
export function getSetting(db: DB, key: string): string | null {
  const r = db.query("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return r?.value ?? null;
}

export function setSetting(db: DB, key: string, value: string): void {
  db.query(
    "INSERT INTO settings (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  ).run(key, value, new Date().toISOString());
}

// Offline mode: nothing new spawns, network-dependent supervision pauses,
// working agents were told to park after their current step. See docs/API.md.
export function isOffline(db: DB): boolean {
  return getSetting(db, "offline") === "1";
}

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

export const CREATES = /^\s*CREATE\s+(?:UNIQUE\s+)?(TABLE|INDEX|TRIGGER|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/i;
export const ADD_COLUMN = /^\s*ALTER\s+TABLE\s+(\w+)\s+ADD\s+(?:COLUMN\s+)?(\w+)/i;

// Does the schema already have what this statement would create? SQLite has no
// IF NOT EXISTS for ALTER TABLE ADD COLUMN, and we want the same skip-if-present
// answer for every statement kind, so ask the schema rather than pattern-match
// SQLite's error strings, which are not an API.
//
// Matches on type AND name, so an index named after an existing table is still
// created rather than silently skipped.
//
// ponytail: matches identity, not definition — an existing object with the same
// type+name but a different body is assumed to be ours and skipped. The
// migrations-are-well-formed test rejects duplicate names at CI time, which is
// where that collision would actually come from. Compare sqlite_master.sql here
// if a migration ever has to reconcile a foreign object of the same name.
export function alreadyApplied(db: DB, stmt: string): boolean {
  const created = CREATES.exec(stmt);
  if (created) {
    const [, kind, name] = created;
    return db.query("SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?").get(kind.toLowerCase(), name) != null;
  }
  const added = ADD_COLUMN.exec(stmt);
  if (added) {
    // Identifiers come from our own migration text and are \w+; PRAGMA takes no params.
    const cols = db.query(`PRAGMA table_info(${added[1]})`).all() as { name: string }[];
    return cols.some((c) => c.name === added[2]);
  }
  // Anything else (an UPDATE backfill) has no schema effect to detect, so it
  // always runs and must be written re-runnable. Guard against a migration whose
  // effect we cannot verify being silently trusted.
  return false;
}

function migrate(db: DB): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)"
  );
  const applied = new Set(
    (db.query("SELECT name FROM schema_migrations").all() as { name: string }[]).map((r) => r.name)
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.name)) continue;
    db.transaction(() => {
      let skipped = 0;
      for (const stmt of m.statements) {
        if (alreadyApplied(db, stmt)) {
          skipped++;
          continue;
        }
        // .trim() is load-bearing: bun:sqlite's exec() silently swallows a
        // step-time error (a failing UNIQUE index build, a CHECK violation) when
        // anything trails the final `;`. Migrations must fail closed.
        // exec(), not prepare().run(): prepare() compiles only the first
        // statement and silently discards the rest.
        db.exec(stmt.trim());
      }
      // Expected once per DB when adopting the ledger; on an already-adopted DB
      // it means schema drift.
      if (skipped > 0) {
        console.warn(`[db] migration ${m.name}: ${skipped} statement(s) already applied, skipped`);
      }
      db.query("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(m.name, now());
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
