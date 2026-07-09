// Brief composition. Composed fresh at spawn time (Phase 2) and exposed at
// GET /api/tasks/:id/brief. Pure function of DB state.
import type { DB } from "./db.ts";
import { getTask } from "./state.ts";

const EMIT_PROTOCOL = `## Reporting protocol (\`hive emit\`)
You are running under hive. Report progress with the \`hive emit\` CLI so the
director's board stays current. Do not wait to be asked for status.

  hive emit <task-id> status   --note "what you just did / are doing"
  hive emit <task-id> evidence --file ./screenshot.png --note "caption"
  hive emit <task-id> needs-decision --note "one line summary"   (then open a decision card)
  hive emit <task-id> blocked  --note "why you are stuck"
  hive emit <task-id> done     --note "final summary"

Rules:
- A task NEVER reaches Done without evidence. Attach at least one evidence item
  (screenshot, test run, log, report, or link) before emitting \`done\`.
- Scout tasks (knowledge-only) require a written report as evidence.
- When you hit a decision the director must make, emit \`needs-decision\` and
  stop; do not guess on anything high-risk (prod, feature flags, destructive ops).`;

function definitionOfDone(kind: string): string {
  if (kind === "scout") {
    return "## Definition of done\nA written report captured as evidence (kind=report) that answers the question. No code changes required.";
  }
  if (kind === "chore") {
    return "## Definition of done\nThe chore is complete with at least one evidence item showing the result (log, screenshot, or test run).";
  }
  return "## Definition of done\nCode merged (PR open -> reviewed -> verifying -> done), post-merge smoke checks pass, and at least one evidence item is attached. No task reaches Done without evidence.";
}

// Compose the full agent brief. Includes: task description, definition of done,
// hive emit protocol, all active GLOBAL policies, and active PROJECT policies.
export function composeBrief(db: DB, taskId: string): string {
  const task = getTask(db, taskId);
  if (!task) throw new Error(`unknown task: ${taskId}`);

  const globals = db
    .query(
      "SELECT title, body FROM policies WHERE scope = 'global' AND active = 1 ORDER BY created_at"
    )
    .all() as { title: string; body: string }[];
  const projectScope = `project:${task.project_id}`;
  const projectPols = db
    .query(
      "SELECT title, body FROM policies WHERE scope = ? AND active = 1 ORDER BY created_at"
    )
    .all(projectScope) as { title: string; body: string }[];

  const parts: string[] = [];
  parts.push(`# Task: ${task.title}`);
  parts.push(`Task id: ${task.id}\nKind: ${task.kind}`);
  parts.push(`## Brief\n${task.brief?.trim() || "(no description provided)"}`);
  parts.push(definitionOfDone(task.kind));
  parts.push(EMIT_PROTOCOL);

  if (globals.length) {
    parts.push(
      "## Global policies (always apply)\n" +
        globals.map((p) => `### ${p.title}\n${p.body}`).join("\n\n")
    );
  }
  if (projectPols.length) {
    parts.push(
      "## Project policies\n" +
        projectPols.map((p) => `### ${p.title}\n${p.body}`).join("\n\n")
    );
  }

  return parts.join("\n\n") + "\n";
}
