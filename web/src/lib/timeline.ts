// Pure timeline builder: fold a task's raw events into readable timeline items.
// No React, no store — a function of (events, decisions) so it unit-tests cleanly.
//
// What it does:
//   - drops legacy hook-status noise (`status` events with note "hook: …") and
//     the quiet `agent_turn_end` heartbeat.
//   - renders `assistant_text` as a transcript bubble (the agent's speech).
//   - groups consecutive `tool_use` events into ONE "used N tools" item.
//   - hydrates a `needs-decision` event into a decision block carrying the full
//     question + options + (if answered) the resolved answer — the paired
//     `decision_answered` event is folded in, not shown as its own row.

export interface TLEvent {
  id: string;
  ts: string;
  source: string;
  type: string;
  payload: Record<string, unknown>;
}

export interface TLOption {
  key: string;
  label?: string;
  detail?: string;
}

export interface TLDecision {
  id: string;
  title: string;
  context?: string | null;
  risk?: string | null;
  status: string; // "open" | answered
  answer_key?: string | null;
  answer_note?: string | null;
  answered_at?: string | null;
  answered_by?: string | null;
  options?: TLOption[];
}

export type TimelineItem =
  | { kind: "event"; id: string; ts: string; ev: TLEvent }
  | { kind: "text"; id: string; ts: string; source: string; text: string }
  | { kind: "tools"; id: string; ts: string; tools: { tool: string; summary: string }[] }
  | { kind: "decision"; id: string; ts: string; decision: TLDecision; open: boolean; answerLabel: string | null };

// True for the bare hook-status rows we want gone (also cleans legacy data).
export function isHookStatusNoise(ev: { type: string; payload?: Record<string, unknown> }): boolean {
  return ev.type === "status" && String(ev.payload?.note ?? "").startsWith("hook:");
}

// Resolve an answer_key to its human option label (falls back to the key).
export function answerLabelOf(d: TLDecision): string | null {
  if (!d.answer_key) return null;
  const opt = d.options?.find((o) => o.key === d.answer_key);
  return opt?.label || d.answer_key;
}

// Build the timeline in chronological order (oldest → newest) — a transcript
// reads top-to-bottom. `events` may arrive in any order; it is sorted here.
export function buildTimeline(events: TLEvent[], decisions: TLDecision[]): TimelineItem[] {
  const byId = new Map(decisions.map((d) => [d.id, d]));
  // Stable sort by ts ONLY: hook bursts collapse many events into one
  // millisecond, and the server already returns same-ts rows in insertion
  // (transcript) order — a random-id tiebreak here would scramble that order.
  const sorted = [...events].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));

  const items: TimelineItem[] = [];
  let toolRun: { id: string; ts: string; tools: { tool: string; summary: string }[] } | null = null;
  const flush = () => {
    if (toolRun) {
      items.push({ kind: "tools", id: toolRun.id, ts: toolRun.ts, tools: toolRun.tools });
      toolRun = null;
    }
  };

  for (const ev of sorted) {
    // Drop noise: legacy hook status, quiet turn-end heartbeat, and the
    // decision_answered event (folded into its decision block below).
    if (isHookStatusNoise(ev) || ev.type === "agent_turn_end" || ev.type === "decision_answered") {
      continue;
    }

    if (ev.type === "tool_use") {
      const tool = String(ev.payload?.tool ?? "tool");
      const summary = String(ev.payload?.summary ?? "");
      if (!toolRun) toolRun = { id: ev.id, ts: ev.ts, tools: [] };
      toolRun.tools.push({ tool, summary });
      continue;
    }
    flush(); // any non-tool event closes the current tool run

    if (ev.type === "assistant_text") {
      const text = String(ev.payload?.text ?? "");
      if (text.trim()) items.push({ kind: "text", id: ev.id, ts: ev.ts, source: ev.source, text });
      continue;
    }

    if (ev.type === "jira_comment") {
      const text = String(ev.payload?.text ?? "").trim();
      const author = ev.payload?.direction === "inbound" ? String(ev.payload?.author ?? "Jira") : "";
      if (text) items.push({ kind: "text", id: ev.id, ts: ev.ts, source: ev.source, text: author ? `${author}: ${text}` : text });
      continue;
    }

    if (ev.type === "needs-decision") {
      const d = byId.get(String(ev.payload?.decision_id ?? ""));
      if (d) {
        const open = d.status === "open";
        items.push({ kind: "decision", id: ev.id, ts: ev.ts, decision: d, open, answerLabel: answerLabelOf(d) });
        continue;
      }
      // No hydrated decision (shouldn't happen): fall through to a plain event.
    }

    items.push({ kind: "event", id: ev.id, ts: ev.ts, ev });
  }
  flush();
  return items;
}
