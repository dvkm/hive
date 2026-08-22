// Thin API helper. Same-origin in the built app; dev uses the vite proxy.
// VITE_HIVE_URL lets you point the dev app at a daemon on another host.
const BASE = import.meta.env.VITE_HIVE_URL || "";
const DIRECTOR_ACTOR_KEY = "hive_director_actor";

export function directorActor(): string | null {
  try {
    let actor = sessionStorage.getItem(DIRECTOR_ACTOR_KEY);
    if (!actor) {
      actor = `web-${crypto.randomUUID().slice(0, 8)}`;
      sessionStorage.setItem(DIRECTOR_ACTOR_KEY, actor);
    }
    return actor;
  } catch {
    return null;
  }
}

// Remote access (phone PWA over LAN/Tailscale): the server 401s non-loopback
// requests without the API token (`hive remote` prints it). Stored once in
// localStorage; loopback/desktop never sees a 401 so never prompts.
export function apiToken(): string | null {
  try {
    return localStorage.getItem("hive_token");
  } catch {
    return null;
  }
}
function authHeaders(): Record<string, string> {
  const t = apiToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}
let tokenPrompt: Promise<boolean> | null = null;
function promptForToken(): Promise<boolean> {
  if (tokenPrompt) return tokenPrompt;
  tokenPrompt = new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.className = "modal token-dialog";
    dialog.innerHTML = `
      <form method="dialog">
        <h2>Hive API token</h2>
        <label class="fld">
          <span>Run \`hive remote\` on the Mac</span>
          <input type="password" autocomplete="current-password" autofocus />
        </label>
        <div class="modal-foot">
          <div class="spacer"></div>
          <button type="button" class="btn">Cancel</button>
          <button type="submit" class="btn btn-primary">Save</button>
        </div>
      </form>`;
    const input = dialog.querySelector("input")!;
    const finish = (saved: boolean) => {
      dialog.remove();
      tokenPrompt = null;
      resolve(saved);
    };
    dialog.querySelector<HTMLButtonElement>('button[type="button"]')!.onclick = () => finish(false);
    dialog.oncancel = (event) => {
      event.preventDefault();
      finish(false);
    };
    dialog.querySelector("form")!.onsubmit = (event) => {
      event.preventDefault();
      const token = input.value.trim();
      if (!token) return;
      localStorage.setItem("hive_token", token);
      finish(true);
    };
    document.body.appendChild(dialog);
    dialog.showModal();
  });
  return tokenPrompt;
}

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
export type HealthStatus = "healthy" | "silent" | "stuck" | "dead";
export interface Health {
  status: HealthStatus;
  reason: string | null;
  since: string;
}

export interface Task {
  id: string;
  number: number; // legacy global handle retained for PR markers and API compatibility
  project_number?: number; // stable sequence within the project
  display_id?: string; // project-scoped human handle, e.g. HIVE-247
  project_id: string;
  title: string;
  brief: string;
  state: State;
  kind: Kind;
  agent_target: string | null;
  worktree_path: string | null;
  branch: string | null;
  pr_url: string | null;
  ci_status: CiStatus;
  head_sha: string | null; // PR's current head commit, refreshed by the reconciler's PR poll
  summary: string | null;
  source: string | null;
  source_ref: string | null;
  parent_task_id: string | null;
  duplicate_of: string | null; // survivor id when cancelled as a duplicate
  depends_on: string[]; // task ids governed by the server dependency gate (docs/API.md)
  deferred_until?: string | null; // parked pending an offline human action; nudges suppressed while future-dated
  health?: Health | null;
  requeued_to?: string | null; // successor id when failed + auto-requeued
  never_dispatched?: boolean; // source=external, never spawned — no agent exists or ever will unless manually dispatched
  created_at: string;
  updated_at: string;
}

export interface Event {
  id: string;
  task_id: string;
  ts: string;
  source: "agent" | "hook" | "herdr" | "reconciler" | "monitor" | "director" | "system" | "chat_supervisor" | "jira" | "jira-sync" | "unknown";
  type: string;
  payload: Record<string, unknown>;
}

