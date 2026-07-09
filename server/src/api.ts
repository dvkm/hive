// HTTP routing for hive. Plain Bun.serve routing by hand (zero deps).
// The exact request/response contract lives in docs/API.md.
import { dirname, join, normalize } from "node:path";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import type { DB } from "./db.ts";
import { newId, now, evidenceDir } from "./db.ts";
import { taskWithHealth, broadcastTask, needsAttention } from "./health.ts";
import { addClient, removeClient, broadcast } from "./bus.ts";
import {
  transition,
  writeEvent,
  getTask,
  canTransition,
  TransitionError,
  TERMINAL,
  type State,
} from "./state.ts";
import { composeBrief } from "./briefs.ts";
import {
  parseProject,
  parseTask,
  parseEvent,
  parseEvidence,
  parseDecision,
  parsePolicy,
  parseIncident,
} from "./rows.ts";
import { Herdr, herdr as defaultHerdr } from "./runtime/herdr.ts";
import { cleanupTask } from "./cleanup.ts";
import { resolveProjectSecrets } from "./secrets.ts";
import { runSmoke } from "./monitors.ts";
import { enqueue, ackNotifications } from "./notifications.ts";
import { authorize, resolveGrantForDecision, type AuthzInput } from "./authority.ts";
import { isReviewed } from "./dispatcher.ts";
import { runPlanner, resolvePlanForDecision, type PlannerExec } from "./planner.ts";
import { detectDuplicate, mergeInto, openDuplicateDecision, resolveDuplicateForDecision, duplicateClusters } from "./dedup.ts";
import { costUsd } from "./pricing.ts";
import { taskDiff } from "./diff.ts";
import type { Exec } from "./exec.ts";
import { defaultExec } from "./exec.ts";
import { taskIdFromBody, taskNumberFromTitle } from "./marker.ts";

export interface HandlerDeps {
  herdr?: Herdr; // injectable for tests
  supervise?: boolean; // start the herdr wait loop after spawn (true in prod wiring)
  plannerExec?: PlannerExec; // injectable planner subprocess (domain supervisors)
  exec?: Exec; // injectable gh/git subprocess (diff + merge); tests pass a stub
}

const VERSION = "0.1.0";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}
function err(message: string, status = 400): Response {
  return json({ error: message }, status);
}

// Standing-authority gate for the internal risky paths (spawn, steer, verify,
// done). Returns a blocking Response when the action is denied (403) or needs a
// decision (409 {decision_id}); returns null when it may proceed.
function authzBlock(db: DB, input: AuthzInput): Response | null {
  const r = authorize(db, input);
  if (r.effect === "allow") return null;
  if (r.effect === "deny") return err(r.reason, 403);
  return json(
    { error: "requires a decision", effect: "require_decision", decision_id: r.decision_id },
    409
  );
}

const WEB_DIST = join(import.meta.dir, "..", "..", "web", "dist");
const HOOKS_DIR = join(import.meta.dir, "..", "..", "hooks");

export function makeHandler(db: DB, deps: HandlerDeps = {}) {
  const herdr = deps.herdr ?? defaultHerdr;
  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const { pathname } = url;
    const method = req.method;

    if (method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    try {
      // ---- SSE stream ----
      if (pathname === "/api/stream" && method === "GET") return sseStream();

      // ---- health ----
      if (pathname === "/api/health" && method === "GET")
        return json({ ok: true, version: VERSION });

      // ---- evidence static files ----
      if (pathname.startsWith("/evidence/") && method === "GET")
        return serveEvidence(pathname);

      // ---- projects ----
      if (pathname === "/api/projects") {
        if (method === "GET") {
          // Archived projects (config.archived === true) are hidden unless
          // ?archived=all is passed. tasks still reference them; there is no delete.
          const includeArchived = url.searchParams.get("archived") === "all";
          const sql = includeArchived
            ? "SELECT * FROM projects ORDER BY created_at"
            : "SELECT * FROM projects WHERE COALESCE(json_extract(config, '$.archived'), 0) = 0 ORDER BY created_at";
          return json(db.query(sql).all().map(parseProject));
        }
        if (method === "POST") return createProject(db, await req.json());
      }
      let m = pathname.match(/^\/api\/projects\/([^/]+)$/);
      if (m && method === "GET") {
        const r = db.query("SELECT * FROM projects WHERE id = ?").get(m[1]);
        return r ? json(parseProject(r)) : err("project not found", 404);
      }
      if (m && method === "PUT") return updateProject(db, m[1], await req.json());

      // ---- activity feed (reverse-chronological projection over events) ----
      if (pathname === "/api/feed" && method === "GET") return listFeed(db, url);

      // ---- morning brief (one composed catch-up view over existing data) ----
      if (pathname === "/api/brief" && method === "GET") return brief(db, url);

      // ---- evidence browser (all evidence across tasks, filtered) ----
      if (pathname === "/api/evidence" && method === "GET") return listEvidence(db, url);

      // ---- global search (tasks/decisions/learnings/policies/projects) ----
      if (pathname === "/api/search" && method === "GET") return search(db, url);

      // ---- braindump intake ----
      if (pathname === "/api/intake" && method === "POST") return intake(db, await req.json(), deps);

      // ---- PR → task linking (match an open PR back to its task by marker) ----
      if (pathname === "/api/tasks/link-pr" && method === "POST")
        return await linkPrEndpoint(db, await req.json(), deps);

      // ---- tasks ----
      if (pathname === "/api/tasks") {
        if (method === "GET") return listTasks(db, url);
        if (method === "POST") return createTask(db, await req.json());
      }
      // Duplicate CLUSTERS among current non-terminal tasks (backfill/UI). Must
      // precede the /:id route so "duplicates" isn't parsed as a task id.
      if (pathname === "/api/tasks/duplicates" && method === "GET")
        return json({ clusters: duplicateClusters(db) });
      m = pathname.match(/^\/api\/tasks\/([^/]+)\/merge-into$/);
      if (m && method === "POST") return mergeIntoEndpoint(db, m[1], await req.json());
      m = pathname.match(/^\/api\/tasks\/([^/]+)$/);
      if (m && method === "GET") return getTaskFull(db, m[1]);
      if (m && method === "PUT") return updateTask(db, m[1], await req.json());

      m = pathname.match(/^\/api\/tasks\/([^/]+)\/events$/);
      if (m) {
        if (method === "GET") {
          const rows = db
            .query("SELECT * FROM events WHERE task_id = ? ORDER BY ts")
            .all(m[1]);
          return json(rows.map(parseEvent));
        }
        if (method === "POST") return await ingestEvent(db, m[1], req);
      }
      m = pathname.match(/^\/api\/tasks\/([^/]+)\/transition$/);
      if (m && method === "POST") return await doTransition(db, m[1], await req.json());

      m = pathname.match(/^\/api\/tasks\/([^/]+)\/spawn$/);
      if (m && method === "POST")
        return await spawnTask(db, herdr, m[1], await safeJson(req), deps);

      m = pathname.match(/^\/api\/tasks\/([^/]+)\/send$/);
      if (m && method === "POST") return await sendSteer(db, herdr, m[1], await req.json());

      m = pathname.match(/^\/api\/tasks\/([^/]+)\/focus-agent$/);
      if (m && method === "POST") return await focusAgent(db, herdr, m[1]);

      m = pathname.match(/^\/api\/tasks\/([^/]+)\/requeue$/);
      if (m && method === "POST") return requeueEndpoint(db, m[1]);

      m = pathname.match(/^\/api\/tasks\/([^/]+)\/cleanup$/);
      if (m && method === "POST") return await cleanupEndpoint(db, herdr, m[1]);

      m = pathname.match(/^\/api\/tasks\/([^/]+)\/usage$/);
      if (m && method === "GET") return taskUsage(db, m[1]);

      m = pathname.match(/^\/api\/tasks\/([^/]+)\/brief$/);
      if (m && method === "GET") {
        if (!getTask(db, m[1])) return err("task not found", 404);
        return json({ task_id: m[1], brief: composeBrief(db, m[1]) });
      }
      m = pathname.match(/^\/api\/tasks\/([^/]+)\/diff$/);
      if (m && method === "GET") return await taskDiffEndpoint(db, m[1], deps);

      m = pathname.match(/^\/api\/tasks\/([^/]+)\/merge$/);
      if (m && method === "POST") return await mergeTask(db, herdr, m[1], await safeJson(req), deps);

      m = pathname.match(/^\/api\/tasks\/([^/]+)\/request-changes$/);
      if (m && method === "POST") return await requestChanges(db, herdr, m[1], await req.json());

      m = pathname.match(/^\/api\/tasks\/([^/]+)\/guarded-action$/);
      if (m && method === "POST") return guardedAction(db, m[1], await req.json());

      m = pathname.match(/^\/api\/tasks\/([^/]+)\/plan$/);
      if (m && method === "POST") {
        if (!getTask(db, m[1])) return err("task not found", 404);
        const r = await runPlanner(db, m[1], { exec: deps.plannerExec });
        return r.ok ? json({ ok: true, decision: r.decision }) : json({ ok: false, error: r.error }, 502);
      }

      // ---- decisions ----
      if (pathname === "/api/decisions") {
        if (method === "GET") return listDecisions(db, url);
        if (method === "POST") return apiCreateDecision(db, await req.json());
      }
      m = pathname.match(/^\/api\/decisions\/([^/]+)$/);
      if (m && method === "GET") {
        const r = db.query("SELECT * FROM decisions WHERE id = ?").get(m[1]);
        return r ? json(parseDecision(r)) : err("decision not found", 404);
      }
      m = pathname.match(/^\/api\/decisions\/([^/]+)\/draft$/);
      if (m && method === "PUT") return saveDraft(db, m[1], await req.json());

      m = pathname.match(/^\/api\/decisions\/([^/]+)\/answer$/);
      if (m && method === "POST") return apiAnswerDecision(db, m[1], await req.json());
      m = pathname.match(/^\/api\/decisions\/([^/]+)\/dismiss$/);
      if (m && method === "POST") return apiDismissDecision(db, m[1]);

      // ---- policies ----
      if (pathname === "/api/policies") {
        if (method === "GET") return listPolicies(db, url);
        if (method === "POST") return createPolicy(db, await req.json());
      }
      m = pathname.match(/^\/api\/policies\/([^/]+)$/);
      if (m) {
        if (method === "GET") {
          const r = db.query("SELECT * FROM policies WHERE id = ?").get(m[1]);
          return r ? json(parsePolicy(r)) : err("policy not found", 404);
        }
        if (method === "PUT") return updatePolicy(db, m[1], await req.json());
        if (method === "DELETE") {
          db.query("DELETE FROM policies WHERE id = ?").run(m[1]);
          return json({ ok: true });
        }
      }

      // ---- authority rules (standing-authority policy engine) ----
      if (pathname === "/api/authority/rules") {
        if (method === "GET") return listAuthorityRules(db, url);
        if (method === "POST") return createAuthorityRule(db, await req.json());
      }
      m = pathname.match(/^\/api\/authority\/rules\/([^/]+)$/);
      if (m) {
        if (method === "PUT") return updateAuthorityRule(db, m[1], await req.json());
        if (method === "DELETE") {
          db.query("DELETE FROM authority_rules WHERE id = ?").run(m[1]);
          return json({ ok: true });
        }
      }

      // ---- analytics (cost/token) ----
      if (pathname === "/api/analytics/summary" && method === "GET") return analyticsSummary(db, url);

      // ---- incidents ----
      if (pathname === "/api/incidents" && method === "GET") return listIncidents(db, url);

      // ---- learnings (regression ledger) ----
      if (pathname === "/api/learnings") {
        if (method === "GET") return listLearnings(db, url);
        if (method === "POST") return createLearning(db, await req.json());
      }
      m = pathname.match(/^\/api\/learnings\/([^/]+)$/);
      if (m) {
        if (method === "GET") {
          const r = db.query("SELECT * FROM learnings WHERE id = ?").get(m[1]);
          return r ? json(r) : err("learning not found", 404);
        }
        if (method === "PUT") return updateLearning(db, m[1], await req.json());
        if (method === "DELETE") {
          db.query("DELETE FROM learnings WHERE id = ?").run(m[1]);
          return json({ ok: true });
        }
      }
      m = pathname.match(/^\/api\/learnings\/([^/]+)\/recur$/);
      if (m && method === "POST") return recurLearning(db, m[1]);

      // ---- notifications ----
      if (pathname === "/api/notifications" && method === "GET") return listNotifications(db, url);
      if (pathname === "/api/notifications/ack" && method === "POST")
        return json({ ok: true, acked: ackNotifications(db) });

      // ---- secrets (names/metadata only; values live in the provider) ----
      m = pathname.match(/^\/api\/projects\/([^/]+)\/secrets$/);
      if (m) {
        if (method === "GET") return listSecrets(db, m[1]);
        if (method === "POST") return createSecret(db, m[1], await req.json());
      }
      m = pathname.match(/^\/api\/projects\/([^/]+)\/secrets\/([^/]+)$/);
      if (m && method === "DELETE") return deleteSecret(db, m[1], decodeURIComponent(m[2]));

      // ---- static web app (falls back to a message when not built) ----
      if (method === "GET" && !pathname.startsWith("/api/"))
        return await serveWeb(pathname);

      return err("not found", 404);
    } catch (e: any) {
      if (e instanceof TransitionError) return err(e.message, 409);
      if (e instanceof SyntaxError) return err("invalid JSON body", 400);
      console.error("[hive] handler error:", e);
      return err(e?.message || "internal error", 500);
    }
  };
}

