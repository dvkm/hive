// Hive decides, the director rules (director, 2026-09-23).
//
// Every open decision card first goes to an advisor pass, the step the director
// used to do by hand by handing each card to another agent. Reversible
// engineering and process calls hive answers itself with the raiser's
// recommended option, and the digest reports them. Product judgment and
// authority calls reach the director with one line saying why, and never time
// out. A card the advisor cannot judge goes to the director too.
//
// A Jira ask that still has open questions after hive read the code goes to the
// person who filed the ticket first; the director sees it only if their reply
// still leaves something to decide.
import type { DB } from "./db.ts";
import { now } from "./db.ts";
import { getTask, writeEvent } from "./state.ts";
import { broadcast } from "./bus.ts";
import { enqueue } from "./notifications.ts";
import { optionNeedsDirectorInput, riskLevel } from "./policy.ts";
import { notTestProjectSql } from "./testProjects.ts";
import { getIntent, openQuestions, type Intent } from "./intents.ts";
import { askedReporterAt, investigationDue, investigatorOn, mirrorOf, reporterReplyAt } from "./intentInvestigate.ts";
import { jiraConfigFor } from "./intake/jira.ts";
import { claudeBin, defaultPlannerExec, parseModelJson, type PlannerExec } from "./planner.ts";
import { claudeProfileEnvForRepo } from "./claudeProfiles.ts";
import { modelFailure, noteModelCall } from "./modelCall.ts";
import { startLoop } from "./loop.ts";

const MODEL = process.env.HIVE_ADVISOR_MODEL || "sonnet";
const TIMEOUT_MS = 120_000;
// A card the advisor has not judged in this long is shown to the director
// anyway, so a stalled advisor can never hide a question.
const JUDGE_GRACE_MS = 10 * 60 * 1000;
// Same bound for an ask hive is still reading the code for.
const INVESTIGATE_GRACE_MS = 30 * 60 * 1000;

export function advisorOn(): boolean {
  return process.env.HIVE_ADVISOR !== "0";
}

export interface AdvisorDeps {
  // Answer a card as hive. True when the answer was recorded.
  answer: (decisionId: string, answerKey: string, note: string) => boolean | Promise<boolean>;
  // Re-send a card to every open screen once it has been judged.
  publish?: (decisionId: string) => void;
  exec?: PlannerExec;
  model?: string;
  intervalMs?: number;
}

export interface Advice {
  owner: "hive" | "director";
  pick: string | null;
  why: string;
}

// Cards that are the director's by rule, before any model reads them: a class
// reserved for a person, a high-risk rating, a standing-authority grant, and
// the "this keeps failing" cards hive raises after its own retries ran out.
function directorOnly(db: DB, d: { id: string; decision_class?: string | null; risk?: string | null; options?: unknown }): string | null {
  if (d.decision_class) return "Only you can answer this kind of question.";
  if (riskLevel(d.risk) === "high") return "The risk on this one is high.";
  let options: any[] = [];
  try {
    options = Array.isArray(d.options) ? d.options : JSON.parse(String(d.options ?? "[]"));
  } catch {
    options = [];
  }
  const recommended = options.find((o) => o?.recommended);
  if (recommended && optionNeedsDirectorInput(recommended)) return "The recommended answer needs something only you can supply.";
  if (db.query("SELECT 1 FROM authority_grants WHERE decision_id = ? LIMIT 1").get(d.id)) return "It asks for permission to run something risky.";
  const raised = db
    .query("SELECT type FROM events WHERE type IN ('recovery_card', 'breaker_card') AND json_extract(payload, '$.decision_id') = ? LIMIT 1")
    .get(d.id) as { type: string } | undefined;
  if (raised) return "Hive already retried this and it keeps failing.";
  return null;
}

// Whether the advisor will judge this card, so its creator holds the push.
export function advisorWillJudge(db: DB, d: { id: string; decision_class?: string | null; risk?: string | null; options?: unknown }): boolean {
  return advisorOn() && !directorOnly(db, d);
}

