#!/usr/bin/env bun
// Claude Code Stop-hook usage reporter -> hive.
//
// The Stop-hook JSON payload does NOT carry token counts, but it carries
// `transcript_path` — a JSONL where every assistant message has a `message.usage`
// block (input_tokens, output_tokens, cache_read_input_tokens,
// cache_creation_input_tokens) and `message.model`. We aggregate per model and
// POST one `usage` event per model to hive's ingestion endpoint.
//
// Contract: fail silent, never block the agent. No-op unless HIVE_TASK_ID is set.
//
// Totals are CUMULATIVE for the whole transcript, posted with a session_id (the
// transcript basename): hive upserts one usage row per (task, session, model),
// so repeated Stops CONVERGE instead of stacking. The previous version posted a
// fresh row per Stop — hive agents are interactive (Stop fires every turn), so
// a 50-turn session billed ~50 cumulative rows and inflated task costs by an
// order of magnitude (the "cost calculations are wrong" complaint, 2026-07-12).

const taskId = process.env.HIVE_TASK_ID;
if (!taskId) process.exit(0);
const hiveUrl = process.env.HIVE_URL || `http://127.0.0.1:${process.env.HIVE_PORT || 4700}`;

let payload: any = {};
try {
  payload = JSON.parse((await Bun.stdin.text()) || "{}");
} catch {
  process.exit(0);
}
const transcript = payload.transcript_path;
if (!transcript) process.exit(0);

let text = "";
try {
  text = await Bun.file(transcript).text();
} catch {
  process.exit(0);
}

type Agg = {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
};
const perModel: Record<string, Agg> = {};
for (const line of text.split("\n")) {
  if (!line.trim()) continue;
  let row: any;
  try {
    row = JSON.parse(line);
  } catch {
    continue;
  }
  const msg = row?.message;
  if (row?.type !== "assistant" || !msg?.usage) continue;
  const u = msg.usage;
  const model = msg.model || "unknown";
  const a = (perModel[model] ??= {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
  });
  a.input_tokens += u.input_tokens || 0;
  a.output_tokens += u.output_tokens || 0;
  a.cache_read_tokens += u.cache_read_input_tokens || 0;
  a.cache_write_tokens += u.cache_creation_input_tokens || 0;
}

// The transcript filename is the session uuid — stable across every Stop of
// this session, distinct across respawns of the same task.
const sessionId = String(transcript).split("/").pop()?.replace(/\.jsonl$/, "") || null;

for (const [model, a] of Object.entries(perModel)) {
  if (!Object.values(a).some(Boolean)) continue;
  try {
    await fetch(`${hiveUrl}/api/tasks/${taskId}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(2000),
      body: JSON.stringify({ type: "usage", source: "hook", model, session_id: sessionId, ...a }),
    });
  } catch {
    /* fail silent */
  }
}
