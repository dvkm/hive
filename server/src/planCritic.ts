// Plan checkpoints with an automatic critic (HIVE-412).
//
// For task kinds listed in a project's config.plan_gate.kinds, the brief tells
// the agent to post its plan as a checkpoint BEFORE its first edit. When such a
// checkpoint arrives, hive runs one cheap sonnet one-shot over the plan plus the
// task brief and attaches the result as a `plan_critique` event linked to the
// checkpoint. A `veto` concern also steers the agent, quoting the concern.
//
// Nothing blocks: the critique runs in the background and the agent keeps
// working. config.plan_gate.block exists for a later phase and is read by
// nothing yet.
import type { DB } from "./db.ts";
import { writeEvent } from "./state.ts";
import { claudeBin, defaultPlannerExec, type PlannerExec } from "./planner.ts";

const MODEL = "sonnet";
const TIMEOUT_MS = 60_000;

export interface Plan {
  kind: "plan";
  goal: string;
  approach: string;
  files_expected: string[];
  verification_planned: string;
}

export interface Concern {
  severity: "note" | "veto";
  text: string;
}

export interface PlanCriticDeps {
  plannerExec?: PlannerExec;
  steer?: (taskId: string, message: string) => Promise<unknown>;
}

// Which task kinds must post a plan checkpoint. Default: none — the gate is
// opt-in per project.
export function planGateKinds(config: any): string[] {
  const kinds = config?.plan_gate?.kinds;
  return Array.isArray(kinds) ? kinds.filter((k: unknown) => typeof k === "string") : [];
}

// A checkpoint's fields as a plan, or null when it is an ordinary checkpoint.
// Fields arrive top-level from `hive emit --json` (JSON) or as strings
// (multipart), so files_expected is accepted in either form.
export function parsePlan(fields: Record<string, any>): Plan | null {
  if (fields?.kind !== "plan") return null;
  const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  let files = fields.files_expected;
  if (typeof files === "string") {
    try {
      files = JSON.parse(files);
    } catch {
      files = [files];
    }
  }
  return {
    kind: "plan",
    goal: text(fields.goal),
    approach: text(fields.approach),
    files_expected: Array.isArray(files) ? files.map((f: unknown) => String(f)) : [],
    verification_planned: text(fields.verification_planned),
  };
}

export function buildCriticPrompt(task: any, plan: Plan): string {
  return [
    "You are reviewing an engineer's PLAN before they write any code. Judge only",
    "whether the plan will deliver the task as briefed. You cannot see the code, so",
    "do not guess about details the plan does not mention.",
    "",
    `Task: ${task.title ?? ""}`,
    `Brief:\n${String(task.brief ?? "").slice(0, 8000)}`,
    "",
    "Plan:",
    JSON.stringify(plan, null, 2),
    "",
    'Reply with ONE JSON object and nothing else: {"concerns":[{"severity":"note"|"veto","text":"..."}]}',
    "- severity 'veto': the plan misses the brief, solves the wrong problem, or would",
    "  cause real damage. Only for a problem worth interrupting the engineer over.",
    "- severity 'note': a smaller gap worth mentioning.",
    "- No concerns is a fine answer. Return {\"concerns\":[]} rather than inventing one.",
    "- Each text is one plain-English sentence naming the specific gap.",
  ].join("\n");
}

// Defensive extraction, same ladder as the planner: whole body, then the
// `claude -p --output-format json` {result: "..."} envelope, then first-brace to
// last-brace for prose-wrapped JSON. Anything unparseable means no concerns.
export function extractConcerns(raw: string): Concern[] | null {
  const normalize = (o: any): Concern[] | null => {
    if (!o || !Array.isArray(o.concerns)) return null;
    return o.concerns
      .filter((c: any) => c && typeof c.text === "string" && c.text.trim())
      .map((c: any) => ({
        severity: c.severity === "veto" ? "veto" : "note",
        text: String(c.text).trim(),
      }));
  };
  const tryParse = (s: string): Concern[] | null => {
    try {
      return normalize(JSON.parse(s));
    } catch {
      return null;
    }
  };
  const braces = (s: string): Concern[] | null => {
    const i = s.indexOf("{");
    const j = s.lastIndexOf("}");
    return i < 0 || j <= i ? null : tryParse(s.slice(i, j + 1));
  };
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

// Run the critic and attach its verdict. Never throws: a critic that fails logs
// and attaches an empty critique, because a broken model must not disturb an
// agent that is already working.
export async function critiquePlan(
  db: DB,
  task: any,
  checkpointId: string,
  plan: Plan,
  deps: PlanCriticDeps = {}
): Promise<Concern[]> {
  const plannerExec = deps.plannerExec ?? defaultPlannerExec;
  const attach = (concerns: Concern[], error?: string) => {
    writeEvent(db, {
      task_id: task.id,
      source: "hive",
      type: "plan_critique",
      payload: { checkpoint_id: checkpointId, concerns, ...(error ? { error } : {}) },
    });
    if (error) console.error(`[hive] plan critic for ${task.id}: ${error}`);
    return concerns;
  };

  let res: Awaited<ReturnType<PlannerExec>>;
  try {
    res = await plannerExec(
      [claudeBin(), "-p", "--model", MODEL, buildCriticPrompt(task, plan), "--output-format", "json"],
      { timeoutMs: TIMEOUT_MS, ...(task.worktree_path ? { cwd: task.worktree_path } : {}) }
    );
  } catch (e: any) {
    return attach([], `critic spawn failed: ${e?.message ?? e}`);
  }
  if (res.timedOut) return attach([], `critic timed out after ${TIMEOUT_MS}ms`);
  if (res.code !== 0) return attach([], `critic exited ${res.code}: ${(res.stderr || res.stdout).slice(0, 400)}`);
  const concerns = extractConcerns(res.stdout);
  if (!concerns) return attach([], "critic output was not valid JSON with concerns");

  attach(concerns);
  const vetoes = concerns.filter((c) => c.severity === "veto");
  if (vetoes.length && deps.steer) {
    await deps.steer(
      task.id,
      `Plan review VETO on the plan you just posted: ${vetoes.map((v) => `"${v.text}"`).join(" ")} ` +
        `Re-read the brief, fix the plan, and post the corrected plan checkpoint before you keep editing.`
    );
  }
  return concerns;
}
