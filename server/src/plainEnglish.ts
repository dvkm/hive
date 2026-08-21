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
Everything you write here lands in front of a busy director, often on a phone.
Write it the way you would say it out loud:

- One idea per sentence, around 20 words or fewer. If a sentence needs a second
  comma to survive, split it in two.
- Everyday words. Write "checks the list twice", not "performs a dual-pass
  verification".
- Spell out jargon and abbreviations the first time, then use the short form.
- No nested parentheticals, no stacked clauses, no noun pile-ups.
- Lead with the point. The first line says what happened or what to decide; the
  detail comes after.
- Keep the facts exact. File paths, numbers, identifiers, and product strings
  (including Korean UI text such as "임시저장") stay verbatim — only the sentence
  around them gets simpler.
- Say each fact ONCE per artifact. If a bullet, question, or option repeats
  something already stated above it, delete it or write only the new part.

Bad:  "root formula restated as the two-step curve, widths extended to check
      1439 and 1440 either side of the step"
Good: "The formula is now written as a two-step curve. The test checks the
      width on both sides of the step, at 1439 and 1440."`;
