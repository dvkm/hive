// The intent record: what was asked, and what the director accepted.
//
// hive had no durable record of either. The ask lived in a task brief, which
// dies with the task (Jira WEB-101's post-Done comments landed on nothing), and
// the understanding quiz was minted from the review diff rather than from what
// was accepted, so #2190 was re-asked three times. Anthropic's AI-Native SDLC
// playbook (2026-08-21) puts an intent.md first in the loop — intent → spec →
// plan → diff → PR → incident → new intent — and this is that record inside hive.
//
// body_md is Markdown with EXACTLY the playbook's five headings, in order.
// Deterministic parsing, no model call: the UI renders the sections it finds.
import type { DB } from "./db.ts";

export const INTENT_SECTIONS = [
  "Problem",
  "Proposed outcome",
  "Affected users and systems",
  "Constraints",
  "Open questions",
] as const;

export const INTENT_SOURCES = ["jira", "director", "incident", "agent"] as const;
export const INTENT_STATUSES = ["draft", "accepted", "superseded"] as const;

export interface Intent {
  id: string;
  project_id: string;
  task_id: string | null;
  source: string;
  source_ref: string | null;
  status: string;
  body_md: string;
  author: string | null;
  accepted_by: string | null;
  accepted_at: string | null;
  created_at: string;
  updated_at: string;
}

const HEADING = /^##\s+(.+?)\s*$/;

// The five headings, in order, or the reason this body is not an intent. The
// order is load-bearing: a reader scans Problem before Constraints, and a
// generated brief (deliverable 2) reads the sections positionally.
export function intentBodyError(body: string): string | null {
  const found = String(body ?? "")
    .split("\n")
    .flatMap((line) => {
      const m = HEADING.exec(line);
      return m ? [m[1]] : [];
    });
  if (found.length === INTENT_SECTIONS.length && found.every((h, i) => h === INTENT_SECTIONS[i])) return null;
  return `body_md needs exactly these five headings, in this order: ${INTENT_SECTIONS.map((s) => `## ${s}`).join(", ")} (found: ${found.length ? found.map((s) => `## ${s}`).join(", ") : "none"})`;
}

// The text under one heading. Returns "" for a section that exists and is empty.
export function intentSection(body: string, heading: string): string {
  const lines = String(body ?? "").split("\n");
  const start = lines.findIndex((line) => HEADING.exec(line)?.[1] === heading);
  if (start === -1) return "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => HEADING.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
}

// Bullets under "## Open questions" that are still open. A bullet counts as
// answered ONLY when it carries a ticked checkbox; a plain bullet is a question
// nobody has answered yet, which is the whole point of the acceptance gate.
// Prose that is not a bullet ("None.") is not a question.
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

// Add one unchecked bullet under "## Open questions" — the "Ask the originator"
// action. Appends to that section rather than the end of the file, so the five
// headings stay in order.
export function addOpenQuestion(body: string, question: string): string {
  const lines = String(body ?? "").split("\n");
  const start = lines.findIndex((line) => HEADING.exec(line)?.[1] === "Open questions");
  if (start === -1) return `${body.trimEnd()}\n\n## Open questions\n- [ ] ${question}\n`;
  const bullet = `- [ ] ${question}`;
  const out = [...lines];
  out.splice(start + 1, 0, bullet);
  return out.join("\n");
}

export function getIntent(db: DB, id: string): Intent | null {
  return (db.query("SELECT * FROM intents WHERE id = ?").get(id) as Intent | undefined) ?? null;
}

// The dispatcher's gate: a task whose intent is still a draft has not been
// accepted by anyone, so no agent starts on it. Only `draft` blocks — an
// accepted intent dispatches, and a superseded one has already re-pointed its
// task at the replacement.
export function intentNotAccepted(db: DB, task: { intent_id?: string | null } | null | undefined): boolean {
  const id = task?.intent_id;
  if (!id) return false;
  return getIntent(db, id)?.status === "draft";
}

// Where the accepted intent is versioned in the project repo. The Jira key when
// there is one, so the file is findable by the ticket everyone else uses.
export function intentSlug(task: { jira_key?: string | null; number?: number }): string {
  const key = String(task?.jira_key ?? "").trim();
  return key || `hive-${task?.number ?? 0}`;
}

// The intent file to drop into a fresh worktree, or null when this task has no
// accepted intent. The agent's first commit versions it with the code.
export function intentFileFor(db: DB, task: { intent_id?: string | null; jira_key?: string | null; number?: number }): { path: string; body: string } | null {
  const id = task?.intent_id;
  if (!id) return null;
  const intent = getIntent(db, id);
  if (!intent || intent.status !== "accepted") return null;
  return { path: `intent/${intentSlug(task)}.md`, body: intent.body_md.endsWith("\n") ? intent.body_md : `${intent.body_md}\n` };
}
