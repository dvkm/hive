// Brief composition. Composed fresh at spawn time (Phase 2) and exposed at
// GET /api/tasks/:id/brief. Pure function of DB state.
import type { DB } from "./db.ts";
import { getTask } from "./state.ts";
import { prTitlePrefix, prBodyFooter } from "./marker.ts";
import { managingThreadForTask } from "./chat.ts";
import { PLAIN_ENGLISH } from "./plainEnglish.ts";
import { taskIdentifier } from "./taskIdentifier.ts";

// The PR marker contract (documented in docs/API.md). Both halves are REQUIRED
// on any PR the agent opens so hive can link the PR back to this task.
function prMarkerSection(number: number, id: string): string {
  return `## Opening a PR (REQUIRED marker)
When you open the PR for this task, it MUST carry the hive marker so the board
links the PR back to this task automatically:

- The PR **title** MUST start with \`${prTitlePrefix(number)}\` (the space is part of it).
- The PR **body** MUST include this line on its own (a footer is ideal):

  ${prBodyFooter(id)}

Don't hand-format it — run \`hive pr-marker ${id}\` and paste what it prints.`;
}

const EMIT_PROTOCOL = `## Reporting protocol (\`hive emit\`)
Keep the director's board current with the \`hive\` CLI. If it is not on PATH,
use \`"$HIVE_CLI"\`. Prefer the CLI over raw curl so actions are attributed.

  hive emit <task-id> status   --note "what you just did / are doing"
  hive emit <task-id> evidence --file ./screenshot.png --note "caption"
  hive decision ask <task-id> --title "..." --context "..." --option k:label:detail ...   (opens a card AND parks the task — see below)
  hive emit <task-id> blocked  --note "why you are stuck"
  hive emit <task-id> ready    --pr-url <url> --note "PR <url>"   (hand off for review)
  hive emit <task-id> done     --note "final summary"

If your task's own PR closes with nothing left to merge (head==base, so GitHub
refuses to reopen it) but the work already landed via a different PR/commit,
don't wait on a human: point at the commit that actually carries the work and
close the task yourself. Hive verifies that commit is on the base branch
before it lets this through:

  hive emit <task-id> unmergeable --landing-commit <sha> --note "why"

Rules:
- Emit status before commands expected to exceed a minute.
- Attach evidence before \`ready\`. Use screenshots for visual work and test
  output for other changes. A task never reaches Done without evidence.
- Scout tasks (knowledge-only) require a written report as evidence.
- Hand off with \`ready\` when the PR is open. If CI is pending, END THE TURN;
  hive monitors it and wakes you only if action is needed. If CI fails, fix it.
- Before \`ready\`, submit a concise structured self-review:

    hive emit <task-id> review_summary --json review.json

  review.json shape (omit empty sections):
    {"done": ["what shipped, per change"],
     "iffy": [{"what": "the shortcut/risk/hack", "why": "why you did it anyway"}],
     "decisions": ["decisions you made or that were answered, one line each"],
     "testing": ["what you ran + result (tests, e2e, manual repro)"],
     "followups": ["tasks you spawned (#num) or suggest"],
     "understanding": {
       "background": "why this work exists and the prior belief, decision, or history needed to understand it",
       "scope": "what systems, sources, time range, and exclusions were examined",
       "essence": "the goal and core idea in plain language, before code details",
       "walkthrough": ["2-4 causal steps in the order a person should learn them"],
       "affected_areas": ["users, systems, or decisions materially affected"],
       "risk_assessment": "confidence, important uncertainty, and what could change the conclusion",
       "participate": "what this now lets the director decide, question, or build next",
       "checks": [{
         "question": "one conceptual self-check, not trivia",
         "options": [{"key": "a", "label": "..."}, {"key": "b", "label": "..."}],
         "answer_key": "a",
         "explanation": "why the answer is right"}]}}
  \`understanding.checks\` is required for every review. Use 1-5 questions,
  each with 2-4 plausible options and a teaching explanation.
  Every question must help them understand this specific change or report:
  behavior, user impact, risk, tradeoff, or evidence. Never test whether the
  agent knows how
  to code, debug, merge, use tools, follow agent policy, or operate Hive. Agent
  competence belongs in internal checks. Never quiz project bookkeeping. If a
  question does not improve the director's understanding of this review, omit
  it. Keep each question and option under 500 characters. For reports, make the
  packet a compact impact analysis. Include \`iffy\` whenever work is uncertain,
  hacky, or has a known ceiling.
- When you hit a decision the director must make, open a REAL decision card with
  concrete options — never bury a question in a status note or review summary
  (text questions can't be answered with a click):

    hive decision ask <task-id> --title "one specific question" \\
      --context "why this surfaced, what changes, and your recommendation" \\
      --option key1:Label:"what choosing this means" --option key2:Label:"..." \\
      --recommend key1

  Context must stand alone without opening the task. Give 2-4 options and a
  recommendation. \`hive decision ask\` parks the task, so do not emit a second
  needs-decision event. Keep working elsewhere if the answer is not blocking.
- When the director REQUESTS CHANGES, first reply with
  \`hive emit <task-id> status --note "..."\` saying what you'll change (this is
  a visible conversation — silence looks like the request was lost), then do the
  work and emit \`ready\` again.
- When the director's note ASKS A QUESTION, answer it with
  \`hive emit <task-id> answer --note "the answer"\` — answers are pushed to the
  director; plain status notes and your pane output are NOT. Never leave a
  question answered only in prose.
- Work ONLY inside your own worktree and scratchpad. NEVER create, edit, or
  delete files in the project's main checkout, other worktrees, or the human's
  home — cleanup of your own sandbox is auto-approved; anything outside it is not.
- Killing processes: prefer \`kill %1\` (your own shell jobs) or a pidfile in your
  scratchpad (\`... & echo $! > "$SCRATCH/dev.pid"\`, later \`kill $(cat ...)\` /
  \`pkill -F\`) — those pass the command gate automatically. Broad \`pkill -f <pattern>\`
  escalates to the director and stalls you.`;

