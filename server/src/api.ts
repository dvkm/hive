// HTTP routing for hive. Plain Bun.serve routing by hand (zero deps).
// The exact request/response contract lives in docs/API.md.
import { dirname, join, normalize } from "node:path";
import { mkdirSync } from "node:fs";
import type { DB } from "./db.ts";
import { newId, now, evidenceDir } from "./db.ts";
import { addClient, removeClient, broadcast } from "./bus.ts";
import {
  transition,
  writeEvent,
  getTask,
  canTransition,
  TransitionError,
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
} from "./rows.ts";

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

const WEB_DIST = join(import.meta.dir, "..", "..", "web", "dist");

export function makeHandler(db: DB) {
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

      // ---- tasks ----
      if (pathname === "/api/tasks") {
        if (method === "GET") return listTasks(db, url);
        if (method === "POST") return createTask(db, await req.json());
      }
      m = pathname.match(/^\/api\/tasks\/([^/]+)$/);
      if (m && method === "GET") return getTaskFull(db, m[1]);

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
      if (m && method === "POST") return doTransition(db, m[1], await req.json());

      m = pathname.match(/^\/api\/tasks\/([^/]+)\/send$/);
      if (m && method === "POST") return sendSteer(db, m[1], await req.json());

      m = pathname.match(/^\/api\/tasks\/([^/]+)\/brief$/);
      if (m && method === "GET") {
        if (!getTask(db, m[1])) return err("task not found", 404);
        return json({ task_id: m[1], brief: composeBrief(db, m[1]) });
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
  broadcast({ type: "task", task: row });
  return json(parseTask(row), 201);
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
  return json(db.query(sql).all(...args).map(parseTask));
}

function getTaskFull(db: DB, id: string): Response {
  const task = getTask(db, id);
  if (!task) return err("task not found", 404);
  const events = db.query("SELECT * FROM events WHERE task_id = ? ORDER BY ts").all(id).map(parseEvent);
  const evidence = db.query("SELECT * FROM evidence WHERE task_id = ? ORDER BY ts").all(id).map(parseEvidence);
  const decisions = db.query("SELECT * FROM decisions WHERE task_id = ? ORDER BY ts").all(id).map(parseDecision);
  return json({ ...task, events, evidence, decisions });
}

function doTransition(db: DB, id: string, body: any): Response {
  if (!body?.to) return err("'to' state is required");
  const task = transition(db, id, body.to as State, {
    source: body.source ?? "director",
    reason: body.reason,
  });
  return json(task);
}

// Steering is a Phase 2 concern (herdr adapter). Stubbed: records an event only.
function sendSteer(db: DB, id: string, body: any): Response {
  if (!getTask(db, id)) return err("task not found", 404);
  const message = body?.message ?? "";
  writeEvent(db, { task_id: id, source: "director", type: "steer", payload: { message, stubbed: true } });
  return json({ ok: true, stubbed: true, message });
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
  // Resume the task if it was parked on this decision. (herdr `agent send` is Phase 2.)
  const task = getTask(db, r.task_id);
  if (task && task.state === "needs_decision")
    transition(db, r.task_id, "in_progress", { source: "director", reason: "decision answered" });

  const decision = parseDecision({ ...r, status: "answered", answer_key: answerKey, answer_note: answerNote, answered_at: answeredAt });
  broadcast({ type: "decision", decision });
  return json(decision);
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
