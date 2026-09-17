import { test, expect, afterEach } from "bun:test";
import { parseUsageEnvelope, defaultPlannerExec, setUsageSink, lastModelUsage, type ModelUsageRow } from "./planner.ts";

const ENVELOPE = {
  type: "result",
  total_cost_usd: 0.0123,
  usage: {
    input_tokens: 11,
    output_tokens: 22,
    cache_read_input_tokens: 33,
    cache_creation_input_tokens: 44,
  },
  modelUsage: { "claude-sonnet-4-5": {} },
};

afterEach(() => setUsageSink(null));

test("parseUsageEnvelope: whole-JSON envelope", () => {
  expect(parseUsageEnvelope(JSON.stringify(ENVELOPE), [])).toEqual({
    model: "claude-sonnet-4-5",
    input_tokens: 11,
    output_tokens: 22,
    cache_read_tokens: 33,
    cache_write_tokens: 44,
    cost_usd: 0.0123,
  });
});

test("parseUsageEnvelope: stream-json last line, model from argv", () => {
  const { modelUsage, ...noModelUsage } = ENVELOPE;
  const stdout = `{"type":"system"}\n{"type":"assistant"}\n${JSON.stringify(noModelUsage)}\n`;
  const row = parseUsageEnvelope(stdout, ["claude", "-p", "--model", "sonnet"]);
  expect(row?.model).toBe("sonnet");
  expect(row?.cache_write_tokens).toBe(44);
});

test("parseUsageEnvelope: no usage block, garbage, empty", () => {
  expect(parseUsageEnvelope(JSON.stringify({ result: "hi" }), [])).toBeNull();
  expect(parseUsageEnvelope("not json at all", [])).toBeNull();
  expect(parseUsageEnvelope("   ", [])).toBeNull();
});

test("parseUsageEnvelope: unpriced envelope keeps cost null and falls back to unknown", () => {
  const row = parseUsageEnvelope(JSON.stringify({ usage: { input_tokens: 1 } }), []);
  expect(row).toEqual({
    model: "unknown",
    input_tokens: 1,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    cost_usd: null,
  });
});

test("defaultPlannerExec feeds the sink with site/taskId", async () => {
  process.env.HIVE_TEAMCLAUDE = "0"; // no proxy probe in a test
  const seen: ModelUsageRow[] = [];
  setUsageSink((r) => seen.push(r));
  const res = await defaultPlannerExec(["/bin/sh", "-c", `printf %s '${JSON.stringify(ENVELOPE)}'`], {
    timeoutMs: 10_000,
    taskId: "tsk_fake",
    site: "unit-test",
  });
  expect(res.code).toBe(0);
  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({ taskId: "tsk_fake", site: "unit-test", model: "claude-sonnet-4-5", cost_usd: 0.0123 });
  expect(lastModelUsage(1)[0]).toMatchObject({ site: "unit-test", output_tokens: 22 });
});

test("defaultPlannerExec records nothing when the envelope has no usage", async () => {
  process.env.HIVE_TEAMCLAUDE = "0";
  const seen: ModelUsageRow[] = [];
  setUsageSink((r) => seen.push(r));
  await defaultPlannerExec(["/bin/sh", "-c", `printf %s '{"result":"ok"}'`], { timeoutMs: 10_000 });
  expect(seen).toHaveLength(0);
});
