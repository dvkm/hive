// Thin API helper. Same-origin in the built app; dev uses the vite proxy.
// VITE_HIVE_URL lets you point the dev app at a daemon on another host.
//
// The shapes this speaks live in domain.ts (types only, no browser code) and
// are re-exported here, so `from "./api"` keeps working everywhere.
export * from "./domain";
import type {
  AnalyticsSummary,
  AttentionBudget,
  AuthorityRule,
  AutonomyStats,
  Away,
  BranchCheck,
  Brief,
  ChatMessage,
  ChatThread,
  Checkpoint,
  Decision,
  DeploymentsStatus,
  DiffResult,
  DivergenceRow,
  EvidenceRow,
  FeedEvent,
  GlanceCard,
  Incident,
  JiraSyncState,
  JiraTaskState,
  Kind,
  LandGraph,
  Learning,
  ManagerVerification,
  Notification,
  Policy,
  PrGardenerItem,
  Project,
  RaceView,
  SearchHit,
  State,
  Task,
  TaskDetail,
  UnderstandingQuiz,
  UsageRow,
  UsageTotals,
} from "./domain";

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

// Mirrors server/src/diff.ts MAX_DIFF_LINES (used only for the truncation notice).
export const MAX_DIFF_LINES = 20000;

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

const TASKS_PATH = "/api/tasks?compact=1";
const TASKS_CACHE = "hive-task-list-v1";
const taskCacheKey = () => new URL(BASE + TASKS_PATH, globalThis.location?.href || "http://localhost/").href;
// A cached board older than this is worse than no board: it paints a confident
// snapshot of a fleet that has moved on, and every action aimed at it 409s.
const TASKS_CACHE_MAX_AGE_MS = 5 * 60 * 1000;
const CACHED_AT = "x-hive-cached-at";
async function cachedTasks(): Promise<Task[] | null> {
  if (!("caches" in globalThis)) return null;
  try {
    const response = await (await caches.open(TASKS_CACHE)).match(taskCacheKey());
    if (!response) return null;
    // Undated entries predate the stamp, so treat them as too old to trust.
    const cachedAt = Number(response.headers.get(CACHED_AT));
    if (!cachedAt || Date.now() - cachedAt > TASKS_CACHE_MAX_AGE_MS) return null;
    return response.json();
  } catch {
    return null;
  }
}
async function cacheTasks(tasks: Task[]): Promise<void> {
  if (!("caches" in globalThis)) return;
  try {
    await (await caches.open(TASKS_CACHE)).put(taskCacheKey(), new Response(JSON.stringify(tasks), { headers: { "Content-Type": "application/json", [CACHED_AT]: String(Date.now()) } }));
  } catch {
    /* cache is an optional fast path */
  }
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

export const api = {
  race: (raceId: string) => req<RaceView>(`/api/races/${raceId}`),
  startRace: (taskId: string, b: { attempts?: number; agents?: string[]; deadline_min?: number } = {}) =>
    req<{ ok: boolean; race_id: string; task_ids: string[] }>(`/api/tasks/${taskId}/race`, {
      method: "POST",
      body: JSON.stringify(b),
    }),
  pickRaceWinner: (raceId: string, taskId: string) =>
    req<{ ok: boolean; winner: string; losers: string[] }>(`/api/races/${raceId}/pick`, {
      method: "POST",
      body: JSON.stringify({ task_id: taskId }),
    }),
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
  // The attention budget: the threshold and what hive paused because of it.
  // The COUNT the board shows is still actionableItems() locally, so the number
  // on screen can never disagree with the nav badge.
  attention: () => req<AttentionBudget>(`/api/attention`),
  away: () => req<Away>(`/api/away`),
  setAway: (on: boolean) => req<Away>(`/api/away`, { method: "POST", body: JSON.stringify({ on }) }),
  checkpoints: () => req<{ checkpoints: Checkpoint[] }>(`/api/checkpoints`),
  ackCheckpoint: (taskId: string, eventId: string, verdict: "ok" | "flag", note?: string) =>
    req<{ ok: boolean; delivered: boolean; followup_task_id: string | null }>(`/api/tasks/${taskId}/checkpoints/${eventId}/ack`, {
      method: "POST",
      body: JSON.stringify({ verdict, note, source: "director", actor: directorActor() }),
    }),
  understandingQuizzes: () => req<{ quizzes: UnderstandingQuiz[] }>(`/api/understanding-quizzes?scope=all`),
  catchup: (limit = 10, projectId?: string) =>
    req<{ cards: GlanceCard[] }>(`/api/catchup?limit=${limit}${projectId ? `&project_id=${encodeURIComponent(projectId)}` : ""}`),
  answerUnderstandingQuiz: (taskId: string, answerKey: string, version: string, surface?: "focus") =>
    req<{ ok: boolean; correct: boolean; passed: boolean; explanation: string | null; completed?: number; total?: number; quiz?: Pick<UnderstandingQuiz, "question" | "options" | "version" | "completed" | "total"> }>(`/api/tasks/${taskId}/understanding-quiz/answer`, {
      method: "POST",
      body: JSON.stringify({ answer_key: answerKey, version, source: "director", actor: directorActor(), surface }),
    }),
  deferUnderstandingQuiz: (taskId: string) =>
    req<{ ok: boolean; status: "deferred" | "passed" }>(`/api/tasks/${taskId}/understanding-quiz/defer`, {
      method: "POST",
      body: JSON.stringify({ confirm: "quiz_later", source: "director", actor: directorActor() }),
    }),
  requireUnderstandingQuiz: (taskId: string) =>
    req<{ ok: boolean; understanding_required: boolean }>(`/api/tasks/${taskId}/understanding-quiz/require`, {
      method: "POST",
      body: JSON.stringify({ source: "director", actor: directorActor() }),
    }),
  cachedTasks,
  tasks: async (q: { state?: State; project_id?: string } = {}) => {
    const p = new URLSearchParams(q as Record<string, string>).toString();
    const tasks = await req<Task[]>(p ? `/api/tasks?${p}&compact=1` : TASKS_PATH);
    if (!p) void cacheTasks(tasks);
    return tasks;
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
  createTask: (b: { project_id: string; title: string; brief?: string; kind?: Kind; priority?: string }, files?: File[]) =>
    req<Task>(`/api/tasks`, { method: "POST", body: bodyFor(b, files) }),
  intake: (b: { project_id: string; text: string }) =>
    req<{ ok: boolean; task: Task }>(`/api/intake`, { method: "POST", body: JSON.stringify(b) }),
  updateTask: (id: string, b: { title?: string; brief?: string; priority?: string }, files?: File[]) =>
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
  playbook: (id: string) =>
    req<{ ok: boolean; learning_id: string; playbook: { title: string } }>(`/api/tasks/${id}/playbook`, {
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
  takeover: (id: string) =>
    req<{ ok: boolean; worktree_path: string; branch: string | null; agent_stopped: boolean }>(
      `/api/tasks/${id}/takeover`,
      { method: "POST" }
    ),
  handback: (id: string, note?: string) =>
    req<{ ok: boolean; steer_queued: boolean; summary: string | null; branch: string | null }>(
      `/api/tasks/${id}/handback`,
      { method: "POST", body: JSON.stringify({ note }) }
    ),
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
  landGraph: (project?: string) => req<LandGraph>(`/api/tasks/land-graph${project ? `?project=${project}` : ""}`),
  divergence: (project?: string) =>
    req<{ rows: DivergenceRow[] }>(`/api/tasks/divergence${project ? `?project=${project}` : ""}`),
  landQueue: (task_ids: string[], queued = true) =>
    req<{ changed: string[]; queued: boolean }>(`/api/tasks/land-queue`, {
      method: "POST",
      body: JSON.stringify({ task_ids, queued }),
    }),
  branchCheck: (id: string) => req<BranchCheck>(`/api/tasks/${id}/branch-check`),
  merge: (id: string, strategy?: "local_ff", overrideConfirmedRisks?: boolean) =>
    req<Task>(`/api/tasks/${id}/merge`, {
      method: "POST",
      body: JSON.stringify({
        ...(strategy ? { merge_strategy: strategy } : {}),
        ...(overrideConfirmedRisks ? { override_confirmed_risks: true } : {}),
        actor: directorActor(),
      }),
    }),
  // In review this bounces the task back to its agent. On a task that already
  // shipped the same call files a follow-up instead (followup_task_id).
  requestChanges: (id: string, notes: string) =>
    req<{ ok: boolean; delivered?: boolean; task?: Task; followup_task_id?: string; followup_label?: string }>(
      `/api/tasks/${id}/request-changes`,
      { method: "POST", body: JSON.stringify({ notes, actor: directorActor() }) }
    ),

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
      // The inbox is the director's surface — answers from here are the director's.
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
  prGardener: (id: string) => req<PrGardenerItem[]>(`/api/projects/${id}/pr-gardener`),
  // The GitHub credential stays on the server: these two POSTs ask hive to run
  // the workflow, and the browser never holds a token that could.
  deployments: (id: string) => req<DeploymentsStatus>(`/api/projects/${id}/deployments`),
  deploy: (id: string, commit?: string) =>
    req<{ ok: true; workflow: string; ref: string }>(`/api/projects/${id}/deployments/deploy`, {
      method: "POST",
      body: JSON.stringify({ commit: commit ?? "" }),
    }),
  rollback: (id: string, tag?: string) =>
    req<{ ok: true; workflow: string; ref: string }>(`/api/projects/${id}/deployments/rollback`, {
      method: "POST",
      body: JSON.stringify({ tag: tag ?? "" }),
    }),
  setPrGardenerOverride: (id: string, prNumber: number, override: PrGardenerItem["override"]) =>
    req<PrGardenerItem>(`/api/projects/${id}/pr-gardener/${prNumber}`, { method: "POST", body: JSON.stringify({ override }) }),
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

  autonomyStats: (days = 7, project?: string) => {
    const q = new URLSearchParams({ days: String(days) });
    if (project) q.set("project_id", project);
    return req<AutonomyStats>(`/api/stats/autonomy?${q}`);
  },

  morningBrief: (since?: string, project?: string) => {
    const q = new URLSearchParams();
    if (since) q.set("since", since);
    if (project) q.set("project", project); // scopes the spend rollup; other sections filter in the browser
    const qs = q.toString();
    return req<Brief>(`/api/brief${qs ? "?" + qs : ""}`);
  },

  // Director chat (persistent project supervisor or global Chief of Staff session).
  chatThreads: (project_id?: string) =>
    req<ChatThread[]>(`/api/chat/threads${project_id ? "?project_id=" + project_id : ""}`),
  chatThread: (id: string) => req<ChatThread & { messages: ChatMessage[] }>(`/api/chat/threads/${id}`),
  chatTurn: (b: { project_id?: string; thread_id?: string; scope?: "chief"; text: string }) =>
    // Non-blocking: the turn is persisted and answered as "queued"; the real
    // delivery status arrives over SSE (chat_delivery).
    req<{ thread_id: string; delivery: "queued" }>(`/api/chat/turn`, {
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
