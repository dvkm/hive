# Review and verify card audit

Date: 2026-09-17. Source: web/src/views/ReviewCard.tsx (ReviewCard, VerifyCard), Brief.tsx (Focus), UnderstandingQuiz.tsx, attention.tsx, Catchup.tsx, and 779 review_summary events from the last 30 days in the live database.

## The question: lead with the mental model?

Yes. The numbers and the code both say the mental model is the better lead.

- The lead line "What changed" is chosen by a fallback chain: the pre-reviewer's diff summary first (present on 68% of reviews), then the agent's `essence`, then the first Completed line. The pre-reviewer writes from the diff, in engineer voice: "Adds a sectorOrder prop to CategoryListPanel so player-search asset rows cluster by sector…". The agent's `essence` is written for a person: "The list is re-ordered in the browser so rows of the same sector sit together, inside the sales and rentals groups it already had." The card demotes the second into the collapsed panel as "Core idea".
- The packet exists almost always: 97% of reviews carry `understanding`, 96% a `background`, 96% an `essence`, 93% a walkthrough, 91% a `participate`. It is the one piece of text the protocol tells agents to write "the way you would explain the change to a colleague on the phone".
- The card already fights duplication between the three sources (`withoutPromoted` deletes the essence from the panel when it matches the lead). Three phrasings of one fact is the structural cause. One source should own the headline.

Recommendation: the headline is `essence`. `background` is the second line. The pre-reviewer's summary moves to the audit trail as the reviewer's note.

## Review card (in_review): every block, when it shows, how often, verdict

| # | Block | Shows when | How often (30 d) | Verdict |
|---|---|---|---|---|
| 1 | Meta line: ref, project, kind | always | 100% | Keep ref and title. Project and kind are already in the Focus label and the ref prefix; cut from Focus. |
| 2 | PR link or "branch x" | always | 100% | Keep the PR link. "branch hive/abc" is noise; drop. |
| 3 | Sidecar chip "✓ checks" / "N findings" | when a sidecar report exists | most | Show only when it warns. A green chip on every card is wallpaper. |
| 4 | CI badge | when ci_status set | most | Show only failing, pending, or never ran. Green CI is the default, not news. |
| 5 | Open decision cards (radios) | open decisions on the task | 36% of tasks have had one | Keep. It is the thing to do first. |
| 6 | Stacked-PR warning | branch shares commits with another open task | rare | Keep. Changes the merge decision. |
| 7 | Preview panel (stack status, start/stop) | projects with a preview config | one project | Keep, it is an action. Collapse to one line when nothing is running. |
| 8 | What changed + paths + diffstat | any of auto_review summary / essence / done[0] | ~100% | Replace with `essence`. Diffstat goes to the trail. |
| 9 | Before → after table | a done/testing line contains "A -> B" with a number | 87 of 6,431 lines (1.4%) | Cut. Rare, regex on prose, and when it fires the line is usually a test count nobody decides on. |
| 10 | Why it was needed | background, else a Completed line with "because" | 96% | Keep as line two. |
| 11 | Hive recommends / Needs you + reason | always | 100% | Keep. This is the decision. Reason text is fine at one line. |
| 12 | Risk verdicts: N still open, settled findings expander | pre-review ran on this head | 28% have verdicts | Keep open items. The "checked N other findings, none a problem" expander is trail material. |
| 13 | Verification checklist | task has verification_cmds | some | Keep. It is the contract the work had to pass. |
| 14 | Evidence strip: chips + screenshot thumbnails | any evidence | 31% have screenshots | Screenshots stay and get bigger. Chips like "Log: vitest on the grou… 26m ago 89e2d5e" are trail material; show a count. |
| 15 | "Understand this change" panel: Mental model (Before, Core idea, How it works, What this opens up) | packet exists | 97% | Before and Core idea become the lead (8, 10). "What this opens up" is the check-it instruction and belongs next to the action. "How it works" stays collapsed. |
| 16 | Visual explanation iframe | explanation page exists for this head | 56% | Keep collapsed. Heavy, and the mental model covers the glance. |
| 17 | Full report and audit trail: changes thread, checkpoints, Completed / Caveats / Judgment calls / Checks / Follow-ups, summary, diff | always | Caveats 79%, Judgment calls 88%, Follow-ups 53% | Caveats and Judgment calls are what a reviewer weighs, and they sit two expanders deep. Promote up to three of them into a "Watch out for" block under the recommendation. Everything else stays in the trail. |
| 18 | Understanding quiz | quiz required and not passed | 42% passed, 32% deferred | Keep. It is the gate. |
| 19 | "Understanding confirmed. Approval unlocked." | quiz passed | | Fine, or a chip. |
| 20 | "Mechanical change: no understanding check needed. [Quiz me on this one]" | every chore / mechanical change | every such card | Noise. A muted one-liner at most, no button. |
| 21 | Risk override note, land-held note, quiz-deferred note, risk-after-pass note | specific states | rare | Keep. Each explains a refusal the director would otherwise hit. |
| 22 | Actions: Ship / Request changes / Reject | always | 100% | Keep. |
| 23 | Blocked reason line + Merge anyway / Have agent add it | merge blocked | | Keep, but put it above the buttons. Today the disabled button comes first and the reason after. |
| 24 | Merge failed + Force local merge | after a failed merge | rare | Keep. |
| 25 | N recorded failures expander | failure events on the task | some | Keep collapsed. |
| 26 | Notes editor | after Request changes / Reject | | Keep. |

## Verify card (verifying): the card in the screenshot

Blocks: meta, PR link, What changed, Why it was needed, evidence strip, "Understand this change" (collapsed), "Needs you: Check it, then close it. This merged and is waiting on you. Nothing else moves it.", Verified button, Open task.

What a verifier needs is different from what a reviewer needs: what to look at, where, and what good looks like. That is `participate` ("Open a player on the map search and check the list reads the way you want…"), the screenshots, and the preview URL. Today `participate` is inside the collapsed panel as the last paragraph and the lead is the pre-reviewer's jargon line.

Recommended verify card: Core idea, then "Check this" (participate) with the preview or PR link, then screenshots, then the button. Before and How it works collapsed. Evidence chips in the trail.

## Other inbox kinds

- Intent: fixed today. Drafts arrive investigated, only decisions remain.
- Decision, checkpoint, attention, waiting: fine. One row, one action each.
- Catch-up quiz digests: the inbox shows "Catch up on 130 shipped changes" and "Catch up on 88". Two hundred and eighteen quizzes, presented one at a time, is a queue nobody will finish, and it inflates the count that drives the attention budget. Options: expire catch-up quizzes after 7 days, cap the digest at the last 10 like the Catch up page, or make the post-ship quiz a sample rather than every ship.
- TaskEvidence strip under decisions, checkpoints and quizzes: the same chip noise as 14. Show screenshots, count the rest.
- Budget banner: "6 things need you. That is over your budget of 5, so hive paused . Nothing already running was stopped. Nothing is being held yet." Three sentences to say nothing happened, plus a stray space before the period. Show it only when something is actually held.

## Proposed Focus card order

1. Title, ref, PR link. Status chips only when not green.
2. Core idea (essence). Before (background) as the second line.
3. Watch out for: open risk verdicts, up to three caveats or judgment calls.
4. Needs you: recommendation, the one action, blocked reason above the button.
5. Check this (participate) with preview or PR link, screenshots.
6. Understanding check when required.
7. Collapsed: How it works, visual explanation, full report and audit trail.
