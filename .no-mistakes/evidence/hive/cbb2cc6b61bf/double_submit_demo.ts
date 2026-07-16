// End-to-end demo of the brand-new-chat double-submit fix (hive-318).
// Boots the real HTTP handler, fires two concurrent POST /api/chat/turn with
// the SAME project_id and text and NO thread_id (a UI double-submit before the
// client has a thread_id back), then prints the raw API responses and the
// persisted DB state. herdr's exec is stubbed so no real agent spawns; a 15ms
// delay on `worktree create` reproduces the original race window.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "hive-demo-"));
process.env.HIVE_HOME = HOME;

const { openDb } = await import("../../../../server/src/db.ts");
const { makeHandler } = await import("../../../../server/src/api.ts");
const { Herdr } = await import("../../../../server/src/runtime/herdr.ts");
import type { Exec, ExecResult } from "../../../../server/src/exec.ts";

const OK = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const WT = join(HOME, "wt");
const has = (argv: string[], ...xs: string[]) => xs.every((x) => argv.includes(x));

let spawns = 0;
const exec: Exec = async (argv) => {
  if (has(argv, "worktree", "create")) {
    await new Promise((r) => setTimeout(r, 15)); // the race window
    return OK(`{"result":{"worktree":{"path":${JSON.stringify(WT)},"branch":"hive/x","open_workspace_id":"w1"}}}`);
  }
  if (has(argv, "agent", "get")) return OK('{"result":{"agent":{"pane_id":"p1","agent_status":"working"}}}');
  if (has(argv, "workspace", "list")) return OK('{"result":{"workspaces":[{"workspace_id":"wF","label":"hive-fleet"}]}}');
  if (has(argv, "tab", "create")) return OK('{"result":{"tab":{"tab_id":"wF:t2"}}}');
  if (has(argv, "agent", "start")) { spawns++; return OK(); }
  return OK();
};

const db = openDb(":memory:");
const server = Bun.serve({ port: 0, fetch: makeHandler(db, { herdr: new Herdr(exec, "herdr") }) });
const BASE = `http://127.0.0.1:${server.port}`;

const post = async (path: string, body: unknown) => {
  const res = await fetch(BASE + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
};
const get = async (path: string) => (await fetch(BASE + path)).json();

const project = await post("/api/projects", { name: "acme", repo_path: WT });
const projectId = (project.json as any).id;

console.log("Firing 2 concurrent POST /api/chat/turn { project_id, text } with NO thread_id...\n");
const [a, b] = await Promise.all([
  post("/api/chat/turn", { project_id: projectId, text: "ship the login work" }),
  post("/api/chat/turn", { project_id: projectId, text: "ship the login work" }),
]);

console.log("request A response:", JSON.stringify(a));
console.log("request B response:", JSON.stringify(b));

const threads = (await get("/api/chat/threads")) as any;
const threadList = Array.isArray(threads) ? threads : threads.threads;
console.log("\nthreads in DB:", Array.isArray(threadList) ? threadList.length : threadList);
const thread = await get(`/api/chat/threads/${(a.json as any).thread_id}`) as any;

console.log("\n=== RESULT ===");
console.log("same thread_id for both requests :", (a.json as any).thread_id === (b.json as any).thread_id, `(${(a.json as any).thread_id})`);
console.log("agent spawns (agent start calls) :", spawns);
console.log("persisted director messages      :", thread.messages.length);
console.log("\nExpected after fix: same=true, spawns=1, messages=1");

server.stop(true);
