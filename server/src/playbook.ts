// Promote a finished task into a reusable playbook. A done task's brief, its
// key events, and its final diff stat hold the recipe for "how work like this
// gets done here" — but that recipe dies with the task card. A one-shot
// `claude -p` (sonnet) distills it into a small JSON object and files it as a
// kind='reference' learning, which is pinned into future briefs and reachable
// from `hive recall`. No schema change: the learnings table already carries
// references (db.ts v3-learnings + the v-kind column).
import type { DB } from "./db.ts";
import { now } from "./db.ts";
import { getTask } from "./state.ts";
import type { Exec } from "./exec.ts";
import { defaultExec } from "./exec.ts";
import { claudeBin, defaultPlannerExec, type PlannerExec } from "./planner.ts";
import { addReference } from "./learn.ts";
import { taskDiff } from "./diff.ts";
import { PLAIN_ENGLISH } from "./plainEnglish.ts";

const TIMEOUT_MS = Number(process.env.HIVE_PLAYBOOK_TIMEOUT_MS || 180_000);

export interface PlaybookDeps {
  exec?: PlannerExec; // the claude -p runner (injectable in tests)
  shellExec?: Exec; // gh/git for the diff stat
}

export interface Playbook {
  title: string;
  when_to_use: string;
  steps: string[];
  gotchas: string[];
  success_criteria: string[];
}

// Loose-parse the model output: whole JSON, the `claude -p --output-format
// json` {result:"..."} envelope, or a braces slice of prose. Same three shapes
// the reviewer and drift judges have to cope with.
export function extractPlaybook(raw: string): Playbook | null {
  const strings = (v: any): string[] =>
    Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : [];
  const norm = (o: any): Playbook | null => {
    if (!o || typeof o.title !== "string" || !o.title.trim()) return null;
    if (typeof o.when_to_use !== "string" || !o.when_to_use.trim()) return null;
    const steps = strings(o.steps);
    if (!steps.length) return null; // a playbook with no steps is not a playbook
    return {
      title: o.title.trim(),
      when_to_use: o.when_to_use.trim(),
      steps,
      gotchas: strings(o.gotchas),
      success_criteria: strings(o.success_criteria),
    };
  };
  const tryParse = (s: string) => {
    try {
      return norm(JSON.parse(s));
    } catch {
      return null;
    }
  };
  const braces = (s: string) => {
    const a = s.indexOf("{");
    const b = s.lastIndexOf("}");
    return a >= 0 && b > a ? tryParse(s.slice(a, b + 1)) : null;
  };
  const whole = tryParse(raw);
  if (whole) return whole;
  try {
    const env = JSON.parse(raw);
    if (env && typeof env.result === "string") return tryParse(env.result) ?? braces(env.result);
  } catch {}
  return braces(raw);
}

// The events that actually describe how the work went: what the agent did
// (status), the tradeoffs it called out mid-flight (checkpoint), and its own
// closing account of the change (review_summary).
const KEY_EVENT_TYPES = ["status", "checkpoint", "review_summary"];
const EVENT_LIMIT = 60;
const EVENT_CHARS = 12_000;

function keyEvents(db: DB, taskId: string): string {
  const rows = db
    .query(
      `SELECT type, payload FROM events WHERE task_id = ? AND type IN (${KEY_EVENT_TYPES.map(() => "?").join(",")})
        ORDER BY ts ASC, rowid ASC LIMIT ${EVENT_LIMIT}`
    )
    .all(taskId, ...KEY_EVENT_TYPES) as { type: string; payload: string }[];
  return rows
    .map((r) => `- ${r.type}: ${r.payload}`)
    .join("\n")
    .slice(0, EVENT_CHARS);
}

// Files touched and their line counts — the shape of the change, not its text.
// Best-effort: a done task's branch may already be gone, and a playbook is
// still worth writing from the brief and events alone.
async function diffStat(db: DB, taskId: string, exec: Exec): Promise<string> {
  const d = await taskDiff(db, taskId, exec).catch(() => null);
  if (!d || !d.ok) return "(diff unavailable)";
  if (!d.diff.files.length) return "(no files changed)";
  return d.diff.files
    .map((f) => `${f.path} | +${f.additions} -${f.deletions}${f.binary ? " (binary)" : ""}`)
    .join("\n")
    .slice(0, 8000);
}

