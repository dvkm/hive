// Every shape the API speaks, and nothing that runs.
//
// These live apart from api.ts because api.ts is browser code (it opens a
// dialog, reads localStorage, touches the cache API). The needs-you rules in
// needsYou.ts are shared with the server (server/src/attention.ts imports them
// so the count there and the nav badge here can never be two definitions), and
// a type import from a browser-only module drags the whole browser module into
// the server's typecheck. api.ts re-exports everything here, so every existing
// `from "./api"` import is unchanged.

export type State =
  | "queued"
  | "in_progress"
  | "needs_decision"
  | "in_review"
  | "verifying"
  | "done"
  | "failed"
  | "cancelled";

export type Kind = "ship" | "scout" | "chore";

// "unavailable" = GitHub created the check but refused to run the job (billing,
// no runner). Red on GitHub, but nothing an agent can fix, so hive doesn't gate
// on it — see ciStatusProbed in server/src/reconciler.ts.
export type CiStatus = "passing" | "failing" | "pending" | "unavailable" | null;

// Server-computed health (single source of truth; never re-derived here).
export type HealthStatus = "healthy" | "deferred" | "silent" | "stuck" | "dead";

export interface Health {
  status: HealthStatus;
  reason: string | null;
  since: string;
}

// Latest background check on a task's own commits (server/src/sidecar.ts):
// hive runs tsc and the project's lint script on an agent's fresh commits while
// it works. Advisory only; CI is still the merge gate.
export interface SidecarReport {
  sha: string;
  ok: boolean;
  findings: { tool: string; summary: string }[];
}

export interface Task {
  id: string;
  number: number; // legacy global handle retained for PR markers and API compatibility
  project_number?: number; // stable sequence within the project
  display_id?: string; // project-scoped human handle, e.g. HIVE-247
  project_id: string;
  title: string;
  brief?: string | null; // omitted from the compact list; present on task detail
  state: State;
  kind: Kind;
  priority?: "now" | "next" | "normal" | "later";
  agent_target: string | null;
  worktree_path: string | null;
  branch: string | null;
  pr_url: string | null;
  ci_status: CiStatus;
  head_sha: string | null; // PR's current head commit, refreshed by the reconciler's PR poll
  summary: string | null;
  source: string | null;
  source_ref: string | null;
  jira_key: string | null;
  jira_link_kind: "mirror" | "subtask" | null;
  parent_task_id: string | null;
  race_id?: string | null; // best-of-N: the group of attempts this task is one of
  duplicate_of: string | null; // survivor id when cancelled as a duplicate
  depends_on: string[]; // task ids governed by the server dependency gate (docs/API.md)
  deferred_until?: string | null; // parked pending an offline human action; nudges suppressed while future-dated
  parked_for_director?: string | null; // director took the worktree over; no agent runs on it until hand-back
  land_queued_at?: string | null; // marked approved-to-land; the land queue merges it in graph order
  needs_you_since?: string | null; // when review/failed entered Focus; unlike updated_at, CI and metadata cannot reset it
  health?: Health | null;
  sidecar?: SidecarReport | null; // latest background check on this task's commits
  evidence_count?: number; // list endpoint only; avoids fetching every task detail on startup
  spawn_error?: boolean; // list endpoint only; prior spawn failed and no spawn ever succeeded
  overlap_hold?: { number: number; files: string[] } | null; // list endpoint only; queued behind a live task that looks like it edits the same files
  requeued_to?: string | null; // successor id when failed + auto-requeued
  review_actionable?: boolean; // in_review AND the director can act on it now (server-computed, HIVE-500)
  skip?: { reason: string; label: string; permanent: boolean; since: string | null } | null; // queued only: why the dispatcher last skipped it
  never_dispatched?: boolean; // source=external, never spawned — no agent exists or ever will unless manually dispatched
  reviewed?: boolean; // intake tasks only: the director (or intake triage) signalled it is free to dispatch
  created_at: string;
  updated_at: string;
}

export interface Event {
  id: string;
  task_id: string;
  ts: string;
  source: "agent" | "hook" | "herdr" | "reconciler" | "monitor" | "director" | "system" | "supervisor" | "chat_supervisor" | "jira" | "jira-sync" | "unknown";
  type: string;
  payload: Record<string, unknown>;
}

