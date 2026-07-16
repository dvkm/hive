// Director chat: a conversational surface over hive. A director message is
// routed to a supervisor `claude -p` subprocess that can take real, scoped
// actions (create a task, answer/steer a decision, steer an agent) and answer
// read-only status questions.
//
// SAME design constraint as planner.ts: NO persistent in-process LLM session
// (firstmate's failure mode). Each turn is a short-lived subprocess. Durable
// state (the conversation) lives in SQLite and is re-injected fresh each turn.
//
// This module owns the pure/testable half: thread + message persistence, prompt
// composition, and the subprocess call that returns a parsed {reply, actions}.
// api.ts owns executing the actions (they need the private task/steer/decision
// handlers + herdr) — mirroring how planner.ts returns a plan that api.ts acts on.
import type { DB } from "./db.ts";
import { newId, now } from "./db.ts";
import { claudeBin, defaultPlannerExec, type PlannerExec } from "./planner.ts";
import { listReferences } from "./learn.ts";

const DEFAULT_TIMEOUT_MS = Number(process.env.HIVE_CHAT_TIMEOUT_MS || 120_000);
const DEFAULT_ARGV = [claudeBin(), "-p", "--model", "sonnet"];
// How many prior messages of a thread to replay into the prompt. A chat driving
// hive is short-horizon (create this, answer that); the durable record is the
// full DB thread, this just bounds the per-turn prompt.
const HISTORY_LIMIT = 20;

export interface ChatDeps {
  exec?: PlannerExec;
  timeoutMs?: number;
}

// The strict-JSON contract the supervisor subprocess returns. `reply` is the
// human-facing text; `actions` is the allow-listed write intents the server
// executes. Read-only status is answered directly in `reply` from pre-injected
// context — it is NOT an action.
export type ChatAction =
  | { type: "create_task"; title: string; brief?: string; kind?: "ship" | "scout" | "chore" }
  | { type: "answer_decision"; decision_id: string; answer_key: string; note?: string }
  | { type: "send_steer"; task_id: string; message: string };

export interface ChatResponse {
  reply: string;
  actions: ChatAction[];
}

// -------------------------------------------------------------- persistence
export interface ChatThread {
  id: string;
  project_id: string | null;
  task_id: string | null;
  title: string | null;
  created_at: string;
  updated_at: string;
}
export interface ChatMessage {
  id: string;
  thread_id: string;
  ts: string;
  role: "director" | "assistant";
  text: string;
  actions: any[];
}

export function createThread(
  db: DB,
  opts: { project_id?: string | null; task_id?: string | null; title?: string | null } = {}
): ChatThread {
  const id = newId("thr");
  const t = now();
  db.query(
    "INSERT INTO chat_threads (id, project_id, task_id, title, created_at, updated_at) VALUES (?,?,?,?,?,?)"
  ).run(id, opts.project_id ?? null, opts.task_id ?? null, opts.title ?? null, t, t);
  return getThread(db, id)!;
}

export function getThread(db: DB, id: string): ChatThread | null {
  return (db.query("SELECT * FROM chat_threads WHERE id = ?").get(id) as ChatThread) ?? null;
}

export function listThreads(db: DB, projectId?: string | null): ChatThread[] {
  const rows = projectId
    ? db.query("SELECT * FROM chat_threads WHERE project_id = ? ORDER BY updated_at DESC").all(projectId)
    : db.query("SELECT * FROM chat_threads ORDER BY updated_at DESC").all();
  return rows as ChatThread[];
}

export function appendMessage(
  db: DB,
  threadId: string,
  role: "director" | "assistant",
  text: string,
  actions: any[] = []
): ChatMessage {
  const row = { id: newId("msg"), thread_id: threadId, ts: now(), role, text, actions: JSON.stringify(actions) };
  db.query(
    "INSERT INTO chat_messages (id, thread_id, ts, role, text, actions) VALUES (?,?,?,?,?,?)"
  ).run(row.id, row.thread_id, row.ts, row.role, row.text, row.actions);
  db.query("UPDATE chat_threads SET updated_at = ? WHERE id = ?").run(row.ts, threadId);
  return { ...row, actions };
}

