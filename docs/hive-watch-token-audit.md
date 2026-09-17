# Hive-watch corebeat — token audit and TypeSafe Jev offload candidates

Audited 2026-09-17. Scripts: `audit.py`, `audit2.py`, `audit3.py`, `audit4.py` in this scratchpad. Nothing in the hive repo was touched.

## Sessions

All three carry `customTitle: "Hive-watch corebeat"`, all in one project dir
`/Users/david/.claude/projects/-Users-david-projects-monorepo--claude-worktrees-agent-task-prioritization-87902a/`.
They are the same watch lineage (S3 is the original `/hive-watch corebeat` invocation, S2 and S1 are its continuations after auto-compaction).

| # | file | size | date | first user msg |
|---|---|---|---|---|
| S1 | `11bfaffa-4556-449c-a72b-e905cae41582.jsonl` | 41.5 MB | Sep 17 | fork/continuation, title `Hive-watch corebeat` |
| S2 | `8d28249e-5c1f-4d3d-9d4f-69faa147c088.jsonl` | 29.1 MB | Sep 1 | continuation, same title |
| S3 | `996792b6-8bcf-4e1a-91c2-2575ec90e938.jsonl` | 5.6 MB | Aug 29 | `<command-name>/hive-watch</command-name> <command-args>corebeat</command-args>` |

## 1. Turns, tool calls, tokens

| | S1 | S2 | S3 | total |
|---|---:|---:|---:|---:|
| assistant turns | 3,750 | 5,423 | 1,134 | 10,307 |
| tool calls | 1,798 | 2,690 | 412 | 4,900 |
| uncached input tok | 133,992 | 10,818 | 2,262 | 147,072 |
| output tok | 3,371,858 | 3,767,781 | 919,697 | 8,059,336 |
| cache **write** tok | 26,893,269 | 16,833,180 | 2,200,688 | 45,927,137 |
| cache **read** tok | 2,077,441,101 | 2,967,592,312 | 581,431,917 | **5,626,465,330** |
| billable total | 2,107,840,220 | 2,988,204,091 | 584,554,564 | **5,680,598,875** |
| event wakeups (ticks) | 419 | 371 | 145 | 935 |
| mean assistant turns / tick | 8.9 | 14.6 | 7.8 | 11.0 |

**The headline: 99.0% of the spend is cache-read.** Mean context re-read per assistant turn is **~551k tokens** (S1 554k, S2 547k, S3 513k). Output is 0.14% of the bill. Actual fetched data is negligible: all tool results across all three sessions total **3.57 M characters ≈ 0.9 M tokens**, i.e. 0.016% of the billed tokens.

Consequence that governs everything below: **cost is linear in the number of assistant turns, not in what those turns do.** Every turn costs ~551k tokens (~$0.83 at Opus cache-read rates) whether it runs a 20-char `curl` or writes one sentence. Removing a turn is worth ~551k tokens; shrinking a tool result is worth nothing.

## 2. Top 15 tool calls by result size

### S1 (total tool_result 1,325,432 chars)

| pattern | n | total chars | mean |
|---|---:|---:|---:|
| Bash sqlite3 ~/.hive/hive.db | 211 | 241,242 | 1,143 |
| Bash cd ~/projects/monorepo … | 58 | 101,631 | 1,752 |
| Bash cd ~/projects/hive-live … | 72 | 96,734 | 1,343 |
| Bash python3 inline | 102 | 78,857 | 773 |
| Bash gh pr view | 68 | 75,225 | 1,106 |
| Bash hive CLI | 118 | 56,226 | 476 |
| ScheduleWakeup | 325 | 51,424 | 158 |
| Bash hive-land script | 100 | 48,543 | 485 |
| Bash gh run | 35 | 47,676 | 1,362 |
| Bash hive_watch.py | 11 | 31,419 | 2,856 |
| Monitor hive-watch (all) | 103 | 30,917 | 300 |
| Bash git log | 29 | 30,045 | 1,036 |
| Read scratchpad/tracker-gap-audit.md | 2 | 29,694 | 14,847 |
| Bash hive-task script | 13 | 23,637 | 1,818 |
| Read scratchpad/newsletter-gap-audit.md | 2 | 22,995 | 11,497 |

### S2 (total 1,782,302 chars)

