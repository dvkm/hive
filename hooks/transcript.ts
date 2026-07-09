// Pure transcript extraction: turn Claude Code transcript JSONL lines into hive
// timeline events. Kept dependency-free and side-effect-free so report-transcript.ts
// (the hook runner) and the unit tests can share it.
//
// The transcript is append-only JSONL. Each assistant row looks like:
//   {"type":"assistant","message":{"content":[
//      {"type":"text","text":"..."},
//      {"type":"tool_use","name":"Bash","input":{"command":"..."}}]}}
// We emit one `assistant_text` event per text block (the agent's actual output)
// and one `tool_use` event per tool_use block (a cheap one-line summary, never
// the full input).

export interface EventBody {
  type: "assistant_text" | "tool_use";
  source: "hook";
  payload: Record<string, unknown>;
}

const MAX_SUMMARY = 200;

// One cheap, sensible field per tool — never dump the whole input blob.
export function toolSummary(name: string, input: any): string {
  if (!input || typeof input !== "object") return "";
  let s = "";
  switch (name) {
    case "Bash":
      s = input.command ?? "";
      break;
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      s = input.file_path ?? input.notebook_path ?? "";
      break;
    case "Grep":
    case "Glob":
      s = input.pattern ?? "";
      break;
    case "Task":
      s = input.description ?? "";
      break;
    case "WebFetch":
      s = input.url ?? "";
      break;
    case "WebSearch":
      s = input.query ?? "";
      break;
    case "TodoWrite":
      s = "";
      break;
    default:
      // Best-effort: pick the first obviously-scalar hint field.
      s = input.file_path ?? input.command ?? input.pattern ?? input.url ?? input.query ?? input.description ?? "";
  }
  s = String(s).replace(/\s+/g, " ").trim();
  return s.length > MAX_SUMMARY ? s.slice(0, MAX_SUMMARY - 1) + "…" : s;
}

// Extract ordered event bodies from a slice of NEW transcript lines. Non-assistant
// rows and unparseable lines are skipped. Empty/whitespace text blocks are dropped.
export function extractTurns(lines: string[]): EventBody[] {
  const out: EventBody[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let row: any;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row?.type !== "assistant") continue;
    const content = row?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === "text") {
        const text = String(block.text ?? "").trim();
        if (text) out.push({ type: "assistant_text", source: "hook", payload: { text } });
      } else if (block?.type === "tool_use") {
        const tool = String(block.name ?? "tool");
        out.push({ type: "tool_use", source: "hook", payload: { tool, summary: toolSummary(tool, block.input) } });
      }
    }
  }
  return out;
}