function verdictFor(db: DB, decisionId: string): { owner: string; why: string | null } | null {
  const row = db
    .query("SELECT payload FROM events WHERE type = 'advisor_verdict' AND json_extract(payload, '$.decision_id') = ? ORDER BY ts DESC, rowid DESC LIMIT 1")
    .get(decisionId) as { payload: string } | undefined;
  if (!row) return null;
  try {
    const p = JSON.parse(row.payload);
    return { owner: String(p.owner ?? "director"), why: p.why ? String(p.why) : null };
  } catch {
    return null;
  }
}

// `for_director` is false while the advisor is still deciding whose card this
// is; `advice` is its one-line reason when it left the card to the director.
export function withAdvice<T extends { id: string; ts: string; status: string; decision_class?: string | null; risk?: string | null }>(
  db: DB,
  d: T
): T & { for_director: boolean; advice: string | null } {
  const verdict = verdictFor(db, d.id);
  const judging =
    d.status === "open" && !verdict && advisorWillJudge(db, d) && Date.now() - Date.parse(d.ts) < JUDGE_GRACE_MS;
  return { ...d, for_director: !judging, advice: verdict?.owner === "director" ? verdict.why : null };
}

// `hive_working`: hive is still reading the code for this draft, so it is not
// the director's yet. `waiting_on`: the reporter was asked and has not replied.
export function withIntentStatus<T extends Intent>(db: DB, intent: T): T & { hive_working: boolean; waiting_on: "reporter" | null } {
  if (intent.status !== "draft") return { ...intent, hive_working: false, waiting_on: null };
  const asked = askedReporterAt(db, intent);
  const replied = reporterReplyAt(db, intent);
  const since = replied ?? intent.created_at;
  const hive_working = investigatorOn() && investigationDue(db, intent) && Date.now() - Date.parse(since) < INVESTIGATE_GRACE_MS;
  return { ...intent, hive_working, waiting_on: asked && !replied ? "reporter" : null };
}

export function buildAdvisorPrompt(d: any, task: any, projectName: string): string {
  const options: any[] = Array.isArray(d.options) ? d.options : JSON.parse(d.options || "[]");
  const optionLines = options
    .map((o) => `- ${o.key}: ${o.label ?? ""}${o.detail ? ` (${o.detail})` : ""}${o.recommended ? " [recommended]" : ""}`)
    .join("\n");
  return `You decide who answers a question that came up while software work was being done: the
person who owns the project, or the system doing the work.

The owner decides only these:
- PRODUCT judgment: what users see or experience, product behavior, wording, design,
  pricing, plans and quotas, who can see which content, which feature matters more.
- AUTHORITY: writes to production data, money or billing, deleting or tearing down
  anything that cannot be restored, security and credentials, access for other people,
  messages to people outside the team, releases and deploys, starting or stopping
  servers on the owner's machine, anything that cannot be undone.

The system settles everything else: reversible engineering and process calls, such as
closing a duplicate, trimming work back to what was asked or splitting it, retrying or
requeueing work, pointing a task at a newer attempt, picking between two equivalent
implementations, closing work that already shipped, cleanup that loses nothing.
When in doubt, the owner decides.

Project: ${projectName}
Work item: ${task?.title ?? "(unknown)"}

Question: ${d.title}
Context: ${String(d.context ?? "(none)").slice(0, 3000)}
Risk as the asker rated it: ${d.risk ?? "(not rated)"}
Options:
${optionLines || "(no options)"}

Reply with JSON only:
{"owner": "system" or "owner", "pick": "<option key the system chooses, only when owner is system>", "why": "<one short plain sentence, readable in two seconds, no jargon>"}`;
}

export function normalizeAdvice(o: any): Advice | null {
  if (!o || typeof o !== "object") return null;
  const owner = o.owner === "system" ? "hive" : o.owner === "owner" ? "director" : null;
  const why = typeof o.why === "string" ? o.why.trim() : "";
  if (!owner || !why) return null;
  return { owner, pick: typeof o.pick === "string" && o.pick.trim() ? o.pick.trim() : null, why };
}

