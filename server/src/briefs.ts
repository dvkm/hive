// Brief composition. Composed fresh at spawn time (Phase 2) and exposed at
// GET /api/tasks/:id/brief. Pure function of DB state.
import type { DB } from "./db.ts";
import { getTask } from "./state.ts";
import { prTitlePrefix, prBodyFooter } from "./marker.ts";
import { managingThreadForTask } from "./chat.ts";

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
If \`hive\` is not on your PATH, run it as \`"$HIVE_CLI"\` (set in your env), e.g.
\`"$HIVE_CLI" emit <task-id> status --note "..."\` — same for \`hive task create\`
and \`hive pr-marker\`. Prefer the CLI over raw curl: it attributes what you do.

  hive emit <task-id> status   --note "what you just did / are doing"
  hive emit <task-id> evidence --file ./screenshot.png --note "caption"
  hive decision ask <task-id> --title "..." --option k:label:detail ...   (opens a card AND parks the task — see below)
  hive emit <task-id> blocked  --note "why you are stuck"
  hive emit <task-id> ready    --pr-url <url> --note "PR <url>"   (hand off for review)
  hive emit <task-id> done     --note "final summary"

Rules:
- BEFORE any command expected to run more than a minute (builds, full test
  suites, e2e, docker up), emit status first, e.g.
  \`hive emit <task-id> status --note "running e2e (~5m)"\` — a silent long
  command looks stuck and triggers supervisor nudges (one agent ate 10).
- A task NEVER reaches Done without evidence. Attach at least one evidence item
  (screenshot, test run, log, report, or link) before emitting \`done\`.
- Attach evidence BEFORE \`ready\`, not just before done — the review card shows
  it to the director next to your diff. Anything visual gets a screenshot
  (before/after for changes to existing UI); everything else gets test output.
- Scout tasks (knowledge-only) require a written report as evidence.
- HAND OFF, don't go idle. When your PR is open (or, for a scout, your report
  is attached), emit \`hive emit <task-id> ready --pr-url <url>\`. Review means
  CI IS GREEN: if checks are still running or failing, the handoff is HELD and
  the response tells you — stay on the task. hive moves it to review
  automatically the moment checks pass, and steers you if they fail; fix and
  push until green. Never sit idle with red CI.
- BEFORE \`ready\`, submit a structured self-review — the director reviews THIS,
  not your prose, so keep every bullet one tight line:

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
  \`understanding.checks\` is REQUIRED for every review, including report-only
  work. Provide 1-5 questions. Use one for a single, straightforward takeaway;
  add more only when each tests a distinct decision-relevant idea, angle, or
  scenario, never superficial rewordings. Each needs 2-4 plausible options and
  a short teaching explanation. Hive rotates questions
  after a miss and shuffles option order, so never depend on answer position.
  Keep each question and option complete and under 500 characters.
  For a report, make the packet read like a compact impact
  analysis: background = why the report was commissioned and relevant prior
  context, scope = investigation boundaries, essence = headline finding,
  walkthrough = evidence chain, affected_areas = blast radius,
  risk_assessment = confidence and uncertainty, and participate = recommended
  next decision. Then test decision-relevant takeaways. Keep the whole
  packet short and teach only the background needed.
  Honesty rule: "iffy" is MANDATORY when anything is uncertain, hacky, or has a
  known ceiling — an empty iffy list on risky work reads as hiding it.
- When you hit a decision the director must make, open a REAL decision card with
  concrete options — never bury a question in a status note or review summary
  (text questions can't be answered with a click):

    hive decision ask <task-id> --title "one specific question" \\
      --option key1:Label:"what choosing this means" --option key2:Label:"..." \\
      --recommend key1

  One card per question, 2-4 options each, always include your recommendation.
  \`hive decision ask\` already parks the task in \`needs_decision\` — don't also
  emit \`needs-decision\` for the same question, it opens a second, redundant
  card (two entries for one decision). Stop and wait for the answer if you
  can't proceed without it; keep working on other parts if you can.
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
  parts.push(`# Task #${task.number}: ${task.title}`);
  parts.push(`Task number: ${task.number}\nTask id: ${task.id}\nKind: ${task.kind}`);
  parts.push(`## Brief\n${task.brief?.trim() || "(no description provided)"}`);
  parts.push(definitionOfDone(task.kind));
  parts.push(EMIT_PROTOCOL);
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

  // Project reference: durable facts (design files, dashboards, glossary). The
  // brief carries only the INDEX (titles) so it stays small as the store grows;
  // the agent pulls the full fact on demand with `hive recall`. Short reference
  // bodies (a bare URL / one line) are shown inline — no round-trip for those.
  const references = db
    .query("SELECT title, body FROM learnings WHERE project_id = ? AND kind = 'reference' AND status = 'active' ORDER BY first_seen")
    .all(task.project_id) as { title: string; body: string | null }[];
  if (references.length) {
    const line = (r: { title: string; body: string | null }) => {
      const b = (r.body ?? "").trim();
      return b && b.length <= 120 && !b.includes("\n") ? `- **${r.title}** — ${b}` : `- **${r.title}**`;
    };
    parts.push(
      `## Project knowledge (search it — DON'T ask the director for what's here)
This project has stored references, past-failure learnings, and policies. Before
you assume, guess, or ask the director something a teammate would already know,
search them:

  hive recall <keywords>          # e.g. hive recall figma design, hive recall migration

Reference facts on file (run \`hive recall\` for the full detail of any):
${references.map(line).join("\n")}`
    );
  }

  // Answers to past decision cards — so this crew consults the prior ruling
  // before raising the same question again. Indexed by question (+ a short
  // answer inline); the full note is one `hive recall` away.
  const decisions = db
    .query(
      "SELECT title, body FROM learnings WHERE project_id = ? AND kind = 'decision' AND status = 'active' ORDER BY last_seen DESC LIMIT 12"
    )
    .all(task.project_id) as { title: string; body: string | null }[];
  if (decisions.length) {
    const line = (d: { title: string; body: string | null }) => {
      const a = (d.body ?? "").replace(/\n/g, " ").trim();
      return a && a.length <= 140 ? `- **${d.title}** — ${a}` : `- **${d.title}**`;
    };
    parts.push(
      `## Decisions already made (don't re-ask — recall, then act)
The director already answered these for this project. Before you raise a
decision card, check whether it's already settled here (or via \`hive recall\`):
${decisions.map(line).join("\n")}`
    );
  }

  // Known failure patterns: active FAILURE learnings, 10 most recent.
  const learnings = db
    .query(
      "SELECT title, body, occurrences FROM learnings WHERE project_id = ? AND kind = 'failure' AND status = 'active' ORDER BY last_seen DESC LIMIT 10"
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