export interface Evidence {
  id: string;
  task_id: string;
  ts: string;
  kind: "screenshot" | "test_run" | "log" | "report" | "explanation" | "link";
  path: string | null;
  url: string | null;
  caption: string | null;
  meta: Record<string, unknown>;
  preview?: string | null; // first ~3 lines of a test_run/log file (server-provided)
}

// One evidence row in the browser: the evidence joined to its task + project.
export interface EvidenceRow extends Evidence {
  task_title: string;
  task_kind: Kind;
  project_id: string;
  project_name: string;
}

export interface Option {
  key: string;
  label: string;
  detail?: string;
  recommended?: boolean;
}

export interface Decision {
  id: string;
  task_id: string;
  ts: string;
  title: string;
  context: string | null;
  risk: string | null;
  blast_radius: string | null;
  options: Option[];
  status: "open" | "answered" | "expired";
  answer_key: string | null;
  answer_note: string | null;
  draft_note: string | null;
  answered_at: string | null;
  // Who answered (audit trail). director when the director clicked in the inbox;
  // chat_supervisor/agent/system for programmatic callers; unknown if unattributed.
  // "reconciler" on a card the system expired, "unattributed" on a card
  // resolved before hive recorded answerers at all (everything before
  // 2026-07-22). null only ever appears on an open card.
  answered_by: "director" | "chat_supervisor" | "agent" | "system" | "unknown" | "reconciler" | "unattributed" | null;
  answered_actor: string | null;
  // Set on cards no automation may answer — today only "intake_triage", the
  // "which reading should we build?" card raised by intake triage.
  decision_class: string | null;
  bundle?: DecisionBundle | null;
  plan?: DecisionPlan | null;
}

// Structured planner breakdown behind a "Proposed breakdown: …" decision, so
// the card can render an actual checklist + question inputs instead of the
// flattened `context` text. Null for every other kind of decision.
export interface DecisionPlan {
  proposed_tasks: { title: string; brief: string; kind: Kind }[];
  rationale: string;
  questions: string[];
  reason: string;
}

// Server-derived context bundled onto each open card (see decisionBundle in
// api.ts): prior director choices on this project, the affected PR/branch, and
// task spend so far — enough to decide without opening the task.
export interface DecisionBundle {
  task_number: number | null;
  task_display_id?: string | null;
  // Only on cards whose own words are about CI: what they cited, what the
  // checks say now, and when hive last looked.
  ci?: {
    at_card: string;
    status: string | null;
    checked_at: string | null;
    changed: boolean;
    outage?: { signal: string; fix_task_number: number | null } | null;
  } | null;
  pr_url: string | null;
  branch: string | null;
  spend_usd: number;
  prior_decisions: { id: string; title: string; answer: string | null; answered_at: string | null }[];
}