// ---------------------------------------------------------------- projects
function createProject(db: DB, body: any): Response {
  if (!body?.name) return err("name is required");
  const row = {
    id: newId("proj"),
    name: String(body.name),
    repo_path: body.repo_path ?? null,
    config: JSON.stringify(body.config ?? {}),
    created_at: now(),
  };
  db.query(
    "INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)"
  ).run(row.id, row.name, row.repo_path, row.config, row.created_at);
  return json(parseProject(row), 201);
}

// Update a project's mutable fields. `config` is REPLACED wholesale (the web UI
// reads the project, edits keys like auto_dispatch, and writes the object back).
function updateProject(db: DB, id: string, body: any): Response {
  const existing: any = db.query("SELECT * FROM projects WHERE id = ?").get(id);
  if (!existing) return err("project not found", 404);
  const name = body?.name != null ? String(body.name) : existing.name;
  const repo_path = body?.repo_path !== undefined ? body.repo_path : existing.repo_path;
  const config = body?.config !== undefined ? JSON.stringify(body.config) : existing.config;
  db.query("UPDATE projects SET name = ?, repo_path = ?, config = ? WHERE id = ?").run(name, repo_path, config, id);
  return json(parseProject(db.query("SELECT * FROM projects WHERE id = ?").get(id)));
}

// ---------------------------------------------------------------- intake
// Braindump intake: the director dumps unstructured text and the planner turns
// it into a proposed task breakdown that lands in the decision inbox for
// approval. The braindump itself is stored as a chore task
// (source='intake_braindump') so the raw text, the planner run and any
// planner_error stay durable and inspectable on a task page. The dispatcher
// never auto-spawns intake tasks; approving the plan retires this one.
function intake(db: DB, body: any, deps: HandlerDeps): Response {
  const text = String(body?.text ?? "").trim();
  if (!body?.project_id) return err("project_id is required");
  if (!text) return err("text is required");
  if (!db.query("SELECT 1 FROM projects WHERE id = ?").get(body.project_id))
    return err("unknown project_id", 400);

  const id = newId();
  const t = now();
  // Short enough that "Proposed breakdown: <title>" stays readable on a card.
  const head = text.split("\n")[0];
  const title = `[braindump] ${head.length > 72 ? head.slice(0, 71) + "…" : head}`;
  db.query(
    `INSERT INTO tasks (id, project_id, title, brief, state, kind, source, created_at, updated_at)
     VALUES (?,?,?,?, 'queued', 'chore', 'intake_braindump', ?, ?)`
  ).run(id, body.project_id, title, text, t, t);
  writeEvent(db, { task_id: id, source: "director", type: "created", payload: { title } });
  const task = getTask(db, id);
  broadcastTask(db, task);

  // The planner is a `claude -p` subprocess that runs for tens of seconds, so it
  // must not hold the request open — the decision card arrives over SSE when it
  // lands, and runPlanner records its own planner_error event on failure.
  runPlanner(db, id, { exec: deps.plannerExec }).catch(() => {});
  return json({ ok: true, task }, 202);
}

