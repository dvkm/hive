// The plain-language bar for every string a human director reads: task titles
// and briefs the planner writes, agent status notes and checkpoints, decision
// cards, report bullets, review summaries, and understanding-quiz questions.
//
// Injected verbatim into every prompt that produces such text (briefs.ts,
// planner.ts, reviewer.ts, drift.ts) so the bar cannot drift apart between
// them. Director feedback 2026-08-19: quizzes and briefs read like compressed
// engineer shorthand, e.g. "root formula restated as the two-step curve, widths
// extended to check 1439 and 1440 either side of the step" — that example is
// the `Bad:` line below, on purpose.
//
// Companion to the "Design all director-facing output for an ADHD reader"
// global policy: that one decides WHAT is worth showing, this one decides HOW
// each sentence is worded.
export const PLAIN_ENGLISH = `## Plain English (required for every line a human reads)
Write for a busy director on a phone. Lead with the point. Use everyday words,
one idea per sentence, and spell out jargon once. Avoid nested clauses and noun
piles. Keep paths, numbers, identifiers, and product strings exact. State each
fact once. If a sentence needs a second comma, split it.`;
