// What a review card leads with (HIVE-557). The card used to open with a
// recommendation and a wall of prose; a person deciding actually wants four
// things, in this order: what changed, what state it left behind, why it was
// needed, and whether it needs them. Everything here is derived from data the
// card already loads — no new server field and no new prose from the agent.

// One line on a phone is ~60 characters, two is the most a glance tolerates.
// Same cap the catchup cards use (server/src/glance.ts HEADLINE_MAX).
export const ONE_LINE_MAX = 140;

// Prefers the first sentence when it fits on its own; otherwise cuts at a word
// boundary and marks the cut. Mirrors headline() in server/src/glance.ts.
export function oneLine(text: unknown, max = ONE_LINE_MAX): string {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!flat) return "";
  const first = flat.match(/^.*?[.!?](?=\s|$)/)?.[0];
  const pick = first && first.length <= max ? first : flat;
  if (pick.length <= max) return pick;
  const cut = pick.slice(0, max);
  const space = cut.lastIndexOf(" ");
  // A cut that lands after "and" or "with" reads as a typo; drop the dangling
  // word so the ellipsis is the only sign of the cut.
  const kept = (space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/, "");
  return `${kept.replace(/\s+(and|or|but|with|that|to|of|for|in|on|the|a)$/i, "")}…`;
}

export interface StateChange {
  label: string;
  before: string;
  after: string;
  // The review item it was read out of, so the card can avoid printing that
  // same sentence again lower down.
  source: string;
}

// A value worth putting in a state table is short and at least one side of it
// is a number: "7 -> 0", "113 -> 113", "in_review -> done". A sentence that
// happens to contain an arrow between two clauses is not a state change.
const PAIR = /([A-Za-z0-9_.%$/+-]{1,16})\s*(?:->|→|=>)\s*([A-Za-z0-9_.%$/+-]{1,16})/;

// Words that end a label but say nothing: the label is what was measured.
const LABEL_MAX = 44;

function labelFor(before: string): string {
  // Agents write "Verified on a copy of the live DB: stranded-row count 7 -> 0".
  // The useful label is the last clause, not the whole preamble.
  const clause = before.split(/[:;,(]/).pop() ?? "";
  const words = clause.trim().split(/\s+/).filter(Boolean).slice(-5).join(" ");
  const flat = (words || clause.trim()).replace(/^[^A-Za-z0-9]+/, "");
  return flat.length > LABEL_MAX ? `${flat.slice(0, LABEL_MAX - 1)}…` : flat;
}

// Reads "label A -> B" out of the agent's own review lines. One row per line,
// the first pair wins: a line listing two changes is prose, and prose belongs
// in the collapsed audit.
export function stateChanges(items: string[]): StateChange[] {
  const rows: StateChange[] = [];
  for (const item of items) {
    const flat = String(item ?? "").replace(/\s+/g, " ").trim();
    const m = flat.match(PAIR);
    if (!m) continue;
    const trim = (v: string) => v.replace(/[.,;:]+$/, "");
    const before = trim(m[1]);
    const after = trim(m[2]);
    if (!before || !after) continue;
    if (!/\d/.test(before) && !/\d/.test(after)) continue;
    const label = labelFor(flat.slice(0, m.index));
    if (!label) continue;
    rows.push({ label, before, after, source: flat });
  }
  return rows;
}

// Everything the card promoted into a lead section, so the collapsed lists can
// drop it. Compared on flattened text: the same sentence, rendered twice, is
// the single biggest reason the old card was a thousand words.
export function withoutPromoted<T>(items: T[] | undefined, promoted: string[], text: (item: T) => string): T[] {
  const seen = new Set(promoted.map((p) => p.replace(/\s+/g, " ").trim()));
  return (items ?? []).filter((item) => !seen.has(text(item).replace(/\s+/g, " ").trim()));
}

// Two sentences of thought process, no more. Prefers the packet the agent
// wrote for it; falls back to the Completed line that explains a cause, which
// is where an agent without an understanding packet puts its reasoning.
export const WHY_MAX = 260;
const CAUSE = /\bbecause\b|\bsince\b|\bwhy\b|\bso that\b|\broot cause\b/i;

// `source` is the review line the text came from, so the collapsed Completed
// list can drop it instead of saying it twice.
export function whyItWasNeeded(background: string | undefined, done: string[]): { text: string; source: string } {
  if (background?.trim()) return { text: oneLine(background, WHY_MAX), source: "" };
  const cause = done.find((item) => CAUSE.test(item));
  return cause ? { text: oneLine(cause, WHY_MAX), source: cause } : { text: "", source: "" };
}