// ---------------------------------------------------------------- tasks
function createTask(db: DB, body: any): Response {
  if (!body?.project_id) return err("project_id is required");
  if (!body?.title) return err("title is required");
  if (!db.query("SELECT 1 FROM projects WHERE id = ?").get(body.project_id))
    return err("unknown project_id", 400);
  const kind = body.kind ?? "ship";
  if (!["ship", "scout", "chore"].includes(kind)) return err("invalid kind");
  const t = now();
  const row = {
    id: newId(),
    project_id: body.project_id,
    title: String(body.title),
    brief: body.brief ?? null,
    state: "queued",
    kind,
    agent_target: body.agent_target ?? null,
    worktree_path: null,
    branch: null,
    pr_url: null,
    ci_status: null,
    summary: null,
    source: null,
    created_at: t,
    updated_at: t,
  };
  db.query(
    `INSERT INTO tasks (id, project_id, title, brief, state, kind, agent_target,
      worktree_path, branch, pr_url, ci_status, summary, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    row.id, row.project_id, row.title, row.brief, row.state, row.kind,
    row.agent_target, row.worktree_path, row.branch, row.pr_url, row.ci_status,
    row.summary, row.created_at, row.updated_at
  );
  writeEvent(db, { task_id: row.id, source: "director", type: "created", payload: { title: row.title } });
  // Re-read so the assigned `number` (set by the DB trigger) rides on the
  // returned task and the broadcast payload.
  const created = getTask(db, row.id);
  broadcastTask(db, created);

  // Duplicate detection. An exact dup of a brand-new (queued, no agent) task is
  // auto-merged with no interruption; anything fuzzier — or an exact dup of a
  // task that's already started — asks the director via a decision card. Safety:
  // only a queued task with no agent is ever auto-cancelled here.
  const match = detectDuplicate(db, parseTask(row));
  if (match) {
    const safeAuto = row.state === "queued" && !row.agent_target;
    if (match.tier === "exact" && safeAuto) {
      mergeInto(db, row.id, match.survivor.id);
      return json(taskWithHealth(db, getTask(db, row.id)), 201);
    }
    openDuplicateDecision(db, getTask(db, row.id), match);
    return json(taskWithHealth(db, getTask(db, row.id)), 201);
  }
  return json(taskWithHealth(db, created), 201);
}

// Link a marked PR back to its task. Matches by the `hive-task: <id>` body
// footer first (the stable machine key), falling back to the `[hive-<number>]`
// title prefix. Sets pr_url only when the task isn't already linked, so an
// agent-reported PR is never clobbered and re-scanning is idempotent. Shared by
// the reconciler's scan and the POST /api/tasks/link-pr endpoint.
export function linkPrIfMarked(
  db: DB,
  pr: { title?: string | null; body?: string | null; url: string },
  source: "reconciler" | "director" = "reconciler"
): { task_id: string; number: number; linked: boolean } | null {
  const id = taskIdFromBody(pr.body);
  let task: any = id ? getTask(db, id) : null;
  let via = "id";
  if (!task) {
    const n = taskNumberFromTitle(pr.title);
    if (n != null) {
      task = db.query("SELECT * FROM tasks WHERE number = ?").get(n);
      via = "number";
    }
  }
  if (!task) return null;
  if (task.pr_url) return { task_id: task.id, number: task.number, linked: false };
  db.query("UPDATE tasks SET pr_url = ?, updated_at = ? WHERE id = ?").run(pr.url, now(), task.id);
  writeEvent(db, { task_id: task.id, source, type: "pr_linked", payload: { pr_url: pr.url, via } });
  broadcastTask(db, getTask(db, task.id));
  return { task_id: task.id, number: task.number, linked: true };
}

// POST /api/tasks/link-pr {pr_url} — resolve a PR's marker and link it to its
// task. Reads the PR title/body via `gh pr view` and matches by marker.
async function linkPrEndpoint(db: DB, body: any, deps: HandlerDeps): Promise<Response> {
  const prUrl = String(body?.pr_url ?? "").trim();
  if (!prUrl) return err("pr_url is required");
  const exec = deps.exec ?? defaultExec;
  const r = await exec(["gh", "pr", "view", prUrl, "--json", "title,body,url"]);
  if (r.code !== 0) return err(r.stderr.trim() || r.stdout.trim() || "gh pr view failed", 502);
  let data: any;
  try {
    data = JSON.parse(r.stdout);
  } catch {
    return err("could not parse gh pr view output", 502);
  }
  const res = linkPrIfMarked(db, { title: data.title, body: data.body, url: data.url || prUrl }, "director");
  if (!res) return err("PR carries no hive marker (no `hive-task:` footer or `[hive-<n>]` title)", 422);
  return json({ ok: true, ...res });
}

// Update a task's editable fields (title / brief). Used by the attention tray's
// "edit & requeue" flow before it re-queues a failed task.
function updateTask(db: DB, id: string, body: any): Response {
  const task = getTask(db, id);
  if (!task) return err("task not found", 404);
  const title = body?.title != null ? String(body.title) : task.title;
  const brief = body?.brief != null ? String(body.brief) : task.brief;
  db.query("UPDATE tasks SET title = ?, brief = ?, updated_at = ? WHERE id = ?").run(title, brief, now(), id);
  const updated = getTask(db, id);
  broadcastTask(db, updated);
  return json(taskWithHealth(db, updated));
}

// Manual merge: fold this task into `target_id`, cancelling it as a duplicate.
// Distinct from POST /merge (the PR/branch merge another crew built). Refuses
// self-merge and a target that doesn't exist; mergeInto's cancel guards against
// folding an already-terminal task (409 via the transition error).
function mergeIntoEndpoint(db: DB, id: string, body: any): Response {
  const task = getTask(db, id);
  if (!task) return err("task not found", 404);
  const targetId = body?.target_id;
  if (!targetId) return err("target_id is required");
  if (targetId === id) return err("cannot merge a task into itself");
  if (!getTask(db, targetId)) return err("target task not found", 404);
  const cancelled = mergeInto(db, id, targetId);
  return json(taskWithHealth(db, cancelled));
}

function listTasks(db: DB, url: URL): Response {
  const state = url.searchParams.get("state");
  const projectId = url.searchParams.get("project_id");
  const where: string[] = [];
  const args: any[] = [];
  if (state) { where.push("state = ?"); args.push(state); }
  if (projectId) { where.push("project_id = ?"); args.push(projectId); }
  const sql =
    "SELECT * FROM tasks" +
    (where.length ? " WHERE " + where.join(" AND ") : "") +
    " ORDER BY updated_at DESC";
  return json(db.query(sql).all(...args).map(parseTask).map((t) => taskWithHealth(db, t)));
}

// Activity feed: reverse-chronological events across ALL tasks, each enriched
// with its task title/kind/project (single JOIN query, indexed on events(ts)).
// Screenshot/evidence events also carry the evidence url via a json_extract join
// so the web can render thumbnails inline. `?since` (ts), `?project` (id),
// `?limit` (default 100, capped 500), `?types` (csv of feed categories).
//
// ponytail: FEED_CATEGORIES mirrors web/src/lib/eventText.ts. A 5-line map is
// cheaper to duplicate than to cross the server<-web build seam; keep in sync.
const FEED_CATEGORIES: Record<string, string[]> = {
  state: ["state_change", "ready_for_review"],
  decision: ["needs-decision", "decision_answered", "planned", "authority_required", "authority_granted"],
  evidence: ["evidence", "smoke_passed"],
  incident: ["blocked", "stale", "spawn_error", "smoke_failed", "steer_error", "planner_error", "supervise_error", "authority_denied"],
  lifecycle: ["created", "spawned", "agent_status", "status", "steer", "note", "ci_status", "pr_merged", "planning", "assistant_text", "tool_use", "agent_turn_end"],
};

function listFeed(db: DB, url: URL): Response {
  const since = url.searchParams.get("since");
  const project = url.searchParams.get("project");
  const typesCsv = url.searchParams.get("types");
  let limit = parseInt(url.searchParams.get("limit") ?? "100", 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = 100;
  limit = Math.min(limit, 500);

  // null cats = every category; otherwise the selected subset. Standalone monitor
  // incidents (no task_id) are folded in when the "incident" category is in play.
  const cats = typesCsv ? typesCsv.split(",").map((s) => s.trim()).filter(Boolean) : null;
  const wantIncidents = !cats || cats.includes("incident");
  const eventTypes = cats ? cats.flatMap((c) => FEED_CATEGORIES[c] ?? []) : null;

  // ---- task-bound events ----
  let eventRows: any[] = [];
  if (!eventTypes || eventTypes.length > 0) {
    const where: string[] = [];
    const args: any[] = [];
    if (since) { where.push("e.ts > ?"); args.push(since); }
    if (project) { where.push("t.project_id = ?"); args.push(project); }
    if (eventTypes) {
      where.push(`e.type IN (${eventTypes.map(() => "?").join(",")})`);
      args.push(...eventTypes);
    }
    const sql =
      `SELECT e.id, e.task_id, e.ts, e.source, e.type, e.payload,
              t.number AS task_number, t.title AS task_title, t.kind AS task_kind, t.project_id AS project_id,
              p.name AS project_name,
              ev.url AS evidence_url, ev.kind AS evidence_kind
       FROM events e
       JOIN tasks t ON t.id = e.task_id
       JOIN projects p ON p.id = t.project_id
       LEFT JOIN evidence ev ON ev.id = json_extract(e.payload, '$.evidence_id')` +
      (where.length ? " WHERE " + where.join(" AND ") : "") +
      " ORDER BY e.ts DESC, e.id DESC LIMIT ?";
    args.push(limit);
    eventRows = db.query(sql).all(...args).map((r: any) => ({
      id: r.id,
      task_id: r.task_id,
      ts: r.ts,
      source: r.source,
      type: r.type,
      payload: JSON.parse(r.payload || "{}"),
      task_number: r.task_number ?? null,
      task_title: r.task_title,
      task_kind: r.task_kind,
      project_id: r.project_id,
      project_name: r.project_name,
      evidence_url: r.evidence_url ?? null,
      evidence_kind: r.evidence_kind ?? null,
    }));
  }

  // ---- standalone monitor incidents (incidents table, no task_id) ----
  let incidentRows: any[] = [];
  if (wantIncidents) {
    const where: string[] = [];
    const args: any[] = [];
    if (since) { where.push("i.ts > ?"); args.push(since); }
    if (project) { where.push("i.project_id = ?"); args.push(project); }
    const sql =
      `SELECT i.id, i.project_id, i.monitor, i.ts, i.status, i.detail, p.name AS project_name
       FROM incidents i
       JOIN projects p ON p.id = i.project_id` +
      (where.length ? " WHERE " + where.join(" AND ") : "") +
      " ORDER BY i.ts DESC LIMIT ?";
    args.push(limit);
    incidentRows = db.query(sql).all(...args).map((r: any) => ({
      id: r.id,
      task_id: null,
      ts: r.ts,
      source: "monitor",
      type: "incident",
      payload: { monitor: r.monitor, status: r.status, detail: r.detail, project_id: r.project_id },
      task_number: null,
      task_title: null,
      task_kind: null,
      project_id: r.project_id,
      project_name: r.project_name,
      evidence_url: null,
      evidence_kind: null,
    }));
  }

  // Merge both streams into one reverse-chronological page. Each source is
  // pre-capped at `limit`, so slicing the sorted merge to `limit` is exact.
  const rows = [...eventRows, ...incidentRows]
    .sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : a.id < b.id ? 1 : -1))
    .slice(0, limit);
  return json({ events: rows });
}

// Morning brief: ONE composed catch-up view over existing data (no new tables).
// "what happened while I was away and what needs me", in priority order. Every
// section is a plain query over rows the other endpoints already expose; the web
// renders them with the existing Decisions / attention-tray / card components.
//
// `?since` (ISO) scopes the "what changed" sections (done / incidents / spend /
// learnings). The action-state sections (open decisions, needs-attention, live
// fleet, unreviewed intake) are current-state, not windowed — they need you now
// regardless of when you last looked.
function brief(db: DB, url: URL): Response {
  const since = url.searchParams.get("since");

  // ① done since — completed tasks with evidence count + summary, keyed on the
  // state_change→done event ts (the actual completion moment).
  const done = db
    .query(
      `SELECT t.id, t.title, t.summary, t.project_id, p.name AS project_name, sc.ts AS done_at,
              (SELECT COUNT(*) FROM evidence e WHERE e.task_id = t.id) AS evidence_count
       FROM tasks t
       JOIN projects p ON p.id = t.project_id
       JOIN events sc ON sc.task_id = t.id AND sc.type = 'state_change'
         AND json_extract(sc.payload, '$.to') = 'done'
       WHERE t.state = 'done'` + (since ? " AND sc.ts >= ?" : "") +
      " ORDER BY sc.ts DESC"
    )
    .all(...(since ? [since] : []));

  // ② needs attention — failed tasks awaiting triage + live tasks whose health
  // is dead/stuck. Full task objects (with health) so the web reuses tray rows.
  // Not windowed: these persist until you act on them.
  const attnCandidates = db
    .query(
      "SELECT * FROM tasks WHERE state = 'failed' OR (agent_target IS NOT NULL AND state IN ('in_progress','needs_decision','in_review','verifying'))"
    )
    .all()
    .map(parseTask)
    .map((t: any) => taskWithHealth(db, t));
  const failed_or_attention = attnCandidates.filter((t: any) => needsAttention(t));

  // ③ decisions — open cards ARE the action items (full objects, rendered inline).
  const decisions = db
    .query("SELECT * FROM decisions WHERE status = 'open' ORDER BY ts DESC")
    .all()
    .map(parseDecision);

  // ④ fleet now — currently live agents (task + health).
  const fleet = db
    .query(
      "SELECT * FROM tasks WHERE agent_target IS NOT NULL AND state IN ('in_progress','needs_decision','in_review','verifying') ORDER BY updated_at DESC"
    )
    .all()
    .map(parseTask)
    .map((t: any) => taskWithHealth(db, t));

  // ⑤ incidents opened/resolved since.
  const incidents = db
    .query(
      `SELECT i.*, p.name AS project_name FROM incidents i
       JOIN projects p ON p.id = i.project_id` + (since ? " WHERE i.ts >= ?" : "") +
      " ORDER BY i.ts DESC"
    )
    .all(...(since ? [since] : []));

  // ⑥ intake — unreviewed Google-Chat draft tasks still queued for triage.
  const intake = db
    .query(
      "SELECT t.*, p.name AS project_name FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.source = 'intake_gchat' AND t.state = 'queued' ORDER BY t.created_at DESC"
    )
    .all()
    .filter((t: any) => !isReviewed(db, t.id))
    .map((t: any) => ({ ...parseTask(t), project_name: t.project_name }));

  // ⑦ to review — in-review tasks awaiting the captain's review & merge. Full
  // task objects (with health) so the web renders review cards inline.
  const to_review = db
    .query("SELECT * FROM tasks WHERE state = 'in_review' ORDER BY updated_at DESC")
    .all()
    .map(parseTask)
    .map((t: any) => taskWithHealth(db, t));

  // ⑧ spend since — reuse the analytics rollup (totals + by-model for top model).
  const w = since ? " WHERE ts >= ?" : "";
  const a = since ? [since] : [];
  const spend = {
    totals: db.query(`SELECT ${usageTotals()} FROM usage${w}`).get(...a),
    by_model: db
      .query(`SELECT model, ${usageTotals()} FROM usage${w} GROUP BY model ORDER BY cost_usd DESC, total_tokens DESC`)
      .all(...a),
  };

  // ⑨ learnings created/recurred since (last_seen bumps on both create and recur).
  const learnings_new = db
    .query(
      `SELECT l.*, p.name AS project_name FROM learnings l
       JOIN projects p ON p.id = l.project_id` + (since ? " WHERE l.last_seen >= ?" : "") +
      " ORDER BY l.last_seen DESC"
    )
    .all(...(since ? [since] : []));

  return json({
    since: since ?? null,
    done,
    failed_or_attention,
    decisions,
    fleet,
    incidents,
    intake,
    to_review,
    spend,
    learnings_new,
  });
}

// Evidence browser: all evidence across tasks, newest first, joined to its task
// title/kind + project, with an inline preview for test_run/log. Filters:
// project, kind, task; cap 100.
function listEvidence(db: DB, url: URL): Response {
  const project = url.searchParams.get("project");
  const kind = url.searchParams.get("kind");
  const task = url.searchParams.get("task");
  let limit = parseInt(url.searchParams.get("limit") ?? "100", 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = 100;
  limit = Math.min(limit, 100);

  const where: string[] = [];
  const args: any[] = [];
  if (project) { where.push("t.project_id = ?"); args.push(project); }
  if (kind) { where.push("ev.kind = ?"); args.push(kind); }
  if (task) { where.push("ev.task_id = ?"); args.push(task); }

  const sql =
    `SELECT ev.*, t.title AS task_title, t.kind AS task_kind,
            t.project_id AS project_id, p.name AS project_name
     FROM evidence ev
     JOIN tasks t ON t.id = ev.task_id
     JOIN projects p ON p.id = t.project_id` +
    (where.length ? " WHERE " + where.join(" AND ") : "") +
    " ORDER BY ev.ts DESC, ev.id DESC LIMIT ?";
  args.push(limit);

  const rows = db.query(sql).all(...args).map((r: any) => ({
    id: r.id,
    task_id: r.task_id,
    ts: r.ts,
    kind: r.kind,
    path: r.path,
    url: r.url,
    caption: r.caption,
    meta: JSON.parse(r.meta || "{}"),
    task_title: r.task_title,
    task_kind: r.task_kind,
    project_id: r.project_id,
    project_name: r.project_name,
    preview: evidencePreview(r.path, r.kind),
  }));
  return json({ evidence: rows });
}

// Global search across the five text-bearing entities. Honest LIKE (not FTS5:
// an FTS virtual table + triggers across five heterogeneous tables doesn't
// compose cleanly with the append-only migration list, and the DB is a
// single-user local file). Rank per entity: exact title > title prefix >
// title contains > body only. Capped at 50 total.
// ponytail: LIKE scan over a local single-user DB; swap for FTS5 if the
// tables ever grow past tens of thousands of rows.
function searchSnippet(text: string | null, q: string, len = 120): string {
  if (!text) return "";
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return text.length > len ? text.slice(0, len) + "…" : text;
  const start = Math.max(0, i - 30);
  const end = start + len;
  return (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
}
function titleRank(title: string, q: string): number {
  const t = (title || "").toLowerCase();
  const ql = q.toLowerCase();
  if (t === ql) return 0;
  if (t.startsWith(ql)) return 1;
  if (t.includes(ql)) return 2;
  return 3; // matched in a body field only
}
function search(db: DB, url: URL): Response {
  const q = (url.searchParams.get("q") ?? "").trim();
  let limit = parseInt(url.searchParams.get("limit") ?? "50", 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = 50;
  limit = Math.min(limit, 50);
  if (!q) return json({ hits: [] });

  const like = "%" + q.replace(/[\\%_]/g, (c) => "\\" + c) + "%";
  const E = " ESCAPE '\\'";
  type Hit = {
    type: string; id: string; title: string; snippet: string;
    task_state?: string; project_id?: string; _rank: number;
  };
  const hits: Hit[] = [];
  const bodySnippet = (title: string, ...bodies: (string | null)[]) => {
    for (const b of bodies) if (b && b.toLowerCase().includes(q.toLowerCase())) return searchSnippet(b, q);
    return searchSnippet(bodies.find((b) => b) ?? title, q);
  };

  for (const r of db.query(
    `SELECT id, title, brief, summary, state, project_id FROM tasks
     WHERE title LIKE ?${E} OR brief LIKE ?${E} OR summary LIKE ?${E}`
  ).all(like, like, like) as any[]) {
    hits.push({ type: "task", id: r.id, title: r.title, snippet: bodySnippet(r.title, r.brief, r.summary), task_state: r.state, project_id: r.project_id, _rank: titleRank(r.title, q) });
  }
  for (const r of db.query(
    `SELECT id, title, context FROM decisions WHERE title LIKE ?${E} OR context LIKE ?${E}`
  ).all(like, like) as any[]) {
    hits.push({ type: "decision", id: r.id, title: r.title, snippet: bodySnippet(r.title, r.context), _rank: titleRank(r.title, q) });
  }
  for (const r of db.query(
    `SELECT id, title, body, project_id FROM learnings WHERE title LIKE ?${E} OR body LIKE ?${E}`
  ).all(like, like) as any[]) {
    hits.push({ type: "learning", id: r.id, title: r.title, snippet: bodySnippet(r.title, r.body), project_id: r.project_id, _rank: titleRank(r.title, q) });
  }
  for (const r of db.query(
    `SELECT id, title, body FROM policies WHERE title LIKE ?${E} OR body LIKE ?${E}`
  ).all(like, like) as any[]) {
    hits.push({ type: "policy", id: r.id, title: r.title, snippet: bodySnippet(r.title, r.body), _rank: titleRank(r.title, q) });
  }
  for (const r of db.query(
    `SELECT id, name FROM projects WHERE name LIKE ?${E}`
  ).all(like) as any[]) {
    hits.push({ type: "project", id: r.id, title: r.name, snippet: "", _rank: titleRank(r.name, q) });
  }

  hits.sort((a, b) => a._rank - b._rank || a.title.localeCompare(b.title));
  const out = hits.slice(0, limit).map(({ _rank, ...h }) => h);
  return json({ hits: out });
}

// First ~3 non-empty lines of a test_run/log evidence file, so the pass/fail
// counts are scannable inline without downloading. null for other kinds or an
// unreadable file.
// ponytail: reads the whole file; evidence files are small (test output / smoke
// JSON). Bound the read if logs ever grow large.
function evidencePreview(path: string | null, kind: string): string | null {
  if (!path || (kind !== "test_run" && kind !== "log")) return null;
  try {
    const lines = readFileSync(path, "utf8")
      .split("\n")
      .map((l) => l.trimEnd())
      .filter((l) => l.trim() !== "");
    return lines.length ? lines.slice(0, 3).join("\n") : null;
  } catch {
    return null;
  }
}

function getTaskFull(db: DB, id: string): Response {
  const task = getTask(db, id);
  if (!task) return err("task not found", 404);
  const events = db.query("SELECT * FROM events WHERE task_id = ? ORDER BY ts").all(id).map(parseEvent);
  const evidence = db
    .query("SELECT * FROM evidence WHERE task_id = ? ORDER BY ts")
    .all(id)
    .map(parseEvidence)
    .map((e: any) => ({ ...e, preview: evidencePreview(e.path, e.kind) }));
  const decisions = db.query("SELECT * FROM decisions WHERE task_id = ? ORDER BY ts").all(id).map(parseDecision);
  return json({ ...taskWithHealth(db, task), events, evidence, decisions });
}

async function doTransition(db: DB, id: string, body: any): Promise<Response> {
  if (!body?.to) return err("'to' state is required");
  const to = body.to as State;
  // High-blast-radius transitions (post-merge verify, marking done) are gated.
  if (to === "verifying" || to === "done") {
    const t = getTask(db, id);
    if (t) {
      const blocked = authzBlock(db, { project_id: t.project_id, action: `task.${to === "verifying" ? "verify" : "done"}`, target: t.title, task_id: id });
      if (blocked) return blocked;
    }
  }
  const task = transition(db, id, to, {
    source: body.source ?? "director",
    reason: body.reason,
  });
  // Post-deploy smoke runs once when a task enters `verifying`. runSmoke may
  // bounce the task back to in_progress on failure; re-read to reflect that.
  if (to === "verifying") {
    await runSmoke(db, id).catch((e) => console.error("[hive] smoke run failed:", e));
    return json(getTask(db, id));
  }
  return json(task);
}

// ---- review experience: diff / approve+merge / request-changes ----

// GET /api/tasks/:id/diff → the structured branch diff for the review UI.
async function taskDiffEndpoint(db: DB, id: string, deps: HandlerDeps): Promise<Response> {
  const r = await taskDiff(db, id, deps.exec ?? defaultExec);
  return r.ok ? json(r.diff) : err(r.error, r.status);
}

// Map our merge_method config onto gh's flag. Squash is the default.
function ghMergeFlag(method: string | undefined): string {
  if (method === "merge") return "--merge";
  if (method === "rebase") return "--rebase";
  return "--squash";
}

// POST /api/tasks/:id/merge — approve & merge an in-review task.
// PR-backed: `gh pr merge <url> <method>`. Otherwise a local fast-forward of the
// task branch into the project's default branch. On success: `merged` event,
// in_review→verifying (triggers smoke), best-effort worktree teardown. On
// failure (conflict / not fast-forward / CI blocked): 409 with the reason and no
// state change. Guarded by the `task.merge` standing-authority action.
async function mergeTask(db: DB, herdr: Herdr, id: string, body: any, deps: HandlerDeps): Promise<Response> {
  const task = getTask(db, id);
  if (!task) return err("task not found", 404);
  if (task.state !== "in_review")
    return err(`task is '${task.state}', not 'in_review'; only in-review tasks can be merged`, 409);

  const blocked = authzBlock(db, { project_id: task.project_id, action: "task.merge", target: task.title, task_id: id });
  if (blocked) return blocked;

  const exec = deps.exec ?? defaultExec;
  const project: any = db.query("SELECT * FROM projects WHERE id = ?").get(task.project_id);
  const config = JSON.parse(project?.config ?? "{}");
  const base = config.default_branch || "main";

  let method: string;
  if (task.pr_url) {
    const flag = ghMergeFlag(config.merge_method);
    method = `pr ${flag.slice(2)}`;
    const r = await exec(["gh", "pr", "merge", task.pr_url, flag]);
    if (r.code !== 0) {
      const reason = r.stderr.trim() || r.stdout.trim() || `gh pr merge exited ${r.code}`;
      writeEvent(db, { task_id: id, source: "director", type: "merge_failed", payload: { reason } });
      return err(reason, 409);
    }
  } else {
    if (!project?.repo_path) return err("project has no repo_path; cannot merge", 400);
    if (!task.branch) return err("task has no branch and no pr_url; nothing to merge", 400);
    // Documented safe local merge: fast-forward the default branch to the task
    // branch tip. Requires the default branch to be an ancestor of the task
    // branch; a non-fast-forward (diverged / conflicting) merge is refused, no
    // working tree is touched. Callers wanting a squash merge should use a PR.
    const anc = await exec(["git", "-C", project.repo_path, "merge-base", "--is-ancestor", base, task.branch]);
    if (anc.code !== 0) {
      const reason = `'${base}' is not an ancestor of '${task.branch}'; not a fast-forward (rebase the branch or open a PR)`;
      writeEvent(db, { task_id: id, source: "director", type: "merge_failed", payload: { reason } });
      return err(reason, 409);
    }
    const r = await exec(["git", "-C", project.repo_path, "merge", "--ff-only", task.branch]);
    if (r.code !== 0) {
      const reason = r.stderr.trim() || r.stdout.trim() || `git merge --ff-only exited ${r.code}`;
      writeEvent(db, { task_id: id, source: "director", type: "merge_failed", payload: { reason } });
      return err(reason, 409);
    }
    method = "local ff-only";
  }

  writeEvent(db, { task_id: id, source: "director", type: "merged", payload: { method, base, branch: task.branch, pr_url: task.pr_url } });
  // in_review → verifying (runs post-deploy smoke once).
  transition(db, id, "verifying", { source: "director", reason: `merged (${method})` });
  await runSmoke(db, id).catch((e) => console.error("[hive] smoke run failed:", e));

  // Best-effort worktree teardown now the branch is merged. Never fails the
  // request — a leftover worktree is a cleanup nuisance, not a merge failure.
  if (task.worktree_path && task.branch && project?.repo_path) {
    try {
      await herdr.teardown({
        repoPath: project.repo_path,
        branch: task.branch,
        worktreePath: task.worktree_path,
        defaultBranch: base,
      });
    } catch (e) {
      console.error(`[hive] teardown after merge failed for ${id}:`, e);
    }
  }

  return json(getTask(db, id));
}

// POST /api/tasks/:id/request-changes body {notes} — bounce an in-review task
// back to in_progress and deliver the captain's notes to the agent (best-effort
// send; the `changes_requested` event records the notes either way, so a dead
// agent gets them when it respawns and re-reads its timeline).
async function requestChanges(db: DB, herdr: Herdr, id: string, body: any): Promise<Response> {
  const task = getTask(db, id);
  if (!task) return err("task not found", 404);
  if (task.state !== "in_review")
    return err(`task is '${task.state}', not 'in_review'`, 409);
  const notes = String(body?.notes ?? "").trim();
  if (!notes) return err("notes are required");

  let delivered = false;
  if (task.agent_target) {
    try {
      const res = await herdr.send(task.agent_target, `hive: changes requested before merge —\n${notes}`);
      delivered = res.code === 0;
    } catch {
      delivered = false;
    }
  }
  writeEvent(db, { task_id: id, source: "director", type: "changes_requested", payload: { notes, delivered } });
  const updated = transition(db, id, "in_progress", { source: "director", reason: "changes requested" });
  return json({ ok: true, delivered, task: updated });
}

// Spawn a herdr agent for a queued task: create the worktree, start the agent
// with HIVE_TASK_ID/HIVE_URL + project secrets in env and the composed brief.
async function spawnTask(
  db: DB,
  herdr: Herdr,
  id: string,
  body: any,
  deps: HandlerDeps
): Promise<Response> {
  const task = getTask(db, id);
  if (!task) return err("task not found", 404);
  const project: any = db.query("SELECT * FROM projects WHERE id = ?").get(task.project_id);
  if (!project?.repo_path) return err("project has no repo_path; cannot spawn", 400);
  const blocked = authzBlock(db, { project_id: task.project_id, action: "task.spawn", target: task.title, task_id: id });
  if (blocked) return blocked;

  const r = await spawnAgent(db, herdr, id, { hiveUrl: body?.hive_url, supervise: deps.supervise });
  if (!r.ok) return err(`spawn failed: ${r.error}`, 502);
  return json({ ok: true, task: getTask(db, id), agent_target: r.agent_target });
}

// The reusable spawn core, shared by the /spawn endpoint and the dispatcher.
// Composes the brief, creates the worktree + starts the agent via herdr, writes
// the `spawned`/`spawn_error` events and the queued->in_progress transition.
// Assumes callers have already run their own gates (authority, dispatch policy).
// Returns {ok:false} instead of throwing so the dispatcher can back off.
export async function spawnAgent(
  db: DB,
  herdr: Herdr,
  id: string,
  opts: { hiveUrl?: string; supervise?: boolean } = {}
): Promise<{ ok: true; agent_target: string } | { ok: false; error: string }> {
  const task = getTask(db, id);
  if (!task) return { ok: false, error: "task not found" };
  const project: any = db.query("SELECT * FROM projects WHERE id = ?").get(task.project_id);
  if (!project?.repo_path) return { ok: false, error: "project has no repo_path" };
  const config = JSON.parse(project.config ?? "{}");

  // Compose the brief fresh; it is delivered as the interactive agent's first
  // prompt (see runtime/herdr.defaultAgentArgv) — no `-p` one-shot.
  const brief = composeBrief(db, id);
  const hiveUrl = opts.hiveUrl || process.env.HIVE_URL || `http://127.0.0.1:${process.env.HIVE_PORT || 4700}`;
  const env = await resolveProjectSecrets(db, task.project_id);

  let result;
  try {
    result = await herdr.spawn({
      taskId: id,
      repoPath: project.repo_path,
      hiveUrl,
      title: task.title,
      brief,
      base: config.default_branch,
      env,
      agentArgv: config.agent_argv, // optional per-project override (verbatim)
      // Seed the worktree with hive's Claude Code hook wiring BEFORE the agent
      // starts, so Stop/SubagentStop/PostToolUse reporting is structural.
      prepareWorktree: (worktreePath) => writeHookSettings(worktreePath, id, hiveUrl, config.command_approval),
    });
  } catch (e: any) {
    writeEvent(db, { task_id: id, source: "herdr", type: "spawn_error", payload: { error: String(e?.message ?? e) } });
    return { ok: false, error: String(e?.message ?? e) };
  }

  db.query(
    "UPDATE tasks SET agent_target = ?, worktree_path = ?, branch = ?, updated_at = ? WHERE id = ?"
  ).run(result.agent_target, result.worktree_path, result.branch, now(), id);
  writeEvent(db, {
    task_id: id,
    source: "herdr",
    type: "spawned",
    payload: {
      agent_target: result.agent_target,
      branch: result.branch,
      worktree_path: result.worktree_path,
      tab_id: result.tab_id,
      label: result.label,
      fleet_workspace_id: result.fleet_workspace_id,
    },
  });
  if (task.state === "queued") transition(db, id, "in_progress", { source: "herdr", reason: "agent spawned" });

  if (opts.supervise) superviseAgent(db, herdr, id, result.agent_target);

  return { ok: true, agent_target: result.agent_target };
}

// Re-arming supervised wait loop. Each completed wait re-arms; on error the
// reconciler's polling is the safety net. Started only in production wiring.
async function superviseAgent(db: DB, herdr: Herdr, taskId: string, target: string): Promise<void> {
  const WAIT_MS = 5 * 60 * 1000;
  // ponytail: sequential loop, one agent per task; fine for a localhost tool.
  while (true) {
    const task = getTask(db, taskId);
    if (!task || TERMINAL.includes(task.state as State)) return;
    let res;
    try {
      res = await herdr.wait(target, "idle", WAIT_MS);
    } catch (e) {
      writeEvent(db, { task_id: taskId, source: "herdr", type: "supervise_error", payload: { error: String((e as any)?.message ?? e) } });
      return; // reconciler takes over
    }
    if (res.code !== 0) return; // timeout / not found: fall back to reconciler polling
    const status = await herdr.status(target);
    if (status !== "unknown") {
      const last = db
        .query("SELECT payload FROM events WHERE task_id = ? AND type = 'agent_status' ORDER BY ts DESC LIMIT 1")
        .get(taskId) as { payload: string } | undefined;
      const prev = last ? (JSON.parse(last.payload).status ?? null) : null;
      if (status !== prev)
        writeEvent(db, { task_id: taskId, source: "herdr", type: "agent_status", payload: { status } });
    }
  }
}

// Steer a live agent via `herdr agent send`. Degrades gracefully: the event is
// always recorded; a herdr failure is surfaced in the response, never thrown.
async function sendSteer(db: DB, herdr: Herdr, id: string, body: any): Promise<Response> {
  const task = getTask(db, id);
  if (!task) return err("task not found", 404);
  const message = String(body?.message ?? "");
  if (!message) return err("message is required");
  const blocked = authzBlock(db, { project_id: task.project_id, action: "task.steer", target: task.title, task_id: id });
  if (blocked) return blocked;
  const target = task.agent_target;
  writeEvent(db, { task_id: id, source: "director", type: "steer", payload: { message, target } });

  if (!target) return json({ ok: false, delivered: false, error: "task has no agent_target (not spawned)" });
  try {
    const res = await herdr.send(target, message);
    if (res.code !== 0) {
      const error = res.stderr.trim() || res.stdout.trim() || `herdr send exited ${res.code}`;
      writeEvent(db, { task_id: id, source: "herdr", type: "steer_error", payload: { error } });
      return json({ ok: false, delivered: false, error });
    }
    return json({ ok: true, delivered: true, message });
  } catch (e: any) {
    const error = String(e?.message ?? e);
    writeEvent(db, { task_id: id, source: "herdr", type: "steer_error", payload: { error } });
    return json({ ok: false, delivered: false, error });
  }
}

// MCP servers whose tools open an interactive Allow/Deny dialog. A spawned
// worker has no human at its pane, so the dialog blocks the session forever
// (health=stuck, seen 2026-07-09). A bare `mcp__<server>` deny entry drops every
// tool of that server from the agent's context — verified live: the denied tools
// are not merely rejected on call, they never appear, so no dialog can fire.
// Deny beats allow across all settings scopes, which is why this reaches
// claude-in-chrome even though the Chrome extension (not .mcp.json) registers
// it. Browser verification goes headless instead (BROWSER_VERIFICATION, briefs.ts).
const DENIED_MCP_SERVERS = ["mcp__claude-in-chrome", "mcp__computer-use"];

// Clearly-safe, read-only / standard-dev tool patterns that must NEVER raise a
// permission dialog for a spawned worker (no human is at the pane to answer).
// `deny` still beats `allow`, so the browser-MCP denials above are unaffected.
// Anything NOT on this list falls through to the PreToolUse classifier hook,
// which auto-approves other safe commands and escalates risky ones to the
// authority engine. Kept in lockstep with the SAFE list in hooks/classify.ts.
const SAFE_TOOL_ALLOWLIST = [
  "Read",
  "Grep",
  "Glob",
  "NotebookRead",
  "TodoWrite",
  "Bash(ls:*)",
  "Bash(cat:*)",
  "Bash(pwd)",
  "Bash(echo:*)",
  "Bash(head:*)",
  "Bash(tail:*)",
  "Bash(wc:*)",
  "Bash(grep:*)",
  "Bash(rg:*)",
  "Bash(find:*)",
  "Bash(which:*)",
  "Bash(git status:*)",
  "Bash(git diff:*)",
  "Bash(git log:*)",
  "Bash(git show:*)",
  "Bash(git branch:*)",
  "Bash(bun test:*)",
  "Bash(bun run:*)",
  "Bash(npm test:*)",
  "Bash(npm run:*)",
  "Bash(pnpm test:*)",
  "Bash(pnpm run:*)",
  "Bash(yarn test:*)",
];

// Write hive's Claude Code hook wiring into a spawned worktree. Uses
// settings.local.json (the per-directory override, gitignored by Claude Code
// convention) so the agent reports Stop/SubagentStop/PostToolUse to hive
// without any agent discipline. HIVE_TASK_ID/HIVE_URL reach the hook via the
// agent's env (`herdr agent start --env`); the hook is a no-op without them.
// `commandApproval` (project config `command_approval`) governs UNKNOWN commands
// in the PreToolUse classifier: escalate (default) | allow | prompt.
function writeHookSettings(
  worktreePath: string,
  taskId: string,
  hiveUrl: string,
  commandApproval: "escalate" | "allow" | "prompt" = "escalate"
): void {
  const hook = join(HOOKS_DIR, "hive-hook.sh");
  const approve = join(HOOKS_DIR, "hive-approve.sh");
  const settings = {
    permissions: { allow: SAFE_TOOL_ALLOWLIST, deny: DENIED_MCP_SERVERS },
    hooks: {
      // Gate Bash before it runs: safe commands auto-approve, risky ones escalate
      // to the authority engine so an autonomous worker never hangs on a dialog.
      PreToolUse: [
        { matcher: "Bash", hooks: [{ type: "command", command: `${approve} ${commandApproval}` }] },
      ],
      Stop: [{ hooks: [{ type: "command", command: `${hook} Stop` }] }],
      SubagentStop: [{ hooks: [{ type: "command", command: `${hook} SubagentStop` }] }],
      PostToolUse: [
        { matcher: "Bash|Write|Edit", hooks: [{ type: "command", command: `${hook} PostToolUse` }] },
      ],
    },
  };
  const dir = join(worktreePath, ".claude");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "settings.local.json"), JSON.stringify(settings, null, 2));
}

