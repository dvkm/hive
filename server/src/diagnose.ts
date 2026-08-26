// Pane-tail diagnosis: a "silent" agent's pane usually says exactly what is
// wrong. Before nudging or failing, the reconciler classifies the tail so each
// failure class gets graceful handling instead of nudge→fail (2026-07-11: all
// seven "silent" failures were really dialogs, lost auth, or a full context).
export type PaneDiagnosis =
  | { kind: "auto_mode_setup"; excerpt: string }
  | { kind: "trust_dialog"; excerpt: string }
  | { kind: "blocked_dialog"; excerpt: string }
  | { kind: "auth_lost"; excerpt: string }
  | { kind: "context_full"; excerpt: string }
  | { kind: "usage_limit"; excerpt: string }
  | { kind: "api_error"; excerpt: string }
  | { kind: "queued_input"; excerpt: string }
  | null;

// "You've hit your session limit · resets 4:20pm (America/Los_Angeles)" →
// the next local occurrence of that clock time, as ISO. The reset is a hard
// wall nudging can't move (44% of sampled sessions hit it; nudges just
// re-triggered the same reply, and redispatch came ~19h later by hand).
// ponytail: assumes the message's timezone is the server's own — hive and its
// agents run on the same machine.
export function parseResetClock(text: string, nowMs: number): string | null {
  const m = /resets\s+(\d{1,2})(?::(\d{2}))?\s*([ap]m)/i.exec(text);
  if (!m) return null;
  let h = Number(m[1]) % 12;
  if (m[3].toLowerCase() === "pm") h += 12;
  const d = new Date(nowMs);
  d.setHours(h, Number(m[2] ?? 0), 0, 0);
  if (d.getTime() <= nowMs) d.setDate(d.getDate() + 1);
  return d.toISOString();
}

// A few lines of context around the matched line, newest text last.
function excerptAround(lines: string[], idx: number, before = 8, after = 4): string {
  return lines
    .slice(Math.max(0, idx - before), Math.min(lines.length, idx + after + 1))
    .join("\n")
    .trim()
    .slice(0, 900);
}

// Dialogs hive answers by itself. Default: MCP tool approvals whose tool name
// is read-shaped (`<server> - get_*/list_*/search_*/read_*/whoami(…) (MCP)`) —
// screenshots, metadata, searches. Write-shaped MCP tools, sensitive-file
// prompts, and anything unrecognized still escalate to a card. Projects extend
// via config.dialog_auto_approve (regex strings, case-insensitive).
const AUTO_APPROVE_DEFAULT = [/ - (get|list|search|read|whoami)[a-z_]*\b/i];

export function dialogAutoApprovable(excerpt: string, extraPatterns: string[] = []): boolean {
  if (AUTO_APPROVE_DEFAULT.some((rx) => rx.test(excerpt))) return true;
  for (const p of extraPatterns) {
    try {
      if (new RegExp(p, "i").test(excerpt)) return true;
    } catch {
      /* a bad user regex must never break recovery */
    }
  }
  return false;
}

