#!/usr/bin/env bun
// Claude Code hook -> hive transcript reporter.
//
// Reads the `transcript_path` JSONL from the hook stdin payload, extracts the
// NEW assistant turns since a per-transcript line cursor, and POSTs them to hive
// as `assistant_text` (the agent's actual output) and `tool_use` events. This
// replaces the old noisy bare-status POST on every PostToolUse.
//
// Dedup: a sibling `<transcript_path>.hive-cursor` file stores the number of
// transcript lines already processed. Each hook fire (PostToolUse and
// Stop/SubagentStop) only posts lines past the cursor, so nothing double-posts
// even though multiple hook events read the same append-only transcript.
//
// Contract: fail silent, never block the agent. No-op unless HIVE_TASK_ID is set.

import { extractTurns } from "./transcript.ts";

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
const lines = text.split("\n").filter((l) => l.trim());

const cursorFile = transcript + ".hive-cursor";
let cursor = 0;
try {
  cursor = parseInt(await Bun.file(cursorFile).text(), 10) || 0;
} catch {
  /* first run: no cursor yet */
}
if (cursor > lines.length) cursor = 0; // transcript rotated/truncated: resync

const events = extractTurns(lines.slice(cursor));
for (const e of events) {
  try {
    await fetch(`${hiveUrl}/api/tasks/${taskId}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(2000),
      body: JSON.stringify(e),
    });
  } catch {
    /* fail silent */
  }
}
// Advance the cursor to the full line count so the next fire starts fresh.
try {
  await Bun.write(cursorFile, String(lines.length));
} catch {
  /* fail silent */
}
