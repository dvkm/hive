// HTTP routing for hive. Plain Bun.serve routing by hand (zero deps).
// The exact request/response contract lives in docs/API.md.
import { dirname, join, normalize } from "node:path";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import type { DB } from "./db.ts";
import { newId, now, evidenceDir, isOffline, setSetting, getSetting } from "./db.ts";
import { taskWithHealth, broadcastTask, needsAttention } from "./health.ts";
import { addClient, removeClient, broadcast } from "./bus.ts";
import {
  transition,
  writeEvent,
  getTask,
  canTransition,
  TransitionError,
  TERMINAL,
  advanceIfFinished,
  evidenceCount,
  evidenceAtSha,
  changesRequestUnaddressed,
  isDeferred,
  deferTask,
  undeferTask,
  type State,
} from "./state.ts";
import { composeBrief } from "./briefs.ts";
import { recordSystemLearning, recordDecisionKnowledge, signature, resolveRefCaptureForDecision, addReference, listReferences } from "./learn.ts";
import {
  parseProject,
  parseTask,
  parseEvent,
  parseEvidence,
  parseDecision,
  parsePolicy,
  parseIncident,
} from "./rows.ts";
import { Herdr, herdr as defaultHerdr, sendFailure } from "./runtime/herdr.ts";
import { queuedSteers, markSteersDelivered, steerPreamble, queueSteerEvent, type Delivery } from "./steer.ts";
import { cleanupTask, runStackCmd } from "./cleanup.ts";
import { resolveProjectSecrets } from "./secrets.ts";
import { smokeThenAdvance } from "./monitors.ts";
import { enqueue, ackNotifications } from "./notifications.ts";
import { authorize, resolveGrantForDecision, resolveDenyGuardrailForDecision, type AuthzInput } from "./authority.ts";
import { isReviewed } from "./dispatcher.ts";
import { runPlanner, resolvePlanForDecision, type PlannerExec } from "./planner.ts";
import { routeIntakeProject } from "./intake/route.ts";
import { detectDuplicate, mergeInto, openDuplicateDecision, resolveDuplicateForDecision, duplicateClusters } from "./dedup.ts";
import { costUsd } from "./pricing.ts";
import { checkCostGuardrails, resolveCostCapForDecision, taskSpend } from "./costs.ts";
import { evaluateAutoApprove } from "./autoapprove.ts";
import { vapidPublicKey, saveSubscription, removeSubscription } from "./push.ts";
import { explainCommandDecision } from "./explain.ts";
import { ciStatusOf } from "./reconciler.ts";
import { taskDiff } from "./diff.ts";
import { detectDestructiveRebase, type BranchScope } from "./rebaseGuard.ts";
import type { Exec } from "./exec.ts";
import { defaultExec } from "./exec.ts";
import { taskIdFromBody, taskNumberFromTitle } from "./marker.ts";
import {
  createThread,
  getThread,
  listThreads,
  listMessages,
  appendMessage,
  setThreadTask,
  composeSupervisorBrief,
  type ChatThread,
} from "./chat.ts";

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

