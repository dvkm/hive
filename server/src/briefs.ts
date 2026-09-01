// Brief composition. Composed fresh at spawn time (Phase 2) and exposed at
// GET /api/tasks/:id/brief. Pure function of DB state.
import type { DB } from "./db.ts";
import { getTask, isSelfAuditLineage } from "./state.ts";
import { prTitlePrefix, prBodyFooter } from "./marker.ts";
import { managingThreadForTask } from "./chat.ts";
import { PLAIN_ENGLISH } from "./plainEnglish.ts";
import { taskIdentifier } from "./taskIdentifier.ts";
import { planGateKinds, planGateBlocks } from "./planCritic.ts";
import { figmaTokenEnv } from "./secrets.ts";
import { matchPlaybook, playbookSection } from "./playbook.ts";

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
Use the \`hive\` CLI so actions are attributed. If it is not on PATH, use
\`"$HIVE_CLI"\`.

  hive emit <task-id> status   --note "what you just did / are doing"
  hive emit <task-id> evidence --file ./screenshot.png --note "caption"
  hive emit <task-id> blocked  --note "why you are stuck"
  hive emit <task-id> ready    --pr-url <url> --note "PR <url>"   (hand off for review)

If your task's own PR closes with nothing left to merge (head==base, so GitHub
refuses to reopen it) but the work landed elsewhere, close it with the verified
landing commit:

  hive emit <task-id> unmergeable --landing-commit <sha> --note "why"

Rules:
- Emit status before commands expected to exceed a minute.
- Commit and push FIRST, then attach evidence, review, and \`ready\`. Evidence is
  tied to the commit it was captured on, so a push after it leaves it behind and
  the handoff is refused. If you do push again, re-capture the evidence.
- Attach evidence before \`ready\`: screenshots for visual work, test output
  otherwise. Scout tasks require a report. A task never reaches Done without evidence.
- Hand off with \`ready\` when the PR is open. If CI is pending, END THE TURN;
  hive monitors it and wakes you only if action is needed. If CI fails, fix it.
- Before \`ready\`, submit a concise structured self-review:

    hive emit <task-id> review_summary --json review.json

  Write review.json inside your own worktree or session scratchpad, never a
  shared path like /tmp/review.json. Hive refuses a payload it reads from
  anywhere else: two agents sharing one path published each other's reviews.

  Shape: {"done":[],"iffy":[{"what":"","why":""}],"decisions":[],
  "testing":[],"followups":[],"understanding":{"background":"","scope":"",
  "essence":"","walkthrough":[],"affected_areas":[],"risk_assessment":"",
  "participate":"","checks":[{"question":"","options":[{"key":"a",
  "label":""},{"key":"b","label":""}],"answer_key":"a","explanation":""}]}}
  Omit empty sections. \`understanding.checks\` is REQUIRED only for
  judgment-class work: the auto-review verdict is not \`looks_good\`, the diff
  touches security, auth, payments or migrations, the task kind is outside the
  project's auto-merge list, or the director asked for a quiz on this card. For
  everything else the checks are OPTIONAL, and leaving them out blocks nothing.
  Every question must help them understand this specific change: behavior, impact, risk,
  tradeoff, or evidence. Never test whether the agent can code, debug, merge,
  use tools, follow policy, or operate Hive; agent competence belongs in internal
  checks. Never quiz project bookkeeping. If it does not improve the director's
  understanding of this review, omit it. Include \`iffy\` for every real uncertainty.
  Write every question and option in plain everyday words: one idea per sentence,
  no nested clauses. Use jargon only if the diff itself introduces the term, and
  then define it in the question or explanation. Make each option plainly
  distinct from the others, not near-duplicates. Length follows the content, not
  a cap: a simple change earns a short question, a genuinely complex change can
  take the words it needs. Write background, essence, walkthrough, and
  participate the way you would explain the change to a colleague on the phone:
  clarity first, brevity second.
- When you hit a decision the director must make, open a REAL decision card with
  2-4 concrete options and a recommendation:

    hive decision ask <task-id> --title "one specific question" \\
      --context "why this surfaced, what changes, and your recommendation" \\
      --option key1:Label:"what choosing this means" --option key2:Label:"..." \\
      --recommend key1

  Context must stand alone without opening the task. This command parks the task,
  so do not emit a duplicate needs-decision event.
- On REQUESTS CHANGES, emit status with what you will change, then fix and emit
  \`ready\` again. Answer director questions with \`hive emit <task-id> answer
  --note "..."\`; pane prose and status notes do not deliver answers.
- Work ONLY inside your own worktree and scratchpad. NEVER create, edit, or
  delete files in main, other worktrees, or the human's home. Kill only your own
  shell jobs or pidfile-owned processes; broad process kills require approval.`;

