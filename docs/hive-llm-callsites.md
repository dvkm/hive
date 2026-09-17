# Hive LLM call-site inventory — candidates for a typed judgment model (TypeSafe Jev)

Repo: `/Users/david/projects/hive/.claude/worktrees/hive-performance-bottlenecks-26e598`
Read-only survey, 2026-09-17. Line numbers are from this worktree.

## Shape of the surface

Every model call in hive is a shell-out: `claude -p <prompt> --output-format json`, spawned via
`defaultPlannerExec` (`server/src/planner.ts`). There is **one** spawn helper and **one** parser:

- `server/src/planner.ts:37` `claudeBin()` — resolves the binary.
- `server/src/planner.ts:232` `parseModelJson(raw, normalize)` — three-tier loose parse: whole-string
  JSON → the `{result:"..."}` envelope → a first-`{`-to-last-`}` braces slice. Every structured call
  site funnels through it with its own normalizer.
- `server/src/modelCall.ts` — the single failure/health/auth-alert path (`noteModelCall`,
  `modelFailure`, `isAuthFailure`).
- `server/src/teamclaude.ts` — injects the TeamClaude proxy env (`HTTPS_PROXY` / `ANTHROPIC_BASE_URL`)
  into every one-shot when the proxy is up. Hive never reads a port number itself; it parses
  `teamclaude env`. **There are no per-call counters on the hive side of the proxy.**

There are **14 distinct prompt-and-parse call sites** (12 files). Nothing uses a streaming or
agentic API for judgment except the two that deliberately want tool use
(`intentInvestigate`, `explainDiff`) and the worker runtime (`runtime/claudeStream.ts`, out of scope).

## Inventory

