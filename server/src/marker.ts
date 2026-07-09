// The canonical PR ↔ task marker. THE contract (documented in docs/API.md):
//   - PR title MUST start with the prefix `[hive-<number>] `
//   - PR body MUST include the footer line `hive-task: <id>`
// The id footer is the primary link (stable, unique machine key); the number in
// the title is a human-readable fallback used when the footer is missing.
export function prTitlePrefix(number: number): string {
  return `[hive-${number}] `;
}

export function prBodyFooter(id: string): string {
  return `hive-task: ${id}`;
}

// Both halves of the marker for a task, ready to hand to an agent/CLI.
export function prMarker(number: number, id: string): { titlePrefix: string; bodyFooter: string } {
  return { titlePrefix: prTitlePrefix(number), bodyFooter: prBodyFooter(id) };
}

// Parse the task id out of a PR body's `hive-task: <id>` footer. ids are the
// 12-char hex from newId(); accept the general id charset to stay forgiving.
export function taskIdFromBody(body: string | null | undefined): string | null {
  if (!body) return null;
  return /hive-task:\s*([A-Za-z0-9_]+)/.exec(body)?.[1] ?? null;
}

// Parse the task number out of a PR title's `[hive-<number>]` prefix.
export function taskNumberFromTitle(title: string | null | undefined): number | null {
  if (!title) return null;
  const m = /\[hive-(\d+)\]/.exec(title);
  return m ? Number(m[1]) : null;
}