export function listMessages(db: DB, threadId: string, limit?: number): ChatMessage[] {
  const rows = (
    limit
      ? db.query("SELECT * FROM chat_messages WHERE thread_id = ? ORDER BY ts DESC LIMIT ?").all(threadId, limit)
      : db.query("SELECT * FROM chat_messages WHERE thread_id = ? ORDER BY ts ASC").all(threadId)
  ) as any[];
  const msgs = rows.map((r) => ({ ...r, actions: safeParse(r.actions) })) as ChatMessage[];
  return limit ? msgs.reverse() : msgs; // DESC+LIMIT fetches the newest N; return oldest→newest
}

function safeParse(s: string): any[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

// ------------------------------------------------------------------ prompt
// Compose the supervisor prompt: role + allow-listed action schema + live
// project status (open decisions, recent tasks) + conversation history + the
// new director message. Pure function of DB state + the passed message.
export function composeChatPrompt(
  db: DB,
  opts: { projectId?: string | null; taskId?: string | null; history: ChatMessage[]; text: string }
): string {
  const parts: string[] = [];
  parts.push(
    "# You are hive's director-chat supervisor.",
    "The director talks to you to drive hive. You answer status questions directly and, when asked to act, emit scoped actions the server executes for you.",
    ""
  );

  // Project + status context (serves read-only "get_status" without an action).
  if (opts.projectId) {
    const proj: any = db.query("SELECT id, name FROM projects WHERE id = ?").get(opts.projectId);
    parts.push(`## Project\n${proj?.name ?? opts.projectId} (${opts.projectId})`);

    const tasks = db
      .query(
        "SELECT number, id, title, state, kind FROM tasks WHERE project_id = ? ORDER BY updated_at DESC LIMIT 25"
      )
      .all(opts.projectId) as any[];
    if (tasks.length)
      parts.push(
        "## Recent tasks (newest first)\n" +
          tasks.map((t) => `#${t.number} [${t.state}/${t.kind}] ${t.title}  (id=${t.id})`).join("\n")
      );

    const decisions = db
      .query(
        `SELECT d.id, d.title, d.options FROM decisions d JOIN tasks t ON t.id = d.task_id
         WHERE t.project_id = ? AND d.status = 'open' ORDER BY d.ts DESC LIMIT 15`
      )
      .all(opts.projectId) as any[];
    if (decisions.length)
      parts.push(
        "## Open decisions (answerable via answer_decision)\n" +
          decisions
            .map((d) => {
              const opts2 = safeParse(d.options)
                .map((o: any) => `${o.key}=${o.label}`)
                .join(", ");
              return `${d.id}: ${d.title}  [options: ${opts2}]`;
            })
            .join("\n")
      );

    const refs = listReferences(db, opts.projectId);
    if (refs.length)
      parts.push(
        "## Project reference (durable facts)\n" +
          refs.map((r) => `### ${r.title}\n${r.body?.trim() || ""}`.trimEnd()).join("\n\n")
      );
  }

  // The specific task the chat is scoped to, if any.
  if (opts.taskId) {
    const task: any = db.query("SELECT * FROM tasks WHERE id = ?").get(opts.taskId);
    if (task)
      parts.push(
        `## This conversation is about task #${task.number}\nTitle: ${task.title}\nState: ${task.state} · Kind: ${task.kind}\n\n${task.brief?.trim() || "(no brief)"}`
      );
  }

  parts.push(
    `## Actions you may take
Return STRICT JSON and NOTHING ELSE — no markdown fences, no prose outside it:

{"reply":"<what you say to the director>","actions":[<zero or more of the below>]}

- Create a task:      {"type":"create_task","title":"...","brief":"...","kind":"ship|scout|chore"}
- Answer a decision:  {"type":"answer_decision","decision_id":"dec_...","answer_key":"<one of its option keys>","note":"optional"}
- Steer a live agent: {"type":"send_steer","task_id":"<task id>","message":"..."}

Rules:
- For status/read questions, put the answer in "reply" and leave "actions" empty — the tasks/decisions above are your source of truth.
- Only emit an action the director clearly asked for. When unsure, ask in "reply" and emit no action.
- kind defaults to ship (code change); scout = knowledge/report only; chore = ops.
- You CANNOT merge PRs, run commands, or take destructive/irreversible actions from chat — tell the director to use the board's guarded controls for those.
- Keep "reply" short and concrete. Confirm what you're about to do; the server reports back whether each action succeeded.`
  );

  if (opts.history.length)
    parts.push(
      "## Conversation so far\n" +
        opts.history.map((m) => `${m.role === "director" ? "Director" : "You"}: ${m.text}`).join("\n")
    );

  parts.push(`## New director message\n${opts.text}`);

  return parts.join("\n\n") + "\n";
}

// ------------------------------------------------------------------ parse
// Defensive extraction — same envelope handling as planner.extractPlan:
// `claude -p --output-format json` wraps the assistant text in {result:"..."}.
export function extractChatResponse(raw: string): ChatResponse | null {
  const whole = tryParse(raw);
  if (whole) return whole;
  try {
    const env = JSON.parse(raw);
    if (env && typeof env.result === "string") {
      const inner = tryParse(env.result) ?? braces(env.result);
      if (inner) return inner;
    }
  } catch {
    /* not an envelope */
  }
  return braces(raw);
}

function tryParse(s: string): ChatResponse | null {
  try {
    return normalize(JSON.parse(s));
  } catch {
    return null;
  }
}
function braces(s: string): ChatResponse | null {
  const i = s.indexOf("{");
  const j = s.lastIndexOf("}");
  if (i < 0 || j <= i) return null;
  return tryParse(s.slice(i, j + 1));
}
function normalize(o: any): ChatResponse | null {
  if (!o || typeof o !== "object") return null;
  if (typeof o.reply !== "string" && !Array.isArray(o.actions)) return null;
  const actions = Array.isArray(o.actions) ? o.actions.filter(isValidAction) : [];
  return { reply: typeof o.reply === "string" ? o.reply : "", actions };
}
// Only the allow-listed shapes survive. An unknown/ill-formed action is dropped
// (never executed) — the server-side allow-list, not the model, is the boundary.
function isValidAction(a: any): a is ChatAction {
  if (!a || typeof a !== "object") return false;
  if (a.type === "create_task") return typeof a.title === "string" && a.title.trim().length > 0;
  if (a.type === "answer_decision") return typeof a.decision_id === "string" && typeof a.answer_key === "string";
  if (a.type === "send_steer") return typeof a.task_id === "string" && typeof a.message === "string" && a.message.trim().length > 0;
  return false;
}

// ------------------------------------------------------------------ run
// Spawn the supervisor subprocess for one turn and return the parsed response.
// Injectable exec so tests never spawn `claude` (same contract as PlannerExec).
// Throws on spawn/timeout/non-zero/unparseable so the caller records the error.
export async function runChatTurn(
  db: DB,
  opts: { projectId?: string | null; taskId?: string | null; history: ChatMessage[]; text: string },
  deps: ChatDeps = {}
): Promise<ChatResponse> {
  const argv = [...DEFAULT_ARGV, composeChatPrompt(db, opts), "--output-format", "json"];
  const exec = deps.exec ?? defaultPlannerExec;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const res = await exec(argv, { timeoutMs });
  if (res.timedOut) throw new Error(`chat turn timed out after ${timeoutMs}ms`);
  if (res.code !== 0) throw new Error(`chat turn exited ${res.code}: ${res.stderr.trim() || res.stdout.trim()}`);
  const parsed = extractChatResponse(res.stdout);
  if (!parsed) throw new Error("chat turn output was not valid JSON with a reply/actions");
  return parsed;
}
