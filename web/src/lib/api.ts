// Thin API helper. Same-origin in the built app; dev uses the vite proxy.
// VITE_HIVE_URL lets you point the dev app at a daemon on another host.
const BASE = import.meta.env.VITE_HIVE_URL || "";

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
export type CiStatus = "passing" | "failing" | "pending" | null;

// Server-computed health (single source of truth; never re-derived here).
export type HealthStatus = "healthy" | "silent" | "stuck" | "dead";
export interface Health {
  status: HealthStatus;
  reason: string | null;
  since: string;
}

export interface Task {
  id: string;
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
  summary: string | null;
  source: string | null;
  parent_task_id: string | null;
  health?: Health | null;
  created_at: string;
  updated_at: string;
}

export interface Event {
  id: string;
  task_id: string;
  ts: string;
  source: "agent" | "hook" | "herdr" | "reconciler" | "monitor" | "director" | "system";
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
    archived?: boolean;
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

export interface TaskDetail extends Task {
  events: Event[];
  evidence: Evidence[];
  decisions: Decision[];
}

// One global-search hit. task_state/project_id are present only for task hits.
export interface SearchHit {
  type: "task" | "decision" | "learning" | "policy" | "project";
  id: string;
  title: string;
  snippet: string;
  task_state?: State;
  project_id?: string;
}

export interface UsageTotals {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
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
  task_title: string | null;
  task_kind: Kind | null;
  project_id: string;
  project_name: string;
  evidence_url: string | null;
  evidence_kind: Evidence["kind"] | null;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
  });
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

export const api = {
  tasks: (q: { state?: State; project_id?: string } = {}) => {
    const p = new URLSearchParams(q as Record<string, string>).toString();
    return req<Task[]>(`/api/tasks${p ? "?" + p : ""}`);
  },
  task: (id: string) => req<TaskDetail>(`/api/tasks/${id}`),
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
  createTask: (b: { project_id: string; title: string; brief?: string; kind?: Kind }) =>
    req<Task>(`/api/tasks`, { method: "POST", body: JSON.stringify(b) }),
  updateTask: (id: string, b: { title?: string; brief?: string }) =>
    req<Task>(`/api/tasks/${id}`, { method: "PUT", body: JSON.stringify(b) }),
  brief: (id: string) => req<{ task_id: string; brief: string }>(`/api/tasks/${id}/brief`),
  transition: (id: string, to: State, reason?: string) =>
    req<Task>(`/api/tasks/${id}/transition`, {
      method: "POST",
      body: JSON.stringify({ to, reason, source: "director" }),
    }),
  send: (id: string, message: string) =>
    req<{ ok: boolean; stubbed: boolean; message: string }>(`/api/tasks/${id}/send`, {
      method: "POST",
      body: JSON.stringify({ message }),
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

  decisions: (status: "open" | "answered" | "all" = "open") =>
    req<Decision[]>(`/api/decisions?status=${status}`),
  decisionDraft: (id: string, draft_note: string) =>
    req<{ ok: boolean; id: string }>(`/api/decisions/${id}/draft`, {
      method: "PUT",
      body: JSON.stringify({ draft_note }),
    }),
  answerDecision: (id: string, answer_key: string, answer_note?: string) =>
    req<Decision>(`/api/decisions/${id}/answer`, {
      method: "POST",
      body: JSON.stringify({ answer_key, answer_note }),
    }),

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
    req<Project[]>(`/api/projects${opts.archived ? "?archived=all" : ""}`),
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
  createLearning: (b: { project_id: string; title: string; body?: string; create_root_cause_task?: boolean }) =>
    req<Learning>(`/api/learnings`, { method: "POST", body: JSON.stringify(b) }),
  updateLearning: (id: string, b: Partial<Pick<Learning, "title" | "body" | "status">>) =>
    req<Learning>(`/api/learnings/${id}`, { method: "PUT", body: JSON.stringify(b) }),
  recurLearning: (id: string) => req<Learning>(`/api/learnings/${id}/recur`, { method: "POST", body: "{}" }),

  analyticsSummary: (since?: string) =>
    req<AnalyticsSummary>(`/api/analytics/summary${since ? "?since=" + encodeURIComponent(since) : ""}`),
  taskUsage: (id: string) =>
    req<{ task_id: string; usage: UsageRow[]; totals: UsageTotals }>(`/api/tasks/${id}/usage`),

  search: (q: string, limit = 50) =>
    req<{ hits: SearchHit[] }>(`/api/search?q=${encodeURIComponent(q)}&limit=${limit}`),

  notifications: () => req<{ notifications: Notification[]; unread: number }>(`/api/notifications`),
  ackNotifications: () => req<{ ok: boolean; acked: number }>(`/api/notifications/ack`, { method: "POST", body: "{}" }),
};
