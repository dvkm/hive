// Pure transcript extraction: turn Claude Code or Codex transcript JSONL lines
// into hive timeline events. Kept dependency-free and side-effect-free so the
// hook runner and unit tests can share it.
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
  if (typeof input === "string") {
    const s = input.replace(/\s+/g, " ").trim();
    return s.length > MAX_SUMMARY ? s.slice(0, MAX_SUMMARY - 1) + "…" : s;
  }
  if (!input || typeof input !== "object") return "";
  let s = "";
  switch (name) {
    case "Bash":
    case "exec_command":
    case "local_shell":
      s = input.command ?? "";
      s ||= input.cmd ?? input.action?.command ?? "";
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

function toolInput(item: any): any {
  const raw = item?.input ?? item?.arguments ?? item?.action ?? {};
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function appendText(out: EventBody[], content: any): void {
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (block?.type !== "text" && block?.type !== "output_text") continue;
    const text = String(block.text ?? "").trim();
    if (text) out.push({ type: "assistant_text", source: "hook", payload: { text } });
  }
}

// Extract ordered event bodies from a slice of NEW transcript lines. Claude
// stores assistant blocks under `type=assistant`; Codex stores them as
// `response_item` rows. Empty and unparseable rows are skipped.
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
    if (row?.type === "assistant") {
      const content = row?.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block?.type === "text") appendText(out, [block]);
        else if (block?.type === "tool_use") {
          const tool = String(block.name ?? "tool");
          out.push({ type: "tool_use", source: "hook", payload: { tool, summary: toolSummary(tool, block.input) } });
        }
      }
      continue;
    }

    const item = row?.type === "response_item" ? row.payload : null;
    if (item?.type === "message" && item.role === "assistant") appendText(out, item.content);
    else if (["custom_tool_call", "function_call", "local_shell_call"].includes(item?.type)) {
      const tool = String(item.name ?? (item.type === "local_shell_call" ? "local_shell" : "tool"));
      out.push({ type: "tool_use", source: "hook", payload: { tool, summary: toolSummary(tool, toolInput(item)) } });
    }
  }
  return out;
}