// Leave the card to the director: record why, and push it to them unless the
// card was already pushed when it was created.
function escalate(db: DB, deps: AdvisorDeps, d: any, why: string | null, extra: Record<string, unknown> = {}): void {
  writeEvent(db, { task_id: d.task_id, source: "system", type: "advisor_verdict", payload: { decision_id: d.id, owner: "director", why, ...extra } });
  const pushed = db.query("SELECT 1 FROM notifications WHERE decision_id = ? AND kind = 'decision' LIMIT 1").get(d.id);
  if (!pushed)
    enqueue(db, {
      kind: "decision",
      task_id: d.task_id,
      decision_id: d.id,
      title: `Needs you: ${d.title}`,
      body: why ?? d.context ?? undefined,
      urgency: "urgent",
    });
  deps.publish?.(d.id);
}

export async function adviseDecision(db: DB, d: any, deps: AdvisorDeps): Promise<void> {
  const escalateTo = (why: string | null, extra: Record<string, unknown> = {}) => escalate(db, deps, d, why, extra);
  const ruled = directorOnly(db, d);
  if (ruled) return escalateTo(ruled);
  const task = getTask(db, d.task_id);
  const project = task
    ? (db.query("SELECT name, repo_path FROM projects WHERE id = ?").get(task.project_id) as { name: string; repo_path: string | null } | undefined)
    : undefined;
  const repoPath = project?.repo_path || undefined;
  const model = deps.model ?? MODEL;
  const argv = [
    claudeBin(), "-p", "--model", model, buildAdvisorPrompt(d, task, project?.name ?? ""),
    "--output-format", "json", "--max-turns", "1",
    "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
  ];
  let res: Awaited<ReturnType<PlannerExec>>;
  try {
    res = await (deps.exec ?? defaultPlannerExec)(argv, {
      timeoutMs: TIMEOUT_MS,
      ...(repoPath ? { cwd: repoPath, env: claudeProfileEnvForRepo(repoPath) } : {}),
      taskId: d.task_id,
      site: "advisor",
    });
  } catch (e: any) {
    return escalateTo(null, { error: `advisor spawn failed: ${e?.message ?? e}` });
  }
  if (res.timedOut || res.code !== 0) return escalateTo(null, { error: modelFailure(db, res, { timeoutMs: TIMEOUT_MS }) });
  noteModelCall(db, null);
  const advice = parseModelJson(res.stdout, normalizeAdvice);
  if (!advice) return escalateTo(null, { error: "advisor output was not valid JSON" });
  if (advice.owner === "director") return escalateTo(advice.why, { model });

  // Hive may only take the raiser's own recommendation; with none, its pick
  // must be one of the options.
  const options: any[] = Array.isArray(d.options) ? d.options : JSON.parse(d.options || "[]");
  const recommended = options.find((o) => o?.recommended)?.key ?? null;
  const pick = recommended ?? (options.some((o) => o?.key === advice.pick) ? advice.pick : null);
  if (!pick || (recommended && advice.pick && advice.pick !== recommended))
    return escalateTo(advice.why, { model, note: "hive would not take the recommended option" });
  const answered = await deps.answer(d.id, pick, `Hive decided: ${advice.why}`);
  if (!answered) return escalateTo(advice.why, { model, note: "hive's answer was refused" });
  writeEvent(db, { task_id: d.task_id, source: "system", type: "advisor_verdict", payload: { decision_id: d.id, owner: "hive", pick, why: advice.why, model } });
  enqueue(db, { kind: "auto_answered", task_id: d.task_id, decision_id: d.id, title: `Hive decided: ${d.title}`, body: advice.why });
}