| # | file:line | state in prompt | asked for | parse | model | frequency | verdict |
|---|---|---|---|---|---|---|---|
| 1 | `server/src/intake/triage.ts:164` (prompt `:82`, parse `:116`) | task title + brief (4 000 chars). `NO_TOOLS`. | `bucket`: mechanical \| decision_required; on decision: a question, 2-4 interpretations, a recommendation, one-sentence reasoning | `extractTriage` → own 3-tier JSON parse, enum-checked on `bucket`, drops the card if <2 interpretations | sonnet, 60 s | once per ambient intake task (gchat msg, watched doc), opt-in `config.intake_triage` | **PARTIAL** — the `bucket` half is a textbook Noul ("does this request have more than one reasonable reading?"). Fail-open already means a cheap wrong answer is tolerated. The question + interpretations are generated prose → stay on Claude, but only fire when the Noul says ambiguous. Biggest single win: today every ambient task pays a sonnet call to learn "mechanical". |
| 2 | `server/src/reviewer.ts:316` (prompt `:108`, parse `:63`) | task number/title, brief (4 000), PR diff (60 000, retry 15 000), PLAIN_ENGLISH | `verdict`: looks_good \| caution + `summary` (2-3 sentences) + `risks[]` + `questions[]` | `extractReview` via `parseModelJson`; verdict coerced (anything ≠ "caution" → looks_good) | `config.model_by_kind.review` ?? sonnet, 180 s | per task entering `in_review`, per PR head; loop every 60 s, `REVIEW_CONCURRENCY = 4`, `MAX_REVIEW_ATTEMPTS = 2` | **KEEP** — the summary and the risk/question text are the product. The verdict is derived from the risk list, not independent. |
| 3 | `server/src/reviewer.ts:953` risk branch (prompt `verifyPrompt:741`, parse `extractVerdict:575`) | ONE risk string, task number/title, worktree path, branch commits, settled decisions, evidence captions, diff (60 000) | `verdict`: confirmed \| refuted + `why` (≤300 ch) + `evidence_path` | `parseModelJson`, hard enum: anything not exactly confirmed/refuted → null → counted `unverified` | **opus**, 180 s | one run **per risk**, `MAX_VERIFIED_RISKS = 5`, `RISK_CONCURRENCY = 2`, `MAX_VERIFY_ATTEMPTS = 3` per head. Nested inside the per-task fan-out → up to ~8 concurrent opus subprocesses | **PARTIAL, highest value** — the decision is a Noul ("is this flagged risk real, given the diff + these commits + these rulings?") and the whole downstream gate reads only the enum (`confirmedRisks`, `ambiguityCleared`). `why` is prose but only matters on `confirmed`. A Jev pre-judgment could refute the cheap ones and route only the survivors to opus. This is the most expensive judgment in hive: opus, per-finding, retried 3×. |
| 4 | `server/src/reviewer.ts:953` question branch (prompt `answerPrompt:768`, parse `extractAnswer:584`) | ONE question, task, worktree path, evidence captions, diff | `answerable`: machine \| human + `answer` (≤300 ch) | `parseModelJson`, hard enum | opus, 180 s | as #3, `MAX_VERIFIED_QUESTIONS = 5` | **PARTIAL** — same shape. "Can this question be settled by reading the repo, or does it need the director?" is a Choice over 2. The prompt even says "if unsure, say human", i.e. a probability threshold in prose. |
| 5 | `server/src/intentDraft.ts:151` (prompt `:85`, parse `:113`) | ticket title, description, comments (20 000 chars) | the five intent headings + `open_questions[]` | `parseModelJson` + `normalize`; falls back to a lossless deterministic body on any failure | sonnet, 120 s | once per intent draft (Jira import, director brief, agent follow-up) | **KEEP** — generated prose under five headings, no fixed answer set. |
| 6 | `server/src/intentDraft.ts:299` `mintIntentChecks` (prompt ~`:230`, parse `:262`) | the accepted intent body | up to 3 quiz questions, each 2-4 options + `answer_key` + explanation | `normalizeChecks`: validates `answer_key ∈ options`, ≥2 options, caps at 3/4 | sonnet, 120 s | once per accepted intent | **KEEP** — authoring questions is generation. |
| 7 | `server/src/intentInvestigate.ts:65` (prompt `:79`, parse `:119`) | the draft's five sections, the raw request, a graft how-to when `graft/INDEX.md` exists | rewritten sections + `findings[]` + `open_questions[]` (empty array = auto-accept) | `normalizeInvestigation` via `parseModelJson`; `open_questions: null` means "model didn't say" and the draft keeps its own | sonnet (`HIVE_INTENT_INVESTIGATOR_MODEL`), **10 min**, `--max-turns 40`, read-only tool allowlist | loop every 60 s, concurrency 2, **exactly once per draft ever** (the `intent_investigated` event is the ledger) | **KEEP** — real tool use over the checkout. But see #7b. |
| 7b | `intentInvestigate.ts:250` (the auto-accept branch) | — | — | pure code: `openQuestions(body).length === 0 → accept` | none | per investigation | **OFFLOADABLE (per question)** — the accept/hold call is made by counting the strings the investigator returned. A Noul per surviving question ("must a *person* decide this, or does the code settle it?") is a second, independent read that would stop the investigator's own enthusiasm from auto-accepting a draft it shouldn't. |
| 8 | `server/src/drift.ts:355` (prompt `driftPrompt` ~`:200`, parse `:100`) | brief (4 000), direction since brief (12 steers/decisions × 700 ch), file list, commit subjects, sampled added lines (8/file, 200 total), `NO_TOOLS` | `drifting`: bool + `beyond[]` + `why` (≤30 words) | `extractDrift` via `parseModelJson`; requires `typeof o.drifting === "boolean"` | `config.model_by_kind.drift` ?? sonnet, 300 s | every `scope_drift_commits` (default 3) commits on a live branch; loop 60 s, **one task per pass**, once per task ever (a card ends it) | **PARTIAL** — `drifting` is a Noul over supplied state, and the file header explicitly argues that no path heuristic discriminates so a *judge* is needed. `beyond`/`why` are the card copy. Note the deterministic post-filter `splitByDirection:264` already overrides the model on paths a steer named. |
| 9 | `server/src/planCritic.ts:153` (prompt `:96`, parse `:114`) | task title, brief (8 000), the plan checkpoint JSON | `concerns[]`, each `severity`: note \| veto + one sentence | `extractConcerns` via `parseModelJson`; severity coerced (≠ veto → note) | sonnet, 60 s | once per plan checkpoint, only for `config.plan_gate.kinds` | **PARTIAL** — the veto/note split is a Score on two ordered levels, and only `veto` has an effect (it steers the agent). The concern text is prose. A Noul "would this plan miss the brief badly enough to interrupt?" could gate the whole call. |
| 10 | `server/src/explain.ts:43` (prompt inline `:31`, parse `:65`) | one shell command string (4 000 ch) | first line `VERDICT: zero-risk \| real-risk`, then 2-3 bullets | **regex over free text**: `/^VERDICT:\s*(zero-risk\|real-risk)\s*$/im`, then the verdict line is stripped for display | **haiku**, 60 s | per gated-command decision card, fire-and-forget | **PARTIAL, cleanest split in the repo** — the verdict is already a binary parsed by regex out of prose. Jev Noul for `zero-risk`; the bullets stay generated. (The comment says "~a cent", so the saving is latency and the removal of a regex-over-prose parse, not dollars.) |
| 11 | `server/src/playbook.ts:165` (prompt `:106`, parse `:36`) | finished task's brief (6 000), key events, diff stat (8 000) | title, when_to_use, steps[], gotchas[], success_criteria[] | own 3-tier parse; rejects empty `steps` | `config.model_by_kind.playbook` ?? sonnet, 180 s | on demand, per done task promoted to a playbook | **KEEP** — pure generation. |
| 12 | `server/src/explainDiff.ts:217` | task, full PR diff (200 000 ch), the review's understanding checks, `NO_WRITE_TOOLS` | a complete self-contained interactive HTML page | `extractHtml:190` — searches for `<!doctype html\|<html`, slices to the last `</html>` | **opus**, **15 min** | once per PR head before review handoff | **KEEP** — generation plus exploration. (Largest single spend per task in the system.) |
| 13 | `server/src/planner.ts:299` (prompt `composePlannerPrompt`, parse `extractPlan:253`) | project brief + task context + pinned learnings | `proposed_tasks[]` ({title, brief, kind ∈ ship/scout/chore}), `rationale`, `questions[]` | `parseModelJson` + `normalize`; kind enum-coerced to "ship" | sonnet (`DEFAULT_ARGV:79`) or `config.planner_argv`, timeout configurable | per `POST /plan` and per auto-intake breakdown | **PARTIAL** — only the per-task `kind` field is a fixed-set answer over given state (a Choice over 3). Everything else is generation. Low value on its own; worth it only if the kind is later shown to be miscalled (it drives `auto_merge.kinds`). |
| 14 | `server/src/runtime/claudeStream.ts:104` | — | the worker agent itself | stream-json protocol | per-project | long-lived, one per task | **KEEP** — not a judgment call site. |

