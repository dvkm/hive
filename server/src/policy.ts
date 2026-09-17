// Auto-handle vs escalate-to-decision-inbox (task #260).
//
// Before this, "should this proceed without a human?" was answered ad hoc at
// each call site: planner.ts hardcoded risk="normal" on every breakdown card
// regardless of what it proposed; reconciler.ts's autoMergeReady re-derived its
// own inline reversibility/preference checks. Same question, different answer
// depending which file asked it. classifyEscalation() is the one place that
// question gets answered, so the planner and reconciler both consume the same
// policy instead of leaving it to per-call-site judgment.
//
// Four factors, checked in this fixed order (first match wins — there's no
// glob to rank the way authority.ts ranks rules, so order IS the policy):
//   1. irreversible, or blast radius is prod        -> escalate, high
//   2. ambiguous (open questions, no single reading) -> escalate, normal
//   3. no stored preference for a non-local change   -> escalate, normal
//   4. otherwise                                     -> auto_handle, low

import { judge, noul, choice, score, typesafeMode } from "./typesafe.ts";

export type BlastRadius = "local" | "shared" | "prod";
export type Effect = "auto_handle" | "escalate";
export type Risk = "low" | "normal" | "high";

export interface EscalationFactors {
  reversible: boolean;
  blastRadius: BlastRadius;
  ambiguous: boolean;
  preferenceKnown: boolean;
}

export interface EscalationVerdict {
  effect: Effect;
  risk: Risk;
  reason: string;
}

export function classifyEscalation(f: EscalationFactors): EscalationVerdict {
  if (!f.reversible || f.blastRadius === "prod")
    return {
      effect: "escalate",
      risk: "high",
      reason: !f.reversible ? "irreversible" : "production blast radius",
    };
  if (f.ambiguous)
    return { effect: "escalate", risk: "normal", reason: "ambiguous — open questions, no single reading" };
  if (!f.preferenceKnown && f.blastRadius !== "local")
    return { effect: "escalate", risk: "normal", reason: "no stored preference for a non-local change" };
  return { effect: "auto_handle", risk: "low", reason: "reversible, scoped, unambiguous, preference known" };
}

// Heuristic keyword scan — best-effort text signal, not a parser. Deliberately
// conservative: any prod/irreversible keyword anywhere in the proposed work
// escalates the whole plan, even if only one of several proposed tasks touches it.
// Union of the two copies that used to exist (policy's + autoapprove's), so
// collapsing them loses no signal: `live` and `customer  data` came from
// autoapprove, `deployment` from here.
const PROD_RE = /\bprod(uction)?\b|\bdeploy(ment)?\b|\bcustomer\s*data\b|\blive\b/i;
const SHARED_RE = /\bmigration\b|\bschema\b|\binfra(structure)?\b|\bshared\b|\bpipeline\b/i;
const IRREVERSIBLE_RE = /\bdrop\s+table\b|\bforce.?push\b|\brm\s+-rf\b|\bdestroy\b|\bdelete\b.*\bpermanent/i;

// Would acting on this option require the DIRECTOR to hand something over
// (a credential, token, login, file) before the agent can proceed? Auto-answering
// such an option is worse than useless: the answer arrives with no payload and the
// agent stays blocked (incident dec_8f964774097e — auto-picked "give me admin
// credentials", no token attached, director had to intervene anyway).
//
// One place, two signals: an explicit `requires_input: true` a caller can set on
// the option, and a conservative keyword scan of the label+detail so naive cards
// that never set the flag are still caught. Kept deliberately narrow — matching a
// credential/attachment ask, not any mention of a word.
const NEEDS_INPUT_RE =
  /\b(credential|token|secret|password|passphrase|api[\s-]?key|login credential)s?\b|\b(attach|upload|paste|provide|supply|hand over|send me|give me)\b[^.]*\b(token|key|credential|secret|password|login|file|link|url|access)\b/i;

export function optionNeedsDirectorInput(opt: { label?: string; detail?: string; requires_input?: boolean }): boolean {
  if (opt?.requires_input === true) return true;
  return NEEDS_INPUT_RE.test(`${opt?.label ?? ""} ${opt?.detail ?? ""}`);
}

// ---------------------------------------------------------------------------
// One classifier for decision-card free text (task: TypeSafe judgment).
//
// `risk` and `blast_radius` are agent-written prose. Two copies of the same
// regex scan used to answer "is this prod/shared/irreversible/blocking?" — one
// here, one in autoapprove.ts. They collapse into classifyCardTextSync(); the
// async classifyCardText() asks Jev the same four questions and, in enforce
// mode, may only make the answer STRICTER (see the fail-closed merge below).
// ---------------------------------------------------------------------------

export type RiskLevel = "low" | "normal" | "medium" | "high";
const RISK_ORDER: RiskLevel[] = ["low", "normal", "medium", "high"];
const BLAST_ORDER: BlastRadius[] = ["local", "shared", "prod"];

// Moved here from autoapprove.ts so policy.ts owns every card-text judgment
// (autoapprove re-exports it; every existing caller keeps working).
//   - empty/missing -> "normal" (the historic default for an unset field);
//   - a recognized level word at the start -> that level;
//   - anything else (free prose) -> "high", because unrecognized text is not a
//     licence to answer a card automatically.
export function riskLevel(risk: unknown): RiskLevel {
  const text = String(risk ?? "").trim().toLowerCase();
  if (!text) return "normal";
  const word = text.match(/^(low|normal|medium|high)\b/)?.[1];
  return (word as RiskLevel) ?? "high";
}

