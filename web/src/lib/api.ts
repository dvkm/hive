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

export interface Project {
  id: string;
  name: string;
  repo_path: string | null;
  config: {
    default_branch?: string;
    deploy_notes?: string;
    monitors?: { name: string; url: string; expect_status: number; expect_substring?: string; interval_s: number }[];
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
  createTask: (b: { project_id: string; title: string; brief?: string; kind?: Kind }) =>
    req<Task>(`/api/tasks`, { method: "POST", body: JSON.stringify(b) }),
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

  projects: () => req<Project[]>(`/api/projects`),
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

  notifications: () => req<{ notifications: Notification[]; unread: number }>(`/api/notifications`),
  ackNotifications: () => req<{ ok: boolean; acked: number }>(`/api/notifications/ack`, { method: "POST", body: "{}" }),
};
