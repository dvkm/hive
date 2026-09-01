import { test, expect, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "hive-usage-test-"));
process.env.HIVE_HOME = HOME;

const { openDb, newId, now } = await import("../src/db.ts");
const { makeHandler } = await import("../src/api.ts");
const { costUsd, priceFor } = await import("../src/pricing.ts");

const db = openDb(":memory:");
const handler = makeHandler(db);

async function post(path: string, body: unknown) {
  const res = await handler(new Request("http://127.0.0.1" + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
  return { status: res.status, json: await res.json() };
}
async function get(path: string) {
  const res = await handler(new Request("http://127.0.0.1" + path));
  return { status: res.status, json: await res.json() };
}

let projectId = "";
let taskId = "";
beforeAll(async () => {
  const p = await post("/api/projects", {
    name: "usage-proj",
    repo_path: "/tmp/x",
    // per-project pricing override for an otherwise-unknown model family
    config: { pricing: { mymodel: { input: 1, output: 2, cache_read: 0 } } },
  });
  projectId = p.json.id;
  const t = await post("/api/tasks", { project_id: projectId, title: "usage task" });
  taskId = t.json.id;
});

test("pricing: cost math + unknown-model null path", () => {
  // 1M input + 1M output, sonnet: $3 + $15 = $18
  expect(costUsd("claude-sonnet-4-5", { input_tokens: 1e6, output_tokens: 1e6, cache_read_tokens: 0 })).toBeCloseTo(18, 6);
  // opus cache-read is 0.1x input: 1M * $0.50/MTok
  expect(costUsd("claude-opus-4-8", { input_tokens: 0, output_tokens: 0, cache_read_tokens: 1e6 })).toBeCloseTo(0.5, 6);
  // unknown model -> null (unpriced), never throws
  expect(priceFor("gpt-4o")).toBeNull();
  expect(costUsd("gpt-4o", { input_tokens: 1e6, output_tokens: 1e6, cache_read_tokens: 0 })).toBeNull();
});

test("pricing: cache tokens are not priced as fresh input", () => {
  const M = 1e6;
  const fresh = { input_tokens: M, output_tokens: 0, cache_read_tokens: 0 };
  // cache read costs 0.1x fresh input; cache write costs 1.25x.
  expect(costUsd("claude-opus-4-8", fresh)).toBeCloseTo(5, 6);
  expect(costUsd("claude-opus-4-8", { ...fresh, input_tokens: 0, cache_read_tokens: M })).toBeCloseTo(0.5, 6);
  expect(costUsd("claude-opus-4-8", { ...fresh, input_tokens: 0, cache_write_tokens: M })).toBeCloseTo(6.25, 6);
  // an override that omits cache_write still gets the 1.25x default
  const o = { mymodel: { input: 4, output: 8, cache_read: 0.4 } };
  expect(costUsd("mymodel", { ...fresh, input_tokens: 0, cache_write_tokens: M }, o)).toBeCloseTo(5, 6);
});

test("usage ingestion (JSON): cost computed server-side", async () => {
  const r = await post(`/api/tasks/${taskId}/events`, {
    type: "usage",
    model: "claude-sonnet-4-5",
    input_tokens: 1_000_000,
    output_tokens: 1_000_000,
    cache_read_tokens: 0,
  });
  expect(r.status).toBe(201);
  expect(r.json.usage.cost_usd).toBeCloseTo(18, 6);
  expect(r.json.usage.source).toBe("agent");
});

test("usage ingestion (multipart): string fields coerced", async () => {
  const form = new FormData();
  form.set("type", "usage");
  form.set("source", "hook");
  form.set("model", "claude-3-5-haiku");
  form.set("input_tokens", "1000000");
  form.set("output_tokens", "0");
  form.set("cache_read_tokens", "0");
  const res = await handler(new Request(`http://127.0.0.1/api/tasks/${taskId}/events`, { method: "POST", body: form }));
  expect(res.status).toBe(201);
  const j = await res.json();
  expect(j.usage.input_tokens).toBe(1_000_000);
  expect(j.usage.cost_usd).toBeCloseTo(1, 6); // haiku input $1.00/MTok
  expect(j.usage.source).toBe("hook");
});

test("usage ingestion: cache_write_tokens round-trip + priced at 1.25x", async () => {
  const r = await post(`/api/tasks/${taskId}/events`, {
    type: "usage",
    model: "claude-opus-4-8",
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 1_000_000,
    cache_write_tokens: 1_000_000,
  });
  expect(r.status).toBe(201);
  expect(r.json.usage.cache_write_tokens).toBe(1_000_000);
  expect(r.json.usage.cost_usd).toBeCloseTo(0.5 + 6.25, 6);
});

test("usage ingestion: unknown model stores cost null (unpriced)", async () => {
  const r = await post(`/api/tasks/${taskId}/events`, {
    type: "usage",
    model: "some-other-llm",
    input_tokens: 500,
    output_tokens: 500,
  });
  expect(r.status).toBe(201);
  expect(r.json.usage.cost_usd).toBeNull();
});

test("usage ingestion: project config.pricing override applies", async () => {
  const r = await post(`/api/tasks/${taskId}/events`, {
    type: "usage",
    model: "mymodel-v9",
    input_tokens: 1_000_000,
    output_tokens: 0,
  });
  expect(r.status).toBe(201);
  expect(r.json.usage.cost_usd).toBeCloseTo(1, 6); // override input $1/MTok
});

test("caller-supplied cost_usd is stored verbatim", async () => {
  const r = await post(`/api/tasks/${taskId}/events`, {
    type: "usage",
    model: "claude-opus-4-1",
    input_tokens: 10,
    output_tokens: 10,
    cost_usd: 0.4242,
  });
  expect(r.json.usage.cost_usd).toBeCloseTo(0.4242, 6);
});

test("task usage endpoint returns rows + totals", async () => {
  const { status, json } = await get(`/api/tasks/${taskId}/usage`);
  expect(status).toBe(200);
  expect(json.task_id).toBe(taskId);
  expect(json.usage.length).toBeGreaterThanOrEqual(5);
  expect(json.totals.calls).toBe(json.usage.length);
  const processed = json.usage.reduce(
    (sum: number, row: any) =>
      sum + row.input_tokens + row.output_tokens + row.cache_read_tokens + row.cache_write_tokens,
    0
  );
  expect(json.totals.total_tokens).toBe(processed);
  // totals.cost_usd only sums priced rows; unpriced row contributes null->0
  expect(json.totals.cost_usd).toBeGreaterThan(0);
  expect(json.totals.unpriced).toBeGreaterThanOrEqual(1);
});

test("summary rollups + since window (injected timestamps)", async () => {
  // Fresh project so the rollups are isolated from the shared task above.
  const p = await post("/api/projects", { name: "window-proj", repo_path: "/tmp/y" });
  const pid = p.json.id;
  const t = await post("/api/tasks", { project_id: pid, title: "window task" });
  const tid = t.json.id;

  // Insert two rows directly with controlled ts: one old, one recent.
  const old = new Date(Date.now() - 10 * 24 * 3600_000).toISOString(); // 10d ago
  const recent = now();
  const insert = (ts: string, cost: number) =>
    db
      .query(
        `INSERT INTO usage (id, task_id, ts, model, input_tokens, output_tokens, cache_read_tokens, cost_usd, source)
         VALUES (?,?,?,?,?,?,?,?,?)`
      )
      .run(newId("use"), tid, ts, "claude-sonnet-4-5", 1000, 1000, 0, cost, "agent");
  insert(old, 5);
  insert(recent, 7);

  // All-time: both rows.
  const all = await get(`/api/analytics/summary`);
  const allProj = all.json.by_project.find((r: any) => r.project_id === pid);
  expect(allProj.cost_usd).toBeCloseTo(12, 6);
  expect(allProj.calls).toBe(2);

  // 7d window: only the recent row.
  const since = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
  const win = await get(`/api/analytics/summary?since=${encodeURIComponent(since)}`);
  const winProj = win.json.by_project.find((r: any) => r.project_id === pid);
  expect(winProj.cost_usd).toBeCloseTo(7, 6);
  expect(winProj.calls).toBe(1);

  // by_model + top_tasks reflect the same window.
  expect(win.json.by_model.some((r: any) => r.model === "claude-sonnet-4-5")).toBe(true);
  const top = win.json.top_tasks.find((r: any) => r.task_id === tid);
  expect(top.cost_usd).toBeCloseTo(7, 6);
});

test("SSE broadcasts a usage message on ingest", async () => {
  const res = await handler(new Request("http://127.0.0.1/api/stream"));
  const reader = res.body!.getReader();
  await reader.read(); // hello headline
  const p = post(`/api/tasks/${taskId}/events`, {
    type: "usage",
    model: "claude-sonnet-4-5",
    input_tokens: 1,
    output_tokens: 1,
  });
  const { value } = await reader.read();
  await p;
  const text = new TextDecoder().decode(value);
  expect(text).toContain('"type":"usage"');
  await reader.cancel();
});
