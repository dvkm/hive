# Task #364 — chat supervisor auto-approve, live CLI + HTTP run (validation)

Booted the real hive HTTP handler (`makeHandler`) on a port and drove the actual `bin/hive` CLI against it via `HIVE_URL`, over four realistic decision cards. This exercises the full path the supervisor agent hits: CLI → `POST /api/decisions/:id/auto-answer` → `apiAutoAnswerDecision` → server-enforced `evaluateAutoApprove` bar → resolver + audit. No mocks on the request path.

## Supervisor CLI transcript (real `bin/hive` against a live server)

```
$ hive decision auto-answer <ref-card>  --key save --reason "the ops dashboard"
auto-approved <ref-card> (save)
exit=0

$ hive decision auto-answer <dup-card>  --key merge      # high-confidence duplicate (0.91)
auto-approved <dup-card> (merge)
exit=0

$ hive decision auto-answer <cost-card> --key wrap_up    # cost cap = NOT allow-listed
escalated <cost-card> to the director: not an auto-approvable category — routing to the director
exit=3

$ hive decision auto-answer <null-risk-card> --key save  # unrated card (commit b21c709)
escalated <null-risk-card> to the director: risk '(none)' is above the auto-approve bar
exit=3
```

The two allow-listed categories (reference capture, high-confidence duplicate merge) auto-approve with exit 0. The cost-cap card and the unrated (null-risk) reference card are both refused server-side (HTTP 403) and exit 3. The null-risk case exercises the follow-up commit b21c709: an absent risk rating is not "low or normal", so even an otherwise-allow-listed category escalates.

## Server-side state after the run (persisted DB)

```
ref  card: answered
dup  card: answered
cost card: open      (left OPEN for the director)
null-risk: open      (unrated card left OPEN — commit b21c709)
```

## Audit trail, rendered exactly as the web feed shows it (`web/src/lib/eventText.ts`)

```
[auto_approved]         source=chat_supervisor  ->  "supervisor auto-approved: save — reference capture — reversible, zero blast radius"
[decision_answered]     source=chat_supervisor  ->  "answered: save (supervisor)"
[auto_approved]         source=chat_supervisor  ->  "supervisor auto-approved: merge — high-confidence duplicate merge (recommended)"
[decision_answered]     source=chat_supervisor  ->  "answered: merge (supervisor)"
[auto_approve_declined] source=chat_supervisor  ->  "supervisor escalated to director: not an auto-approvable category — routing to the director"
[auto_approve_declined] source=chat_supervisor  ->  "supervisor escalated to director: risk '(none)' is above the auto-approve bar"
```

Every auto-approval is tagged `source=chat_supervisor` (forensically distinct from a director click), carries the allow-list category + reason, and the answered card renders with a "(supervisor)" suffix. Declines log `auto_approve_declined` and never touch the card. All four event types render under the **Decisions** feed category.

## Backstops covered by `server/test/autoapprove.test.ts` (8 tests, all pass)

recommended-only gate (weak 0.4 dup → escalate); risk above low/normal → escalate; null/unrated risk → escalate; prod/shared blast radius → escalate; pending standing-authority grant → HARD exclusion even if recommended + low risk; cost cap / deny-guardrail / plain product question → escalate; `apiAutoAnswerDecision` safe card answered + audited, unsafe card stays OPEN + 403.