| pattern | n | total chars | mean |
|---|---:|---:|---:|
| Bash sqlite3 ~/.hive/hive.db | 963 | 808,187 | 839 |
| Bash hive CLI | 387 | 238,763 | 616 |
| Bash cd ~/projects/monorepo … | 41 | 78,624 | 1,917 |
| Bash gh pr view | 140 | 64,793 | 462 |
| ScheduleWakeup | 382 | 60,328 | 157 |
| Bash cd /Users/david/projects/monorepo … | 63 | 57,967 | 920 |
| Bash gh run | 42 | 50,940 | 1,212 |
| Bash cd ~/projects/hive-live … | 40 | 48,587 | 1,214 |
| Bash cd /Users/david/projects/hive-live … | 48 | 39,891 | 831 |
| Bash python3 inline | 41 | 39,294 | 958 |
| Bash curl /api/understanding-quizzes | 36 | 27,982 | 777 |
| Bash git log | 36 | 26,373 | 732 |
| Bash git diff | 13 | 17,538 | 1,349 |
| Bash curl /api/tasks | 16 | 17,060 | 1,066 |
| Bash curl /api/health | 25 | 13,359 | 534 |

### S3 (total 463,178 chars)

| pattern | n | total chars | mean |
|---|---:|---:|---:|
| Bash curl /api/tasks/`<id>` | 76 | 106,789 | 1,405 |
| Bash cd /Users/david/projects/hive-live … | 35 | 48,961 | 1,398 |
| Bash curl /api/decisions?status=open | 15 | 42,247 | 2,816 |
| Bash echo "=== … (multi-probe) | 18 | 34,176 | 1,898 |
| Bash cd …/monorepo/.claude/worktrees/… | 28 | 34,111 | 1,218 |
| Bash curl /api/tasks | 23 | 22,572 | 981 |
| Bash grep "api/checkpoints" | 1 | 19,049 | 19,049 |
| Bash cd /Users/david/projects/monorepo | 19 | 15,900 | 836 |
| Bash gh run | 5 | 13,353 | 2,670 |
| Bash gh pr view | 19 | 11,559 | 608 |
| Bash curl /api/projects | 9 | 10,302 | 1,144 |
| WebSearch | 3 | 8,508 | 2,836 |
| Bash python3 inline | 15 | 8,283 | 552 |
| Bash ssh corebeat prod box | 13 | 6,899 | 530 |
| Bash hive CLI | 8 | 6,711 | 838 |

Shape of the fetch layer: **`sqlite3 ~/.hive/hive.db` + `hive` CLI + `curl /api/tasks/<id>` + `gh pr view` + `gh run` are ~70% of all bytes read**, in ~1,200 calls averaging under 1.1 kB each. These are small, structured, highly repetitive state reads — exactly the input a judgment model would take.

## 3. The repeated per-tick decision

The skill (`/Users/david/.claude/skills/hive-watch/SKILL.md`) is explicit that **all classification lives in the deterministic script** and "Claude only reacts to the lines". In practice the transcripts show Claude re-classifying every line it receives. One tick looks like this:

1. A Monitor line arrives: `CLASS project=corebeat task=<id> :: <summary>` (mean ~300 chars).
2. Claude fetches the surrounding state — typically 3 to 8 calls: `sqlite3 ~/.hive/hive.db` for the task row and its recent events, `hive task <id>` / `curl /api/tasks/<id>`, `gh pr view --json state,mergeable,mergeStateStatus`, sometimes `gh run list`, `git log origin/main`.
3. Claude makes a **small classification judgment** in prose: is this new or a re-announcement on the throttle; is it transient or a real blocker; is it a duplicate and which side is younger; is it already fixed on main; does it need David or can I act; is the agent stuck or merely rate-limited/racing.
4. Claude acts (`hive land`, cancel, steer, requeue, ack) or does nothing, then writes one line to David, then re-arms `ScheduleWakeup`.

Mean **11 assistant turns per tick** across 935 ticks. The dominant outcome is *nothing to do*: a large share of the judgment snippets end in "Nothing new", "Nothing to do; holding", "informational", "Self-clears — no action".

Representative judgment-shaped snippets (all under 40 words):

> "9th failure, same loop. Already diagnosed and pushed — not re-notifying. Standing by."

> "Same benign race as before: the change request spawned the agent and a second spawn was refused because that agent is alive. Nothing to do."

> "The name-lock refusal from my own spawn attempt, surfacing as an event. Self-clears — no action."

> "The parity job on WEB-149's head is only queued (CodeBuild backlog), not failed… The CI_FAILURE signal was transient. Landing waits for that queued run."

> "The 6-hourly reminder of the six director-gated parked tasks… Informational; they wait on you."

> "#2102 is confirmed a duplicate of already-merged work (#1216)… I'm cancelling the respawned agent now before it wastes a turn rebasing this dead PR."