// True when riskLevel() said "high" only because it could not parse a level out
// of the prose — the one case Jev is allowed to talk a card back DOWN.
const riskUnparseable = (risk: unknown): boolean => {
  const text = String(risk ?? "").trim().toLowerCase();
  return text.length > 0 && !/^(low|normal|medium|high)\b/.test(text);
};

export interface CardText {
  title?: string | null;
  context?: string | null;
  risk?: string | null;
  blast_radius?: string | null;
  options?: unknown;
}

export interface CardClass {
  risk: RiskLevel;
  blast: BlastRadius;
  reversible: boolean;
  needs_input: boolean;
  source: "typesafe" | "regex";
  /** shadow mode only: what Jev would have said, for the caller's event payload. */
  shadow?: Omit<CardClass, "shadow">;
}

function cardOptions(c: CardText): { label?: string; detail?: string; requires_input?: boolean }[] {
  const raw = typeof c.options === "string" ? safeParse(c.options) : c.options;
  return Array.isArray(raw) ? raw : [];
}
function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return [];
  }
}
const cardProse = (c: CardText): string =>
  [c.title, c.context, ...cardOptions(c).map((o) => `${o?.label ?? ""} ${o?.detail ?? ""}`)].filter(Boolean).join(" ");

/** The regex baseline: today's behavior, in one place. Fail-open fallback. */
export function classifyCardTextSync(c: CardText): CardClass {
  const prose = cardProse(c);
  // The explicit blast_radius field wins when the agent filled it in (that is
  // all autoapprove ever looked at); the prose is only a fallback for cards
  // that left it blank, where the old answer was an unconditional "local".
  const blastText = String(c.blast_radius ?? "").trim() || prose;
  return {
    risk: riskLevel(c.risk),
    blast: PROD_RE.test(blastText) ? "prod" : SHARED_RE.test(blastText) ? "shared" : "local",
    reversible: !IRREVERSIBLE_RE.test(prose),
    needs_input: cardOptions(c).some(optionNeedsDirectorInput),
    source: "regex",
  };
}

export async function classifyCardText(
  c: CardText,
  deps: { fetch?: typeof fetch; env?: NodeJS.ProcessEnv } = {}
): Promise<CardClass> {
  const base = classifyCardTextSync(c);
  const mode = typesafeMode(deps.env);
  if (mode === "off") return base;

  const j = await judge(
    { title: c.title ?? "", context: c.context ?? "", risk: c.risk ?? "", blast_radius: c.blast_radius ?? "", options: cardOptions(c) },
    {
      risk: {
        type: "score",
        instructions: "How risky is acting on this decision card without a human?",
        criteria: [
          "low: cosmetic or trivially undone; no data, no money, no other people affected",
          "normal: ordinary scoped work; a mistake is noticed and reverted in the same session",
          "medium: touches shared state, other people's work, or costs money; undoing it takes deliberate effort",
          "high: production, customer data, credentials, money, or anything that cannot be undone",
        ],
      },
      blast: {
        type: "choice",
        instructions: "How far does acting on this reach?",
        criteria: {
          local: "one task, branch, or worktree — nobody else sees it",
          shared: "a migration, schema, infrastructure, pipeline, or anything else shared across the team",
          prod: "production, a deployment, live systems, or customer data",
        },
      },
      reversible: {
        type: "noul",
        instructions: "Can the effect of acting on this be undone?",
        criteria: { true: "revertible by a normal action", false: "destroys data, force-pushes, or is otherwise permanent" },
      },
      needs_input: {
        type: "noul",
        instructions: "Would acting on this require the director to hand over a credential, a file, or account access first?",
        criteria: { true: "the answer is useless without a secret, attachment, or login the director must supply", false: "the agent can act on its own" },
      },
    },
    deps
  );
  if (!j) return base; // null = fail open

  const s = score(j.answers.risk);
  const b = choice(j.answers.blast);
  const rev = noul(j.answers.reversible);
  const inp = noul(j.answers.needs_input);
  const ts: Omit<CardClass, "shadow"> = {
    risk: RISK_ORDER[Math.min(RISK_ORDER.length - 1, Math.max(0, Math.round(s ?? 3)))] ?? base.risk,
    blast: BLAST_ORDER.includes(b as BlastRadius) ? (b as BlastRadius) : base.blast,
    reversible: rev == null ? base.reversible : rev >= 0.5,
    needs_input: inp == null ? base.needs_input : inp >= 0.5,
    source: "typesafe",
  };
  if (mode === "shadow") return { ...base, shadow: ts };

  // Enforce, fail-closed: Jev may tighten freely, and may only loosen `risk`,
  // in the single case where the regex said "high" purely because the prose was
  // unparseable. autoapprove's explicit-low/normal bar is untouched either way,
  // so no Jev answer can turn a refusal into an approval.
  const rank = (r: RiskLevel) => RISK_ORDER.indexOf(r);
  const risk =
    rank(ts.risk) > rank(base.risk) ? ts.risk : base.risk === "high" && riskUnparseable(c.risk) ? ts.risk : base.risk;
  return {
    risk,
    blast: BLAST_ORDER.indexOf(ts.blast) > BLAST_ORDER.indexOf(base.blast) ? ts.blast : base.blast,
    reversible: base.reversible && ts.reversible,
    needs_input: base.needs_input || ts.needs_input,
    source: "typesafe",
  };
}

export function factorsFromPlan(
  plan: { proposed_tasks: { title: string; brief: string }[]; questions: string[] },
  preferenceKnown: boolean
): EscalationFactors {
  const c = classifyCardTextSync({ title: plan.proposed_tasks.map((t) => `${t.title} ${t.brief}`).join(" ") });
  return { reversible: c.reversible, blastRadius: c.blast, ambiguous: plan.questions.length > 0, preferenceKnown };
}
