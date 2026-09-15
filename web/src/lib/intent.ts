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

// Every bullet under "## Open questions", ticked or not, in document order.
export function questionBullets(body: string): { text: string; done: boolean }[] {
  return intentSection(body, "Open questions")
    .split("\n")
    .flatMap((line) => {
      const m = /^\s*[-*]\s+(.*)$/.exec(line);
      if (!m) return [];
      const raw = m[1].trim();
      const done = /^\[x\]\s*/i.test(raw);
      return [{ text: raw.replace(/^\[[x\s]?\]\s*/i, ""), done }];
    });
}

// Tick the nth unanswered bullet (in openQuestions order) and keep the answer
// on the same line, so the server's "[x]" gate and a reader of the Markdown
// both see it. Ticking is what unlocks Accept; the answer text is optional.
export function answerOpenQuestion(body: string, index: number, answer = ""): string {
  const lines = String(body ?? "").split("\n");
  const start = lines.findIndex((line) => HEADING.exec(line)?.[1] === "Open questions");
  if (start === -1) return body;
  let seen = 0;
  for (let i = start + 1; i < lines.length && !HEADING.test(lines[i]); i++) {
    const m = /^(\s*[-*]\s+)(.*)$/.exec(lines[i]);
    if (!m || /^\[x\]/i.test(m[2].trim())) continue;
    if (seen++ !== index) continue;
    const question = m[2].trim().replace(/^\[\s?\]\s*/, "");
    lines[i] = `${m[1]}[x] ${question}${answer.trim() ? ` — ${answer.trim()}` : ""}`;
    return lines.join("\n");
  }
  return body;
}

// Mirror of server/src/intentDraft.ts DEFAULT_OPEN_QUESTION: the one question
// hive itself adds to every draft so a human reads it before an agent starts.
// On the card, Accept IS the answer to it; only questions people asked hold.
export const DEFAULT_OPEN_QUESTION = "Is this the ask, and what does done look like? Tick this once you have read the draft.";

export function isHiveQuestion(text: string): boolean {
  return text.trim() === DEFAULT_OPEN_QUESTION;
}

// What Accept saves before it accepts: hive's own question ticked, everything
// else untouched. Returns the body unchanged when hive did not ask.
export function answerHiveQuestion(body: string): string {
  const mine = openQuestions(body).findIndex(isHiveQuestion);
  return mine >= 0 ? answerOpenQuestion(body, mine) : body;
}

// Replace what sits under one heading (adding the heading at the end if the
// draft lacks it), so a section can be filled in from the card without opening
// the whole Markdown.
export function setIntentSection(body: string, heading: string, text: string): string {
  const lines = String(body ?? "").split("\n");
  const start = lines.findIndex((line) => HEADING.exec(line)?.[1] === heading);
  const block = text.trim() ? [text.trim(), ""] : [""];
  if (start === -1) return `${String(body ?? "").trimEnd()}\n\n## ${heading}\n${block.join("\n")}`;
  const rest = lines.slice(start + 1);
  const next = rest.findIndex((line) => HEADING.test(line));
  const end = next === -1 ? lines.length : start + 1 + next;
  return [...lines.slice(0, start + 1), ...block, ...lines.slice(end)].join("\n");
}

export function isDraft(intent: Intent): boolean {
  return intent.status === "draft";
}
