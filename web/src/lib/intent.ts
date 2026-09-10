// Browser-side mirror of server/src/intents.ts's parsers. Deliberately a
// mirror, the same way needsYou.ts mirrors the server's dependency gate: the
// card renders the five sections without a round trip, and the server stays the
// authority on what may be accepted.
import { INTENT_SECTIONS, type Intent } from "./domain";

const HEADING = /^##\s+(.+?)\s*$/;

// The text under one heading. "" for a section that exists and is empty.
export function intentSection(body: string, heading: string): string {
  const lines = String(body ?? "").split("\n");
  const start = lines.findIndex((line) => HEADING.exec(line)?.[1] === heading);
  if (start === -1) return "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => HEADING.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
}

export function intentSections(body: string): { heading: string; text: string }[] {
  return INTENT_SECTIONS.map((heading) => ({ heading, text: intentSection(body, heading) }));
}

// Bullets under "## Open questions" nobody has answered. A bullet counts as
// answered only when it carries a ticked checkbox — the same rule the server's
// acceptance gate applies, so the card can say why Accept is refused before the
// director taps it.
export function openQuestions(body: string): string[] {
  return intentSection(body, "Open questions")
    .split("\n")
    .flatMap((line) => {
      const m = /^\s*[-*]\s+(.*)$/.exec(line);
      if (!m) return [];
      const text = m[1].trim();
      return /^\[x\]\s*/i.test(text) ? [] : [text.replace(/^\[\s?\]\s*/, "")];
    })
    .filter(Boolean);
}

// "Ask the originator": one more unchecked bullet under Open questions, which
// is also what holds acceptance until somebody answers it.
export function addOpenQuestion(body: string, question: string): string {
  const lines = String(body ?? "").split("\n");
  const start = lines.findIndex((line) => HEADING.exec(line)?.[1] === "Open questions");
  if (start === -1) return `${body.trimEnd()}\n\n## Open questions\n- [ ] ${question}\n`;
  const out = [...lines];
  out.splice(start + 1, 0, `- [ ] ${question}`);
  return out.join("\n");
}

export function isDraft(intent: Intent): boolean {
  return intent.status === "draft";
}