## 4. Where the tokens go

Turns classified by role; cost = input + cache-read + cache-write + output on that turn.

| role | turns | tokens | share |
|---|---:|---:|---:|
| **fetch** (Bash/Read/Grep/Agent/WebSearch) | 3,973 | 2,131,990,946 | **37.5%** |
| **judgment — thinking-only turns** | 2,859 | 1,520,276,283 | 26.8% |
| **judgment — interstitial prose turns** | 1,734 | 958,750,287 | 16.9% |
| **wait/arm** (ScheduleWakeup, Monitor, TaskStop) | 824 | 520,175,222 | 9.2% |
| **report to David** (turn ending a tick) | 814 | 500,281,390 | 8.8% |
| other tools | 103 | 49,124,747 | 0.9% |
| total | 10,307 | 5,680,598,875 | 100% |

Per session:

| role | S1 | S2 | S3 |
|---|---:|---:|---:|
| fetch | 33.3% | 40.7% | 36.6% |
| judgment (thinking) | 36.0% | 20.4% | 26.1% |
| judgment (prose) | 11.3% | 20.2% | 19.9% |
| report to David | 5.7% | 9.3% | 17.2% |
| wait/arm | 12.3% | 8.7% | 0.0% |

**Judgment = 43.6% of all tokens (4,593 turns).** Fetching = 37.5%. Writing to David = 8.8%. Loop bookkeeping = 9.2%.

That 43.6% is the direct offload target. A meaningful slice of the 37.5% fetch cost is downstream of the same judgments — probes run only to settle "is this real or transient" — so the reachable ceiling is higher than 43.6%, call it 55-65% if the judgment is answered before Claude is woken at all.

## 5. Ranked offloadable judgments

Each is a decision the session makes many times per night, from state the hive script already has in hand, with a fixed small answer space and no prose output. Savings are stated in turns × 551k tokens.

### 1. "Is this line worth waking Claude at all?" — Noul (yes/no)
- **Input state**: the class line, the task row (state, agent_target, is_deferred, last 5 events with timestamps), whether the same (class, task) fired before in this session and Claude's outcome then, minutes since.
- **Question**: does this line require any action this tick?
- **Answer**: yes/no probability; below threshold → suppress, log only.
- **Why it's the top item**: the dominant recorded outcome is "Nothing new / informational / no action". Conservatively a third of the 935 ticks resolve to nothing after ~11 turns each.
- **Estimate**: ~300 ticks × ~6 turns saved ≈ 1,800 turns ≈ **990 M tokens (~17% of the session)**.

### 2. "Re-announcement of something already handled?" — Noul (yes/no)
- **Input state**: the new line; the list of (class, task, one-line resolution) this session already closed; the throttle windows (6h failed/checkpoints/duplicates, 1h stale/orphan/mirror, 30m decisions/land-fail/land-ready).
- **Question**: is this the same open item Claude already resolved or already decided to hold?
- **Answer**: yes/no. On yes, replay the stored one-liner instead of re-deriving it.
- **Evidence**: "The 6-hour re-announcement of CORE-1255's context-exhaustion failure… Nothing new."; "Routine repeat of an already-resolved task."; "The known failed parent again; informational." (three consecutive ticks in S1).
- **Estimate**: ~150 ticks × ~5 turns ≈ 750 turns ≈ **413 M (7%)**.

### 3. "Transient or real blocker?" — Choice {transient-retry, real-blocker, needs-human}
- **Input state**: for LAND_FAIL / CI_FAILURE / MERGE_FAILED / SPAWN_ERROR — the failure string, the PR's `mergeable`/`mergeStateStatus`, whether required checks are queued vs failed, whether base moved, attempt count for this task.
- **Question**: which of the three?
- **Answer**: choice; transient → re-mark and stay quiet, only escalate on repeat.
- **Evidence**: "The parity job … is only queued (CodeBuild backlog), not failed … The CI_FAILURE signal was transient."; "The gate is hive re-running its risk check on the new head, which is transient: the merge re-attempts itself."
- **Estimate**: ~120 occurrences × ~4 turns ≈ 480 turns ≈ **264 M (4.6%)**.

### 4. "Spawn error: benign race or stuck holder?" — Noul (yes/no)
- **Input state**: the name-lock/spawn refusal text, the holder's pid + age + agent status, timestamp of the spawn that succeeded, whether a steer was queued.
- **Question**: is the holder a live agent younger than the refusal (benign race)?
- **Answer**: yes/no. Yes → silence.
- **Evidence**: "Benign — the same race as before. #2109's agent is bound and alive (pid 72359, 45 seconds old, status `working`)… Nothing to do; holding." This exact shape recurs at least five times in S1 alone, each time costing a `ps`/`hive agent` probe plus a prose turn.
- **Estimate**: ~60 × ~4 turns ≈ 240 turns ≈ **132 M (2.3%)**.