export function diagnosePane(tail: string): PaneDiagnosis {
  const lines = (tail ?? "").split("\n");
  const find = (rx: RegExp) => {
    for (let i = lines.length - 1; i >= 0; i--) if (rx.test(lines[i])) return i;
    return -1;
  };

  // Claude Code queued a submitted message (sent while it was mid-turn) but
  // went idle without auto-draining it (task #1098, incident 2026-08-19: a
  // steer's Enter landed, the text queued exactly as the UI intends, and then
  // the turn that would have drained it just never started). The footer is the
  // CLI's own signal that something is queued for a future turn, so it's safe
  // to act on directly.
  const footer = lines.slice(-6);
  const queued = footer.findIndex((line) => /^\s*Press up to edit queued messages\s*$/i.test(line));
  if (queued !== -1)
    return { kind: "queued_input", excerpt: excerptAround(lines, lines.length - footer.length + queued) };

  // Dialogs are the next most specific, actionable state.
  const autoMode = find(/Set up auto mode for your environment\?/i);
  if (
    autoMode !== -1 &&
    (/Also scan shell history/i.test(tail) || (/Auto mode lets Claude act without asking/i.test(tail) && /Not now/i.test(tail)))
  )
    return { kind: "auto_mode_setup", excerpt: excerptAround(lines, autoMode, 4, 14) };
  const trust = find(/Quick safety check:|Yes, I trust this folder/i);
  if (trust !== -1 && /Quick safety check:/i.test(tail) && /Yes, I trust this folder/i.test(tail))
    return { kind: "trust_dialog", excerpt: excerptAround(lines, trust, 12, 6) };
  const dialog = find(/Do you want to proceed\?|Esc to cancel|requested permissions to/i);
  if (dialog !== -1) return { kind: "blocked_dialog", excerpt: excerptAround(lines, dialog, 12, 6) };

  const auth = find(/Not logged in|Please run \/login|OAuth token .*(expired|revoked)|Invalid API key|authentication_error/i);
  if (auth !== -1) return { kind: "auth_lost", excerpt: excerptAround(lines, auth) };

  const ctx = find(/\/clear to save [\d.]+k tokens|[Cc]ontext (window is )?(low|full)|approaching.*context limit|Conversation compacted/);
  if (ctx !== -1) return { kind: "context_full", excerpt: excerptAround(lines, ctx) };

  const limit = find(/hit your (session|usage|weekly) limit/i);
  if (limit !== -1) return { kind: "usage_limit", excerpt: excerptAround(lines, limit) };

  const api = find(/rate.?limit|overloaded_error|529|API Error|ETIMEDOUT|ENOTFOUND|ECONNRESET|fetch failed|network error|Unable to connect/i);
  if (api !== -1) return { kind: "api_error", excerpt: excerptAround(lines, api) };

  return null;
}

// ---- codex edit confirmations --------------------------------------------
// Codex asks before writing files: "Would you like to make the following
// edits?" with its 1/2/3 choices. That is a WRITE, not a command — an `rm -rf`
// or any other shell approval is a different prompt and never matches here.
// Returns the files the pending edit touches, or null when the tail is not a
// codex edit confirmation (or names no file we can read). The caller decides
// whether those paths are the agent's to write (reconciler.autoAnswerDialog).
const EDIT_PROMPT = /Would you like to make the following edits\?/;
const EDIT_CHOICES = /don't ask again for these files/i;

// The pane hard-wraps: a long path continues on the next line, so a bullet is
// complete only once its "(+N -M)" tail shows up. Join until it does.
function unwrapBullet(lines: string[], i: number): string {
  let s = lines[i].trim();
  for (let j = i + 1; j < lines.length && !/\(\+\d+\s+-\d+\)/.test(s); j++) {
    const next = lines[j].trim();
    if (!next) break;
    s += next;
  }
  return s;
}

export function editDialogPaths(tail: string): string[] | null {
  const lines = (tail ?? "").split("\n");
  const prompt = lines.findLastIndex((l) => EDIT_PROMPT.test(l));
  if (prompt === -1 || !EDIT_CHOICES.test(tail)) return null;

  const paths: string[] = [];
  // "Destination:" names the file outright; its path may wrap over several
  // lines and ends at the blank line before the choices.
  const dest = lines.findLastIndex((l, i) => i > prompt && /^\s*Destination:\s*$/.test(l));
  if (dest !== -1) {
    let p = "";
    for (let i = dest + 1; i < lines.length && lines[i].trim(); i++) p += lines[i].trim();
    if (p) paths.push(p);
  }
  // Otherwise the diff above the prompt is headed by codex's own file bullet.
  // Only THIS dialog's diff counts: the pane still holds bullets from edits
  // approved minutes ago, and approving a dialog whose real files were never
  // checked is the one failure this feature cannot have. So take the single
  // contiguous block directly above the prompt (blank lines bound it) and
  // never widen — no bullet in that block means we do not know what the edit
  // touches, and the caller parks it for the director.
  let end = prompt;
  while (end > 0 && !lines[end - 1].trim()) end--; // blank separator above the prompt
  let start = end;
  while (start > 0 && lines[start - 1].trim()) start--;
  for (let i = start; i < end; i++) {
    const m = /^[•*]\s+(?:Added|Edited|Updated|Created|Deleted)\s+(\S.*)$/.exec(lines[i].trim());
    if (m) paths.push(unwrapBullet(lines, i).replace(/^[•*]\s+\w+\s+/, "").replace(/\s*\(\+\d+\s+-\d+\).*$/, ""));
  }
  return paths.length ? paths : null;
}
