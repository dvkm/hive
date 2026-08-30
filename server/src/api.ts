// HTTP routing for hive. Plain Bun.serve routing by hand (zero deps).
// The exact request/response contract lives in docs/API.md.
import { dirname, join, normalize } from "node:path";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import type { DB } from "./db.ts";
import { newId, now, evidenceDir, isOffline, setSetting, getSetting } from "./db.ts";
import { taskWithHealth, tasksWithHealth, broadcastTask, needsAttention, herdrOutage, sessionUtilization } from "./health.ts";
import { isSupervisedTask, isExternalTask, supervisedSql, neverDispatched, isJiraMirror } from "./supervision.ts";
import { activeProjects, isEphemeralRepoPath, notTestProjectSql } from "./testProjects.ts";
import { addClient, removeClient, broadcast, appClientCount, setProjectResolver } from "./bus.ts";
import {
  transition,
  writeEvent,
  getTask,
  TransitionError,
  TERMINAL,
  advanceIfFinished,
  verificationGate,
  verificationChecklist,
  missingVerifications,
  evidenceCount,
  evidenceAtSha,
  changesRequestUnaddressed,
  decisionAnswerUnaddressed,
  isDeferred,
  isTrackingOnlyTask,
  TRACKING_ONLY_REQUEUE_ERROR,
  TRACKING_ONLY_OWNERSHIP_ERROR,
  deferTask,
  undeferTask,
  unmetDeps,
  repointDependents,
  dependsTransitivelyOn,
  dependentsWedgedForDecision,
  resolveDependentsWedgedForDecision,
  queuedInputRecoveryPending,
  isSelfAuditLineage,
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
import { queuedSteers, markSteersDelivered, resumeReviewForDeliveredSteers, steerPreamble, queueSteerEvent, type Delivery } from "./steer.ts";
import { cleanupTask, runStackCmd } from "./cleanup.ts";
import { takeOver, handBack, TakeoverError } from "./takeover.ts";
import { figmaTokenEnv, resolveProjectSecrets, serviceName } from "./secrets.ts";
import { teamclaudeEnv, teamclaudeOverlay, usesTeamclaude } from "./teamclaude.ts";
import { smokeThenAdvance, type Fetcher } from "./monitors.ts";
import {
  deploymentsStatus,
  startDeploy,
  startRollback,
  type DeploymentsConfig,
} from "./deployments.ts";
import { enqueue, ackNotifications, markShown, recordDeliveryError, lastDeliveryError } from "./notifications.ts";
import { authorize, resolveGrantForDecision, resolveDenyGuardrailForDecision, type AuthzInput } from "./authority.ts";
import { isReviewed } from "./dispatcher.ts";
import { runPlanner, resolvePlanForDecision, decisionPlan, selectedPlanIndices, type PlannerExec } from "./planner.ts";
import { claudeProfileEnvForRepo } from "./claudeProfiles.ts";
import { makePlaybook } from "./playbook.ts";
import { routeIntakeProject } from "./intake/route.ts";
import {
  REF_PREFIX as JIRA_REF_PREFIX,
  JIRA_COMMENT_MAX_LENGTH,
  JIRA_WRITE_SCOPE,
  jiraConfig,
  jiraConfigStatusFor,
  readSyncState as readJiraSyncState,
  runProjectCycle as runJiraProjectCycle,
  pendingOutbound,
  deliveredOutbound,
  resolveUnknownOutbound,
  resolveEvidenceUrl,
  linkTaskToJira,
  type JiraDeps,
} from "./intake/jira.ts";
import { detectDuplicate, mergeInto, openDuplicateDecision, resolveDuplicateForDecision, duplicateClusters } from "./dedup.ts";
import { triageIntake, resolveIntakeTriageForDecision } from "./intake/triage.ts";
import { noteRepoMismatch, resolveRepoMismatchForDecision } from "./repoTarget.ts";
import { costUsd } from "./pricing.ts";
import { checkUsageGuardrails, resolveUsageCapForDecision, taskSpend } from "./costs.ts";
import { resolveScopeDriftForDecision } from "./drift.ts";
import { evaluateAutoApprove, evaluateAutopilotApprove, NO_AUTO_ANSWER_REASON } from "./autoapprove.ts";
import { decisionAnswerTokenOk, vapidPublicKey, saveSubscription, removeSubscription, type PushSub } from "./push.ts";
import { explainCommandDecision } from "./explain.ts";
import { confirmedRisks, cautionCleared, latestAutoReviewVerdict, reviewCompleteForHead } from "./reviewer.ts";
import { explanationFor, explanationGate } from "./explainDiff.ts";
import { agentPlatformEnv, commandForCurrentShell } from "./platform.ts";
import { critiquePlan, parsePlan, planGateBlocks, planReleaseSteer } from "./planCritic.ts";
import { autoResumeOnTurnEnd } from "./resume.ts";
import { ciStatusOf, ciStatusProbed, probePrReadiness, reclaimDeadWorktree, infraTaskOpen, probeAgent } from "./reconciler.ts";
import { getAway, setAway, awayNow, heldPushes, lastFlush, syncAway } from "./away.ts";
import type { AwayConfig } from "./away.ts";
import { taskDiff } from "./diff.ts";
import { authoredFiles, captureBranchScope, detectDestructiveRebase, type BranchScope } from "./rebaseGuard.ts";
import { landGraph, markLand, resolveLandPauseForDecision } from "./landQueue.ts";
import { followServingBranch, resolveServingFollowForDecision } from "./servingBranch.ts";
import { findEmbeddedTasks } from "./branchContents.ts";
import type { Exec } from "./exec.ts";
import { autonomyStats } from "./autonomyStats.ts";
import { defaultExec, isSafeRef, projectBaseBranch, projectComparisonBase, preferSafeRef } from "./exec.ts";
import { taskIdFromBody, taskNumberFromTitle } from "./marker.ts";
import { projectPrefix, taskIdentifier } from "./taskIdentifier.ts";
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
  COMMITMENT_STATUSES,
  type ChatThread,
} from "./chat.ts";
import { validateProjectConfig, type Agent } from "./projectConfig.ts";
import { gardenerQueue, resolveGardenerDecision, setGardenerOverride } from "./prGardener.ts";

