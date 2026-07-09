// HTTP routing for hive. Plain Bun.serve routing by hand (zero deps).
// The exact request/response contract lives in docs/API.md.
import { dirname, join, normalize } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import type { DB } from "./db.ts";
import { newId, now, evidenceDir } from "./db.ts";
import { taskWithHealth, broadcastTask } from "./health.ts";
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
import { resolveProjectSecrets } from "./secrets.ts";
import { runSmoke } from "./monitors.ts";
import { enqueue, ackNotifications } from "./notifications.ts";
import { authorize, resolveGrantForDecision, type AuthzInput } from "./authority.ts";
import { runPlanner, resolvePlanForDecision, type PlannerExec } from "./planner.ts";

export interface HandlerDeps {
  herdr?: Herdr; // injectable for tests
  supervise?: boolean; // start the herdr wait loop after spawn (true in prod wiring)
  plannerExec?: PlannerExec; // injectable planner subprocess (domain supervisors)
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
          const rows = db.query("SELECT * FROM projects ORDER BY created_at").all();
          return json(rows.map(parseProject));
        }
        if (method === "POST") return createProject(db, await req.json());
      }
      let m = pathname.match(/^\/api\/projects\/([^/]+)$/);
      if (m && method === "GET") {
        const r = db.query("SELECT * FROM projects WHERE id = ?").get(m[1]);
        return r ? json(parseProject(r)) : err("project not found", 404);
      }
      if (m && method === "PUT") return updateProject(db, m[1], await req.json());

      // ---- tasks ----
      if (pathname === "/api/tasks") {
        if (method === "GET") return listTasks(db, url);
        if (method === "POST") return createTask(db, await req.json());
      }
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

      m = pathname.match(/^\/api\/tasks\/([^/]+)\/brief$/);
      if (m && method === "GET") {
        if (!getTask(db, m[1])) return err("task not found", 404);
        return json({ task_id: m[1], brief: composeBrief(db, m[1]) });
      }
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
  broadcastTask(db, row);
  return json(taskWithHealth(db, parseTask(row)), 201);
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

function getTaskFull(db: DB, id: string): Response {
  const task = getTask(db, id);
  if (!task) return err("task not found", 404);
  const events = db.query("SELECT * FROM events WHERE task_id = ? ORDER BY ts").all(id).map(parseEvent);
  const evidence = db.query("SELECT * FROM evidence WHERE task_id = ? ORDER BY ts").all(id).map(parseEvidence);
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
      prepareWorktree: (worktreePath) => writeHookSettings(worktreePath, id, hiveUrl),
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

// Write hive's Claude Code hook wiring into a spawned worktree. Uses
// settings.local.json (the per-directory override, gitignored by Claude Code
// convention) so the agent reports Stop/SubagentStop/PostToolUse to hive
// without any agent discipline. HIVE_TASK_ID/HIVE_URL reach the hook via the
// agent's env (`herdr agent start --env`); the hook is a no-op without them.
function writeHookSettings(worktreePath: string, taskId: string, hiveUrl: string): void {
  const hook = join(HOOKS_DIR, "hive-hook.sh");
  const settings = {
    hooks: {
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

  // --- status / blocked / generic ---
  const event = writeEvent(db, { task_id: taskId, source, type, payload: { note } });
  return json({ event }, 201);
}

function serveEvidence(pathname: string): Response {
  const rel = normalize(decodeURIComponent(pathname.slice("/evidence/".length)));
  if (rel.startsWith("..") || rel.includes("../")) return err("forbidden", 403);
  const filePath = join(evidenceDir(), rel);
  const f = Bun.file(filePath);
  return new Response(f); // Bun serves 404 automatically for missing files via .exists — handled below
}

// ---------------------------------------------------------------- decisions
export function createDecision(
  db: DB,
  d: { task_id: string; title: string; context?: string | null; risk?: string | null; blast_radius?: string | null; options?: any[] }
): any {
  if (!getTask(db, d.task_id)) throw new Error("unknown task_id");
  const row = {
    id: newId("dec"),
    task_id: d.task_id,
    ts: now(),
    title: d.title,
    context: d.context ?? null,
    risk: d.risk ?? null,
    blast_radius: d.blast_radius ?? null,
    options: JSON.stringify(d.options ?? []),
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
  // Resume the task if it was parked on this decision. (herdr `agent send` is Phase 2.)
  const task = getTask(db, r.task_id);
  if (task && task.state === "needs_decision")
    transition(db, r.task_id, "in_progress", { source: "director", reason: "decision answered" });

  const decision = parseDecision({ ...r, status: "answered", answer_key: answerKey, answer_note: answerNote, answered_at: answeredAt });
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
