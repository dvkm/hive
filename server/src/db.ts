// SQLite schema + tiny migration mechanism for hive.
// DB path from HIVE_DB env, default ~/.hive/hive.db. Directory is created if missing.
import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";

export function defaultDbPath(): string {
  return process.env.HIVE_DB || homeDbPath();
}

// The LIVE fleet's database, ignoring every env override. HIVE_DB moves
// defaultDbPath; nothing moves this. The single-server guard needs to know
// "am I about to open the real one?" and cannot ask defaultDbPath, which
// answers with whatever the caller already set.
export function homeDbPath(): string {
  return join(homedir(), ".hive", "hive.db");
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
  // standing-authority policy engine. The director grants scoped authority once; the
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
  // Who answered a decision. Before this, every answer was logged as the
  // director — a chat-supervisor or any API caller was indistinguishable from
  // the director in the audit trail. answered_by is the caller identity
  // (director|chat_supervisor|agent|system|unknown), answered_actor an optional
  // free label (e.g. the supervisor session id). Audit only, no auto-approve.
  {
    name: "v19-decision-caller",
    statements: [
      `ALTER TABLE decisions ADD COLUMN answered_by TEXT`,
      `ALTER TABLE decisions ADD COLUMN answered_actor TEXT`,
    ],
  },
  // "Deferred, waiting on a human": a task blocked on an OFFLINE human action
  // (e.g. sudo) answered "Schedule for later" has no state that fits —
  // in_progress keeps drawing "gone quiet" nudges (task #329 got 9+),
  // needs_decision is wrong with no open card. deferred_until parks it: the
  // stale/nudge machinery skips it while the timestamp is in the future, and it
  // stays in_progress (no state hop). Far-future = indefinite; a real date =
  // auto-resume then; the director/agent un-defers to resume early.
  {
    name: "v20-task-deferred-until",
    statements: [`ALTER TABLE tasks ADD COLUMN deferred_until TEXT`],
  },
  // A director-chat thread is one top-level supervisor run. Keep its current
  // objective and control-loop cursor on the thread; meetings, verification
  // attempts, and retrospectives stay append-only task events.
  {
    name: "v21-supervisor-run-ledger",
    statements: [
      `ALTER TABLE chat_threads ADD COLUMN objective TEXT`,
      `ALTER TABLE chat_threads ADD COLUMN acceptance_criteria TEXT NOT NULL DEFAULT '[]'`,
      `ALTER TABLE chat_threads ADD COLUMN phase TEXT NOT NULL DEFAULT 'intake'`,
      `ALTER TABLE chat_threads ADD COLUMN next_action TEXT`,
      `ALTER TABLE chat_threads ADD COLUMN waiting_on TEXT`,
      `ALTER TABLE chat_threads ADD COLUMN wakeup_at TEXT`,
      `ALTER TABLE chat_threads ADD COLUMN outcome TEXT`,
      `ALTER TABLE chat_threads ADD COLUMN completed_at TEXT`,
    ],
  },
  // Commitments are the outcomes a supervisor owes, not another copy of its
  // worker task list. They stay linked to the conversation or task that
  // created the obligation, while owner_task_id points at the current worker.
  {
    name: "v22-supervisor-commitments",
    statements: [
      `CREATE TABLE commitments (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES chat_threads(id),
        project_id TEXT NOT NULL REFERENCES projects(id),
        title TEXT NOT NULL,
        owner_task_id TEXT REFERENCES tasks(id),
        source_message_id TEXT REFERENCES chat_messages(id),
        source_task_id TEXT REFERENCES tasks(id),
        status TEXT NOT NULL DEFAULT 'open',
        due_at TEXT,
        depends_on TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE INDEX idx_commitments_thread ON commitments(thread_id, status, updated_at)`,
    ],
  },
  // The command-card haiku explainer (explain.ts) now reports a structured
  // verdict ("zero-risk" | "real-risk"), not just free-text bullets. Stored
  // per-decision so the deny-guardrail tally (authority.ts) can exclude
  // denials the explainer already called zero-risk from the "always block?"
  // count — a false-positive classifier match shouldn't be able to mint a
  // standing deny rule on its own (task 1022).
  {
    name: "v23-decision-explainer-verdict",
    statements: [`ALTER TABLE decisions ADD COLUMN explainer_verdict TEXT`],
  },
  // Every hive server process registers here BEFORE it runs a single background
  // loop, so the one holding the DB lease can see — and terminate — any other
  // server still attached to this database (lease.ts). A lease alone only tells
  // a well-behaved predecessor to stand down; this is what closes the case
  // where it doesn't (task #1152).
  {
    name: "v24-server-instances",
    statements: [
      `CREATE TABLE server_instances (
        instance TEXT PRIMARY KEY,
        pid INTEGER NOT NULL,
        port INTEGER NOT NULL,
        registered_at TEXT NOT NULL,
        evicted_at TEXT
      )`,
    ],
  },
  // Requeue adoption pointers: the predecessor's branch/ghost-branch/open-PR,
  // recorded structurally on the requeue's own row (not just prose in its
  // brief) so a dispatch-time guard can enforce "adopt, don't rebuild" even if
  // the brief text is later edited. Fixes the duplicate-PR class (hive-1090):
  // a requeued task rebuilt a whole feature as a second PR while the first
  // one sat open, unreferenced, on the failed predecessor.
  {
    name: "v24-task-resume-context",
    statements: [
      `ALTER TABLE tasks ADD COLUMN resume_branch TEXT`,
      `ALTER TABLE tasks ADD COLUMN resume_ghost_branch TEXT`,
      `ALTER TABLE tasks ADD COLUMN resume_pr_url TEXT`,
    ],
  },
  // Human-facing task numbers are scoped to their project. The original
  // globally unique `number` remains intact for old PR markers and API
  // compatibility; `project_number` is the stable sequence used by the UI.
  {
    name: "v25-project-task-numbers",
    statements: [
      `ALTER TABLE tasks ADD COLUMN project_number INTEGER`,
      `UPDATE tasks SET project_number = (
        SELECT COUNT(*) FROM tasks t2
        WHERE t2.project_id = tasks.project_id
          AND (t2.created_at < tasks.created_at
            OR (t2.created_at = tasks.created_at AND t2.id <= tasks.id))
      ) WHERE project_number IS NULL`,
      `CREATE UNIQUE INDEX idx_tasks_project_number ON tasks(project_id, project_number)`,
      `CREATE TRIGGER tasks_assign_project_number AFTER INSERT ON tasks
      WHEN NEW.project_number IS NULL
      BEGIN
        UPDATE tasks SET project_number = (
          SELECT COALESCE(MAX(project_number), 0) + 1 FROM tasks
          WHERE project_id = NEW.project_id
        ) WHERE id = NEW.id;
      END`,
    ],
  },
  // Red-CI freshness. `ci_checked_at` records when the reconciler last LOOKED at
  // a PR's checks (ci_status only changes when the answer changes), and the two
  // decision columns pin what a card actually cited: the CI status at the moment
  // it was written, and the infra-outage signal (if any) it was blocked by. A
  // card can then be re-checked when rendered, and a second PR hitting the same
  // outage inherits the director's one ruling instead of asking again.
  {
    name: "v26-ci-signal-freshness",
    statements: [
      `ALTER TABLE tasks ADD COLUMN ci_checked_at TEXT`,
      `ALTER TABLE decisions ADD COLUMN ci_status_at_card TEXT`,
      `ALTER TABLE decisions ADD COLUMN ci_signal TEXT`,
    ],
  },
  // The PR's last-observed GitHub state (OPEN/CLOSED/MERGED), refreshed by the
  // reconciler's PR poll alongside ci_status. advanceIfFinished reads this to
  // avoid promoting to in_review a task whose PR is already known-closed —
  // syncPRs would immediately bounce it back, ping-ponging every tick (#1256).
  {
    name: "v27-task-pr-state",
    statements: [`ALTER TABLE tasks ADD COLUMN pr_state TEXT`],
  },
  // A requeue row's parent_task_id is trusted only once its creation event has
  // been verified (state.ts: verifyRequeueProvenance) — a hand-inserted or
  // otherwise provenance-less row must never be treated as recovery lineage.
  // The partial index is what lets the startup/reconciler sweep scan only rows
  // still awaiting a verdict, instead of every source='requeue' task ever
  // created (hive-305).
  {
    name: "v28-requeue-provenance",
    statements: [
      `ALTER TABLE tasks ADD COLUMN requeue_provenance_verified INTEGER NOT NULL DEFAULT 0`,
      `CREATE INDEX idx_tasks_unverified_requeue ON tasks(id) WHERE source = 'requeue' AND requeue_provenance_verified = 0`,
    ],
  },
  // Land queue (task #1257): when the director marks an in-review task
  // approved-to-land, this stamps the approval. The reconciler's land sweep
  // merges every marked task whose graph edges are satisfied and clears the
  // stamp; a task that leaves review loses the stamp and needs a fresh mark.
  {
    name: "v29-task-land-queue",
    statements: [`ALTER TABLE tasks ADD COLUMN land_queued_at TEXT`],
  },
  {
    name: "v30-task-jira-link",
    statements: [
      `ALTER TABLE tasks ADD COLUMN jira_key TEXT`,
      `ALTER TABLE tasks ADD COLUMN jira_link_kind TEXT CHECK (jira_link_kind IN ('mirror', 'subtask'))`,
      `CREATE UNIQUE INDEX idx_tasks_jira_key ON tasks(jira_key) WHERE jira_key IS NOT NULL`,
      `UPDATE tasks SET jira_key = substr(source_ref, 6), jira_link_kind = 'mirror'
       WHERE source_ref LIKE 'jira:%' AND jira_key IS NULL`,
    ],
  },
  {
    name: "v31-task-jira-link-kind-uniqueness",
    statements: [
      `DROP INDEX IF EXISTS idx_tasks_jira_key`,
      `CREATE UNIQUE INDEX idx_tasks_jira_key_kind ON tasks(jira_key, jira_link_kind) WHERE jira_key IS NOT NULL`,
    ],
  },
  // PR #186 token-gated subscription creation at 2026-08-24T21:58:34Z.
  // Remove endpoints registered before that protection existed.
  {
    name: "v32-prune-unauthenticated-push-subscriptions",
    statements: [`DELETE FROM push_subscriptions WHERE created_at < '2026-08-24T21:58:34Z'`],
  },
  {
    name: "v33-pr-gardener",
    statements: [
      `CREATE TABLE pr_gardener_items (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        pr_number INTEGER NOT NULL,
        pr_url TEXT NOT NULL,
        title TEXT NOT NULL,
        classification TEXT NOT NULL,
        reason TEXT NOT NULL,
        sensitive INTEGER NOT NULL DEFAULT 0,
        override TEXT,
        action_task_id TEXT REFERENCES tasks(id),
        decision_id TEXT REFERENCES decisions(id),
        fix_attempts INTEGER NOT NULL DEFAULT 0,
        last_action TEXT,
        last_action_at TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (project_id, pr_number)
      )`,
      `CREATE INDEX idx_pr_gardener_action_task ON pr_gardener_items(action_task_id)`,
    ],
  },
  // Per-task verification contract: a JSON array of {name, cmd} the agent must
  // run before handing off, each piece of evidence tagged with the name it
  // came from (`hive emit ... --verify-name <name>`). Data only for now —
  // nothing is gated on it yet.
  {
    name: "v34-task-verification-cmds",
    statements: [`ALTER TABLE tasks ADD COLUMN verification_cmds TEXT`],
  },
  // Four-level ordinal priority: now > next > normal > later. ORDERING ONLY —
  // it decides which queued task is picked up first and which approved PR lands
  // first. It never preempts: a running agent is never killed to make room.
  // Validated in the app (api.ts), not by a CHECK constraint, so the vocabulary
  // can grow without a table rebuild.
  {
    name: "v35-task-priority",
    statements: [`ALTER TABLE tasks ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal'`],
  },
  // Where a terminal task's pr_url goes when it's found to point at a PR that
  // no longer carries this task's marker (hive-487: a repo migration reset PR
  // numbering, so old pr_urls silently resolved to unrelated PRs). Keeps the
  // historical reference instead of discarding it, without it being mistaken
  // for a live link.
  {
    name: "v36-task-legacy-pr-url",
    statements: [`ALTER TABLE tasks ADD COLUMN legacy_pr_url TEXT`],
  },
  // A decision that names its own class. Set on cards no automation may ever
  // answer for the director (today: intake triage), and checked by every
  // auto-answer path.
  {
    name: "v37-decision-class",
    statements: [`ALTER TABLE decisions ADD COLUMN decision_class TEXT`],
  },
  {
    name: "v38-events-type-task-index",
    statements: [`CREATE INDEX idx_events_type_task ON events(type, task_id, ts)`],
  },
  // --track is retired (hive-1864): source='external' made a task hive could
  // never dispatch and never spawn, silently, so 26 of them went nowhere. The
  // parked ones become ordinary tasks deferred indefinitely — visible in the
  // queue, skipped by the dispatcher, resumed with `hive emit <id> undefer`.
  // Jira mirrors keep source='external' (source_ref 'jira:KEY' gates them on its
  // own, and they are the healthy population). Both statements re-run safely:
  // the park runs before the source clear, and once source is cleared the WHERE
  // matches nothing.
  {
    name: "v39-retire-tracking-only-source",
    statements: [
      `UPDATE tasks SET deferred_until = '9999-12-31T00:00:00.000Z'
         WHERE source = 'external' AND COALESCE(source_ref, '') NOT LIKE 'jira:%'
           AND state NOT IN ('done', 'failed', 'cancelled') AND deferred_until IS NULL`,
      `UPDATE tasks SET source = NULL
         WHERE source = 'external' AND COALESCE(source_ref, '') NOT LIKE 'jira:%'`,
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

// A test that forgets to pass a scratch path falls through to defaultDbPath()
// and writes fixtures straight into the live fleet database (hive-1436: a
// leaked "scratch (hive-1560 seed)" project with repo_path '/repo' wasted a
// reconciler spawn every cycle for ~10 hours). `bun test` sets NODE_ENV=test
// on its own, so this needs no per-test opt-in.
export function openDb(path: string = defaultDbPath()): DB {
  if (process.env.NODE_ENV === "test" && path === homeDbPath()) {
    throw new Error(
      `openDb: refusing to open the live database (${homeDbPath()}) under NODE_ENV=test. Pass an explicit scratch path, e.g. openDb(":memory:").`
    );
  }
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path, { create: true });
  try {
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA foreign_keys = ON;");
    migrate(db);
    return db;
  } catch (error) {
    // Windows refuses to reopen/delete a SQLite file while a failed migration's
    // handle is still live. Close before rethrowing so recovery and tests can
    // inspect the unchanged database immediately.
    db.close();
    throw error;
  }
}

export const CREATES = /^\s*CREATE\s+(?:UNIQUE\s+)?(TABLE|INDEX|TRIGGER|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/i;
export const ADD_COLUMN = /^\s*ALTER\s+TABLE\s+(\w+)\s+ADD\s+(?:COLUMN\s+)?(\w+)/i;
export const DROPS = /^\s*DROP\s+(TABLE|INDEX|TRIGGER|VIEW)\s+(?:IF\s+EXISTS\s+)?(\w+)/i;

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
  const dropped = DROPS.exec(stmt);
  if (dropped) {
    const [, kind, name] = dropped;
    return db.query("SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?").get(kind.toLowerCase(), name) == null;
  }
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