export function playbookPrompt(task: any, events: string, stat: string): string {
  return [
    `A task just finished. Distill it into a reusable playbook for the NEXT person who takes on work like this.`,
    `Generalize: describe the repeatable recipe, not this one task's bookkeeping. Skip anything that only ever applies to this task.`,
    ``,
    `Task #${task.number}: ${task.title}`,
    `Brief:\n${(task.brief ?? "").slice(0, 6000)}`,
    ``,
    `Key events (what the agent did, flagged, and concluded):`,
    events || "(none)",
    ``,
    `Final diff stat:`,
    stat,
    ``,
    PLAIN_ENGLISH,
    ``,
    `Answer as ONLY a JSON object, no prose around it:`,
    `{"title": "short imperative name for this kind of work, e.g. 'Add an API endpoint backed by a learnings row'",`,
    ` "when_to_use": "one sentence: the situation that should make someone reach for this",`,
    ` "steps": ["each step in order, concrete, naming real files/commands where they apply"],`,
    ` "gotchas": ["each trap that cost time here and would cost it again"],`,
    ` "success_criteria": ["each check that proves the work is actually done"]}`,
    `Rules: steps must be non-empty. Empty gotchas or success_criteria arrays are fine if there is nothing real to say.`,
    `Never repeat the same point across two bullets.`,
  ].join("\n");
}

// The stored body: a `[playbook]` prefix so it is greppable and distinguishable
// from a hand-written reference, the when_to_use line so `hive recall` matches
// on the situation, then the JSON verbatim in a fenced block.
export function playbookBody(pb: Playbook, task: any): string {
  return [
    `[playbook] ${pb.when_to_use}`,
    ``,
    `Distilled from task #${task.number}: ${task.title}`,
    ``,
    "```json",
    JSON.stringify(pb, null, 2),
    "```",
  ].join("\n");
}

export type PlaybookResult =
  | { ok: true; learning_id: string; playbook: Playbook }
  | { ok: false; status: number; error: string };

export async function makePlaybook(db: DB, taskId: string, deps: PlaybookDeps = {}): Promise<PlaybookResult> {
  const task = getTask(db, taskId);
  if (!task) return { ok: false, status: 404, error: "task not found" };
  // A playbook is distilled from how the work actually landed. Before done,
  // the recipe is still changing underneath it.
  if (task.state !== "done")
    return { ok: false, status: 409, error: `task is ${task.state}; only a done task can become a playbook` };

  const project: any = db.query("SELECT config FROM projects WHERE id = ?").get(task.project_id);
  const config = JSON.parse(project?.config ?? "{}");
  const stat = await diffStat(db, taskId, deps.shellExec ?? defaultExec);
  const prompt = playbookPrompt(task, keyEvents(db, taskId), stat);

  const argv = [claudeBin(), "-p", "--model", config.model_by_kind?.playbook ?? "sonnet", prompt, "--output-format", "json"];
  const exec = deps.exec ?? defaultPlannerExec;
  let res;
  try {
    res = await exec(argv, { timeoutMs: TIMEOUT_MS });
  } catch (e: any) {
    return { ok: false, status: 502, error: String(e?.message ?? e) };
  }
  if (res.timedOut) return { ok: false, status: 502, error: `timed out after ${TIMEOUT_MS}ms` };
  if (res.code !== 0) return { ok: false, status: 502, error: `exited ${res.code}: ${res.stderr.trim().slice(0, 300)}` };

  const pb = extractPlaybook(res.stdout);
  if (!pb) return { ok: false, status: 502, error: "unparseable playbook output" };

  const learningId = storePlaybook(db, task, pb);
  return { ok: true, learning_id: learningId, playbook: pb };
}

// Playbook titles are model-generated, and addReference upserts on (project,
// kind, title): two different tasks that landed on the same title would
// silently replace each other, leaving one playbook gone and the survivor
// pointing at the wrong source task. Key on the source task instead —
// re-promoting a task rewrites its own row, and a title another row already
// claims gets the task number appended rather than clobbering it.
export function storePlaybook(db: DB, task: any, pb: Playbook): string {
  const body = playbookBody(pb, task);
  const mine = db
    .query(
      `SELECT id FROM learnings WHERE project_id = ? AND kind = 'reference' AND source_task_id = ?
         AND body LIKE '[playbook]%' LIMIT 1`
    )
    .get(task.project_id, task.id) as { id: string } | undefined;
  const title = freeTitle(db, task.project_id, pb.title, task.number, mine?.id);
  if (mine) {
    db.query("UPDATE learnings SET title = ?, body = ?, last_seen = ?, status = 'active' WHERE id = ?").run(
      title,
      body,
      now(),
      mine.id
    );
    return mine.id;
  }
  return addReference(db, task.project_id, title, body, task.id);
}

function freeTitle(db: DB, projectId: string, base: string, taskNumber: number, ownId?: string): string {
  const taken = (t: string) => {
    const row = db
      .query("SELECT id FROM learnings WHERE project_id = ? AND kind = 'reference' AND title = ? LIMIT 1")
      .get(projectId, t) as { id: string } | undefined;
    return !!row && row.id !== ownId;
  };
  if (!taken(base)) return base;
  for (let i = 1; ; i++) {
    const t = i === 1 ? `${base} (task #${taskNumber})` : `${base} (task #${taskNumber}) (${i})`;
    if (!taken(t)) return t;
  }
}
