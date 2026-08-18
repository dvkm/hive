import { strict as assert } from "node:assert";
import { planRelease } from "./src/planner.ts";
import { formatPlan } from "./src/format.ts";
import type { ReleaseItem } from "./src/types.ts";

const items: ReleaseItem[] = [
  { id: "schema", title: "Finalize schema", priority: 2 },
  { id: "api", title: "Ship API", priority: 5, depends_on: ["schema"] },
  { id: "docs", title: "Publish docs", priority: 4 },
  { id: "deploy", title: "Deploy release", priority: 5, depends_on: ["api", "docs"] },
];

const failures: string[] = [];
async function check(name: string, fn: () => unknown | Promise<unknown>) {
  try {
    await fn();
    console.log(`ok  ${name}`);
  } catch (error: any) {
    failures.push(`${name}: ${error?.message ?? error}`);
    console.error(`not ok  ${name}`);
  }
}

await check("reports ready and directly blocked work", () => {
  const plan = planRelease(items);
  assert.deepEqual(plan.next, ["docs", "schema"]);
  assert.deepEqual(plan.blocked, [
    { id: "api", blocked_by: ["schema"] },
    { id: "deploy", blocked_by: ["api", "docs"] },
  ]);
});

await check("builds a priority-aware topological order", () => {
  assert.deepEqual(planRelease(items).order, ["docs", "schema", "api", "deploy"]);
});

await check("removes completed work from every projection", () => {
  const plan = planRelease(items, ["schema", "docs"]);
  assert.deepEqual(plan.next, ["api"]);
  assert.deepEqual(plan.blocked, [{ id: "deploy", blocked_by: ["api"] }]);
  assert.deepEqual(plan.order, ["api", "deploy"]);
});

await check("rejects invalid graphs", () => {
  assert.throws(() => planRelease([...items, { ...items[0] }]), /duplicate/i);
  assert.throws(() => planRelease([{ id: "a", title: "A", priority: 1, depends_on: ["missing"] }]), /unknown/i);
  assert.throws(() => planRelease([
    { id: "a", title: "A", priority: 1, depends_on: ["b"] },
    { id: "b", title: "B", priority: 1, depends_on: ["a"] },
  ]), /cycle/i);
});

await check("does not mutate caller input", () => {
  const frozen = Object.freeze(structuredClone(items).map((item) => Object.freeze({
    ...item,
    ...(item.depends_on ? { depends_on: Object.freeze([...item.depends_on]) } : {}),
  })));
  planRelease(frozen as ReleaseItem[]);
  assert.deepEqual(frozen, items);
});

await check("formats a concise text report", () => {
  const text = formatPlan(planRelease(items));
  assert.match(text, /Ready now/i);
  assert.match(text, /docs/);
  assert.match(text, /Blocked/i);
  assert.match(text, /api.*schema/i);
  assert.match(text, /Execution order/i);
});

await check("CLI supports JSON and text output", () => {
  const json = Bun.spawnSync(["bun", "run", "src/cli.ts", "fixtures/release.json"]);
  assert.equal(json.exitCode, 0, json.stderr.toString());
  assert.deepEqual(JSON.parse(json.stdout.toString()).order, ["docs", "schema", "api", "deploy"]);
  const text = Bun.spawnSync(["bun", "run", "src/cli.ts", "fixtures/release.json", "--text"]);
  assert.equal(text.exitCode, 0, text.stderr.toString());
  assert.match(text.stdout.toString(), /Ready now/i);
});

if (failures.length) {
  console.error(`\n${failures.length} acceptance check${failures.length === 1 ? "" : "s"} failed:`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("\nAll autonomy benchmark checks passed.");
