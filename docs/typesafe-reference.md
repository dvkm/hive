# TypeSafe AI (Jev / System One) — Engineering Reference

Source: docs.typesafe.ai, fetched via `curl <page>.md` (Mintlify markdown export), 2026-09-17.

## What it is

Jev is TypeSafe's flagship "System One" model: not a chat LLM, not an agent. You send a
`state` (the content to judge) plus a map of typed `questions`; it returns typed `answers`
with calibrated probabilities — no free text, no parsing. System One is explicitly "for
building AI-powered software, not agents": it does not generate code or choose its own next
action. Code stays in control of the workflow; the model only answers narrow, structured
judgments embedded in it.

## Getting an API key

Dashboard: https://console.typesafe.ai/settings/keys — "Get your API key from the
dashboard." Playground for interactive testing: https://console.typesafe.ai/playground.
Client reads the key from the `TYPESAFE_API_KEY` environment variable by default (both
Python and JS SDKs).

## HTTP API

### Endpoint

```http
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer <API_KEY>
Content-Type: application/json
```

### Request body

```json
{
  "state": "Help! My payouts have been failing for 3 days.",
  "model": "jev-latest",
  "questions": {
    "is_urgent": {
      "type": "noul",
      "instructions": "Does this convey urgency?"
    }
  }
}
```

Top-level fields:
- `state` (`string | object | array`, required) — content to evaluate. Text only (no
  images/audio/video); convert non-text content to text first.
- `model` (`string`, required) — e.g. `"jev-latest"`.
- `questions` (`map<string, Question>`, required) — key you choose per question; the key is
  never sent to the model, only used to key the response.

### Question types (request side)

**Noul**
```json
{ "type": "noul", "instructions": "Does this convey urgency?",
  "criteria": { "true": "Explicitly time-sensitive", "false": "No urgency expressed" } }
```
`criteria` optional: `{ "true": string, "false": string }` describing what yes/no mean.

**Choice**
```json
{ "type": "choice", "instructions": "Which team should handle this?",
  "criteria": { "billing": "Payments, invoicing, refunds",
                "technical": "Bugs, outages, integrations",
                "sales": "Pricing, upgrades, new accounts" } }
```
`criteria` required: `map<string, string | null>` — option name to rubric (`null` if no
extra detail needed). Up to 255 options per Choice question.

**Score**
```json
{ "type": "score", "instructions": "How frustrated is the customer?",
  "criteria": ["Calm", "Frustrated", "Very angry"] }
```
`criteria` required: ordered array of level descriptions, low to high. At least 2 levels,
up to 10.

### Response body

```json
{
  "model": "jev-latest",
  "answers": {
    "is_urgent": { "type": "noul", "noul": 0.92 }
  },
  "usage": { "input_tokens": 312, "output_tokens": 48 }
}
```
- `model` (string) — model that actually answered.
- `answers` (`map<string, Answer>`) — one per question id.
- `usage.input_tokens`, `usage.output_tokens` (integers).

### Answer shapes

Noul:
```json
{ "type": "noul", "noul": 0.92 }
```
`noul` (number 0–1) — probability the answer is yes. No `confidence` field.

Choice:
```json
{ "type": "choice", "choice": "technical",
  "probabilities": { "billing": 0.08, "technical": 0.85, "sales": 0.07 },
  "confidence": 0.82 }
```
`choice` (string, highest-probability option), `probabilities` (`map<option, number>`,
sums to 1), `confidence` (number 0–1).

Score:
```json
{ "type": "score", "score": 1.6,
  "legend": { "0": "Calm", "1": "Frustrated", "2": "Very angry" },
  "probabilities": { "0": 0.05, "1": 0.3, "2": 0.65 },
  "confidence": 0.78 }
```
`score` (number, probability-weighted position, can fall between levels), `legend`
(`map<level index string, description>`), `probabilities` (`map<level index string,
number>`, sums to 1), `confidence` (number 0–1).

### Errors