// Live checklist: judgment calls surface DURING the build (the director ticks
// or flags them from the board), not as a surprise at review time. Flags come
// back as steer messages; checkpoints never block.
const CHECKPOINTS = `## Checkpoints (surface choices WHILE you build)
Emit assumptions, shortcuts, and real tradeoffs when you make them, then KEEP WORKING:

  hive emit <task-id> checkpoint --note "the choice + why, one line"

Checkpoints are non-blocking; flags return as steers. Prod, destructive work,
and feature flags still use \`hive decision ask\` or the guarded-action gate.`;

// Plan gate (HIVE-412): for the kinds a project opts in via config.plan_gate,
// the plan is posted as a checkpoint before the first edit, and hive critiques
// it automatically. Nothing blocks; a serious concern comes back as a steer.
// With plan_gate.block on (HIVE-413) the last paragraph is swapped for a wait
// instruction — see BLOCKING_PLAN_TAIL.
const PLAN_CHECKPOINT = `## Plan checkpoint (before your first edit)
Post your plan before you change any file:

  hive emit <task-id> checkpoint --json plan.json

Write plan.json first, with exactly these fields:

  {"kind":"plan",
   "goal":"what done looks like, in one sentence",
   "approach":"how you will get there, in a few sentences",
   "files_expected":["path/to/file.ts"],
   "verification_planned":"the check that proves it works"}

Hive reviews the plan and sends any concerns back as a steer. Keep working
while it reviews; this checkpoint never blocks you. If a concern comes back,
fix the plan and post it again before you carry on editing.`;

// Blocking mode. The agent posts the plan and then STOPS. The director's ack
// (or the auto-ack sweep) delivers a steer that releases it, so the only safe
// thing an agent can do here is end its turn and wait to be woken.
const BLOCKING_PLAN_TAIL = `This project BLOCKS on the plan. After you post it, do NOT edit any file.
Emit the plan, say in one line that you are waiting, and END YOUR TURN.

A steer wakes you with the verdict:
- "Your plan is APPROVED" — start editing and finish the task.
- "Your plan was FLAGGED" — fix the plan, post it again, and wait again.

Do not poll, do not ask again, and do not start work while you wait.`;

// The non-blocking tail, replaced wholesale in blocking mode.
const PLAN_TAIL_OPEN = `Hive reviews the plan and sends any concerns back as a steer. Keep working
while it reviews; this checkpoint never blocks you. If a concern comes back,
fix the plan and post it again before you carry on editing.`;

