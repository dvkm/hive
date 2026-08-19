// HTTP routing for hive. Plain Bun.serve routing by hand (zero deps).
// The exact request/response contract lives in docs/API.md.
import { dirname, join, normalize } from "node:path";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import type { DB } from "./db.ts";
import { newId, now, evidenceDir, isOffline, setSetting, getSetting } from "./db.ts";
import { taskWithHealth, broadcastTask, needsAttention, herdrOutage, sessionUtilization } from "./health.ts";
import { isSupervisedTask, supervisedSql } from "./supervision.ts";
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
  decisionAnswerUnaddressed,
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
import { Herdr, herdr as defaultHerdr, sendFailure, isHerdrUnreachable } from "./runtime/herdr.ts";
import { queuedSteers, markSteersDelivered, steerPreamble, queueSteerEvent, type Delivery } from "./steer.ts";
import { cleanupTask, runStackCmd } from "./cleanup.ts";
import { resolveProjectSecrets } from "./secrets.ts";
import { smokeThenAdvance, type Fetcher } from "./monitors.ts";
import { enqueue, ackNotifications } from "./notifications.ts";
import { authorize, resolveGrantForDecision, resolveDenyGuardrailForDecision, type AuthzInput } from "./authority.ts";
import { isReviewed } from "./dispatcher.ts";
import { runPlanner, resolvePlanForDecision, decisionPlan, selectedPlanIndices, type PlannerExec } from "./planner.ts";
import { routeIntakeProject } from "./intake/route.ts";
import { detectDuplicate, mergeInto, openDuplicateDecision, resolveDuplicateForDecision, duplicateClusters } from "./dedup.ts";
import { noteRepoMismatch, resolveRepoMismatchForDecision } from "./repoTarget.ts";
import { costUsd } from "./pricing.ts";
import { checkCostGuardrails, resolveCostCapForDecision, taskSpend } from "./costs.ts";
import { evaluateAutoApprove, evaluateAutopilotApprove } from "./autoapprove.ts";
import { vapidPublicKey, saveSubscription, removeSubscription } from "./push.ts";
import { explainCommandDecision } from "./explain.ts";
import { autoResumeOnTurnEnd } from "./resume.ts";
import { ciStatusOf } from "./reconciler.ts";
import { taskDiff } from "./diff.ts";
import { captureBranchScope, detectDestructiveRebase, type BranchScope } from "./rebaseGuard.ts";
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
  managingThreadForTask,
  updateThreadRun,
  supervisorArtifacts,
  listCommitments,
  createCommitment,
  updateCommitment,
  projectAutonomyProfile,
  SUPERVISOR_PHASES,
  AUTONOMY_PROFILES,
  COMMITMENT_STATUSES,
  type ChatThread,
} from "./chat.ts";

