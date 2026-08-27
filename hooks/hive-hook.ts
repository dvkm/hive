#!/usr/bin/env bun
// Cross-platform Claude Code / Codex lifecycle hook. The historical `.sh`
// wrapper remains for existing Unix installs; new Hive spawns call this file
// directly with Bun so native Windows does not depend on WSL or shell syntax.
import { join } from "node:path";

const taskId = process.env.HIVE_TASK_ID;
if (!taskId) process.exit(0);

const event = process.argv[2] || "Stop";
const hiveUrl = process.env.HIVE_URL || `http://127.0.0.1:${process.env.HIVE_PORT || 4700}`;
const input = await Bun.stdin.text().catch(() => "");

async function runReporter(name: string): Promise<void> {
  try {
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, name)], {
      env: process.env,
      stdin: "pipe",
      stdout: "ignore",
      stderr: "ignore",
    });
    proc.stdin.write(input);
    await proc.stdin.end();
    const timeout = setTimeout(() => proc.kill(), 5_000);
    await proc.exited;
    clearTimeout(timeout);
  } catch {
    // Hooks are telemetry. They must never block or crash the worker.
  }
}

await runReporter("report-transcript.ts");

if (event === "Stop" || event === "SubagentStop") {
  await runReporter("report-usage.ts");
  try {
    await fetch(`${hiveUrl}/api/tasks/${taskId}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "agent_turn_end", source: "hook", payload: { hook: event } }),
      signal: AbortSignal.timeout(2_000),
    });
  } catch {
    // Fail silent: the reconciler remains the lifecycle backstop.
  }
}

if (process.env.HIVE_AGENT === "codex") console.log("{}");