export interface Policy {
  id: string;
  scope: string; // "global" | "project:<id>"
  title: string;
  body: string;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface AuthorityRule {
  id: string;
  project_id: string | null;
  scope: string; // "global" | "project:<id>"
  action_pattern: string;
  effect: "allow" | "require_decision" | "deny";
  note: string | null;
  active: boolean;
  created_at: string;
}

export interface Project {
  id: string;
  name: string;
  repo_path: string | null;
  config: {
    default_branch?: string;
    deploy_notes?: string;
    monitors?: { name: string; url: string; expect_status: number; expect_substring?: string; interval_s: number }[];
    auto_dispatch?: boolean;
    dispatch_kinds?: Kind[];
    max_agents?: number;
    supervisor_persona?: string;
    playbook?: string;
    agent?: "claude" | "codex" | "teamclaude";
    codex_model?: string;
    codex_model_by_kind?: Partial<Record<Kind, string>>;
    codex_reasoning_effort?: "minimal" | "low" | "medium" | "high" | "xhigh";
    codex_reasoning_effort_by_kind?: Partial<Record<Kind, "minimal" | "low" | "medium" | "high" | "xhigh">>;
    codex_auto_compact_token_limit?: number;
    codex_tool_output_token_limit?: number;
    processed_token_warn?: number;
    processed_token_cap?: number;
    wait_call_warn?: number;
    wait_call_cap?: number;
    autonomy_profile?: "conservative" | "balanced" | "autopilot";
    // Opt-in: presence of this key is what puts the project on /deployments.
    deployments?: {
      deploy_workflow?: string;
      rollback_workflow?: string;
      tag_prefix?: string;
      workflow_ref?: string;
      health_url?: string;
      health_substring?: string;
      posthog_project?: string;
      posthog_host?: string;
      flags?: string[];
      history?: number;
    };
    archived?: boolean;
    test?: boolean;
    pr_gardener?: {
      enabled?: boolean;
      cadence?: string;
      land_when?: "green_and_clean";
      close_stale_after?: string;
      auto_close_superseded?: boolean;
      sensitive_paths?: string[];
      max_actions_per_sweep?: number;
      max_fix_attempts?: number;
    };
    [k: string]: unknown;
  };
  // Server-canonicalized Jira site (null unless the project's config passes the
  // credential gate). The only trusted base for a browse link in the UI.
  jira_site: string | null;
  created_at: string;
}

export interface PrGardenerItem {
  project_id: string;
  pr_number: number;
  pr_url: string;
  title: string;
  classification: "land" | "rebase" | "fix" | "close" | "decision" | "hold" | "wait";
  reason: string;
  sensitive: number;
  override: "force_land" | "force_close" | "hold" | null;
  decision_id: string | null;
  linked_task_id: string | null;
  linked_task_state: State | null;
}

// Production releases for a project (server/src/deployments.ts). The newest
// `prod-*` tag is what is live; there is no branch that means "production".
export interface Release {
  tag: string;
  sha: string;
  short: string;
  subject: string;
  created_at: string;
  current: boolean;
}

export interface FlagState {
  key: string;
  name: string | null;
  active: boolean | null; // null = PostHog has no such flag, or hive could not ask
  rollout: number | null;
}

export interface WorkflowRun {
  id: number;
  name: string;
  event: string;
  status: string;
  conclusion: string | null;
  url: string;
  created_at: string;
  head_sha: string;
}

export interface DeploymentsStatus {
  branch: string;
  head: { sha: string; short: string; subject: string } | null;
  current: Release | null;
  releases: Release[];
  ahead: number | null;
  health: { ok: boolean; detail: string; url: string } | null;
  flags: { available: boolean; reason: string | null; items: FlagState[] };
  runs: WorkflowRun[];
  errors: string[];
}

export interface Incident {
  id: string;
  project_id: string;
  monitor: string;
  ts: string;
  status: "open" | "resolved";
  detail: string;
}

export interface Learning {
  id: string;
  project_id: string;
  title: string;
  body: string | null;
  source_task_id: string | null;
  occurrences: number;
  first_seen: string;
  last_seen: string;
  status: "active" | "resolved";
  root_cause_task_id: string | null;
  kind?: string; // "failure" | "reference" | "decision" (required on create, no default)
}

export interface Notification {
  id: string;
  ts: string;
  kind: string;
  task_id: string | null;
  decision_id: string | null;
  title: string;
  body: string | null;
  urgency: "normal" | "urgent";
  delivered_at: string | null;
}

// Director chat: a persistent supervisor session over hive (server/src/chat.ts).
export interface ChatThread {
  id: string;
  project_id: string | null;
  task_id: string | null;
  title: string | null;
  objective: string | null;
  acceptance_criteria: string[];
  phase: "intake" | "planning" | "executing" | "waiting" | "verifying" | "complete" | "stopped";
  next_action: string | null;
  waiting_on: string | null;
  wakeup_at: string | null;
  outcome: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  meetings?: ManagerMeeting[];
  verifications?: ManagerVerification[];
  retrospectives?: ManagerRetrospective[];
  commitments?: Commitment[];
}

export interface Commitment {
  id: string;
  thread_id: string;
  project_id: string;
  title: string;
  owner_task_id: string | null;
  owner_title: string | null;
  source_message_id: string | null;
  source_message_text: string | null;
  source_task_id: string | null;
  source_task_title: string | null;
  status: "open" | "in_progress" | "blocked" | "done" | "dropped";
  due_at: string | null;
  depends_on: string[];
  created_at: string;
  updated_at: string;
}

export interface ManagerMeeting {
  event_id: string;
  ts: string;
  meeting_id: string;
  stage: "proposal" | "critique" | "decided";
  topic: string;
  participants: string[];
  summary: string | null;
  decision: string | null;
  recommendation: string | null;
  dissent: string[];
  evidence: string[];
  risks: string[];
  delivered: number;
}

export interface ManagerVerification {
  event_id: string;
  ts: string;
  verification_id: string;
  status: "started" | "passed" | "failed";
  method: string;
  result: string | null;
  target_task_ids: string[];
  evidence_ids: string[];
  replay_of: string | null;
}

export interface ManagerRetrospective {
  event_id: string;
  ts: string;
  retrospective_id: string;
  summary: string;
  worked: string[];
  problems: string[];
  lessons: string[];
}

export interface ChatMessage {
  id: string;
  thread_id: string;
  ts: string;
  role: "director" | "assistant";
  text: string;
  actions: { type?: "decision"; decision_id?: string; label?: string; [k: string]: unknown }[];
}

export interface TaskDetail extends Task {
  events: Event[];
  evidence: Evidence[];
  decisions: Decision[];
  // The task's verification contract resolved against its evidence, server-side
  // (HIVE-403). Absent when the task declared no commands.
  verification?: VerificationItem[];
  // The task's preview stack (HIVE-629). Absent whenever the project has no
  // `preview` config, which is what makes the preview UI opt-in per project.
  preview?: PreviewState;
}

// A running copy of the branch the director can click into. Derived server-side
// from the task's preview_* events (server/src/preview.ts).
export interface PreviewState {
  status: "idle" | "queued" | "building" | "ready" | "failed" | "expired";
  urls: { label: string; url: string }[];
  login_hint: string | null;
  // The page the agent changed, from `hive emit ... ready --preview-path`.
  preview_path: string | null;
  smoke_passed: number | null;
  smoke_failed: number | null;
  tail: string | null;
  reason: string | null;
  at: string | null;
}

// One declared verification command and whether fresh evidence for it exists.
export interface VerificationItem {
  name: string;
  cmd: string;
  satisfied: boolean;
  evidence_id: string | null;
}

// Structured branch diff for the in-review review panel (server/src/diff.ts).
export type DiffLineKind = "add" | "del" | "ctx";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface DiffFile {
  path: string;
  additions: number;
  deletions: number;
  binary?: boolean;
  hunks: DiffHunk[];
}

export interface DiffResult {
  files: DiffFile[];
  truncated: boolean;
}

// Live dependency + stacked-branch status (server/src/api.ts taskBranchCheckEndpoint,
// task #1000): recomputed fresh on every fetch rather than trusted from an
// agent's evidence prose about what a dependency or branch contains.
export interface BranchCheck {
  unmet_deps: { id: string; number: number; title: string; state: State }[];
  embedded_tasks: { id: string; number: number; title: string }[];
  understanding_required?: boolean; // judgment-class change; the quiz gates approval (hive-1559)
  // The risk check runs when the PR reaches review, not at the land attempt, so
  // the card knows before the director spends anything whether Ship can work
  // (HIVE-570). Undefined on an older server: the old land-time gate still applies.
  confirmed_risks?: { risk: string; why: string; evidence_path?: string }[];
  risk_check_unfinished?: { unverified: number; checked: number; reason?: string | null } | null;
}

// The land queue's ordering graph (server/src/landQueue.ts). `from` lands
// before `to`: "depends" is declared (depends_on or a brief line), "conflict"
// is inferred from two branches touching the same files.
export interface LandGraph {
  nodes: { id: string; number: number; project_number: number | null; title: string; land_queued_at: string | null }[];
  edges: { from: string; to: string; kind: "depends" | "conflict"; files?: string[] }[];
}

// The divergence radar (server/src/divergence.ts): for every branch still being
// worked on, how far it trails the branch it will land on and which files it
// shares with a sibling branch. `behind: null` means git could not tell.
export interface DivergenceRow {
  id: string;
  number: number;
  title: string;
  state: State;
  branch: string;
  behind: number | null;
  files: number;
  overlaps: { task_id: string; number: number; files: string[] }[];
}

// One global-search hit. task_state/project_id are present only for task hits.
export interface SearchHit {
  type: "task" | "decision" | "learning" | "policy" | "project";
  id: string;
  title: string;
  snippet: string;
  task_state?: State;
  project_id?: string;
  display_id?: string;
}

export interface UsageTotals {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  total_tokens: number;
  cost_usd: number;
  calls: number;
  unpriced: number;
}

export interface UsageRow {
  id: string;
  task_id: string;
  ts: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number | null;
  source: string;
}

export interface AnalyticsSummary {
  since: string | null;
  totals: UsageTotals;
  by_model: (UsageTotals & { model: string })[];
  by_project: (UsageTotals & { project_id: string; project_name: string })[];
  top_tasks: (UsageTotals & { task_id: string; title: string; project_id: string })[];
}

// One enriched row of the activity feed: an event joined to its task + project,
// plus the evidence url for screenshot/evidence events (null otherwise). Rows for
// standalone monitor incidents carry type "incident" and a null task_id/title.
export interface FeedEvent extends Omit<Event, "task_id"> {
  task_id: string | null;
  task_number: number | null;
  task_display_id: string | null;
  task_title: string | null;
  task_kind: Kind | null;
  project_id: string;
  project_name: string;
  evidence_url: string | null;
  evidence_kind: Evidence["kind"] | null;
}

// One done-since row in the brief (task + completion metadata).
export interface BriefDone {
  id: string;
  title: string;
  summary: string | null;
  project_id: string;
  project_name: string;
  done_at: string;
  evidence_count: number;
}

export interface BriefIncident extends Incident {
  project_name: string;
}

export interface BriefIntake extends Task {
  project_name: string;
}

export interface BriefLearning extends Learning {
  project_name: string;
}

// The composed re-entry and activity snapshot. Action-state sections (decisions,
// attention, fleet, intake) are current-state; done/incidents/spend/learnings are
// windowed by `since`.
export interface Brief {
  since: string | null;
  auto_answered_dialogs: number; // benign agent dialogs the server answered itself
  done: BriefDone[];
  director_required_task_ids: string[];
  failed_or_attention: Task[];
  decisions: Decision[];
  fleet: Task[];
  incidents: BriefIncident[];
  intake: BriefIntake[];
  to_review: Task[]; // Hive-owned reviews the director can act on now; tracking-only tasks are excluded.
  in_review_pending: Task[]; // still in review but not yet the director's: red/running CI, review pipeline unfinished, or no report to read.
  spend: { totals: UsageTotals; by_model: (UsageTotals & { model: string })[] };
  learnings_new: BriefLearning[];
}

// Away mode, as returned by GET/POST /api/away. `active` is the live state
// (manual switch OR the schedule window); `on` is only the manual switch.
export interface HeldPush {
  at: string;
  class: string;
  title: string;
  body: string | null;
  url: string;
}

// GET /api/attention — how many things need the director fleet-wide, the
// threshold, and which optional generators are paused because of it.
export interface AttentionBudget {
  count: number;
  threshold: number;
  over: boolean;
  paused: string[];
  // What the pause is holding, so a quiet board never hides held work.
  // Optional: an older server answers without it, and a missing field must not
  // take the board down.
  held?: { scouts: number; watchers: number };
}

export interface Away {
  on: boolean;
  active: boolean;
  schedule?: { start: string; end: string; tz: string };
  held: number;
  items?: HeldPush[];
  last_flush?: { at: string; items: HeldPush[] } | null;
}

// An open (un-acked) build-time checkpoint, as returned by GET /api/checkpoints.
export interface CheckpointPlan {
  goal: string;
  approach: string;
  files_expected: string[];
  verification_planned: string;
}

export interface Checkpoint {
  id: string;
  task_id: string;
  ts: string;
  task_number: number;
  task_title: string;
  task_state: string;
  project_id: string;
  note: string;
  // Plan checkpoints only (HIVE-412/413). `blocking` means the agent is parked
  // until this is acked; `concerns` is the critic's verdict, [] until it lands.
  blocking?: boolean;
  plan?: CheckpointPlan;
  concerns?: { severity: "note" | "veto"; text: string }[];
}

export type ReviewItem = string | { what: string; why?: string };

export interface UnderstandingPacket {
  background?: string;
  scope?: string;
  essence?: string;
  walkthrough?: string[];
  affected_areas?: string[];
  risk_assessment?: string;
  participate?: string;
  check?: {
    question: string;
    options: { key: string; label: string }[];
    answer_key: string;
    explanation?: string;
  };
  checks?: {
    question: string;
    options: { key: string; label: string }[];
    answer_key: string;
    explanation?: string;
  }[];
}

export interface ReviewSummary {
  done?: string[];
  iffy?: ReviewItem[];
  decisions?: string[];
  testing?: string[];
  followups?: string[];
  understanding?: UnderstandingPacket;
}

// One shipped change, sized for a glance (HIVE-511). `headline` is already
// capped server-side; the card renders it on one line regardless.
export interface GlanceCard {
  task_id: string;
  number: number;
  display_id: string;
  title: string;
  project_id: string;
  kind: string;
  state: string;
  shipped_at: string;
  headline: string;
  merged_by: "auto" | "director" | null;
  files: number;
  additions: number;
  deletions: number;
  diff_unavailable: boolean;
  areas: { area: string; churn: number }[];
  images: { url: string; caption: string | null; phase: "before" | "after" | null }[];
  explanation_url: string | null;
}

export interface UnderstandingQuiz {
  id: string;
  task_id: string;
  ts: string;
  task_number: number;
  task_title: string;
  task_state: State;
  task_kind: Kind;
  project_id: string;
  report: ReviewSummary;
  question: string;
  options: { key: string; label: string }[];
  version: string;
  completed?: number;
  total?: number;
  status: "required" | "deferred";
}

export interface JiraSyncState {
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
  consecutive_failures: number;
  next_due_at: string | null;
  interval_ms: number;
  running: boolean;
  stats: Record<string, unknown> | null;
}

export interface JiraTaskState {
  linked: boolean;
  issue_key?: string;
  browse_url?: string | null;
  enabled?: boolean;
  write?: boolean;
  configured?: boolean;
  config_error?: string | null;
  write_scope?: {
    status: boolean;
    comments: boolean;
    labels: readonly string[];
    assignee: boolean;
    create_subtask: boolean;
  };
  assignee?: string | null;
  sync?: JiraSyncState;
  pending?: {
    comments: number;
    receipts: number;
    unknown: { action: "comment_push" | "receipt"; source_id: string; error: string | null; text: string | null; ts: string }[];
  };
  delivered?: Record<string, unknown>[];
  linked_subtasks?: {
    id: string;
    display_id: string;
    title: string;
    state: State;
    jira_key: string;
    browse_url: string | null;
  }[];
}

// GET /api/stats/autonomy — the read-only autonomy scoreboard. `precision` and
// `agreement_rate` are null when there was nothing measurable, which the UI
// shows as "no data" rather than a made-up 100%.
export interface AutonomyStats {
  window: { days: number; since: string; until: string };
  auto_merge_precision: {
    merges: number;
    measurable: number;
    clean: number;
    fixed: number;
    precision: number | null;
    revert_detection: "on" | "off";
  };
  inbox_load: {
    by_day: { day: string; total: number }[];
    totals: { decision: number; quiz: number; checkpoint: number; dialog: number; stale: number; total: number };
    per_day: number;
  };
  recovery: { auto_respawns: number; one_cap_parks: number; scouts_spawned: number };
  agreement: { auto_answered: number; contradictions: number; auto_contradicted: number; agreement_rate: number | null };
}

export interface RaceAttempt {
  task_id: string;
  number: number;
  title: string;
  agent: string;
  state: State;
  branch: string | null;
  pr_url: string | null;
  settled: boolean;
  diff: { files: number; additions: number; deletions: number } | null;
  verification: { name: string; satisfied: boolean }[];
  cost_usd: number;
  processed_tokens: number;
  outcome: "winner" | "loser" | null;
}

export interface RaceView {
  race_id: string;
  deadline: string | null;
  settled: boolean;
  attempts: RaceAttempt[];
}