// Background-loop liveness for /api/health (incident 2026-07-17: the
// dispatcher stopped ticking for 3.5h with zero outward signal). Threshold is
// 3 missed cycles, floored at 5min so a loop's own interval never makes it
// flap stale right before its next tick.
const STALE_FLOOR_MS = 5 * 60 * 1000;
const DISPATCH_STALE_MS = Math.max(STALE_FLOOR_MS, Number(process.env.HIVE_DISPATCH_MS || 30_000) * 3);
const REAP_STALE_MS = Math.max(STALE_FLOOR_MS, Number(process.env.HIVE_REAP_MS || 300_000) * 3);
function loopLiveness(db: DB, settingKey: string, staleMs: number): { last_run: string | null; stale: boolean } {
  const lastRun = getSetting(db, settingKey);
  const ageMs = lastRun ? Date.now() - Date.parse(lastRun) : null;
  return { last_run: lastRun, stale: ageMs === null || ageMs > staleMs };
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

// Remote requests (a phone on the LAN / Tailscale) must present the API token;
// loopback (CLI, hooks, agents, the desktop app) stays trustless as before.
// Accepted as `Authorization: Bearer <t>` or `?token=<t>` — EventSource cannot
// set headers, so the SSE stream needs the query form. Exported for tests.
export function remoteAuthOk(db: DB, req: Request, url: URL, ip: string | null): boolean {
  if (!ip || ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1") return true;
  const token = getSetting(db, "api_token");
  if (!token) return false; // bound to LAN with no token minted → locked
  const presented =
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() || url.searchParams.get("token");
  return presented === token;
}

export function makeHandler(db: DB, deps: HandlerDeps = {}) {
  const herdr = deps.herdr ?? defaultHerdr;
  return async function handle(req: Request, server?: { requestIP?: (r: Request) => { address: string } | null }): Promise<Response> {
    const url = new URL(req.url);
    const { pathname } = url;
    const method = req.method;

    if (method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    if (pathname.startsWith("/api/")) {
      const ip = server?.requestIP?.(req)?.address ?? null;
      if (!remoteAuthOk(db, req, url, ip)) return err("unauthorized (see `hive remote` for the token)", 401);
    }

    try {
      // ---- SSE stream ----
      if (pathname === "/api/stream" && method === "GET") return sseStream();

      // ---- health ----
      if (pathname === "/api/health" && method === "GET")
        return json({ ok: true, version: VERSION, dispatcher: loopLiveness(db, "last_dispatch_at", DISPATCH_STALE_MS), reaper: loopLiveness(db, "last_reap_at", REAP_STALE_MS) });

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

      // ---- director chat (persistent supervisor session over hive) ----
      if (pathname === "/api/chat/turn" && method === "POST")
        return await chatTurn(db, herdr, deps, await req.json());
      if (pathname === "/api/chat/threads" && method === "GET")
        return json(listThreads(db, url.searchParams.get("project_id")));
      {
        const m = pathname.match(/^\/api\/chat\/threads\/([^/]+)\/reply$/);
        if (m && method === "POST") return chatReply(db, m[1], await req.json());
      }
      {
        const m = pathname.match(/^\/api\/chat\/threads\/([^/]+)\/close$/);
        if (m && method === "POST") return chatClose(db, m[1]);
      }
      {
        const m = pathname.match(/^\/api\/chat\/threads\/([^/]+)$/);
        if (m && method === "GET") {
          const thread = getThread(db, m[1]);
          if (!thread) return err("thread not found", 404);
          return json({ ...thread, messages: listMessages(db, m[1]) });
        }
      }

      // ---- PR → task linking (match an open PR back to its task by marker) ----
      if (pathname === "/api/tasks/link-pr" && method === "POST")
        return await linkPrEndpoint(db, await req.json(), deps);

      // ---- tasks ----
      if (pathname === "/api/tasks") {
        if (method === "GET") return listTasks(db, url);
        if (method === "POST") return await createTask(db, req);
      }
      // Duplicate CLUSTERS among current non-terminal tasks (backfill/UI). Must
      // precede the /:id route so "duplicates" isn't parsed as a task id.
      if (pathname === "/api/tasks/duplicates" && method === "GET")
        return json({ clusters: duplicateClusters(db) });
      m = pathname.match(/^\/api\/tasks\/([^/]+)\/merge-into$/);
      if (m && method === "POST") return mergeIntoEndpoint(db, m[1], await req.json());
      m = pathname.match(/^\/api\/tasks\/([^/]+)$/);
      if (m && method === "GET") return getTaskFull(db, m[1]);
      if (m && method === "PUT") return await updateTask(db, m[1], req);

      m = pathname.match(/^\/api\/tasks\/([^/]+)\/events$/);
      if (m) {
        if (method === "GET") {
          const rows = db
            .query("SELECT * FROM events WHERE task_id = ? ORDER BY ts")
            .all(m[1]);
          return json(rows.map(parseEvent));
        }
        if (method === "POST") return await ingestEvent(db, m[1], req, deps);
      }
      m = pathname.match(/^\/api\/tasks\/([^/]+)\/transition$/);
      if (m && method === "POST") return await doTransition(db, m[1], await req.json());

      m = pathname.match(/^\/api\/tasks\/([^/]+)\/spawn$/);
      if (m && method === "POST")
        return await spawnTask(db, herdr, m[1], await safeJson(req), deps);

      m = pathname.match(/^\/api\/tasks\/([^/]+)\/send$/);
      if (m && method === "POST") return await sendSteer(db, herdr, m[1], req);

      if (pathname === "/api/steer/broadcast" && method === "POST")
        return await broadcastSteer(db, herdr, await req.json());

      // Web push (mobile PWA). The public VAPID key is not a secret.
      if (pathname === "/api/push/vapid" && method === "GET")
        return json({ key: vapidPublicKey(db) });
      if (pathname === "/api/push/subscribe" && method === "POST") {
        try {
          saveSubscription(db, await req.json());
          return json({ ok: true });
        } catch (e: any) {
          return err(String(e?.message ?? e), 400);
        }
      }
      if (pathname === "/api/push/unsubscribe" && method === "POST") {
        const b: any = await safeJson(req);
        if (b?.endpoint) removeSubscription(db, b.endpoint);
        return json({ ok: true });
      }

      if (pathname === "/api/checkpoints" && method === "GET") return listOpenCheckpoints(db);

      if (pathname === "/api/offline" && method === "GET")
        return json({ on: isOffline(db) });
      if (pathname === "/api/offline" && method === "POST")
        return await setOffline(db, herdr, await req.json());
      m = pathname.match(/^\/api\/tasks\/([^/]+)\/checkpoints\/([^/]+)\/ack$/);
      if (m && method === "POST") return await ackCheckpoint(db, herdr, m[1], m[2], await req.json());

      m = pathname.match(/^\/api\/tasks\/([^/]+)\/focus-agent$/);
      if (m && method === "POST") return await focusAgent(db, herdr, m[1]);

      m = pathname.match(/^\/api\/tasks\/([^/]+)\/requeue$/);
      if (m && method === "POST") return requeueEndpoint(db, m[1]);

      m = pathname.match(/^\/api\/tasks\/([^/]+)\/cleanup$/);
      if (m && method === "POST") return await cleanupEndpoint(db, herdr, m[1]);

      m = pathname.match(/^\/api\/tasks\/([^/]+)\/usage$/);
      if (m && method === "GET") return taskUsage(db, m[1]);

      // Live read-only view of the agent's terminal pane (the web UI's
      // embedded terminal polls this). Input goes through steer as always.
      m = pathname.match(/^\/api\/tasks\/([^/]+)\/pane$/);
      if (m && method === "GET") return await taskPane(db, herdr, m[1], url);

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
        return r ? json(withBundle(db, parseDecision(r))) : err("decision not found", 404);
      }
      m = pathname.match(/^\/api\/decisions\/([^/]+)\/draft$/);
      if (m && method === "PUT") return saveDraft(db, m[1], await req.json());

      m = pathname.match(/^\/api\/decisions\/([^/]+)\/answer$/);
      if (m && method === "POST") return apiAnswerDecision(db, herdr, m[1], await req.json());
      m = pathname.match(/^\/api\/decisions\/([^/]+)\/auto-answer$/);
      if (m && method === "POST") return apiAutoAnswerDecision(db, herdr, m[1], await req.json());
      m = pathname.match(/^\/api\/decisions\/([^/]+)\/dismiss$/);
      if (m && method === "POST") return apiDismissDecision(db, m[1]);

      // ---- policies ----
      if (pathname === "/api/policies") {
        if (method === "GET") return listPolicies(db, url);
        if (method === "POST") return createPolicy(db, herdr, await req.json());
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
      // Knowledge search: agents recall project references/learnings/policies on
      // demand instead of carrying the whole store in every brief.
      if (pathname === "/api/knowledge" && method === "GET") return knowledgeSearch(db, url);
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

  // The caller's project_id is a DEFAULT, not gospel — the web picker defaults to
  // whatever project is in view. Classify the text against every project's
  // identifying signals and re-route when a different one clearly matches, so a
  // acme braindump lands in the acme repo and not wherever the UI sat.
  const route = routeIntakeProject(db, text, body.project_id);
  const projectId = route.project_id;

  const id = newId();
  const t = now();
  // Short enough that "Proposed breakdown: <title>" stays readable on a card.
  const head = text.split("\n")[0];
  const title = `[braindump] ${head.length > 72 ? head.slice(0, 71) + "…" : head}`;
  db.query(
    `INSERT INTO tasks (id, project_id, title, brief, state, kind, source, created_at, updated_at)
     VALUES (?,?,?,?, 'queued', 'chore', 'intake_braindump', ?, ?)`
  ).run(id, projectId, title, text, t, t);
  writeEvent(db, { task_id: id, source: "director", type: "created", payload: { title } });
  if (route.rerouted) {
    const from: any = db.query("SELECT name FROM projects WHERE id = ?").get(body.project_id);
    const to: any = db.query("SELECT name FROM projects WHERE id = ?").get(projectId);
    writeEvent(db, {
      task_id: id,
      source: "system",
      type: "note",
      payload: { note: `Intake auto-routed from ${from?.name ?? body.project_id} to ${to?.name ?? projectId} (matched: ${route.matched.join(", ")}).` },
    });
  }
  const task = getTask(db, id);
  broadcastTask(db, task);

  // The planner is a `claude -p` subprocess that runs for tens of seconds, so it
  // must not hold the request open — the decision card arrives over SSE when it
  // lands, and runPlanner records its own planner_error event on failure.
  runPlanner(db, id, { exec: deps.plannerExec }).catch(() => {});
  return json({ ok: true, task }, 202);
}

// ---------------------------------------------------------------- chat
// One director→supervisor turn. NON-BLOCKING by design: persist the message,
// make sure the thread's persistent supervisor session is live (spawn it on the
// first message), deliver the message into that session, and return immediately.
// The supervisor thinks/acts asynchronously and posts its reply back via
// `hive chat reply <thread>` → POST /reply → SSE, so the director is never
// blocked waiting on the LLM. The session holds context across turns and
// coordinates worker agents itself (see composeSupervisorBrief).
async function chatTurn(db: DB, herdr: Herdr, deps: HandlerDeps, body: any): Promise<Response> {
  const text = String(body?.text ?? "").trim();
  if (!text) return err("text is required");

  if (body?.thread_id) {
    const thread = getThread(db, String(body.thread_id));
    if (!thread) return err("thread not found", 404);
    if (!thread.project_id) return err("thread has no project scope; cannot run a supervisor session", 400);
    return json(await chatTurnOnThread(db, herdr, deps, thread, text), 202);
  }

  const projectId = body?.project_id ? String(body.project_id) : null;
  if (!projectId) return err("project_id is required to start a chat (the supervisor session runs in the project's repo)");
  if (!db.query("SELECT 1 FROM projects WHERE id = ?").get(projectId)) return err("unknown project_id", 400);

  // A brand-new chat has no thread_id yet, so two concurrent first-messages
  // (a UI double-submit before the client gets a thread_id back) each used to
  // call createThread independently, producing two threads/tasks/spawns for
  // what the user experienced as one message. Dedupe on (project, text): a
  // genuine double-submit repeats the exact text within the same tick, so the
  // second request rides the first's in-flight thread-creation + delivery
  // instead of racing its own.
  const dedupeKey = `${projectId} ${text}`;
  let pending = pendingNewChats.get(dedupeKey);
  if (!pending) {
    pending = (async () => {
      const thread = createThread(db, {
        project_id: projectId,
        title: text.split("\n")[0].slice(0, 80),
      });
      return chatTurnOnThread(db, herdr, deps, thread, text);
    })();
    pendingNewChats.set(dedupeKey, pending);
    pending.finally(() => pendingNewChats.delete(dedupeKey)).catch(() => {});
  }
  return json(await pending, 202);
}

const pendingNewChats = new Map<string, Promise<{ thread_id: string; delivery: string; agent_target?: string; error?: string }>>();

async function chatTurnOnThread(
  db: DB,
  herdr: Herdr,
  deps: HandlerDeps,
  thread: ChatThread,
  text: string
): Promise<{ thread_id: string; delivery: string; agent_target?: string; error?: string }> {
  broadcast({ type: "chat_message", message: appendMessage(db, thread.id, "director", text) });

  // The message the session receives is prefixed so it always knows which thread
  // to reply to, even mid-conversation.
  const wire = `[director → chat thread ${thread.id}]\n${text}`;
  const delivery = await withThreadLock(thread.id, () => deliverToSupervisor(db, herdr, deps, thread.id, wire));
  return { thread_id: thread.id, ...delivery };
}

// Serializes concurrent turns on the same chat thread. Without this, two
// /api/chat/turn requests arriving before the first spawn lands (an impatient
// double-send, or a second message sent right after the UI receives
// thread_id) both see agent_target===null and both call spawnAgent for the
// same taskId, racing worktree create/reclaim and starting two claude
// sessions. A waiter runs only after the winner's spawn has landed, so it
// re-reads fresh state and takes the fast (deliver-into-live-session) path
// instead of racing it. One process holds the whole thread's traffic, so a
// promise-chain per thread id is enough — no cross-process lock needed.
const threadLocks = new Map<string, Promise<unknown>>();

function withThreadLock<T>(threadId: string, fn: () => Promise<T>): Promise<T> {
  const next = (threadLocks.get(threadId) ?? Promise.resolve()).catch(() => {}).then(fn);
  threadLocks.set(threadId, next);
  return next;
}

// Ensure the thread's supervisor agent is live (spawn on first use / respawn if
// it died), then deliver the director's message into it. A message that arrives
// before the session is live is queued as a steer and rides along in the spawn
// brief, so nothing is dropped. Returns a small delivery receipt. Must run
// under withThreadLock (re-reads the thread/task fresh, so a serialized
// waiter observes whatever the prior turn on this thread just did).
async function deliverToSupervisor(
  db: DB,
  herdr: Herdr,
  deps: HandlerDeps,
  threadId: string,
  message: string
): Promise<{ delivery: string; agent_target?: string; error?: string }> {
  const thread = getThread(db, threadId)!;

  // Reuse (or create) the backing supervisor task — a plain chore task whose
  // agent IS the session. source='chat_supervisor' keeps it out of the
  // dispatcher and the normal board lanes; it is infrastructure, not a deliverable.
  let taskId = thread.task_id;
  let task = taskId ? getTask(db, taskId) : null;
  // A closed (terminal — see chatClose) supervisor task is never resurrected;
  // a message to a closed thread starts a fresh session, same thread.
  if (!task || TERMINAL.includes(task.state as State)) {
    taskId = newId();
    const t = now();
    db.query(
      `INSERT INTO tasks (id, project_id, title, brief, state, kind, source, created_at, updated_at)
       VALUES (?,?,?,?, 'in_progress', 'chore', 'chat_supervisor', ?, ?)`
    ).run(taskId, thread.project_id, `[chat] supervisor: ${thread.title ?? thread.id}`, null, t, t);
    writeEvent(db, { task_id: taskId, source: "director", type: "created", payload: { title: `[chat] supervisor session`, thread_id: thread.id } });
    setThreadTask(db, thread.id, taskId);
    task = getTask(db, taskId);
  }

  // Is the session already live? If so, just send into it (fast path).
  if (task.agent_target) {
    const { alive } = await herdr.probe(task.agent_target).catch(() => ({ alive: false }));
    if (alive) {
      const error = await sendOnce(herdr, task.agent_target, message);
      if (!error) {
        writeEvent(db, { task_id: taskId!, source: "director", type: "steer", payload: { message, target: task.agent_target, delivery: "delivered", delivered_at: now() } });
        return { delivery: "delivered", agent_target: task.agent_target };
      }
      // fall through to respawn on a send failure to a supposedly-live agent
    }
  }

  // Not live: queue the message (it rides in the spawn brief) and spawn.
  queueSteerEvent(db, taskId!, message, "queued for chat supervisor spawn");
  const r = await spawnAgent(db, herdr, taskId!, {
    supervise: false, // a standing session never "finishes into review"
    briefOverride: composeSupervisorBrief(db, thread),
  });
  if (!r.ok) return { delivery: "failed", error: r.error };
  return { delivery: "spawned", agent_target: r.agent_target };
}

// The supervisor session posts its reply to the director here (via
// `hive chat reply <thread> "..."`). Loopback-only in practice (agents run on
// localhost); appends the assistant message and streams it over SSE.
function chatReply(db: DB, threadId: string, body: any): Response {
  const thread = getThread(db, threadId);
  if (!thread) return err("thread not found", 404);
  const text = String(body?.text ?? "").trim();
  if (!text) return err("text is required");
  const message = appendMessage(db, threadId, "assistant", text);
  broadcast({ type: "chat_message", message });
  return json({ ok: true, message });
}

// End a thread's live supervisor session: cancel its backing task, which fires
// the terminal hook (state.setTerminalHook -> cleanupTask) and tears down the
// worktree/session immediately — the reaper sweep is just the backstop for any
// miss. Without this, a chat's supervisor task stays 'in_progress' forever
// (supervise:false, dispatcher/reaper skip non-terminal tasks by design) and
// permanently pins its worktree/session. Idempotent: closing an already-closed
// or task-less thread is a no-op. The thread + its message history survive —
// only the live session ends; a later message spawns a fresh one (see
// deliverToSupervisor).
function chatClose(db: DB, threadId: string): Response {
  const thread = getThread(db, threadId);
  if (!thread) return err("thread not found", 404);
  const task = thread.task_id ? getTask(db, thread.task_id) : null;
  if (task && !TERMINAL.includes(task.state as State)) {
    transition(db, task.id, "cancelled", { source: "director", reason: "chat thread closed" });
  }
  return json({ ok: true, thread_id: threadId });
}

// ---------------------------------------------------------------- tasks
// Accepts JSON or multipart; attached files are saved under the new task's id
// and their absolute paths appended to the brief, so the agent that picks the
// task up can read them.
async function createTask(db: DB, req: Request): Promise<Response> {
  const { fields: body, files } = await bodyWithFiles(req);
  if (!body?.project_id) return err("project_id is required");
  if (!body?.title) return err("title is required");
  if (!db.query("SELECT 1 FROM projects WHERE id = ?").get(body.project_id))
    return err("unknown project_id", 400);
  const kind = body.kind ?? "ship";
  if (!["ship", "scout", "chore"].includes(kind)) return err("invalid kind");
  // Agents may create follow-up tasks (source="agent", parent_task_id → the
  // spawning task); the dispatcher treats them like director-created tasks.
  const parent = body.parent_task_id ? String(body.parent_task_id) : null;
  if (parent && !db.query("SELECT 1 FROM tasks WHERE id = ?").get(parent))
    return err("unknown parent_task_id", 400);
  // depends_on: task ids this task waits on (array, or comma-separated string
  // from the CLI). Validated here so a typo can't block a task forever.
  const rawDeps = Array.isArray(body.depends_on)
    ? body.depends_on
    : body.depends_on
      ? String(body.depends_on).split(",")
      : [];
  const deps = rawDeps.map((d: any) => String(d).trim()).filter(Boolean);
  for (const d of deps) {
    if (!db.query("SELECT 1 FROM tasks WHERE id = ?").get(d)) return err(`unknown depends_on task: ${d}`, 400);
  }
  const t = now();
  // Id first: attachments are stored under it, and the brief they extend is
  // written in the INSERT below (and read by duplicate detection).
  const id = newId();
  const { block } = await attachFiles(id, files);
  const brief = ((body.brief ?? "") + block).trim();
  const row = {
    id,
    project_id: body.project_id,
    title: String(body.title),
    brief: brief || null,
    state: "queued",
    kind,
    agent_target: body.agent_target ?? null,
    worktree_path: null,
    branch: null,
    pr_url: null,
    ci_status: null,
    summary: null,
    source: body.source ? String(body.source) : null,
    parent_task_id: parent,
    depends_on: deps.length ? JSON.stringify(deps) : null,
    created_at: t,
    updated_at: t,
  };
  db.query(
    `INSERT INTO tasks (id, project_id, title, brief, state, kind, agent_target,
      worktree_path, branch, pr_url, ci_status, summary, source, parent_task_id, depends_on, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    row.id, row.project_id, row.title, row.brief, row.state, row.kind,
    row.agent_target, row.worktree_path, row.branch, row.pr_url, row.ci_status,
    row.summary, row.source, row.parent_task_id, row.depends_on, row.created_at, row.updated_at
  );
  writeEvent(db, {
    task_id: row.id,
    source: row.source === "agent" ? "agent" : "director",
    type: "created",
    payload: { title: row.title, ...(parent ? { parent_task_id: parent } : {}) },
  });
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
//
// Opening the PR is what hands the task to the director: an in-progress task
// moves to `in_review`, which is the ONLY state POST /merge accepts and the only
// one the Review lane renders. Without this the Approve & merge button is
// unreachable. The reconciler re-checks open PRs as a time-based fallback.
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
  handOffToReview(db, task.id, source);
  broadcastTask(db, getTask(db, task.id));
  return { task_id: task.id, number: task.number, linked: true };
}

// in_progress → in_review, the hand-off that puts a task in the director's
// Review lane with an Approve & merge button. No-op from any other state
// (queued/needs_decision/terminal), so it is safe to call repeatedly.
export function handOffToReview(db: DB, taskId: string, source: string): boolean {
  const t: any = getTask(db, taskId);
  if (!t || t.state !== "in_progress") return false;
  // #234: the reconciler's CI-green poll used to re-queue a task the director
  // JUST sent back (changes_requested) 33s later, before any new commit — CI was
  // still green on the old head. The shared guard blocks re-queue until new work
  // (a pushed commit / evidence / review_summary) lands after the request.
  if (changesRequestUnaddressed(db, taskId)) return false;
  transition(db, taskId, "in_review", { source, reason: "PR open, awaiting review" });
  return true;
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
// Accepts JSON or multipart; attached files are appended to the brief the same
// way task creation does.
async function updateTask(db: DB, id: string, req: Request): Promise<Response> {
  const task = getTask(db, id);
  if (!task) return err("task not found", 404);
  const { fields: body, files } = await bodyWithFiles(req);
  const title = body?.title != null ? String(body.title) : task.title;
  const { block } = await attachFiles(id, files);
  // `base` stays null when the caller sent no brief and the task had none, so a
  // title-only PUT does not turn a NULL brief into "".
  const base = body?.brief != null ? String(body.brief) : task.brief;
  const brief = block ? (base ?? "") + block : base;
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
  decision: ["needs-decision", "decision_answered", "planned", "authority_required", "authority_granted", "auto_approved", "auto_approve_declined"],
  evidence: ["evidence", "smoke_passed"],
  incident: ["blocked", "stale", "spawn_error", "smoke_failed", "steer_error", "planner_error", "supervise_error", "authority_denied", "merge_failed"],
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
    .map((r) => withBundle(db, parseDecision(r)));

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
  const decisions = db.query("SELECT * FROM decisions WHERE task_id = ? ORDER BY ts").all(id).map((r) => withBundle(db, parseDecision(r)));
  return json({ ...taskWithHealth(db, task), events, evidence, decisions });
}

async function doTransition(db: DB, id: string, body: any): Promise<Response> {
  if (!body?.to) return err("'to' state is required");
  const to = body.to as State;
  // High-blast-radius transitions (post-merge verify, marking done) are gated.
  if (to === "verifying" || to === "done") {
    const t = getTask(db, id);
    if (t) {
      // A task with a PR must go through POST /merge — a plain move to verifying
      // skips the actual merge, and the smoke monitor then stamps the task done
      // with the PR still open (seen live 2026-07-18: task 2ae573b0a229 / PR #281).
      // /merge handles every PR state: open → merges, MERGED → advances, CLOSED →
      // merge_failed with re-link guidance. mergeTask calls transition() directly,
      // so the sanctioned path is unaffected.
      if (to === "verifying" && t.state === "in_review" && t.pr_url)
        return err(
          `task has a PR (${t.pr_url}); use POST /api/tasks/${id}/merge so the PR actually merges — a direct move to 'verifying' skips the merge`,
          409
        );
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
    await smokeThenAdvance(db, id).catch((e) => console.error("[hive] smoke run failed:", e));
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

// A merge failure whose reason looks like a conflict / diverged branch is the
// agent's to fix, not the captain's: bounce the task back to in_progress with
// rebase instructions (best-effort send, like request-changes — the event
// records everything for a respawned agent). Other failures (CI blocked, auth,
// gh missing) keep the task in_review and just report the reason.
const MERGE_CONFLICT_RE = /conflict|not mergeable|not an ancestor|fast-forward/i;
async function mergeFailed(db: DB, herdr: Herdr, task: any, base: string, reason: string): Promise<Response> {
  const conflict = MERGE_CONFLICT_RE.test(reason);
  let delivered = false;
  let sendError: string | null = null;
  if (conflict && task.agent_target) {
    try {
      const res = await herdr.send(
        task.agent_target,
        `hive: merge into '${base}' failed — ${reason}\nRebase your branch '${task.branch}' onto the latest '${base}', resolve the conflicts, rerun the tests, then push.`
      );
      sendError = sendFailure(res);
      delivered = sendError === null;
    } catch (e: any) {
      sendError = String(e?.message ?? e);
    }
  }
  writeEvent(db, {
    task_id: task.id,
    source: "director",
    type: "merge_failed",
    payload: { reason, conflict, delivered, ...(sendError ? { send_error: sendError } : {}) },
  });
  recordSystemLearning(db, task.project_id, `merge failure: ${signature(reason)}`, reason, task.id);
  if (conflict) {
    transition(db, task.id, "in_progress", { source: "director", reason: "merge conflict — agent asked to rebase" });
    return err(`merge conflict — task sent back to the agent to rebase onto '${base}' (${reason})`, 409);
  }
  return err(reason, 409);
}

// Fast-forward the project's default branch to the task branch tip, in the
// primary checkout. Requires the checkout to be ON `base` (git merge --ff-only
// lands on whatever HEAD is, not on the named ref) and `base` (the LOCAL ref,
// which can be ahead of origin/<base>) to be an ancestor of `task.branch` — a
// diverged/conflicting branch is refused, no working tree is touched. Returns
// null on success, or a failure reason string.
async function attemptLocalFf(exec: Exec, project: any, task: any, base: string): Promise<string | null> {
  const head = await exec(["git", "-C", project.repo_path, "symbolic-ref", "--short", "HEAD"]);
  const current = head.stdout.trim();
  if (head.code !== 0 || current !== base) {
    return (
      `primary checkout's HEAD is on '${current || "a detached commit"}', not '${base}'; ` +
      `switch the primary checkout to '${base}' before merging.`
    );
  }
  const anc = await exec(["git", "-C", project.repo_path, "merge-base", "--is-ancestor", base, task.branch]);
  if (anc.code !== 0) {
    // Name the exact commit compared against: this is the primary checkout's
    // LOCAL base ref, which can be ahead of origin/<base> — an agent rebased
    // onto origin/main and hit this identical failure twice before digging
    // out that hive checks a different, unfetchable-by-name ref.
    const sha = (await exec(["git", "-C", project.repo_path, "rev-parse", "--short", base])).stdout.trim();
    return (
      `'${base}' (LOCAL ref in the primary checkout${sha ? `, ${sha}` : ""} — may be ahead of origin/${base}) ` +
      `is not an ancestor of '${task.branch}'; not a fast-forward. Rebase onto that exact commit ` +
      `(git fetch <primary-checkout> ${base}) or open a PR.`
    );
  }
  const r = await exec(["git", "-C", project.repo_path, "merge", "--ff-only", task.branch]);
  if (r.code !== 0) return r.stderr.trim() || r.stdout.trim() || `git merge --ff-only exited ${r.code}`;
  return null;
}

// Does the PR's own state say the merge was refused over the base comparison
// (stale/diverged base) rather than branch protection? GitHub returns the same
// opaque "Pull Request is not mergeable" for both, so the reason string alone
// can't authorize a local merge that bypasses required checks/reviews. Only
// DIRTY/BEHIND/UNKNOWN qualify, and only when neither a required review nor a
// failing/running required check is the blocker (the rollup mixes CheckRun and
// StatusContext shapes — ciStatusOf owns that distinction). Anything unknown →
// false: the local ff is never the safe default here.
function staleBaseRefusal(prView: any): boolean {
  const status = String(prView?.mergeStateStatus ?? "").toUpperCase();
  if (status !== "DIRTY" && status !== "BEHIND" && status !== "UNKNOWN") return false;
  const review = String(prView?.reviewDecision ?? "").toUpperCase();
  if (review === "REVIEW_REQUIRED" || review === "CHANGES_REQUESTED") return false;
  const ci = ciStatusOf(prView?.statusCheckRollup);
  return ci !== "failing" && ci !== "pending";
}

// POST /api/tasks/:id/merge — approve & merge an in-review task.
// PR-backed: `gh pr merge <url> <method>`. Otherwise a local fast-forward of the
// task branch into the project's default branch. On success: `merged` event,
// in_review→verifying (triggers smoke), best-effort worktree teardown. On
// conflict: the task is bounced back to the agent (see mergeFailed); other
// failures (CI blocked) return 409 with the reason and no state change.
//
// body.merge_strategy === "local_ff" forces the local fast-forward path even
// when task.pr_url is set — the escape hatch for a PR whose base comparison
// on GitHub is stale (origin/<base> behind the primary checkout's local
// <base>) while the branch is still a clean ff onto local <base>. It skips
// `gh pr merge` and the staleBaseRefusal gate (an explicit override is the
// caller's call to make) but still honours the PR state probe: a CLOSED PR is
// refused and a MERGED one just advances. The same
// staleness shape is also detected automatically: if `gh pr merge` fails with
// a conflict/not-mergeable/not-an-ancestor reason AND the PR's own state says
// the blocker is the base comparison rather than branch protection, hive tries
// the local ff before bouncing the task back to the agent (rebasing onto a
// stale origin/<base> would only make things worse).
// Guarded by the `task.merge` standing-authority action.
export async function mergeTask(db: DB, herdr: Herdr, id: string, body: any, deps: HandlerDeps): Promise<Response> {
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
  const forceLocalFf = body?.merge_strategy === "local_ff";

  // Guard against a destructive auto-rebase landing (task #314): a stale branch
  // that no-mistakes' CI monitor rebased onto base, silently reverting other
  // tasks' shipped commits, then reported green CI. Compare the branch's final
  // authored scope against the snapshot taken before any rebase; if it now
  // reverts base commits outside its original scope, refuse the merge. The
  // director can override with body.override_destructive_check.
  if (!body?.override_destructive_check && project?.repo_path && task.branch) {
    const snapEvent: any = db
      .query("SELECT payload FROM events WHERE task_id = ? AND type = 'branch_scope' ORDER BY ts ASC LIMIT 1")
      .get(id);
    if (snapEvent) {
      let snapshot: BranchScope | null = null;
      try {
        snapshot = JSON.parse(snapEvent.payload);
      } catch {}
      if (snapshot) {
        const regressed = await detectDestructiveRebase(exec, project.repo_path, base, task.branch, snapshot);
        if (regressed && regressed.length) {
          const files = regressed.slice(0, 10).join(", ") + (regressed.length > 10 ? `, …(+${regressed.length - 10})` : "");
          writeEvent(db, {
            task_id: id,
            source: "director",
            type: "merge_blocked_destructive",
            payload: { base, branch: task.branch, regressed },
          });
          recordSystemLearning(
            db,
            task.project_id,
            "destructive auto-rebase blocked at merge",
            `branch reverts base work outside its scope: ${files}`,
            id
          );
          if (task.agent_target) {
            await herdr
              .send(
                task.agent_target,
                `hive: merge into '${base}' BLOCKED — your branch '${task.branch}' now reverts commits ` +
                  `already on '${base}' outside this task's scope (${files}). This is the destructive ` +
                  `auto-rebase pattern from task #314: an auto-resolve dropped intervening work while CI stayed ` +
                  `green. Do NOT trust the rebase — abandon this branch and re-cut a clean one off CURRENT ` +
                  `'${base}', re-apply only your task's change, and push. If those reverts are intentional, the ` +
                  `director can override.`
              )
              .catch(() => {});
          }
          transition(db, id, "in_progress", { source: "director", reason: "merge blocked: destructive auto-rebase" });
          return err(
            `merge blocked — branch '${task.branch}' reverts base work outside this task's scope (${files}); ` +
              `the auto-rebase likely dropped intervening commits (task #314). Re-cut off current '${base}', or ` +
              `merge with override_destructive_check=true if intentional.`,
            409
          );
        }
      }
    }
  }

  let method = "";
  let prView: any = null;
  if (task.pr_url) {
    // A closed or already-merged PR fails `gh pr merge` with an opaque GraphQL
    // error and used to bounce the agent with a bogus conflict steer (task #90
    // looped on its replaced PR for hours). Tell the truth instead — and when
    // GitHub says MERGED, just advance: the work landed, hive's link was stale.
    // Runs on the forced local_ff path too: that override exists for a stale
    // base comparison, never for landing a rejected PR's branch.
    const probe = await exec([
      "gh",
      "pr",
      "view",
      task.pr_url,
      "--json",
      "state,mergeStateStatus,reviewDecision,statusCheckRollup",
    ]);
    if (probe.code === 0) {
      prView = JSON.parse(probe.stdout || "{}");
      const prState = String(prView.state ?? "").toUpperCase();
      if (prState === "MERGED") {
        method = "already merged on GitHub";
      } else if (prState === "CLOSED") {
        return mergeFailed(
          db,
          herdr,
          task,
          base,
          `PR is CLOSED (not merged): ${task.pr_url}. If the agent replaced it, its 'ready' emit now re-links the task; otherwise re-link via POST /api/tasks/link-pr.`
        );
      }
    }
  }

  if (!method) {
    if (task.pr_url && !forceLocalFf) {
      const flag = ghMergeFlag(config.merge_method);
      method = `pr ${flag.slice(2)}`;
      const r = await exec(["gh", "pr", "merge", task.pr_url, flag]);
      if (r.code !== 0) {
        const reason = r.stderr.trim() || r.stdout.trim() || `gh pr merge exited ${r.code}`;
        // GitHub's mergeability check compares against origin/<base>, which can
        // be a stale fork behind the primary checkout's local <base> (task 328).
        // Rebasing onto that stale fork only pulls in unrelated history — so
        // before bouncing the agent, check whether the branch is still a clean
        // ff onto LOCAL <base> and merge that way instead. Gated on the PR's own
        // state: a protection block (failing checks, missing reviews) wears the
        // same "not mergeable" reason, and must never be merged around.
        if (MERGE_CONFLICT_RE.test(reason) && staleBaseRefusal(prView) && project?.repo_path && task.branch) {
          const ffReason = await attemptLocalFf(exec, project, task, base);
          if (ffReason === null) {
            method = "local ff-only (PR merge reported not-mergeable against origin/" + base + ")";
          } else {
            return mergeFailed(db, herdr, task, base, `${reason}; local fast-forward also refused: ${ffReason}`);
          }
        } else {
          return mergeFailed(db, herdr, task, base, reason);
        }
      }
    } else {
      if (!project?.repo_path) return err("project has no repo_path; cannot merge", 400);
      if (!task.branch) return err("task has no branch; nothing to merge", 400);
      // Documented safe local merge: fast-forward the default branch to the task
      // branch tip. Requires the default branch to be an ancestor of the task
      // branch; a non-fast-forward (diverged / conflicting) merge is refused, no
      // working tree is touched. Callers wanting a squash merge should use a PR.
      const ffReason = await attemptLocalFf(exec, project, task, base);
      if (ffReason !== null) return mergeFailed(db, herdr, task, base, ffReason);
      method = forceLocalFf && task.pr_url ? "local ff-only (forced; PR-backed task)" : "local ff-only";
    }
  }

  writeEvent(db, { task_id: id, source: "director", type: "merged", payload: { method, base, branch: task.branch, pr_url: task.pr_url } });
  // in_review → verifying (runs post-deploy smoke once).
  transition(db, id, "verifying", { source: "director", reason: `merged (${method})` });
  await smokeThenAdvance(db, id).catch((e) => console.error("[hive] smoke run failed:", e));

  // Best-effort worktree teardown now the branch is merged. Never fails the
  // request — a leftover worktree is a cleanup nuisance, not a merge failure.
  // cleanupWorktree (git-based, WIP-preserving), NOT teardown: a merged task's
  // worktree has no herdr workspace id, and `herdr worktree remove` only
  // addresses workspaces ("unknown option: --cwd", seen live 2026-07-10).
  if (task.worktree_path && task.branch && project?.repo_path) {
    try {
      await herdr.cleanupWorktree({
        repoPath: project.repo_path,
        branch: task.branch,
        worktreePath: task.worktree_path,
        taskId: id,
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
  let sendError: string | null = null;
  if (task.agent_target) {
    try {
      const res = await herdr.send(
        task.agent_target,
        `hive: changes requested before merge —\n${notes}\n\n` +
          `If any of the above is a QUESTION, reply with \`hive emit ${id} answer --note "..."\` ` +
          `(answers are pushed to the director; pane text is not), then make the changes and emit ready again.\n\n` +
          `After you push the fix, RE-CAPTURE evidence against the new commit — a fresh test run or log for ` +
          `server/back-end changes, a screenshot for UI. The old evidence is now stale and the handoff is HELD ` +
          `until fresh evidence matches HEAD (hive emit ${id} evidence --file ... --note ...).`
      );
      sendError = sendFailure(res);
      delivered = sendError === null;
    } catch (e: any) {
      sendError = String(e?.message ?? e);
    }
  }
  const lastSync: any = db
    .query("SELECT payload FROM events WHERE task_id = ? AND type = 'pr_synchronized' ORDER BY ts DESC LIMIT 1")
    .get(id);
  const head_sha: string | null = lastSync ? (JSON.parse(lastSync.payload).head_sha ?? null) : null;
  writeEvent(db, {
    task_id: id,
    source: "director",
    type: "changes_requested",
    payload: { notes, delivered, head_sha, ...(sendError ? { send_error: sendError } : {}) },
  });
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

// Model per task kind, always pinned: without an explicit --model the CLI's
// own default applies, which can be the priciest tier (fable burned $2.2k in
// 97 sessions, incl. Opus-priced "say hello" health checks). Ship work gets
// opus; scouts/chores are mechanical enough for sonnet. Per-project overrides:
// config.model_by_kind = {ship:"opus",...} wins over config.model wins over
// these defaults. config.agent_argv (verbatim) bypasses this entirely.
const DEFAULT_MODEL_BY_KIND: Record<string, string> = { ship: "opus", scout: "sonnet", chore: "sonnet" };

export function modelForTask(config: any, kind: string): string {
  return config?.model_by_kind?.[kind] ?? config?.model ?? DEFAULT_MODEL_BY_KIND[kind] ?? "sonnet";
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
  opts: { hiveUrl?: string; supervise?: boolean; briefOverride?: string; exec?: Exec } = {}
): Promise<{ ok: true; agent_target: string } | { ok: false; error: string }> {
  const task = getTask(db, id);
  if (!task) return { ok: false, error: "task not found" };
  const project: any = db.query("SELECT * FROM projects WHERE id = ?").get(task.project_id);
  if (!project?.repo_path) return { ok: false, error: "project has no repo_path" };
  const config = JSON.parse(project.config ?? "{}");

  // Compose the brief fresh; it is delivered as the interactive agent's first
  // prompt (see runtime/herdr.defaultAgentArgv) — no `-p` one-shot. Steers sent
  // while the task had no live agent ride along on top, so they reach the fresh
  // agent instead of vanishing. briefOverride is the persistent-chat supervisor's
  // bespoke brief (it isn't a normal ship/scout task, so composeBrief's
  // open-a-PR-and-hand-off protocol doesn't apply).
  const pending = queuedSteers(db, id);
  const brief = steerPreamble(pending) + (opts.briefOverride ?? composeBrief(db, id));
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
      model: modelForTask(config, task.kind),
      agentArgv: config.agent_argv, // optional per-project override (verbatim)
      // Seed the worktree BEFORE the agent starts: hive's Claude Code hook
      // wiring (structural Stop/SubagentStop/PostToolUse reporting), then the
      // per-project spawn hook (config.setup_argv, e.g. wt.sh up {worktree}) so
      // agents don't have to install deps / bring up their stack themselves.
      prepareWorktree: async (worktreePath) => {
        writeHookSettings(worktreePath, id, hiveUrl, config.command_approval);
        const setup = await runStackCmd(db, id, config.setup_argv, project.repo_path, worktreePath, opts.exec ?? defaultExec, {
          type: "stack_setup",
          source: "herdr",
          timeoutMs: Number(config.stack_setup_timeout_ms) || 600_000,
        });
        // Unlike teardown, a failed setup ABORTS the spawn: starting an agent
        // whose deps/stack never came up burns a whole run on confusing
        // downstream failures. Throwing here surfaces out of herdr.spawn into
        // the catch below — one spawn_error naming the reason, {ok:false} to the
        // dispatcher (which backs off), and the queued steers stay queued for
        // the retry because markSteersDelivered runs only on the success path.
        if (!setup.ok) throw new Error(`stack setup failed: ${setup.error ?? "unknown error"}`);
      },
    });
  } catch (e: any) {
    writeEvent(db, { task_id: id, source: "herdr", type: "spawn_error", payload: { error: String(e?.message ?? e) } });
    recordSystemLearning(db, task.project_id, `spawn failure: ${signature(String(e?.message ?? e))}`, String(e?.message ?? e), id);
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
  // The agent is up and holding the queued steers in its brief — receipt them.
  // Only now: a failed spawn above leaves them queued for the next attempt.
  markSteersDelivered(db, pending.map((s) => s.id));
  if (task.state === "queued") transition(db, id, "in_progress", { source: "herdr", reason: "agent spawned" });

  if (opts.supervise) superviseAgent(db, herdr, id, result.agent_target);

  return { ok: true, agent_target: result.agent_target };
}

// Re-arming supervised wait loop: the herdr PUSH channel for "the agent is
// done". It never relies on anything the agent emits — herdr's own idle signal
// drives the in_progress → in_review handoff (advanceIfFinished, same logic as
// the reconciler's poll backstop). A wait timeout re-arms while the agent is
// alive, so supervision covers tasks longer than one wait window; the loop ends
// on handoff, death, or a herdr error, and the reconciler's polling is the
// safety net for everything after. Started only in production wiring; exported
// for tests.
export async function superviseAgent(db: DB, herdr: Herdr, taskId: string, target: string): Promise<void> {
  const WAIT_MS = 5 * 60 * 1000;
  // Idle with nothing to hand off yet (no PR): `wait --status idle` returns
  // immediately while the agent stays idle, so a bare re-arm would busy-spin.
  const IDLE_RECHECK_MS = 15_000;
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
    if (res.code !== 0) {
      // Timeout (agent still working) or a vanished agent. Re-arm while alive;
      // a dead agent is the reconciler recovery's job, not ours.
      const { alive } = await herdr.probe(target);
      if (!alive) return;
      continue;
    }
    const status = await herdr.status(target);
    if (status !== "unknown") {
      const last = db
        .query("SELECT payload FROM events WHERE task_id = ? AND type = 'agent_status' ORDER BY ts DESC LIMIT 1")
        .get(taskId) as { payload: string } | undefined;
      const prev = last ? (JSON.parse(last.payload).status ?? null) : null;
      if (status !== prev)
        writeEvent(db, { task_id: taskId, source: "herdr", type: "agent_status", payload: { status } });
      // The push-signal payoff: hand off to review the moment herdr says idle,
      // instead of waiting out the next reconciler cycle.
      if (advanceIfFinished(db, taskId, status, "herdr")) return; // handed off; done supervising
    }
    await new Promise((r) => setTimeout(r, IDLE_RECHECK_MS));
  }
}

// One `herdr agent send` attempt. Returns the failure reason, or null if the
// message landed. Never throws.
async function sendOnce(herdr: Herdr, target: string, message: string): Promise<string | null> {
  try {
    return sendFailure(await herdr.send(target, message));
  } catch (e: any) {
    return String(e?.message ?? e);
  }
}

// Steer an agent via `herdr agent send`, with a delivery receipt. Every steer is
// recorded as one `steer` event carrying its own delivery status, and a steer
// that finds no live agent is QUEUED rather than dropped — the next spawn of the
// task prepends it to the brief (see spawnAgent). Re-sending is never needed.
// Accepts JSON or multipart; attached files are saved and their absolute paths
// appended to the message the agent receives (so they ride along on redelivery).
// Programmatic steer for hive's own subsystems (offline prep, checkpoint
// flags): same delivery-receipt semantics as the HTTP path, no Request object,
// no authz gate (the server is steering, not an agent).
async function internalSteer(db: DB, herdr: Herdr, id: string, message: string): Promise<boolean> {
  const task = getTask(db, id);
  if (!task) return false;
  const target = task.agent_target;
  let error: string | null = target ? null : "task has no agent_target (not spawned)";
  if (target) {
    error = await sendOnce(herdr, target, message);
    if (error) error = await sendOnce(herdr, target, message);
    if (error) writeEvent(db, { task_id: id, source: "herdr", type: "steer_error", payload: { error, target } });
  }
  const delivered = !error;
  const delivery: Delivery = delivered ? "delivered" : TERMINAL.includes(task.state as State) ? "failed" : "queued";
  writeEvent(db, {
    task_id: id,
    source: "director",
    type: "steer",
    payload: { message, target, attachments: [], delivery, ...(delivered ? { delivered_at: now() } : { error }) },
  });
  return delivered;
}

async function sendSteer(db: DB, herdr: Herdr, id: string, req: Request): Promise<Response> {
  const task = getTask(db, id);
  if (!task) return err("task not found", 404);
  const { fields, files } = await bodyWithFiles(req);
  const text = String(fields?.message ?? "");
  if (!text) return err("message is required");
  const blocked = authzBlock(db, { project_id: task.project_id, action: "task.steer", target: task.title, task_id: id });
  if (blocked) return blocked;
  const { paths, block } = await attachFiles(id, files);
  const message = text + block;
  const target = task.agent_target;

  let error: string | null = target ? null : "task has no agent_target (not spawned)";
  if (target) {
    // Retry once: a herdr socket hiccup is the common failure, and a resend into
    // a live composer is idempotent (the Enter is what submits it).
    error = await sendOnce(herdr, target, message);
    if (error) error = await sendOnce(herdr, target, message);
    if (error) writeEvent(db, { task_id: id, source: "herdr", type: "steer_error", payload: { error, target } });
  }

  const delivered = !error;
  // A terminal task will never be spawned again, so queuing would be a lie.
  const delivery: Delivery = delivered ? "delivered" : TERMINAL.includes(task.state as State) ? "failed" : "queued";
  writeEvent(db, {
    task_id: id,
    source: "director",
    type: "steer",
    payload: { message, target, attachments: paths, delivery, ...(delivered ? { delivered_at: now() } : { error }) },
  });
  return json({ ok: delivered, delivered, delivery, message, attachments: paths, ...(error ? { error } : {}) });
}

// The agent's pane, as plain text. ANSI/control sequences are stripped
// server-side so the client renders it in a bare <pre> — good enough to watch
// an agent work; interaction stays on the steer channel.
async function taskPane(db: DB, herdr: Herdr, id: string, url: URL): Promise<Response> {
  const task = getTask(db, id);
  if (!task) return err("task not found", 404);
  if (!task.agent_target) return err("task has no agent (not spawned, or already cleaned up)", 404);
  const lines = Math.min(Math.max(Number(url.searchParams.get("lines")) || 200, 10), 2000);
  const raw = await herdr.read(task.agent_target, lines);
  // CSI/OSC escape sequences and stray control chars (keep \n and \t).
  const text = raw
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
  return json({ task_id: id, agent_target: task.agent_target, lines, text, ts: now() });
}

// Broadcast a steer to every task with a live agent (optionally one project's).
// Replaces the observed copy-paste-to-N-tasks pattern: protocol updates went
// out by hand to up to 8 agents, three times in one morning. Delivery receipts
// per task (delivered / queued), same semantics as a single steer.
async function steerLiveAgents(
  db: DB,
  herdr: Herdr,
  message: string,
  projectId?: string
): Promise<{ targets: number; delivered: number; results: { task_id: string; delivered: boolean }[] }> {
  const rows = db
    .query(
      `SELECT id FROM tasks WHERE agent_target IS NOT NULL
        AND state IN ('in_progress','needs_decision','in_review','verifying')${projectId ? " AND project_id = ?" : ""}`
    )
    .all(...(projectId ? [projectId] : [])) as { id: string }[];
  const results: { task_id: string; delivered: boolean }[] = [];
  for (const t of rows) {
    results.push({ task_id: t.id, delivered: await internalSteer(db, herdr, t.id, message) });
  }
  return { targets: results.length, delivered: results.filter((r) => r.delivered).length, results };
}

async function broadcastSteer(db: DB, herdr: Herdr, body: any): Promise<Response> {
  const message = String(body?.message ?? "").trim();
  if (!message) return err("message is required");
  const r = await steerLiveAgents(db, herdr, message, body?.project_id ? String(body.project_id) : undefined);
  return json({ ok: true, ...r });
}

// ---- offline mode ----
// "Going offline": drain, don't kill. The flag pauses the dispatcher/promoter
// (nothing new spawns), the network half of the reconciler (no PR sync, no
// stale flags, no nudges — offline must not read as failure), monitors, and
// gchat. Working agents get a PREP steer while the network is still up: push
// WIP, write a handoff note, finish the current local step, stop. All task
// state is already durable in SQLite; the handoff notes preserve the in-flight
// context. Turning the flag off steers parked agents to resume and reopens
// dispatch.
async function setOffline(db: DB, herdr: Herdr, body: any): Promise<Response> {
  const on = !!body?.on;
  if (on === isOffline(db)) return json({ on, steered: 0 });
  setSetting(db, "offline", on ? "1" : "0");
  broadcast({ type: "offline", on });

  const working = db
    .query(
      "SELECT id, agent_target FROM tasks WHERE agent_target IS NOT NULL AND state IN ('in_progress','needs_decision')"
    )
    .all() as { id: string; agent_target: string }[];

  const prep = (id: string) =>
    `OFFLINE PREP: this machine is about to lose internet. While the network is still up, do these NOW, in order: ` +
    `(1) commit your work-in-progress and push your branch (git add -A && git commit && git push -u origin HEAD); ` +
    `(2) write a handoff note: hive emit ${id} status --note "HANDOFF: <exactly where you are, what's done, verified how, and the precise next step>"; ` +
    `(3) finish only your current LOCAL step, then stop and wait — no API calls, web fetches, or pushes after that. ` +
    `You will get a "back online" message when connectivity returns.`;
  const resume = () =>
    `Back ONLINE: connectivity is restored. Re-read your last HANDOFF status note and continue the task from exactly where you left off.`;

  let steered = 0;
  for (const t of working) {
    try {
      if (await internalSteer(db, herdr, t.id, on ? prep(t.id) : resume())) steered++;
    } catch {
      /* a steer failure queues; the drain/respawn replays it */
    }
  }

  enqueue(db, {
    kind: "offline",
    title: on ? `Offline mode ON — fleet draining (${steered} agents prepped)` : "Offline mode OFF — fleet resuming",
    body: on
      ? "Nothing new will spawn. Agents push WIP + write handoff notes, finish their current step, and park."
      : "Dispatcher, promoter, monitors, and recovery are back on; parked agents were told to continue.",
    urgency: "normal",
  });
  writeEvent2Offline(db, on, steered);
  return json({ on, steered });
}

// A durable record on no particular task: offline toggles matter when reading
// history ("why did nothing run for six hours?"). Uses the notifications table
// timestamp via enqueue above; this writes a feed-visible marker too.
function writeEvent2Offline(db: DB, on: boolean, steered: number): void {
  try {
    const anyTask = db.query("SELECT id FROM tasks ORDER BY updated_at DESC LIMIT 1").get() as { id: string } | undefined;
    if (anyTask)
      writeEvent(db, { task_id: anyTask.id, source: "director", type: on ? "offline_on" : "offline_off", payload: { steered } });
  } catch {
    /* marker only */
  }
}

// ---- checkpoints (live build-time checklist) ----
// Agents emit `checkpoint` events WHILE building ("assuming X", "took shortcut
// Y") instead of saving every judgment call for the final review. The director
// ticks them (ok) or flags them; a flag steers the agent immediately. State is
// derived purely from events — no table, no migration.
function checkpointNote(payload: string): string {
  try {
    return String(JSON.parse(payload).note ?? "");
  } catch {
    return "";
  }
}

function listOpenCheckpoints(db: DB): Response {
  // Un-acked checkpoints stay reviewable AFTER the task finishes — agents
  // finish faster than the director's attention cycle, and 21 of the first 25
  // checkpoints vanished unreviewed when this filtered to live states
  // (2026-07-10). Only cancelled tasks drop out (their calls died with them).
  const rows = db
    .query(
      `SELECT e.id, e.task_id, e.ts, e.payload, t.number, t.title, t.project_id, t.state
         FROM events e JOIN tasks t ON t.id = e.task_id
        WHERE e.type = 'checkpoint'
          AND t.state != 'cancelled'
          AND NOT EXISTS (
            SELECT 1 FROM events a
             WHERE a.task_id = e.task_id AND a.type = 'checkpoint_ack'
               AND json_extract(a.payload, '$.checkpoint_id') = e.id)
        ORDER BY t.number DESC, e.ts ASC`
    )
    .all() as any[];
  return json({
    checkpoints: rows.map((r) => ({
      id: r.id,
      task_id: r.task_id,
      ts: r.ts,
      task_number: r.number,
      task_title: r.title,
      task_state: r.state,
      project_id: r.project_id,
      note: checkpointNote(r.payload),
    })),
  });
}

async function ackCheckpoint(db: DB, herdr: Herdr, taskId: string, eventId: string, body: any): Promise<Response> {
  const ev: any = db
    .query("SELECT * FROM events WHERE id = ? AND task_id = ? AND type = 'checkpoint'")
    .get(eventId, taskId);
  if (!ev) return err("checkpoint not found", 404);
  const verdict = body?.verdict;
  if (verdict !== "ok" && verdict !== "flag") return err("verdict must be 'ok' or 'flag'");
  const note = body?.note ? String(body.note) : null;
  writeEvent(db, {
    task_id: taskId,
    source: "director",
    type: "checkpoint_ack",
    payload: { checkpoint_id: eventId, verdict, note },
  });
  let delivered = false;
  let followup_task_id: string | null = null;
  if (verdict === "flag") {
    const cpText = checkpointNote(ev.payload);
    const task = getTask(db, taskId);
    const live = task && !["done", "cancelled", "failed"].includes(task.state) && task.agent_target;
    if (live) {
      delivered = await internalSteer(
        db,
        herdr,
        taskId,
        `Director FLAGGED your checkpoint: "${cpText}"${note ? ` — ${note}` : ""}. Address this now, before continuing.`
      );
    }
    // Late flag (task finished / agent gone): the work already shipped, so the
    // correction becomes a queued follow-up task instead of a dead steer. A
    // live agent with a failed delivery is NOT rerouted — the steer event is
    // recorded and the agent sees it on its next poll/respawn.
    if (!live && task) {
      const fid = newId();
      const t = now();
      db.query(
        `INSERT INTO tasks (id, project_id, title, brief, state, kind, source, parent_task_id, created_at, updated_at)
         VALUES (?,?,?,?, 'queued', 'ship', 'checkpoint_flag', ?, ?, ?)`
      ).run(
        fid,
        task.project_id,
        `Flagged checkpoint from #${task.number}: ${cpText.slice(0, 80)}`,
        `The director flagged a checkpoint after task #${task.number} ("${task.title}") had already ${task.state === "done" ? "shipped" : "stopped"}.\n\nCheckpoint (the agent's judgment call): ${cpText}\n\nDirector's flag: ${note ?? "(no note)"}\n\nRevisit that decision in the shipped code and correct it per the director's note. Original task id: ${taskId}.`,
        taskId,
        t,
        t
      );
      writeEvent(db, { task_id: fid, source: "director", type: "created", payload: { title: "checkpoint flag follow-up", checkpoint_id: eventId } });
      broadcastTask(db, getTask(db, fid));
      followup_task_id = fid;
    }
  }
  return json({ ok: true, delivered, followup_task_id });
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
  "Bash(git blame:*)",
  "Bash(git rev-parse:*)",
  "Bash(git ls-files:*)",
  "Bash(git ls-tree:*)",
  "Bash(git describe:*)",
  "Bash(git shortlog:*)",
  "Bash(git reflog:*)",
  "Bash(git cat-file:*)",
  "Bash(git tag)",
  "Bash(git remote)",
  "Bash(git stash list)",
  "Bash(git worktree list)",
  "Bash(bun test:*)",
  "Bash(bun run:*)",
  "Bash(npm test:*)",
  "Bash(npm run:*)",
  "Bash(pnpm test:*)",
  "Bash(pnpm run:*)",
  "Bash(yarn test:*)",
  // gh: read-only subcommands only — mirrors hooks/classify.ts's SAFE list.
  "Bash(gh pr view:*)",
  "Bash(gh pr list:*)",
  "Bash(gh pr diff:*)",
  "Bash(gh pr checks:*)",
  "Bash(gh pr status:*)",
  "Bash(gh issue view:*)",
  "Bash(gh issue list:*)",
  "Bash(gh issue status:*)",
  "Bash(gh run view:*)",
  "Bash(gh run list:*)",
  "Bash(gh workflow view:*)",
  "Bash(gh workflow list:*)",
  "Bash(gh release view:*)",
  "Bash(gh release list:*)",
  "Bash(gh repo view:*)",
  "Bash(gh auth status)",
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
  // Re-broadcast the failed original: its earlier `failed` SSE frame predates
  // this successor, so clients still show it as awaiting triage without this.
  broadcastTask(db, getTask(db, source.id));
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
// If this card was a blocked-dialog escalation (reconciler recoverBlockedDialog),
// answering it sends the chosen keystroke to the agent's frozen pane remotely:
// approve → "1", deny → "3". Fire-and-forget; the outcome event records delivery.
export function resolveBlockedForDecision(db: DB, herdr: Herdr, decisionId: string, answerKey: string): boolean {
  const ev = db
    .query(
      `SELECT task_id FROM events WHERE type = 'blocked_card' AND json_extract(payload, '$.decision_id') = ? LIMIT 1`
    )
    .get(decisionId) as { task_id: string } | undefined;
  if (!ev) return false;
  const task = getTask(db, ev.task_id);
  if (!task?.agent_target) return true; // it WAS a blocked card, just no live agent to key
  const key = answerKey === "approve" ? "1" : "3";
  herdr
    .answerDialog(task.agent_target, key)
    .then((r) => {
      writeEvent(db, {
        task_id: task.id,
        source: "director",
        type: "dialog_answered",
        payload: { decision_id: decisionId, key, delivered: r.code === 0, ...(r.code !== 0 ? { error: r.stderr.trim() || r.stdout.trim() } : {}) },
      });
    })
    .catch((e) => {
      writeEvent(db, { task_id: task.id, source: "director", type: "dialog_answered", payload: { decision_id: decisionId, key, delivered: false, error: String(e?.message ?? e) } });
    });
  return true;
}

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
// On-demand knowledge lookup across a project's references, failure learnings,
// and policies (global + project). `project_id` or `task_id` scopes it; `q` is a
// space-separated set of keywords, ALL of which must appear (title or body,
// case-insensitive). No q → return all references + policies (the "what exists"
// index). LIKE, not FTS — a few hundred rows, keep it boring.
function knowledgeSearch(db: DB, url: URL): Response {
  let projectId = url.searchParams.get("project_id");
  const taskId = url.searchParams.get("task_id");
  if (!projectId && taskId) {
    const t: any = db.query("SELECT project_id FROM tasks WHERE id = ?").get(taskId);
    projectId = t?.project_id ?? null;
  }
  if (!projectId) return err("project_id or task_id is required");
  const terms = (url.searchParams.get("q") ?? "").trim().split(/\s+/).filter(Boolean);
  const like = (cols: string) =>
    terms.length ? " AND " + terms.map(() => `(${cols}) LIKE ?`).join(" AND ") : "";

  const refs = db
    .query(
      `SELECT title, body FROM learnings WHERE project_id = ? AND kind = 'reference' AND status = 'active'${like("title || ' ' || COALESCE(body,'')")} ORDER BY first_seen`
    )
    .all(projectId, ...terms.map((t) => `%${t}%`)) as any[];
  const learnings = db
    .query(
      `SELECT title, body, occurrences FROM learnings WHERE project_id = ? AND kind = 'failure' AND status = 'active'${like("title || ' ' || COALESCE(body,'')")} ORDER BY last_seen DESC LIMIT 20`
    )
    .all(projectId, ...terms.map((t) => `%${t}%`)) as any[];
  const policies = db
    .query(
      `SELECT title, body FROM policies WHERE active = 1 AND (scope = 'global' OR scope = ?)${like("title || ' ' || body")} ORDER BY created_at`
    )
    .all(`project:${projectId}`, ...terms.map((t) => `%${t}%`)) as any[];
  // Answers to past decision cards — so a crew consults the prior ruling before
  // re-raising the same question.
  const decisions = db
    .query(
      `SELECT title, body, occurrences FROM learnings WHERE project_id = ? AND kind = 'decision' AND status = 'active'${like("title || ' ' || COALESCE(body,'')")} ORDER BY last_seen DESC LIMIT 20`
    )
    .all(projectId, ...terms.map((t) => `%${t}%`)) as any[];

  return json({ query: terms.join(" "), references: refs, learnings, policies, decisions });
}

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
  // Reference facts route to the reference store (pinned into briefs, browsable
  // under References), not the occurrence-aged failure ledger.
  if (body.kind === "reference") {
    const id = addReference(db, body.project_id, String(body.title), body.body ?? null, body.source_task_id ?? null);
    return json(db.query("SELECT * FROM learnings WHERE id = ?").get(id), 201);
  }
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

// ---------------------------------------------------------------- uploads
// Store an uploaded file under HIVE_HOME evidence storage, namespaced by task.
// Shared by evidence uploads and by steer/brief attachments. The timestamp
// prefix is not unique on its own — a multi-file upload saves every file within
// the same millisecond — so collisions get a counter.
async function saveUpload(taskId: string, file: File): Promise<{ path: string; url: string }> {
  const destDir = join(evidenceDir(), taskId);
  mkdirSync(destDir, { recursive: true });
  // A multipart part with a name but no `filename=` parses (in Bun) as a File
  // whose `.name` is undefined — guard so a malformed part can't crash the save.
  const safeName = (file.name ?? "").replace(/[^\w.\-]/g, "_") || "file";
  const stamp = Date.now();
  let finalName = `${stamp}_${safeName}`;
  for (let i = 1; existsSync(join(destDir, finalName)); i++) finalName = `${stamp}_${i}_${safeName}`;
  const dest = join(destDir, finalName);
  await Bun.write(dest, file);
  return { path: dest, url: `/evidence/${taskId}/${finalName}` };
}

// Read a request that may be multipart (text fields + any number of files) or
// plain JSON, so an endpoint can accept attachments without a separate route.
async function bodyWithFiles(req: Request): Promise<{ fields: any; files: File[] }> {
  const ct = req.headers.get("content-type") || "";
  if (!ct.includes("multipart/form-data")) return { fields: await safeJson(req), files: [] };
  const form = await req.formData();
  const fields: Record<string, string> = {};
  const files: File[] = [];
  for (const [k, v] of form.entries()) {
    if (v instanceof File) files.push(v);
    else fields[k] = String(v);
  }
  return { fields, files };
}

// Save attachments for a task and render the block appended to a steer message
// or a brief. Agents get absolute paths because they read files off disk, not
// over HTTP. Deliberately does NOT insert `evidence` rows: evidence gates the
// `done` transition, and an input the director attached is not proof of work.
async function attachFiles(taskId: string, files: File[]): Promise<{ paths: string[]; block: string }> {
  const paths: string[] = [];
  for (const f of files) paths.push((await saveUpload(taskId, f)).path);
  const block = paths.length
    ? `\n\n## Attachments\nThese files are on disk; read them with the Read tool.\n${paths.map((p) => `- ${p}`).join("\n")}`
    : "";
  return { paths, block };
}

// The task worktree's current HEAD commit. Evidence is stamped with this SHA at
// capture time, and the ready gate compares it against attached evidence so a
// stale screenshot (from before a change-request fix) can't satisfy the handoff.
// Fails soft (null) when there's no worktree or git can't answer — a broken git
// must not strand every handoff (same fail-open stance as the CI probe).
async function headSha(exec: Exec, cwd: string | null): Promise<string | null> {
  if (!cwd) return null;
  try {
    const r = await exec(["git", "rev-parse", "HEAD"], { cwd });
    const sha = r.code === 0 ? r.stdout.trim() : "";
    return sha || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- event ingestion (`hive emit`)
async function ingestEvent(db: DB, taskId: string, req: Request, deps: HandlerDeps = {}): Promise<Response> {
  if (!getTask(db, taskId)) return err("task not found", 404);
  const exec = deps.exec ?? defaultExec;
  const ct = req.headers.get("content-type") || "";
  let fields: Record<string, string> = {};
  let file: File | null = null;

  if (ct.includes("multipart/form-data")) {
    const form = await req.formData();
    for (const [k, v] of form.entries()) {
      if (v instanceof File) file = v;
      else fields[k] = String(v);
    }
    // An empty, nameless part (ad-hoc `curl -F file=...` without `@`, or a Blob
    // body) parses as a zero-byte File — not a real attachment. Drop it so an
    // otherwise-valid event still ingests instead of storing junk evidence.
    if (file && file.size === 0 && !file.name) file = null;
  } else {
    fields = (await req.json()) as any;
  }

  const type = fields.type;
  if (!type) return err("event 'type' is required");
  const source = fields.source || "agent";
  const note = fields.note ?? null;

  // --- evidence ---
  if (type === "evidence") {
    // Kind inference for uploads: "any file = screenshot" mislabeled agents'
    // .md reports / .tsv exports as images (broken <img> on review, task #72).
    const inferKind = (name: string): string => {
      if (/\.(png|jpe?g|gif|webp|svg)$/i.test(name)) return "screenshot";
      if (/\.(md|markdown)$/i.test(name)) return "report";
      return "log";
    };
    const kind = fields.kind || (file ? inferKind(file.name) : fields.url ? "link" : "log");
    let path: string | null = null;
    let servedUrl: string | null = fields.url ?? null;
    if (file) {
      const saved = await saveUpload(taskId, file);
      path = saved.path;
      servedUrl = saved.url;
    }
    // Tie the artifact to the commit it was captured from: the worktree HEAD at
    // emit time. The ready gate reads meta.commit_sha to reject stale evidence.
    let meta = fields.meta ?? "{}";
    const evTask = getTask(db, taskId);
    const sha = fields.commit_sha ?? (await headSha(exec, evTask?.worktree_path ?? null));
    if (sha) {
      try {
        const m = JSON.parse(meta);
        if (m && typeof m === "object" && m.commit_sha == null) m.commit_sha = sha;
        meta = JSON.stringify(m);
      } catch {
        // non-JSON meta: leave it, the sha stamp is best-effort
      }
    }
    const ev = {
      id: newId("ev"),
      task_id: taskId,
      ts: now(),
      kind,
      path,
      url: servedUrl,
      caption: fields.caption ?? note,
      meta,
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
    // The agent's explicit handoff is AUTHORITATIVE about which PR carries the
    // work — including when it replaces an earlier PR (closed #161 → rebased
    // #166, task #90). The old `only if unlinked` guard silently ignored the
    // new url, so every merge kept hitting the closed PR in a loop. ci_status
    // resets: it described the old PR.
    if (prUrl && prUrl !== t.pr_url) {
      db.query("UPDATE tasks SET pr_url = ?, ci_status = NULL, updated_at = ? WHERE id = ?").run(prUrl, now(), taskId);
      writeEvent(db, {
        task_id: taskId,
        source,
        type: "pr_linked",
        payload: { pr_url: prUrl, via: t.pr_url ? "ready_replaced" : "ready", ...(t.pr_url ? { replaced: t.pr_url } : {}) },
      });
    }
    if (note) writeEvent(db, { task_id: taskId, source, type: "note", payload: { note } });
    if (t.state === "in_progress") {
      // Review means "truly ready for the director to approve & merge" — a red
      // or still-running CI is not that. Probe the PR's checks NOW (hive's own
      // ci_status lags a reconciler cycle): failing/pending holds the task
      // in_progress with the agent; syncPRs promotes it the moment checks go
      // green and steers the agent if they go red. No checks at all (repo
      // without CI) and gh trouble both fail OPEN — a broken gh must not
      // strand every handoff.
      // Evidence gate, same shape as the CI hold: "attach evidence BEFORE
      // ready" is protocol, and an evidence-less card is an empty review that
      // wastes the director's queue (#163 landed there twice).
      const needsReport = t.kind === "scout";
      const hasProduct = needsReport ? evidenceCount(db, taskId, "report") >= 1 : evidenceCount(db, taskId) >= 1;
      if (!hasProduct) {
        writeEvent(db, { task_id: taskId, source, type: "ready_held", payload: { reason: "no_evidence" } });
        broadcastTask(db, getTask(db, taskId));
        return json({
          held: true,
          reason: "no_evidence",
          message: needsReport
            ? "Handoff held: scouts hand off a written report. Attach it (hive emit <task-id> evidence --kind report --file report.md), then emit ready again."
            : "Handoff held: no evidence attached. Server/back-end changes need a test run or log; UI changes need a screenshot (before/after). Attach it with `hive emit <task-id> evidence --file ... --note ...`, then emit ready again.",
        });
      }
      // Freshness gate: the evidence the director sees must reflect the CURRENT
      // commit. After a change request the agent pushes a fix, so evidence from
      // an earlier commit is stale (the #223 bug: the screenshot never updated).
      // Require at least one evidence item tied to HEAD. Scouts hand off a
      // written report, not commit-bound screenshots, so they're exempt. Fails
      // open when there's no worktree / git can't resolve HEAD.
      if (!needsReport) {
        const head = await headSha(exec, t.worktree_path);
        if (head && evidenceAtSha(db, taskId, head) < 1) {
          writeEvent(db, { task_id: taskId, source, type: "ready_held", payload: { reason: "stale_evidence", head_sha: head } });
          broadcastTask(db, getTask(db, taskId));
          return json({
            held: true,
            reason: "stale_evidence",
            head_sha: head,
            message:
              `Handoff held: your attached evidence is from an earlier commit, not the current one (${head.slice(0, 7)}). ` +
              `Re-capture against the latest commit — a fresh test run or log for server/back-end changes, ` +
              `a screenshot for UI — and attach it (hive emit ${taskId} evidence --file ... --note ...), then emit ready again.`,
          });
        }
      }
      const pr = prUrl ?? t.pr_url;
      if (pr) {
        let ci: string | null = null;
        const probe = await exec(["gh", "pr", "view", pr, "--json", "statusCheckRollup"]);
        if (probe.code === 0) {
          try {
            ci = ciStatusOf(JSON.parse(probe.stdout || "{}").statusCheckRollup);
          } catch {
            ci = null;
          }
        }
        if (ci === "failing" || ci === "pending") {
          db.query("UPDATE tasks SET ci_status = ?, updated_at = ? WHERE id = ?").run(ci, now(), taskId);
          writeEvent(db, { task_id: taskId, source, type: "ready_held", payload: { pr_url: pr, ci_status: ci } });
          broadcastTask(db, getTask(db, taskId));
          return json({
            held: true,
            ci_status: ci,
            message:
              ci === "failing"
                ? `CI is FAILING on ${pr} — the handoff is held. Run \`gh pr checks ${pr}\`, fix the failures, push; hive hands off automatically when checks pass.`
                : `CI is still running on ${pr} — the handoff is held. Stay on the task; hive hands off automatically when checks pass (and steers you if they fail).`,
          });
        }
      }
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

  // --- review_summary (structured self-review; the review card renders it) ---
  // Sections arrive top-level (the CLI --json spread) as arrays, or as JSON
  // strings via multipart. Anything else is dropped; an empty summary is a 400
  // so a mis-shaped submission fails loudly instead of storing {note:null}.
  if (type === "review_summary") {
    const pick = (k: string): unknown[] | undefined => {
      const v = (fields as any)[k];
      if (Array.isArray(v)) return v;
      if (typeof v === "string") {
        try {
          const p = JSON.parse(v);
          return Array.isArray(p) ? p : undefined;
        } catch {
          return undefined;
        }
      }
      return undefined;
    };
    const payload: Record<string, unknown> = {};
    for (const k of ["done", "iffy", "decisions", "testing", "followups"]) {
      const v = pick(k);
      if (v?.length) payload[k] = v;
    }
    if (!Object.keys(payload).length)
      return err("review_summary needs at least one of done/iffy/decisions/testing/followups (arrays)");
    const event = writeEvent(db, { task_id: taskId, source, type, payload });
    return json({ event }, 201);
  }

  // --- answer (agent replying to the director's question) ---
  // A question in a request-changes note (or steer) deserves a reply that
  // REACHES the director — agents used to answer in pane text / status notes
  // that only mirror into the feed, so the answer was never seen (2026-07-12:
  // a two-paragraph AES explanation surfaced only in the transcript log).
  // Urgent: the director asked; the reply should land as a push, not a digest.
  if (type === "answer") {
    if (!note) return err("answer needs --note (the reply text)");
    const t = getTask(db, taskId);
    const event = writeEvent(db, { task_id: taskId, source, type: "answer", payload: { note } });
    enqueue(db, {
      kind: "answer",
      urgency: "urgent",
      task_id: taskId,
      title: `Answer on #${t?.number}: ${t?.title?.slice(0, 60) ?? taskId}`,
      body: note.slice(0, 300),
    });
    return json({ event }, 201);
  }

  // --- deferred / undefer (park a task waiting on an OFFLINE human action) ---
  // A decision answered "Schedule for later" (blocked on e.g. sudo) has no state
  // that fits: in_progress keeps drawing "gone quiet" nudges (task #329 got 9+),
  // needs_decision is wrong with no open card. Deferring sets deferred_until so
  // the stale/nudge machinery skips it; the director (or agent) un-defers to
  // resume. The task stays in_progress — no state hop (task #679).
  if (type === "deferred") {
    const task = deferTask(db, taskId, deferUntil(fields.until, fields.days), { source, note });
    return json({ task }, 201);
  }
  if (type === "undefer") {
    const wasDeferred = isDeferred(getTask(db, taskId));
    const task = undeferTask(db, taskId, { source, note });
    // Nudge the (possibly idle) agent that it's unblocked and should continue.
    if (wasDeferred)
      queueSteerEvent(db, taskId, `This task was un-deferred${note ? `: ${note}` : ""} — re-read your last steps, emit a status note, and continue.`, "un-deferred");
    return json({ task }, 201);
  }

  // --- status / blocked / generic ---
  const event = writeEvent(db, { task_id: taskId, source, type, payload: { note } });
  return json({ event }, 201);
}

// Horizon for a deferral: an explicit ISO --until, or now + --days, or a
// far-future sentinel for an indefinite defer (cleared only by un-defer).
const INDEFINITE_DEFER = "9999-12-31T00:00:00.000Z";
function deferUntil(until?: string, days?: string): string {
  if (until) {
    const t = Date.parse(String(until));
    if (Number.isFinite(t)) return new Date(t).toISOString();
  }
  const n = Number(days);
  if (Number.isFinite(n) && n > 0) return new Date(Date.now() + n * 86_400_000).toISOString();
  return INDEFINITE_DEFER;
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
    cache_write_tokens: int(fields.cache_write_tokens),
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
  // Hook totals are CUMULATIVE per session (whole-transcript sums, one Stop per
  // turn). A session_id makes ingestion an UPSERT — one row per
  // (task, session, model) that converges on the final total — via a
  // deterministic id. Without it (older hooks, manual posts) each POST is its
  // own row, which double-counts interactive sessions.
  const sessionId = typeof fields.session_id === "string" && fields.session_id ? fields.session_id : null;
  const id = sessionId
    ? "use_" + new Bun.CryptoHasher("sha256").update(`${taskId}|${sessionId}|${model}`).digest("hex").slice(0, 16)
    : newId("use");
  const row = {
    id,
    task_id: taskId,
    ts: now(),
    model,
    ...tokens,
    cost_usd: cost,
    source,
  };
  db.query(
    `INSERT OR REPLACE INTO usage (id, task_id, ts, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, source)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(row.id, row.task_id, row.ts, row.model, row.input_tokens, row.output_tokens, row.cache_read_tokens, row.cache_write_tokens, row.cost_usd, row.source);
  broadcast({ type: "usage", usage: row });
  // Cost lands here per turn — the guardrail check belongs where the number is
  // freshest (warn steer at cost_warn_usd, decision card at cost_cap_usd).
  try {
    checkCostGuardrails(db, taskId);
  } catch (e) {
    console.error("[hive] cost guardrails:", e);
  }
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
    COALESCE(SUM(${p}cache_write_tokens),0) AS cache_write_tokens,
    COALESCE(SUM(${p}input_tokens + ${p}output_tokens + ${p}cache_read_tokens + ${p}cache_write_tokens),0) AS total_tokens,
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
  // Text evidence is UTF-8 (agents write Korean captions/reports); without an
  // explicit charset the browser guesses and mangles it (seen live 2026-07-10).
  if (/\.(md|markdown|txt|log|tsv|csv|json|py|ts|js|sh|yaml|yml|toml)$/i.test(rel)) {
    const mime = /\.(md|markdown)$/i.test(rel) ? "text/markdown" : /\.json$/i.test(rel) ? "application/json" : "text/plain";
    return new Response(f, { headers: { "Content-Type": `${mime}; charset=utf-8` } });
  }
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

// The context an open card needs to be decided in one pass, derived (never
// stored) from live tables so it can't go stale: what the director already
// chose on this project, the concrete artifact (PR/branch) the call affects,
// and what the task has cost so far. Attached as `bundle` to every OPEN card
// the client renders. ponytail: "relevant prior" = same-project + most-recent
// answered, not semantic match — upgrade to title similarity if this gets noisy.
export function decisionBundle(db: DB, taskId: string, decisionId: string): any {
  const task = getTask(db, taskId);
  if (!task) return null;
  const prior = (
    db
      .query(
        `SELECT dc.id, dc.title, dc.answer_key, dc.answered_at, dc.options
           FROM decisions dc JOIN tasks t ON t.id = dc.task_id
          WHERE t.project_id = ? AND dc.status = 'answered' AND dc.id != ?
          ORDER BY dc.answered_at DESC LIMIT 3`
      )
      .all(task.project_id, decisionId) as any[]
  ).map((r) => {
    const opts = JSON.parse(r.options || "[]");
    const chosen = opts.find((o: any) => o.key === r.answer_key);
    return { id: r.id, title: r.title, answer: chosen?.label ?? r.answer_key ?? null, answered_at: r.answered_at };
  });
  return {
    task_number: task.number ?? null,
    pr_url: task.pr_url ?? null,
    branch: task.branch ?? null,
    spend_usd: +taskSpend(db, taskId).toFixed(2),
    prior_decisions: prior,
  };
}

// Attach the derived bundle to a parsed decision. Cheap enough to run on every
// open card at fetch/broadcast time; skipped implicitly for terminal cards that
// callers never pass here.
export function withBundle(db: DB, d: any): any {
  return { ...d, bundle: decisionBundle(db, d.task_id, d.id) };
}

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
  writeEvent(db, { task_id: d.task_id, source: "agent", type: "needs-decision", payload: { decision_id: row.id, title: row.title } });
  // Move task into needs_decision if the current state allows it.
  const task = getTask(db, d.task_id);
  if (canTransition(task.state, "needs_decision")) {
    transition(db, d.task_id, "needs_decision", { source: "agent", reason: row.title });
  }
  // Enrich AFTER the transition so the bundle's spend/PR reflect current state.
  const decision = withBundle(db, parseDecision(row));
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
  return json(rows.map((r) => withBundle(db, parseDecision(r))));
}

// Autosave: overwrite draft_note only. Cheap, called on every keystroke (debounced).
function saveDraft(db: DB, id: string, body: any): Response {
  const r = db.query("SELECT 1 FROM decisions WHERE id = ?").get(id);
  if (!r) return err("decision not found", 404);
  db.query("UPDATE decisions SET draft_note = ? WHERE id = ?").run(body?.draft_note ?? "", id);
  return json({ ok: true, id });
}

// Who is allowed to answer a decision. Recorded for audit-trail integrity so a
// chat-supervisor (or any API caller) answering is not logged as the director.
// This is identity only — it grants nothing and gates nothing.
const ANSWER_SOURCES = ["director", "chat_supervisor", "agent", "system", "unknown"] as const;

export function apiAnswerDecision(db: DB, herdr: Herdr, id: string, body: any): Response {
  const r: any = db.query("SELECT * FROM decisions WHERE id = ?").get(id);
  if (!r) return err("decision not found", 404);
  if (r.status !== "open") return err(`decision already ${r.status}`, 409);
  const answerKey = body?.answer_key;
  if (!answerKey) return err("answer_key is required");
  const options: any[] = JSON.parse(r.options || "[]");
  if (options.length && !options.some((o) => o.key === answerKey))
    return err(`answer_key '${answerKey}' is not one of the options`, 400);

  // Caller identity. A missing source is NOT assumed to be the director — the
  // web UI now sends source:"director" explicitly, so a bare call is a caller
  // we cannot vouch for ("unknown"). A present-but-invalid source is rejected.
  const answeredBy = body?.source ?? "unknown";
  if (!ANSWER_SOURCES.includes(answeredBy))
    return err(`source '${answeredBy}' is not one of ${ANSWER_SOURCES.join("|")}`, 400);
  const answeredActor = body?.actor ?? null;

  const answeredAt = now();
  const answerNote = body?.answer_note ?? r.draft_note ?? null;
  db.query(
    "UPDATE decisions SET status = 'answered', answer_key = ?, answer_note = ?, answered_at = ?, answered_by = ?, answered_actor = ? WHERE id = ?"
  ).run(answerKey, answerNote, answeredAt, answeredBy, answeredActor, id);

  writeEvent(db, {
    task_id: r.task_id,
    source: answeredBy,
    type: "decision_answered",
    payload: { decision_id: id, answer_key: answerKey, answer_note: answerNote, answered_by: answeredBy, actor: answeredActor },
  });
  // Each specialized resolver returns true if it OWNED this card (and did its
  // own agent-facing action). A card no resolver claims is a plain question
  // from the agent — its answer must be relayed to the agent below, or the
  // answer never reaches whoever asked (the #163 stall: a live agent parked on
  // a question, answered in the UI, never told).
  const claimed = [
    // approve → mint 24h grant (agent retries); deny → steer the reason.
    resolveGrantForDecision(db, id, answerKey, now, answerNote),
    resolveDenyGuardrailForDecision(db, id, answerKey),
    resolvePlanForDecision(db, id, answerKey),
    resolveRecoveryForDecision(db, id, answerKey),
    resolveBlockedForDecision(db, herdr, id, answerKey),
    resolveDuplicateForDecision(db, id, answerKey),
    resolveCostCapForDecision(db, id, answerKey),
    resolveRefCaptureForDecision(db, id, answerKey, answerNote),
  ].some(Boolean);
  if (!claimed) {
    const label = options.find((o) => o.key === answerKey)?.label ?? answerKey;
    queueSteerEvent(
      db,
      r.task_id,
      `Director answered your decision "${r.title}": ${label}.` + (answerNote ? ` ${answerNote}` : "") + " Proceed on this basis.",
      "queued by decision answer"
    );
    // A genuine product/preference question (no resolver owned it) is a durable
    // project fact — persist it so the next crew consults the answer instead of
    // re-raising the same card.
    recordDecisionKnowledge(db, id, answerKey, answerNote);
  }
  // Resume the task if it was parked on this decision. (herdr `agent send` is Phase 2.)
  const task = getTask(db, r.task_id);
  if (task && task.state === "needs_decision")
    transition(db, r.task_id, "in_progress", { source: answeredBy, reason: "decision answered" });

  const decision = parseDecision({ ...r, status: "answered", answer_key: answerKey, answer_note: answerNote, answered_at: answeredAt, answered_by: answeredBy, answered_actor: answeredActor });
  broadcast({ type: "decision", decision });
  return json(decision);
}

// The chat supervisor's auto-approve path. Runs the server-enforced bar
// (evaluateAutoApprove); if it clears, answers the card tagged as
// source:"chat_supervisor" (so it's forensically distinct from a director click)
// and writes an `auto_approved` audit event carrying the category + reason.
// If it doesn't clear, answers NOTHING, leaves the card open for the director,
// logs `auto_approve_declined`, and returns 403 so the supervisor knows to
// escalate. The verdict — not the caller's identity — is the gate.
export function apiAutoAnswerDecision(db: DB, herdr: Herdr, id: string, body: any): Response {
  const r: any = db.query("SELECT * FROM decisions WHERE id = ?").get(id);
  if (!r) return err("decision not found", 404);
  if (r.status !== "open") return err(`decision already ${r.status}`, 409);
  const answerKey = body?.answer_key;
  if (!answerKey) return err("answer_key is required");

  const verdict = evaluateAutoApprove(db, r, answerKey);
  if (!verdict.allow) {
    writeEvent(db, {
      task_id: r.task_id,
      source: "chat_supervisor",
      type: "auto_approve_declined",
      payload: { decision_id: id, answer_key: answerKey, category: verdict.category, reason: verdict.reason },
    });
    return json({ effect: "escalate", category: verdict.category, reason: verdict.reason }, 403);
  }

  // Audit FIRST (who + why), so the record survives even if the answer path
  // below throws. The supervisor's own note, if any, rides alongside the reason.
  writeEvent(db, {
    task_id: r.task_id,
    source: "chat_supervisor",
    type: "auto_approved",
    payload: { decision_id: id, answer_key: answerKey, category: verdict.category, reason: verdict.reason, note: body?.answer_note ?? null },
  });
  return apiAnswerDecision(db, herdr, id, { ...body, source: "chat_supervisor" });
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
  // An authority card's pending grant must die with it: left 'pending', every
  // retry of the gated command resolves to this expired decision id and the
  // agent waits on it forever (19 of 28 approval cards expired exactly this way).
  // Denying makes the retry open a FRESH card; the steer below says don't retry.
  const wasAuthority = resolveGrantForDecision(db, id, "deny");
  {
    const t = getTask(db, r.task_id);
    if (t && !TERMINAL.includes(t.state as State))
      queueSteerEvent(
        db,
        r.task_id,
        `The director dismissed your decision card "${r.title}" without answering — it is gone, do not wait ` +
          `on it or retry the same request. ${wasAuthority ? "The gated command stays unapproved; find another way (or narrow the command so the gate passes). " : ""}` +
          `Proceed with your best judgment and note the call as a checkpoint.`,
        "queued by decision dismiss"
      );
  }
  // Resume the task if this was its LAST open card — otherwise it stays parked
  // in needs_decision with nothing left to wait on (seen live 2026-07-10:
  // three agents stranded after their moot approval cards were dismissed).
  const remaining = db
    .query("SELECT 1 FROM decisions WHERE task_id = ? AND status = 'open' LIMIT 1")
    .get(r.task_id);
  const task = getTask(db, r.task_id);
  if (!remaining && task && task.state === "needs_decision")
    transition(db, r.task_id, "in_progress", { source: "director", reason: "last open decision dismissed" });
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
    summary: body.summary ?? null,
  });
  if (r.effect === "allow") return json({ ok: true, effect: "allow" });
  if (r.effect === "deny") return json({ ok: false, effect: "deny", error: r.reason }, 403);
  // Command cards get an async plain-English explanation appended while open —
  // never blocks the gate response.
  if (String(body.action).startsWith("command."))
    void explainCommandDecision(db, r.decision_id, String(body.target));
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
function createPolicy(db: DB, herdr: Herdr, body: any): Response {
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
  // Live agents' briefs are frozen at spawn; without this every protocol change
  // was hand-steered to each agent ("your brief predates it", 8 agents × 3
  // iterations observed). New policy → automatic broadcast to its scope.
  if (row.active) {
    const projectId = scope.startsWith("project:") ? scope.slice("project:".length) : undefined;
    void steerLiveAgents(
      db,
      herdr,
      `Protocol update (a standing policy was just added — it applies to you NOW, your brief predates it):\n### ${row.title}\n${row.body}`,
      projectId
    );
  }
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