// "View agent" affordance: focus the task's herdr tab so David can watch/attach.
async function focusAgent(db: DB, herdr: Herdr, id: string): Promise<Response> {
  const task = getTask(db, id);
  if (!task) return err("task not found", 404);
  if (!task.agent_target) return json({ ok: false, focused: false, error: "task has no agent" });
  try {
    const r = await herdr.focus(task.agent_target);
    if (r.code !== 0) {
      const error = r.stderr.trim() || r.stdout.trim() || `herdr focus exited ${r.code}`;
      return json({ ok: false, focused: false, error });
    }
    writeEvent(db, { task_id: id, source: "director", type: "focus_agent", payload: { target: task.agent_target } });
    return json({ ok: true, focused: true, target: task.agent_target });
  } catch (e: any) {
    return json({ ok: false, focused: false, error: String(e?.message ?? e) });
  }
}

// Manual "fail + requeue" (the recovery banner's override): fail the task if
// live, then spin up a fresh queued copy. Idempotent on an already-failed task.
function requeueEndpoint(db: DB, id: string): Response {
  const task = getTask(db, id);
  if (!task) return err("task not found", 404);
  if (!TERMINAL.includes(task.state as State)) {
    transition(db, id, "failed", { source: "director", reason: "manual fail + requeue" });
  }
  const newId = requeueTask(db, getTask(db, id));
  writeEvent(db, { task_id: id, source: "director", type: "requeued", payload: { new_task_id: newId } });
  return json({ ok: true, new_task_id: newId });
}