| Status | Meaning |
|---|---|
| `401 Unauthorized` | Missing/invalid API key. |
| `422 Unprocessable Entity` | Request failed validation; body names the offending field. |
| `429 Too Many Requests` | Rate limit exceeded. |
| `529 Overloaded` | TypeSafe temporarily overloaded. |

Retry `429`/`529` with exponential backoff; SDKs do this by default, honoring
`retry-after` when present.

### Models endpoint

```
GET /v1/models
Authorization: Bearer <API_KEY>
```
Response: `{ "models": [ { "name": string, "description": string, "release_date": string } ] }`.
Lists aliases; versioned IDs (e.g. `jev-1.13.0`) work in `model` even if unlisted.

## Confidence

`confidence` is derived from `probabilities` (Choice/Score only — Noul has none): a
concentrated distribution → high confidence, a flat one → low. It's a convenience default;
raw `probabilities` are always returned if you want a different metric. Suggested pattern:
three confidence bands — high (act automatically), medium (confirm/flag/gather more info),
low (route to a human) — with thresholds that scale per action's risk, not one global
number.

## Limits

- Request token budget (state + questions combined): **~32,000 tokens**, roughly 150,000
  characters of English text.
- Choice: up to **255 options**.
- Score: **2–10 levels** required.
- Questions per request: no fixed count limit stated — bounded only by the shared token
  budget. Adding questions costs only their extra tokens and "barely changes response
  time" because all questions in a request run in parallel.

## Pricing & rate limits (model: `jev-1.13.0`, current as of fetch)

| | Jev 1.13 (`jev-1.13.0`) |
|---|---|
| Price | $42 / Btok input, $0.042 / Mtok input — **output tokens are free** |
| Rate limits | 250,000 tokens/second, 1,200 requests/minute |