// Live checklist: judgment calls surface DURING the build (the director ticks
// or flags them from the board), not as a surprise at review time. Flags come
// back as steer messages; checkpoints never block.
const CHECKPOINTS = `## Checkpoints (surface choices WHILE you build)
Do not save your judgment calls for the final review. The moment you make one —
an assumption about intent, a shortcut with a ceiling, a pick between real
alternatives, anything you would later list as "iffy" — emit it and KEEP WORKING:

  hive emit <task-id> checkpoint --note "the choice + why, one line"

Each checkpoint becomes a live checkbox the director ticks (approved) or flags;
a flag arrives as a steer message — address it when it lands, then continue.
Checkpoints are non-blocking by design. High-risk calls (prod, destructive,
feature flags) still go through \`hive decision ask\` / the guarded-action gate.
At handoff, your review_summary "iffy" section should mostly restate checkpoints
the director has already seen — surprises there mean you checkpointed too little.`;

// Agents may fan work out instead of scope-creeping their own task. HIVE_TASK_ID
// is set in every spawned agent's env, so the CLI auto-attributes the new task
// (source=agent, parent_task_id → this task).
function spawnTasksSection(projectId: string): string {
  return `## Spawning follow-up tasks
When you discover work that is OUT OF SCOPE for this task — a bug you noticed,
a missing test, a natural follow-up — do not expand your task. Queue it as a
new task and keep going:

  hive task create --project ${projectId} \\
    --title "short imperative title" \\
    --brief-text "what, where (files/paths), why, and the definition of done" \\
    --kind ship|scout|chore

Write the brief self-contained: the agent that picks it up has NONE of your
context. Include file paths, repro steps, and what done looks like. The task is
linked to you automatically (parent) and the dispatcher schedules it like any
other — duplicates are auto-detected, so when in doubt, file it.

When you hit a NON-OBVIOUS gotcha (a build quirk, a flaky path, a repo landmine
that cost you real time), record it so future agents see it in their briefs:

  hive learning add --project ${projectId} --kind failure --title "one-line pattern" --body "the fix / what to know"

When you discover a DURABLE PROJECT FACT the director would otherwise have to
repeat (the design file/link, a dashboard URL, a glossary term, an env detail),
store it as a reference — it gets pinned into every future brief and planner:

  hive learning add --project ${projectId} --kind reference --title "what it is" --body "the fact / link"

Mechanical failures (spawn/merge/smoke) are recorded automatically — this is
for the things only you know you tripped on.`;
}

function teamSection(db: DB, taskId: string): string | null {
  const thread = managingThreadForTask(db, taskId);
  if (!thread?.task_id) return null;
  const task = getTask(db, taskId)!;
  return `## Your team
This task belongs to a top-level ask managed by supervisor task \`${thread.task_id}\`.
The manager is automatically notified about blockers, decisions, peer messages,
review handoffs, failures, and completions. Keep working without waiting for it,
but use the team instead of escalating routine uncertainty to the director:

  hive task send ${thread.task_id} "what you need, what you tried, and your recommendation"
  hive task list --project ${task.project_id}   # find a peer's task id
  hive task send <peer-task-id> "specific question or interface proposal"

Messages are durable and attributed to your task. When a teammate messages you,
reply with \`hive task send <their-task-id> "..."\`. Ask peers for missing
context, coordinate shared interfaces before coding across the seam, and report
the resolution to the manager. Do not run open-ended chat; one concrete question,
answer, and next action is usually enough.`;
}

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
  const displayId = taskIdentifier(db, task);
  parts.push(`# Task ${displayId}: ${task.title}`);
  parts.push(`Task identifier: ${displayId}\nLegacy task number: ${task.number}\nTask id: ${task.id}\nKind: ${task.kind}`);
  parts.push(`## Brief\n${task.brief?.trim() || "(no description provided)"}`);
  parts.push(definitionOfDone(task.kind));
  parts.push(EMIT_PROTOCOL);
  parts.push(PLAIN_ENGLISH);
  parts.push(CHECKPOINTS);
  parts.push(spawnTasksSection(task.project_id));
  const team = teamSection(db, taskId);
  if (team) parts.push(team);
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

  // Project history grows without bound, so briefs carry counts and retrieve
  // task-relevant facts on demand instead of replaying the whole store.
  const knowledge = db
    .query("SELECT kind, COUNT(*) AS count FROM learnings WHERE project_id = ? AND status = 'active' GROUP BY kind")
    .all(task.project_id) as { kind: string; count: number }[];
  if (knowledge.length) {
    const counts = Object.fromEntries(knowledge.map((row) => [row.kind, row.count]));
    parts.push(`## Project knowledge (recall, then act)
Hive has ${counts.reference ?? 0} references, ${counts.decision ?? 0} past decisions, and ${counts.failure ?? 0} failure patterns for this project. Before guessing, asking, or repeating an old failure, search with task-specific keywords:

  hive recall <keywords>`);
  }

  return parts.join("\n\n") + "\n";
}