### 5. "Duplicate — and which side dies?" — Choice {not-duplicate, cancel-younger, cancel-neither-already-landed}
- **Input state**: both task rows (id, title, created_at, state, pr_url, PR file set), the script's Jaccard score, whether either is `verifying`/`done`, whether one is a Jira mirror and the other its `[KEY] …` work task.
- **Question**: which side, if any, to cancel.
- **Answer**: choice.
- **Evidence**: "#2102 is confirmed a duplicate of already-merged work (#1216)… I'm cancelling the respawned agent now"; "Adjacent, not duplicate — but they'd collide"; and a whole tick spent re-tightening the watcher because DUPLICATE fired on a landed pair.
- **Estimate**: ~40 × ~6 turns ≈ 240 turns ≈ **132 M (2.3%)**.

### 6. "Does this need David, or may I act?" — Score on ordered levels {act-silently, act-and-mention, ask-David, urgent-wake-David}
- **Input state**: the item (decision card body, checkpoint note, quiz), its kind (chore/scout/ship/product/security), the project's `auto_merge.kinds` config, whether David delegated this class in-session, the `needs_human` flag.
- **Question**: how high does this escalate?
- **Answer**: ordered score — this is the one that must be conservative, so a calibrated level with a high bar for the bottom rung.
- **Evidence**: "Well-judged card. Notably it refused to mint a CMS admin JWT…"; "The map-pin decision is the one already surfaced to you; still waiting on your 1/2/3/park."
- **Estimate**: ~80 × ~4 turns ≈ 320 turns ≈ **176 M (3.1%)**. Keep a human-side floor: never let the model move something *down* from ask-David without David's in-session delegation.

### 7. "Agent silent: stalled, rate-limited, deferred, or director-queue?" — Choice {respawn, wait, deferred-noop, verifying-tell-director}
- **Input state**: task state, `agent_target`, last event kind + age, last `recovery_nudge` text, deferred flag/`deferred_until`, whether a usage-limit event appears in the last hour.
- **Question**: which of the four.
- **Evidence**: "The agent isn't stuck — it's rate-limited. It hit a usage limit at 06:10, resumed at 07:32… Blocked until 08:47."; "Both are already correctly parked — `deferred` until 9999… Nothing wrong."
- **Estimate**: ~50 × ~5 turns ≈ 250 turns ≈ **138 M (2.4%)**.

### 8. "Is this already fixed on main?" — Noul (yes/no)
- **Input state**: the task/PR title and diff file list, the last N merged PR titles + file lists on `origin/main`, the live checkout head.
- **Question**: is the change this task proposes already present on main?
- **Evidence**: "Both #2108 and #2110 are already fixed on main—#2108's one-liner landed via #1216, and #2110's COLLATE fix via #1214"; "HIVE-475 is already done (PR #9 merged)".
- **Estimate**: ~45 × ~6 turns ≈ 270 turns ≈ **149 M (2.6%)**.

### 9. "Which project does this belong to?" — Choice over project names
- Already deterministic in the script (client-side cache over `/api/tasks/<id>`); listed only for completeness. Near-zero savings — do not spend a model call on it.

**Rolled up**: items 1-8 cover roughly **4,350 turns ≈ 2.4 B tokens ≈ 42% of the three sessions' billed spend**, which is essentially the whole judgment bucket plus the probes that exist only to serve it.

## 6. The structural point

Nothing here is helped by trimming tool output — 3.57 M chars of data cost 0.9 M tokens against a 5.68 B bill. The bill is 10,307 turns each dragging a ~551k-token context. So the Jev integration that pays is one that answers the question **before the session is woken**, inside `hive_watch.py`, so the suppressed tick produces zero Claude turns — not one that Claude calls as a tool, which would still cost a full turn to invoke and another to read.

Design that follows: `hive_watch.py` gathers the same task/PR/event state it already gathers for its board-state classes, puts it to Jev as the typed question above, and emits a line only when the answer clears the threshold — plus a nightly digest of what it suppressed so David can see the recall. The skill's "no classification lives in Claude" invariant then becomes true in fact, and its determinism claim weakens in a bounded, auditable way (Jev's answers are typed and loggable, so a fixed fixture still replays).