### Judgments made today with regex/heuristics that a typed model would do better

These are not LLM call sites, but they are the same *kind* of question, currently answered by a
regex, and they feed the same gates. Worth listing because they are the cheapest places to prove Jev
out — no model call to remove, just a heuristic to replace.

| file:line | what it decides | how | verdict |
|---|---|---|---|
| `server/src/policy.ts:52-54` `PROD_RE` / `SHARED_RE` / `IRREVERSIBLE_RE` | blast radius (local/shared/prod) and reversibility of a proposed plan, from the concatenated task titles + briefs | three regexes over free text | **OFFLOADABLE** — Choice over `{local, shared, prod}` and a Noul for reversible. Feeds `classifyEscalation`, which decides auto_handle vs the decision inbox. |
| `server/src/policy.ts:66` `NEEDS_INPUT_RE` | "would answering this option require the director to hand over a credential/file?" | one long regex over label+detail | **OFFLOADABLE** — a Noul. The comment names the incident it exists for (`dec_8f964774097e`). |
| `server/src/autoapprove.ts:39` `riskLevel()` | normalizes an agent's free-text `risk` field to low/normal/medium/high | `^(low\|normal\|medium\|high)\b` else **"high"** | **OFFLOADABLE** — a Score on ordered levels. The comment says three genuinely-high cards slipped through an exact match; today anything unparseable is forced to "high", i.e. the heuristic is knowingly lossy. |
| `server/src/autoapprove.ts:54-55, 105` | prod/shared blast radius of a decision card's `blast_radius` free-text field | two more regexes (a second copy of policy.ts's) | **OFFLOADABLE** — same Choice; two copies of the same question is itself the argument for one typed judgment. |
| `server/src/dedup.ts:43` `titleSimilarity` | duplicate task detection; ≥0.6 opens a card, ≥0.8 recommends merge (and ≥0.8 is what `evaluateAutoApprove` treats as confident enough to auto-merge) | word-set Jaccard | **PARTIAL** — "are these two tasks the same ask?" is a Noul whose probability maps directly onto the two existing thresholds. The `ponytail:` comment already flags the no-stopword ceiling. |
| `hooks/classify.ts:30+` | Bash command → safe / dangerous / unknown, the PreToolUse auto-approval boundary | ~25 denylist regexes + an allowlist, whole-command then per-segment | **KEEP as-is, PARTIAL at most** — this is a safety boundary that must be deterministic and offline. A typed model could be added *after* the regexes to shrink "unknown" (which today escalates), never to override "dangerous". |

