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

  // Order matters: a dialog is the most specific, actionable state.
  const autoMode = find(/Set up auto mode for your environment\?/i);
  if (autoMode !== -1 && /Also scan shell history/i.test(tail))
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