// Agents may fan work out instead of scope-creeping their own task. HIVE_TASK_ID
// is set in every spawned agent's env, so the CLI auto-attributes the new task
// (source=agent, parent_task_id → this task).
function spawnTasksSection(projectId: string): string {
  return `## Spawning follow-up tasks
Queue out-of-scope bugs, missing tests, and follow-ups instead of expanding this task:

  hive task create --project ${projectId} \\
    --title "short imperative title" \\
    --brief-text "what, where (files/paths), why, and the definition of done" \\
    --kind ship|scout|chore

Make the brief self-contained with paths, repro steps, and done criteria. Record
non-obvious gotchas and durable project facts for later recall:

  hive learning add --project ${projectId} --kind failure --title "one-line pattern" --body "the fix / what to know"

  hive learning add --project ${projectId} --kind reference --title "what it is" --body "the fact / link"
Mechanical spawn, merge, and smoke failures are recorded automatically.`;
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
Interactive browser MCPs (claude-in-chrome, computer-use) are denied because
their dialogs strand unattended workers. Verify web changes headlessly:

  curl -sS -i http://127.0.0.1:<port>/<path>        # status, headers, HTML, JSON
  bunx playwright screenshot --viewport-size="1280,800" <url> out.png

Prefer an existing Playwright or Puppeteer setup. If invoking Chromium
directly, include its \`--headless\` flag. Attach the result:

  hive emit <task-id> evidence --file out.png --note "logged-in dashboard"`;

// Figma access for headless agents. The Figma MCP needs interactive auth, so a
// spawned agent can never use it; without this section agents guess at UI and
// it drifts from the design. Only shown when hive actually has a token to pass
// through (see figmaTokenEnv), otherwise the instructions would just fail.
function figmaSection(): string | null {
  if (!figmaTokenEnv().FIGMA_TOKEN) return null;
  return `## Figma (headless, no MCP)
The Figma MCP needs interactive login, so you cannot use it. Your env has
\`FIGMA_TOKEN\`. Read frames straight from the Figma REST API instead:

  curl -sS -H "X-Figma-Token: $FIGMA_TOKEN" \\
    "https://api.figma.com/v1/files/<fileKey>/nodes?ids=<nodeId>"      # spec JSON
  curl -sS -H "X-Figma-Token: $FIGMA_TOKEN" \\
    "https://api.figma.com/v1/images/<fileKey>?ids=<nodeId>&format=png" # PNG render URL

The file key and node id are in the frame's Figma URL
(\`figma.com/design/<fileKey>/...?node-id=<nodeId>\`; turn \`1-23\` into \`1:23\`).
If the repo ships its own helper, prefer it (corebeat has
\`scripts/figma-frame.sh\`). Check the frame BEFORE building or changing UI, and
attach the render as evidence. Never print, commit, or echo the token.`;
}

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

// The task's verification contract, when the director set one. Named commands
// the agent runs before handing off, each with its real output attached back
// under the same name. Nothing is gated on this yet (see HIVE-401 A2) — the
// brief just states the contract.
function verificationContract(taskId: string, cmds: { name: string; cmd: string }[] | null): string | null {
  if (!cmds?.length) return null;
  const lines = cmds.map((c) => `- \`${c.name}\`\n\n      ${c.cmd}`).join("\n\n");
  return `## Verification contract (run every one before \`ready\`)
This task has ${cmds.length} named verification command${cmds.length === 1 ? "" : "s"}. Run each one
exactly as written, from your worktree, before you emit \`ready\`:

${lines}

Attach the REAL output of each run as evidence, tagged with its name:

  hive emit ${taskId} evidence --verify-name <name> --file ./out.txt --note "<name> output"

Use the exact name from the list. Do not paraphrase, summarize, or invent
output — attach what the command actually printed. If a command fails, fix the
cause and run it again, or emit \`blocked\` explaining why it cannot pass.`;
}

function definitionOfDone(db: DB, task: { id: string; kind: string; source?: string | null }): string {
  if (isSelfAuditLineage(db, task)) {
    return "## Definition of done\nIf the audit finds no safe material improvement, attach the findings as report evidence and emit `done` without changing code. Otherwise, merge one evidence-backed optimization through the normal ship path.";
  }
  if (task.kind === "scout") {
    return "## Definition of done\nA written report captured as evidence (kind=report) that answers the question. No code changes required.";
  }
  if (task.kind === "chore") {
    return "## Definition of done\nThe chore is complete with at least one evidence item showing the result (log, screenshot, or test run).";
  }
  return "## Definition of done\nCode merged (PR open -> reviewed -> verifying -> done), post-merge smoke checks pass, and at least one evidence item is attached. No task reaches Done without evidence.";
}

// Compose the full agent brief. Stored knowledge stays behind `hive recall` so
// the prompt cost does not grow with the project history.
export function composeBrief(db: DB, taskId: string): string {
  const task = getTask(db, taskId);
  if (!task) throw new Error(`unknown task: ${taskId}`);

  const projectScope = `project:${task.project_id}`;

  const parts: string[] = [];
  const displayId = taskIdentifier(db, task);
  parts.push(`# Task ${displayId}: ${task.title}`);
  parts.push(`Task identifier: ${displayId}\nLegacy task number: ${task.number}\nTask id: ${task.id}\nKind: ${task.kind}`);
  parts.push(`## Brief\n${task.brief?.trim() || "(no description provided)"}`);
  parts.push(definitionOfDone(db, task));
  const contract = verificationContract(task.id, task.verification_cmds);
  if (contract) parts.push(contract);
  parts.push(EMIT_PROTOCOL);
  parts.push(PLAIN_ENGLISH);
  parts.push(CHECKPOINTS);
  const project: any = db.query("SELECT config FROM projects WHERE id = ?").get(task.project_id);
  const projectConfig = JSON.parse(project?.config ?? "{}");
  if (planGateKinds(projectConfig).includes(task.kind))
    parts.push(
      planGateBlocks(projectConfig, task.kind)
        ? PLAN_CHECKPOINT.replace(PLAN_TAIL_OPEN, BLOCKING_PLAN_TAIL)
        : PLAN_CHECKPOINT
    );
  parts.push(spawnTasksSection(task.project_id));
  const team = teamSection(db, taskId);
  if (team) parts.push(team);
  parts.push(prMarkerSection(task.number, task.id));
  parts.push(BROWSER_VERIFICATION);
  const figma = figmaSection();
  if (figma) parts.push(figma);

  // Standing authority: which scoped rules govern this agent + the guarded-action
  // protocol it MUST use before any externally-risky operation it runs itself.
  parts.push(standingAuthority(db, task.project_id, task.id));

  // A past task like this one may have left a recipe. Inline the single best
  // match (steps included) instead of trusting the crew to guess the keywords
  // that would have recalled it.
  const playbook = matchPlaybook(db, task.project_id, `${task.title} ${task.brief ?? ""}`);
  if (playbook) parts.push(playbookSection(playbook));

  // Project history grows without bound, so briefs carry counts and retrieve
  // task-relevant facts on demand instead of replaying the whole store.
  const knowledge = db
    .query("SELECT kind, COUNT(*) AS count FROM learnings WHERE project_id = ? AND status = 'active' GROUP BY kind")
    .all(task.project_id) as { kind: string; count: number }[];
  const policyCounts = db
    .query(
      `SELECT
         COALESCE(SUM(scope = 'global'), 0) AS global_count,
         COALESCE(SUM(scope = ?), 0) AS project_count
       FROM policies WHERE active = 1 AND (scope = 'global' OR scope = ?)`
    )
    .get(projectScope, projectScope) as { global_count: number; project_count: number };
  if (knowledge.length || policyCounts.global_count || policyCounts.project_count) {
    const counts = Object.fromEntries(knowledge.map((row) => [row.kind, row.count]));
    parts.push(`## Project knowledge (recall, then act)
Hive has ${policyCounts.global_count} global policies, ${policyCounts.project_count} project policies, ${counts.reference ?? 0} references, ${counts.decision ?? 0} past decisions, and ${counts.failure ?? 0} failure patterns. Before coding, guessing, asking, or repeating an old failure, retrieve only the matching guidance with task-specific keywords:

  hive recall <keywords>`);
  }

  return parts.join("\n\n") + "\n";
}