Rate limits are called out as adjusting dynamically without notice ("we are serving a very
large volume of demand"); higher/custom limits via sales@typesafe.ai. Aliases:
`jev-latest` → `jev-1.13.0` (SDK default), `jev-preview` → `jev-1.13.0` (currently
identical, no preview build live).

## Latency

"Most queries complete in about 100 ms." Called out as fast enough for real-time request
paths and user interfaces. Adding more questions to one request barely changes response
time since they run in parallel.

## JavaScript SDK

Package: `@typesafe-ai/sdk`. Requires Node.js 20+.

```sh
npm install @typesafe-ai/sdk
```

Minimal working example (verbatim from docs):

```ts
import { choice, TypeSafeClient } from "@typesafe-ai/sdk";

const client = new TypeSafeClient();
const response = await client.systemOne({
  state: { document: "I was charged twice. Please fix this ASAP." },
  questions: {
    category: choice("What is this ticket about?", {
      billing: null,
      technical: null,
      other: null,
    }),
  },
});

console.log(response.answers.category.choice);
```

Client reads `TYPESAFE_API_KEY` from env. Answer types are inferred from the questions you
pass. Ships ESM, CommonJS, and TypeScript declarations. Also exposes `choice()`, `noul()`,
`score()` helper functions, and typed interfaces `ChoiceQuestion<T>`, `ChoiceResponse<T>`,
`NoulQuestion`, `NoulResponse`, `ScoreQuestion<T>`, `ScoreResponse<T>`,
`SystemOneRequest<Q>`, `SystemOneResult<Q>`, `Usage`, plus error classes `APIError`,
`AuthenticationError`, `RateLimitError`, `BadRequestError`, `NotFoundError`,
`PermissionDeniedError`, `UnprocessableEntityError`, `InternalServerError`,
`APIConnectionError`, `APITimeoutError`, `APIUserAbortError`. Source:
github.com/typesafe-ai/typesafe-sdk-js (`src/client.ts`, `src/types.ts`).

Python SDK (for comparison, since cookbooks use it): package `typesafe_sdk`, install via
`pip install typesafe-sdk` or `uv add typesafe-sdk` (Python ≥3.10), client class
`TypeSafeClient`, method `client.system_one(state=..., questions={...})`, question classes
`Choice`, `Score`, `Noul`.

## Patterns

**Speculative fan-out** (`/patterns/fan-out`): put every question your system might need
into one request (even ones that only matter for some inputs — e.g. bug severity only
matters if the ticket turns out to be a bug report), then have code decide what's relevant.
No latency cost from extra questions since they run in parallel; the Parallel Questions
cookbook shows batching 13 questions into one call is ~12.2x cheaper and ~10.0x faster than
13 separate calls, same answers.

**Composite scoring** (`/patterns/composite-scoring`): break one complex ranking judgment
(e.g. resume screening) into several independent Score questions (python_depth,
team_leadership, system_design, generalist), normalize each to 0–1, then combine with
weights you own in code, e.g.:
```python
ic_score = (0.40 * py) + (0.10 * lead) + (0.40 * arch) + (0.10 * general)
```
Weights live in code, not a prompt, so you can retune without re-writing instructions.

**Confidence-gated routing** (`/patterns/confidence-routing`): use `confidence` as a second
axis alongside the answer — the answer says what, confidence says whether to act
automatically, confirm, or escalate.

**Intent routing** (`/patterns/intent-routing`): classify an incoming request and route it
to deterministic logic, a specialist LLM, or a human.

## Cookbooks (one-line summaries from the docs index)

- **Function calling** (`cookbooks/function_calling`): turns natural-language trading
  requests into calls to ordinary typed functions by mapping function names and closed-set
  arguments to confidence-aware questions. A `stated` yes/no sub-question makes an argument
  optional — no is "argument absent, use the function's own default." Write questions about
  the idea, not the literal wording, and never name a question after its parameter (avoid
  "Which resolution?").
- **Re-ranking** (`cookbooks/rerank_typesafe`): builds 30-passage BM25 shortlists for 40
  CLERC legal queries, then asks one TypeSafe question per query-candidate pair, raising
  top-1 accuracy from 5% to 18% and top-10 from 38% to 62%.
- **Hierarchical classification** (`cookbooks/hierarchical_classification`): classifies
  documents through deep patent/retail/biomedical/source-code hierarchies via parallel beam
  search over Choice probabilities — each Choice answer decides which options the next
  request offers (a case where chaining requests is justified).
- **Double-checking citations** (`cookbooks/citation_check`): first checks in code whether a
  quoted citation literally exists (substring match after normalizing whitespace/curly
  quotes) — no model needed for that; only when a citation names a section without quoting
  does it go to a Choice question asking whether the quote's context supports the claim,
  with confidence flagging for human review.
- **SDE cascade** (`cookbooks/sde_cascade`): 2-stage structured-data-extraction cascade
  (mini → verify → reasoning) to get most of a big reasoning model's quality at a fraction
  of the cost.

## What Jev is bad at / not for

System One (Jev) is explicitly "TypeSafe's model for building AI-powered software, not
agents": it does not generate code, write replies, produce free text, or choose its own
next action — there is no text generation or output parsing step at all, only typed
answers constrained to the options/levels you defined. It is not meant for open-ended,
multi-factor judgments or slow reasoning in a single call — "analyze this message and
determine the best course of action" is called out directly as the wrong shape of question;
the fix the docs prescribe is always to decompose such a judgment into several narrow,
atomic questions (one per independent factor) and combine the answers with your own logic
in code, rather than expecting the model to weigh everything itself. It only accepts text
input (strings, JSON objects/arrays of text) — no images, audio, or video; non-text content
must be transcribed/captioned into text first. And each question in a request is evaluated
independently, with no memory of, or context from, another question's answer in the same
call — if a judgment genuinely depends on an earlier answer (to decide what data to fetch
next, or what options to offer), that requires a second request in code, not something Jev
does on its own.

## Pages that failed to fetch

None — all requested pages (llms.txt, system-one, how-to-build-with-system-one, state,
primitives + choice/noul/score, confidence, api, sdk/javascript, patterns/fan-out,
patterns/composite-scoring, the five named cookbooks, models, introduction, quickstart)
returned content successfully via `curl https://docs.typesafe.ai/<path>.md`.
