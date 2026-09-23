import { expect, test } from "bun:test";
import type { Evidence } from "../src/lib/api";
import { orderEvidence } from "../src/views/ReviewCard";

const shot = (id: string, caption: string, ts: string): Evidence => ({
  id,
  task_id: "task-1",
  ts,
  kind: "screenshot",
  path: null,
  url: `/evidence/${id}.png`,
  caption,
  meta: {},
});

// The pair from the director's screenshot: same second, same commit, and the
// AFTER row emitted first.
const after = shot("after", "AFTER: card refreshed to the article as it reads now", "2026-01-01T00:00:00.000Z");
const before = shot("before", "BEFORE: card mails the draft-time headline", "2026-01-01T00:00:00.000Z");

test("a before/after pair reads before-then-after however it was emitted", () => {
  const later = shot("later", "Unrelated shot", "2026-01-01T00:05:00.000Z");
  const earlier = shot("earlier", "Unrelated earlier shot", "2025-12-31T00:00:00.000Z");
  expect(orderEvidence([after, before, later, earlier]).map((e) => e.id)).toEqual([
    "earlier",
    "before",
    "after",
    "later",
  ]);
});

test("two before/after pairs on one task stay two pairs", () => {
  const b1 = shot("b1", "BEFORE: first pair", "2026-01-01T00:00:00.000Z");
  const a1 = shot("a1", "AFTER: first pair", "2026-01-01T00:01:00.000Z");
  const b2 = shot("b2", "BEFORE: second pair", "2026-01-01T00:10:00.000Z");
  const a2 = shot("a2", "AFTER: second pair", "2026-01-01T00:11:00.000Z");
  expect(orderEvidence([a2, b2, a1, b1]).map((e) => e.id)).toEqual(["b1", "a1", "b2", "a2"]);
});

test("an AFTER captured before its BEFORE still reads second", () => {
  const earlyAfter = { ...after, ts: "2025-12-31T00:00:00.000Z" };
  expect(orderEvidence([before, earlyAfter]).map((e) => e.id)).toEqual(["before", "after"]);
});
