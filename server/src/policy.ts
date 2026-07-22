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
const PROD_RE = /\bprod(uction)?\b|\bdeploy(ment)?\b|\bcustomer data\b/i;
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

export function factorsFromPlan(
  plan: { proposed_tasks: { title: string; brief: string }[]; questions: string[] },
  preferenceKnown: boolean
): EscalationFactors {
  const text = plan.proposed_tasks.map((t) => `${t.title} ${t.brief}`).join(" ");
  return {
    reversible: !IRREVERSIBLE_RE.test(text),
    blastRadius: PROD_RE.test(text) ? "prod" : SHARED_RE.test(text) ? "shared" : "local",
    ambiguous: plan.questions.length > 0,
    preferenceKnown,
  };
}
