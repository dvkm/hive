# Task #364 — chat supervisor auto-approves safe decision cards (end-to-end)

Ran the real `hive` server + `hive decision auto-answer` CLI against three live decision cards.

## Supervisor CLI transcript (what the supervisor agent actually runs)

```
$ hive decision auto-answer <ref-card> --key save --reason "the ops dashboard"
auto-approved dec_7da391cebd0a (save)
exit=0

$ hive decision auto-answer <dup-card> --key merge      # high-confidence duplicate (0.91)
auto-approved dec_1bd42e3f03cd (merge)
exit=0

$ hive decision auto-answer <cost-card> --key wrap_up    # cost cap = NOT allow-listed
escalated dec_035d319f192e to the director: not an auto-approvable category — routing to the director
exit=3
```

The two allow-listed categories (reference capture, high-confidence duplicate merge) auto-approve with exit 0.
The cost-cap card is refused server-side (HTTP 403), exits 3, and stays OPEN for the director.

## Server-side effects (not just prose)

- Cost-cap card status after the refusal: **open** (left for the director).
- Duplicate task actually folded: `Implement password reset via email -> state=cancelled (folded into <survivor>)`.
- Reference-capture resolver ran (reference stored) — covered by `apiAutoAnswerDecision` unit test.

## Audit trail rendered in the feed (Decisions category)

```
[auto_approve_declined] source=chat_supervisor  ->  "supervisor escalated to director: not an auto-approvable category — routing to the director"
[auto_approved]         source=chat_supervisor  ->  "supervisor auto-approved: merge — high-confidence duplicate merge (recommended)"
[decision_answered]     source=chat_supervisor  ->  "answered: merge (supervisor)"
[auto_approved]         source=chat_supervisor  ->  "supervisor auto-approved: save — reference capture — reversible, zero blast radius"
[decision_answered]     source=chat_supervisor  ->  "answered: save (supervisor)"
```

Every auto-approval is tagged `source=chat_supervisor` (forensically distinct from a director click) and
carries the allow-list category + reason. Declines log `auto_approve_declined`. Both new event types render
under the **Decisions** feed category.

## Backstops verified by `server/test/autoapprove.test.ts` (8 tests, all passing)

- only the raiser's own recommended option auto-selects (weak 0.4 dup match → escalate)
- risk above low/normal → escalate; prod/shared blast radius → escalate
- pending standing-authority command grant → HARD exclusion even if recommended + low risk
- cost cap / deny-guardrail / plain product question → escalate
- `apiAutoAnswerDecision`: safe card answered + audited as supervisor; unsafe card stays OPEN + 403
