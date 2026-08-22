import { expect, test } from "bun:test";
import { create } from "react-test-renderer";
import { MemoryRouter } from "react-router-dom";
import type { Decision } from "../src/lib/api";
import { DecisionCard } from "../src/views/DecisionCard";

(globalThis as unknown as { window: typeof globalThis }).window = globalThis;
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: { getItem: () => null, setItem: () => {} },
});

const card = (ci: any): Decision => ({
  id: "dec-1",
  task_id: "task-1",
  ts: new Date().toISOString(),
  title: "Merge PR #811 with two checks red?",
  context: "Both red checks failed in seconds with no runner.",
  risk: null,
  blast_radius: null,
  options: [{ key: "merge", label: "Merge anyway", recommended: true }],
  status: "open",
  answer_key: null,
  answer_note: null,
  draft_note: null,
  answered_at: null,
  answered_by: null,
  answered_actor: null,
  bundle: {
    task_number: 811,
    pr_url: null,
    branch: null,
    spend_usd: 0,
    prior_decisions: [],
    ci,
  },
} as any);

// Flatten the rendered tree to the strings a reader actually sees — JSX splits
// one sentence across several text children.
function flatten(node: any): string {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(flatten).join("");
  return flatten(node.children);
}
const text = (d: Decision): string =>
  flatten(create(<MemoryRouter><DecisionCard d={d} onDone={() => {}} /></MemoryRouter>).toJSON());

test("a card citing CI says how fresh its facts are, and names the shared outage fix", () => {
  const t = text(card({
    at_card: "unavailable",
    status: "unavailable",
    checked_at: new Date(Date.now() - 120_000).toISOString(),
    changed: false,
    outage: { signal: "parity,syntax:no-steps", fix_task_number: 1261 },
  }));
  expect(t).toContain("Checks still unavailable");
  expect(t).toContain("2m ago");
  expect(t).toContain("Hive is already fixing it in #1261");
});

test("a card whose checks moved on says so instead of showing the old result", () => {
  const t = text(card({ at_card: "failing", status: "passing", checked_at: new Date().toISOString(), changed: true, outage: null }));
  expect(t).toContain("Checks changed since this card: failing → passing");
});