// Rewrite an ask's open questions as one short comment to the person who filed
// the ticket, in the owner's voice. Falls back to the questions as written.
async function reporterComment(questions: string[], deps: AdvisorDeps): Promise<string> {
  const fallback = ["Before I start on this, could you help me with a couple of things?", "", ...questions.map((q) => `- ${q}`), "", "Thank you!"].join("\n");
  const prompt = `Rewrite these open questions about a ticket as ONE short, friendly comment to the person
who filed it, written by the engineer who will do the work. Plain professional English,
a greeting line, the questions as a short list, a thank-you line. Ask only what the
questions ask. Never mention tools, automation, AI, drafts or internal records.

Questions:
${questions.map((q) => `- ${q}`).join("\n")}

Reply with JSON only: {"comment": "<the comment text>"}`;
  try {
    const res = await (deps.exec ?? defaultPlannerExec)(
      [claudeBin(), "-p", "--model", deps.model ?? MODEL, prompt, "--output-format", "json", "--max-turns", "1", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}'],
      { timeoutMs: TIMEOUT_MS, site: "advisor-reporter" }
    );
    if (res.code !== 0 || res.timedOut) return fallback;
    const parsed = parseModelJson(res.stdout, (o: any) => (typeof o?.comment === "string" && o.comment.trim() ? o.comment.trim() : null));
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

// A Jira ask hive finished reading the code for, that still has questions, and
// whose reporter was never asked: ask them on the ticket, once.
export async function askReporters(db: DB, deps: AdvisorDeps): Promise<number> {
  const drafts = db
    .query(
      `SELECT i.* FROM intents i JOIN projects p ON p.id = i.project_id
        WHERE i.status = 'draft' AND i.source = 'jira' AND ${notTestProjectSql("p.config")}
          AND EXISTS (SELECT 1 FROM events e WHERE e.type = 'intent_investigated' AND json_extract(e.payload, '$.intent_id') = i.id)
        ORDER BY i.created_at LIMIT 50`
    )
    .all() as Intent[];
  let asked = 0;
  for (const intent of drafts) {
    // Never from a read of an older version of the ticket, never the same questions twice.
    if (investigationDue(db, intent) || askedReporterAt(db, intent)) continue;
    const questions = openQuestions(intent.body_md);
    const mirror = mirrorOf(db, intent);
    const cfg = jiraConfigFor(db, intent.project_id);
    if (!questions.length || !mirror || !cfg?.enabled || !cfg.write) continue;
    const text = await reporterComment(questions, deps);
    const fresh = getIntent(db, intent.id);
    if (!fresh || fresh.status !== "draft") continue;
    writeEvent(db, { task_id: mirror.id, source: "system", type: "jira_comment", payload: { direction: "outbound", intent_id: intent.id, asked_reporter: true, text } });
    writeEvent(db, { task_id: mirror.id, source: "system", type: "asked_reporter", payload: { intent_id: intent.id, questions, at: now() } });
    broadcast({ type: "intent", intent: withIntentStatus(db, fresh) });
    asked++;
  }
  return asked;
}

export async function adviseOnce(db: DB, deps: AdvisorDeps): Promise<number> {
  const open = db
    .query(
      `SELECT d.* FROM decisions d JOIN tasks t ON t.id = d.task_id JOIN projects p ON p.id = t.project_id
        WHERE d.status = 'open' AND ${notTestProjectSql("p.config")}
          AND NOT EXISTS (SELECT 1 FROM events e WHERE e.type = 'advisor_verdict' AND json_extract(e.payload, '$.decision_id') = d.id)
        ORDER BY d.ts LIMIT 5`
    )
    .all() as any[];
  for (const d of open) {
    try {
      await adviseDecision(db, d, deps);
    } catch (e) {
      console.error(`[hive] advisor ${d.id}:`, e);
      escalate(db, deps, d, null, { error: String((e as any)?.message ?? e) });
    }
  }
  const asked = await askReporters(db, deps).catch((e) => {
    console.error("[hive] advisor reporter questions:", e);
    return 0;
  });
  return open.length + asked;
}

export function startAdvisor(db: DB, deps: AdvisorDeps): () => void {
  return startLoop("decision-advisor", deps.intervalMs ?? 20_000, () => adviseOnce(db, deps), { firstRunAfterMs: 10_000 });
}
