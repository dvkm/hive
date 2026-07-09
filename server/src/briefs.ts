// Brief composition. Composed fresh at spawn time (Phase 2) and exposed at
// GET /api/tasks/:id/brief. Pure function of DB state.
import type { DB } from "./db.ts";
import { getTask } from "./state.ts";
import { prTitlePrefix, prBodyFooter } from "./marker.ts";

// The PR marker contract (documented in docs/API.md). Both halves are REQUIRED
// on any PR the agent opens so hive can link the PR back to this task.
function prMarkerSection(number: number, id: string): string {
  return `## Opening a PR (REQUIRED marker)
When you open the PR for this task — whether via /no-mistakes or directly with
\`gh pr create\` — it MUST carry the hive marker so the board links the PR back
to this task automatically:

- The PR **title** MUST start with \`${prTitlePrefix(number)}\` (the space is part of it).
- The PR **body** MUST include this line on its own (a footer is ideal):

  ${prBodyFooter(id)}

Don't hand-format it — run \`hive pr-marker ${id}\` and paste what it prints.`;
}

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

// Kept in sync with DENIED_MCP_SERVERS in api.ts, which writes the matching
// permissions.deny into each worktree's .claude/settings.local.json.
const BROWSER_VERIFICATION = `## Browser verification (headless only)
The interactive browser MCP servers (claude-in-chrome, computer-use) are DENIED
in your worktree settings and will not appear in your tool list. They pop an
Allow/Deny dialog, and nobody is watching your pane, so a call to one used to
hang the agent forever. Verify web changes headlessly instead:

  curl -sS -i http://127.0.0.1:<port>/<path>        # status, headers, HTML, JSON
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \\
    --headless --disable-gpu --screenshot=out.png --window-size=1280,800 <url>

If the repo already depends on Playwright or Puppeteer, drive that instead of
raw Chrome. Attach the result as evidence:

  hive emit <task-id> evidence --file out.png --note "logged-in dashboard"`;

// Standing-authority section: the active rules (global + project) that govern
// this agent, plus the exact guarded-action protocol. The server enforces these
// before risky actions dispatch, so agents never serially ask for permission.
function standingAuthority(db: DB, projectId: string, taskId: string): string {
  const rules = db
    .query(
      "SELECT action_pattern, effect, note FROM authority_rules " +
        "WHERE active = 1 AND (project_id IS NULL OR project_id = ?) ORDER BY created_at"
    )
    .all(projectId) as { action_pattern: string; effect: string; note: string | null }[];

  const lines = rules.length
    ? rules.map((r) => `- \`${r.action_pattern}\` → **${r.effect}**${r.note ? ` (${r.note})` : ""}`).join("\n")
    : "- (no rules yet — unmatched actions default to allow and are logged)";

  return `## Standing authority (server-enforced)
The director granted standing authority once; the hive server enforces it BEFORE
risky actions dispatch. Do NOT serially ask for permission. Rules that apply here
(most-specific wins, project over global, longer pattern over shorter):

${lines}

Your shell commands are gated automatically: clearly-safe, read-only / standard
dev commands (ls, cat, grep, git status/diff/log, bun test, bun run, ...) run
freely with no dialog, while destructive or unknown commands are routed through
this same authority engine before they execute. You do not need to pre-clear
ordinary work — just run it. When a risky command IS gated you'll see the tool
denied with either "denied by standing authority" or "escalated to hive decision
<id>"; in the latter case a card is waiting for the director, so re-run the same
command once it's approved (a single-use grant lets the retry through).

Before ANY externally-risky operation you run yourself (prod deploy, feature-flag
flip, destructive op), call the guarded-action gate and act ONLY on its answer:

  curl -sS -X POST "$HIVE_URL/api/tasks/${taskId}/guarded-action" \\
    -H 'Content-Type: application/json' \\
    -d '{"action":"deploy","target":"acme-web on PROD","detail":"release v1.2.3"}'

- 200 {"effect":"allow"}         → proceed.
- 403 {"effect":"deny"}          → STOP. Do not perform it.
- 409 {"decision_id":"..."}      → a decision card was opened naming the exact
    target. WAIT for the director to answer, then retry the SAME call verbatim;
    once approved it passes (a single-use grant is spent).`;
}

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
  parts.push(`# Task #${task.number}: ${task.title}`);
  parts.push(`Task number: ${task.number}\nTask id: ${task.id}\nKind: ${task.kind}`);
  parts.push(`## Brief\n${task.brief?.trim() || "(no description provided)"}`);
  parts.push(definitionOfDone(task.kind));
  parts.push(EMIT_PROTOCOL);
  parts.push(prMarkerSection(task.number, task.id));
  parts.push(BROWSER_VERIFICATION);

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

  // Standing authority: which scoped rules govern this agent + the guarded-action
  // protocol it MUST use before any externally-risky operation it runs itself.
  parts.push(standingAuthority(db, task.project_id, task.id));

  // Known failure patterns: active learnings for the project, 10 most recent.
  const learnings = db
    .query(
      "SELECT title, body, occurrences FROM learnings WHERE project_id = ? AND status = 'active' ORDER BY last_seen DESC LIMIT 10"
    )
    .all(task.project_id) as { title: string; body: string | null; occurrences: number }[];
  if (learnings.length) {
    parts.push(
      "## Known failure patterns (learn from past regressions)\n" +
        learnings
          .map((l) => `### ${l.title} (seen ${l.occurrences}×)\n${l.body?.trim() || ""}`.trimEnd())
          .join("\n\n")
    );
  }

  return parts.join("\n\n") + "\n";
}