// Manual cleanup trigger: force teardown (worktree + herdr session) for a
// terminal task. Refuses on a live task so an in-flight worktree is never
// removed out from under a working agent. Backstop for the auto-teardown that
// fires on the done/cancelled transition and the periodic reaper sweep.
async function cleanupEndpoint(db: DB, herdr: Herdr, id: string): Promise<Response> {
  const task = getTask(db, id);
  if (!task) return err("task not found", 404);
  if (!TERMINAL.includes(task.state as State))
    return err("task is not terminal; refusing to clean up a live task", 409);
  const r = await cleanupTask(db, herdr, id, { force: true });
  return json({ ok: true, ...r });
}

// Create a fresh queued copy of a task (source='requeue', parent_task_id → the
// failed original). The lineage links let the recovery loop cap auto-requeues.
export function requeueTask(db: DB, source: any): string {
  const id = newId();
  const t = now();
  db.query(
    `INSERT INTO tasks (id, project_id, title, brief, state, kind, source, parent_task_id, created_at, updated_at)
     VALUES (?,?,?,?, 'queued', ?, 'requeue', ?, ?, ?)`
  ).run(id, source.project_id, source.title, source.brief ?? null, source.kind, source.id, t, t);
  writeEvent(db, { task_id: id, source: "reconciler", type: "created", payload: { title: source.title, requeue_of: source.id } });
  broadcastTask(db, getTask(db, id));
  return id;
}