export interface HandlerDeps {
  herdr?: Herdr; // injectable for tests
  supervise?: boolean; // start the herdr wait loop after spawn (true in prod wiring)
  plannerExec?: PlannerExec; // injectable planner subprocess (domain supervisors)
  triageExec?: PlannerExec; // injectable intake-triage classifier (intake/triage.ts)
  exec?: Exec; // injectable gh/git subprocess (diff + merge); tests pass a stub
  fetch?: Fetcher; // injectable smoke-check fetcher (post-merge); tests pass a stub
  jira?: JiraDeps;
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

function actorOf(body: any): string | null {
  const actor = body?.actor == null ? "" : String(body.actor).trim();
  return actor || null;
}

function staleResponse(message: string, resolution: Record<string, unknown>): Response {
  const source = resolution.source ? String(resolution.source) : "unknown actor";
  const actor = resolution.actor ? ` (${String(resolution.actor)})` : "";
  const at = resolution.at ? ` at ${String(resolution.at)}` : "";
  const outcome = resolution.answer_label ?? resolution.verdict ?? resolution.reason;
  return json({ error: `${message} by ${source}${actor}${at}${outcome ? `: ${String(outcome)}` : ""}`, stale: true, resolution }, 409);
}

// Background-loop liveness for /api/health (incident 2026-07-17: the
// dispatcher stopped ticking for 3.5h with zero outward signal). Threshold is
// 3 missed cycles, floored at 5min so a loop's own interval never makes it
// flap stale right before its next tick.
const STALE_FLOOR_MS = 5 * 60 * 1000;
const DISPATCH_STALE_MS = Math.max(STALE_FLOOR_MS, Number(process.env.HIVE_DISPATCH_MS || 30_000) * 3);
const REAP_STALE_MS = Math.max(STALE_FLOOR_MS, Number(process.env.HIVE_REAP_MS || 300_000) * 3);
const RECONCILE_STALE_MS = Math.max(STALE_FLOOR_MS, Number(process.env.HIVE_RECONCILE_MS || 60_000) * 3);
function loopLiveness(db: DB, settingKey: string, staleMs: number): { last_run: string | null; stale: boolean } {
  const lastRun = getSetting(db, settingKey);
  const ageMs = lastRun ? Date.now() - Date.parse(lastRun) : null;
  return { last_run: lastRun, stale: ageMs === null || ageMs > staleMs };
}

// task #1096: the reconciler (gh PR sync, herdr status sync, staleness flags)
// errored on EVERY cycle for ~27min live (gh ENOENT) and /health stayed
// ok:true throughout — reconciler.error_streak set by reconciler.ts's
// heartbeat() was the only place that failure was recorded at all. 3
// consecutive failing cycles (not "never run yet", which would false-alarm on
// every fresh boot before the first cycle completes) is the sustained-failure
// signal that flips top-level `ok`.
const RECONCILE_ERROR_STREAK_THRESHOLD = 3;
// reviewer.ts's reviewer_parse_failure_streak (task HIVE-446): the model kept
// producing unparseable output on every attempt, same sustained-failure signal
// as the reconciler's error streak above.
const REVIEWER_PARSE_FAILURE_STREAK_THRESHOLD = 3;
function reviewerHealth(db: DB): { parse_failure_streak: number } {
  return { parse_failure_streak: Number(getSetting(db, "reviewer_parse_failure_streak") ?? "0") };
}
function reconcilerHealth(db: DB): { last_run: string | null; stale: boolean; consecutive_errors: number; last_error: string | null } {
  return {
    ...loopLiveness(db, "last_reconcile_at", RECONCILE_STALE_MS),
    consecutive_errors: Number(getSetting(db, "reconciler_error_streak") ?? "0"),
    last_error: getSetting(db, "reconciler_last_error"),
  };
}

// Tools the reconciler could not start for several cycles running (task #1667:
// `gh` against a repo_path that no longer existed). Those are skipped and
// retried rather than raised as cycle errors, so without this they would be
// invisible: PR linking off, /api/health saying ok. Written by reconciler.ts's
// noteToolStart; an empty value means recovered.
export function degradedTools(db: DB): string[] {
  const rows = db.query("SELECT key, value FROM settings WHERE key LIKE 'tool_degraded_%' AND value <> ''").all() as { key: string; value: string }[];
  return rows.map((r) => `${r.key.replace("tool_degraded_", "")}: ${r.value}`).sort();
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

// Resolve a project for the deployments routes. The tab is opt-in: a project
// without a config.deployments block has no production release model, so it 404s
// rather than guessing one.
type DeploymentsProject =
  | { ok: true; repoPath: string; branch: string; config: DeploymentsConfig }
  | { ok: false; res: Response };

function deploymentsProject(db: DB, id: string): DeploymentsProject {
  const row = db.query("SELECT * FROM projects WHERE id = ?").get(id);
  if (!row) return { ok: false, res: err("project not found", 404) };
  const project = parseProject(row);
  const config = (project.config as any)?.deployments as DeploymentsConfig | undefined;
  if (!config) return { ok: false, res: err("deployments are not configured for this project", 404) };
  if (!project.repo_path) return { ok: false, res: err("project has no repo_path", 400) };
  return { ok: true, repoPath: project.repo_path, branch: projectBaseBranch(project.config), config };
}

const WEB_DIST = join(import.meta.dir, "..", "..", "web", "dist");
const HOOKS_DIR = join(import.meta.dir, "..", "..", "hooks");
const REPO_ROOT = join(import.meta.dir, "..", "..");
const ELECTRON_PKG = join(REPO_ROOT, "electron", "package.json");

// The API token (minted on boot in index.ts) presented as `Authorization:
// Bearer <t>` or `?token=<t>` — EventSource cannot set headers, so the SSE
// stream needs the query form. No token minted → nothing can authenticate.
function tokenOk(db: DB, req: Request, url: URL): boolean {
  const token = getSetting(db, "api_token");
  if (!token) return false;
  const presented =
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() || url.searchParams.get("token");
  return presented === token;
}

// Remote requests (a phone on the LAN / Tailscale) must present the API token.
// A push action may instead present the token scoped to that exact decision.
// Loopback (CLI, hooks, agents, the desktop app) stays trustless as before.
// Exported for tests.
export function remoteAuthOk(db: DB, req: Request, url: URL, ip: string | null): boolean {
  if (!ip || ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1") return true;
  if (tokenOk(db, req, url)) return true;
  const answer = req.method === "POST" && url.pathname.match(/^\/api\/decisions\/([^/]+)\/answer$/);
  const presented = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() || null;
  return !!answer && decisionAnswerTokenOk(db, answer[1], presented);
}

// Credential-bearing writes need the API token even from loopback. Config and
// secret values can reach network/subprocess destinations (scout #991), while
// a push subscription can redirect notification payloads to an attacker.
// Reads and the task flow stay trustless so CLI/hook/agent calls keep working.
//
// The local capability that satisfies this is filesystem access to hive's DB:
// the CLI reads the minted token out of ~/.hive/hive.db (see cli/hive.ts) the
// same way `hive remote` does, while a caller that only holds an HTTP socket
// cannot. Any future credential-bearing write belongs on this list.
const WRITE_AUTH_ROUTES: { method: string; path: RegExp }[] = [
  { method: "PUT", path: /^\/api\/projects\/[^/]+$/ },
  { method: "POST", path: /^\/api\/projects\/[^/]+\/secrets$/ },
  { method: "DELETE", path: /^\/api\/projects\/[^/]+\/secrets\/[^/]+$/ },
  { method: "POST", path: /^\/api\/projects\/[^/]+\/pr-gardener\/\d+$/ },
  { method: "POST", path: /^\/api\/push\/subscribe$/ },
  // Deploying and rolling back production. Hive has no user accounts, so the
  // API token IS the super-admin check: holding it means filesystem access to
  // hive's own DB, which an agent's HTTP socket or a stray browser tab does not
  // have. Reading the release list stays open; only pressing the button is gated.
  { method: "POST", path: /^\/api\/projects\/[^/]+\/deployments\/(deploy|rollback)$/ },
];

// True when the request may proceed: either it is not a gated write, or it
// presented the token. Exported for tests.
export function requireWriteAuth(db: DB, req: Request, url: URL): boolean {
  if (!WRITE_AUTH_ROUTES.some((r) => r.method === req.method && r.path.test(url.pathname)))
    return true;
  return tokenOk(db, req, url);
}

export function makeHandler(db: DB, deps: HandlerDeps = {}) {
  const herdr = deps.herdr ?? defaultHerdr;
  // Lets bus.ts stamp project_id onto frames that only name a task.
  setProjectResolver((taskId) => (db.query("SELECT project_id FROM tasks WHERE id = ?").get(taskId) as any)?.project_id ?? null);
  async function handle(req: Request, server?: { requestIP?: (r: Request) => { address: string } | null }): Promise<Response> {
    const url = new URL(req.url);
    const { pathname } = url;
    const method = req.method;

    if (method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    if (pathname.startsWith("/api/")) {
      const ip = server?.requestIP?.(req)?.address ?? null;
      if (!remoteAuthOk(db, req, url, ip)) return err("unauthorized (see `hive remote` for the token)", 401);
      if (!requireWriteAuth(db, req, url))
        return err("unauthorized: this write requires the API token (see `hive remote`)", 401);
    }

    try {
      // ---- SSE stream ----
      if (pathname === "/api/stream" && method === "GET") return sseStream(url.searchParams);

      // ---- health ----
      if (pathname === "/api/health" && method === "GET") {
        const reconciler = reconcilerHealth(db);
        const reviewer = reviewerHealth(db);
        const degraded = degradedTools(db);
        const ok = reconciler.consecutive_errors < RECONCILE_ERROR_STREAK_THRESHOLD
          && reviewer.parse_failure_streak < REVIEWER_PARSE_FAILURE_STREAK_THRESHOLD
          && degraded.length === 0;
        return json({ ok, version: VERSION, dispatcher: loopLiveness(db, "last_dispatch_at", DISPATCH_STALE_MS), reaper: loopLiveness(db, "last_reap_at", REAP_STALE_MS), reconciler, reviewer, degraded, herdr_outage: herdrOutage(db), sessions: sessionUtilization(db) });
      }

      // ---- desktop shell self-update (HIVE-420) ----
      if (pathname === "/api/shell-version" && method === "GET") {
        const pkg = JSON.parse(readFileSync(ELECTRON_PKG, "utf8"));
        return json({ version: pkg.version, repo_path: REPO_ROOT });
      }

      // ---- evidence static files ----
      if (pathname.startsWith("/evidence/") && method === "GET")
        return serveEvidence(pathname);

      // ---- projects ----
      if (pathname === "/api/projects") {
        if (method === "GET") {
          // Archived projects (config.archived === true) are hidden unless
          // ?archived=all is passed. tasks still reference them; there is no delete.
          // Test/ephemeral projects (config.test === true, see testProjects.ts)
          // are hidden the same way, unless ?test=all is passed.
          const includeArchived = url.searchParams.get("archived") === "all";
          const includeTest = url.searchParams.get("test") === "all";
          const conds: string[] = [];
          if (!includeArchived) conds.push("COALESCE(json_extract(config, '$.archived'), 0) = 0");
          if (!includeTest) conds.push(notTestProjectSql());
          const sql = "SELECT * FROM projects" + (conds.length ? " WHERE " + conds.join(" AND ") : "") + " ORDER BY created_at";
          return json(db.query(sql).all().map(projectPayload));
        }
        if (method === "POST") return createProject(db, await req.json());
      }
      {
        const match = pathname.match(/^\/api\/projects\/([^/]+)\/pr-gardener$/);
        if (match && method === "GET") {
          if (!db.query("SELECT 1 FROM projects WHERE id = ?").get(match[1])) return err("project not found", 404);
          return json(gardenerQueue(db, match[1]));
        }
      }
      {
        const match = pathname.match(/^\/api\/projects\/([^/]+)\/pr-gardener\/(\d+)$/);
        if (match && method === "POST") {
          const body = await req.json() as any;
          const prNumber = Number(match[2]);
          const item: any = db.query("SELECT * FROM pr_gardener_items WHERE project_id = ? AND pr_number = ?").get(match[1], prNumber);
          if (!item) return err("PR Gardener item not found", 404);
          if (item.decision_id && body.override !== null) {
            const answered = apiAnswerDecision(db, herdr, item.decision_id, { answer_key: body.override, source: "director" });
            if (!answered.ok) return answered;
          } else if (!setGardenerOverride(db, match[1], prNumber, body.override)) {
            return err("override must be force_land, force_close, hold, or null", 400);
          }
          return json(gardenerQueue(db, match[1]).find((row) => row.pr_number === prNumber));
        }
      }
      // ---- deployments (production releases: what is live + the two buttons) ----
      {
        const match = pathname.match(/^\/api\/projects\/([^/]+)\/deployments(\/deploy|\/rollback)?$/);
        if (match) {
          const project = deploymentsProject(db, match[1]);
          if (!project.ok) return project.res;
          const { repoPath, branch, config } = project;
          const exec = deps.exec ?? defaultExec;
          if (!match[2] && method === "GET") {
            // The PostHog key is only resolved when the project actually asked
            // for flag states, so the keychain is left alone otherwise.
            const posthogKey = config.flags?.length
              ? (await resolveProjectSecrets(db, match[1], exec)).POSTHOG_API_KEY
              : undefined;
            return json(
              await deploymentsStatus(repoPath, branch, config, { exec, fetcher: deps.fetch, posthogKey })
            );
          }
          if (match[2] && method === "POST") {
            const body = (await safeJson(req)) as any;
            const r =
              match[2] === "/deploy"
                ? await startDeploy(exec, repoPath, branch, config, body?.commit)
                : await startRollback(exec, repoPath, branch, config, body?.tag);
            return r.ok ? json(r) : err(r.error, r.status);
          }
        }
      }
      let m = pathname.match(/^\/api\/projects\/([^/]+)$/);
      if (m && method === "GET") {
        const r = db.query("SELECT * FROM projects WHERE id = ?").get(m[1]);
        return r ? json(projectPayload(r)) : err("project not found", 404);
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
        if (method === "POST") return await createTask(db, req, deps);
      }
      // Land queue (task #1257). Both must precede the /:id route so their
      // path segment isn't parsed as a task id.
      // POST /api/tasks/land-queue {task_ids: [...], queued?: bool} — mark (or
      // unmark) in-review tasks as approved-to-land, in ONE call.
      if (pathname === "/api/tasks/land-queue" && method === "POST") {
        const body = await safeJson(req);
        const ids = Array.isArray(body?.task_ids) ? body.task_ids.map(String) : [];
        if (!ids.length) return err("task_ids must be a non-empty array", 400);
        const queued = body?.queued !== false;
        return json({ changed: markLand(db, ids, queued), queued });
      }
      // GET /api/tasks/land-graph?project=<id> — the review column's ordering
      // edges (declared dependencies + inferred file conflicts) for the board.
      if (pathname === "/api/tasks/land-graph" && method === "GET") {
        const projectId = url.searchParams.get("project");
        const projects = projectId ? [{ id: projectId }] : activeProjects(db).map((p) => ({ id: p.id }));
        const graphs = await Promise.all(projects.map((p) => landGraph(db, p.id, deps.exec ?? defaultExec)));
        return json({ nodes: graphs.flatMap((g) => g.nodes), edges: graphs.flatMap((g) => g.edges) });
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
          saveSubscription(db, await req.json() as PushSub);
          return json({ ok: true });
        } catch (e: any) {
          return err(String(e?.message ?? e), 400);
        }
      }
      if (pathname === "/api/push/unsubscribe" && method === "POST") {
        // Excluded from WRITE_AUTH_ROUTES (no token required) because this route
        // can only remove the named endpoint, but it still runs through the
        // remoteAuthOk check above like every other /api/ route.
        const b: any = await safeJson(req);
        if (b?.endpoint) removeSubscription(db, b.endpoint);
        return json({ ok: true });
      }

      if (pathname === "/api/stats/autonomy" && method === "GET")
        return json(
          await autonomyStats(db, {
            days: Number(url.searchParams.get("days")) || undefined,
            projectId: url.searchParams.get("project_id"),
            exec: url.searchParams.get("reverts") === "0" ? null : deps.exec,
          })
        );

      if (pathname === "/api/checkpoints" && method === "GET") return listOpenCheckpoints(db, url);
      if (pathname === "/api/understanding-quizzes" && method === "GET") return listUnderstandingQuizzes(db, url);

      if (pathname === "/api/offline" && method === "GET")
        return json({ on: isOffline(db) });
      if (pathname === "/api/offline" && method === "POST")
        return await setOffline(db, herdr, await req.json());

      if (pathname === "/api/away" && method === "GET")
        return json({ ...getAway(db), active: awayNow(db), held: heldPushes(db).length, items: heldPushes(db), last_flush: lastFlush(db) });
      if (pathname === "/api/away" && method === "POST") return setAwayMode(db, await req.json());
      m = pathname.match(/^\/api\/tasks\/([^/]+)\/checkpoints\/([^/]+)\/ack$/);
      if (m && method === "POST") return await ackCheckpoint(db, herdr, m[1], m[2], await req.json());
      m = pathname.match(/^\/api\/tasks\/([^/]+)\/understanding-quiz\/answer$/);
      if (m && method === "POST") return answerUnderstandingQuiz(db, m[1], await req.json());
      m = pathname.match(/^\/api\/tasks\/([^/]+)\/understanding-quiz\/defer$/);
      if (m && method === "POST") return deferUnderstandingQuiz(db, m[1], await req.json());
      m = pathname.match(/^\/api\/tasks\/([^/]+)\/understanding-quiz\/require$/);
      if (m && method === "POST") return requireUnderstandingQuiz(db, m[1], await req.json());

      m = pathname.match(/^\/api\/tasks\/([^/]+)\/focus-agent$/);
      if (m && method === "POST") return await focusAgent(db, herdr, m[1]);

      // Director take-over / hand-back of a task's worktree (HIVE-352).
      m = pathname.match(/^\/api\/tasks\/([^/]+)\/(takeover|handback)$/);
      if (m && method === "POST") return await takeoverEndpoint(db, herdr, m[1], m[2], await safeJson(req), deps);

      m = pathname.match(/^\/api\/tasks\/([^/]+)\/requeue$/);
      if (m && method === "POST") return await requeueEndpoint(db, herdr, m[1]);

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

      m = pathname.match(/^\/api\/tasks\/([^/]+)\/branch-check$/);
      if (m && method === "GET") return await taskBranchCheckEndpoint(db, m[1], deps);

      m = pathname.match(/^\/api\/tasks\/([^/]+)\/merge$/);
      if (m && method === "POST") return await mergeTask(db, herdr, m[1], await safeJson(req), deps);

      m = pathname.match(/^\/api\/tasks\/([^/]+)\/request-changes$/);
      if (m && method === "POST") return await requestChanges(db, herdr, m[1], await req.json(), deps);

      m = pathname.match(/^\/api\/tasks\/([^/]+)\/jira$/);
      if (m && method === "GET") return jiraTaskState(db, m[1]);

      m = pathname.match(/^\/api\/tasks\/([^/]+)\/jira\/sync$/);
      if (m && method === "POST") return await jiraManualSync(db, m[1], deps.jira);

      m = pathname.match(/^\/api\/tasks\/([^/]+)\/jira\/link$/);
      if (m && method === "POST") {
        const body = await safeJson(req);
        if (!body?.parent_key) return err("parent_key is required");
        return json(await linkTaskToJira(db, m[1], String(body.parent_key), deps.jira), 201);
      }

      m = pathname.match(/^\/api\/tasks\/([^/]+)\/jira\/delivery\/resolve$/);
      if (m && method === "POST") return jiraResolveDelivery(db, m[1], await safeJson(req));

      m = pathname.match(/^\/api\/tasks\/([^/]+)\/guarded-action$/);
      if (m && method === "POST") return guardedAction(db, m[1], await req.json());

      m = pathname.match(/^\/api\/tasks\/([^/]+)\/plan$/);
      if (m && method === "POST") {
        if (!getTask(db, m[1])) return err("task not found", 404);
        const r = await runPlanner(db, m[1], { exec: deps.plannerExec });
        return r.ok ? json({ ok: true, decision: r.decision }) : json({ ok: false, error: r.error }, r.status ?? 502);
      }

      // Distil a finished task into a reusable playbook (a kind='reference'
      // learning). Done tasks only — see makePlaybook.
      m = pathname.match(/^\/api\/tasks\/([^/]+)\/playbook$/);
      if (m && method === "POST") {
        const r = await makePlaybook(db, m[1], { exec: deps.plannerExec, shellExec: deps.exec });
        return r.ok
          ? json({ ok: true, learning_id: r.learning_id, playbook: r.playbook }, 201)
          : json({ ok: false, error: r.error }, r.status);
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
      // The desktop app reports what macOS did with a native notification:
      // {shown:true} it rendered, or {error} it refused.
      m = pathname.match(/^\/api\/notifications\/([^/]+)\/delivery$/);
      if (m && method === "POST") {
        const b: any = await req.json().catch(() => ({}));
        if (b?.error) {
          recordDeliveryError(m[1], String(b.error));
          return json({ ok: false });
        }
        return json({ ok: markShown(db, m[1]) });
      }
      // `hive notify --test`: fire one real notification through the live path.
      if (pathname === "/api/notifications/test" && method === "POST") return testNotification(db);
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
    if (pathname === "/api/tasks" && new URL(req.url).searchParams.get("compact") === "1" &&
        req.headers.get("accept-encoding")?.includes("gzip") && response.body) {
      const headers = new Headers(response.headers);
      headers.set("Content-Encoding", "gzip");
      headers.set("Vary", "Accept-Encoding");
      return new Response(response.body.pipeThrough(new CompressionStream("gzip")), {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }
    return response;
  };
}

// ---------------------------------------------------------------- projects
function createProject(db: DB, body: any): Response {
  if (!body?.name) return err("name is required");
  const invalid = validateProjectConfig(body.config ?? {});
  if (invalid) return err(invalid);
  // A repo_path living inside a task's own worktree/scratchpad can only be a
  // scratch artifact (see testProjects.ts) — auto-flag it test unless the
  // caller already said one way or the other.
  const config = { ...(body.config ?? {}) };
  if (config.test === undefined && isEphemeralRepoPath(body.repo_path)) config.test = true;
  const row = {
    id: newId("proj"),
    name: String(body.name),
    repo_path: body.repo_path ?? null,
    config: JSON.stringify(config),
    created_at: now(),
  };
  db.query(
    "INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)"
  ).run(row.id, row.name, row.repo_path, row.config, row.created_at);
  return json(projectPayload(row), 201);
}

// Update a project's mutable fields. `config` is REPLACED wholesale (the web UI
// reads the project, edits keys like auto_dispatch, and writes the object back).
function updateProject(db: DB, id: string, body: any): Response {
  const existing: any = db.query("SELECT * FROM projects WHERE id = ?").get(id);
  if (!existing) return err("project not found", 404);
  const name = body?.name != null ? String(body.name) : existing.name;
  const repo_path = body?.repo_path !== undefined ? body.repo_path : existing.repo_path;
  if (body?.config !== undefined) {
    const invalid = validateProjectConfig(body.config);
    if (invalid) return err(invalid);
  }
  const config = body?.config !== undefined ? JSON.stringify(body.config) : existing.config;
  db.query("UPDATE projects SET name = ?, repo_path = ?, config = ? WHERE id = ?").run(name, repo_path, config, id);
  return json(projectPayload(db.query("SELECT * FROM projects WHERE id = ?").get(id)));
}

// The project payload the UI reads. `jira_site` is the CANONICALIZED site from
// the credential gate, never the raw config value: a client that builds a
// browse URL must not be able to be pointed at an attacker-named host by a
// config write, which is the same guarantee jiraTaskState's browse_url makes.
function projectPayload(row: any) {
  const project = parseProject(row);
  return { ...project, jira_site: jiraConfig(project.config)?.site ?? null };
}

// ---------------------------------------------------------------- jira
// Everything the board needs to show a mirrored Jira ticket honestly: where it
// lives, when it last synced, what is still unresolved, and any error
// that has NOT been cleared by a later success. A director should never have to
// guess whether the sync ran, which is what makes people re-submit work.
function jiraIssueKey(task: { jira_key?: string | null; source_ref?: string | null }): string {
  if (task.jira_key) return task.jira_key;
  const ref = String(task.source_ref ?? "");
  return ref.startsWith(JIRA_REF_PREFIX) ? ref.slice(JIRA_REF_PREFIX.length) : "";
}

function jiraTaskState(db: DB, taskId: string): Response {
  const task = getTask(db, taskId);
  if (!task) return err("task not found", 404);
  const key = jiraIssueKey(task);
  if (!key) return json({ linked: false });
  const configStatus = jiraConfigStatusFor(db, task.project_id);
  const cfg = configStatus.config;
  const state = readJiraSyncState(db, task.project_id);
  const pending = pendingOutbound(db, taskId);
  const assignee = /^Assignee: (.+)$/m.exec(String(task.brief ?? ""))?.[1] ?? null;
  const delivered = deliveredOutbound(db, taskId);
  const site = cfg?.site ?? null;
  const linkedSubtasks = (task.jira_link_kind === "mirror" || isJiraMirror(task))
    ? (db.query(
        `SELECT id, project_id, number, project_number, title, state, jira_key
         FROM tasks
         WHERE project_id = ? AND jira_link_kind = 'subtask' AND (
           parent_task_id = ? OR EXISTS (
             SELECT 1 FROM events
             WHERE task_id = tasks.id AND type = 'jira_sync'
               AND json_extract(payload, '$.action') IN ('link_created', 'link_discovered')
               AND json_extract(payload, '$.parent') = ?
           )
         )
         ORDER BY number`
      ).all(task.project_id, task.id, key) as any[]).map((row) => ({
        id: row.id,
        display_id: taskIdentifier(db, row),
        title: row.title,
        state: row.state,
        jira_key: row.jira_key,
        browse_url: site ? `${site}/browse/${encodeURIComponent(row.jira_key)}` : null,
      }))
    : [];

  return json({
    linked: true,
    issue_key: key,
    browse_url: key && site ? `${site}/browse/${encodeURIComponent(key)}` : null,
    enabled: cfg?.enabled ?? false,
    write: cfg?.write ?? false,
    // A configured-but-malformed target reads as "not configured" here on
    // purpose: the credential gate refused it, and the UI should not imply the
    // site it names is in use.
    configured: !!cfg,
    // The config is present but invalid (a bad JQL filter, unparsable JSON).
    // The automatic cycle is OFF for it, so the board shows this reason from the
    // first read rather than waiting for a failure count to climb.
    config_error: configStatus.error,
    write_scope: { ...JIRA_WRITE_SCOPE, create_subtask: cfg?.write_scope?.create_subtask === true },
    assignee: assignee === "-" ? null : assignee,
    sync: configStatus.error ? { ...state, last_error: `jira cycle could not run: ${configStatus.error}` } : state,
    pending,
    delivered,
    linked_subtasks: linkedSubtasks,
  });
}

function jiraResolveDelivery(db: DB, taskId: string, body: any): Response {
  const task = getTask(db, taskId);
  if (!task) return err("task not found", 404);
  if (!jiraIssueKey(task)) return err("task is not linked to a Jira issue", 400);
  const action = String(body?.action ?? "");
  const sourceId = String(body?.source_id ?? "");
  if ((action !== "comment_push" && action !== "receipt") || !sourceId)
    return err("action and source_id identify the unknown Jira delivery", 400);
  if (!resolveUnknownOutbound(db, taskId, action, sourceId))
    return err("delivery is not awaiting confirmation", 409);
  return jiraTaskState(db, taskId);
}

// Manual retry. Runs the SAME per-project cycle the timer runs, so a director
// clicking retry exercises exactly the automatic path — there is no second
// implementation that could succeed while the real one keeps failing.
async function jiraManualSync(db: DB, taskId: string, deps?: JiraDeps): Promise<Response> {
  const task = getTask(db, taskId);
  if (!task) return err("task not found", 404);
  if (!jiraIssueKey(task)) return err("task is not linked to a Jira issue", 400);
  const r = await runJiraProjectCycle(db, task.project_id, deps);
  return json({ ok: r.ok, error: r.error ?? null, stats: r.stats ?? null, sync: r.state }, r.ok ? 200 : 502);
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
  // braindump lands in the repo it is about and not wherever the UI sat.
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
    // The turn itself now returns before delivery, so the dedupe window must be
    // held open until the thread's delivery settles — otherwise the second
    // submit of a double-send arrives after the entry is gone and starts its
    // own thread/task/spawn.
    pending
      .then((r) => threadIdle(r.thread_id))
      .catch(() => {})
      .finally(() => pendingNewChats.delete(dedupeKey));
  }
  return json(await pending, 202);
}

const pendingNewChats = new Map<string, Promise<{ thread_id: string; delivery: string }>>();

// Persist the message and return; delivery runs asynchronously under the same
// per-thread lock. A cold session spawns a worktree and the project stack (up
// to stack_setup_timeout_ms), which must never hold the director's HTTP request
// open. Progress and failures reach the UI over SSE — chat_delivery for the
// transient status, a visible thread message when it fails.
async function chatTurnOnThread(
  db: DB,
  herdr: Herdr,
  deps: HandlerDeps,
  thread: ChatThread,
  text: string
): Promise<{ thread_id: string; delivery: string }> {
  broadcast({
    type: "chat_message",
    project_id: thread.project_id,
    message: appendMessage(db, thread.id, "director", text),
  });
  keepWarmAttempts.delete(thread.id); // a director turn restarts keep-warm's patience

  // The message the session receives is prefixed so it always knows which thread
  // to reply to, even mid-conversation.
  const wire = `[director → chat thread ${thread.id}]\n${text}`;
  chatDeliveryStatus(thread.id, "queued");
  withThreadLock(thread.id, async () => {
    const delivery = await deliverToSupervisor(db, herdr, deps, thread.id, wire);
    if (delivery.delivery === "failed")
      postThreadNotice(db, thread.id, `Your Chief of Staff could not start: ${delivery.error ?? "spawn failed"}. Send the message again to retry.`);
  }).catch((e) => {
    chatDeliveryStatus(thread.id, "failed", String((e as any)?.message ?? e));
    postThreadNotice(db, thread.id, `Your Chief of Staff could not start: ${String((e as any)?.message ?? e)}. Send the message again to retry.`);
  });
  return { thread_id: thread.id, delivery: "queued" };
}

// Transient delivery status for the open chat panel. Not durable: a reload
// falls back to the thread's own message history, which is.
function chatDeliveryStatus(threadId: string, status: string, error?: string): void {
  broadcast({ type: "chat_delivery", thread_id: threadId, status, ...(error ? { error } : {}) });
}

// A failed turn must be visible in the conversation, not a silent hang. Message
// roles are director|assistant, so the notice rides in as an assistant message.
function postThreadNotice(db: DB, threadId: string, text: string): void {
  broadcast({
    type: "chat_message",
    project_id: getThread(db, threadId)?.project_id ?? null,
    message: appendMessage(db, threadId, "assistant", text),
  });
}

// Tests (and any caller that must observe a settled turn) await the thread's
// in-flight delivery; the lock chain IS that handle.
export function threadIdle(threadId: string): Promise<unknown> {
  return (threadLocks.get(threadId) ?? Promise.resolve()).catch(() => {});
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
    if (!runtimeProjectId) {
      const error = "no project repository is available for the Chief of Staff session";
      chatDeliveryStatus(threadId, "failed", error);
      return { delivery: "failed", error };
    }
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

  // Is the session already live? If so, just send into it (fast path). Uses
  // probeAgent (not a raw herdr.probe) so a herdr registry eviction — the
  // supervisor pane is still alive, only its registration was wiped — is
  // re-adopted here instead of read as dead and sent through spawnAgent, where
  // the spawn guard would correctly refuse (name still held) and drop the turn.
  if (task.agent_target) {
    const { alive } = await probeAgent(herdr, db, taskId!, task.agent_target).catch(() => ({ alive: false }));
    if (alive) {
      chatDeliveryStatus(threadId, "delivering");
      const error = await sendOnce(herdr, task.agent_target, wireMessage);
      if (!error) {
        writeEvent(db, { task_id: taskId!, source: "director", type: "steer", payload: { message: wireMessage, target: task.agent_target, delivery: "delivered", delivered_at: now() } });
        keepWarmAttempts.delete(threadId); // a live session took the message: it is warm
        chatDeliveryStatus(threadId, "delivered");
        return { delivery: "delivered", agent_target: task.agent_target };
      }
      // fall through to respawn on a send failure to a supposedly-live agent
    }
  }

  // Not live: queue the message (it rides in the spawn brief) and spawn.
  queueSteerEvent(db, taskId!, wireMessage, "queued for chat supervisor spawn");
  chatDeliveryStatus(threadId, "spawning");
  const r = await spawnAgent(db, herdr, taskId!, {
    supervise: false, // a standing session never "finishes into review"
    briefOverride: composeSupervisorBrief(db, thread),
  });
  if (!r.ok) {
    chatDeliveryStatus(threadId, "failed", r.error);
    return { delivery: "failed", error: r.error };
  }
  chatDeliveryStatus(threadId, "spawned");
  return { delivery: "spawned", agent_target: r.agent_target };
}

// ---- keep-warm ----
// A supervisor session that dies between director messages otherwise makes the
// NEXT message pay the full cold start (worktree + project stack). Respawn it
// where the death is already observed — syncAgents writes agent_status=gone —
// instead of polling for it. A closed thread has a terminal backing task and is
// never respawned. Attempts only reset on a delivery into a LIVE session, so a
// session that dies right after each spawn backs off instead of looping.
const KEEP_WARM_MAX_ATTEMPTS = 3;
const keepWarmAttempts = new Map<string, number>();

export function keepSupervisorWarm(db: DB, herdr: Herdr, deps: HandlerDeps, event: any): void {
  if (event.type !== "agent_status" || event.payload?.status !== "gone") return;
  const task = getTask(db, event.task_id);
  if (!task || task.source !== "chat_supervisor" || TERMINAL.includes(task.state as State)) return;
  const thread = managingThreadForTask(db, task.id);
  if (!thread || thread.task_id !== task.id) return;
  const attempt = (keepWarmAttempts.get(thread.id) ?? 0) + 1;
  if (attempt > KEEP_WARM_MAX_ATTEMPTS) return;
  keepWarmAttempts.set(thread.id, attempt);
  const message = [
    `[hive keep-warm]`,
    `Your session was restarted after the previous one ended. Read the thread and run ledger, then continue the current run silently.`,
    `Do not message the director just because you restarted.`,
  ].join("\n");
  withThreadLock(thread.id, async () => {
    const r = await deliverToSupervisor(db, herdr, deps, thread.id, message);
    if (r.delivery === "failed" && attempt >= KEEP_WARM_MAX_ATTEMPTS)
      postThreadNotice(db, thread.id, `Your Chief of Staff session could not be restarted (${r.error ?? "spawn failed"}). Send a message to try again.`);
  }).catch((e) => console.error(`[hive] keep-warm ${thread.id}:`, e));
}

function coordinatorProjectId(db: DB): string | null {
  const candidates = activeProjects(db).filter((p) => p.repo_path);
  const hive = candidates.find((p) => p.name.toLowerCase() === "hive");
  return (hive ?? candidates[0])?.id ?? null;
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
  "auto_merge_failed",
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
  events: Map<string, any>;
};
const pendingManagerUpdates = new Map<string, ManagerPending>();
export const MANAGER_WAKEUP_DEBOUNCE_MS = 45_000;

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

export async function flushManagerUpdate(threadId: string): Promise<void> {
  const pending = pendingManagerUpdates.get(threadId);
  if (!pending) return;
  pendingManagerUpdates.delete(threadId);
  const current = getThread(pending.db, threadId);
  if (!current?.task_id) return;
  const manager = getTask(pending.db, current.task_id);
  if (!manager || TERMINAL.includes(manager.state as State)) return; // explicitly closed thread
  const events = [...pending.events.values()].slice(-20);
  const lines = events.map((event) => managerEventLine(pending.db, event));
  const projectIds = [
    ...new Set(
      events
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
  const thread = managingThreadForTask(db, event.task_id);
  if (!thread?.task_id) return;
  if (event.type === "steer" && event.payload?.from_task_id === thread.task_id) return;

  const existing = pendingManagerUpdates.get(thread.id);
  if (existing) {
    // One task can emit several lifecycle events in a burst. Keep only its
    // latest state so a manager gets one actionable line, not a replay.
    existing.events.delete(event.task_id);
    existing.events.set(event.task_id, event);
    return;
  }
  const timer = setTimeout(() => {
    flushManagerUpdate(thread.id).catch((e) => console.error(`[hive] manager wakeup ${thread.id}:`, e));
  }, MANAGER_WAKEUP_DEBOUNCE_MS);
  timer.unref?.();
  pendingManagerUpdates.set(thread.id, { db, herdr, deps, events: new Map([[event.task_id, event]]) });
}

export function projectInboxCounts(db: DB, projectId: string): { checkpoints: number; decisions: number; reviews: number; attention: number } {
  const checkpoints = Number(
    (db
      .query(
        `SELECT COUNT(*) AS n FROM events e JOIN tasks t ON t.id = e.task_id JOIN projects p ON p.id = t.project_id
          WHERE e.type = 'checkpoint' AND t.project_id = ? AND t.state != 'cancelled' AND ${supervisedSql("t.source", "t.agent_target")}
            AND NOT EXISTS (
              SELECT 1 FROM events a
               WHERE a.task_id = e.task_id AND a.type = 'checkpoint_ack'
                 AND json_extract(a.payload, '$.checkpoint_id') = e.id)
            AND ${CHECKPOINT_NOT_EXPIRED_SQL}`
      )
      .get(projectId) as { n: number }).n
  );
  const decisions = Number(
    (db
      .query(`SELECT COUNT(*) AS n FROM decisions d JOIN tasks t ON t.id = d.task_id WHERE d.status = 'open' AND t.project_id = ? AND ${supervisedSql("t.source", "t.agent_target")}`)
      .get(projectId) as { n: number }).n
  );
  // supervisedSql() covers source='external'; the source_ref clause covers a
  // Jira mirror, which is tracking-only whatever its source column says.
  const reviews = Number(
    (db.query(`SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND state = 'in_review' AND ${supervisedSql()} AND COALESCE(source_ref, '') NOT LIKE 'jira:%'`).get(projectId) as { n: number }).n
  );
  const tasks = tasksWithHealth(db, db.query("SELECT * FROM tasks WHERE project_id = ?").all(projectId).map(parseTask));
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
  for (const project of activeProjects(db)) {
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
  broadcast({ type: "chat_message", project_id: thread.project_id, message });
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
    if (!target) return err(`target task not found: ${id}`, 409);
    // A project-scoped thread may only cite its own project's tasks. A
    // portfolio thread (project_id is null, e.g. the Chief of Staff)
    // supervises every project, so no project filter applies to it.
    if (thread.project_id && target.project_id !== thread.project_id) return err(`target task is outside this run's project: ${id}`, 409);
  }
  if (status === "passed") {
    if (!result) return err("passed verification requires result");
    if (!evidenceIds.length) return err("passed verification requires evidence_ids");
    for (const id of evidenceIds) {
      const row = thread.project_id
        ? db.query("SELECT 1 FROM evidence e JOIN tasks t ON t.id = e.task_id WHERE e.id = ? AND t.project_id = ?").get(id, thread.project_id)
        : db.query("SELECT 1 FROM evidence e WHERE e.id = ?").get(id);
      if (!row) return err(`evidence is unknown or outside this run's project: ${id}`);
    }
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
// depends_on: task ids this task waits on (array, or comma-separated string
// from the CLI). Validated here — against real tasks, and never against
// `selfId` — so a typo, or a task naming itself, can't block forever. Shared
// by createTask and updateTask (the latter is how an agent declares a
// dependency it discovers mid-task, after creation).
function parseDeps(db: DB, raw: any, selfId?: string): string[] | Response {
  const rawDeps = Array.isArray(raw) ? raw : raw ? String(raw).split(",") : [];
  const deps = rawDeps.map((d: any) => String(d).trim()).filter(Boolean);
  for (const d of deps) {
    if (selfId && d === selfId) return err("a task cannot depend on itself", 400);
    if (!db.query("SELECT 1 FROM tasks WHERE id = ?").get(d)) return err(`unknown depends_on task: ${d}`, 400);
    if (selfId && dependsTransitivelyOn(db, d, selfId)) return err("depends_on would create a dependency cycle", 400);
  }
  return deps;
}

// The verification contract: named commands an agent must run before it hands
// off, so its evidence can be tagged with the name it came from
// (`hive emit ... --verify-name <name>`). Stored as a JSON array on the task.
// Names are short slugs so they read well in a brief and in evidence payloads.
// Nothing is gated on this yet — it is data the brief renders.
function parseVerificationCmds(raw: any): { name: string; cmd: string }[] | null | Response {
  if (raw === null || raw === "") return null;
  let list = raw;
  if (typeof raw === "string") {
    try {
      list = JSON.parse(raw);
    } catch {
      return err("verification_cmds must be a JSON array of {name, cmd}", 400);
    }
  }
  if (!Array.isArray(list)) return err("verification_cmds must be an array of {name, cmd}", 400);
  const seen = new Set<string>();
  const out: { name: string; cmd: string }[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      return err("each verification_cmds entry must be an object with 'name' and 'cmd'", 400);
    const name = String((entry as any).name ?? "");
    const cmd = String((entry as any).cmd ?? "");
    if (!/^[a-z0-9-]{1,32}$/.test(name))
      return err(`invalid verification_cmds name: ${JSON.stringify(name)} (use 1-32 chars of a-z, 0-9, -)`, 400);
    if (seen.has(name)) return err(`duplicate verification_cmds name: ${name}`, 400);
    if (!cmd.trim()) return err(`verification_cmds entry '${name}' needs a non-empty cmd`, 400);
    seen.add(name);
    out.push({ name, cmd });
  }
  return out.length ? out : null;
}

// Priority is ordering only, never preemption: it decides which queued task is
// picked up first (dispatcher.ts) and which approved PR lands first
// (landQueue.ts). Highest to lowest: now, next, normal, later.
export const TASK_PRIORITIES = ["now", "next", "normal", "later"] as const;

// Returns the validated value, or a 400 for anything outside the vocabulary.
function parsePriority(raw: any): string | Response {
  const p = String(raw);
  if (!(TASK_PRIORITIES as readonly string[]).includes(p))
    return err(`invalid priority: ${JSON.stringify(p)} (use ${TASK_PRIORITIES.join(", ")})`, 400);
  return p;
}

// Only the director may jump the whole queue with 'now' — it is the one level
// that can borrow a slot past max_agents (dispatcher.ts), so a supervisor or an
// agent handing itself one would spend the fleet's headroom on its own work.
// Everything with an attributed non-director source tops out at 'next'.
// The task `source` IS the attribution: the web UI and the CLI send none (or
// "director"), agents send "agent", the chat supervisor sends "chat_supervisor".
// ponytail: stated-source attribution, the same trust model the rest of this
// local API runs on. Swap in a real caller identity if hive ever grows one.
const DIRECTOR_TASK_SOURCES = ["director", "web", "cli"];

function isDirectorSource(source: any): boolean {
  const s = source == null ? "" : String(source).trim();
  return s === "" || DIRECTOR_TASK_SOURCES.includes(s);
}

// Returns a 403 when this source may not set this priority, else null.
function authorizePriority(source: any, priority: string): Response | null {
  if (priority !== "now" || isDirectorSource(source)) return null;
  return err(
    `only the director may set priority 'now' (source '${String(source)}' may set at most 'next')`,
    403
  );
}

// Security-shaped work starts one notch up the queue. Same vocabulary the
// understanding-quiz gate applies to changed paths (DEFAULT_SENSITIVE_PATHS),
// matched here as whole words against the title and brief so "author" and
// "authority" do not read as "auth".
// ponytail: the default token list only, not a project's sensitive_paths
// override — that override is about which FILES earn a quiz, not about what a
// brief is asking for. Wire it up if a project ever needs its own words.
// Built per call, not once at module load: DEFAULT_SENSITIVE_PATHS is declared
// further down this file, so a module-level regex here would read it too early.
export function looksSecuritySensitive(text: string): boolean {
  return new RegExp(`\\b(${DEFAULT_SENSITIVE_PATHS.join("|")})s?\\b`, "i").test(text ?? "");
}

// Accepts JSON or multipart; attached files are saved under the new task's id
// and their absolute paths appended to the brief, so the agent that picks the
// task up can read them.
async function createTask(db: DB, req: Request, handlerDeps: HandlerDeps = {}): Promise<Response> {
  const { fields: body, files } = await bodyWithFiles(req);
  if (!body?.project_id) return err("project_id is required");
  if (!body?.title) return err("title is required");
  if (!db.query("SELECT 1 FROM projects WHERE id = ?").get(body.project_id))
    return err("unknown project_id", 400);
  const kind = body.kind ?? "ship";
  const source = body.source ? String(body.source) : null;
  if (!["ship", "scout", "chore"].includes(kind)) return err("invalid kind");
  if (source === "self-audit") return err("source 'self-audit' is reserved for the scheduler", 400);
  // A tracking-only task starts life with no agent — that's the whole point
  // (see supervision.ts). Accepting a caller-supplied agent_target here would
  // let a fresh external task skip straight past the neverDispatched gate
  // spawnAgent enforces below.
  if (source === "external" && body.agent_target)
    return err("external tasks cannot be created with an agent_target — they start tracking-only and are dispatched (if ever) via spawn", 400);
  // Agents may create follow-up tasks (source="agent", parent_task_id → the
  // spawning task); the dispatcher treats them like director-created tasks.
  const parent = body.parent_task_id ? String(body.parent_task_id) : null;
  const parentTask = parent ? getTask(db, parent) : null;
  if (parent && !parentTask) return err("unknown parent_task_id", 400);
  if (parentTask && isTrackingOnlyTask(parentTask)) return err(TRACKING_ONLY_OWNERSHIP_ERROR, 409);
  if (isTrackingOnlyTask({ source }) && body.agent_target)
    return err(TRACKING_ONLY_OWNERSHIP_ERROR, 409);
  const deps = parseDeps(db, body.depends_on);
  if (deps instanceof Response) return deps;
  const verifyCmds = body.verification_cmds !== undefined ? parseVerificationCmds(body.verification_cmds) : null;
  if (verifyCmds instanceof Response) return verifyCmds;
  // Priority, most specific wins: an explicit value, then the parent's (a
  // follow-up matters as much as the work that spawned it), then what the task
  // itself is — a security-shaped brief starts at 'next'. Nothing here ever
  // reaches 'now': only the director grants that, and only explicitly.
  let priority: string;
  if (body.priority !== undefined) {
    const parsed = parsePriority(body.priority);
    if (parsed instanceof Response) return parsed;
    // Authority applies to the value the caller ASKED for, not to an inherited
    // one: an agent filing a follow-up under a director's 'now' task is not
    // granting itself anything, it is staying with work the director already
    // ranked.
    const denied = authorizePriority(source, parsed);
    if (denied) return denied;
    priority = parsed;
  } else if (parentTask) {
    priority = parentTask.priority ?? "normal";
  } else if (looksSecuritySensitive(`${body.title ?? ""}\n${body.brief ?? ""}`)) {
    priority = "next";
  } else {
    priority = "normal";
  }
  // A follow-up task's brief often describes code that only exists in the
  // parent's still-open PR (HIVE-299). Auto-depend on the parent until its PR
  // has merged so the dispatcher holds this task the same way unmetDeps
  // already holds explicit depends_on — no separate PR-status check needed.
  if (parentTask && unmetDeps(db, { depends_on: [parent as string] }).length && !deps.includes(parent as string)) {
    deps.push(parent as string);
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
    source,
    parent_task_id: parent,
    depends_on: deps.length ? JSON.stringify(deps) : null,
    verification_cmds: verifyCmds ? JSON.stringify(verifyCmds) : null,
    priority,
    created_at: t,
    updated_at: t,
  };
  db.query(
    `INSERT INTO tasks (id, project_id, title, brief, state, kind, agent_target,
      worktree_path, branch, pr_url, ci_status, summary, source, parent_task_id, depends_on, verification_cmds, priority, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    row.id, row.project_id, row.title, row.brief, row.state, row.kind,
    row.agent_target, row.worktree_path, row.branch, row.pr_url, row.ci_status,
    row.summary, row.source, row.parent_task_id, row.depends_on, row.verification_cmds,
    row.priority, row.created_at, row.updated_at
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
  // Ambient intake only (source intake_*/watch), and only when the project opted
  // in. Deliberately not awaited: a 60s classifier must not hold the create
  // response, and the dispatcher holds the task meanwhile.
  triageIntake(db, getTask(db, row.id), { exec: handlerDeps.triageExec }).catch((e) => console.error(`[hive] intake triage ${row.id}:`, e));
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
  source: "reconciler" | "director" = "reconciler",
  // A task whose stored PR no longer exists (the repo's history was rewritten,
  // the PR was created against a different repo, the branch was replayed) is
  // otherwise stuck forever: the pr_url guard below refuses every new link, and
  // nothing else can clear it. Only the explicit director endpoint sets this —
  // the reconciler must never silently repoint a task at a different PR.
  allowRelink = false
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
  if (isTrackingOnlyTask(task)) return { task_id: task.id, number: task.number, linked: false };
  if (task.pr_url && !(allowRelink && task.pr_url !== pr.url))
    return { task_id: task.id, number: task.number, linked: false };
  db.query("UPDATE tasks SET pr_url = ?, updated_at = ? WHERE id = ?").run(pr.url, now(), task.id);
  const previous = task.pr_url as string | null;
  writeEvent(db, { task_id: task.id, source, type: "pr_linked", payload: { pr_url: pr.url, via, ...(previous ? { relinked_from: previous } : {}) } });
  backfillRequeueResume(db, task.id, source);
  handOffToReview(db, task.id, source);
  broadcastTask(db, getTask(db, task.id));
  return { task_id: task.id, number: task.number, linked: true };
}

// in_progress → in_review, the hand-off that puts a task in the director's
// Review lane with an Approve & merge button. No-op from any other state
// (queued/needs_decision/terminal), so it is safe to call repeatedly.
export function handOffToReview(db: DB, taskId: string, source: string): boolean {
  const t: any = getTask(db, taskId);
  if (!t || t.state !== "in_progress" || isTrackingOnlyTask(t)) return false;
  // #234: the reconciler's CI-green poll used to re-queue a task the director
  // JUST sent back (changes_requested) 33s later, before any new commit — CI was
  // still green on the old head. The shared guard blocks re-queue until new work
  // (a pushed commit / evidence / review_summary) lands after the request.
  if (changesRequestUnaddressed(db, taskId)) return false;
  if (decisionAnswerUnaddressed(db, taskId)) return false;
  // #1234 review-12: a PR can already be open while a queued-input recovery is
  // in flight (or just resolved) on this same task — don't hand it to review
  // until the redelivered turn has had its chance to run.
  if (queuedInputRecoveryPending(db, taskId)) return false;
  // #1249: review also means "there is a page explaining this change". A
  // missing one holds the task here and kicks off the generation, which calls
  // back into this function when the page lands.
  if (explanationGate(db, t) !== "ready") return false;
  // #1579: every named verification command needs its own evidence before the
  // director sees the card. Checked here (not left to transition's throw) so the
  // reconciler's per-cycle poll holds quietly instead of raising.
  if (verificationGate(db, t, source).length > 0) return false;
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
  const res = linkPrIfMarked(db, { title: data.title, body: data.body, url: data.url || prUrl }, "director", body?.force === true);
  if (!res) return err("PR carries no hive marker (no `hive-task:` footer or `[hive-<n>]` title)", 422);
  return json({ ok: true, ...res });
}

// Update a task's editable fields (title / brief / depends_on). Used by the
// attention tray's "edit & requeue" flow before it re-queues a failed task,
// and by an agent that discovers mid-task it needs another task's PR to land
// first (depends_on is otherwise only settable at creation).
// Accepts JSON or multipart; attached files are appended to the brief the same
// way task creation does.
async function updateTask(db: DB, id: string, req: Request): Promise<Response> {
  const task = getTask(db, id);
  if (!task) return err("task not found", 404);
  // Only a JIRA MIRROR has an external system that actually owns title/brief
  // (the sync overwrites them from the issue every cycle, so a director edit
  // here would just be clobbered next pull). A plain source='external' task
  // (e.g. a director-authored kanban/observations log) has no such owner —
  // the director IS the author, so blocking edits there only locks them out
  // of their own log for no reason.
  if (isJiraMirror(task))
    return err(`tracking-only task fields are owned by Jira (${task.source_ref}) — edit the issue there instead`, 409);
  const { fields: body, files } = await bodyWithFiles(req);
  const title = body?.title != null ? String(body.title) : task.title;
  const { block } = await attachFiles(id, files);
  // `base` stays null when the caller sent no brief and the task had none, so a
  // title-only PUT does not turn a NULL brief into "".
  const base = body?.brief != null ? String(body.brief) : task.brief;
  const brief = block ? (base ?? "") + block : base;
  // depends_on is full-replace, same contract as at creation: omit the field to
  // leave it alone, send an array (or comma-separated string) to replace it.
  let deps: string[] = task.depends_on;
  if (body?.depends_on !== undefined) {
    const parsed = parseDeps(db, body.depends_on, id);
    if (parsed instanceof Response) return parsed;
    deps = parsed;
  }
  // verification_cmds is full-replace too: omit to leave it alone, send [] or
  // null to clear it.
  let verify: string | null = task.verification_cmds ? JSON.stringify(task.verification_cmds) : null;
  if (body?.verification_cmds !== undefined) {
    const parsed = parseVerificationCmds(body.verification_cmds);
    if (parsed instanceof Response) return parsed;
    verify = parsed ? JSON.stringify(parsed) : null;
  }
  // priority is a plain scalar: omit it to leave it alone.
  let priority: string = task.priority ?? "normal";
  if (body?.priority !== undefined) {
    const parsed = parsePriority(body.priority);
    if (parsed instanceof Response) return parsed;
    const denied = authorizePriority(body.source, parsed);
    if (denied) return denied;
    priority = parsed;
  }
  db.query("UPDATE tasks SET title = ?, brief = ?, depends_on = ?, verification_cmds = ?, priority = ?, updated_at = ? WHERE id = ?")
    .run(title, brief, deps.length ? JSON.stringify(deps) : null, verify, priority, now(), id);
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
  const compact = url.searchParams.get("compact") === "1";
  const includeTest = url.searchParams.get("test") === "all";
  const where: string[] = [];
  const args: any[] = [];
  if (state) { where.push("t.state = ?"); args.push(state); }
  if (projectId) { where.push("t.project_id = ?"); args.push(projectId); }
  // Tasks under a test/ephemeral project (see testProjects.ts) are hidden
  // from director surfaces by default, same as the project itself.
  if (!includeTest) where.push(notTestProjectSql("p.config"));
  const sql =
    `SELECT t.*,
      CASE WHEN t.state IN ('in_review', 'failed') THEN COALESCE(
        (SELECT MAX(e.ts) FROM events e WHERE e.task_id = t.id AND e.type = 'state_change'
          AND json_extract(e.payload, '$.to') = t.state), t.updated_at)
      END AS needs_you_since
     FROM tasks t JOIN projects p ON p.id = t.project_id` +
    (where.length ? " WHERE " + where.join(" AND ") : "") +
    " ORDER BY t.updated_at DESC";
  const tasks = tasksWithHealth(db, db.query(sql).all(...args).map(parseTask));
  return json(tasks.map((task) => {
    const listed = {
      ...task,
      ...(compact ? { brief: undefined } : {}),
      evidence_count: evidenceCount(db, task.id),
      spawn_error: task.state === "queued" &&
        !!db.query("SELECT 1 FROM events WHERE task_id = ? AND type = 'spawn_error' LIMIT 1").get(task.id) &&
        !db.query("SELECT 1 FROM events WHERE task_id = ? AND type = 'spawned' LIMIT 1").get(task.id),
    };
    return compact
      ? Object.fromEntries(Object.entries(listed).filter(([, value]) =>
          value != null && value !== false && value !== 0 && (!Array.isArray(value) || value.length)))
      : listed;
  }));
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
              t.number AS task_number, t.project_number AS task_project_number,
              t.title AS task_title, t.kind AS task_kind, t.project_id AS project_id,
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
      task_display_id: `${projectPrefix(r.project_name)}-${r.task_project_number ?? r.task_number}`,
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
      task_display_id: null,
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
// `?project` scopes the spend rollup to one project; the web filters the other
// sections in the browser, which spend cannot do because it arrives pre-summed.
// `?since` (ISO) scopes the "what changed" sections (done / incidents / spend /
// learnings). The action-state sections (open decisions, needs-attention, live
// fleet, unreviewed intake) are current-state, not windowed — they need you now
// regardless of when you last looked.
function brief(db: DB, url: URL): Response {
  const since = url.searchParams.get("since");
  const project = url.searchParams.get("project");

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
  const attnCandidates = tasksWithHealth(
    db,
    db
      .query(
        "SELECT * FROM tasks WHERE state = 'failed' OR (agent_target IS NOT NULL AND state IN ('in_progress','needs_decision','in_review','verifying'))"
      )
      .all()
      .map(parseTask)
  );
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
  const fleet = tasksWithHealth(
    db,
    db
      .query(
        "SELECT * FROM tasks WHERE agent_target IS NOT NULL AND state IN ('in_progress','needs_decision','in_review','verifying') ORDER BY updated_at DESC"
      )
      .all()
      .map(parseTask)
  );

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

  // ⑦ to review — Hive-owned in-review tasks awaiting the captain's review
  // and merge. Full task objects (with health) so the web renders review cards inline.
  const to_review = tasksWithHealth(
    db,
    db
      .query("SELECT * FROM tasks WHERE state = 'in_review' ORDER BY updated_at DESC")
      .all()
      .map(parseTask)
      .filter((task: any) => !isTrackingOnlyTask(task))
  );

  // ⑧ spend since — reuse the analytics rollup (totals + by-model for top model).
  // `?project` scopes it, so a reader who filtered the brief to one project does
  // not read a fleet-wide cost next to that project's rows. Usage rows only know
  // their task, so the project filter joins through tasks.
  const clauses = [...(since ? ["u.ts >= ?"] : []), ...(project ? ["t.project_id = ?"] : [])];
  const w = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
  const a = [...(since ? [since] : []), ...(project ? [project] : [])];
  const from = `FROM usage u JOIN tasks t ON u.task_id = t.id${w}`;
  const spend = {
    totals: db.query(`SELECT ${usageTotals("u.")} ${from}`).get(...a),
    by_model: db
      .query(`SELECT u.model, ${usageTotals("u.")} ${from} GROUP BY u.model ORDER BY cost_usd DESC, total_tokens DESC`)
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

  // ⑩ dialogs the server answered for the agent — a count, not a card each
  // (task #1562). Windowed like the other "what happened" sections; a day is
  // the default because that is how often the director reads this.
  const dialogsSince = since ?? new Date(Date.now() - 24 * 3600_000).toISOString();
  const auto_answered_dialogs = (db
    .query("SELECT COUNT(*) AS n FROM events WHERE type = 'dialog_auto_answered' AND ts >= ?")
    .get(dialogsSince) as { n: number }).n;

  return json({
    since: since ?? null,
    auto_answered_dialogs,
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

  const ref = /^([a-z0-9]+)-(\d+)$/i.exec(q);
  if (ref) {
    const candidates = db
      .query(`SELECT t.id, t.number, t.title, t.summary, t.state, t.project_id, t.project_number, p.name AS project_name
                FROM tasks t JOIN projects p ON p.id = t.project_id
               WHERE t.project_number = ?`)
      .all(Number(ref[2])) as any[];
    const match = candidates.find((task) => projectPrefix(task.project_name) === ref[1].toUpperCase());
    if (match)
      return json({ hits: [{ type: "task", id: match.id, title: match.title, snippet: match.summary ?? "", task_state: match.state, project_id: match.project_id, display_id: taskIdentifier(db, match) }] });
  }

  const like = "%" + q.replace(/[\\%_]/g, (c) => "\\" + c) + "%";
  const E = " ESCAPE '\\'";
  type Hit = {
    type: string; id: string; title: string; snippet: string;
    task_state?: string; project_id?: string; display_id?: string; _rank: number;
  };
  const hits: Hit[] = [];
  const bodySnippet = (title: string, ...bodies: (string | null)[]) => {
    for (const b of bodies) if (b && b.toLowerCase().includes(q.toLowerCase())) return searchSnippet(b, q);
    return searchSnippet(bodies.find((b) => b) ?? title, q);
  };

  for (const r of db.query(
    `SELECT t.id, t.number, t.project_number, t.title, t.brief, t.summary, t.state, t.project_id
       FROM tasks t
      WHERE t.title LIKE ?${E} OR t.brief LIKE ?${E} OR t.summary LIKE ?${E}`
  ).all(like, like, like) as any[]) {
    hits.push({ type: "task", id: r.id, title: r.title, snippet: bodySnippet(r.title, r.brief, r.summary), task_state: r.state, project_id: r.project_id, display_id: taskIdentifier(db, r), _rank: titleRank(r.title, q) });
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
  // The verification contract, resolved against the evidence the merge gate
  // reads, so the review card can show the checklist instead of restating the
  // rule (HIVE-403). Absent entirely when the task declared no contract.
  const verification = verificationChecklist(db, task);
  return json({ ...taskWithHealth(db, task), events, evidence, decisions, ...(verification.length ? { verification } : {}) });
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
    // Tracking-only tasks fall through to a PLAIN transition. For them an
    // in_review -> in_progress move is not "the director requests changes", it
    // is the external system moving its own ticket back, so there is nothing to
    // bounce and no agent to contact.
    //
    // This supersedes hive-996's 409 here, deliberately. That guard rejected a
    // never-dispatched external task to stop bounceForChanges queueing a steer
    // nobody reads and failing to spawn an agent. Falling through achieves the
    // same thing — no steer, no spawn — and lets the move actually succeed,
    // which is what a mirrored ticket needs. neverDispatched implies
    // source='external' implies tracking-only, so that guard would be
    // unreachable below rather than merely unused.
    if (t && t.state === "in_review" && !isTrackingOnlyTask(t)) {
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
      const hiveOwnedReview = !isTrackingOnlyTask(t);
      if (hiveOwnedReview && to === "verifying" && t.state === "in_review" && t.kind === "scout" && understandingChecksRequired(db, t)) {
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
      if (hiveOwnedReview && to === "verifying" && t.state === "in_review" && t.pr_url)
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
  const task = getTask(db, id);
  if (!task) return err("task not found", 404);
  if (isTrackingOnlyTask(task)) return err("tracking-only tasks have no Hive-owned diff to review", 409);
  const r = await taskDiff(db, id, deps.exec ?? defaultExec);
  return r.ok ? json(r.diff) : err(r.error, r.status);
}

// GET /api/tasks/:id/branch-check → live dependency + stacked-branch status
// for the review UI (task #1000). An agent's evidence prose ("origin/main now
// includes dependencies") is a frozen claim from whenever it was written;
// this recomputes the two things that claim actually asserts, fresh on every
// call: (a) is every declared depends_on task actually merged/done, and
// (b) does this branch share history with another currently open task's
// branch (a stacked PR that can silently carry that task's pre-rewrite
// commits — see findEmbeddedTasks).
export async function taskBranchCheckEndpoint(db: DB, id: string, deps: HandlerDeps): Promise<Response> {
  const task = getTask(db, id);
  if (!task) return err("task not found", 404);
  const unmet_deps = unmetDeps(db, task).map((b) => ({ id: b.id, number: b.number, title: b.title, state: b.state }));

  let embedded_tasks: { id: string; number: number; title: string }[] = [];
  const project: any = db.query("SELECT * FROM projects WHERE id = ?").get(task.project_id);
  if (project?.repo_path && task.branch) {
    const config = JSON.parse(project.config ?? "{}");
    const base = projectComparisonBase(config);
    // TERMINAL, not just done/cancelled: a `failed` task's branch is as dead as
    // a cancelled one, and one real project's 109 failed tasks were 87 of the 103 rows
    // this flag used to dump on one card (task #1134).
    const others = db
      .query(
        `SELECT id, number, title, branch FROM tasks WHERE project_id = ? AND id != ? AND branch IS NOT NULL
           AND state NOT IN (${TERMINAL.map(() => "?").join(", ")}) ORDER BY number`
      )
      .all(task.project_id, id, ...TERMINAL) as { id: string; number: number; title: string; branch: string }[];
    const found = await findEmbeddedTasks(deps.exec ?? defaultExec, project.repo_path, base, task.branch, others);
    if (found) embedded_tasks = found;
  }
  // The review card only blocks on the understanding check when this says so.
  return json({ unmet_deps, embedded_tasks, understanding_required: understandingChecksRequired(db, task) });
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
export const AUTO_MERGE_PAUSED = "auto-merge paused because task readiness changed; review the task again";
async function mergeFailed(db: DB, herdr: Herdr, task: any, base: string, reason: string, actor: string | null = null): Promise<Response> {
  const conflict = MERGE_CONFLICT_RE.test(reason);
  const msg = `hive: merge into '${base}' failed — ${reason}\nRebase your branch '${task.branch}' onto the latest '${base}', resolve the conflicts, rerun the tests, then push.`;
  let delivered = false;
  let sendError: string | null = null;
  if (conflict && task.agent_target) {
    try {
      const res = await herdr.send(task.agent_target, msg);
      sendError = sendFailure(res);
      delivered = sendError === null;
    } catch (e: any) {
      sendError = String(e?.message ?? e);
    }
  }
  // The task stays in_review, where its agent has usually been released, so a
  // conflict that reached nobody is queued for the dispatcher's reattach pass.
  if (conflict && !delivered) queueSteerEvent(db, task.id, msg, "merge conflict; no live agent");
  writeEvent(db, {
    task_id: task.id,
    source: "director",
    type: "merge_failed",
    payload: { reason, conflict, delivered, actor, ...(sendError ? { send_error: sendError } : {}) },
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
async function attemptLocalFf(
  exec: Exec,
  project: any,
  task: any,
  base: string,
  requiredPr?: { base: string; head: string | null },
  beforeMutation?: () => boolean
): Promise<string | null> {
  const baseSha = await exec(["git", "-C", project.repo_path, "rev-parse", base]);
  const branchSha = await exec(["git", "-C", project.repo_path, "rev-parse", task.branch]);
  const oldSha = baseSha.stdout.trim();
  const newSha = branchSha.stdout.trim();
  if (baseSha.code !== 0 || branchSha.code !== 0 || !oldSha || !newSha)
    return baseSha.stderr.trim() || branchSha.stderr.trim() || "could not resolve merge refs";

  // A PR branch must contain the PR's current base commit, not merely Hive's
  // possibly stale local branch. Otherwise a local ff can bypass GitHub's
  // conflict verdict and silently omit integration-branch commits.
  if (requiredPr) {
    if (!requiredPr.head)
      return "PR head metadata is missing; local fast-forward was not attempted";
    if (newSha !== requiredPr.head)
      return `local branch '${task.branch}' resolves to ${newSha.slice(0, 12)}, but the PR head is ${requiredPr.head.slice(0, 12)}; refresh the local branch from the PR head`;
    const current = await exec(["git", "-C", project.repo_path, "merge-base", "--is-ancestor", requiredPr.base, newSha]);
    if (current.code !== 0)
      return `current PR base ${requiredPr.base.slice(0, 12)} is not an ancestor of '${task.branch}'; refresh the branch from origin/${base}`;
  }

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
    if (beforeMutation && !beforeMutation()) return AUTO_MERGE_PAUSED;
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

  if (beforeMutation && !beforeMutation()) return AUTO_MERGE_PAUSED;
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

// Files a merge landed. GitHub is the only authority for a PR — after a squash
// merge the PR head may not exist locally at all, so there is deliberately no
// local fallback on that path. A PR-less local ff reads the branch's own
// authored diff instead. Returns null when neither can be read: merged_files is
// then simply absent, and the autonomy stats treat that merge as unmeasurable
// for file overlap. Never throws, never blocks the merge.
async function mergedFileList(
  exec: Exec,
  task: any,
  repoPath: string | null,
  base: string,
  head: string | null
): Promise<string[] | null> {
  if (task.pr_url) {
    const r = await exec(["gh", "pr", "view", task.pr_url, "--json", "files"]);
    if (r.code !== 0) return null;
    try {
      const files = JSON.parse(r.stdout || "{}").files;
      return Array.isArray(files) ? files.map((f: any) => String(f?.path ?? "")).filter(Boolean).sort() : null;
    } catch {
      return null;
    }
  }
  if (!repoPath || !head) return null;
  return await authoredFiles(exec, repoPath, base, head);
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
// caller's call to make), but still requires the local branch to match the PR
// head and contain its current base. It also honours the PR state probe: a
// CLOSED PR is refused and a MERGED one just advances. The same
// staleness shape is also detected automatically: if `gh pr merge` fails with
// a conflict/not-mergeable/not-an-ancestor reason AND the PR's own state says
// the blocker is the base comparison rather than branch protection, hive tries
// the local ff before bouncing the task back to the agent (rebasing onto a
// stale origin/<base> would only make things worse).
// Guarded by the `task.merge` standing-authority action.
export async function mergeTask(
  db: DB,
  herdr: Herdr,
  id: string,
  body: any,
  deps: HandlerDeps,
  opts: { beforeMutation?: () => boolean } = {}
): Promise<Response> {
  const task = getTask(db, id);
  const actor = actorOf(body);
  if (!task) return err("task not found", 404);
  if (isTrackingOnlyTask(task)) return err("tracking-only tasks have no Hive-owned work to merge", 409);
  if (task.state !== "in_review")
    return err(`task is '${task.state}', not 'in_review'; only in-review tasks can be merged`, 409);
  if (task.kind === "scout")
    return err(`scout tasks are report-only; accept the report by moving task '${id}' to 'verifying' instead of merging its branch`, 409);

  const blocked = authzBlock(db, { project_id: task.project_id, action: "task.merge", target: task.title, task_id: id });
  if (blocked) return blocked;

  const project: any = db.query("SELECT * FROM projects WHERE id = ?").get(task.project_id);
  const config = JSON.parse(project?.config ?? "{}");
  const autoShipKind = Array.isArray(config.auto_merge?.kinds) && config.auto_merge.kinds.includes(task.kind);
  // Mechanical changes (hive-1559) never mint a quiz, so nothing here to gate on.
  let deferQuizReviewEventId: string | null = null;
  if (understandingChecksRequired(db, task)) {
    const quiz = latestUnderstandingQuiz(db, id);
    if (!quiz)
      return err("Understanding check required. Ask the agent to submit one in its latest review before merging.", 409);
    if (understandingQuizStatus(db, id, quiz.reviewEventId) === "required") {
      if (!autoShipKind)
        return err("Pass the understanding check before merging, or choose 'Continue now, quiz me later'.", 409);
      deferQuizReviewEventId = quiz.reviewEventId;
    }
  }

  // HIVE-403: the verification contract, at the merge gate. For a kind the
  // project ships automatically, an unproven command blocks the merge outright
  // — auto-merge must never land work whose declared checks were never run. A
  // director landing any other kind by hand may proceed, but the response says
  // which commands have no evidence so the choice is an informed one.
  const missingVerify = missingVerifications(db, task);
  if (missingVerify.length && autoShipKind)
    return err(
      `merge blocked — no evidence for ${missingVerify.length} declared verification${missingVerify.length === 1 ? "" : "s"}: ` +
        `${missingVerify.join(", ")}. Run them and attach the output, or merge a kind that is not in auto_merge.kinds by hand.`,
      409
    );

  // Recompute the dependency claim live rather than trusting evidence prose
  // (task #1000: #977 claimed its dependency had landed on main; it hadn't).
  // Mirrors the dispatcher's own gate (state.ts unmetDeps) at the other end
  // of the task's life — spawn and merge both refuse while a declared
  // dependency isn't actually merged/done.
  const blockingDeps = unmetDeps(db, task);
  if (blockingDeps.length) {
    const names = blockingDeps.map((b) => `#${b.number} ${b.title} (${b.state})`).join(", ");
    return err(`blocked by unmet dependenc${blockingDeps.length === 1 ? "y" : "ies"}: ${names} — not yet merged/done`, 409);
  }

  // The risk check (HIVE-406) re-read the real code for this exact head. Risks
  // it CONFIRMED are the ones that survived an adversarial second look, so the
  // director sees that short list verbatim instead of the whole caution blob.
  // Refuted risks say nothing here. Overridable, like the rebase guard below.
  const confirmed = body?.override_confirmed_risks ? [] : confirmedRisks(db, id, task.head_sha);
  if (confirmed.length)
    return err(
      `merge blocked — the risk check confirmed ${confirmed.length} risk${confirmed.length === 1 ? "" : "s"} on this head: ` +
        confirmed.map((c) => `“${c.risk}” — ${c.why}${c.evidence_path ? ` (${c.evidence_path})` : ""}`).join("; ") +
        `. Fix them, or merge with override_confirmed_risks=true.`,
      409
    );

  const exec = deps.exec ?? defaultExec;
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
        projectBaseBranch(config),
        `Could not inspect PR metadata; merge was not attempted (${probe.stderr.trim() || "gh pr view failed"}).`,
        actor
      );
    try {
      prView = JSON.parse(probe.stdout || "{}");
    } catch {
      return mergeFailed(db, herdr, task, projectBaseBranch(config), "Could not parse PR metadata; merge was not attempted.", actor);
    }
    if (!prView.baseRefName || !prView.baseRefOid)
      return mergeFailed(db, herdr, task, projectBaseBranch(config), "PR base metadata is missing; merge was not attempted.", actor);
  }
  const base = preferSafeRef(prView?.baseRefName, projectBaseBranch(config));
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
    const linked = db
      .query("SELECT ts, payload FROM events WHERE task_id = ? AND type = 'pr_linked' ORDER BY ts DESC")
      .all(id) as { ts: string; payload: string }[];
    const replacementAt = linked.find((event) => {
      try {
        return Boolean(JSON.parse(event.payload)?.replaced);
      } catch {
        return false;
      }
    })?.ts ?? "";
    const snapEvent: any = db
      .query("SELECT payload FROM events WHERE task_id = ? AND type = 'branch_scope' AND ts > ? ORDER BY ts DESC LIMIT 1")
      .get(id, replacementAt);
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
          .query("SELECT payload FROM events WHERE task_id = ? AND type = 'pr_synchronized' AND ts > ? ORDER BY ts ASC LIMIT 1")
          .get(id, replacementAt) as { payload: string } | undefined;
        let originalHead: string | null = (snapshot as BranchScope & { head_sha?: string | null }).head_sha ?? null;
        try {
          originalHead ||= firstSync ? JSON.parse(firstSync.payload).head_sha ?? null : null;
        } catch {}
        // A same-branch re-cut (force-push/rebuild) leaves the recorded snapshot
        // commit outside the new head's history: comparing against it reads
        // every file the rebuilt branch re-touches as a "revert" of base work,
        // even when the branch is now strictly ahead (task #1696). Detect that
        // the snapshot commit is no longer an ancestor of the new head and
        // re-baseline against the CURRENT head instead of the stale snapshot.
        let invalidated = false;
        if (originalHead) {
          const anc = await exec(["git", "-C", project.repo_path, "merge-base", "--is-ancestor", originalHead, guardHead]);
          // exit 0 = ancestor (not invalidated), 1 = confirmed NOT an ancestor
          // (force-push/rebuild). Any other exit code is a transient git
          // failure (bad object, repo lock) — treat it like "not invalidated"
          // rather than re-baselining off a possibly-bogus guardHead.
          invalidated = anc.code === 1;
        }
        let captureFailed = false;
        if (invalidated) {
          const fresh = await captureBranchScope(exec, project.repo_path, guardBase, guardHead);
          if (fresh) {
            snapshot = fresh;
            writeEvent(db, { task_id: id, source: "director", type: "branch_scope", payload: { ...fresh, head_sha: guardHead } });
          } else {
            captureFailed = true;
          }
        } else if (originalHead) {
          const exact = await captureBranchScope(exec, project.repo_path, guardBase, originalHead);
          if (exact) snapshot = { ...snapshot, files: exact.files };
        }
        const regressed = captureFailed
          ? []
          : snapshot
            ? await detectDestructiveRebase(exec, project.repo_path, guardBase, guardHead, snapshot)
            : null;
        if (captureFailed || (regressed && regressed.length)) {
          const files = captureFailed
            ? ""
            : regressed!.slice(0, 10).join(", ") + (regressed!.length > 10 ? `, …(+${regressed!.length - 10})` : "");
          const reason = captureFailed
            ? `could not re-verify branch scope for '${task.branch}' after a same-branch re-cut (snapshot capture failed)`
            : `branch '${task.branch}' reverts base work outside this task's scope (${files})`;
          writeEvent(db, {
            task_id: id,
            source: "director",
            type: "merge_blocked_destructive",
            payload: { base, branch: task.branch, regressed, reason, actor },
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
          `PR is CLOSED (not merged): ${task.pr_url}. If the agent replaced it, its 'ready' emit now re-links the task; otherwise re-link via POST /api/tasks/link-pr.`,
          actor
        );
      }
    }
  }

  if (!method) {
    if (task.pr_url && !forceLocalFf) {
      const flag = ghMergeFlag(config.merge_method);
      method = `pr ${flag.slice(2)}`;
      if (opts.beforeMutation && !opts.beforeMutation()) return err(AUTO_MERGE_PAUSED, 409);
      // Re-verify the PR's live head immediately before merging (the probe at
      // the top of this function, any auto-review pass, and the director's
      // click can all be arbitrarily stale by now) and give `gh pr merge` that
      // exact head as an atomic precondition — a force-push or new commit
      // landing in the gap then fails the merge instead of being silently
      // absorbed into it (task HIVE-307). Best-effort: if the live head can't
      // be confirmed, fall back to the unguarded merge rather than blocking on
      // a probe failure unrelated to the merge itself.
      let matchedHead: string | null = null;
      const readiness = await probePrReadiness(exec, task.pr_url);
      if (opts.beforeMutation && !opts.beforeMutation()) return err(AUTO_MERGE_PAUSED, 409);
      if (readiness.ok) {
        const liveHead =
          typeof readiness.data.headRefOid === "string" && readiness.data.headRefOid ? readiness.data.headRefOid : null;
        if (liveHead && String(readiness.data.state ?? "").toUpperCase() === "OPEN") matchedHead = liveHead;
      }
      const mergeArgv = ["gh", "pr", "merge", task.pr_url, flag];
      if (matchedHead) mergeArgv.push("--match-head-commit", matchedHead);
      const r = await exec(mergeArgv);
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
          const ffReason = await attemptLocalFf(
            exec,
            project,
            task,
            base,
            { base: guardBase, head: prView?.headRefOid ?? null },
            opts.beforeMutation
          );
          if (ffReason === null) {
            method = "local ff-only (PR merge reported not-mergeable against origin/" + base + ")";
          } else if (ffReason === AUTO_MERGE_PAUSED) {
            return err(ffReason, 409);
          } else {
            return mergeFailed(db, herdr, task, base, `${reason}; local fast-forward also refused: ${ffReason}`, actor);
          }
        } else {
          return mergeFailed(db, herdr, task, base, reason, actor);
        }
      }
    } else {
      if (!project?.repo_path) return err("project has no repo_path; cannot merge", 400);
      if (!task.branch) return err("task has no branch; nothing to merge", 400);
      // Documented safe local merge: fast-forward the default branch to the task
      // branch tip. Requires the default branch to be an ancestor of the task
      // branch; a non-fast-forward (diverged / conflicting) merge is refused, no
      // working tree is touched. Callers wanting a squash merge should use a PR.
      const ffReason = await attemptLocalFf(
        exec,
        project,
        task,
        base,
        task.pr_url ? { base: guardBase, head: prView?.headRefOid ?? null } : undefined,
        opts.beforeMutation
      );
      if (ffReason === AUTO_MERGE_PAUSED) return err(ffReason, 409);
      if (ffReason !== null) return mergeFailed(db, herdr, task, base, ffReason, actor);
      method = forceLocalFf && task.pr_url ? "local ff-only (forced; PR-backed task)" : "local ff-only";
    }
  }

  if (deferQuizReviewEventId) {
    writeEvent(db, {
      task_id: id,
      source: "system",
      type: "understanding_quiz_deferred",
      payload: {
        review_event_id: deferQuizReviewEventId,
        actor,
        note: "Automatically deferred because this task kind is enabled in auto_merge.kinds.",
      },
    });
  }
  // What this merge actually landed, recorded at merge time so autonomy stats
  // (server/src/autonomyStats.ts) can later ask "did a fix touch these files?".
  // Best effort: an unreadable repo or a deleted PR head just leaves it absent.
  const merged_files = await mergedFileList(exec, task, project?.repo_path ?? null, guardBase, guardHead);
  writeEvent(db, { task_id: id, source: "director", type: "merged", payload: { method, base, branch: task.branch, pr_url: task.pr_url, actor, ...(merged_files ? { merged_files } : {}) } });
  // The running server serves from its own checkout, which may sit on a branch
  // that is not `base` — so a landed change does not run until that checkout
  // follows. Done BEFORE the smoke run below, so smoke tests the code that just
  // landed rather than the code it replaced. Never fails the merge: the work IS
  // on base either way.
  await followServingBranch(db, { exec, repoPath: project?.repo_path ?? null, projectId: task.project_id, base, taskId: id }).catch(
    (e) => console.error("[hive] serving-branch follow failed:", e)
  );
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

  return json({
    ...getTask(db, id),
    ...(missingVerify.length ? { warning: `merged without evidence for: ${missingVerify.join(", ")}` } : {}),
  });
}

// Bounce an in-review task back to in_progress with reviewer feedback, and make
// sure the feedback actually REACHES an agent. Delivers to the live agent; if
// none has an active turn (done/gone, or the send fails) it queues the notes as a steer and
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
  // Two separate questions here, not one: did queueSteerEvent record something
  // worth carrying (its `queued` return value — true whenever a live agent or a
  // future manual respawn might still pick it up, even for a source=external
  // task that WAS manually spawned before), and is it OK for HIVE'S OWN
  // AUTOMATION to spawn a live agent for this task right now. Those aren't the
  // same question: a source=external task must never be auto-dispatched by
  // hive itself, even if a director manually spawned it once before, so gate
  // the respawn on isExternalTask directly rather than inferring it from
  // `queued` — that was the bug a second review pass caught here.
  let respawned = false;
  if (!delivered) {
    const queued = queueSteerEvent(db, id, msg, "changes requested; agent not live");
    if (queued && !isExternalTask(task.source)) {
      const r = await spawnAgent(db, herdr, id, { supervise: deps.supervise, exec: deps.exec });
      respawned = r.ok;
      if (r.ok) delivered = true;
    }
  }
  return { delivered, respawned, sendError };
}

// POST /api/tasks/:id/request-changes body {notes} — bounce an in-review task
// back to in_progress and deliver the captain's notes to the agent.
//
// One verb, two shapes. In review the work has not landed, so the notes go
// straight back to the agent that is still holding it. Once it has SHIPPED
// there is nothing to bounce: the same request files a follow-up task instead
// (HIVE-510), and the original stays done.
async function requestChanges(db: DB, herdr: Herdr, id: string, body: any, deps: HandlerDeps = {}): Promise<Response> {
  const task = getTask(db, id);
  if (!task) return err("task not found", 404);
  if (task.state === "done") return requestChangesOnShipped(db, task, body);
  if (task.state !== "in_review")
    return err(`task is '${task.state}', not 'in_review'`, 409);
  if (isJiraMirror(task))
    return err("this task mirrors a Jira issue — hive does no agent work on it, so there are no changes to request", 409);
  if (neverDispatched(db, task))
    return err("task is untracked (source=external) and has never been spawned — there is no agent to request changes from", 409);
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

  const r = await spawnAgent(db, herdr, id, { hiveUrl: body?.hive_url, supervise: deps.supervise, exec: deps.exec });
  if (!r.ok) return err(`spawn failed: ${r.error}`, 502);
  return json({ ok: true, task: getTask(db, id), agent_target: r.agent_target });
}

export function agentForConfig(config: any): Agent {
  return config?.agent === "codex" ? "codex" : "claude";
}

// Claude is pinned by task kind: without an explicit --model its CLI default
// can be the priciest tier. Codex inherits the signed-in ChatGPT account's
// current default unless the project sets codex_model(_by_kind), so Hive never
// bakes a moving OpenAI model slug into project config.
const DEFAULT_MODEL_BY_KIND: Record<string, string> = { ship: "opus", scout: "sonnet", chore: "sonnet" };

export function modelForTask(config: any, kind: string): string | undefined {
  if (agentForConfig(config) === "codex")
    return config?.codex_model_by_kind?.[kind] ?? config?.codex_model;
  return config?.model_by_kind?.[kind] ?? config?.model ?? DEFAULT_MODEL_BY_KIND[kind] ?? "sonnet";
}

function codexHookOverride(event: string, command: string, matcher?: string): string {
  const group = `${matcher ? `matcher=${JSON.stringify(matcher)},` : ""}hooks=[{type="command",command=${JSON.stringify(command)},timeout=30}]`;
  return `hooks.${event}=[{${group}}]`;
}

export function hookScriptCommand(
  script: "hive-hook.ts" | "classify.ts",
  args: string[] = [],
  platform: NodeJS.Platform = process.platform
): string {
  return commandForCurrentShell(["bun", join(HOOKS_DIR, script), ...args], platform);
}

export function codexAgentArgv(
  brief: string,
  model?: string,
  commandApproval: "escalate" | "allow" | "prompt" = "escalate",
  settings: { reasoningEffort: string; autoCompactTokenLimit: number; toolOutputTokenLimit: number } = {
    reasoningEffort: "medium",
    autoCompactTokenLimit: 64_000,
    toolOutputTokenLimit: 6_000,
  }
): string[] {
  const hook = (event: string) => hookScriptCommand("hive-hook.ts", [event]);
  const approve = hookScriptCommand("classify.ts", [commandApproval]);
  const argv = [
    "codex",
    "--sandbox", "workspace-write",
    "-c", "sandbox_workspace_write.network_access=true",
    "--ask-for-approval", "on-request",
    "--dangerously-bypass-hook-trust",
    "-c", "features.hooks=true",
    "-c", codexHookOverride("PreToolUse", approve, "^Bash$"),
    "-c", codexHookOverride("PermissionRequest", approve, "^Bash$"),
    "-c", codexHookOverride("PostToolUse", hook("PostToolUse")),
    "-c", codexHookOverride("Stop", hook("Stop")),
    "-c", codexHookOverride("SubagentStop", hook("SubagentStop")),
    "-c", `model_reasoning_effort=${JSON.stringify(settings.reasoningEffort)}`,
    "-c", `model_auto_compact_token_limit=${settings.autoCompactTokenLimit}`,
    "-c", `tool_output_token_limit=${settings.toolOutputTokenLimit}`,
  ];
  if (model) argv.push("--model", model);
  argv.push(brief);
  return argv;
}

export function agentArgvFor(config: any, kind: string, brief: string): string[] | undefined {
  if (Array.isArray(config?.agent_argv) && config.agent_argv.length) return config.agent_argv;
  if (agentForConfig(config) !== "codex") return undefined;
  const policy = ["allow", "prompt"].includes(config.command_approval) ? config.command_approval : "escalate";
  return codexAgentArgv(brief, modelForTask(config, kind), policy, {
    reasoningEffort: config.codex_reasoning_effort_by_kind?.[kind] ?? config.codex_reasoning_effort ?? (kind === "ship" ? "medium" : "low"),
    autoCompactTokenLimit: config.codex_auto_compact_token_limit ?? 64_000,
    toolOutputTokenLimit: config.codex_tool_output_token_limit ?? 6_000,
  });
}

function referencesUrl(text: string, url: string): boolean {
  let from = 0;
  while (true) {
    const idx = text.indexOf(url, from);
    if (idx === -1) return false;
    const after = text.charCodeAt(idx + url.length);
    if (Number.isNaN(after) || after < 48 || after > 57) return true;
    from = idx + 1;
  }
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
  // The shared spawn core: every path that starts an agent (the manual /spawn
  // endpoint, the dispatcher's auto loop, bounceForChanges' respawn-on-
  // undelivered fallback) routes through here, so this is the one place that
  // needs to reject work hive must not do. A Jira mirror is refused ALWAYS —
  // it mirrors someone else's ticket, so there is no hive work to start, ever.
  // A never-dispatched external task (see supervision.ts) is refused too; one
  // that WAS spawned before (recovery, manual respawn) is unaffected.
  if (isJiraMirror(task))
    return { ok: false, error: "this task mirrors a Jira issue — hive tracks it but never runs agents on it" };
  if (neverDispatched(db, task))
    return { ok: false, error: "task is untracked (source=external) and has never been spawned — hive does not dispatch agents for tracking-only tasks" };
  // The director is editing this worktree by hand (HIVE-352). Starting an agent
  // in it now means two writers on one checkout; hand it back first.
  if (task.parked_for_director)
    return { ok: false, error: "the director has taken this worktree over — hand it back to put an agent on it again" };
  // Adoption guard (hive-1090): a requeue whose predecessor left an open PR
  // must carry that pointer in its brief before it dispatches — this is the
  // structural backstop for buildResumeSection (requeueTask always writes the
  // pointer), catching a brief edit that stripped it back out. Without this a
  // fresh agent, blind to the open PR, can rebuild the whole feature as a
  // second conflicting PR (the exact incident this closes).
  if (task.resume_pr_url && !referencesUrl(task.brief ?? "", task.resume_pr_url)) {
    const error = `refusing to dispatch: predecessor's open PR ${task.resume_pr_url} is not referenced in this task's brief — restore the RESUME/adoption pointer before dispatching`;
    writeEvent(db, { task_id: id, source: "herdr", type: "spawn_error", payload: { error } });
    return { ok: false, error };
  }
  if (task.resume_pr_url) {
    const ids = task.parent_task_id ? [id, task.parent_task_id] : [id];
    const outcome = prOutcome(db, ids, task.resume_pr_url);
    if (outcome !== "open") {
      const error = `refusing to dispatch: predecessor's PR ${task.resume_pr_url} is already ${outcome}. The resume pointer is stale; reattach to the current PR (or clear resume_pr_url) before dispatching`;
      writeEvent(db, { task_id: id, source: "herdr", type: "spawn_error", payload: { error } });
      return { ok: false, error };
    }
    // hive-487: a recorded "open" outcome only means nothing marked it
    // closed/merged — it says nothing about whether the URL still names THIS
    // lineage (a repo migration resets PR numbering, so an old pr_url can
    // silently resolve to someone else's PR). Confirm the marker live before
    // telling a fresh agent to adopt it.
    if (!(await resumePointerMarkerHolds(db, opts.exec ?? defaultExec, ids, task.resume_pr_url))) {
      const error = `refusing to dispatch: PR ${task.resume_pr_url} no longer carries a hive-task marker naming this task (or its parent) — it may point at a different or migrated repo. Reattach to the current PR (or clear resume_pr_url) before dispatching`;
      writeEvent(db, { task_id: id, source: "herdr", type: "spawn_error", payload: { error } });
      return { ok: false, error };
    }
  }
  const project: any = db.query("SELECT * FROM projects WHERE id = ?").get(task.project_id);
  if (!project?.repo_path) return { ok: false, error: "project has no repo_path" };
  const config = JSON.parse(project.config ?? "{}");
  const agent = agentForConfig(config);

  // Compose the brief fresh; it is delivered as the interactive agent's first
  // prompt (see runtime/herdr.defaultAgentArgv) with no one-shot mode. Steers sent
  // while the task had no live agent ride along on top, so they reach the fresh
  // agent instead of vanishing. briefOverride is the persistent-chat supervisor's
  // bespoke brief (it isn't a normal ship/scout task, so composeBrief's
  // open-a-PR-and-hand-off protocol doesn't apply).
  const pending = queuedSteers(db, id);
  const brief = steerPreamble(pending) + (opts.briefOverride ?? composeBrief(db, id));
  const hiveUrl = opts.hiveUrl || process.env.HIVE_URL || `http://127.0.0.1:${process.env.HIVE_PORT || 4700}`;
  // TeamClaude proxy env first when the project opted in (agent="teamclaude";
  // null when the proxy is down → agent runs direct), then secrets/platform.
  // Machine account routing is applied last so a same-named project secret
  // cannot silently replace the selected Claude profile.
  const env = {
    ...teamclaudeOverlay(usesTeamclaude(config) ? await teamclaudeEnv() : null),
    // Figma access for headless agents (the Figma MCP is interactive-only), so
    // a stripped/sandboxed agent env still reaches the REST API. A project
    // secret of the same name overrides it below.
    ...figmaTokenEnv(),
    ...(await resolveProjectSecrets(db, task.project_id)),
    ...agentPlatformEnv(),
    ...claudeProfileEnvForRepo(project.repo_path),
    HIVE_AGENT: agent,
  };

  let result;
  try {
    result = await herdr.spawn({
      taskId: id,
      repoPath: project.repo_path,
      hiveUrl,
      title: task.title,
      brief,
      base: projectBaseBranch(config),
      env,
      model: modelForTask(config, task.kind),
      agentArgv: agentArgvFor(config, task.kind, brief),
      // Seed the worktree BEFORE the agent starts: agent hook wiring
      // (structural Stop/SubagentStop/PostToolUse reporting), then the
      // per-project spawn hook (config.setup_argv, e.g. wt.sh up {worktree}) so
      // agents don't have to install deps / bring up their stack themselves.
      prepareWorktree: async (worktreePath) => {
        if (agent === "claude") writeHookSettings(worktreePath, id, hiveUrl, config.command_approval);
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
      // Stable pane handle: herdr recycles tab/pane ids, terminal ids it does
      // not. Re-adoption after a registry wipe addresses the pane by this.
      terminal_id: result.terminal_id,
      pane_id: result.pane_id,
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
  resumeReviewForDeliveredSteers(db, id, pending, "respawn");
  if (task.state === "queued") transition(db, id, "in_progress", { source: "herdr", reason: "agent spawned" });

  if (opts.supervise) superviseAgent(db, herdr, id, result.agent_target);

  return { ok: true, agent_target: result.agent_target };
}

// Re-arming supervised wait loop: the herdr PUSH channel for "the agent is
// done". It never relies on anything the agent emits — herdr's own idle/done signal
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
export async function internalSteer(db: DB, herdr: Herdr, id: string, message: string, actor: string | null = null): Promise<boolean> {
  const task = getTask(db, id);
  if (!task || isTrackingOnlyTask(task)) return false;
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
    payload: { message, target, attachments: [], delivery, ...(actor ? { actor } : {}), ...(delivered ? { delivered_at: now() } : { error }) },
  });
  return delivered;
}

async function sendSteer(db: DB, herdr: Herdr, id: string, req: Request): Promise<Response> {
  const task = getTask(db, id);
  if (!task) return err("task not found", 404);
  const { fields, files } = await bodyWithFiles(req);
  const text = String(fields?.message ?? "").trim();
  if (!text) return err("message is required");
  const fromTaskId = fields?.from_task_id ? String(fields.from_task_id) : null;
  const sender = fromTaskId ? getTask(db, fromTaskId) : null;
  const actor = sender ? null : actorOf(fields);
  if (fromTaskId && !sender) return err("unknown from_task_id", 400);
  if (sender && sender.project_id !== task.project_id) return err("teammates must belong to the same project", 400);
  const blocked = authzBlock(db, { project_id: task.project_id, action: "task.steer", target: task.title, task_id: id });
  if (blocked) return blocked;
  const jiraLinked = String(task.source_ref ?? "").startsWith(JIRA_REF_PREFIX);
  if (jiraLinked) {
    // Jira-linked external task: its "agent" is the Jira sync, so the message
    // becomes an outbound comment there instead — a real delivery path
    // regardless of whether this task has ever been spawned. No `delivery`
    // field on the payload: the real push/shadow outcome lives in the sync
    // log's comment_push/comment_shadow events (server/src/intake/jira.ts),
    // and nothing reads it here — a stored 'queued' would just go stale
    // forever once syncJiraOnce actually pushes the comment (task #1008).
    if (files.length) return err("Jira comment attachments are not supported yet", 400);
    const comment = sender ? `Hive agent #${sender.number} (${sender.title}):\n${text}` : text;
    if (comment.length > JIRA_COMMENT_MAX_LENGTH)
      return err(`Jira comments are limited to ${JIRA_COMMENT_MAX_LENGTH} characters`, 413);
    writeEvent(db, {
      task_id: id,
      source: sender ? "agent" : "director",
      type: "jira_comment",
      payload: { direction: "outbound", text: comment, ...(sender ? { from_task_id: sender.id } : { actor }) },
    });
    return json({ ok: true, delivered: false, delivery: "queued", message: comment, attachments: [] });
  }
  // A Jira mirror never has an agent, now or later, so a steer can never land.
  if (isJiraMirror(task))
    return err("this task mirrors a Jira issue — hive runs no agent on it, so a steer can never be delivered", 400);
  // neverDispatched (supervision.ts): tracking-only AND never even manually
  // spawned — since #996, spawnAgent itself refuses a never-dispatched
  // external task's first spawn too, so the only way past this today is a
  // task that was already spawned before that gate existed (recovery, a
  // legacy row). Nobody is ever coming for this message, so a queued steer
  // would sit unread forever instead of just never being delivered (task
  // #977). Once a task HAS been spawned at least once, the normal
  // delivered/queued/failed logic below applies unchanged: a live agent may
  // pick it up now, or a future manual respawn may carry it, same as any
  // other task.
  if (neverDispatched(db, task))
    return err("task is untracked (source=external) and has never been spawned — a steer message can never be delivered", 400);
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
      ...(!sender ? { actor } : {}),
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
  if (isTrackingOnlyTask(task)) return err("tracking-only tasks have no agent pane", 409);
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
  projectId?: string,
  actor: string | null = null
): Promise<{ targets: number; delivered: number; results: { task_id: string; delivered: boolean }[] }> {
  const rows = db
    .query(
      `SELECT id FROM tasks WHERE agent_target IS NOT NULL
        AND state IN ('in_progress','needs_decision','in_review','verifying')${projectId ? " AND project_id = ?" : ""}`
    )
    .all(...(projectId ? [projectId] : [])) as { id: string }[];
  const results: { task_id: string; delivered: boolean }[] = [];
  for (const t of rows) {
    results.push({ task_id: t.id, delivered: await internalSteer(db, herdr, t.id, message, actor) });
  }
  return { targets: results.length, delivered: results.filter((r) => r.delivered).length, results };
}

async function broadcastSteer(db: DB, herdr: Herdr, body: any): Promise<Response> {
  const message = String(body?.message ?? "").trim();
  if (!message) return err("message is required");
  const r = await steerLiveAgents(db, herdr, message, body?.project_id ? String(body.project_id) : undefined, actorOf(body));
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

// ---- away mode ----
// Hold low-urgency phone pushes and batch them. POST accepts any subset of
// {on, schedule, always_through}; anything omitted keeps its current value.
// Turning away mode off (or clearing the schedule) flushes the held list right
// away, so the summary push does not wait for the next reconciler tick.
function setAwayMode(db: DB, body: any): Response {
  const current = getAway(db);
  const next: AwayConfig = {
    on: body?.on === undefined ? current.on : !!body.on,
    schedule: body?.schedule === undefined ? current.schedule : body.schedule || undefined,
    always_through: Array.isArray(body?.always_through) ? body.always_through : current.always_through,
  };
  setAway(db, next);
  const { active, flushed } = syncAway(db);
  return json({ ...getAway(db), active, flushed, held: heldPushes(db).length, items: heldPushes(db), last_flush: lastFlush(db) });
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

// Is this checkpoint a plan the agent is parked on (HIVE-413)?
function planCheckpointBlocks(payload: string): boolean {
  try {
    return JSON.parse(payload)?.blocking === true;
  } catch {
    return false;
  }
}

// The plan fields on a plan checkpoint, for the Needs You card. Null for an
// ordinary note-only checkpoint.
function checkpointPlan(payload: string): Record<string, unknown> | null {
  try {
    const p = JSON.parse(payload);
    if (p?.kind !== "plan") return null;
    return {
      goal: String(p.goal ?? ""),
      approach: String(p.approach ?? ""),
      files_expected: Array.isArray(p.files_expected) ? p.files_expected.map(String) : [],
      verification_planned: String(p.verification_planned ?? ""),
    };
  } catch {
    return null;
  }
}

interface UnderstandingCheck {
  question: string;
  options: { key: string; label: string }[];
  answerKey: string;
  explanation?: string;
}

// Server-side lint floor: only the egregious wording gets flagged (a question
// past ~400 chars, or an option past ~150), and even then it's a steer asking
// the agent to tighten the wording, never a rejection — the length rule is
// soft guidance (director feedback 2026-08-25), so a long-but-reasonable quiz
// for a genuinely complex change must sail through untouched.
function isEgregiousCheckWording(check: { question: string; options: { label: string }[] }): boolean {
  return check.question.length > 400 || check.options.some((option) => option.label.length > 150);
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

// Recurrence guard. One artifact states a fact once: a review card that repeats
// the same point across three bullets and then quizzes it again is the padding
// the director called out (2026-08-19). The prompts (see plainEnglish.ts) ask
// for this; here it is enforced for the case a rule cannot be argued with — the
// SAME sentence twice, ignoring case, punctuation and spacing. A reworded
// repeat still gets through, so this is a floor, not a filter.
function recurrenceKey(value: unknown): string {
  const text =
    typeof value === "string"
      ? value
      : value && typeof value === "object" && typeof (value as any).what === "string"
        ? (value as any).what
        : JSON.stringify(value ?? "");
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function dropRepeats<T>(items: T[], key: (value: T) => string = recurrenceKey): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const k = key(item);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
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

// listUnderstandingQuizzes and answerUnderstandingQuiz must agree on which task
// states have an actionable quiz, or the list can advertise an item the answer
// endpoint then rejects (hive-1006).
const UNDERSTANDING_QUIZ_ANSWERABLE_STATES = ["in_review", "verifying", "done", "failed"];

// Paths whose changes always deserve a director quiz, whatever the reviewer
// said. Per-project override: config.understanding_checks.sensitive_paths.
const DEFAULT_SENSITIVE_PATHS = ["auth", "token", "security", "payment", "billing", "migration", "secret", "credential", "password"];

// Match a token anywhere inside a path segment, case-insensitively, so "auth"
// hits `server/src/auth.ts`, `web/authGuard.ts` AND `src/authTokens.ts`.
// Deliberately biased to false positives: quizzing a mechanical change costs
// the director one question, missing a sensitive one costs a blind merge.
// ponytail: substring matching, not globs. Swap in a glob matcher only if a
// project needs a path shape this cannot express.
function touchesSensitivePath(files: string[], tokens: string[]): boolean {
  const needles = tokens.map((token) => token.toLowerCase()).filter(Boolean);
  return files.some((file) => {
    const segments = file.toLowerCase().split("/");
    return needles.some((needle) => segments.some((segment) => segment.includes(needle)));
  });
}

// The newest verdict from the auto reviewer, or null when it never produced one
// (never ran, errored, or was skipped by project config).

// Judgment-class or not (hive-1559). Hive raises only the few changes that
// actually need the director's head; everything mechanical merges without a
// quiz and never lands in the post-ship backlog. A task is judgment-class when
// ANY of these holds:
//   1. the latest auto_review verdict is not `looks_good` (missing, errored,
//      skipped and `caution` all count — no clean verdict means no free pass),
//   2. its reviewed diff touches a sensitive path (auth/security/payments/
//      migrations by default, per-project via config.understanding_checks),
//   3. its kind is outside the project's auto_merge.kinds allow-list, or
//   4. the director flagged the task (POST .../understanding-quiz/require).
export function understandingChecksRequired(
  db: DB,
  task: { id: string; kind: string; project_id: string; head_sha?: string | null }
): boolean {
  const project: any = db.query("SELECT config FROM projects WHERE id = ?").get(task.project_id);
  const config = JSON.parse(project?.config ?? "{}");
  if (!(Array.isArray(config.auto_merge?.kinds) && config.auto_merge.kinds.includes(task.kind))) return true;
  const flagged = db
    .query("SELECT 1 FROM events WHERE task_id = ? AND type = 'understanding_required' LIMIT 1")
    .get(task.id);
  if (flagged) return true;
  const review = latestAutoReviewVerdict(db, task.id);
  if (!review) return true;
  // A review's verdict only speaks for the head it looked at. A force-push
  // after review moves task.head_sha out from under it (HIVE-453) — treat that
  // review as absent so a stale cleared-caution or stale looks_good can't
  // un-gate the quiz for a head nobody actually reviewed.
  if (task.head_sha && review.reviewed_head_sha !== task.head_sha) return true;
  // A caution whose every risk was refuted and every question answered from the
  // code is not judgment-class either (HIVE-407) — the same rule the reconciler
  // uses to auto-merge it. Anything still confirmed or human-only needs the
  // director, so it keeps its quiz.
  if (review.verdict !== "looks_good" && !cautionCleared(db, task.id, review.reviewed_head_sha, review)) return true;
  const tokens = Array.isArray(config.understanding_checks?.sensitive_paths)
    ? config.understanding_checks.sensitive_paths.map(String)
    : DEFAULT_SENSITIVE_PATHS;
  return touchesSensitivePath(review.files, tokens);
}

// Judgment-class says a quiz is OWED. This says it is ANSWERABLE (HIVE-488).
// A task still in review has nothing to ask the director until its own review
// pipeline finished for the CURRENT head: the auto review was written for that
// head, and every risk and question it raised has a verdict keyed to that head.
// Short of that the quiz is pipeline state — the review card still shows the
// task as in review, but it must not count toward the quiz or needs-you totals.
// Shipped tasks (verifying/done/failed) are the post-ship catch-up class: their
// head is settled and their quiz is answerable, and it only ever feeds the
// digest, never a blocking gate.
function quizAnswerable(db: DB, task: { id: string; state: string; head_sha: string | null; project_id: string }): boolean {
  // Shipped: the post-ship catch-up class. Its head is settled, so it is
  // answerable, and it only ever feeds the digest.
  if (task.state !== "in_review") return true;
  // The director asked for this one by hand, so it is their question whatever
  // the pipeline is doing.
  if (db.query("SELECT 1 FROM events WHERE task_id = ? AND type = 'understanding_required' LIMIT 1").get(task.id)) return true;
  // No head to key verdicts to, or a project that never auto-reviews: the
  // reviewer skips both, so nothing further is coming and this is as complete
  // as the review gets.
  if (!task.head_sha) return true;
  const project: any = db.query("SELECT config FROM projects WHERE id = ?").get(task.project_id);
  if (JSON.parse(project?.config ?? "{}").auto_review === false) return true;
  return reviewCompleteForHead(db, task.id, task.head_sha);
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
): { check: UnderstandingCheck; index: number; completed: number; version: string } {
  const progress = understandingQuizProgress(db, taskId, quiz.reviewEventId);
  const remaining = quiz.checks.map((_, index) => index).filter((index) => !progress.completed.has(index));
  const pool = remaining.length ? remaining : quiz.checks.map((_, index) => index);
  const offset = [...quiz.reviewEventId].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  const index = pool[(offset + progress.attempts) % pool.length];
  return { check: quiz.checks[index], index, completed: quiz.checks.length - remaining.length, version: `${quiz.reviewEventId}:${progress.attempts}` };
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

// Quizzes on tasks that already shipped: the post-ship catch-up backlog. The
// web UI shows these as ONE digest, so the count here is what that digest says,
// not a number of separate attention items. Quizzes on tasks still in review
// are excluded — those gate their own review card.
const POST_SHIP_QUIZ_STATES = ["verifying", "done", "failed"];
// Same filters as listUnderstandingQuizzes (the list the "Catch up" digest
// cards are built from) so this count always agrees with what those cards
// show, including the mechanical-task exclusion (hive-1559). Pass projectId
// to scope the count to one project, matching how the client groups digests.
export function pendingPostShipQuizCount(db: DB, projectId?: string): number {
  const placeholders = POST_SHIP_QUIZ_STATES.map(() => "?").join(",");
  const rows = db
    .query(
      `SELECT e.id, e.task_id, e.payload, t.project_id, t.kind FROM events e JOIN tasks t ON t.id = e.task_id
        WHERE e.type = 'review_summary'
          AND t.state IN (${placeholders})
          AND (? IS NULL OR t.project_id = ?)
          AND NOT EXISTS (
            SELECT 1 FROM events newer
             WHERE newer.task_id = e.task_id AND newer.type = 'review_summary'
               AND (newer.ts > e.ts OR (newer.ts = e.ts AND newer.rowid > e.rowid)))`
    )
    .all(...POST_SHIP_QUIZ_STATES, projectId ?? null, projectId ?? null) as
    { id: string; task_id: string; payload: string; project_id: string; kind: string }[];
  return rows.filter((row) => {
    let payload: any;
    try { payload = JSON.parse(row.payload); } catch { return false; }
    if (!normalizeUnderstandingChecks(payload?.understanding).length) return false;
    // Same judgment-class filter the quiz list applies, or the digest promises
    // more changes to catch up on than the list can show (HIVE-488).
    if (!understandingChecksRequired(db, { id: row.task_id, kind: row.kind, project_id: row.project_id })) return false;
    return understandingQuizStatus(db, row.task_id, row.id) !== "passed";
  }).length;
}

function listUnderstandingQuizzes(db: DB, url: URL): Response {
  const projectId = url.searchParams.get("project_id");
  const statePlaceholders = UNDERSTANDING_QUIZ_ANSWERABLE_STATES.map(() => "?").join(",");
  const rows = db
    .query(
      `SELECT e.id, e.task_id, e.ts, e.payload, t.number, t.title, t.project_id, t.state, t.kind, t.head_sha
         FROM events e JOIN tasks t ON t.id = e.task_id
        WHERE e.type = 'review_summary'
          AND t.state IN (${statePlaceholders})
          AND (? IS NULL OR t.project_id = ?)
          AND NOT EXISTS (
            SELECT 1 FROM events newer
             WHERE newer.task_id = e.task_id AND newer.type = 'review_summary'
               AND (newer.ts > e.ts OR (newer.ts = e.ts AND newer.rowid > e.rowid)))
        ORDER BY t.number DESC`
    )
    .all(...UNDERSTANDING_QUIZ_ANSWERABLE_STATES, projectId, projectId) as any[];
  const quizzes = rows.flatMap((row) => {
    let payload: any;
    try { payload = JSON.parse(row.payload); } catch { return []; }
    const checks = normalizeUnderstandingChecks(payload?.understanding);
    if (!checks.length) return [];
    // A mechanical change gets no backlog entry even when its agent submitted
    // checks anyway (hive-1559).
    if (!understandingChecksRequired(db, { id: row.task_id, kind: row.kind, project_id: row.project_id, head_sha: row.head_sha }))
      return [];
    // Not yet answerable = the review pass has not finished for the live head.
    if (!quizAnswerable(db, { id: row.task_id, state: row.state, head_sha: row.head_sha, project_id: row.project_id })) return [];
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
      version: active.version,
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
  if (!UNDERSTANDING_QUIZ_ANSWERABLE_STATES.includes(task.state))
    return err("understanding checks can be answered during review or from the post-ship backlog", 409);
  if (body?.source !== "director") return err("only the director can answer understanding checks", 403);
  const quiz = latestUnderstandingQuiz(db, taskId);
  if (!quiz) return err("understanding check not found", 404);
  const status = understandingQuizStatus(db, taskId, quiz.reviewEventId);
  const active = activeUnderstandingCheck(db, taskId, quiz);
  const check = active.check;
  const actor = actorOf(body);
  const expectedVersion = body?.version;
  if (expectedVersion !== undefined && typeof expectedVersion !== "string") return err("version must be a string");
  if (status === "passed" || (expectedVersion !== undefined && expectedVersion !== active.version)) {
    const winner: any = db
      .query(
        `SELECT * FROM events WHERE task_id = ?
          AND type IN ('understanding_quiz_attempt', 'understanding_quiz_passed')
          AND json_extract(payload, '$.review_event_id') = ? ORDER BY rowid DESC LIMIT 1`
      )
      .get(taskId, quiz.reviewEventId);
    if (expectedVersion === undefined)
      return json({ ok: true, correct: true, passed: true, explanation: check.explanation ?? null });
    const event = winner ? parseEvent(winner) : null;
    const index = Number(event?.payload?.check_index);
    const answerKey = event?.payload?.answer_key ?? null;
    const answerLabel = Number.isInteger(index)
      ? quiz.checks[index]?.options.find((option) => option.key === answerKey)?.label ?? answerKey
      : answerKey;
    return staleResponse("understanding check already changed", {
      status,
      source: event?.source ?? "system",
      actor: event?.payload?.actor ?? null,
      at: event?.ts ?? null,
      answer_key: answerKey,
      answer_label: answerLabel,
      correct: event?.payload?.correct ?? status === "passed",
    });
  }
  const answerKey = typeof body?.answer_key === "string" ? body.answer_key : "";
  if (!check.options.some((option) => option.key === answerKey)) return err("answer_key must match a quiz option");
  if (answerKey !== check.answerKey) {
    writeEvent(db, {
      task_id: taskId,
      source: "director",
      type: "understanding_quiz_attempt",
      payload: { review_event_id: quiz.reviewEventId, check_index: active.index, answer_key: answerKey, correct: false, actor },
    });
    const next = activeUnderstandingCheck(db, taskId, quiz);
    return json({
      ok: false,
      correct: false,
      passed: false,
      explanation: check.explanation ?? null,
      completed: next.completed,
      total: quiz.checks.length,
      quiz: { question: next.check.question, options: next.check.options, version: next.version, completed: next.completed, total: quiz.checks.length },
    });
  }
  writeEvent(db, {
    task_id: taskId,
    source: "director",
    type: "understanding_quiz_attempt",
    payload: { review_event_id: quiz.reviewEventId, check_index: active.index, answer_key: answerKey, correct: true, actor, surface: body?.surface === "focus" ? "focus" : undefined },
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
      quiz: { question: next.check.question, options: next.check.options, version: next.version, completed: next.completed, total: quiz.checks.length },
    });
  }
  writeEvent(db, {
    task_id: taskId,
    source: "director",
    type: "understanding_quiz_passed",
    payload: { review_event_id: quiz.reviewEventId, check_index: active.index, answer_key: answerKey, actor, surface: body?.surface === "focus" ? "focus" : undefined },
  });
  return json({ ok: true, correct: true, passed: true, explanation: check.explanation ?? null, completed: next.completed, total: quiz.checks.length });
}

// The director's own "quiz me on this one" flag (hive-1559): it makes an
// otherwise mechanical task judgment-class, so its checks are required again.
function requireUnderstandingQuiz(db: DB, taskId: string, body: any): Response {
  const task = getTask(db, taskId);
  if (!task) return err("task not found", 404);
  if (body?.source !== "director") return err("only the director can require understanding checks", 403);
  const already = db.query("SELECT 1 FROM events WHERE task_id = ? AND type = 'understanding_required' LIMIT 1").get(taskId);
  if (!already)
    writeEvent(db, { task_id: taskId, source: "director", type: "understanding_required", payload: { actor: actorOf(body) } });
  return json({ ok: true, understanding_required: true });
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
      payload: { review_event_id: quiz.reviewEventId, actor: actorOf(body) },
    });
  }
  return json({ ok: true, status: "deferred" });
}

// A checkpoint is a note, not a blocker: the agent kept working after emitting
// it. So an un-acked one stops asking for the director once it has gone quiet
// (project config checkpoint_expiry_hours, default 24; 0 disables) AND its task
// moved forward on its own afterwards. It stays on the task timeline either
// way — only the attention inbox drops it. A flagged checkpoint (payload.flag,
// or any ack, which already excludes it here) never expires.
const CHECKPOINT_EXPIRY_DEFAULT_HOURS = 24;
const EXPIRY_HOURS_SQL = `COALESCE(json_extract(p.config, '$.checkpoint_expiry_hours'), ${CHECKPOINT_EXPIRY_DEFAULT_HOURS})`;
const CHECKPOINT_NOT_EXPIRED_SQL = `NOT (
  ${EXPIRY_HOURS_SQL} > 0
  AND julianday(e.ts) < julianday('now') - ${EXPIRY_HOURS_SQL} / 24.0
  AND COALESCE(json_extract(e.payload, '$.flag'), 0) = 0
  AND EXISTS (
    SELECT 1 FROM events s
     WHERE s.task_id = e.task_id AND s.type = 'state_change' AND s.ts > e.ts
       AND json_extract(s.payload, '$.to') IN ('in_review', 'verifying', 'done'))
)`;

function openCheckpointRows(db: DB, projectId: string | null, includeTest = false): any[] {
  // Un-acked checkpoints stay reviewable AFTER the task finishes — agents
  // finish faster than the director's attention cycle, and 21 of the first 25
  // checkpoints vanished unreviewed when this filtered to live states
  // (2026-07-10). Only cancelled tasks drop out (their calls died with them).
  // Checkpoints under a test/ephemeral project (see testProjects.ts) are
  // hidden from director surfaces by default, same as the project itself.
  return db
    .query(
      `SELECT e.id, e.task_id, e.ts, e.payload, t.number, t.title, t.project_id, t.state
         FROM events e JOIN tasks t ON t.id = e.task_id JOIN projects p ON p.id = t.project_id
        WHERE e.type = 'checkpoint'
          AND t.state != 'cancelled'
          AND (? IS NULL OR t.project_id = ?)
          AND (? OR ${notTestProjectSql("p.config")})
          AND NOT EXISTS (
            SELECT 1 FROM events a
             WHERE a.task_id = e.task_id AND a.type = 'checkpoint_ack'
               AND json_extract(a.payload, '$.checkpoint_id') = e.id)
          AND ${CHECKPOINT_NOT_EXPIRED_SQL}
        ORDER BY t.number DESC, e.ts ASC`
    )
    .all(projectId, projectId, includeTest ? 1 : 0) as any[];
}

function listOpenCheckpoints(db: DB, url: URL): Response {
  const rows = openCheckpointRows(db, url.searchParams.get("project_id"), url.searchParams.get("test") === "all");
  return json({
    checkpoints: rows.map((r) => {
      const plan = checkpointPlan(r.payload);
      return {
        id: r.id,
        task_id: r.task_id,
        ts: r.ts,
        task_number: r.number,
        task_title: r.title,
        task_state: r.state,
        project_id: r.project_id,
        note: checkpointNote(r.payload),
        // A blocking plan is the whole card: the director approves from the
        // plan plus the critic's concerns, without opening the task.
        ...(planCheckpointBlocks(r.payload) ? { blocking: true } : {}),
        ...(plan ? { plan, concerns: planConcerns(db, r.task_id, r.id) } : {}),
      };
    }),
  });
}

// The critic's concerns for a plan checkpoint, or [] when the critique has not
// landed yet (it runs in the background).
function planConcerns(db: DB, taskId: string, checkpointId: string): { severity: string; text: string }[] {
  const row: any = db
    .query(
      `SELECT payload FROM events WHERE task_id = ? AND type = 'plan_critique'
        AND json_extract(payload, '$.checkpoint_id') = ? ORDER BY rowid DESC LIMIT 1`
    )
    .get(taskId, checkpointId);
  try {
    const concerns = JSON.parse(row?.payload ?? "{}")?.concerns;
    return Array.isArray(concerns) ? concerns : [];
  } catch {
    return [];
  }
}

async function ackCheckpoint(db: DB, herdr: Herdr, taskId: string, eventId: string, body: any): Promise<Response> {
  const ev: any = db
    .query("SELECT * FROM events WHERE id = ? AND task_id = ? AND type = 'checkpoint'")
    .get(eventId, taskId);
  if (!ev) return err("checkpoint not found", 404);
  const prior: any = db
    .query(
      `SELECT * FROM events WHERE task_id = ? AND type = 'checkpoint_ack'
        AND json_extract(payload, '$.checkpoint_id') = ? ORDER BY rowid ASC LIMIT 1`
    )
    .get(taskId, eventId);
  if (prior) {
    const winner = parseEvent(prior);
    return staleResponse("checkpoint already acknowledged", {
      status: "acknowledged",
      source: winner.source,
      actor: winner.payload.actor ?? null,
      at: winner.ts,
      verdict: winner.payload.verdict,
      note: winner.payload.note ?? null,
    });
  }
  const verdict = body?.verdict;
  if (verdict !== "ok" && verdict !== "flag") return err("verdict must be 'ok' or 'flag'");
  const source = body?.source ?? "director";
  if (source !== "director" && source !== "chat_supervisor")
    return err("source must be 'director' or 'chat_supervisor'");
  const actor = actorOf(body);
  const task = getTask(db, taskId);
  if (verdict === "flag" && task && isTrackingOnlyTask(task))
    return err(TRACKING_ONLY_OWNERSHIP_ERROR, 409);
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
  // A blocking plan checkpoint (HIVE-413) parked the agent: the ack is what
  // restarts it, on both verdicts. An approval says nothing else, so it steers
  // here; a flag falls through to the flag steer below, which already carries
  // the correction.
  if (planCheckpointBlocks(ev.payload) && verdict === "ok") {
    delivered = await internalSteer(db, herdr, taskId, planReleaseSteer("ok", note));
    return json({ ok: true, delivered, followup_task_id });
  }
  if (verdict === "flag") {
    const cpText = checkpointNote(ev.payload);
    // A blocking plan (HIVE-413) parked its agent before any edit: a flag must
    // reach it even with no agent_target right now (internalSteer queues the
    // steer onto the next spawn). Nothing shipped, so a corrective follow-up
    // task would be the wrong answer.
    const live =
      task &&
      !["done", "cancelled", "failed"].includes(task.state) &&
      (task.agent_target || planCheckpointBlocks(ev.payload));
    if (live) {
      delivered = await internalSteer(
        db,
        herdr,
        taskId,
        planCheckpointBlocks(ev.payload)
          ? planReleaseSteer("flag", note)
          : `${source === "chat_supervisor" ? "The project supervisor" : "Director"} FLAGGED your checkpoint: "${cpText}"${note ? ` — ${note}` : ""}. Address this now, before continuing.`
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

// ---- request changes on shipped work (HIVE-510) ----

// What the shipped task left behind, for the follow-up brief. Every line is
// best effort: a report-only task has no PR, an old merge predates merged_files.
function shippedContext(db: DB, task: any): string[] {
  const lines = [
    `- Original task: ${taskIdentifier(db, task)} "${task.title}" (task id ${task.id}, kind ${task.kind})`,
    `- PR: ${task.pr_url || "none — this task shipped no PR"}`,
  ];
  const merged: any = db
    .query("SELECT payload FROM events WHERE task_id = ? AND type = 'merged' ORDER BY ts DESC, rowid DESC LIMIT 1")
    .get(task.id);
  const payload = merged ? JSON.parse(merged.payload || "{}") : null;
  if (task.head_sha) lines.push(`- Commit that shipped: ${task.head_sha}${payload?.base ? ` (merged into ${payload.base})` : ""}`);
  const files = Array.isArray(payload?.merged_files) ? payload.merged_files.filter((f: unknown) => typeof f === "string") : [];
  if (files.length) lines.push(`- Files it touched: ${files.join(", ")}`);
  const explanation = explanationFor(db, task.id, task.head_sha ?? null);
  if (explanation?.url) lines.push(`- Explanation of the change: ${explanation.url}`);
  return lines;
}

// The director read what shipped and wants it changed. The original task is
// terminal and STAYS terminal — reopening it would rewrite the record of what
// actually happened — so the correction becomes its own queued task. Same shape
// as the late checkpoint flag above: parent_task_id back to the original, a
// countable source, kind inherited, and enough shipped context in the brief that
// the new agent never has to re-derive what was built.
function requestChangesOnShipped(db: DB, task: any, body: any) {
  const taskId = task.id;
  if (isTrackingOnlyTask(task)) return err(TRACKING_ONLY_OWNERSHIP_ERROR, 409);
  const note = String(body?.note ?? body?.notes ?? "").trim();
  if (!note) return err("a note is required — it is the brief for the follow-up task", 400);
  const actor = actorOf(body);
  const label = taskIdentifier(db, task);
  const fid = newId();
  const t = now();
  const brief = [
    `The director reviewed ${label} after it shipped and wants changes.`,
    ``,
    `WHAT THEY ASKED FOR (their words, this is the job):`,
    note,
    ``,
    `WHAT ALREADY SHIPPED — start from this, do not rebuild it:`,
    ...shippedContext(db, task),
    ``,
    `Original brief:`,
    task.brief || "(none)",
    ``,
    `Do NOT reopen ${label}. It shipped and its record stays as it is. Make the change above as its own unit of work, with its own PR.`,
  ].join("\n");
  db.query(
    `INSERT INTO tasks (id, project_id, title, brief, state, kind, source, parent_task_id, created_at, updated_at)
     VALUES (?,?,?,?, 'queued', ?, 'director_rework', ?, ?, ?)`
  ).run(fid, task.project_id, `Changes requested on ${label}: ${note.slice(0, 80)}`, brief, task.kind, taskId, t, t);
  writeEvent(db, { task_id: fid, source: "director", type: "created", payload: { title: "director requested changes", original_task_id: taskId, actor } });
  writeEvent(db, { task_id: taskId, source: "director", type: "changes_requested_after_ship", payload: { followup_task_id: fid, note, actor } });
  const followup = getTask(db, fid);
  broadcastTask(db, followup);
  return json({ ok: true, followup_task_id: fid, followup_label: taskIdentifier(db, followup) });
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
  const settings = {
    permissions: { allow: SAFE_TOOL_ALLOWLIST, deny: DENIED_MCP_SERVERS },
    hooks: {
      // Gate Bash before it runs: safe commands auto-approve, risky ones escalate
      // to the authority engine so an autonomous worker never hangs on a dialog.
      PreToolUse: [
        { matcher: "Bash", hooks: [{ type: "command", command: hookScriptCommand("classify.ts", [commandApproval]) }] },
      ],
      Stop: [{ hooks: [{ type: "command", command: hookScriptCommand("hive-hook.ts", ["Stop"]) }] }],
      SubagentStop: [{ hooks: [{ type: "command", command: hookScriptCommand("hive-hook.ts", ["SubagentStop"]) }] }],
      PostToolUse: [
        { matcher: "Bash|Write|Edit", hooks: [{ type: "command", command: hookScriptCommand("hive-hook.ts", ["PostToolUse"]) }] },
      ],
    },
  };
  const dir = join(worktreePath, ".claude");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "settings.local.json"), JSON.stringify(settings, null, 2));
}

// "View agent" affordance: focus the task's herdr tab so the director can watch/attach.
// POST /api/tasks/:id/takeover  — park the agent, hand the worktree to the director.
// POST /api/tasks/:id/handback {note?} — put an agent back on the branch with a
// steer summarising what the director changed while it was parked.
async function takeoverEndpoint(
  db: DB,
  herdr: Herdr,
  id: string,
  verb: string,
  body: any,
  deps: HandlerDeps
): Promise<Response> {
  try {
    if (verb === "takeover") return json({ ok: true, ...(await takeOver(db, id, { herdr, exec: deps.exec })) });
    return json({ ok: true, ...(await handBack(db, id, { note: body?.note, exec: deps.exec })) });
  } catch (e) {
    if (e instanceof TakeoverError) return err(e.message, e.message === "task not found" ? 404 : 409);
    throw e;
  }
}

async function focusAgent(db: DB, herdr: Herdr, id: string): Promise<Response> {
  const task = getTask(db, id);
  if (!task) return err("task not found", 404);
  if (isTrackingOnlyTask(task)) return err("tracking-only tasks have no agent to focus", 409);
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
async function requeueEndpoint(db: DB, herdr: Herdr, id: string): Promise<Response> {
  const task = getTask(db, id);
  if (!task) return err("task not found", 404);
  if (isJiraMirror(task)) return err(TRACKING_ONLY_REQUEUE_ERROR, 409);
  if (!TERMINAL.includes(task.state as State)) {
    await reclaimDeadWorktree(db, herdr, task);
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

// The ghost branch a dead worktree's uncommitted WIP was rescued onto
// (reclaimDeadWorktree / herdr.reclaimWorktree), if the reconciler ever had to
// do that rescue for this task. Most recent one wins (a task can be rescued
// more than once across retries).
function latestGhostBranch(db: DB, taskId: string): string | null {
  const rows = db
    .query("SELECT payload FROM events WHERE task_id = ? AND type = 'worktree_reclaimed' ORDER BY ts DESC")
    .all(taskId) as { payload: string }[];
  for (const r of rows) {
    const ghost = JSON.parse(r.payload)?.ghost_branch;
    if (ghost) return ghost;
  }
  return null;
}

// A predecessor's pr_url only means "adopt this" while the PR is still open —
// once the reconciler has recorded it merged/closed (or a director merged it),
// there's nothing left to adopt.
function prOutcome(db: DB, ids: string[], url: string): "open" | "closed" | "merged" {
  const placeholders = ids.map(() => "?").join(",");
  const row = db
    .query(
      `SELECT type FROM events WHERE task_id IN (${placeholders})
       AND type IN ('pr_closed','pr_merged','merged')
       AND json_extract(payload, '$.pr_url') = ?
       ORDER BY ts DESC LIMIT 1`
    )
    .get(...ids, url) as { type: string } | undefined;
  if (!row) return "open";
  return row.type === "pr_closed" ? "closed" : "merged";
}

function predecessorOpenPrUrl(db: DB, source: any): string | null {
  const inheritedUrl = source.resume_pr_url || null;
  const ownUrl = source.pr_url && source.pr_url !== inheritedUrl ? source.pr_url : null;
  if (ownUrl) {
    const ownOutcome = prOutcome(db, [source.id], ownUrl);
    if (ownOutcome === "open") return ownUrl;
    if (ownOutcome === "merged") return null;
  }
  if (!inheritedUrl) return null;
  const ids = source.parent_task_id ? [source.id, source.parent_task_id] : [source.id];
  return prOutcome(db, ids, inheritedUrl) === "open" ? inheritedUrl : null;
}

function answeredDecisionSummaries(db: DB, taskId: string): string[] {
  const rows = db
    .query("SELECT title, answer_key, answer_note, answered_by, options FROM decisions WHERE task_id = ? AND status = 'answered' ORDER BY answered_at")
    .all(taskId) as { title: string; answer_key: string | null; answer_note: string | null; answered_by: string | null; options: string }[];
  return rows.map((r) => {
    const opts = JSON.parse(r.options || "[]");
    const chosen = opts.find((o: any) => o.key === r.answer_key);
    const note = r.answer_note?.trim();
    const answerer = r.answered_by && r.answered_by !== "director"
      ? `; [answered by ${r.answered_by}, not director]`
      : "";
    return `${r.title} — ${chosen?.label ?? r.answer_key ?? "answered"}${note ? `; note: ${note}` : ""}${answerer}`;
  });
}

function lastReviewHeadline(db: DB, taskId: string): string | null {
  const row = db
    .query("SELECT payload FROM events WHERE task_id = ? AND type = 'review_summary' ORDER BY ts DESC, rowid DESC LIMIT 1")
    .get(taskId) as { payload: string } | undefined;
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.payload);
    const p = parsed && typeof parsed === "object" ? parsed : {};
    const doneCount = Array.isArray(p.done) ? p.done.length : 0;
    const iffyCount = Array.isArray(p.iffy) ? p.iffy.length : 0;
    if (doneCount || iffyCount)
      return `a self-review was already submitted (${doneCount} item(s) done, ${iffyCount} flagged iffy) — read the review_summary event before redoing that work`;
    const sections = ["decisions", "testing", "followups", "understanding"].filter((key) => {
      const value = p[key];
      if (Array.isArray(value)) return value.length > 0;
      return Boolean(value && typeof value === "object" && Object.keys(value).length);
    });
    const detail = sections.length ? ` (${sections.join(", ")} section(s) included)` : "";
    return `a self-review was already submitted${detail} — read the review_summary event before redoing that work`;
  } catch {
    return null;
  }
}

const RESUME_START = "<!-- hive:resume -->";
const RESUME_END = "<!-- /hive:resume -->";

function stripPriorResumeSection(brief: string | null | undefined): string {
  const text = brief ?? "";
  const start = text.indexOf(RESUME_START);
  if (start === -1) return text;
  const end = text.indexOf(RESUME_END, start);
  if (end === -1) return text;
  return (text.slice(0, start) + text.slice(end + RESUME_END.length)).trim();
}

// The auto-generated "RESUME" section prepended to a requeue's brief (see
// requeueTask). Returns null when the predecessor never got as far as a
// branch — nothing to adopt, requeue behaves exactly as before.
function buildResumeSection(
  db: DB,
  source: any
): { text: string; branch: string; ghostBranch: string | null; prUrl: string | null } | null {
  const ownGhostBranch = latestGhostBranch(db, source.id);
  const branch = source.branch || source.resume_branch;
  if (!branch) return null;
  const inheritedBranch = source.resume_branch && source.resume_branch !== branch ? source.resume_branch : null;
  const inheritedGhost = source.resume_ghost_branch && source.resume_ghost_branch !== ownGhostBranch ? source.resume_ghost_branch : null;
  const ghostBranch = ownGhostBranch || inheritedGhost;
  const prUrl = predecessorOpenPrUrl(db, source);
  const prFactsApply = !!prUrl && prUrl === source.pr_url;
  const chain = [source];
  const seen = new Set([source.id]);
  let owner = source;
  const ownsContext = (task: any) => prUrl ? task.pr_url === prUrl : task.branch === branch;
  while (!ownsContext(owner) && owner.parent_task_id) {
    const parent = getTask(db, owner.parent_task_id);
    if (!parent || seen.has(parent.id)) break;
    chain.push(parent);
    seen.add(parent.id);
    owner = parent;
  }
  const ownerPrFactsApply = owner.id !== source.id && !!prUrl && prUrl === owner.pr_url;
  const headSha = prFactsApply ? source.head_sha : ownerPrFactsApply ? owner.head_sha : null;
  const ciStatus = prFactsApply ? source.ci_status : ownerPrFactsApply ? owner.ci_status : null;
  const decisions = chain.flatMap((task) => answeredDecisionSummaries(db, task.id));
  const review = chain.map((task) => lastReviewHeadline(db, task.id)).find(Boolean) ?? null;
  const lead = prUrl
    ? `**RESUME — adopt PR ${prUrl} / branch \`${branch}\`. Do NOT rebuild this feature from scratch.**`
    : `**RESUME — adopt branch \`${branch}\`. Do NOT rebuild this feature from scratch.**`;
  const lines = [
    RESUME_START,
    lead,
    `This continues failed attempt task #${source.number ?? "?"} (id ${source.id}), which already made progress. Fetch \`${branch}\` and merge it into your own branch. Do not check it out and switch away from your own branch; Hive tracks yours going forward, not the predecessor's. Read the merged work and continue from where it stopped.`,
    "",
    `- Branch to merge in: \`${branch}\``,
  ];
  if (ownGhostBranch)
    lines.push(`- Uncommitted WIP was rescued onto \`${ownGhostBranch}\` when the dead worktree was reclaimed. Merge it, along with the adopted branch above, into your own current branch before continuing.`);
  if (inheritedBranch)
    lines.push(`- This attempt itself inherited \`${inheritedBranch}\` from an earlier failed attempt but never confirmed merging it before it also died. Fetch it too, check whether it holds work the branch above is missing, and merge whichever has the real content.`);
  if (inheritedGhost)
    lines.push(`- An earlier attempt also had uncommitted WIP separately rescued onto \`${inheritedGhost}\`. Check it too and merge any missing work into your own current branch.`);
  if (prUrl) lines.push(`- Open PR: ${prUrl}${headSha ? ` (last known head \`${headSha}\`)` : ""} — push your fixes to this PR. Do not open a second PR for this feature.`);
  if (ciStatus) lines.push(`- Last known CI status: ${ciStatus}`);
  if (decisions.length) {
    lines.push(`- Decisions the director already answered on the failed attempt (don't re-ask):`);
    for (const d of decisions) lines.push(`  - ${d}`);
  }
  if (review) lines.push(`- ${review}`);
  lines.push("", "---", RESUME_END);
  return { text: lines.join("\n"), branch, ghostBranch, prUrl };
}

function backfillRequeueResume(db: DB, predecessorId: string, source: "reconciler" | "director"): void {
  const predecessor: any = getTask(db, predecessorId);
  if (!predecessor || (predecessor.state !== "failed" && predecessor.state !== "cancelled")) return;
  const resume = buildResumeSection(db, predecessor);
  if (!resume?.prUrl) return;
  const successors = db
    .query("SELECT * FROM tasks WHERE parent_task_id = ? AND source = 'requeue' AND resume_pr_url IS NULL")
    .all(predecessorId) as any[];
  for (const successor of successors) {
    const priorBrief = stripPriorResumeSection(successor.brief);
    const brief = [resume.text, priorBrief].join("\n").trim();
    const result = db.query(
      "UPDATE tasks SET brief = ?, resume_branch = ?, resume_ghost_branch = ?, resume_pr_url = ?, updated_at = ? WHERE id = ? AND resume_pr_url IS NULL"
    ).run(brief, resume.branch, resume.ghostBranch, resume.prUrl, now(), successor.id);
    if (!result.changes) continue;
    writeEvent(db, {
      task_id: successor.id,
      source,
      type: "resume_pr_backfilled",
      payload: { predecessor_task_id: predecessorId, pr_url: resume.prUrl },
    });
    broadcastTask(db, getTask(db, successor.id));
  }
}

// Create a fresh queued copy of a task (parent_task_id → the failed original).
// The lineage links let the recovery loop cap auto-requeues. When the failed
// attempt left a branch behind, an auto-generated RESUME section is prepended
// to the new task's brief (and the pointer recorded structurally on the row —
// see buildResumeSection) so a cold dispatch adopts the prior work instead of
// silently rebuilding it (hive-1090).
export function requeueTask(db: DB, source: any): string {
  if (isJiraMirror(source)) throw new TransitionError(TRACKING_ONLY_REQUEUE_ERROR);
  const fresh = getTask(db, source.id) ?? source;
  const id = newId();
  const t = now();
  const resume = buildResumeSection(db, fresh);
  const priorBrief = stripPriorResumeSection(fresh.brief);
  const brief = resume ? [resume.text, priorBrief].join("\n").trim() : (priorBrief || null);
  // The Jira link MOVES to the successor, it is not copied (hive-1872). A failed
  // row can never push a status (failed has no Jira meaning), so a link left
  // behind strands the issue forever while the successor that actually finishes
  // the work has nothing to close. Exactly one live task may own a key — the
  // unique index on (jira_key, jira_link_kind) enforces it — so the predecessor
  // is cleared first, in the same transaction as the insert.
  const jiraKey = fresh.jira_link_kind === "subtask" ? fresh.jira_key ?? null : null;
  db.transaction(() => {
    if (jiraKey)
      db.query("UPDATE tasks SET jira_key = NULL, jira_link_kind = NULL, updated_at = ? WHERE id = ?").run(t, fresh.id);
    db.query(
      `INSERT INTO tasks (id, project_id, title, brief, state, kind, source, parent_task_id, resume_branch, resume_ghost_branch, resume_pr_url, priority, jira_key, jira_link_kind, created_at, updated_at)
       VALUES (?,?,?,?, 'queued', ?, 'requeue', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id, fresh.project_id, fresh.title, brief || null, fresh.kind, fresh.id,
      resume?.branch ?? null, resume?.ghostBranch ?? null, resume?.prUrl ?? null,
      // The successor IS the same work, so it keeps the original's place in the
      // queue. Losing it would push a 'now' task to the back on every retry.
      fresh.priority ?? "normal", jiraKey, jiraKey ? "subtask" : null, t, t
    );
  })();
  writeEvent(db, { task_id: id, source: "reconciler", type: "created", payload: { title: fresh.title, requeue_of: fresh.id } });
  if (jiraKey)
    writeEvent(db, {
      task_id: id,
      source: "reconciler",
      type: "jira_link_moved",
      payload: { issue: jiraKey, from_task_id: fresh.id },
    });
  repointDependents(db, fresh.id, id, "reconciler");
  broadcastTask(db, getTask(db, id));
  // Re-broadcast the failed original: its earlier `failed` SSE frame predates
  // this successor, so clients still show it as awaiting triage without this.
  broadcastTask(db, getTask(db, fresh.id));
  return id;
}

// ---- root-cause scout on the second park ----
// One agent dying is bad luck. Two agents dying the same way is a fact about
// the task, and a third blind attempt is a third coin flip. So the park that
// follows a requeue also files ONE scout, with the corpse attached: every
// failed task id, its worktree, its pane-tail evidence, and its recovery
// timeline. Exactly one per lineage, ever — the marker event lives on the
// ORIGINAL task, so every later park in the chain finds it and stays quiet.
const RECOVERY_SCOUT_SOURCE = "recovery-scout";

// original → … → task, walking the source='requeue' parent chain.
function requeueLineage(db: DB, task: any): any[] {
  const chain: any[] = [];
  let cur: any = task;
  while (cur) {
    chain.unshift(cur);
    cur = cur.source === "requeue" && cur.parent_task_id ? getTask(db, cur.parent_task_id) : null;
  }
  return chain;
}

function recoveryScoutMarker(db: DB, originalId: string): { scout_task_id: string } | null {
  const row = db
    .query("SELECT payload FROM events WHERE task_id = ? AND type = 'scout_spawned' ORDER BY ts LIMIT 1")
    .get(originalId) as { payload: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.payload);
  } catch {
    return null;
  }
}

// Scouts hand off a kind='report' evidence row — that's what a later park links.
function recoveryScoutReport(db: DB, scoutTaskId: string): string | null {
  const row = db
    .query("SELECT url FROM evidence WHERE task_id = ? AND kind = 'report' ORDER BY ts DESC LIMIT 1")
    .get(scoutTaskId) as { url: string | null } | undefined;
  return row?.url ?? null;
}

function recoveryScoutBrief(db: DB, chain: any[]): string {
  const corpse = chain
    .map((t, i) => {
      const lines = [`Attempt ${i + 1} — task ${t.id} (state: ${t.state})`];
      if (t.worktree_path) lines.push(`  worktree: ${t.worktree_path}`);
      if (t.branch) lines.push(`  branch: ${t.branch}`);
      if (t.agent_target) lines.push(`  agent transcript: herdr agent read ${t.agent_target}`);
      lines.push(`  saved pane tails and other evidence: ${join(evidenceDir(), t.id)}`);
      const events = db
        .query(
          `SELECT ts, type, payload FROM events WHERE task_id = ?
             AND type IN ('stale','recovery','recovery_nudge','requeued','worktree_reclaimed','state_change')
           ORDER BY ts`
        )
        .all(t.id) as { ts: string; type: string; payload: string }[];
      for (const e of events) lines.push(`  ${e.ts}  ${e.type}  ${e.payload}`);
      return lines.join("\n");
    })
    .join("\n\n");
  return [
    `${chain.length} agents have now failed this same task. Find out why.`,
    ``,
    `Failed task ids: ${chain.map((t) => t.id).join(", ")}`,
    ``,
    `What each attempt left behind:`,
    ``,
    corpse,
    ``,
    `Agent transcripts also live under ~/.herdr/worktrees/<project>/<task-id> and in the herdr session logs for the agent targets above.`,
    ``,
    `Your ask: reproduce the failure, or explain it. Then recommend the one change that would make attempt ${chain.length + 1} succeed.`,
    `Report only. Change nothing: no code edits, no commits, no PR. Hand off with a report (hive emit <task-id> evidence --kind report --file report.md).`,
  ].join("\n");
}

// Returns the new scout's task id, or null when this park has not earned one
// (a single attempt so far) or the lineage already has its scout.
function spawnRecoveryScout(db: DB, task: any, chain: any[]): string | null {
  if (chain.length < 2) return null; // one failure is not yet a pattern
  if (recoveryScoutMarker(db, chain[0].id)) return null; // exactly one per lineage
  const id = newId();
  const t = now();
  const title = `Why does ${task.title} keep failing?`;
  db.query(
    `INSERT INTO tasks (id, project_id, title, brief, state, kind, source, parent_task_id, priority, created_at, updated_at)
     VALUES (?,?,?,?, 'queued', 'scout', ?, ?, ?, ?, ?)`
  ).run(
    id, task.project_id, title, recoveryScoutBrief(db, chain), RECOVERY_SCOUT_SOURCE, task.id,
    // The scout unblocks the lineage it was filed for, so it inherits that
    // lineage's urgency instead of queueing behind it.
    task.priority ?? "normal",
    t, t
  );
  writeEvent(db, { task_id: id, source: "reconciler", type: "created", payload: { title, recovery_scout_of: task.id } });
  writeEvent(db, {
    task_id: chain[0].id,
    source: "reconciler",
    type: "scout_spawned",
    payload: { scout_task_id: id, parked_task_id: task.id, failed_task_ids: chain.map((c) => c.id) },
  });
  broadcastTask(db, getTask(db, id));
  return id;
}

// Open the "recovery cap reached / agent unresponsive" decision card. A
// `recovery_card` event links it to the source task so answering `requeue`
// resolves to a fresh task (resolveRecoveryForDecision).
export function openRecoveryDecision(db: DB, task: any, attempts: number): any {
  const chain = requeueLineage(db, task);
  const scoutId = spawnRecoveryScout(db, task, chain);
  const marker = recoveryScoutMarker(db, chain[0].id);
  const reportUrl = marker ? recoveryScoutReport(db, marker.scout_task_id) : null;
  const scoutLine = reportUrl
    ? ` A root-cause scout already looked into this. Read its report before you decide: ${reportUrl} (task ${marker!.scout_task_id}).`
    : scoutId
      ? ` A root-cause scout (task ${scoutId}) is now digging into why this keeps failing. Its report will say what to change.`
      : marker
        ? ` Root-cause scout ${marker.scout_task_id} is already investigating this task; its report is not in yet.`
        : "";
  const decision = createDecision(db, {
    task_id: task.id,
    title: `Recover failed task: ${task.title}`,
    context:
      `The agent for this task could not be kept alive (auto-requeued ${attempts} time(s) without success). ` +
      `Requeue once more or abandon it?` + scoutLine,
    risk: "normal",
    blast_radius: `Task ${task.id} (${task.title}).`,
    options: [
      { key: "requeue", label: "Requeue once more", detail: "Create a fresh queued task and try again.", recommended: true },
      { key: "abandon", label: "Abandon", detail: "Leave the task failed." },
    ],
  });
  writeEvent(db, {
    task_id: task.id,
    source: "reconciler",
    type: "recovery_card",
    payload: {
      decision_id: decision.id,
      source_task_id: task.id,
      ...(marker ? { scout_task_id: marker.scout_task_id } : {}),
      ...(reportUrl ? { scout_report_url: reportUrl } : {}),
    },
  });
  return decision;
}

// The circuit breaker's ONE card. Raised when hive declares more agents dead in
// a short window than any real fleet loses — the signature of hive losing sight
// of herdr, not of agents dying (2026-08-19). Every teardown path stays paused
// while this card is open, so answering it IS the resume: no second switch.
// Attached to the task whose teardown was blocked, because a decision needs a
// task and that one is the concrete casualty the director can look at.
export function openBreakerDecision(db: DB, task: any, count: number, windowMinutes: number): any {
  const decision = createDecision(db, {
    task_id: task.id,
    title: `Paused recovery: ${count} agents declared dead in ${windowMinutes} min`,
    context:
      `Hive stopped failing and requeuing agents. ${count} death verdicts in ${windowMinutes} minutes usually means hive lost ` +
      `sight of herdr (a desktop-app restart wipes the agent registry while the agents keep running), not that the fleet died. ` +
      `Nothing was torn down and no tabs were closed. Check the herdr panes: if the agents are alive, resume and hive will re-adopt them.`,
    risk: "high",
    blast_radius: "All agent recovery and worktree/session reaping, fleet-wide.",
    options: [
      { key: "resume", label: "Resume recovery", detail: "Agents look fine (or really are gone) — turn sweeps back on.", recommended: true },
      { key: "checked", label: "Resume, I fixed herdr", detail: "Same effect; records that you intervened first." },
    ],
  });
  writeEvent(db, { task_id: task.id, source: "reconciler", type: "breaker_card", payload: { decision_id: decision.id, dead_count: count } });
  enqueue(db, {
    kind: "circuit_breaker",
    urgency: "urgent",
    task_id: task.id,
    decision_id: decision.id,
    title: `Recovery paused: ${count} agents declared dead in ${windowMinutes} min`,
    body: "Nothing was torn down. Check the herdr panes, then answer the card to resume.",
  });
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
  const card = recoveryCardForDecision(db, decisionId);
  if (!card) return false;
  if (answerKey !== "requeue") return true;
  const source = getTask(db, card.source_task_id);
  if (source) {
    const newId = requeueTask(db, source);
    // Every other requeue path writes this, and the board walks it forward to
    // find the live successor. Without it a recovered task looks dead forever
    // (hive-1872) even though its successor finished the work.
    writeEvent(db, { task_id: source.id, source: "director", type: "requeued", payload: { new_task_id: newId, reason: "recovery decision" } });
  }
  return true;
}

function recoveryCardForDecision(db: DB, decisionId: string): { source_task_id: string } | null {
  const ev = db
    .query("SELECT payload FROM events WHERE type = 'recovery_card' AND json_extract(payload, '$.decision_id') = ? ORDER BY ts DESC LIMIT 1")
    .get(decisionId) as { payload: string } | undefined;
  return ev ? JSON.parse(ev.payload) : null;
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
// (task #904: a routine watcher-summary auto-spawned a bogus
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
  const sourceTask = row.source_task_id ? getTask(db, row.source_task_id) : null;
  if (body.create_root_cause_task && sourceTask && isTrackingOnlyTask(sourceTask))
    return err(TRACKING_ONLY_OWNERSHIP_ERROR, 409);
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
  return json({ notifications: rows, unread, last_delivery_error: lastDeliveryError() });
}

// POST /api/notifications/test — fire one real urgent notification down the
// same path a decision uses, so the whole chain can be checked without waiting
// for a real event. The caller polls GET /api/notifications for delivered_at:
// the desktop app sets it only after macOS actually rendered the notification.
function testNotification(db: DB): Response {
  const row = enqueue(db, {
    kind: "test",
    urgency: "urgent",
    title: "hive test notification",
    body: "If you can see this, native notifications work. Clicking it opens hive.",
  });
  return json({ id: row.id, app_clients: appClientCount() }, 201);
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
  const provider = body.provider ?? "keychain";
  const name = String(body.name);
  const row = {
    id: newId("sec"),
    project_id: projectId,
    name,
    provider: String(provider),
    // Derived, never taken from the caller: a client-supplied ref is used
    // verbatim as the keychain service / bitwarden item name, so accepting one
    // would let any caller alias an arbitrary item on the machine and have
    // resolveProjectSecrets hand out its value. Providers' set() computes the
    // same thing, so the value written is always the one this ref resolves.
    ref: serviceName(projectId, name),
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

// hive-487: does `prUrl` still carry a `hive-task:` marker (or `[hive-<n>]`
// title prefix) naming one of `ids`? Used to gate resume-pointer adoption at
// dispatch time — the one place a stale/migrated pr_url would otherwise get
// silently trusted just because nothing marked it closed.
async function resumePointerMarkerHolds(db: DB, exec: Exec, ids: string[], prUrl: string): Promise<boolean> {
  try {
    const r = await exec(["gh", "pr", "view", prUrl, "--json", "title,body"]);
    if (r.code !== 0) return false;
    const data = JSON.parse(r.stdout);
    const bodyId = taskIdFromBody(data.body);
    if (bodyId) return ids.includes(bodyId);
    const titleNumber = taskNumberFromTitle(data.title);
    if (titleNumber == null) return false;
    const placeholders = ids.map(() => "?").join(",");
    return !!db.query(`SELECT 1 FROM tasks WHERE id IN (${placeholders}) AND number = ?`).get(...ids, titleNumber);
  } catch {
    return false;
  }
}

async function prHeadBranch(exec: Exec, prUrl: string): Promise<string | null> {
  try {
    const result = await exec(["gh", "pr", "view", prUrl, "--json", "headRefName"]);
    if (result.code !== 0) return null;
    const branch = JSON.parse(result.stdout)?.headRefName;
    return isSafeRef(branch) ? branch : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- event ingestion (`hive emit`)
async function ingestEvent(db: DB, taskId: string, req: Request, deps: HandlerDeps = {}): Promise<Response> {
  const task = getTask(db, taskId);
  if (!task) return err("task not found", 404);
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
  if (isTrackingOnlyTask(task) && ["needs-decision", "done", "ready", "unmergeable"].includes(type))
    return err("tracking-only tasks do not accept agent lifecycle events", 409);
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
    if (servedUrl && !resolveEvidenceUrl(servedUrl)) return err("evidence url must be a valid HTTP(S) URL or path", 400);
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
    // `--verify-name <name>` ties this artifact back to one entry of the task's
    // verification contract. Recorded on the event; nothing is gated on it yet.
    const verifyName = String(fields.verify_name ?? "").trim() || null;
    const event = writeEvent(db, {
      task_id: taskId,
      source,
      type: "evidence",
      payload: { evidence_id: ev.id, kind, caption: ev.caption, ...(verifyName ? { verify_name: verifyName } : {}) },
    });
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
    const reportOnlySelfAudit = isSelfAuditLineage(db, t) && t.kind === "ship" && t.state === "in_progress" && !t.pr_url && evidenceCount(db, taskId, "report") > 0;
    const task = transition(db, taskId, "done", { source, reason: note ?? undefined, force: reportOnlySelfAudit });
    return json({ task });
  }

  // --- unmergeable (HIVE-314: this task's own PR has nothing left to merge,
  // e.g. GitHub refuses reopenPullRequest because head==base, but the work
  // already landed via a different PR/commit). The agent points at the commit
  // that actually carries the work; hive verifies it against the base branch
  // before granting a terminal 'done' without going through the normal
  // in_review -> verifying merge step.
  if (type === "unmergeable") {
    const landingCommit = String(fields.landing_commit ?? fields.commit_sha ?? "").trim();
    if (!/^[0-9a-f]{7,40}$/i.test(landingCommit))
      return err("unmergeable needs a 'landing_commit' git SHA (7-40 hex chars) that actually carries the work", 400);
    const t = getTask(db, taskId);
    const blocked = authzBlock(db, { project_id: t.project_id, action: "task.done", target: t.title, task_id: taskId });
    if (blocked) return blocked;
    if (!t.pr_url || !["in_review", "verifying"].includes(t.state))
      return err("unmergeable requires a linked PR and a task in review or verifying", 409);
    const project: any = db.query("SELECT * FROM projects WHERE id = ?").get(t.project_id);
    if (!project?.repo_path) return err("project has no repo_path to verify the landing commit against", 400);
    const config = JSON.parse(project.config ?? "{}");
    const baseBranch = projectBaseBranch(config);
    const base = projectComparisonBase(config);
    const fetched = await exec(["git", "-C", project.repo_path, "fetch", "origin", baseBranch]);
    if (fetched.code !== 0) return err(`could not fetch ${baseBranch}; landing commit was not verified`, 409);
    const check = await exec(["git", "-C", project.repo_path, "merge-base", "--is-ancestor", landingCommit, base]);
    if (check.code !== 0)
      return err(
        `landing_commit ${landingCommit} could not be verified as an ancestor of ${base}; cannot confirm the work actually landed`,
        409
      );
    if (note) writeEvent(db, { task_id: taskId, source, type: "note", payload: { note } });
    writeEvent(db, { task_id: taskId, source, type: "unmergeable", payload: { landing_commit: landingCommit, base, note: note ?? null } });
    if (note) db.query("UPDATE tasks SET summary = ? WHERE id = ?").run(note, taskId);
    try {
      const task = transition(db, taskId, "done", {
        source,
        reason: note ?? `unmergeable: work landed via ${landingCommit}, verified on ${base}`,
        force: true,
      });
      return json({ task });
    } catch (e: any) {
      return err(e.message ?? "could not close task", 409);
    }
  }

  // --- ready (agent handoff: PR open / report written → into the review queue) ---
  // The explicit, preferred counterpart to the reconciler's advanceFinished
  // backstop: an agent that has opened its PR (or written its scout report) emits
  // this to hand off for review instead of just going idle. Records or replaces
  // pr_url when supplied, then advances in_progress → in_review.
  if (type === "ready") {
    const t = getTask(db, taskId);
    const prUrl = (fields.pr_url ?? fields.url ?? null) as string | null;
    // The agent's explicit handoff is AUTHORITATIVE about which PR carries the
    // work — including when it replaces an earlier PR (closed #161 → rebased
    // #166, task #90). The old `only if unlinked` guard silently ignored the
    // new url, so every merge kept hitting the closed PR in a loop. ci_status
    // and head_sha reset because they described the old PR. Refresh branch too:
    // the destructive-rebase guard and cleanup must inspect the replacement
    // PR's head, not the stale branch from the rejected attempt.
    if (prUrl && prUrl !== t.pr_url) {
      const branch = await prHeadBranch(exec, prUrl);
      db.query("UPDATE tasks SET pr_url = ?, branch = COALESCE(?, branch), ci_status = NULL, head_sha = NULL, updated_at = ? WHERE id = ?").run(
        prUrl,
        branch,
        now(),
        taskId
      );
      writeEvent(db, {
        task_id: taskId,
        source,
        type: "pr_linked",
        payload: {
          pr_url: prUrl,
          via: t.pr_url ? "ready_replaced" : "ready",
          ...(t.pr_url ? { replaced: t.pr_url } : {}),
          ...(branch ? { branch } : {}),
        },
      });
    } else if (prUrl) {
      const branch = await prHeadBranch(exec, prUrl);
      if (branch && branch !== t.branch) {
        db.query("UPDATE tasks SET branch = ?, updated_at = ? WHERE id = ?").run(branch, now(), taskId);
        writeEvent(db, {
          task_id: taskId,
          source,
          type: "pr_branch_refreshed",
          payload: { pr_url: prUrl, branch, replaced: t.branch },
        });
      }
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
        const probe = await exec(["gh", "pr", "view", pr, "--json", "statusCheckRollup,baseRefOid"]);
        if (probe.code === 0) {
          try {
            const view = JSON.parse(probe.stdout || "{}");
            ci = await ciStatusProbed(exec, view.statusCheckRollup, view.baseRefOid ?? null);
          } catch {
            ci = null;
          }
        }
        db.query("UPDATE tasks SET ci_checked_at = ? WHERE id = ?").run(now(), taskId);
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
                : `CI is still running on ${pr}. End this turn; hive monitors the checks, hands off automatically when they pass, and steers you if they fail.`,
          });
        }
      }
      // Explanation gate (#1249). CI is green by here; the last thing review
      // waits on is the page that explains the change. Generation runs in the
      // background and hands the task off itself when the page is stored, so
      // the agent stays on the task meanwhile instead of going idle.
      if (explanationGate(db, getTask(db, taskId), { exec, plannerExec: deps.plannerExec }) !== "ready") {
        writeEvent(db, { task_id: taskId, source, type: "ready_held", payload: { pr_url: pr ?? null, reason: "explanation_pending" } });
        broadcastTask(db, getTask(db, taskId));
        return json({
          held: true,
          reason: "explanation_pending",
          message:
            "Handoff held: hive is writing the explanation page for this PR. Stay on the task — it moves to review by itself when the page is ready (usually a few minutes).",
        });
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

  // --- transcript + lifecycle (from the Claude Code / Codex hooks) ---
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
    if (type === "tool_use") {
      try {
        checkUsageGuardrails(db, taskId);
      } catch (e) {
        console.error("[hive] usage guardrails:", e);
      }
    }
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
      const deduped = v ? dropRepeats(v) : undefined;
      if (deduped?.length) payload[k] = deduped;
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
        const walkthrough = dropRepeats(rawUnderstanding.walkthrough.map((value: unknown) => text(value)).filter(Boolean)).slice(0, 4);
        if (walkthrough.length) understanding.walkthrough = walkthrough;
      }
      if (Array.isArray(rawUnderstanding.affected_areas)) {
        const affectedAreas = dropRepeats(rawUnderstanding.affected_areas.map((value: unknown) => text(value)).filter(Boolean)).slice(0, 5);
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
      const checks = dropRepeats<{
        question: string;
        options: UnderstandingCheck["options"];
        answer_key: string;
        explanation?: string;
      }>(
        rawChecks.flatMap((value: unknown) => {
          const check = normalizeUnderstandingCheck(value);
          return check ? [{
            question: check.question,
            options: check.options,
            answer_key: check.answerKey,
            ...(check.explanation ? { explanation: check.explanation } : {}),
          }] : [];
        }),
        (check) => recurrenceKey(check.question)
      ).slice(0, 5);
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
    const understandingChecks = (payload.understanding as any)?.checks
      ?? ((payload.understanding as any)?.check ? [(payload.understanding as any).check] : []);
    if (understandingChecks.some(isEgregiousCheckWording))
      queueSteerEvent(
        db,
        taskId,
        "Your understanding-quiz wording is egregiously long (a question over ~400 chars or an option over ~150). Tighten the wording: plain everyday words, one idea per sentence, no nested clauses.",
        "egregious quiz wording"
      );
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

  // --- checkpoint ---
  // Ordinary checkpoints are plain notes and fall through to the generic path.
  // A PLAN checkpoint (HIVE-412) carries structured fields, which are kept on
  // the payload and critiqued in the background — the agent gets its 201 now and
  // hears about any concern as a steer.
  if (type === "checkpoint") {
    const plan = parsePlan(fields);
    if (plan) {
      // Blocking mode (HIVE-413): the marker rides on the payload, so an ack
      // knows to release the agent even if the project config changes later.
      const project: any = db.query("SELECT config FROM projects WHERE id = ?").get(task.project_id);
      const blocking = planGateBlocks(JSON.parse(project?.config ?? "{}"), task.kind);
      const event = writeEvent(db, {
        task_id: taskId,
        source,
        type,
        payload: { note: note ?? plan.goal, ...plan, ...(blocking ? { blocking: true } : {}) },
      });
      const herdr = deps.herdr ?? defaultHerdr;
      critiquePlan(db, task, event.id, plan, {
        plannerExec: deps.plannerExec,
        steer: (id, message) => internalSteer(db, herdr, id, message),
      }).catch((e) => console.error(`[hive] plan critic for ${taskId}:`, e));
      return json({ event }, 201);
    }
  }

  // --- status / blocked / generic ---
  // A checkpoint may carry flag:true — the agent marking its own note as one
  // the director must actually see. Flagged checkpoints never auto-expire.
  const event = writeEvent(db, {
    task_id: taskId,
    source,
    type,
    payload: type === "checkpoint" && fields.flag ? { note, flag: true } : { note },
  });
  if (type === "status" && typeof note === "string" && note.trim() && task.jira_key && task.jira_link_kind === "subtask"
    && jiraConfigStatusFor(db, task.project_id).config?.status_notes_to_comments === true) {
    writeEvent(db, {
      task_id: taskId,
      source,
      type: "jira_comment",
      payload: { direction: "outbound", text: note.trim(), status_event_id: event.id },
    });
  }
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
  // Usage lands here per turn, so token and dollar guardrails check the current
  // cumulative session totals at the same boundary.
  try {
    checkUsageGuardrails(db, taskId);
  } catch (e) {
    console.error("[hive] usage guardrails:", e);
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
    task_display_id: taskIdentifier(db, task),
    ci: ciFreshness(db, task, decisionId),
    pr_url: task.pr_url ?? null,
    branch: task.branch ?? null,
    spend_usd: +taskSpend(db, taskId).toFixed(2),
    prior_decisions: prior,
  };
}

// Freshness for a card that cites CI: what it cited, what the checks say NOW,
// and when hive last looked. Rendered on the card so nobody has to guess whether
// the facts in front of them are still true.
function ciFreshness(db: DB, task: any, decisionId: string): any {
  const d: any = db.query("SELECT ci_status_at_card, ci_signal FROM decisions WHERE id = ?").get(decisionId);
  if (!d?.ci_status_at_card) return null;
  // Blocked by an infra outage: name the task hive already dispatched to fix
  // the signal, so the answer reads as one ruling for every PR it hits.
  const fixer: any = d.ci_signal
    ? db.query(`SELECT number FROM tasks WHERE brief LIKE ? AND state NOT IN ('done','failed','cancelled') ORDER BY created_at DESC LIMIT 1`)
        .get(`%ci-signal: ${d.ci_signal}%`)
    : null;
  return {
    at_card: d.ci_status_at_card,
    status: task.ci_status ?? null,
    checked_at: task.ci_checked_at ?? null,
    changed: (task.ci_status ?? null) !== d.ci_status_at_card,
    outage: d.ci_signal ? { signal: d.ci_signal, fix_task_number: fixer?.number ?? null } : null,
  };
}

// Attach the derived bundle (and, for planner-breakdown cards, the structured
// plan) to a parsed decision. Cheap enough to run on every open card at
// fetch/broadcast time; skipped implicitly for terminal cards that callers
// never pass here.
export function withBundle(db: DB, d: any): any {
  return { ...d, bundle: decisionBundle(db, d.task_id, d.id), plan: decisionPlan(db, d.task_id, d.id) };
}

// A card "cites CI" when the task's checks are actually not passing AND the
// card's own words are about them. The status is the gate: the words alone
// match ordinary English ("keep the red icon", "add a permission check"), and
// mislabelling a card as CI-related would let it be auto-dismissed or
// auto-answered by an unrelated outage.
const CITES_CI = /\bCI\b|\bchecks?\b|\bred\b|\bfailing\b|\bgreen\b/i;
const CI_BLOCKED = new Set(["failing", "unavailable"]);

// What the CI signal looked like when a card was written: the status it cited,
// and the infra-outage signal (from the reconciler's ci_infra event for the
// PR's current head) that was blocking it, if any.
function ciCitation(db: DB, task: any, text: string): { status: string | null; signal: string | null } {
  if (!task?.pr_url || !CI_BLOCKED.has(task.ci_status ?? "") || !CITES_CI.test(text)) return { status: null, signal: null };
  const row: any = db
    .query("SELECT payload FROM events WHERE task_id = ? AND type = 'ci_infra' ORDER BY rowid DESC LIMIT 1")
    .get(task.id);
  let signal: string | null = null;
  if (row && task.ci_status === "unavailable") {
    try {
      const p = JSON.parse(row.payload);
      if (!p.head_sha || !task.head_sha || p.head_sha === task.head_sha) signal = p.signal ?? null;
    } catch {}
  }
  return { status: task.ci_status ?? null, signal };
}

// The director rules ONCE per outage. A later card blocked by the same signal
// inherits that answer instead of interrupting again — but only if the answer
// is one of this card's own options, otherwise the inherited key would be
// meaningless here.
function standingCiRuling(db: DB, projectId: string, signal: string, options: any[]): { key: string; note: string } | null {
  // The ruling holds only while the outage does. hive tracks the outage as one
  // diagnostic task; once that task is closed, the next card asks again.
  if (!infraTaskOpen(db, projectId, signal)) return null;
  const prior: any = db
    .query(
      `SELECT dc.id, dc.answer_key, dc.answer_note, dc.answered_at, dc.title FROM decisions dc
         JOIN tasks t ON t.id = dc.task_id
        WHERE t.project_id = ? AND dc.ci_signal = ? AND dc.status = 'answered' AND dc.answer_key IS NOT NULL
        ORDER BY dc.answered_at DESC LIMIT 1`
    )
    .get(projectId, signal);
  if (!prior) return null;
  if (!options.some((o: any) => o.key === prior.answer_key)) return null;
  return {
    key: prior.answer_key,
    note:
      `Answered automatically: you already ruled on this exact CI outage ("${prior.title}") and that ruling still stands. ` +
      `The same checks block this PR, and nothing about them has changed.` + (prior.answer_note ? ` Your note then: ${prior.answer_note}` : ""),
  };
}

export function createDecision(
  db: DB,
  d: {
    task_id: string;
    title: string;
    context?: string | null;
    risk?: string | null;
    blast_radius?: string | null;
    options?: any[];
    // Set this on a card only the director may ever answer. Every auto-answer
    // path refuses a classed card (see NO_AUTO_ANSWER_REASON in autoapprove.ts).
    decision_class?: string | null;
  }
): any {
  if (!getTask(db, d.task_id)) throw new Error("unknown task_id");
  const options = Array.isArray(d.options) && d.options.length ? d.options : DEFAULT_OPTIONS;
  const cited = ciCitation(db, getTask(db, d.task_id), `${d.title}\n${d.context ?? ""}`);
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
    ci_status_at_card: cited.status,
    ci_signal: cited.signal,
    decision_class: d.decision_class ?? null,
  };
  db.query(
    `INSERT INTO decisions (id, task_id, ts, title, context, risk, blast_radius,
      options, status, answer_key, answer_note, draft_note, answered_at, ci_status_at_card, ci_signal, decision_class)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    row.id, row.task_id, row.ts, row.title, row.context, row.risk,
    row.blast_radius, row.options, row.status, row.answer_key, row.answer_note,
    row.draft_note, row.answered_at, row.ci_status_at_card, row.ci_signal, row.decision_class
  );
  writeEvent(db, { task_id: d.task_id, source: "agent", type: "needs-decision", payload: { decision_id: row.id, title: row.title } });
  // Move task into needs_decision only from in_progress — an agent mid-work
  // raising a card. A queued task (e.g. a dispatcher-raised repo-mismatch card)
  // holds dispatch via the open-decision check itself (repoMismatchUnresolved)
  // and must stay 'queued', not jump to needs_decision, which now also reaches
  // from queued via the director's own explicit park action (hive-1264 gap A) —
  // that path is deliberate and director-only, so it must not fire here too.
  const task = getTask(db, d.task_id);
  if (task.state === "in_progress") {
    transition(db, d.task_id, "needs_decision", { source: "agent", reason: row.title });
  }
  // Same outage, same ruling: answer it now with what the director already
  // decided, and do NOT notify — a second identical question is the interruption
  // this exists to remove.
  // A classed card is never answered by automation, this standing ruling
  // included — the director has to see it.
  const ruling =
    row.ci_signal && !row.decision_class ? standingCiRuling(db, task.project_id, row.ci_signal, options) : null;
  if (ruling) {
    const res = apiAnswerDecision(db, defaultHerdr, row.id, {
      answer_key: ruling.key,
      answer_note: ruling.note,
      source: "system",
      actor: "ci-outage-ruling",
    });
    // If the auto-answer failed the card is still open — fall through and
    // notify, rather than leaving an orphan nobody was told about.
    if (res.ok) return withBundle(db, parseDecision(db.query("SELECT * FROM decisions WHERE id = ?").get(row.id)));
  }
  // Enrich AFTER the transition so the bundle's spend/PR reflect current state.
  const decision = withBundle(db, parseDecision(row));
  broadcast({ type: "decision", decision });
  // Every open decision parks an agent until the director answers it, so all of
  // them are urgent. They used to batch unless risk was "high", which meant the
  // common case waited up to HIVE_DIGEST_MS for a summary line.
  enqueue(db, {
    kind: "decision",
    task_id: d.task_id,
    decision_id: row.id,
    title: `Decision needed: ${row.title}`,
    body: row.blast_radius ?? row.context ?? undefined,
    urgency: "urgent",
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
  const includeTest = url.searchParams.get("test") === "all";
  const where: string[] = [];
  const args: any[] = [];
  if (status !== "all") { where.push("d.status = ?"); args.push(status); }
  if (projectId) { where.push("t.project_id = ?"); args.push(projectId); }
  // Decisions under a test/ephemeral project (see testProjects.ts) are hidden
  // from director surfaces by default, same as the project itself.
  if (!includeTest) where.push(notTestProjectSql("p.config"));
  const sql =
    "SELECT d.* FROM decisions d JOIN tasks t ON t.id = d.task_id JOIN projects p ON p.id = t.project_id" +
    (where.length ? " WHERE " + where.join(" AND ") : "") +
    " ORDER BY d.ts DESC";
  const rows = db.query(sql).all(...args);
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

function closedDecisionResponse(db: DB, r: any): Response | null {
  if (r.status === "open") return null;
  const resolutionRow: any = db
    .query(
      `SELECT * FROM events WHERE task_id = ? AND type IN ('decision_answered', 'decision_expired')
        AND json_extract(payload, '$.decision_id') = ? ORDER BY rowid DESC LIMIT 1`
    )
    .get(r.task_id, r.id);
  const event = resolutionRow ? parseEvent(resolutionRow) : null;
  const options: any[] = JSON.parse(r.options || "[]");
  const answerLabel = options.find((option) => option.key === r.answer_key)?.label ?? r.answer_key ?? null;
  return staleResponse(`decision already ${r.status}`, {
    status: r.status,
    source: r.answered_by ?? event?.source ?? "unknown",
    actor: r.answered_actor ?? event?.payload?.actor ?? null,
    at: r.answered_at ?? event?.ts ?? null,
    answer_key: r.answer_key ?? null,
    answer_label: answerLabel,
    answer_note: r.answer_note ?? null,
    reason: event?.payload?.reason ?? null,
  });
}

// Someone answered a card that is already answered, and picked a DIFFERENT
// option. That is a disagreement with whoever answered first — the signal the
// agreement metric in autonomyStats.ts counts. The answer itself is still
// refused (an answered card stays answered); this only records that it happened,
// once, carrying who answered first so auto-answers can be told from human ones.
function recordContradiction(db: DB, decision: any, body: any): void {
  const answerKey = body?.answer_key;
  if (!answerKey || decision.status !== "answered" || answerKey === decision.answer_key) return;
  const already = db
    .query(
      `SELECT 1 FROM events WHERE task_id = ? AND type = 'decision_contradicted'
        AND json_extract(payload, '$.decision_id') = ? LIMIT 1`
    )
    .get(decision.task_id, decision.id);
  if (already) return;
  // Identity is not validated yet on this path (the answer is refused, not
  // applied), so clamp it rather than writing an arbitrary caller string.
  const claimed = body?.source ?? "unknown";
  const source = ANSWER_SOURCES.includes(claimed) ? claimed : "unknown";
  writeEvent(db, {
    task_id: decision.task_id,
    source,
    type: "decision_contradicted",
    payload: {
      decision_id: decision.id,
      prior_answer_key: decision.answer_key,
      prior_source: decision.answered_by ?? "unknown",
      attempted_answer_key: answerKey,
      source,
      actor: actorOf(body),
    },
  });
}

export function apiAnswerDecision(db: DB, herdr: Herdr, id: string, body: any, supervisorVerified = false): Response {
  const r: any = db.query("SELECT * FROM decisions WHERE id = ?").get(id);
  if (!r) return err("decision not found", 404);
  const closed = closedDecisionResponse(db, r);
  if (closed) {
    recordContradiction(db, r, body);
    return closed;
  }
  const answerKey = body?.answer_key;
  if (!answerKey) return err("answer_key is required");
  const options: any[] = JSON.parse(r.options || "[]");
  if (options.length && !options.some((o) => o.key === answerKey))
    return err(`answer_key '${answerKey}' is not one of the options`, 400);
  const bodyError = decisionAnswerBodyError(body);
  if (bodyError) return err(bodyError, 400);
  const submittedAnswerNote = body?.answer_note;
  const answerNote = submittedAnswerNote ?? r.draft_note ?? null;
  const wedged = dependentsWedgedForDecision(db, id);
  let successorId: string | null = null;
  if (wedged && answerKey === "repoint") {
    const successor = getTask(db, String(answerNote ?? "").trim());
    if (!successor) return err("repoint requires a valid successor task ID in the answer note", 400);
    if (["failed", "cancelled"].includes(successor.state)) return err("repoint successor must not be failed or cancelled", 400);
    if (wedged.dependentTaskIds.some((dependentId) => dependsTransitivelyOn(db, successor.id, dependentId)))
      return err("repoint would create a dependency cycle", 400);
    successorId = successor.id;
  }

  // Caller identity. A missing source is NOT assumed to be the director — the
  // web UI now sends source:"director" explicitly, so a bare call is a caller
  // we cannot vouch for ("unknown"). A present-but-invalid source is rejected.
  const answeredBy = body?.source ?? "unknown";
  if (!ANSWER_SOURCES.includes(answeredBy))
    return err(`source '${answeredBy}' is not one of ${ANSWER_SOURCES.join("|")}`, 400);
  const answeredActor = actorOf(body);
  // Backstop for the classed cards. The sweeps that could reach here are gated
  // at their own source too, so this only ever fires on a new automated caller
  // — which is exactly when we want it to.
  if (r.decision_class && (answeredBy === "system" || answeredBy === "chat_supervisor"))
    return json({ effect: "escalate", category: String(r.decision_class), reason: NO_AUTO_ANSWER_REASON }, 403);
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
  if (plan && answerKey === "approve" && isTrackingOnlyTask(getTask(db, r.task_id) ?? {}))
    return err(TRACKING_ONLY_OWNERSHIP_ERROR, 409);
  const recoveryCard = answerKey === "requeue" ? recoveryCardForDecision(db, id) : null;
  const recoverySource = recoveryCard ? getTask(db, recoveryCard.source_task_id) : null;
  if (recoverySource && isJiraMirror(recoverySource))
    return err(TRACKING_ONLY_REQUEUE_ERROR, 409);
  const selectedIndices = body?.selected_indices;
  if (plan && answerKey === "approve" && selectedPlanIndices(plan.proposed_tasks.length, selectedIndices).length === 0)
    return err("Cannot approve a planner breakdown with no tasks; answer 'reject' instead.", 400);

  const answeredAt = now();
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
    resolveUsageCapForDecision(db, id, answerKey),
    resolveScopeDriftForDecision(db, id, answerKey),
    resolveGardenerDecision(db, id, answerKey),
    resolveRefCaptureForDecision(db, id, answerKey, answerNote),
    resolveDependentsWedgedForDecision(db, id, answerKey, successorId, answeredBy),
    resolveLandPauseForDecision(db, id, answerKey),
    resolveIntakeTriageForDecision(db, id, answerKey, answerNote),
    resolveServingFollowForDecision(db, id, answerKey),
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
  const closed = closedDecisionResponse(db, r);
  if (closed) return closed;
  const answerKey = body?.answer_key;
  const actor = actorOf(body);
  if (!answerKey) return err("answer_key is required");
  const bodyError = decisionAnswerBodyError(body);
  if (bodyError) return err(bodyError, 400);

  const task = getTask(db, r.task_id);
  if (projectAutonomyProfile(db, task?.project_id ?? null) === "conservative") {
    writeEvent(db, {
      task_id: r.task_id,
      source: "chat_supervisor",
      type: "auto_approve_declined",
      payload: { decision_id: id, answer_key: answerKey, category: "autonomy", reason: "project autonomy is conservative; decision requires the director", actor },
    });
    return json({ effect: "escalate", category: "autonomy", reason: "project autonomy is conservative; decision requires the director" }, 403);
  }

  const verdict = evaluateAutoApprove(db, r, answerKey);
  if (!verdict.allow) {
    writeEvent(db, {
      task_id: r.task_id,
      source: "chat_supervisor",
      type: "auto_approve_declined",
      payload: { decision_id: id, answer_key: answerKey, category: verdict.category, reason: verdict.reason, actor },
    });
    return json({ effect: "escalate", category: verdict.category, reason: verdict.reason }, 403);
  }

  // Audit FIRST (who + why), so the record survives even if the answer path
  // below throws. The supervisor's own note, if any, rides alongside the reason.
  writeEvent(db, {
    task_id: r.task_id,
    source: "chat_supervisor",
    type: "auto_approved",
    payload: { decision_id: id, answer_key: answerKey, category: verdict.category, reason: verdict.reason, note: body?.answer_note ?? null, actor },
  });
  return apiAnswerDecision(db, herdr, id, { ...body, source: "chat_supervisor" }, true);
}

// Dismiss: clear a card without answering it (human escape hatch for a card with
// no usable options, or one that's simply no longer relevant). Expires it and
// broadcasts so the inbox clears live. No resolver hooks fire — dismissing is
// explicitly "take no action".
export function apiDismissDecision(db: DB, id: string, moot?: { reason: string; steer: string }): Response {
  const r: any = db.query("SELECT * FROM decisions WHERE id = ?").get(id);
  if (!r) return err("decision not found", 404);
  if (r.status !== "open") return err(`decision already ${r.status}`, 409);
  const source = moot ? "reconciler" : "director";
  db.query("UPDATE decisions SET status = 'expired' WHERE id = ?").run(id);
  writeEvent(db, { task_id: r.task_id, source, type: "decision_expired", payload: { decision_id: id, reason: moot?.reason ?? "dismissed" } });
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
        moot ? moot.steer :
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
    transition(db, r.task_id, "in_progress", { source, reason: moot?.reason ?? "last open decision dismissed" });
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
// ?client=app marks the desktop client. ?project=<id> drops frames belonging to
// other projects (frames with no project scope always pass). ?classes=decision,event
// drops every other frame type. No params = every frame, which is what the web
// UI subscribes with.
export function sseStream(params: URLSearchParams = new URLSearchParams()): Response {
  const project = params.get("project");
  const classList = (params.get("classes") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  let self: { id: string; send: (d: string) => void; app?: boolean; project?: string | null; classes?: Set<string> | null };
  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      self = {
        id: newId(),
        send: (data: string) => controller.enqueue(enc.encode(`data: ${data}\n\n`)),
        app: params.get("client") === "app",
        project,
        classes: classList.length ? new Set(classList) : null,
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