export interface HandlerDeps {
  herdr?: Herdr; // injectable for tests
  supervise?: boolean; // start the herdr wait loop after spawn (true in prod wiring)
  plannerExec?: PlannerExec; // injectable planner subprocess (domain supervisors)
  exec?: Exec; // injectable gh/git subprocess (diff + merge); tests pass a stub
  fetch?: Fetcher; // injectable smoke-check fetcher (post-merge); tests pass a stub
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
  async function handle(req: Request, server?: { requestIP?: (r: Request) => { address: string } | null }): Promise<Response> {
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
        return json({ ok: true, version: VERSION, dispatcher: loopLiveness(db, "last_dispatch_at", DISPATCH_STALE_MS), reaper: loopLiveness(db, "last_reap_at", REAP_STALE_MS), herdr_outage: herdrOutage(db), sessions: sessionUtilization(db) });

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
        const m = pathname.match(/^\/api\/chat\/threads\/([^/]+)\/run$/);
        if (m && method === "PUT") return updateSupervisorRun(db, m[1], await req.json());
      }
      {
        const m = pathname.match(/^\/api\/chat\/threads\/([^/]+)\/meetings$/);
        if (m && method === "POST") return await recordManagerMeeting(db, herdr, m[1], await req.json());
      }
      {
        const m = pathname.match(/^\/api\/chat\/threads\/([^/]+)\/commitments$/);
        if (m && method === "POST") return recordCommitment(db, m[1], await req.json());
      }
      {
        const m = pathname.match(/^\/api\/chat\/threads\/([^/]+)\/commitments\/([^/]+)$/);
        if (m && method === "PUT") return reviseCommitment(db, m[1], m[2], await req.json());
      }
      {
        const m = pathname.match(/^\/api\/chat\/threads\/([^/]+)\/verifications$/);
        if (m && method === "POST") return recordManagerVerification(db, m[1], await req.json());
      }
      {
        const m = pathname.match(/^\/api\/chat\/threads\/([^/]+)\/verifications\/([^/]+)\/replay$/);
        if (m && method === "POST") return await replayManagerVerification(db, herdr, deps, m[1], m[2]);
      }
      {
        const m = pathname.match(/^\/api\/chat\/threads\/([^/]+)\/retrospectives$/);
        if (m && method === "POST") return recordManagerRetrospective(db, m[1], await req.json());
      }
      {
        const m = pathname.match(/^\/api\/chat\/threads\/([^/]+)$/);
        if (m && method === "GET") {
          const thread = getThread(db, m[1]);
          if (!thread) return err("thread not found", 404);
          return json({ ...thread, ...supervisorArtifacts(db, m[1]), commitments: listCommitments(db, m[1]), messages: listMessages(db, m[1]) });
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
      if (m && method === "POST") return await doTransition(db, m[1], await req.json(), deps);

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

      if (pathname === "/api/checkpoints" && method === "GET") return listOpenCheckpoints(db, url);
      if (pathname === "/api/understanding-quizzes" && method === "GET") return listUnderstandingQuizzes(db, url);

      if (pathname === "/api/offline" && method === "GET")
        return json({ on: isOffline(db) });
      if (pathname === "/api/offline" && method === "POST")
        return await setOffline(db, herdr, await req.json());
      m = pathname.match(/^\/api\/tasks\/([^/]+)\/checkpoints\/([^/]+)\/ack$/);
      if (m && method === "POST") return await ackCheckpoint(db, herdr, m[1], m[2], await req.json());
      m = pathname.match(/^\/api\/tasks\/([^/]+)\/understanding-quiz\/answer$/);
      if (m && method === "POST") return answerUnderstandingQuiz(db, m[1], await req.json());
      m = pathname.match(/^\/api\/tasks\/([^/]+)\/understanding-quiz\/defer$/);
      if (m && method === "POST") return deferUnderstandingQuiz(db, m[1], await req.json());

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
      if (m && method === "POST") return await requestChanges(db, herdr, m[1], await req.json(), deps);

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
          const r: any = db.query("SELECT id, root_cause_task_id FROM learnings WHERE id = ?").get(m[1]);
          cancelQueuedRootCauseTask(db, r, "root-cause learning deleted");
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
  }

  return async (req: Request, server?: { requestIP?: (r: Request) => { address: string } | null }): Promise<Response> => {
    const pathname = new URL(req.url).pathname;
    const match = pathname.match(/^\/api\/tasks\/([^/]+)(?:\/(.*))?$/);
    const taskId = match && getTask(db, match[1]) ? match[1] : null;
    const before = taskId
      ? ((db.query("SELECT COALESCE(MAX(rowid), 0) AS rowid FROM events WHERE task_id = ?").get(taskId) as { rowid: number }).rowid)
      : 0;
    const response = await handle(req, server);
    if (taskId && !response.ok && response.status !== 401) {
      const alreadyRecorded = db.query("SELECT 1 FROM events WHERE task_id = ? AND rowid > ? LIMIT 1").get(taskId, before);
      if (!alreadyRecorded) {
        let reason = response.statusText || `HTTP ${response.status}`;
        try {
          const body = await response.clone().json() as { error?: unknown };
          if (body?.error) reason = String(body.error);
        } catch {}
        writeEvent(db, {
          task_id: taskId,
          source: "system",
          type: "action_failed",
          payload: { action: `${req.method} /${match![2] || "task"}`, status: response.status, reason },
        });
      }
    }
    return response;
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
  if (body?.config?.autonomy_profile != null && !AUTONOMY_PROFILES.includes(body.config.autonomy_profile))
    return err(`autonomy_profile must be one of ${AUTONOMY_PROFILES.join("|")}`);
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
  // corebeat braindump lands in the corebeat repo and not wherever the UI sat.
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
    return json(await chatTurnOnThread(db, herdr, deps, thread, text), 202);
  }

  const chief = body?.scope === "chief";
  const projectId = chief ? null : body?.project_id ? String(body.project_id) : null;
  if (!chief && !projectId) return err("project_id is required to start a chat (the supervisor session runs in the project's repo)");
  if (projectId && !db.query("SELECT 1 FROM projects WHERE id = ?").get(projectId)) return err("unknown project_id", 400);
  if (chief && !coordinatorProjectId(db)) return err("at least one project with a repository is required", 400);

  // A brand-new chat has no thread_id yet, so two concurrent first-messages
  // (a UI double-submit before the client gets a thread_id back) each used to
  // call createThread independently, producing two threads/tasks/spawns for
  // what the user experienced as one message. Dedupe on (project, text): a
  // genuine double-submit repeats the exact text within the same tick, so the
  // second request rides the first's in-flight thread-creation + delivery
  // instead of racing its own.
  const dedupeKey = `${projectId ?? "chief"}\0${text}`;
  let pending = pendingNewChats.get(dedupeKey);
  if (!pending) {
    pending = (async () => {
      const thread =
        (chief ? listThreads(db).find((candidate) => candidate.project_id === null) : null) ??
        createThread(db, {
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
  const wireMessage = thread.project_id
    ? message
    : `${message}\n\n[chief reply policy]\nWork silently. Do not send acknowledgments, progress updates, task lists, or wakeup summaries. If director input is genuinely required, send one short bundled reply with up to five \`--decision <id>\` flags so Hive renders answerable cards. Otherwise reply only with a direct answer or the final verified outcome.`;

  // Reuse (or create) the backing supervisor task — a plain chore task whose
  // agent IS the session. source='chat_supervisor' keeps it out of the
  // dispatcher and the normal board lanes; it is infrastructure, not a deliverable.
  let taskId = thread.task_id;
  let task = taskId ? getTask(db, taskId) : null;
  // A closed (terminal — see chatClose) supervisor task is never resurrected;
  // a message to a closed thread starts a fresh session, same thread.
  if (!task || TERMINAL.includes(task.state as State)) {
    const runtimeProjectId = thread.project_id ?? coordinatorProjectId(db);
    if (!runtimeProjectId) return { delivery: "failed", error: "no project repository is available for the Chief of Staff session" };
    taskId = newId();
    const t = now();
    db.query(
      `INSERT INTO tasks (id, project_id, title, brief, state, kind, source, created_at, updated_at)
       VALUES (?,?,?,?, 'in_progress', 'chore', 'chat_supervisor', ?, ?)`
    ).run(taskId, runtimeProjectId, `[chat] ${thread.project_id ? "supervisor" : "Chief of Staff"}: ${thread.title ?? thread.id}`, null, t, t);
    writeEvent(db, { task_id: taskId, source: "director", type: "created", payload: { title: `[chat] ${thread.project_id ? "supervisor" : "Chief of Staff"} session`, thread_id: thread.id } });
    setThreadTask(db, thread.id, taskId);
    task = getTask(db, taskId);
  }

  // Is the session already live? If so, just send into it (fast path).
  if (task.agent_target) {
    const { alive } = await herdr.probe(task.agent_target).catch(() => ({ alive: false }));
    if (alive) {
      const error = await sendOnce(herdr, task.agent_target, wireMessage);
      if (!error) {
        writeEvent(db, { task_id: taskId!, source: "director", type: "steer", payload: { message: wireMessage, target: task.agent_target, delivery: "delivered", delivered_at: now() } });
        return { delivery: "delivered", agent_target: task.agent_target };
      }
      // fall through to respawn on a send failure to a supposedly-live agent
    }
  }

  // Not live: queue the message (it rides in the spawn brief) and spawn.
  queueSteerEvent(db, taskId!, wireMessage, "queued for chat supervisor spawn");
  const r = await spawnAgent(db, herdr, taskId!, {
    supervise: false, // a standing session never "finishes into review"
    briefOverride: composeSupervisorBrief(db, thread),
  });
  if (!r.ok) return { delivery: "failed", error: r.error };
  return { delivery: "spawned", agent_target: r.agent_target };
}

function coordinatorProjectId(db: DB): string | null {
  const row = db
    .query(
      `SELECT id FROM projects
       WHERE repo_path IS NOT NULL AND COALESCE(json_extract(config, '$.archived'), 0) = 0
       ORDER BY CASE WHEN lower(name) = 'hive' THEN 0 ELSE 1 END, created_at
       LIMIT 1`
    )
    .get() as { id: string } | undefined;
  return row?.id ?? null;
}

// Meaningful worker events wake the manager that owns the task. Without managed
// ancestry, an active Chief of Staff is the portfolio-wide fallback.
// One microtask folds synchronous multi-event transitions (needs-decision +
// state_change, ready_for_review + state_change) into one steer instead of
// making the manager react twice to one fact.
const MANAGER_EVENT_TYPES = new Set([
  "checkpoint",
  "needs-decision",
  "blocked",
  "blocked_card",
  "dependency_blocked",
  "ready_for_review",
  "ready_held",
  "answer",
  "auto_review",
  "auto_review_error",
  "changes_requested",
  "ci_failure",
  "pr_closed",
  "pr_conflict",
  "pr_merged",
  "merge_failed",
  "auto_merged",
  "smoke_failed",
  "smoke_passed",
  "verify_wedged",
  "spawn_error",
  "planner_error",
  "stale",
  "recovery",
  "requeued",
  "usage_limit",
]);

type ManagerPending = {
  db: DB;
  herdr: Herdr;
  deps: HandlerDeps;
  events: any[];
};
const pendingManagerUpdates = new Map<string, ManagerPending>();

function managerEventRelevant(event: any): boolean {
  if (event.type === "state_change")
    return ["needs_decision", "in_review", "verifying", "done", "failed", "cancelled"].includes(event.payload?.to);
  // Peer-to-peer messages are copied to the manager. Messages sent BY the
  // manager are excluded later so its own coordination does not echo back.
  if (event.type === "steer") return !!event.payload?.from_task_id;
  return MANAGER_EVENT_TYPES.has(event.type);
}

function managerEventLine(db: DB, event: any): string {
  const task = getTask(db, event.task_id);
  const p = event.payload ?? {};
  const detail = p.note ?? p.title ?? p.error ?? p.reason ?? p.original_message ?? p.message ?? p.decision ?? p.to ?? p.ci_status ?? "";
  const suffix = detail ? ` — ${String(detail).replace(/\s+/g, " ").slice(0, 180)}` : "";
  return `- #${task?.number ?? "?"} ${task?.title ?? event.task_id} [${task?.state ?? "unknown"}]: ${event.type}${suffix}`;
}

function activeManagerForProject(db: DB, projectId: string): ChatThread | null {
  return (
    (db
      .query(
        `SELECT c.* FROM chat_threads c
           JOIN tasks t ON t.id = c.task_id
          WHERE c.project_id = ? AND t.source = 'chat_supervisor'
            AND t.state NOT IN ('done', 'failed', 'cancelled')
          ORDER BY c.updated_at DESC LIMIT 1`
      )
      .get(projectId) as ChatThread | undefined) ?? null
  );
}

function activeChiefOfStaff(db: DB): ChatThread | null {
  return (
    (db
      .query(
        `SELECT c.* FROM chat_threads c
           JOIN tasks t ON t.id = c.task_id
          WHERE c.project_id IS NULL AND t.source = 'chat_supervisor'
            AND t.state NOT IN ('done', 'failed', 'cancelled')
          ORDER BY c.updated_at DESC LIMIT 1`
      )
      .get() as ChatThread | undefined) ?? null
  );
}

function activeManager(db: DB): ChatThread | null {
  return (
    (db
      .query(
        `SELECT c.* FROM chat_threads c
           JOIN tasks t ON t.id = c.task_id
          WHERE t.source = 'chat_supervisor'
            AND t.state NOT IN ('done', 'failed', 'cancelled')
          ORDER BY c.updated_at DESC LIMIT 1`
      )
      .get() as ChatThread | undefined) ?? null
  );
}

async function flushManagerUpdate(threadId: string): Promise<void> {
  const pending = pendingManagerUpdates.get(threadId);
  if (!pending) return;
  pendingManagerUpdates.delete(threadId);
  const current = getThread(pending.db, threadId);
  if (!current?.task_id) return;
  const manager = getTask(pending.db, current.task_id);
  if (!manager || TERMINAL.includes(manager.state as State)) return; // explicitly closed thread
  const lines = pending.events.slice(-20).map((event) => managerEventLine(pending.db, event));
  const projectIds = [
    ...new Set(
      pending.events
        .map((event) => getTask(pending.db, event.task_id)?.project_id)
        .filter((projectId): projectId is string => !!projectId)
    ),
  ];
  const message = [
    `[hive manager wakeup]`,
    `Worker state changed under the top-level ask you own:`,
    ...lines,
    ``,
    `Inspect the affected tasks and current team state now. Act on anything you can resolve: coordinate peers, answer a reversible technical decision, revise or add work, or verify completion. Escalate to the director only at the decision boundary in your manager brief.`,
    ...projectIds.map(
      (projectId) =>
        `Also sweep GET $HIVE_URL/api/checkpoints?project_id=${projectId} and $HIVE_URL/api/decisions?status=open&project_id=${projectId}. For a safe checkpoint, POST its ack endpoint with {"verdict":"ok","source":"chat_supervisor","actor":"${current.id}"}. Read the task context first; leave risky, ambiguous, preference-based, and merge items for the director.`
    ),
  ].join("\n");
  await withThreadLock(threadId, () => deliverToSupervisor(pending.db, pending.herdr, pending.deps, threadId, message));
}

export function notifyManagerOfEvent(db: DB, herdr: Herdr, deps: HandlerDeps, event: any): void {
  if (!managerEventRelevant(event)) return;
  const origin = getTask(db, event.task_id);
  if (!origin || !isSupervisedTask(origin)) return;
  const thread = managingThreadForTask(db, event.task_id) ?? activeChiefOfStaff(db) ?? activeManagerForProject(db, origin.project_id) ?? activeManager(db);
  if (!thread?.task_id) return;
  if (event.type === "steer" && event.payload?.from_task_id === thread.task_id) return;

  const existing = pendingManagerUpdates.get(thread.id);
  if (existing) {
    existing.events.push(event);
    return;
  }
  queueMicrotask(() => {
    flushManagerUpdate(thread.id).catch((e) => console.error(`[hive] manager wakeup ${thread.id}:`, e));
  });
  pendingManagerUpdates.set(thread.id, { db, herdr, deps, events: [event] });
}

export function projectInboxCounts(db: DB, projectId: string): { checkpoints: number; decisions: number; reviews: number; attention: number } {
  const checkpoints = Number(
    (db
      .query(
        `SELECT COUNT(*) AS n FROM events e JOIN tasks t ON t.id = e.task_id
          WHERE e.type = 'checkpoint' AND t.project_id = ? AND t.state != 'cancelled' AND ${supervisedSql("t.source", "t.agent_target")}
            AND NOT EXISTS (
              SELECT 1 FROM events a
               WHERE a.task_id = e.task_id AND a.type = 'checkpoint_ack'
                 AND json_extract(a.payload, '$.checkpoint_id') = e.id)`
      )
      .get(projectId) as { n: number }).n
  );
  const decisions = Number(
    (db
      .query(`SELECT COUNT(*) AS n FROM decisions d JOIN tasks t ON t.id = d.task_id WHERE d.status = 'open' AND t.project_id = ? AND ${supervisedSql("t.source", "t.agent_target")}`)
      .get(projectId) as { n: number }).n
  );
  const reviews = Number(
    (db.query(`SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND state = 'in_review' AND ${supervisedSql()}`).get(projectId) as { n: number }).n
  );
  const tasks = db.query("SELECT * FROM tasks WHERE project_id = ?").all(projectId).map((task) => taskWithHealth(db, parseTask(task)));
  const attention = tasks.filter(needsAttention).length;
  return { checkpoints, decisions, reviews, attention };
}

// One startup pass handles inbox items created before manager wakeups existed.
// New items are event-driven through notifyManagerOfEvent, including work that
// was not originally delegated by an active manager.
export async function sweepManagerInboxes(db: DB, herdr: Herdr, deps: HandlerDeps): Promise<number> {
  const active = db
    .query(
      `SELECT c.* FROM chat_threads c
         JOIN tasks t ON t.id = c.task_id
        WHERE t.source = 'chat_supervisor' AND t.state NOT IN ('done', 'failed', 'cancelled')
        ORDER BY c.updated_at DESC`
    )
    .all() as ChatThread[];
  if (!active.length) return 0;
  const chief = active.find((thread) => !thread.project_id);
  const byProject = new Map(active.filter((thread) => thread.project_id).map((thread) => [thread.project_id!, thread]));
  const fallback = chief ?? active[0];
  const assignments = new Map<string, { thread: ChatThread; projects: { id: string; name: string; counts: ReturnType<typeof projectInboxCounts> }[] }>();
  for (const project of db.query("SELECT id, name FROM projects ORDER BY created_at").all() as { id: string; name: string }[]) {
    const counts = projectInboxCounts(db, project.id);
    const total = counts.checkpoints + counts.decisions + counts.reviews + counts.attention;
    if (!total) continue;
    const thread = chief ?? byProject.get(project.id) ?? fallback;
    const assignment = assignments.get(thread.id) ?? { thread, projects: [] };
    assignment.projects.push({ id: project.id, name: project.name, counts });
    assignments.set(thread.id, assignment);
  }
  let notified = 0;
  for (const { thread, projects } of assignments.values()) {
    const total = projects.reduce(
      (sum, project) => sum + project.counts.checkpoints + project.counts.decisions + project.counts.reviews + project.counts.attention,
      0
    );
    const message = [
      `[hive manager wakeup]`,
      `Project inbox sweep: ${total} open item${total === 1 ? "" : "s"} across ${projects.length} project${projects.length === 1 ? "" : "s"}:`,
      ...projects.map(({ id, name, counts }) => `- ${name} (${id}): ${counts.checkpoints} checkpoints, ${counts.decisions} decisions, ${counts.reviews} reviews, ${counts.attention} failed or stuck tasks`),
      `Inspect every listed project inbox now and work through every low-risk item allowed by your manager brief. Read each item's task context before acting. Create corrective workers in that item's project. Leave merges and any risky, ambiguous, or preference-based choice for the director.`,
      ...projects.map(({ id }) => `Use GET $HIVE_URL/api/checkpoints?project_id=${id} and $HIVE_URL/api/decisions?status=open&project_id=${id}.`),
      `For a safe checkpoint, POST its ack endpoint with {"verdict":"ok","source":"chat_supervisor","actor":"${thread.id}"}.`,
    ].join("\n");
    await withThreadLock(thread.id, () => deliverToSupervisor(db, herdr, deps, thread.id, message));
    notified++;
  }
  return notified;
}

// Resume waiting runs whose durable wakeup time has arrived. Clear the cursor
// before delivery so overlapping timer ticks cannot wake the same run twice;
// deliverToSupervisor durably queues the message when a session must respawn.
export async function wakeDueManagers(db: DB, herdr: Herdr, deps: HandlerDeps): Promise<number> {
  const due = db
    .query(
      `SELECT c.id FROM chat_threads c JOIN tasks t ON t.id = c.task_id
       WHERE c.phase = 'waiting' AND c.wakeup_at IS NOT NULL AND c.wakeup_at <= ?
         AND t.source = 'chat_supervisor' AND t.state NOT IN ('done','failed','cancelled')
       ORDER BY c.wakeup_at ASC`
    )
    .all(now()) as { id: string }[];
  for (const { id } of due) {
    const thread = getThread(db, id)!;
    const updated = updateThreadRun(db, id, {
      phase: "executing",
      next_action: thread.waiting_on ? `Resume after waiting on: ${thread.waiting_on}` : "Resume the manager loop",
      waiting_on: null,
      wakeup_at: null,
    })!;
    writeEvent(db, {
      task_id: updated.task_id!,
      source: "system",
      type: "manager_update",
      payload: { thread_id: id, phase: "executing", wakeup_due: true, next_action: updated.next_action },
    });
    broadcast({ type: "chat_thread", thread: updated });
    await withThreadLock(id, () => deliverToSupervisor(db, herdr, deps, id, [
      `[hive manager wakeup]`,
      `The scheduled wait has ended for: ${thread.objective ?? thread.title ?? id}`,
      thread.waiting_on ? `You were waiting on: ${thread.waiting_on}` : "",
      `Resume the run now, inspect current team state and inboxes, and update the ledger before stopping again.`,
    ].filter(Boolean).join("\n")));
  }
  return due.length;
}

// The supervisor session posts its reply to the director here (via
// `hive chat reply <thread> "..."`). Loopback-only in practice (agents run on
// localhost); appends the assistant message and streams it over SSE.
function chatReply(db: DB, threadId: string, body: any): Response {
  const thread = getThread(db, threadId);
  if (!thread) return err("thread not found", 404);
  const text = String(body?.text ?? "").trim();
  if (!text) return err("text is required");
  const requestedDecisionIds = stringList(
    body?.decision_ids === undefined ? [] : ([] as any[]).concat(body.decision_ids),
    6
  );
  if (requestedDecisionIds.length > 5) return err("at most 5 decisions may be attached to one reply");

  const actions: { type: "decision"; decision_id: string; label: string }[] = [];
  for (const decisionId of [...new Set(requestedDecisionIds)]) {
    const decision = db
      .query(
        `SELECT d.id, d.title, d.status, t.project_id
           FROM decisions d JOIN tasks t ON t.id = d.task_id
          WHERE d.id = ?`
      )
      .get(decisionId) as { id: string; title: string; status: string; project_id: string } | undefined;
    if (!decision) return err(`decision not found: ${decisionId}`, 404);
    if (thread.project_id && decision.project_id !== thread.project_id)
      return err(`decision is outside this chat's project: ${decisionId}`, 403);
    if (decision.status === "open")
      actions.push({ type: "decision", decision_id: decision.id, label: decision.title });
  }

  const messages = listMessages(db, threadId);
  const last = messages.at(-1);
  const surfaced = new Set(
    messages.flatMap((message) =>
      message.actions
        .filter((action) => action?.type === "decision" && typeof action.decision_id === "string")
        .map((action) => action.decision_id as string)
    )
  );
  const freshActions = actions.filter((action) => !surfaced.has(action.decision_id));
  const newlyCompleted =
    thread.phase === "complete" && !!thread.completed_at && (!last || thread.completed_at > last.ts);

  // A portfolio Chief works silently between director turns. After it has
  // replied once, only a newly surfaced decision or newly completed outcome
  // may create another message. Routine wakeup chatter is still recorded in
  // the run ledger and activity stream, but never becomes chat spam.
  const repeatedDecisionRequest = requestedDecisionIds.length > 0 && !freshActions.length;
  if (
    !thread.project_id &&
    !newlyCompleted &&
    (repeatedDecisionRequest || (last?.role === "assistant" && !freshActions.length))
  )
    return json({ ok: true, suppressed: true });

  const message = appendMessage(db, threadId, "assistant", text, freshActions);
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

function stringList(value: any, limit = 20): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(String).map((item) => item.trim()).filter(Boolean).slice(0, limit);
}

function validateCommitmentTask(db: DB, thread: ChatThread, projectId: string, taskId: any, label: string): string | Response | null {
  if (taskId == null || String(taskId).trim() === "") return null;
  const id = String(taskId);
  const task = getTask(db, id);
  if (!task) return err(`${label} task not found: ${id}`, 404);
  if (task.project_id !== projectId) return err(`${label} task is outside the commitment project`, 409);
  if (managingThreadForTask(db, id)?.id !== thread.id) return err(`${label} task is not managed by this thread`, 409);
  return id;
}

function validateCommitmentDeps(db: DB, threadId: string, value: any): string[] | Response {
  const ids = [...new Set(stringList(value))];
  for (const id of ids) {
    const row = db.query("SELECT thread_id FROM commitments WHERE id = ?").get(id) as { thread_id: string } | undefined;
    if (!row) return err(`commitment dependency not found: ${id}`, 404);
    if (row.thread_id !== threadId) return err(`commitment dependency is outside this thread: ${id}`, 409);
  }
  return ids;
}

function commitmentDepsReach(db: DB, threadId: string, startIds: string[], targetId: string): boolean {
  const graph = new Map(listCommitments(db, threadId).map((item) => [item.id, item.depends_on]));
  const pending = [...startIds];
  const seen = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!;
    if (id === targetId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    pending.push(...(graph.get(id) ?? []));
  }
  return false;
}

function recordCommitment(db: DB, threadId: string, body: any): Response {
  const thread = getThread(db, threadId);
  if (!thread) return err("thread not found", 404);
  if (!thread.task_id) return err("supervisor session has not started", 409);
  const title = String(body?.title ?? "").trim();
  if (!title) return err("title is required");
  const projectId = thread.project_id ?? String(body?.project_id ?? "").trim();
  if (!projectId) return err("project_id is required for a portfolio commitment");
  if (!db.query("SELECT 1 FROM projects WHERE id = ?").get(projectId)) return err("project not found", 404);
  if (thread.project_id && body?.project_id && String(body.project_id) !== thread.project_id)
    return err("commitment project is outside this thread", 409);

  const sourceMessageId = body?.source_message_id ? String(body.source_message_id) : null;
  const sourceTask = validateCommitmentTask(db, thread, projectId, body?.source_task_id, "source");
  if (sourceTask instanceof Response) return sourceTask;
  if (sourceMessageId && !db.query("SELECT 1 FROM chat_messages WHERE id = ? AND thread_id = ?").get(sourceMessageId, threadId))
    return err("source message is outside this thread", 409);
  if (!sourceMessageId && !sourceTask) return err("source_message_id or source_task_id is required");

  const ownerTask = validateCommitmentTask(db, thread, projectId, body?.owner_task_id, "owner");
  if (ownerTask instanceof Response) return ownerTask;
  const dependsOn = validateCommitmentDeps(db, threadId, body?.depends_on);
  if (dependsOn instanceof Response) return dependsOn;
  const status = body?.status == null ? "open" : String(body.status);
  if (!COMMITMENT_STATUSES.includes(status as any)) return err(`status must be one of ${COMMITMENT_STATUSES.join("|")}`);
  const dueAt = body?.due_at ? String(body.due_at) : null;
  if (dueAt && !Number.isFinite(Date.parse(dueAt))) return err("due_at must be an ISO timestamp");

  const commitment = createCommitment(db, {
    thread_id: threadId,
    project_id: projectId,
    title,
    owner_task_id: ownerTask,
    source_message_id: sourceMessageId,
    source_task_id: sourceTask,
    status: status as any,
    due_at: dueAt,
    depends_on: dependsOn,
  });
  writeEvent(db, {
    task_id: thread.task_id,
    source: "chat_supervisor",
    type: "manager_commitment",
    payload: { thread_id: threadId, commitment_id: commitment.id, action: "created", title, status },
  });
  return json(commitment, 201);
}

function reviseCommitment(db: DB, threadId: string, commitmentId: string, body: any): Response {
  const thread = getThread(db, threadId);
  if (!thread?.task_id) return err(thread ? "supervisor session has not started" : "thread not found", thread ? 409 : 404);
  const current = listCommitments(db, threadId).find((item) => item.id === commitmentId);
  if (!current) return err("commitment not found", 404);
  const patch: any = {};
  if (body?.title !== undefined) {
    patch.title = String(body.title).trim();
    if (!patch.title) return err("title cannot be empty");
  }
  if (body?.status !== undefined) {
    patch.status = String(body.status);
    if (!COMMITMENT_STATUSES.includes(patch.status)) return err(`status must be one of ${COMMITMENT_STATUSES.join("|")}`);
  }
  if (body?.due_at !== undefined) {
    patch.due_at = body.due_at ? String(body.due_at) : null;
    if (patch.due_at && !Number.isFinite(Date.parse(patch.due_at))) return err("due_at must be an ISO timestamp");
  }
  if (body?.owner_task_id !== undefined) {
    const owner = validateCommitmentTask(db, thread, current.project_id, body.owner_task_id, "owner");
    if (owner instanceof Response) return owner;
    patch.owner_task_id = owner;
  }
  if (body?.depends_on !== undefined) {
    const dependencies = validateCommitmentDeps(db, threadId, body.depends_on);
    if (dependencies instanceof Response) return dependencies;
    if (commitmentDepsReach(db, threadId, dependencies, commitmentId)) return err("commitment dependency cycle", 409);
    patch.depends_on = dependencies;
  }
  const commitment = updateCommitment(db, commitmentId, patch)!;
  writeEvent(db, {
    task_id: thread.task_id,
    source: body?.source === "director" ? "director" : "chat_supervisor",
    type: "manager_commitment",
    payload: { thread_id: threadId, commitment_id: commitment.id, action: "updated", ...patch },
  });
  return json(commitment);
}

function updateSupervisorRun(db: DB, threadId: string, body: any): Response {
  const thread = getThread(db, threadId);
  if (!thread) return err("thread not found", 404);
  if (body?.phase !== undefined && !SUPERVISOR_PHASES.includes(body.phase))
    return err(`phase must be one of ${SUPERVISOR_PHASES.join("|")}`);
  if (body?.acceptance_criteria != null && !Array.isArray(body.acceptance_criteria))
    return err("acceptance_criteria must be an array");
  if (body?.wakeup_at && !Number.isFinite(Date.parse(body.wakeup_at)))
    return err("wakeup_at must be an ISO timestamp");

  const patch: any = {};
  for (const key of ["objective", "phase", "next_action", "waiting_on", "wakeup_at", "outcome"])
    if (body?.[key] !== undefined) patch[key] = body[key] == null ? null : String(body[key]).trim() || null;
  if (body?.acceptance_criteria !== undefined) patch.acceptance_criteria = stringList(body.acceptance_criteria);
  if (patch.phase && patch.phase !== "complete") patch.completed_at = null;

  if (patch.phase === "complete") {
    const artifacts = supervisorArtifacts(db, threadId);
    if (artifacts.verifications[0]?.status !== "passed")
      return err("run completion requires the latest verification attempt to pass", 409);
    if (!artifacts.retrospectives.length)
      return err("run completion requires a recorded retrospective", 409);
    patch.completed_at = now();
    patch.next_action = null;
    patch.waiting_on = null;
    patch.wakeup_at = null;
  }

  const updated = updateThreadRun(db, threadId, patch)!;
  if (updated.task_id)
    writeEvent(db, {
      task_id: updated.task_id,
      source: body?.source === "director" ? "director" : "chat_supervisor",
      type: "manager_update",
      payload: { thread_id: threadId, ...patch },
    });
  broadcast({ type: "chat_thread", thread: updated });
  return json(updated);
}

async function recordManagerMeeting(db: DB, herdr: Herdr, threadId: string, body: any): Promise<Response> {
  const thread = getThread(db, threadId);
  if (!thread) return err("thread not found", 404);
  if (!thread.task_id) return err("supervisor session has not started", 409);
  const stage = String(body?.stage ?? "");
  if (!["proposal", "critique", "decided"].includes(stage)) return err("stage must be proposal|critique|decided");

  let meetingId = body?.meeting_id ? String(body.meeting_id) : newId("meet");
  let topic = String(body?.topic ?? "").trim();
  let participants = stringList(body?.participants, 3);
  if (stage === "proposal") {
    if (!topic) return err("topic is required");
    if (participants.length < 2 || participants.length > 3) return err("proposal stage requires 2-3 participant task ids");
    for (const id of participants) {
      const owner = managingThreadForTask(db, id);
      if (!getTask(db, id) || owner?.id !== threadId) return err(`participant ${id} is not a worker managed by this thread`, 409);
    }
  } else {
    const prior = db
      .query("SELECT payload FROM events WHERE type = 'manager_meeting' AND json_extract(payload, '$.thread_id') = ? AND json_extract(payload, '$.meeting_id') = ? ORDER BY ts DESC, rowid DESC LIMIT 1")
      .get(threadId, meetingId) as { payload: string } | undefined;
    if (!prior) return err("meeting not found", 404);
    const previous = JSON.parse(prior.payload || "{}");
    topic ||= previous.topic;
    participants = participants.length ? participants : stringList(previous.participants, 3);
  }

  const summary = String(body?.summary ?? "").trim() || null;
  const decision = String(body?.decision ?? "").trim() || null;
  const recommendation = String(body?.recommendation ?? decision ?? "").trim() || null;
  const dissent = stringList(body?.dissent, 5);
  const evidence = stringList(body?.evidence, 10);
  const risks = stringList(body?.risks, 5);
  if (stage === "critique" && !summary) return err("critique stage requires summary");
  if (stage === "decided" && !recommendation) return err("decided stage requires recommendation");

  const message = stage === "proposal"
    ? `Bounded team meeting: ${topic}\nGive an independent proposal with risks and concrete evidence. Send it to manager task ${thread.task_id} with: hive task send ${thread.task_id} "<proposal>".`
    : stage === "critique"
      ? `Bounded team meeting critique: ${topic}\nCompeting proposals: ${summary}\nSend one concise correction or critique to manager task ${thread.task_id}.`
      : `Bounded team meeting concluded: ${topic}\nRecommendation: ${recommendation}${summary ? `\nRationale: ${summary}` : ""}${dissent.length ? `\nMaterial dissent: ${dissent.join("; ")}` : ""}${risks.length ? `\nRisks: ${risks.join("; ")}` : ""}\nProceed on this basis.`;
  let delivered = 0;
  for (const id of participants) if (await internalSteer(db, herdr, id, message)) delivered++;

  const event = writeEvent(db, {
    task_id: thread.task_id,
    source: "chat_supervisor",
    type: "manager_meeting",
    payload: { thread_id: threadId, meeting_id: meetingId, stage, topic, participants, summary, decision: decision ?? recommendation, recommendation, dissent, evidence, risks, delivered },
  });
  return json({ ...event.payload, event_id: event.id, ts: event.ts }, stage === "proposal" ? 201 : 200);
}

function recordManagerVerification(db: DB, threadId: string, body: any): Response {
  const thread = getThread(db, threadId);
  if (!thread) return err("thread not found", 404);
  if (!thread.task_id) return err("supervisor session has not started", 409);
  const status = String(body?.status ?? "");
  if (!["started", "passed", "failed"].includes(status)) return err("status must be started|passed|failed");
  const method = String(body?.method ?? "").trim();
  if (!method) return err("method is required");
  const result = String(body?.result ?? "").trim() || null;
  const targetTaskIds = stringList(body?.target_task_ids);
  const evidenceIds = stringList(body?.evidence_ids);
  for (const id of targetTaskIds) {
    const target = getTask(db, id);
    if (!target || target.project_id !== thread.project_id) return err(`target task is outside this run's project: ${id}`, 409);
  }
  if (status === "passed") {
    if (!result) return err("passed verification requires result");
    if (!evidenceIds.length) return err("passed verification requires evidence_ids");
    for (const id of evidenceIds)
      if (!db.query("SELECT 1 FROM evidence e JOIN tasks t ON t.id = e.task_id WHERE e.id = ? AND t.project_id = ?").get(id, thread.project_id))
        return err(`evidence is unknown or outside this run's project: ${id}`);
  }
  const verificationId = newId("verify");
  const event = writeEvent(db, {
    task_id: thread.task_id,
    source: "chat_supervisor",
    type: "manager_verification",
    payload: {
      thread_id: threadId,
      verification_id: verificationId,
      status,
      method,
      result,
      target_task_ids: targetTaskIds,
      evidence_ids: evidenceIds,
      replay_of: body?.replay_of ? String(body.replay_of) : null,
    },
  });
  const next = status === "failed"
    ? { phase: "executing" as const, next_action: `Correct failed verification: ${result ?? method}` }
    : { phase: "verifying" as const, next_action: status === "passed" ? "Record the run retrospective" : `Run verification: ${method}` };
  const updated = updateThreadRun(db, threadId, next)!;
  broadcast({ type: "chat_thread", thread: updated });
  return json({ ...event.payload, event_id: event.id, ts: event.ts }, 201);
}

async function replayManagerVerification(db: DB, herdr: Herdr, deps: HandlerDeps, threadId: string, eventId: string): Promise<Response> {
  const thread = getThread(db, threadId);
  if (!thread?.task_id) return err(thread ? "supervisor session has not started" : "thread not found", thread ? 409 : 404);
  const row = db
    .query("SELECT payload FROM events WHERE id = ? AND type = 'manager_verification' AND json_extract(payload, '$.thread_id') = ?")
    .get(eventId, threadId) as { payload: string } | undefined;
  if (!row) return err("verification not found", 404);
  const prior = JSON.parse(row.payload || "{}");
  const verificationId = newId("verify");
  const event = writeEvent(db, {
    task_id: thread.task_id,
    source: "director",
    type: "manager_verification",
    payload: {
      thread_id: threadId,
      verification_id: verificationId,
      status: "started",
      method: prior.method,
      result: null,
      target_task_ids: prior.target_task_ids ?? [],
      evidence_ids: [],
      replay_of: prior.verification_id ?? eventId,
    },
  });
  const updated = updateThreadRun(db, threadId, { phase: "verifying", next_action: `Replay verification: ${prior.method}` })!;
  broadcast({ type: "chat_thread", thread: updated });
  const message = [
    `[hive manager wakeup]`,
    `Replay verification requested for the top-level outcome.`,
    `Method: ${prior.method}`,
    `Prior result: ${prior.result ?? "none"}`,
    `Target tasks: ${(prior.target_task_ids ?? []).join(", ") || "derive from the run"}`,
    `Acceptance criteria: ${thread.acceptance_criteria.join("; ") || "derive and record them first"}`,
    `Run the same independent check against the current integrated state, compare it with the prior result, and record a passed or failed verification with replay_of=${prior.verification_id ?? eventId}.`,
  ].join("\n");
  const delivery = await withThreadLock(threadId, () => deliverToSupervisor(db, herdr, deps, threadId, message));
  return json({ verification: { ...event.payload, event_id: event.id, ts: event.ts }, ...delivery }, 202);
}

function recordManagerRetrospective(db: DB, threadId: string, body: any): Response {
  const thread = getThread(db, threadId);
  if (!thread) return err("thread not found", 404);
  if (!thread.task_id) return err("supervisor session has not started", 409);
  const summary = String(body?.summary ?? "").trim();
  if (!summary) return err("summary is required");
  const event = writeEvent(db, {
    task_id: thread.task_id,
    source: "chat_supervisor",
    type: "manager_retrospective",
    payload: {
      thread_id: threadId,
      retrospective_id: newId("retro"),
      summary,
      worked: stringList(body?.worked),
      problems: stringList(body?.problems),
      lessons: stringList(body?.lessons),
    },
  });
  const updated = updateThreadRun(db, threadId, { phase: "verifying", next_action: "Close the run with its verified outcome" })!;
  broadcast({ type: "chat_thread", thread: updated });
  return json({ ...event.payload, event_id: event.id, ts: event.ts }, 201);
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
  }
  // Target-repo sanity check (#989). Runs after dedup so an auto-merged task
  // never gets a card it can't act on. A strong mismatch rides back on the
  // response as `warning` (the CLI prints it) and holds dispatch via its card.
  const warning = noteRepoMismatch(db, getTask(db, row.id));
  return json({ ...taskWithHealth(db, getTask(db, row.id)), ...(warning ? { warning } : {}) }, 201);
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
  if (decisionAnswerUnaddressed(db, taskId)) return false;
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
  lifecycle: ["created", "spawned", "agent_status", "status", "steer", "note", "ci_status", "pr_merged", "planning", "assistant_text", "tool_use", "agent_turn_end", "auto_resume"],
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
       WHERE t.state = 'done' AND COALESCE(t.source, '') != 'chat_supervisor'` + (since ? " AND sc.ts >= ?" : "") +
      " ORDER BY sc.ts DESC"
    )
    .all(...(since ? [since] : []));

  // ② needs attention uses the shared eligibility rule over full task objects
  // (with health), so the web can reuse the tray rows.
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

  const directorRequiredTaskIds = new Set(
    decisions
      .filter((decision: any) => {
        const task = getTask(db, decision.task_id);
        const autonomy = projectAutonomyProfile(db, task?.project_id ?? null);
        if (autonomy === "conservative") return true;
        const recommended = decision.options.find((option: any) => option.recommended);
        if (!recommended) return true;
        return !(autonomy === "autopilot"
          ? evaluateAutopilotApprove(db, decision, recommended.key)
          : evaluateAutoApprove(db, decision, recommended.key)).allow;
      })
      .map((decision: any) => decision.task_id)
  );
  for (const checkpoint of openCheckpointRows(db, null)) {
    if (projectAutonomyProfile(db, checkpoint.project_id) === "conservative")
      directorRequiredTaskIds.add(checkpoint.task_id);
  }

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
    director_required_task_ids: [...directorRequiredTaskIds],
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

async function doTransition(db: DB, id: string, body: any, deps: HandlerDeps = {}): Promise<Response> {
  if (!body?.to) return err("'to' state is required");
  const to = body.to as State;
  // A reviewer bounce (`hive task move <id> in_progress --note`) IS a
  // request-changes: it must deliver the note and keep an agent on the task. A
  // plain transition here dropped the note into the event log, respawned nobody,
  // and the reconciler's idle-advance backstop flipped the task right back to
  // in_review — the move looked like it worked but the feedback was lost (#710).
  // Route it through the same bounce path (records changes_requested, respawns a
  // dead agent with the note in its brief).
  if (to === "in_progress") {
    const t = getTask(db, id);
    if (t && t.state === "in_review") {
      const herdr = deps.herdr ?? defaultHerdr;
      const notes = String(body?.reason ?? "").trim() || "The director moved this back to in_progress for more work.";
      const { delivered, respawned } = await bounceForChanges(db, herdr, t, notes, deps);
      return json({ ...getTask(db, id), bounce: { delivered, respawned } });
    }
  }
  // High-blast-radius transitions (post-merge verify, marking done) are gated.
  if (to === "verifying" || to === "done") {
    const t = getTask(db, id);
    if (t) {
      if (to === "verifying" && t.state === "in_review" && t.kind === "scout") {
        const quiz = latestUnderstandingQuiz(db, id);
        if (!quiz)
          return err("Understanding check required. Ask the agent to add one before accepting this report.", 409);
        if (understandingQuizStatus(db, id, quiz.reviewEventId) === "required")
          return err("Pass the understanding check before accepting this report, or choose 'Continue now, quiz me later'.", 409);
      }
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
    await smokeThenAdvance(db, id, { fetch: deps.fetch }).catch((e) => console.error("[hive] smoke run failed:", e));
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

// Fast-forward the project's default branch to the task branch tip. If the
// primary checkout is on `base`, use git merge so its working tree follows the
// ref. Otherwise update the un-checked-out ref atomically, leaving the user's
// current branch untouched. A base checked out in another worktree is refused
// rather than leaving that worktree's files out of sync. Returns null on
// success, or a failure reason string.
async function attemptLocalFf(exec: Exec, project: any, task: any, base: string): Promise<string | null> {
  const baseSha = await exec(["git", "-C", project.repo_path, "rev-parse", base]);
  const branchSha = await exec(["git", "-C", project.repo_path, "rev-parse", task.branch]);
  const oldSha = baseSha.stdout.trim();
  const newSha = branchSha.stdout.trim();
  if (baseSha.code !== 0 || branchSha.code !== 0 || !oldSha || !newSha)
    return baseSha.stderr.trim() || branchSha.stderr.trim() || "could not resolve merge refs";

  const anc = await exec(["git", "-C", project.repo_path, "merge-base", "--is-ancestor", oldSha, newSha]);
  if (anc.code !== 0) {
    // Name the exact commit compared against: this is the primary checkout's
    // LOCAL base ref, which can be ahead of origin/<base> — an agent rebased
    // onto origin/main and hit this identical failure twice before digging
    // out that hive checks a different, unfetchable-by-name ref.
    return (
      `'${base}' (LOCAL ref in the primary checkout, ${oldSha.slice(0, 12)}, may be ahead of origin/${base}) ` +
      `is not an ancestor of '${task.branch}'; not a fast-forward. Rebase onto that exact commit ` +
      `(git fetch <primary-checkout> ${base}) or open a PR.`
    );
  }
  const head = await exec(["git", "-C", project.repo_path, "symbolic-ref", "--short", "HEAD"]);
  const current = head.stdout.trim();
  if (head.code === 0 && current === base) {
    const r = await exec(["git", "-C", project.repo_path, "merge", "--ff-only", task.branch]);
    if (r.code !== 0) return r.stderr.trim() || r.stdout.trim() || `git merge --ff-only exited ${r.code}`;
    return null;
  }

  const worktrees = await exec(["git", "-C", project.repo_path, "worktree", "list", "--porcelain"]);
  if (worktrees.code !== 0) return worktrees.stderr.trim() || "could not inspect project worktrees";
  const holder = worktrees.stdout
    .split(/\n\n+/)
    .find((block) => block.split("\n").includes(`branch refs/heads/${base}`));
  if (holder) {
    const path = holder.split("\n").find((line) => line.startsWith("worktree "))?.slice(9) || "another worktree";
    return `'${base}' is checked out at '${path}'; merge from that checkout before retrying.`;
  }

  const r = await exec(["git", "-C", project.repo_path, "update-ref", `refs/heads/${base}`, newSha, oldSha]);
  if (r.code !== 0) return r.stderr.trim() || r.stdout.trim() || `git update-ref exited ${r.code}`;
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
  if (task.kind === "scout")
    return err(`scout tasks are report-only; accept the report by moving task '${id}' to 'verifying' instead of merging its branch`, 409);

  const blocked = authzBlock(db, { project_id: task.project_id, action: "task.merge", target: task.title, task_id: id });
  if (blocked) return blocked;

  const quiz = latestUnderstandingQuiz(db, id);
  if (!quiz)
    return err("Understanding check required. Ask the agent to submit one in its latest review before merging.", 409);
  if (understandingQuizStatus(db, id, quiz.reviewEventId) === "required")
    return err("Pass the understanding check before merging, or choose 'Continue now, quiz me later'.", 409);

  const exec = deps.exec ?? defaultExec;
  const project: any = db.query("SELECT * FROM projects WHERE id = ?").get(task.project_id);
  const config = JSON.parse(project?.config ?? "{}");
  let prView: any = null;
  if (task.pr_url) {
    const probe = await exec([
      "gh",
      "pr",
      "view",
      task.pr_url,
      "--json",
      "state,mergeStateStatus,reviewDecision,statusCheckRollup,baseRefName,baseRefOid,headRefOid",
    ]);
    if (probe.code !== 0)
      return mergeFailed(
        db,
        herdr,
        task,
        config.default_branch || "main",
        `Could not inspect PR metadata; merge was not attempted (${probe.stderr.trim() || "gh pr view failed"}).`
      );
    try {
      prView = JSON.parse(probe.stdout || "{}");
    } catch {
      return mergeFailed(db, herdr, task, config.default_branch || "main", "Could not parse PR metadata; merge was not attempted.");
    }
    if (!prView.baseRefName || !prView.baseRefOid)
      return mergeFailed(db, herdr, task, config.default_branch || "main", "PR base metadata is missing; merge was not attempted.");
  }
  const base = prView?.baseRefName || config.default_branch || "main";
  const guardBase = prView?.baseRefOid || base;
  const guardHead = prView?.headRefOid || task.branch;
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
        // Legacy snapshots were measured against task.branch, a local ref that
        // can point somewhere other than the PR head. Rebuild their intended
        // file set from the first exact PR head observed in the same cycle.
        const firstSync = db
          .query("SELECT payload FROM events WHERE task_id = ? AND type = 'pr_synchronized' ORDER BY ts ASC LIMIT 1")
          .get(id) as { payload: string } | undefined;
        let originalHead: string | null = (snapshot as BranchScope & { head_sha?: string | null }).head_sha ?? null;
        try {
          originalHead ||= firstSync ? JSON.parse(firstSync.payload).head_sha ?? null : null;
        } catch {}
        if (originalHead) {
          const exact = await captureBranchScope(exec, project.repo_path, guardBase, originalHead);
          if (exact) snapshot = { ...snapshot, files: exact.files };
        }
        const regressed = await detectDestructiveRebase(exec, project.repo_path, guardBase, guardHead, snapshot);
        if (regressed && regressed.length) {
          const files = regressed.slice(0, 10).join(", ") + (regressed.length > 10 ? `, …(+${regressed.length - 10})` : "");
          const reason = `branch '${task.branch}' reverts base work outside this task's scope (${files})`;
          writeEvent(db, {
            task_id: id,
            source: "director",
            type: "merge_blocked_destructive",
            payload: { base, branch: task.branch, regressed, reason },
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
            `merge blocked — ${reason}; ` +
              `the auto-rebase likely dropped intervening commits (task #314). Re-cut off current '${base}', or ` +
              `merge with override_destructive_check=true if intentional.`,
            409
          );
        }
      }
    }
  }

  let method = "";
  if (task.pr_url) {
    // A closed or already-merged PR fails `gh pr merge` with an opaque GraphQL
    // error and used to bounce the agent with a bogus conflict steer (task #90
    // looped on its replaced PR for hours). Tell the truth instead — and when
    // GitHub says MERGED, just advance: the work landed, hive's link was stale.
    // Runs on the forced local_ff path too: that override exists for a stale
    // base comparison, never for landing a rejected PR's branch.
    if (prView) {
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
  await smokeThenAdvance(db, id, { fetch: deps.fetch }).catch((e) => console.error("[hive] smoke run failed:", e));

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

// Bounce an in-review task back to in_progress with reviewer feedback, and make
// sure the feedback actually REACHES an agent. Delivers to the live agent; if
// none is live (idle/gone, or the send fails) it queues the notes as a steer and
// RESPAWNS so the fresh agent gets them in its first brief. Records a
// `changes_requested` event either way — that carries the notes on the timeline
// AND marks the bounce unaddressed, so the reconciler's idle-advance backstop
// (advanceIfFinished) can't silently flip the task straight back to in_review
// before the agent has done the work. That silent revert (#710) made a bounce to
// a dead agent look like it succeeded when nobody read the note.
async function bounceForChanges(
  db: DB,
  herdr: Herdr,
  task: any,
  notes: string,
  deps: HandlerDeps
): Promise<{ delivered: boolean; respawned: boolean; sendError: string | null }> {
  const id = task.id;
  const msg =
    `hive: changes requested before merge —\n${notes}\n\n` +
    `If any of the above is a QUESTION, reply with \`hive emit ${id} answer --note "..."\` ` +
    `(answers are pushed to the director; pane text is not), then make the changes and emit ready again.\n\n` +
    `After you push the fix, RE-CAPTURE evidence against the new commit — a fresh test run or log for ` +
    `server/back-end changes, a screenshot for UI. The old evidence is now stale and the handoff is HELD ` +
    `until fresh evidence matches HEAD (hive emit ${id} evidence --file ... --note ...).`;

  let delivered = false;
  let sendError: string | null = null;
  if (task.agent_target) {
    try {
      const res = await herdr.send(task.agent_target, msg);
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
  transition(db, id, "in_progress", { source: "director", reason: "changes requested" });

  // No live agent read the notes: queue them and respawn so the fresh agent gets
  // them in its brief (spawnAgent receipts the steer on success). Without this
  // the notes sit unread and the task looks reviewed again (#710).
  let respawned = false;
  if (!delivered) {
    queueSteerEvent(db, id, msg, "changes requested; agent not live");
    const r = await spawnAgent(db, herdr, id, { supervise: deps.supervise });
    respawned = r.ok;
    if (r.ok) delivered = true;
  }
  return { delivered, respawned, sendError };
}

// POST /api/tasks/:id/request-changes body {notes} — bounce an in-review task
// back to in_progress and deliver the captain's notes to the agent.
async function requestChanges(db: DB, herdr: Herdr, id: string, body: any, deps: HandlerDeps = {}): Promise<Response> {
  const task = getTask(db, id);
  if (!task) return err("task not found", 404);
  if (task.state !== "in_review")
    return err(`task is '${task.state}', not 'in_review'`, 409);
  const notes = String(body?.notes ?? "").trim();
  if (!notes) return err("notes are required");
  const { delivered, respawned } = await bounceForChanges(db, herdr, task, notes, deps);
  return json({ ok: true, delivered, respawned, task: getTask(db, id) });
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
      base: config.default_branch || "main",
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
    const msg = String(e?.message ?? e);
    // Tag herdr-daemon-down failures as infra: the dispatcher backs off globally
    // (not per-task) and inBackoff excludes them, so an outage doesn't pound the
    // dead socket once per queued task nor inflate the task's own backoff.
    const infra = isHerdrUnreachable(msg) ? "herdr_unreachable" : undefined;
    writeEvent(db, { task_id: id, source: "herdr", type: "spawn_error", payload: { error: msg, ...(infra ? { infra } : {}) } });
    recordSystemLearning(db, task.project_id, `spawn failure: ${signature(msg)}`, msg, id);
    return { ok: false, error: msg };
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
      // The worktree's OWN workspace (distinct from the fleet). `worktree create`
      // auto-spawns it with a live pane/pty that the agent never uses, so cleanup
      // must close it or it leaks a pty forever (2026-07-25).
      workspace_id: result.workspace_id,
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
  const fromTaskId = fields?.from_task_id ? String(fields.from_task_id) : null;
  const sender = fromTaskId ? getTask(db, fromTaskId) : null;
  if (fromTaskId && !sender) return err("unknown from_task_id", 400);
  if (sender && sender.project_id !== task.project_id) return err("teammates must belong to the same project", 400);
  const blocked = authzBlock(db, { project_id: task.project_id, action: "task.steer", target: task.title, task_id: id });
  if (blocked) return blocked;
  if (String(task.source_ref ?? "").startsWith("jira:")) {
    if (files.length) return err("Jira comment attachments are not supported yet", 400);
    const comment = sender ? `Hive agent #${sender.number} (${sender.title}):\n${text}` : text;
    writeEvent(db, {
      task_id: id,
      source: sender ? "agent" : "director",
      type: "jira_comment",
      payload: { direction: "outbound", text: comment, delivery: "queued", ...(sender ? { from_task_id: sender.id } : {}) },
    });
    return json({ ok: true, delivered: false, delivery: "queued", message: comment, attachments: [] });
  }
  const { paths, block } = await attachFiles(id, files);
  const message = sender
    ? `[teammate #${sender.number} ${sender.title} | task ${sender.id}]\n${text}\n\nReply with: "$HIVE_CLI" task send ${sender.id} "<your reply>"${block}`
    : text + block;
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
    source: sender ? "agent" : "director",
    type: "steer",
    payload: {
      message,
      target,
      attachments: paths,
      delivery,
      ...(sender ? { from_task_id: sender.id, from_task_number: sender.number, original_message: text } : {}),
      ...(delivered ? { delivered_at: now() } : { error }),
    },
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

interface UnderstandingCheck {
  question: string;
  options: { key: string; label: string }[];
  answerKey: string;
  explanation?: string;
}

function isAgentProcedureQuestion(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const question = typeof (value as Record<string, unknown>).question === "string"
    ? String((value as Record<string, unknown>).question)
    : "";
  return [
    /\bwhat should (?:you|an? agent|the agent|the worker|the supervisor|the orchestrator) do\b/i,
    /\byour (?:branch|task|pr|pull request|checkout|worktree)\b/i,
    /\bwhere (?:else )?(?:could|should|would) (?:the )?(?:actual )?blocker live\b/i,
    /\bwhere should you investigate\b/i,
    /\bwhat(?:'s| is) the (?:correct|best|next) move\b/i,
  ].some((pattern) => pattern.test(question));
}

function normalizeUnderstandingCheck(value: unknown): UnderstandingCheck | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const question = typeof raw.question === "string" ? raw.question.trim().slice(0, 600) : "";
  const answerKey = typeof raw.answer_key === "string" ? raw.answer_key.trim().slice(0, 80) : "";
  const seen = new Set<string>();
  const options = Array.isArray(raw.options)
    ? raw.options.flatMap((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const option = item as Record<string, unknown>;
        const key = typeof option.key === "string" ? option.key.trim().slice(0, 80) : "";
        const label = typeof option.label === "string" ? option.label.trim().slice(0, 600) : "";
        if (!key || !label || seen.has(key)) return [];
        seen.add(key);
        return [{ key, label }];
      }).slice(0, 4)
    : [];
  if (!question || options.length < 2 || !options.some((option) => option.key === answerKey)) return null;
  const explanation = typeof raw.explanation === "string" && raw.explanation.trim()
    ? raw.explanation.trim().slice(0, 600)
    : undefined;
  return { question, options, answerKey, explanation };
}

function normalizeUnderstandingChecks(understanding: unknown): UnderstandingCheck[] {
  if (!understanding || typeof understanding !== "object" || Array.isArray(understanding)) return [];
  const raw = understanding as Record<string, unknown>;
  const values = Array.isArray(raw.checks) ? raw.checks : Array.isArray(raw.check) ? raw.check : raw.check ? [raw.check] : [];
  return values.flatMap((value) => {
    const check = normalizeUnderstandingCheck(value);
    return check ? [check] : [];
  }).slice(0, 5);
}

function latestUnderstandingQuiz(db: DB, taskId: string): { reviewEventId: string; checks: UnderstandingCheck[] } | null {
  const row: any = db
    .query("SELECT id, payload FROM events WHERE task_id = ? AND type = 'review_summary' ORDER BY ts DESC, rowid DESC LIMIT 1")
    .get(taskId);
  if (!row) return null;
  try {
    const payload = JSON.parse(row.payload);
    const checks = normalizeUnderstandingChecks(payload?.understanding);
    return checks.length ? { reviewEventId: row.id, checks } : null;
  } catch {
    return null;
  }
}

function understandingQuizProgress(db: DB, taskId: string, reviewEventId: string): { attempts: number; completed: Set<number> } {
  const rows = db
    .query("SELECT payload FROM events WHERE task_id = ? AND type = 'understanding_quiz_attempt' AND json_extract(payload, '$.review_event_id') = ?")
    .all(taskId, reviewEventId) as { payload: string }[];
  const completed = new Set<number>();
  for (const row of rows) {
    try {
      const payload = JSON.parse(row.payload);
      if (payload.correct === true && Number.isInteger(payload.check_index)) completed.add(payload.check_index);
    } catch {
      /* ignore malformed legacy attempts */
    }
  }
  return { attempts: rows.length, completed };
}

function activeUnderstandingCheck(
  db: DB,
  taskId: string,
  quiz: { reviewEventId: string; checks: UnderstandingCheck[] }
): { check: UnderstandingCheck; index: number; completed: number } {
  const progress = understandingQuizProgress(db, taskId, quiz.reviewEventId);
  const remaining = quiz.checks.map((_, index) => index).filter((index) => !progress.completed.has(index));
  const pool = remaining.length ? remaining : quiz.checks.map((_, index) => index);
  const offset = [...quiz.reviewEventId].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  const index = pool[(offset + progress.attempts) % pool.length];
  return { check: quiz.checks[index], index, completed: quiz.checks.length - remaining.length };
}

function understandingQuizStatus(db: DB, taskId: string, reviewEventId: string): "required" | "deferred" | "passed" {
  const passed = db
    .query("SELECT 1 FROM events WHERE task_id = ? AND type = 'understanding_quiz_passed' AND json_extract(payload, '$.review_event_id') = ? LIMIT 1")
    .get(taskId, reviewEventId);
  if (passed) return "passed";
  const deferred = db
    .query("SELECT 1 FROM events WHERE task_id = ? AND type = 'understanding_quiz_deferred' AND json_extract(payload, '$.review_event_id') = ? LIMIT 1")
    .get(taskId, reviewEventId);
  return deferred ? "deferred" : "required";
}

// Older agents sometimes re-submit the exact same review after an unrelated
// merge failure. That must not erase a quiz the director already completed.
// Repair the latest duplicate once at startup; future duplicates are rejected
// idempotently at ingestion below.
export function repairDuplicateQuizPasses(db: DB): number {
  const latest = db
    .query(
      `SELECT e.id, e.task_id, e.payload, e.rowid
         FROM events e
        WHERE e.type = 'review_summary'
          AND NOT EXISTS (
            SELECT 1 FROM events newer
             WHERE newer.task_id = e.task_id AND newer.type = 'review_summary' AND newer.rowid > e.rowid)`
    )
    .all() as { id: string; task_id: string; payload: string; rowid: number }[];
  let repaired = 0;
  for (const review of latest) {
    if (understandingQuizStatus(db, review.task_id, review.id) === "passed") continue;
    const prior = db
      .query(
        `SELECT older.id
           FROM events older
          WHERE older.task_id = ? AND older.type = 'review_summary'
            AND older.rowid < ? AND older.payload = ?
            AND EXISTS (
              SELECT 1 FROM events passed
               WHERE passed.task_id = older.task_id AND passed.type = 'understanding_quiz_passed'
                 AND json_extract(passed.payload, '$.review_event_id') = older.id)
            AND NOT EXISTS (
              SELECT 1 FROM events invalidated
               WHERE invalidated.task_id = older.task_id
                 AND invalidated.rowid > older.rowid AND invalidated.rowid < ?
                 AND invalidated.type IN ('changes_requested', 'decision_answered'))
          ORDER BY older.rowid DESC LIMIT 1`
      )
      .get(review.task_id, review.rowid, review.payload, review.rowid) as { id: string } | undefined;
    if (!prior) continue;
    writeEvent(db, {
      task_id: review.task_id,
      source: "system",
      type: "understanding_quiz_passed",
      payload: {
        review_event_id: review.id,
        carried_from_review_event_id: prior.id,
        reason: "identical review already understood",
      },
    });
    repaired++;
  }
  return repaired;
}

function listUnderstandingQuizzes(db: DB, url: URL): Response {
  const projectId = url.searchParams.get("project_id");
  const rows = db
    .query(
      `SELECT e.id, e.task_id, e.ts, e.payload, t.number, t.title, t.project_id, t.state, t.kind
         FROM events e JOIN tasks t ON t.id = e.task_id
        WHERE e.type = 'review_summary'
          AND t.state != 'cancelled'
          AND (? IS NULL OR t.project_id = ?)
          AND NOT EXISTS (
            SELECT 1 FROM events newer
             WHERE newer.task_id = e.task_id AND newer.type = 'review_summary'
               AND (newer.ts > e.ts OR (newer.ts = e.ts AND newer.rowid > e.rowid)))
        ORDER BY t.number DESC`
    )
    .all(projectId, projectId) as any[];
  const quizzes = rows.flatMap((row) => {
    let payload: any;
    try { payload = JSON.parse(row.payload); } catch { return []; }
    const checks = normalizeUnderstandingChecks(payload?.understanding);
    if (!checks.length) return [];
    const understanding = payload?.understanding && typeof payload.understanding === "object" && !Array.isArray(payload.understanding)
      ? Object.fromEntries(Object.entries(payload.understanding).filter(([key]) => key !== "check" && key !== "checks"))
      : {};
    const status = understandingQuizStatus(db, row.task_id, row.id);
    if (status === "passed") return [];
    const active = activeUnderstandingCheck(db, row.task_id, { reviewEventId: row.id, checks });
    return [{
      id: row.id,
      task_id: row.task_id,
      ts: row.ts,
      task_number: row.number,
      task_title: row.title,
      task_state: row.state,
      task_kind: row.kind,
      project_id: row.project_id,
      report: { ...payload, understanding },
      question: active.check.question,
      options: active.check.options,
      completed: active.completed,
      total: checks.length,
      status,
    }];
  });
  return json({ quizzes });
}

function answerUnderstandingQuiz(db: DB, taskId: string, body: any): Response {
  const task = getTask(db, taskId);
  if (!task) return err("task not found", 404);
  if (task.state === "cancelled") return err("cancelled task has no active understanding check", 409);
  if (!["in_review", "verifying", "done", "failed"].includes(task.state))
    return err("understanding checks can be answered during review or from the post-ship backlog", 409);
  if (body?.source !== "director") return err("only the director can answer understanding checks", 403);
  const quiz = latestUnderstandingQuiz(db, taskId);
  if (!quiz) return err("understanding check not found", 404);
  const status = understandingQuizStatus(db, taskId, quiz.reviewEventId);
  const active = activeUnderstandingCheck(db, taskId, quiz);
  const check = active.check;
  if (status === "passed") return json({ ok: true, correct: true, passed: true, explanation: check.explanation ?? null });
  const answerKey = typeof body?.answer_key === "string" ? body.answer_key : "";
  if (!check.options.some((option) => option.key === answerKey)) return err("answer_key must match a quiz option");
  if (answerKey !== check.answerKey) {
    writeEvent(db, {
      task_id: taskId,
      source: "director",
      type: "understanding_quiz_attempt",
      payload: { review_event_id: quiz.reviewEventId, check_index: active.index, answer_key: answerKey, correct: false },
    });
    const next = activeUnderstandingCheck(db, taskId, quiz);
    return json({
      ok: false,
      correct: false,
      passed: false,
      explanation: check.explanation ?? null,
      completed: next.completed,
      total: quiz.checks.length,
      quiz: { question: next.check.question, options: next.check.options, completed: next.completed, total: quiz.checks.length },
    });
  }
  writeEvent(db, {
    task_id: taskId,
    source: "director",
    type: "understanding_quiz_attempt",
    payload: { review_event_id: quiz.reviewEventId, check_index: active.index, answer_key: answerKey, correct: true },
  });
  const next = activeUnderstandingCheck(db, taskId, quiz);
  if (next.completed < quiz.checks.length) {
    return json({
      ok: true,
      correct: true,
      passed: false,
      explanation: check.explanation ?? null,
      completed: next.completed,
      total: quiz.checks.length,
      quiz: { question: next.check.question, options: next.check.options, completed: next.completed, total: quiz.checks.length },
    });
  }
  writeEvent(db, {
    task_id: taskId,
    source: "director",
    type: "understanding_quiz_passed",
    payload: { review_event_id: quiz.reviewEventId, check_index: active.index, answer_key: answerKey },
  });
  return json({ ok: true, correct: true, passed: true, explanation: check.explanation ?? null, completed: next.completed, total: quiz.checks.length });
}

function deferUnderstandingQuiz(db: DB, taskId: string, body: any): Response {
  const task = getTask(db, taskId);
  if (!task) return err("task not found", 404);
  if (task.state !== "in_review") return err("understanding checks can only be deferred while a task is in review", 409);
  if (body?.source !== "director") return err("only the director can defer understanding checks", 403);
  if (body?.confirm !== "quiz_later") return err("confirm must be 'quiz_later'");
  const quiz = latestUnderstandingQuiz(db, taskId);
  if (!quiz) return err("understanding check not found", 404);
  const status = understandingQuizStatus(db, taskId, quiz.reviewEventId);
  if (status === "passed") return json({ ok: true, status });
  if (status !== "deferred") {
    writeEvent(db, {
      task_id: taskId,
      source: "director",
      type: "understanding_quiz_deferred",
      payload: { review_event_id: quiz.reviewEventId },
    });
  }
  return json({ ok: true, status: "deferred" });
}

function openCheckpointRows(db: DB, projectId: string | null): any[] {
  // Un-acked checkpoints stay reviewable AFTER the task finishes — agents
  // finish faster than the director's attention cycle, and 21 of the first 25
  // checkpoints vanished unreviewed when this filtered to live states
  // (2026-07-10). Only cancelled tasks drop out (their calls died with them).
  return db
    .query(
      `SELECT e.id, e.task_id, e.ts, e.payload, t.number, t.title, t.project_id, t.state
         FROM events e JOIN tasks t ON t.id = e.task_id
        WHERE e.type = 'checkpoint'
          AND t.state != 'cancelled'
          AND (? IS NULL OR t.project_id = ?)
          AND NOT EXISTS (
            SELECT 1 FROM events a
             WHERE a.task_id = e.task_id AND a.type = 'checkpoint_ack'
               AND json_extract(a.payload, '$.checkpoint_id') = e.id)
        ORDER BY t.number DESC, e.ts ASC`
    )
    .all(projectId, projectId) as any[];
}

function listOpenCheckpoints(db: DB, url: URL): Response {
  const rows = openCheckpointRows(db, url.searchParams.get("project_id"));
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
  const source = body?.source ?? "director";
  if (source !== "director" && source !== "chat_supervisor")
    return err("source must be 'director' or 'chat_supervisor'");
  const actor = body?.actor ? String(body.actor) : null;
  const task = getTask(db, taskId);
  if (source === "chat_supervisor") {
    if (!actor || !getThread(db, actor)) return err("chat_supervisor checkpoint actions require a valid thread actor", 403);
    if (projectAutonomyProfile(db, task?.project_id ?? null) === "conservative")
      return err("project autonomy is conservative; checkpoint requires the director", 403);
  }
  const note = body?.note ? String(body.note) : null;
  writeEvent(db, {
    task_id: taskId,
    source,
    type: "checkpoint_ack",
    payload: { checkpoint_id: eventId, verdict, note, actor },
  });
  let delivered = false;
  let followup_task_id: string | null = null;
  if (verdict === "flag") {
    const cpText = checkpointNote(ev.payload);
    const live = task && !["done", "cancelled", "failed"].includes(task.state) && task.agent_target;
    if (live) {
      delivered = await internalSteer(
        db,
        herdr,
        taskId,
        `${source === "chat_supervisor" ? "The project supervisor" : "Director"} FLAGGED your checkpoint: "${cpText}"${note ? ` — ${note}` : ""}. Address this now, before continuing.`
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
        `${source === "chat_supervisor" ? "The project supervisor" : "The director"} flagged a checkpoint after task #${task.number} ("${task.title}") had already ${task.state === "done" ? "shipped" : "stopped"}.\n\nCheckpoint (the agent's judgment call): ${cpText}\n\nFlag: ${note ?? "(no note)"}\n\nRevisit that decision in the shipped code and correct it per the flag. Original task id: ${taskId}.`,
        taskId,
        t,
        t
      );
      writeEvent(db, { task_id: fid, source, type: "created", payload: { title: "checkpoint flag follow-up", checkpoint_id: eventId, actor } });
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

// A learning that silently defaulted to kind='failure' when the caller forgot
// --kind used to pollute the "Known failure patterns" brief section forever
// (task #904/corebeat #901: a routine watcher-summary auto-spawned a bogus
// root-cause chore). kind is now required, not inferred.
const CREATABLE_KINDS = new Set(["failure", "reference"]);

// Create a learning. With create_root_cause_task, auto-spawn a queued `chore`
// task (brief prefilled from the learning) and link it — the "unblock now,
// root-cause later" flow. Only kind='failure' may spawn one: a reference/typo
// kind describes no regression to root-cause.
function createLearning(db: DB, body: any): Response {
  if (!body?.project_id) return err("project_id is required");
  if (!body?.title) return err("title is required");
  if (!CREATABLE_KINDS.has(body.kind)) return err("kind is required: 'failure' or 'reference'", 400);
  if (!db.query("SELECT 1 FROM projects WHERE id = ?").get(body.project_id))
    return err("unknown project_id", 400);
  // Reference facts route to the reference store (pinned into briefs, browsable
  // under References), not the occurrence-aged failure ledger.
  if (body.kind === "reference") {
    if (body.create_root_cause_task) return err("create_root_cause_task only applies to kind 'failure'", 400);
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
    kind: body.kind,
  };
  if (body.create_root_cause_task)
    row.root_cause_task_id = createRootCauseTask(db, row);
  db.query(
    `INSERT INTO learnings (id, project_id, title, body, source_task_id, occurrences,
      first_seen, last_seen, status, root_cause_task_id, kind) VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    row.id, row.project_id, row.title, row.body, row.source_task_id, row.occurrences,
    row.first_seen, row.last_seen, row.status, row.root_cause_task_id, row.kind
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

// Retract the chore a learning auto-spawned when that learning stops justifying
// it (recategorized off 'failure', or deleted): an untouched queued one is a
// bogus dispatch waiting to happen. A task already picked up (or finished) is
// left alone — don't yank live work. Only a task hive spawned for *this*
// learning qualifies, proven by createRootCauseTask's `created` event:
// root_cause_task_id is also settable by hand through PUT, and cancelling a
// director's own queued work is worse than the bogus chore this guards against.
// Reports whether it actually cancelled, so callers only drop the link when the
// task really went away.
function cancelQueuedRootCauseTask(
  db: DB,
  learning: { id: string; root_cause_task_id: string | null } | null | undefined,
  reason: string
): boolean {
  const taskId = learning?.root_cause_task_id;
  if (!taskId || getTask(db, taskId)?.state !== "queued") return false;
  const spawned = db
    .query(
      "SELECT 1 FROM events WHERE task_id = ? AND type = 'created' AND json_extract(payload, '$.learning_id') = ? LIMIT 1"
    )
    .get(taskId, learning!.id);
  if (!spawned) return false;
  try {
    transition(db, taskId, "cancelled", { source: "director", reason });
    return true;
  } catch (e) {
    console.error("[hive] cancel root-cause task:", e);
    return false;
  }
}

// kind is correctable here (unlike create, which requires it explicit) — a
// misfiled 'failure' that was actually a routine reference note would
// otherwise sit in the ledger, pinned into every brief, for the project's life.
// The same two kinds as create, in both directions: 'decision' rows are
// authoritative director rulings owned by recordDecisionKnowledge, so a PUT can
// neither promote into that set nor demote a ruling out of it (which would drop
// it from the decisions brief and re-ask the same question as a fresh row).
function updateLearning(db: DB, id: string, body: any): Response {
  const r: any = db.query("SELECT * FROM learnings WHERE id = ?").get(id);
  if (!r) return err("learning not found", 404);
  if (body.status && !["active", "resolved"].includes(body.status))
    return err("status must be 'active' or 'resolved'");
  // Only an actual change is a recategorization: a read-modify-write client
  // echoing the row's own kind back must not trip either fence.
  const recategorizing = body.kind !== undefined && body.kind !== r.kind;
  if (recategorizing && r.kind === "decision")
    return err("decision learnings are managed automatically and cannot be recategorized");
  if (recategorizing && !CREATABLE_KINDS.has(body.kind))
    return err("kind must be 'failure' or 'reference'");
  const next = {
    title: body.title ?? r.title,
    body: body.body ?? r.body,
    status: body.status ?? r.status,
    kind: body.kind ?? r.kind,
    root_cause_task_id: body.root_cause_task_id ?? r.root_cause_task_id,
  };
  if (
    recategorizing && r.kind === "failure" &&
    cancelQueuedRootCauseTask(db, r, `learning recategorized from failure to ${body.kind}`)
  )
    next.root_cause_task_id = null;
  db.query(
    "UPDATE learnings SET title = ?, body = ?, status = ?, kind = ?, root_cause_task_id = ? WHERE id = ?"
  ).run(next.title, next.body, next.status, next.kind, next.root_cause_task_id, id);
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
    const context = fields.context ?? note;
    if (!String(context ?? "").trim()) return err("needs-decision needs context", 400);
    const decision = createDecision(db, {
      task_id: taskId,
      title: fields.title || note || "Decision needed",
      context,
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
      if (decisionAnswerUnaddressed(db, taskId)) {
        writeEvent(db, { task_id: taskId, source, type: "ready_held", payload: { reason: "stale_review" } });
        broadcastTask(db, getTask(db, taskId));
        return json({
          held: true,
          reason: "stale_review",
          message: "Handoff held: the director answered a decision after the latest review summary. Continue with that input, then regenerate the explanation and understanding checks before emitting ready again.",
        });
      }
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
    // Turn ENDED (the Stop hook, not a subagent finishing): if the agent's own
    // final message named work it has not done, resume it with its own words.
    // Best-effort — a supervision check must never fail the agent's heartbeat.
    if (type === "agent_turn_end" && payload.hook === "Stop") {
      const herdr = deps.herdr ?? defaultHerdr;
      try {
        await autoResumeOnTurnEnd(db, taskId, (id, message) => internalSteer(db, herdr, id, message));
      } catch (e) {
        console.error("[hive] auto-resume:", e);
      }
    }
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
    let rawUnderstanding: any = (fields as any).understanding;
    if (typeof rawUnderstanding === "string") {
      try { rawUnderstanding = JSON.parse(rawUnderstanding); } catch { rawUnderstanding = null; }
    }
    if (rawUnderstanding && typeof rawUnderstanding === "object" && !Array.isArray(rawUnderstanding)) {
      const text = (value: unknown, max = 600) =>
        typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
      const understanding: Record<string, unknown> = {};
      for (const key of ["background", "scope", "essence", "risk_assessment", "participate"]) {
        const value = text(rawUnderstanding[key]);
        if (value) understanding[key] = value;
      }
      if (Array.isArray(rawUnderstanding.walkthrough)) {
        const walkthrough = rawUnderstanding.walkthrough.map((value: unknown) => text(value)).filter(Boolean).slice(0, 4);
        if (walkthrough.length) understanding.walkthrough = walkthrough;
      }
      if (Array.isArray(rawUnderstanding.affected_areas)) {
        const affectedAreas = rawUnderstanding.affected_areas.map((value: unknown) => text(value)).filter(Boolean).slice(0, 5);
        if (affectedAreas.length) understanding.affected_areas = affectedAreas;
      }
      const rawCheck = rawUnderstanding.check;
      const rawChecks = Array.isArray(rawUnderstanding.checks)
        ? rawUnderstanding.checks
        : Array.isArray(rawCheck)
          ? rawCheck
          : [];
      const submittedChecks = rawChecks.length ? rawChecks : rawCheck ? [rawCheck] : [];
      if (submittedChecks.some(isAgentProcedureQuestion))
        return err("understanding checks must teach the director about this specific change, not test agent procedures", 400);
      const checks = rawChecks.flatMap((value: unknown) => {
        const check = normalizeUnderstandingCheck(value);
        return check ? [{
          question: check.question,
          options: check.options,
          answer_key: check.answerKey,
          ...(check.explanation ? { explanation: check.explanation } : {}),
        }] : [];
      }).slice(0, 5);
      if (checks.length) understanding.checks = checks;
      if (!checks.length && rawCheck && typeof rawCheck === "object" && !Array.isArray(rawCheck)) {
        const check = normalizeUnderstandingCheck(rawCheck);
        if (check) understanding.check = {
          question: check.question,
          options: check.options,
          answer_key: check.answerKey,
          ...(check.explanation ? { explanation: check.explanation } : {}),
        };
      }
      if (Object.keys(understanding).length) payload.understanding = understanding;
    }
    if (!Object.keys(payload).length)
      return err("review_summary needs a structured review section");
    const latest = db
      .query("SELECT * FROM events WHERE task_id = ? AND type = 'review_summary' ORDER BY rowid DESC LIMIT 1")
      .get(taskId) as any;
    if (
      latest?.payload === JSON.stringify(payload) &&
      !changesRequestUnaddressed(db, taskId) &&
      !decisionAnswerUnaddressed(db, taskId)
    )
      return json({ event: parseEvent(latest), duplicate: true }, 201);
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

// Attach the derived bundle (and, for planner-breakdown cards, the structured
// plan) to a parsed decision. Cheap enough to run on every open card at
// fetch/broadcast time; skipped implicitly for terminal cards that callers
// never pass here.
export function withBundle(db: DB, d: any): any {
  return { ...d, bundle: decisionBundle(db, d.task_id, d.id), plan: decisionPlan(db, d.task_id, d.id) };
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
  if (!String(body?.context ?? "").trim()) return err("context is required", 400);
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
  const projectId = url.searchParams.get("project_id");
  const rows = projectId
    ? status === "all"
      ? db.query("SELECT d.* FROM decisions d JOIN tasks t ON t.id = d.task_id WHERE t.project_id = ? ORDER BY d.ts DESC").all(projectId)
      : db.query("SELECT d.* FROM decisions d JOIN tasks t ON t.id = d.task_id WHERE d.status = ? AND t.project_id = ? ORDER BY d.ts DESC").all(status, projectId)
    : status === "all"
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

function decisionAnswerBodyError(body: any): string | null {
  if (body?.answer_note !== undefined && typeof body.answer_note !== "string")
    return "answer_note must be a string";
  if (body?.selected_indices !== undefined && !Array.isArray(body.selected_indices))
    return "selected_indices must be an array of indices";
  return null;
}

export function apiAnswerDecision(db: DB, herdr: Herdr, id: string, body: any, supervisorVerified = false): Response {
  const r: any = db.query("SELECT * FROM decisions WHERE id = ?").get(id);
  if (!r) return err("decision not found", 404);
  if (r.status !== "open") return err(`decision already ${r.status}`, 409);
  const answerKey = body?.answer_key;
  if (!answerKey) return err("answer_key is required");
  const options: any[] = JSON.parse(r.options || "[]");
  if (options.length && !options.some((o) => o.key === answerKey))
    return err(`answer_key '${answerKey}' is not one of the options`, 400);
  const bodyError = decisionAnswerBodyError(body);
  if (bodyError) return err(bodyError, 400);
  const submittedAnswerNote = body?.answer_note;

  // Caller identity. A missing source is NOT assumed to be the director — the
  // web UI now sends source:"director" explicitly, so a bare call is a caller
  // we cannot vouch for ("unknown"). A present-but-invalid source is rejected.
  const answeredBy = body?.source ?? "unknown";
  if (!ANSWER_SOURCES.includes(answeredBy))
    return err(`source '${answeredBy}' is not one of ${ANSWER_SOURCES.join("|")}`, 400);
  const answeredActor = body?.actor ?? null;
  if (answeredBy === "chat_supervisor" && !supervisorVerified) {
    if (!answeredActor || !getThread(db, String(answeredActor)))
      return err("chat_supervisor decision answers require a valid thread actor", 403);
    const task = getTask(db, r.task_id);
    const autonomy = projectAutonomyProfile(db, task?.project_id ?? null);
    if (autonomy === "conservative") return err("project autonomy is conservative; decision requires the director", 403);
    if (autonomy === "balanced") return err("balanced autonomy may only use the safe auto-answer endpoint", 403);
    const verdict = evaluateAutopilotApprove(db, r, answerKey);
    if (!verdict.allow) return json({ effect: "escalate", category: verdict.category, reason: verdict.reason }, 403);
  }

  const plan = decisionPlan(db, r.task_id, id);
  const selectedIndices = body?.selected_indices;
  if (plan && answerKey === "approve" && selectedPlanIndices(plan.proposed_tasks.length, selectedIndices).length === 0)
    return err("Cannot approve a planner breakdown with no tasks; answer 'reject' instead.", 400);

  const answeredAt = now();
  const answerNote = submittedAnswerNote ?? r.draft_note ?? null;
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
    resolvePlanForDecision(db, r.task_id, id, answerKey, selectedIndices, answerNote),
    resolveRecoveryForDecision(db, id, answerKey),
    resolveBlockedForDecision(db, herdr, id, answerKey),
    resolveDuplicateForDecision(db, id, answerKey),
    resolveRepoMismatchForDecision(db, id, answerKey),
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
  const bodyError = decisionAnswerBodyError(body);
  if (bodyError) return err(bodyError, 400);

  const task = getTask(db, r.task_id);
  if (projectAutonomyProfile(db, task?.project_id ?? null) === "conservative") {
    writeEvent(db, {
      task_id: r.task_id,
      source: "chat_supervisor",
      type: "auto_approve_declined",
      payload: { decision_id: id, answer_key: answerKey, category: "autonomy", reason: "project autonomy is conservative; decision requires the director" },
    });
    return json({ effect: "escalate", category: "autonomy", reason: "project autonomy is conservative; decision requires the director" }, 403);
  }

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
  return apiAnswerDecision(db, herdr, id, { ...body, source: "chat_supervisor" }, true);
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
  if (await f.exists()) return new Response(f, rel === "index.html" ? { headers: { "Cache-Control": "no-store" } } : undefined);
  // SPA fallback to index.html if the build exists at all
  const index = Bun.file(join(WEB_DIST, "index.html"));
  if (await index.exists()) return new Response(index, { headers: { "Cache-Control": "no-store" } });
  return new Response("web app not built", {
    status: 404,
    headers: { "Content-Type": "text/plain", ...CORS },
  });
}