// Open the "recovery cap reached / agent unresponsive" decision card. A
// `recovery_card` event links it to the source task so answering `requeue`
// resolves to a fresh task (resolveRecoveryForDecision).
export function openRecoveryDecision(db: DB, task: any, attempts: number): any {
  const decision = createDecision(db, {
    task_id: task.id,
    title: `Recover failed task: ${task.title}`,
    context:
      `The agent for this task could not be kept alive (auto-requeued ${attempts} time(s) without success). ` +
      `Requeue once more or abandon it?`,
    risk: "normal",
    blast_radius: `Task ${task.id} (${task.title}).`,
    options: [
      { key: "requeue", label: "Requeue once more", detail: "Create a fresh queued task and try again.", recommended: true },
      { key: "abandon", label: "Abandon", detail: "Leave the task failed." },
    ],
  });
  writeEvent(db, { task_id: task.id, source: "reconciler", type: "recovery_card", payload: { decision_id: decision.id, source_task_id: task.id } });
  return decision;
}

// On answering a recovery card: `requeue` → fresh task; anything else → nothing.
export function resolveRecoveryForDecision(db: DB, decisionId: string, answerKey: string): boolean {
  const ev = db
    .query("SELECT payload FROM events WHERE type = 'recovery_card' AND json_extract(payload, '$.decision_id') = ? ORDER BY ts DESC LIMIT 1")
    .get(decisionId) as { payload: string } | undefined;
  if (!ev) return false;
  if (answerKey !== "requeue") return true;
  const sourceId = JSON.parse(ev.payload).source_task_id;
  const source = getTask(db, sourceId);
  if (source) requeueTask(db, source);
  return true;
}

// ---------------------------------------------------------------- incidents
function listIncidents(db: DB, url: URL): Response {
  const status = url.searchParams.get("status");
  const rows = status
    ? db.query("SELECT * FROM incidents WHERE status = ? ORDER BY ts DESC").all(status)
    : db.query("SELECT * FROM incidents ORDER BY ts DESC").all();
  return json({ incidents: rows.map(parseIncident) });
}

// ---------------------------------------------------------------- learnings (regression ledger)
function listLearnings(db: DB, url: URL): Response {
  const projectId = url.searchParams.get("project_id");
  const status = url.searchParams.get("status");
  const where: string[] = [];
  const args: any[] = [];
  if (projectId) { where.push("project_id = ?"); args.push(projectId); }
  if (status) { where.push("status = ?"); args.push(status); }
  const sql =
    "SELECT * FROM learnings" +
    (where.length ? " WHERE " + where.join(" AND ") : "") +
    " ORDER BY last_seen DESC";
  return json(db.query(sql).all(...args));
}