export interface Evidence {
  id: string;
  task_id: string;
  ts: string;
  kind: "screenshot" | "test_run" | "log" | "report" | "link";
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
  // Who answered (audit trail). director when David clicked in the inbox;
  // chat_supervisor/agent/system for programmatic callers; unknown if unattributed.
  answered_by: "director" | "chat_supervisor" | "agent" | "system" | "unknown" | null;
  answered_actor: string | null;
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
    agent?: "claude" | "codex";
    codex_model?: string;
    codex_model_by_kind?: Partial<Record<Kind, string>>;
    codex_reasoning_effort?: "minimal" | "low" | "medium" | "high" | "xhigh";
    codex_reasoning_effort_by_kind?: Partial<Record<Kind, "minimal" | "low" | "medium" | "high" | "xhigh">>;
    codex_auto_compact_token_limit?: number;
    codex_tool_output_token_limit?: number;
    autonomy_profile?: "conservative" | "balanced" | "autopilot";
    archived?: boolean;
    test?: boolean;
    [k: string]: unknown;
  };
  created_at: string;
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
// Mirrors server/src/diff.ts MAX_DIFF_LINES (used only for the truncation notice).
export const MAX_DIFF_LINES = 20000;

// Live dependency + stacked-branch status (server/src/api.ts taskBranchCheckEndpoint,
// task #1000): recomputed fresh on every fetch rather than trusted from an
// agent's evidence prose about what a dependency or branch contains.
export interface BranchCheck {
  unmet_deps: { id: string; number: number; title: string; state: State }[];
  embedded_tasks: { id: string; number: number; title: string }[];
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
  done: BriefDone[];
  director_required_task_ids: string[];
  failed_or_attention: Task[];
  decisions: Decision[];
  fleet: Task[];
  incidents: BriefIncident[];
  intake: BriefIntake[];
  to_review: Task[]; // Hive-owned reviews; tracking-only tasks are excluded.
  spend: { totals: UsageTotals; by_model: (UsageTotals & { model: string })[] };
  learnings_new: BriefLearning[];
}

async function req<T>(path: string, init?: RequestInit, retried = false): Promise<T> {
  // A FormData body must set its own Content-Type: the browser adds the
  // multipart boundary, which we cannot write by hand.
  const isForm = init?.body instanceof FormData;
  const res = await fetch(BASE + path, {
    ...init,
    headers: isForm
      ? { ...authHeaders(), ...(init?.headers || {}) }
      : { "Content-Type": "application/json", ...authHeaders(), ...(init?.headers || {}) },
  });
  if (res.status === 401 && !retried && await promptForToken()) {
    return req<T>(path, init, true); // token just entered — replay once, then reload streams
  }
  if (!res.ok) {
    let msg = res.statusText;
    try {
      msg = (await res.json()).error || msg;
    } catch {
      /* noop */
    }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

// JSON when there's nothing to upload, multipart when there is. The server
// accepts either on /send, POST /api/tasks and PUT /api/tasks/:id.
function bodyFor(fields: Record<string, unknown>, files?: File[]): string | FormData {
  if (!files?.length) return JSON.stringify(fields);
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v != null) fd.append(k, String(v));
  for (const f of files) fd.append("files", f);
  return fd;
}

// An open (un-acked) build-time checkpoint, as returned by GET /api/checkpoints.
export interface Checkpoint {
  id: string;
  task_id: string;
  ts: string;
  task_number: number;
  task_title: string;
  task_state: string;
  project_id: string;
  note: string;
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
  };
  assignee?: string | null;
  sync?: JiraSyncState;
  pending?: {
    comments: number;
    receipts: number;
    unknown: { action: "comment_push" | "receipt"; source_id: string; error: string | null; text: string | null; ts: string }[];
  };
  delivered?: Record<string, unknown>[];
}