---

## Product area 1 — Intent investigator

**Files:** `server/src/intentInvestigate.ts`, `server/src/intentDraft.ts`, `server/src/intents.ts`,
wired at `server/src/index.ts:246-248`.

How it decides today:

1. A ticket arrives. `draftIntentBody` (`intentDraft.ts:143`) runs **one sonnet call** to map the
   raw text into five fixed headings. It never invents: a failure writes the request verbatim under
   "## Problem". The draft **always** carries at least one open question — if the model returns none,
   `normalize` (`intentDraft.ts:112`) injects `DEFAULT_OPEN_QUESTION` ("Is this the ask, and what does
   done look like?"), because the acceptance gate is the point.
2. `startIntentInvestigator` (`:269`) polls every 60 s (first run after 15 s), concurrency 2.
   `pendingInvestigations` (`:182`) selects `status='draft' AND source IN ('jira','director')` with
   **no `intent_investigated` event** — that event is the ledger, written on failure too, so a broken
   model call never retries. Drafts with no anchor task are skipped.
3. One **read-only sonnet agent** runs in the project's checkout: `--max-turns 40`, 10 min timeout,
   `--allowedTools Read Grep Glob Bash(graft:*) Bash(git log:*) Bash(git grep:*) Bash(git show:*)
   Bash(ls:*)`, MCP stripped. Read-only by construction — `-p` cannot answer a permission prompt.
   If `graft/INDEX.md` exists the prompt prepends a graft how-to (`GRAFT_HOW:71`).
4. Output is strict JSON: the five sections rewritten, `findings[]` (each with file:line), and
   `open_questions[]` — *"ONLY what a person must decide"*, empty array when nothing remains.
   `normalizeInvestigation:119` maps a missing/non-array `open_questions` to `null`, which means
   "the model did not say" and the draft keeps its own questions.
5. Two concurrency guards before the write: the intent must still be `draft`, and its `body_md` must
   be byte-identical to what was read — a human's edit during the run outranks the model.
6. **The verdict:** `investigatedBody` renders the new body, and then
   `if (openQuestions(body).length === 0) await deps.accept(intent.id)` (`:250`) — auto-accepted as
   `accepted_by: "hive"`, which is what generates the work brief and lets the task start.

So the accept decision is *not* a separate judgment. It is a string-count over a list the same model
wrote in the same breath. Kill switch: `HIVE_INTENT_INVESTIGATE=0`.

**Where a typed judgment fits.** Keep the investigation (real tool use). Add a Noul per surviving
question — "does this need a person, or does the code settle it?" — as an independent second opinion
before `accept()`. Today one model's enthusiasm both removes the questions and unlocks the work.

---

## Product area 2 — Decision inbox

**Files:** `server/src/api.ts:8642` `createDecision`, `server/src/policy.ts`,
`server/src/autoapprove.ts`, `web/src/lib/needsYou.ts`, `server/src/attention.ts`.

**Creation.** 19 call sites (`learn.ts:111`, `authority.ts:265/373`, `landQueue.ts:479`,
`dedup.ts:157`, `costs.ts:75/196`, `drift.ts:393`, `repoTarget.ts:102`, `planner.ts:329`,
`servingBranch.ts:128`, `race.ts:279`, `reconciler.ts:2559`, `intake/triage.ts:207`, plus four in
`api.ts`). A row carries `title`, `context`, `risk` (**free text**), `blast_radius` (**free text**),
`options[]`, and an optional `decision_class`. Raising a card transitions an `in_progress` task to
`needs_decision`; a queued one stays queued.

**Ordering.** Entirely deterministic, no model involved — `web/src/lib/needsYou.ts`:

- `orderFocusItems:82`: draft intents rank first and group by project (`intentRank`), then
  everything sorts by `focusItemKey`.
- `focusItemKey:39`: the item's timestamp **minus a priority head start** —
  `now: 3 days, next: 2, normal: 1, later: 0` (`PRIORITY_HEAD_START:32`). Priority is a head start,
  not a lane: an old low-priority item eventually outranks a stream of urgent ones.
- `server/src/attention.ts` counts the same items through the same function (deliberately — a count
  that disagreed with the badge would be worse than none) and pauses only *optional* generators
  (queued scouts, watcher tasks) above `ATTENTION_BUDGET_DEFAULT = 5`.

**Surfacing / auto-answer.** `evaluateAutoApprove` (`autoapprove.ts:112`) is a closed allow-list with
two backstops: only the raiser's own `recommended` option may be auto-selected, and a pending
standing-authority grant can never be approved. `safetyBar:81` refuses a card with any
`decision_class` (intake triage stamps `TRIAGE_DECISION_CLASS`), demands an **explicit** `low`/`normal`
risk string, and regex-rejects prod/shared blast radius. Only three categories clear: reference
capture, a ≥0.8-similarity duplicate merge, and a recovery requeue.

**Where a typed judgment fits.** The inbox's *ordering* is fine as it is — deterministic and
explainable, leave it. The *classification feeding it* is the weak part: `risk` and `blast_radius`
arrive as agent-written free text and are then interrogated by regexes in two files
(`policy.ts:52-55`, `autoapprove.ts:54-55`) that do not agree on their patterns. A Score
(low/normal/medium/high) and a Choice (local/shared/prod) over the card's own text and task state
would replace both copies, and `optionNeedsDirectorInput` is a Noul. These are OFFLOADABLE with no
model call to remove — pure heuristic replacement, easy to A/B against stored cards.

---

## Product area 3 — Review land gate / auto-merge

Two models and five gates. Order of events for one task reaching `in_review`:

1. **Pre-review** (`reviewer.ts:316`, sonnet). Produces `auto_review` with
   `verdict ∈ {looks_good, caution}`, summary, `risks[]`, `questions[]`, plus `files[]` parsed from
   the diff. Two synthetic verdicts exist for failure: `unparseable` (two bad parses in a row,
   `:369`) and `unavailable` (retry budget spent, `:222`). Neither is treated as a pass by any gate.
   Guarded on both sides by `livePrHead` so a force-push mid-review can never land a stale verdict.

2. **Per-finding verification** (`reviewer.ts:953`, **opus**, `verifyRisks:820`). One run per risk
   (`extractVerdict` → confirmed|refuted) and per question (`extractAnswer` → machine|human), capped
   at 5 each, `RISK_CONCURRENCY = 2`, `MAX_VERIFY_ATTEMPTS = 3` per head, deduped by an in-memory
   `verifyInFlight` set. Prompts carry: the single finding, branch commits (`repairBlock:648` — "you
   are reading the branch AFTER this work landed"), the director's answered decisions
   (`settledBlock:667`), and the agent's evidence captions (`evidenceBlock:710`). Results land as one
   `risk_verdicts` event. A failed run counts as `unverified`, never as clear.
   `verifyPendingOnce:465` is the catch-up pass for reviews left uncovered.
   `requestRiskRecheck:859` lets the director set a whole verdict set aside by rowid floor —
   the re-run can still confirm the same risk.

3. **Clearance** (`reviewer.ts:1304` `ambiguityCleared`). Clears only when the verdict set covers
   **every** risk and question for **this exact head**, refuted every risk, and answered every
   question from the code. `cautionCleared:1293` adds: a `caution` with nothing listed was never
   verified at all, so it stays the director's call. `confirmedRisks:1281` is what the 409 on merge
   names.

4. **Understanding quiz** (`api.ts:5236` `understandingChecksRequired`). A task is judgment-class if
   **any** of: the latest review isn't `looks_good` (missing/errored/skipped/uncleared-caution all
   count); the reviewed diff touches a sensitive path (`DEFAULT_SENSITIVE_PATHS`, per-project
   `config.understanding_checks.sensitive_paths`); its kind is outside `config.auto_merge.kinds`; or
   the director flagged it. `understandingCheckCertain:5226` is the half that can be decided before
   the review exists. `quizAnswerable:5269` then gates whether it's *askable*: a task with a
   confirmed risk is never quizzed (hive-570 — don't spend the director before spending the machine).
   **The quiz questions themselves are not generated by a server model call** — they come from the
   worker agent's own `review_summary.understanding.checks`, carried forward across re-emissions
   (`carriedUnderstandingChecks:5296`); only an explicit `checks: []` clears them. `mintIntentChecks`
   (#6) is the alternative source when the task has an accepted intent.

5. **Auto-merge** (`reconciler.ts:1601` `autoMergeReady`). Per in_review task with green CI, in
   order: not tracking-only; `passedByDirector` false (a quiz pass proves understanding, never
   approval — it parks for an explicit Ship); no queued steers or queued-input recovery; a usable
   review keyed to the current head; `cautionCleared` if caution; then
   `classifyEscalation({reversible: true, blastRadius: "shared", ambiguous: !cleared,
   preferenceKnown: kinds.includes(task.kind)})` must return `auto_handle` — so
   **`config.auto_merge.kinds` is literally "the stored preference"**; no `changes_requested` ever;
   at least one evidence row; `verificationGate` empty; `autoMergeFailures < MAX_AUTO_MERGE_ATTEMPTS
   (2)` at this head. A `beforeMutation` closure re-checks the volatile half at merge time.

**"Dual-reviewer needs_human"** in memory = the question branch (#4): the pre-reviewer's question,
then opus deciding `machine` vs `human`. A `human` answer is a merge veto and survives every gate.

**Where a typed judgment fits.** #3 and #4 are the prize. Both are already strict enums that the
entire downstream gate reads and nothing else; both run on opus; both run per finding with 3 retries.
A Jev pre-judgment that refutes the obvious ones (or, conversely, confirms high-probability real
bugs) and forwards only the uncertain middle band to opus preserves the existing semantics exactly —
`unverified` already means "no answer", so a Jev abstention has a well-defined home.

---

## Instrumentation available to measure before/after

**What exists:**

- `usage` table (`db.ts:246`): per-task `model`, `input/output/cache_read/cache_write_tokens`,
  `cost_usd`, `source`. Written **only** by `POST /api/tasks/:id/usage` (`api.ts:8440`) from the
  agents' Stop hook, upserted per `(task, session, model)`.
- `server/src/pricing.ts` — `$/MTok` table keyed by longest-substring model match, per-project
  `config.pricing` override, `costUsd()` used when the poster omits a cost.
- `server/src/costs.ts` — `taskSpend`, `taskProcessedTokens`, `taskWaitCalls`, plus warn/cap
  guardrails (dollar caps **off by default**; token caps 75 M warn / 200 M cap; wait-call 25/100).
- `server/src/autonomyStats.ts` — `auto_merge_precision` (7-day fix-signal heuristic, `FIX_OVERLAP
  0.5`), `inbox_load` by class (decision / quiz / checkpoint / dialog / stale), `recovery`,
  `agreement` (did the director later contradict hive's own answer?). Read-only, injectable clock.
  **This is the right scoreboard for a Jev rollout**: precision and agreement are exactly the
  "did the cheap judgment stay correct?" metrics.
- `health.ts:383` `noteToolStart` — per-tool consecutive failure streak, marks health degraded after
  `TOOL_DEGRADED_AFTER`. Fed by `noteModelCall`, so it already counts model-call failures fleet-wide.
- Timing: `intentInvestigate.ts:206` writes `ms` on every `intent_investigated` event;
  `reviewer.ts:207` writes `elapsed_ms` on `auto_review_error`. That is all.

**The gap you will hit immediately:** none of the 14 server-side `claude -p` one-shots writes a
`usage` row. They have no token counts, no cost, and (except the two above) no duration. TeamClaude
is env-injection only — `teamclaude.ts` parses `teamclaude env` and caches the proxy URL for 30 s;
hive never reads a counter back from the proxy, so `teamclaude status` is an out-of-band check, not a
data source hive owns.

**Cheapest instrumentation before any Jev work:** `defaultPlannerExec` in `planner.ts` is the single
choke point every one-shot goes through, and the `--output-format json` envelope every call already
parses carries `total_cost_usd` and a `usage` block that hive currently discards. Recording those
into the existing `usage` table (a new `source`, e.g. `server_oneshot`, keyed by call site) at that
one function would give a per-call-site baseline with no change to any caller — and would make the
opus risk-verification spend, which is almost certainly the largest line, visible for the first time.

## Ranked shortlist

1. `reviewer.ts:953` risk verdict (opus, per finding, ×3 retries) — PARTIAL, largest spend.
2. `reviewer.ts:953` question `machine|human` (opus, per finding) — PARTIAL, same call.
3. `intake/triage.ts:164` `bucket` (sonnet per ambient task, fails open) — PARTIAL, lowest risk to try.
4. `policy.ts` + `autoapprove.ts` regex classifiers — OFFLOADABLE, no call to remove, easy to backtest.
5. `explain.ts:43` `VERDICT:` regex-over-prose (haiku) — PARTIAL, cleanest textbook split.
6. `drift.ts:355` `drifting` bool — PARTIAL, already argued in-code that it needs a judge not a heuristic.
7. `planCritic.ts:153` `veto|note` — PARTIAL, only `veto` has an effect.
8. `dedup.ts:43` Jaccard → Noul with the same 0.6/0.8 thresholds — PARTIAL.