// Create a learning. With create_root_cause_task, auto-spawn a queued `chore`
// task (brief prefilled from the learning) and link it — the "unblock now,
// root-cause later" flow.
function createLearning(db: DB, body: any): Response {
  if (!body?.project_id) return err("project_id is required");
  if (!body?.title) return err("title is required");
  if (!db.query("SELECT 1 FROM projects WHERE id = ?").get(body.project_id))
    return err("unknown project_id", 400);
  const t = now();
  const row: any = {
    id: newId("lrn"),
    project_id: body.project_id,
    title: String(body.title),
    body: body.body ?? null,
    source_task_id: body.source_task_id ?? null,
    occurrences: 1,
    first_seen: t,
    last_seen: t,
    status: "active",
    root_cause_task_id: null,
  };
  if (body.create_root_cause_task)
    row.root_cause_task_id = createRootCauseTask(db, row);
  db.query(
    `INSERT INTO learnings (id, project_id, title, body, source_task_id, occurrences,
      first_seen, last_seen, status, root_cause_task_id) VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(
    row.id, row.project_id, row.title, row.body, row.source_task_id, row.occurrences,
    row.first_seen, row.last_seen, row.status, row.root_cause_task_id
  );
  broadcast({ type: "learning", learning: row });
  return json(row, 201);
}

// Direct insert of a queued chore task (mirrors createIncidentTask). Returns the
// new task id so the learning can link it.
function createRootCauseTask(db: DB, learning: any): string {
  const t = now();
  const id = newId();
  const title = `Root cause: ${learning.title}`;
  const brief = `Automated root-cause task for a recurring failure pattern.\n\n## Learning\n${learning.title}\n\n${learning.body ?? ""}\n\nFind and fix the underlying cause so this stops recurring.`;
  db.query(
    `INSERT INTO tasks (id, project_id, title, brief, state, kind, created_at, updated_at)
     VALUES (?,?,?,?, 'queued', 'chore', ?, ?)`
  ).run(id, learning.project_id, title, brief, t, t);
  writeEvent(db, { task_id: id, source: "director", type: "created", payload: { title, learning_id: learning.id } });
  broadcast({ type: "task", task: getTask(db, id) });
  return id;
}

function updateLearning(db: DB, id: string, body: any): Response {
  const r: any = db.query("SELECT * FROM learnings WHERE id = ?").get(id);
  if (!r) return err("learning not found", 404);
  if (body.status && !["active", "resolved"].includes(body.status))
    return err("status must be 'active' or 'resolved'");
  const next = {
    title: body.title ?? r.title,
    body: body.body ?? r.body,
    status: body.status ?? r.status,
    root_cause_task_id: body.root_cause_task_id ?? r.root_cause_task_id,
  };
  db.query(
    "UPDATE learnings SET title = ?, body = ?, status = ?, root_cause_task_id = ? WHERE id = ?"
  ).run(next.title, next.body, next.status, next.root_cause_task_id, id);
  const updated = { ...r, ...next };
  broadcast({ type: "learning", learning: updated });
  return json(updated);
}

// Bump occurrences + last_seen: the same failure pattern happened again.
function recurLearning(db: DB, id: string): Response {
  const r: any = db.query("SELECT * FROM learnings WHERE id = ?").get(id);
  if (!r) return err("learning not found", 404);
  const last_seen = now();
  db.query(
    "UPDATE learnings SET occurrences = occurrences + 1, last_seen = ?, status = 'active' WHERE id = ?"
  ).run(last_seen, id);
  const updated = { ...r, occurrences: r.occurrences + 1, last_seen, status: "active" };
  broadcast({ type: "learning", learning: updated });
  return json(updated);
}

// ---------------------------------------------------------------- notifications
function listNotifications(db: DB, url: URL): Response {
  const since = url.searchParams.get("since");
  const rows = since
    ? db.query("SELECT * FROM notifications WHERE ts > ? ORDER BY ts DESC").all(since)
    : db.query("SELECT * FROM notifications ORDER BY ts DESC LIMIT 100").all();
  const unread = (db.query("SELECT COUNT(*) AS n FROM notifications WHERE delivered_at IS NULL").get() as { n: number }).n;
  return json({ notifications: rows, unread });
}

// ---------------------------------------------------------------- secrets (metadata only)
function listSecrets(db: DB, projectId: string): Response {
  if (!db.query("SELECT 1 FROM projects WHERE id = ?").get(projectId)) return err("project not found", 404);
  const rows = db
    .query("SELECT id, project_id, name, provider, created_at FROM secrets WHERE project_id = ? ORDER BY name")
    .all(projectId);
  return json({ secrets: rows });
}

function createSecret(db: DB, projectId: string, body: any): Response {
  if (!db.query("SELECT 1 FROM projects WHERE id = ?").get(projectId)) return err("project not found", 404);
  if (!body?.name) return err("name is required");
  if (!body?.ref) return err("ref is required");
  const provider = body.provider ?? "keychain";
  const row = {
    id: newId("sec"),
    project_id: projectId,
    name: String(body.name),
    provider: String(provider),
    ref: String(body.ref),
    created_at: now(),
  };
  db.query(
    "INSERT INTO secrets (id, project_id, name, provider, ref, created_at) VALUES (?,?,?,?,?,?) " +
      "ON CONFLICT(project_id, name) DO UPDATE SET provider = excluded.provider, ref = excluded.ref"
  ).run(row.id, row.project_id, row.name, row.provider, row.ref, row.created_at);
  // Return metadata only, never the ref value in a way tied to a secret value.
  return json({ id: row.id, project_id: projectId, name: row.name, provider: row.provider, created_at: row.created_at }, 201);
}

function deleteSecret(db: DB, projectId: string, name: string): Response {
  const r = db.query("DELETE FROM secrets WHERE project_id = ? AND name = ?").run(projectId, name);
  return json({ ok: true, deleted: r.changes });
}

async function safeJson(req: Request): Promise<any> {
  try {
    const text = await req.text();
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------- event ingestion (`hive emit`)
async function ingestEvent(db: DB, taskId: string, req: Request): Promise<Response> {
  if (!getTask(db, taskId)) return err("task not found", 404);
  const ct = req.headers.get("content-type") || "";
  let fields: Record<string, string> = {};
  let file: File | null = null;

  if (ct.includes("multipart/form-data")) {
    const form = await req.formData();
    for (const [k, v] of form.entries()) {
      if (v instanceof File) file = v;
      else fields[k] = String(v);
    }
  } else {
    fields = (await req.json()) as any;
  }

  const type = fields.type;
  if (!type) return err("event 'type' is required");
  const source = fields.source || "agent";
  const note = fields.note ?? null;

  // --- evidence ---
  if (type === "evidence") {
    const kind = fields.kind || (file ? "screenshot" : fields.url ? "link" : "log");
    let path: string | null = null;
    let servedUrl: string | null = fields.url ?? null;
    if (file) {
      const destDir = join(evidenceDir(), taskId);
      mkdirSync(destDir, { recursive: true });
      const safeName = file.name.replace(/[^\w.\-]/g, "_") || "file";
      const finalName = `${Date.now()}_${safeName}`;
      const dest = join(destDir, finalName);
      await Bun.write(dest, file);
      path = dest;
      servedUrl = `/evidence/${taskId}/${finalName}`;
    }
    const ev = {
      id: newId("ev"),
      task_id: taskId,
      ts: now(),
      kind,
      path,
      url: servedUrl,
      caption: fields.caption ?? note,
      meta: fields.meta ?? "{}",
    };
    db.query(
      "INSERT INTO evidence (id, task_id, ts, kind, path, url, caption, meta) VALUES (?,?,?,?,?,?,?,?)"
    ).run(ev.id, ev.task_id, ev.ts, ev.kind, ev.path, ev.url, ev.caption, ev.meta);
    const evidence = parseEvidence(ev);
    broadcast({ type: "evidence", evidence });
    const event = writeEvent(db, { task_id: taskId, source, type: "evidence", payload: { evidence_id: ev.id, kind, caption: ev.caption } });
    return json({ evidence, event }, 201);
  }

  // --- needs-decision (minimal card; full cards go via POST /api/decisions) ---
  if (type === "needs-decision") {
    const decision = createDecision(db, {
      task_id: taskId,
      title: fields.title || note || "Decision needed",
      context: fields.context ?? note,
      risk: fields.risk,
      blast_radius: fields.blast_radius,
      options: fields.options ? JSON.parse(fields.options) : [],
    });
    return json({ decision, task: getTask(db, taskId) }, 201);
  }

  // --- done ---
  if (type === "done") {
    const t = getTask(db, taskId);
    const blocked = authzBlock(db, { project_id: t.project_id, action: "task.done", target: t.title, task_id: taskId });
    if (blocked) return blocked;
    if (note) writeEvent(db, { task_id: taskId, source, type: "note", payload: { note } });
    if (note) db.query("UPDATE tasks SET summary = ? WHERE id = ?").run(note, taskId);
    const task = transition(db, taskId, "done", { source, reason: note ?? undefined });
    return json({ task });
  }

  // --- ready (agent handoff: PR open / report written → into the review queue) ---
  // The explicit, preferred counterpart to the reconciler's advanceFinished
  // backstop: an agent that has opened its PR (or written its scout report) emits
  // this to hand off for review instead of just going idle. Records a pr_url when
  // supplied and not already linked, then advances in_progress → in_review.
  if (type === "ready") {
    const t = getTask(db, taskId);
    const prUrl = (fields.pr_url ?? fields.url ?? null) as string | null;
    if (prUrl && !t.pr_url) {
      db.query("UPDATE tasks SET pr_url = ?, updated_at = ? WHERE id = ?").run(prUrl, now(), taskId);
      writeEvent(db, { task_id: taskId, source, type: "pr_linked", payload: { pr_url: prUrl, via: "ready" } });
    }
    if (note) writeEvent(db, { task_id: taskId, source, type: "note", payload: { note } });
    if (t.state === "in_progress") {
      writeEvent(db, { task_id: taskId, source, type: "ready_for_review", payload: { pr_url: prUrl ?? t.pr_url ?? null, via: "emit", kind: t.kind } });
      const task = transition(db, taskId, "in_review", { source, reason: note ?? "agent handoff: ready for review" });
      return json({ task });
    }
    // Already advanced (the reconciler beat the agent to it) or not in_progress:
    // ack idempotently rather than erroring on a duplicate handoff.
    return json({ task: getTask(db, taskId) });
  }

  // --- usage (cost/token analytics) ---
  if (type === "usage") return ingestUsage(db, taskId, fields, source);

  // --- transcript + lifecycle (from the Claude Code hooks) ---
  // assistant_text = the agent's actual output; tool_use = a one-line tool
  // summary; agent_turn_end = a quiet Stop/SubagentStop heartbeat. These carry a
  // structured `payload` object (JSON body) rather than a bare `note`.
  if (type === "assistant_text" || type === "tool_use" || type === "agent_turn_end") {
    let payload: Record<string, unknown> = {};
    if (fields.payload && typeof fields.payload === "object") payload = fields.payload;
    else if (typeof fields.payload === "string") {
      try { payload = JSON.parse(fields.payload); } catch { /* ignore */ }
    }
    const event = writeEvent(db, { task_id: taskId, source, type, payload });
    return json({ event }, 201);
  }

  // --- status / blocked / generic ---
  const event = writeEvent(db, { task_id: taskId, source, type, payload: { note } });
  return json({ event }, 201);
}

// Record one LLM-call usage row. Fields arrive as numbers (JSON) or strings
// (multipart), so coerce. cost_usd is computed server-side from the price table
// (+ per-project config.pricing override) when the caller doesn't supply it;
// an unpriced model stores cost_usd null and is surfaced as "unpriced".
function ingestUsage(db: DB, taskId: string, fields: Record<string, any>, source: string): Response {
  const model = String(fields.model ?? "").trim();
  if (!model) return err("usage 'model' is required");
  const int = (v: any) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  const tokens = {
    input_tokens: int(fields.input_tokens),
    output_tokens: int(fields.output_tokens),
    cache_read_tokens: int(fields.cache_read_tokens),
  };
  let cost: number | null;
  if (fields.cost_usd != null && fields.cost_usd !== "") {
    const c = Number(fields.cost_usd);
    cost = Number.isFinite(c) ? c : null;
  } else {
    const task = getTask(db, taskId);
    const project: any = db.query("SELECT config FROM projects WHERE id = ?").get(task.project_id);
    const overrides = project ? JSON.parse(project.config || "{}").pricing : null;
    cost = costUsd(model, tokens, overrides);
  }
  const row = {
    id: newId("use"),
    task_id: taskId,
    ts: now(),
    model,
    ...tokens,
    cost_usd: cost,
    source,
  };
  db.query(
    `INSERT INTO usage (id, task_id, ts, model, input_tokens, output_tokens, cache_read_tokens, cost_usd, source)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(row.id, row.task_id, row.ts, row.model, row.input_tokens, row.output_tokens, row.cache_read_tokens, row.cost_usd, row.source);
  broadcast({ type: "usage", usage: row });
  return json({ usage: row }, 201);
}

// ---------------------------------------------------------------- analytics (cost/token)
// Aggregate columns over the `usage` table. `p` is the column-qualifier prefix
// ("" for a plain scan, "u." when usage is joined as `u`).
function usageTotals(p = ""): string {
  return `
    COALESCE(SUM(${p}input_tokens),0) AS input_tokens,
    COALESCE(SUM(${p}output_tokens),0) AS output_tokens,
    COALESCE(SUM(${p}cache_read_tokens),0) AS cache_read_tokens,
    COALESCE(SUM(${p}input_tokens + ${p}output_tokens + ${p}cache_read_tokens),0) AS total_tokens,
    COALESCE(SUM(${p}cost_usd),0) AS cost_usd,
    COUNT(*) AS calls,
    COALESCE(SUM(CASE WHEN ${p}cost_usd IS NULL THEN 1 ELSE 0 END),0) AS unpriced`;
}

function analyticsSummary(db: DB, url: URL): Response {
  const since = url.searchParams.get("since");
  const w = since ? " WHERE ts >= ?" : "";
  const a = since ? [since] : [];
  const totals = db.query(`SELECT ${usageTotals()} FROM usage${w}`).get(...a);
  const by_model = db
    .query(`SELECT model, ${usageTotals()} FROM usage${w} GROUP BY model ORDER BY cost_usd DESC, total_tokens DESC`)
    .all(...a);
  // Per-project + top tasks join through tasks; qualify the ts filter on usage.
  const jw = since ? " WHERE u.ts >= ?" : "";
  const by_project = db
    .query(
      `SELECT t.project_id, p.name AS project_name, ${usageTotals("u.")}
       FROM usage u JOIN tasks t ON u.task_id = t.id JOIN projects p ON t.project_id = p.id${jw}
       GROUP BY t.project_id ORDER BY cost_usd DESC, total_tokens DESC`
    )
    .all(...a);
  const top_tasks = db
    .query(
      `SELECT u.task_id, t.title, t.project_id, ${usageTotals("u.")}
       FROM usage u JOIN tasks t ON u.task_id = t.id${jw}
       GROUP BY u.task_id ORDER BY cost_usd DESC, total_tokens DESC LIMIT 10`
    )
    .all(...a);
  return json({ since: since ?? null, totals, by_model, by_project, top_tasks });
}

function taskUsage(db: DB, taskId: string): Response {
  if (!getTask(db, taskId)) return err("task not found", 404);
  const usage = db.query("SELECT * FROM usage WHERE task_id = ? ORDER BY ts").all(taskId);
  const totals = db.query(`SELECT ${usageTotals()} FROM usage WHERE task_id = ?`).get(taskId);
  return json({ task_id: taskId, usage, totals });
}

function serveEvidence(pathname: string): Response {
  const rel = normalize(decodeURIComponent(pathname.slice("/evidence/".length)));
  if (rel.startsWith("..") || rel.includes("../")) return err("forbidden", 403);
  const filePath = join(evidenceDir(), rel);
  const f = Bun.file(filePath);
  return new Response(f); // Bun serves 404 automatically for missing files via .exists — handled below
}

// ---------------------------------------------------------------- decisions
// A decision with no options is un-answerable: nothing to click in the inbox
// and the answer endpoint has no key to validate. Agent/emit paths default to
// this two-option set rather than silently dropping the signal; the direct
// POST /api/decisions rejects (400) so a buggy client is told to fix its call.
const DEFAULT_OPTIONS = [
  { key: "proceed", label: "Proceed", recommended: true },
  { key: "dismiss", label: "Dismiss" },
];

export function createDecision(
  db: DB,
  d: { task_id: string; title: string; context?: string | null; risk?: string | null; blast_radius?: string | null; options?: any[] }
): any {
  if (!getTask(db, d.task_id)) throw new Error("unknown task_id");
  const options = Array.isArray(d.options) && d.options.length ? d.options : DEFAULT_OPTIONS;
  const row = {
    id: newId("dec"),
    task_id: d.task_id,
    ts: now(),
    title: d.title,
    context: d.context ?? null,
    risk: d.risk ?? null,
    blast_radius: d.blast_radius ?? null,
    options: JSON.stringify(options),
    status: "open",
    answer_key: null,
    answer_note: null,
    draft_note: null,
    answered_at: null,
  };
  db.query(
    `INSERT INTO decisions (id, task_id, ts, title, context, risk, blast_radius,
      options, status, answer_key, answer_note, draft_note, answered_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    row.id, row.task_id, row.ts, row.title, row.context, row.risk,
    row.blast_radius, row.options, row.status, row.answer_key, row.answer_note,
    row.draft_note, row.answered_at
  );
  const decision = parseDecision(row);
  writeEvent(db, { task_id: d.task_id, source: "agent", type: "needs-decision", payload: { decision_id: row.id, title: row.title } });
  // Move task into needs_decision if the current state allows it.
  const task = getTask(db, d.task_id);
  if (canTransition(task.state, "needs_decision")) {
    transition(db, d.task_id, "needs_decision", { source: "agent", reason: row.title });
  }
  broadcast({ type: "decision", decision });
  // Notify: a high-risk decision is urgent (immediate push); others batch.
  enqueue(db, {
    kind: "decision",
    task_id: d.task_id,
    decision_id: row.id,
    title: `Decision needed: ${row.title}`,
    body: row.blast_radius ?? row.context ?? undefined,
    urgency: (row.risk ?? "").toLowerCase() === "high" ? "urgent" : "normal",
  });
  return decision;
}

function apiCreateDecision(db: DB, body: any): Response {
  if (!body?.task_id) return err("task_id is required");
  if (!body?.title) return err("title is required");
  if (!Array.isArray(body?.options) || body.options.length === 0)
    return err("options must be a non-empty array", 400);
  const decision = createDecision(db, {
    task_id: body.task_id,
    title: body.title,
    context: body.context,
    risk: body.risk,
    blast_radius: body.blast_radius,
    options: body.options ?? [],
  });
  return json(decision, 201);
}

function listDecisions(db: DB, url: URL): Response {
  const status = url.searchParams.get("status") ?? "open";
  const rows =
    status === "all"
      ? db.query("SELECT * FROM decisions ORDER BY ts DESC").all()
      : db.query("SELECT * FROM decisions WHERE status = ? ORDER BY ts DESC").all(status);
  return json(rows.map(parseDecision));
}

// Autosave: overwrite draft_note only. Cheap, called on every keystroke (debounced).
function saveDraft(db: DB, id: string, body: any): Response {
  const r = db.query("SELECT 1 FROM decisions WHERE id = ?").get(id);
  if (!r) return err("decision not found", 404);
  db.query("UPDATE decisions SET draft_note = ? WHERE id = ?").run(body?.draft_note ?? "", id);
  return json({ ok: true, id });
}

function apiAnswerDecision(db: DB, id: string, body: any): Response {
  const r: any = db.query("SELECT * FROM decisions WHERE id = ?").get(id);
  if (!r) return err("decision not found", 404);
  if (r.status !== "open") return err(`decision already ${r.status}`, 409);
  const answerKey = body?.answer_key;
  if (!answerKey) return err("answer_key is required");
  const options: any[] = JSON.parse(r.options || "[]");
  if (options.length && !options.some((o) => o.key === answerKey))
    return err(`answer_key '${answerKey}' is not one of the options`, 400);

  const answeredAt = now();
  const answerNote = body?.answer_note ?? r.draft_note ?? null;
  db.query(
    "UPDATE decisions SET status = 'answered', answer_key = ?, answer_note = ?, answered_at = ? WHERE id = ?"
  ).run(answerKey, answerNote, answeredAt, id);

  writeEvent(db, {
    task_id: r.task_id,
    source: "director",
    type: "decision_answered",
    payload: { decision_id: id, answer_key: answerKey, answer_note: answerNote },
  });
  // If this card gated a standing-authority request, approve → mint the
  // single-use 24h grant so the agent's retry passes; deny → block it.
  resolveGrantForDecision(db, id, answerKey);
  // If this card was a planner breakdown proposal, approve → create the proposed
  // child tasks (source='planner', parent_task_id → source); reject → event only.
  resolvePlanForDecision(db, id, answerKey);
  // If this card was a stale-recovery escalation, `requeue` → fresh task.
  resolveRecoveryForDecision(db, id, answerKey);
  // If this card was a possible-duplicate card, `merge` → fold + cancel.
  resolveDuplicateForDecision(db, id, answerKey);
  // Resume the task if it was parked on this decision. (herdr `agent send` is Phase 2.)
  const task = getTask(db, r.task_id);
  if (task && task.state === "needs_decision")
    transition(db, r.task_id, "in_progress", { source: "director", reason: "decision answered" });

  const decision = parseDecision({ ...r, status: "answered", answer_key: answerKey, answer_note: answerNote, answered_at: answeredAt });
  broadcast({ type: "decision", decision });
  return json(decision);
}

// Dismiss: clear a card without answering it (human escape hatch for a card with
// no usable options, or one that's simply no longer relevant). Expires it and
// broadcasts so the inbox clears live. No resolver hooks fire — dismissing is
// explicitly "take no action".
function apiDismissDecision(db: DB, id: string): Response {
  const r: any = db.query("SELECT * FROM decisions WHERE id = ?").get(id);
  if (!r) return err("decision not found", 404);
  if (r.status !== "open") return err(`decision already ${r.status}`, 409);
  db.query("UPDATE decisions SET status = 'expired' WHERE id = ?").run(id);
  writeEvent(db, { task_id: r.task_id, source: "director", type: "decision_expired", payload: { decision_id: id, reason: "dismissed" } });
  const decision = parseDecision({ ...r, status: "expired" });
  broadcast({ type: "decision", decision });
  return json(decision);
}

// ---------------------------------------------------------------- authority (standing-authority engine)
// Agents call this BEFORE any externally-risky operation they run themselves
// (deploy, flag flip, destructive op). allow → 200; deny → 403; require_decision
// → 409 {decision_id} (open a card; the agent waits, then retries the same call).
function guardedAction(db: DB, taskId: string, body: any): Response {
  const task = getTask(db, taskId);
  if (!task) return err("task not found", 404);
  if (!body?.action) return err("action is required");
  if (!body?.target) return err("target is required");
  const r = authorize(db, {
    project_id: task.project_id,
    action: String(body.action),
    target: String(body.target),
    task_id: taskId,
    detail: body.detail ?? null,
  });
  if (r.effect === "allow") return json({ ok: true, effect: "allow" });
  if (r.effect === "deny") return json({ ok: false, effect: "deny", error: r.reason }, 403);
  return json({ ok: false, effect: "require_decision", decision_id: r.decision_id }, 409);
}

function authorityRow(r: any) {
  return { ...r, active: !!r.active };
}

function listAuthorityRules(db: DB, url: URL): Response {
  const projectId = url.searchParams.get("project_id");
  const rows = projectId
    ? db.query("SELECT * FROM authority_rules WHERE project_id = ? ORDER BY created_at").all(projectId)
    : db.query("SELECT * FROM authority_rules ORDER BY created_at").all();
  return json(rows.map(authorityRow));
}

function createAuthorityRule(db: DB, body: any): Response {
  if (!body?.action_pattern) return err("action_pattern is required");
  const effect = body.effect ?? "allow";
  if (!["allow", "require_decision", "deny"].includes(effect))
    return err("effect must be allow | require_decision | deny");
  const projectId = body.project_id ?? null;
  if (projectId && !db.query("SELECT 1 FROM projects WHERE id = ?").get(projectId))
    return err("unknown project_id", 400);
  const row = {
    id: newId("aur"),
    project_id: projectId,
    scope: projectId ? `project:${projectId}` : "global",
    action_pattern: String(body.action_pattern),
    effect,
    note: body.note ?? null,
    active: body.active === false ? 0 : 1,
    created_at: now(),
  };
  db.query(
    "INSERT INTO authority_rules (id, project_id, scope, action_pattern, effect, note, active, created_at) VALUES (?,?,?,?,?,?,?,?)"
  ).run(row.id, row.project_id, row.scope, row.action_pattern, row.effect, row.note, row.active, row.created_at);
  return json(authorityRow(row), 201);
}

function updateAuthorityRule(db: DB, id: string, body: any): Response {
  const r: any = db.query("SELECT * FROM authority_rules WHERE id = ?").get(id);
  if (!r) return err("authority rule not found", 404);
  if (body.effect && !["allow", "require_decision", "deny"].includes(body.effect))
    return err("effect must be allow | require_decision | deny");
  const next = {
    action_pattern: body.action_pattern ?? r.action_pattern,
    effect: body.effect ?? r.effect,
    note: body.note ?? r.note,
    active: body.active === undefined ? r.active : body.active ? 1 : 0,
  };
  db.query(
    "UPDATE authority_rules SET action_pattern = ?, effect = ?, note = ?, active = ? WHERE id = ?"
  ).run(next.action_pattern, next.effect, next.note, next.active, id);
  return json(authorityRow({ ...r, ...next }));
}

// ---------------------------------------------------------------- policies
function createPolicy(db: DB, body: any): Response {
  if (!body?.title) return err("title is required");
  if (!body?.body) return err("body is required");
  const scope = body.scope ?? "global";
  if (scope !== "global" && !/^project:.+/.test(scope))
    return err("scope must be 'global' or 'project:<id>'");
  const t = now();
  const row = {
    id: newId("pol"),
    scope,
    title: String(body.title),
    body: String(body.body),
    active: body.active === false ? 0 : 1,
    created_at: t,
    updated_at: t,
  };
  db.query(
    "INSERT INTO policies (id, scope, title, body, active, created_at, updated_at) VALUES (?,?,?,?,?,?,?)"
  ).run(row.id, row.scope, row.title, row.body, row.active, row.created_at, row.updated_at);
  return json(parsePolicy(row), 201);
}

function listPolicies(db: DB, url: URL): Response {
  const scope = url.searchParams.get("scope");
  const rows = scope
    ? db.query("SELECT * FROM policies WHERE scope = ? ORDER BY created_at").all(scope)
    : db.query("SELECT * FROM policies ORDER BY created_at").all();
  return json(rows.map(parsePolicy));
}

function updatePolicy(db: DB, id: string, body: any): Response {
  const r: any = db.query("SELECT * FROM policies WHERE id = ?").get(id);
  if (!r) return err("policy not found", 404);
  const next = {
    scope: body.scope ?? r.scope,
    title: body.title ?? r.title,
    body: body.body ?? r.body,
    active: body.active === undefined ? r.active : body.active ? 1 : 0,
  };
  db.query(
    "UPDATE policies SET scope = ?, title = ?, body = ?, active = ?, updated_at = ? WHERE id = ?"
  ).run(next.scope, next.title, next.body, next.active, now(), id);
  return json(parsePolicy({ ...r, ...next, updated_at: now() }));
}

// ---------------------------------------------------------------- SSE
function sseStream(): Response {
  let self: { id: string; send: (d: string) => void };
  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      self = {
        id: newId(),
        send: (data: string) => controller.enqueue(enc.encode(`data: ${data}\n\n`)),
      };
      addClient(self);
      // headline so clients know the stream is live
      controller.enqueue(enc.encode(`data: ${JSON.stringify({ type: "hello", version: VERSION })}\n\n`));
    },
    cancel() {
      if (self) removeClient(self);
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...CORS,
    },
  });
}

// ---------------------------------------------------------------- static web
async function serveWeb(pathname: string): Promise<Response> {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\//, "");
  const filePath = join(WEB_DIST, normalize(rel));
  if (!filePath.startsWith(WEB_DIST)) return err("forbidden", 403);
  const f = Bun.file(filePath);
  if (await f.exists()) return new Response(f);
  // SPA fallback to index.html if the build exists at all
  const index = Bun.file(join(WEB_DIST, "index.html"));
  if (await index.exists()) return new Response(index);
  return new Response("web app not built", {
    status: 404,
    headers: { "Content-Type": "text/plain", ...CORS },
  });
}
