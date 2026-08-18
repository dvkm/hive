import { readFileSync } from "node:fs";
import { planRelease } from "./planner.ts";
import { formatPlan } from "./format.ts";
import type { ReleaseItem } from "./types.ts";

const args = process.argv.slice(2);
const path = args.find((arg) => !arg.startsWith("--"));
if (!path) {
  console.error("usage: bun run src/cli.ts <release.json> [--text]");
  process.exit(2);
}

const input = JSON.parse(readFileSync(path, "utf8")) as { items: ReleaseItem[]; completed?: string[] };
const plan = planRelease(input.items, input.completed ?? []);
console.log(args.includes("--text") ? formatPlan(plan) : JSON.stringify(plan, null, 2));
