import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";

const workspace = resolve(process.argv[2] || "");
if (!process.argv[2]) throw new Error("usage: bun run benchmark:score <benchmark-workspace>");
const metadata = JSON.parse(readFileSync(join(workspace, ".hive-benchmark.json"), "utf8"));
const base = process.env.HIVE_URL || `http://127.0.0.1:${process.env.HIVE_PORT || 4700}`;

async function get(path: string): Promise<any> {
  const response = await fetch(base + path);
  const data = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${data.error || response.statusText}`);
  return data;
}

const acceptance = Bun.spawnSync(["bun", "run", "check"], { cwd: workspace });
const acceptanceHash = createHash("sha256").update(readFileSync(join(workspace, "acceptance.ts"))).digest("hex");
const thread = await get(`/api/chat/threads/${metadata.thread_id}`);
const tasks = await get(`/api/tasks?project_id=${metadata.project_id}`);
const decisions = await get(`/api/decisions?status=open&project_id=${metadata.project_id}`);
const workers = tasks.filter((task: any) => task.source !== "chat_supervisor");
const directorTurns = thread.messages.filter((message: any) => message.role === "director").length;
const commitments = thread.commitments ?? [];
const decisionMemos = (thread.meetings ?? []).filter((meeting: any) => meeting.stage === "decided");
const checks = {
  acceptance_passed: acceptance.exitCode === 0,
  evaluator_unchanged: acceptanceHash === metadata.acceptance_sha256,
  run_completed: thread.phase === "complete",
  verification_passed: thread.verifications?.[0]?.status === "passed",
  retrospective_recorded: !!thread.retrospectives?.length,
  no_extra_human_turns: directorTurns === 1,
  no_open_decisions: decisions.length === 0,
  commitments_completed: commitments.length > 0 && commitments.every((commitment: any) => commitment.status === "done"),
  decision_memo_recorded: decisionMemos.length > 0,
};
const passed = Object.values(checks).filter(Boolean).length;
console.log(JSON.stringify({
  score: `${passed}/${Object.keys(checks).length}`,
  checks,
  worker_tasks: workers.length,
  failed_workers: workers.filter((task: any) => task.state === "failed").length,
  commitments: commitments.length,
  decision_memos: decisionMemos.length,
  acceptance_output: acceptance.stdout.toString().trim(),
  acceptance_errors: acceptance.stderr.toString().trim(),
}, null, 2));

if (passed !== Object.keys(checks).length) process.exit(1);
