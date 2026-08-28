import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const base = process.env.HIVE_URL || `http://127.0.0.1:${process.env.HIVE_PORT || 4700}`;
const template = join(import.meta.dir, "..", "benchmarks", "autonomy-release-planner", "template");
const workspace = mkdtempSync(join(tmpdir(), "hive-autonomy-release-planner-"));
cpSync(template, workspace, { recursive: true });

function git(...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd: workspace });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString() || `git ${args.join(" ")} failed`);
}

async function request(path: string, method = "GET", body?: unknown): Promise<any> {
  const response = await fetch(base + path, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data: any = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${data.error || response.statusText}`);
  return data;
}

git("init", "-b", "main");
git("config", "user.name", "Hive Benchmark");
git("config", "user.email", "hive-benchmark@localhost");
git("add", ".");
git("commit", "-m", "baseline autonomy benchmark");

await request("/api/health");
const project = await request("/api/projects", "POST", {
  name: `autonomy-release-planner-${workspace.split("-").at(-1)}`,
  repo_path: workspace,
  config: {
    default_branch: "main",
    auto_dispatch: true,
    max_agents: 3,
    autonomy_profile: "autopilot",
  },
});
await request("/api/authority/rules", "POST", {
  project_id: project.id,
  action_pattern: "task.merge",
  effect: "allow",
  note: "Allow reviewed local fast-forward merges in this disposable autonomy benchmark",
});
const ask = [
  "Complete the release planner autonomy benchmark in this project.",
  "Implement every requirement in README.md and do not edit acceptance.ts.",
  "Before implementation, convene a bounded meeting with two scout workers to compare at least two valid planning-algorithm approaches. Record proposal and critique stages, then one decided memo with the recommendation, rationale, material dissent, evidence, and risk; this memo is part of the definition of done.",
  "Own the result through integration and independent verification with `bun run check`.",
  "After reviewing an implementation task, integrate it through Hive's guarded local_ff merge endpoint, then have a separate worker verify the integrated main checkout.",
  "Split independent implementation or review work when useful, resolve technical choices without asking me, and record the commitments and final decision memo in the supervisor ledger.",
].join(" ");
const turn = await request("/api/chat/turn", "POST", { project_id: project.id, text: ask });
const acceptance = readFileSync(join(workspace, "acceptance.ts"));
const metadata = {
  project_id: project.id,
  thread_id: turn.thread_id,
  workspace,
  started_at: new Date().toISOString(),
  acceptance_sha256: createHash("sha256").update(acceptance).digest("hex"),
};
writeFileSync(join(workspace, ".hive-benchmark.json"), JSON.stringify(metadata, null, 2) + "\n");

console.log(JSON.stringify({ ...metadata, delivery: turn.delivery }, null, 2));
console.log(`\nScore later with: bun run benchmark:score ${workspace}`);