export const api = {
  token: apiToken,
  jira: (taskId: string) => req<JiraTaskState>(`/api/tasks/${taskId}/jira`),
  jiraSync: (taskId: string) =>
    req<{ ok: boolean; error: string | null; stats: Record<string, unknown> | null; sync: JiraSyncState }>(
      `/api/tasks/${taskId}/jira/sync`,
      { method: "POST" }
    ),
  jiraResolveDelivery: (taskId: string, action: "comment_push" | "receipt", sourceId: string) =>
    req<JiraTaskState>(`/api/tasks/${taskId}/jira/delivery/resolve`, {
      method: "POST",
      body: JSON.stringify({ action, source_id: sourceId }),
    }),
  subscribePush: (subscription: unknown) =>
    req<{ ok: boolean }>(`/api/push/subscribe`, { method: "POST", body: JSON.stringify(subscription) }),
  offline: () => req<{ on: boolean }>(`/api/offline`),
  setOffline: (on: boolean) =>
    req<{ on: boolean; steered: number }>(`/api/offline`, { method: "POST", body: JSON.stringify({ on }) }),
  checkpoints: () => req<{ checkpoints: Checkpoint[] }>(`/api/checkpoints`),
  ackCheckpoint: (taskId: string, eventId: string, verdict: "ok" | "flag", note?: string) =>
    req<{ ok: boolean; delivered: boolean; followup_task_id: string | null }>(`/api/tasks/${taskId}/checkpoints/${eventId}/ack`, {
      method: "POST",
      body: JSON.stringify({ verdict, note, source: "director", actor: directorActor() }),
    }),
  understandingQuizzes: () => req<{ quizzes: UnderstandingQuiz[] }>(`/api/understanding-quizzes`),
  answerUnderstandingQuiz: (taskId: string, answerKey: string, version: string) =>
    req<{ ok: boolean; correct: boolean; passed: boolean; explanation: string | null; completed?: number; total?: number; quiz?: Pick<UnderstandingQuiz, "question" | "options" | "version" | "completed" | "total"> }>(`/api/tasks/${taskId}/understanding-quiz/answer`, {
      method: "POST",
      body: JSON.stringify({ answer_key: answerKey, version, source: "director", actor: directorActor() }),
    }),
  deferUnderstandingQuiz: (taskId: string) =>
    req<{ ok: boolean; status: "deferred" | "passed" }>(`/api/tasks/${taskId}/understanding-quiz/defer`, {
      method: "POST",
      body: JSON.stringify({ confirm: "quiz_later", source: "director", actor: directorActor() }),
    }),
  tasks: (q: { state?: State; project_id?: string } = {}) => {
    const p = new URLSearchParams(q as Record<string, string>).toString();
    return req<Task[]>(`/api/tasks${p ? "?" + p : ""}`);
  },
  task: (id: string) => req<TaskDetail>(`/api/tasks/${id}`),
  pane: (id: string, lines = 200) =>
    req<{ task_id: string; agent_target: string; text: string; ts: string }>(`/api/tasks/${id}/pane?lines=${lines}`),
  feed: (q: { since?: string; project?: string; types?: string; limit?: number } = {}) => {
    const p = new URLSearchParams();
    if (q.since) p.set("since", q.since);
    if (q.project) p.set("project", q.project);
    if (q.types) p.set("types", q.types);
    if (q.limit) p.set("limit", String(q.limit));
    const qs = p.toString();
    return req<{ events: FeedEvent[] }>(`/api/feed${qs ? "?" + qs : ""}`);
  },
  evidence: (q: { project?: string; kind?: string; task?: string; limit?: number } = {}) => {
    const p = new URLSearchParams();
    if (q.project) p.set("project", q.project);
    if (q.kind) p.set("kind", q.kind);
    if (q.task) p.set("task", q.task);
    if (q.limit) p.set("limit", String(q.limit));
    const qs = p.toString();
    return req<{ evidence: EvidenceRow[] }>(`/api/evidence${qs ? "?" + qs : ""}`);
  },
  createTask: (b: { project_id: string; title: string; brief?: string; kind?: Kind }, files?: File[]) =>
    req<Task>(`/api/tasks`, { method: "POST", body: bodyFor(b, files) }),
  intake: (b: { project_id: string; text: string }) =>
    req<{ ok: boolean; task: Task }>(`/api/intake`, { method: "POST", body: JSON.stringify(b) }),
  updateTask: (id: string, b: { title?: string; brief?: string }, files?: File[]) =>
    req<Task>(`/api/tasks/${id}`, { method: "PUT", body: bodyFor(b, files) }),
  brief: (id: string) => req<{ task_id: string; brief: string }>(`/api/tasks/${id}/brief`),
  transition: (id: string, to: State, reason?: string) =>
    req<Task>(`/api/tasks/${id}/transition`, {
      method: "POST",
      body: JSON.stringify({ to, reason, source: "director" }),
    }),
  send: (id: string, message: string, files?: File[]) =>
    // `attachments` is absent on the no-agent / herdr-error responses.
    req<{ ok: boolean; delivered: boolean; delivery: "delivered" | "queued" | "failed"; message: string; attachments?: string[]; error?: string }>(`/api/tasks/${id}/send`, {
      method: "POST",
      body: bodyFor({ message, actor: directorActor() }, files),
    }),
  plan: (id: string) =>
    req<{ ok: boolean; decision?: Decision; error?: string }>(`/api/tasks/${id}/plan`, {
      method: "POST",
      body: "{}",
    }),
  spawn: (id: string) =>
    req<{ ok: boolean; task: Task; agent_target: string }>(`/api/tasks/${id}/spawn`, {
      method: "POST",
      body: "{}",
    }),
  focusAgent: (id: string) =>
    req<{ ok: boolean; focused: boolean; target?: string; error?: string }>(`/api/tasks/${id}/focus-agent`, {
      method: "POST",
      body: "{}",
    }),
  requeue: (id: string) =>
    req<{ ok: boolean; new_task_id: string }>(`/api/tasks/${id}/requeue`, {
      method: "POST",
      body: "{}",
    }),
  mergeInto: (id: string, target_id: string) =>
    req<Task>(`/api/tasks/${id}/merge-into`, { method: "POST", body: JSON.stringify({ target_id }) }),
  duplicates: () =>
    req<{ clusters: { project_id: string; tasks: Pick<Task, "id" | "title" | "project_id" | "state">[] }[] }>(`/api/tasks/duplicates`),
  diff: (id: string) => req<DiffResult>(`/api/tasks/${id}/diff`),
  branchCheck: (id: string) => req<BranchCheck>(`/api/tasks/${id}/branch-check`),
  merge: (id: string, strategy?: "local_ff") =>
    req<Task>(`/api/tasks/${id}/merge`, {
      method: "POST",
      body: JSON.stringify({ ...(strategy ? { merge_strategy: strategy } : {}), actor: directorActor() }),
    }),
  requestChanges: (id: string, notes: string) =>
    req<{ ok: boolean; delivered: boolean; task: Task }>(`/api/tasks/${id}/request-changes`, {
      method: "POST",
      body: JSON.stringify({ notes }),
    }),

  decisions: (status: "open" | "answered" | "all" = "open") =>
    req<Decision[]>(`/api/decisions?status=${status}`),
  decisionDraft: (id: string, draft_note: string) =>
    req<{ ok: boolean; id: string }>(`/api/decisions/${id}/draft`, {
      method: "PUT",
      body: JSON.stringify({ draft_note }),
    }),
  answerDecision: (id: string, answer_key: string, answer_note?: string, selected_indices?: number[]) =>
    req<Decision>(`/api/decisions/${id}/answer`, {
      method: "POST",
      // The inbox is David's surface — answers from here are the director's.
      body: JSON.stringify({ answer_key, answer_note, selected_indices, source: "director", actor: directorActor() }),
    }),
  dismissDecision: (id: string) =>
    req<Decision>(`/api/decisions/${id}/dismiss`, { method: "POST" }),

  policies: () => req<Policy[]>(`/api/policies`),
  createPolicy: (b: { title: string; body: string; scope?: string; active?: boolean }) =>
    req<Policy>(`/api/policies`, { method: "POST", body: JSON.stringify(b) }),
  updatePolicy: (id: string, b: Partial<Pick<Policy, "title" | "body" | "scope" | "active">>) =>
    req<Policy>(`/api/policies/${id}`, { method: "PUT", body: JSON.stringify(b) }),

  authorityRules: (project_id?: string) =>
    req<AuthorityRule[]>(`/api/authority/rules${project_id ? "?project_id=" + project_id : ""}`),
  createAuthorityRule: (b: { project_id?: string | null; action_pattern: string; effect: string; note?: string }) =>
    req<AuthorityRule>(`/api/authority/rules`, { method: "POST", body: JSON.stringify(b) }),
  updateAuthorityRule: (id: string, b: Partial<Pick<AuthorityRule, "action_pattern" | "effect" | "note" | "active">>) =>
    req<AuthorityRule>(`/api/authority/rules/${id}`, { method: "PUT", body: JSON.stringify(b) }),

  projects: (opts: { archived?: boolean } = {}) =>
    req<Project[]>(`/api/projects${opts.archived ? "?archived=all&test=all" : ""}`),
  createProject: (b: { name: string; repo_path: string; config?: Project["config"] }) =>
    req<Project>(`/api/projects`, { method: "POST", body: JSON.stringify(b) }),
  updateProject: (id: string, b: { config?: Project["config"]; name?: string; repo_path?: string | null }) =>
    req<Project>(`/api/projects/${id}`, { method: "PUT", body: JSON.stringify(b) }),
  // Incidents API is built in parallel; treat absence (404/network) as "not running yet".
  incidents: (status: "open" | "resolved") =>
    req<{ incidents: Incident[] }>(`/api/incidents?status=${status}`),

  learnings: (q: { project_id?: string; status?: "active" | "resolved" } = {}) => {
    const p = new URLSearchParams(q as Record<string, string>).toString();
    return req<Learning[]>(`/api/learnings${p ? "?" + p : ""}`);
  },
  createLearning: (b: { project_id: string; title: string; kind: "failure" | "reference"; body?: string; create_root_cause_task?: boolean }) =>
    req<Learning>(`/api/learnings`, { method: "POST", body: JSON.stringify(b) }),
  updateLearning: (id: string, b: Partial<Pick<Learning, "title" | "body" | "status" | "kind">>) =>
    req<Learning>(`/api/learnings/${id}`, { method: "PUT", body: JSON.stringify(b) }),
  recurLearning: (id: string) => req<Learning>(`/api/learnings/${id}/recur`, { method: "POST", body: "{}" }),

  analyticsSummary: (since?: string) =>
    req<AnalyticsSummary>(`/api/analytics/summary${since ? "?since=" + encodeURIComponent(since) : ""}`),
  taskUsage: (id: string) =>
    req<{ task_id: string; usage: UsageRow[]; totals: UsageTotals }>(`/api/tasks/${id}/usage`),

  search: (q: string, limit = 50) =>
    req<{ hits: SearchHit[] }>(`/api/search?q=${encodeURIComponent(q)}&limit=${limit}`),

  morningBrief: (since?: string) =>
    req<Brief>(`/api/brief${since ? "?since=" + encodeURIComponent(since) : ""}`),

  // Director chat (persistent project supervisor or global Chief of Staff session).
  chatThreads: (project_id?: string) =>
    req<ChatThread[]>(`/api/chat/threads${project_id ? "?project_id=" + project_id : ""}`),
  chatThread: (id: string) => req<ChatThread & { messages: ChatMessage[] }>(`/api/chat/threads/${id}`),
  chatTurn: (b: { project_id?: string; thread_id?: string; scope?: "chief"; text: string }) =>
    req<{ thread_id: string; delivery: "delivered" | "spawned" | "failed"; error?: string }>(`/api/chat/turn`, {
      method: "POST",
      body: JSON.stringify(b),
    }),
  chatClose: (id: string) => req<{ ok: boolean; thread_id: string }>(`/api/chat/threads/${id}/close`, { method: "POST", body: "{}" }),
  updateChatRun: (id: string, b: Partial<Pick<ChatThread, "objective" | "acceptance_criteria" | "phase" | "next_action" | "waiting_on" | "wakeup_at" | "outcome">>) =>
    req<ChatThread>(`/api/chat/threads/${id}/run`, { method: "PUT", body: JSON.stringify({ ...b, source: "director" }) }),
  replayVerification: (threadId: string, eventId: string) =>
    req<{ verification: ManagerVerification; delivery: "delivered" | "spawned" | "failed"; error?: string }>(`/api/chat/threads/${threadId}/verifications/${eventId}/replay`, { method: "POST", body: "{}" }),

  notifications: () => req<{ notifications: Notification[]; unread: number }>(`/api/notifications`),
  ackNotifications: () => req<{ ok: boolean; acked: number }>(`/api/notifications/ack`, { method: "POST", body: "{}" }),
};
