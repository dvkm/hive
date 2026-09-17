import { test, expect } from "bun:test";
import { classifyEscalation, factorsFromPlan, classifyCardText, classifyCardTextSync } from "../src/policy.ts";

const BASE = { reversible: true, blastRadius: "local" as const, ambiguous: false, preferenceKnown: true };

test("irreversible always escalates high, regardless of other factors", () => {
  const v = classifyEscalation({ ...BASE, reversible: false });
  expect(v.effect).toBe("escalate");
  expect(v.risk).toBe("high");
});

test("prod blast radius always escalates high", () => {
  const v = classifyEscalation({ ...BASE, blastRadius: "prod" });
  expect(v.effect).toBe("escalate");
  expect(v.risk).toBe("high");
});

test("ambiguous escalates normal when reversible and not prod", () => {
  const v = classifyEscalation({ ...BASE, ambiguous: true });
  expect(v.effect).toBe("escalate");
  expect(v.risk).toBe("normal");
});

test("unknown preference on a non-local change escalates normal", () => {
  const v = classifyEscalation({ ...BASE, blastRadius: "shared", preferenceKnown: false });
  expect(v.effect).toBe("escalate");
  expect(v.risk).toBe("normal");
});

test("unknown preference on a purely local change still auto-handles", () => {
  const v = classifyEscalation({ ...BASE, blastRadius: "local", preferenceKnown: false });
  expect(v.effect).toBe("auto_handle");
  expect(v.risk).toBe("low");
});

test("reversible, scoped, unambiguous, known preference auto-handles", () => {
  const v = classifyEscalation(BASE);
  expect(v.effect).toBe("auto_handle");
  expect(v.risk).toBe("low");
});

test("factorsFromPlan flags prod/deploy keywords as prod blast radius", () => {
  const f = factorsFromPlan(
    { proposed_tasks: [{ title: "Roll out to prod", brief: "deploy the release" }], questions: [] },
    true
  );
  expect(f.blastRadius).toBe("prod");
});

test("factorsFromPlan flags migration/schema keywords as shared blast radius", () => {
  const f = factorsFromPlan(
    { proposed_tasks: [{ title: "Add a migration", brief: "adjust the schema" }], questions: [] },
    true
  );
  expect(f.blastRadius).toBe("shared");
});

test("factorsFromPlan treats open questions as ambiguous", () => {
  const f = factorsFromPlan(
    { proposed_tasks: [{ title: "Add a button", brief: "" }], questions: ["which page?"] },
    true
  );
  expect(f.ambiguous).toBe(true);
});

test("factorsFromPlan flags destructive keywords as irreversible", () => {
  const f = factorsFromPlan(
    { proposed_tasks: [{ title: "Clean up", brief: "force-push over the branch" }], questions: [] },
    true
  );
  expect(f.reversible).toBe(false);
});

test("factorsFromPlan carries preferenceKnown through unchanged", () => {
  const f = factorsFromPlan({ proposed_tasks: [{ title: "Add a button", brief: "" }], questions: [] }, false);
  expect(f.preferenceKnown).toBe(false);
});

// ---- classifyCardText: regex baseline + Jev ---------------------------------

const CARD = {
  title: "Rename a local helper",
  context: "tidy-up in one worktree",
  risk: "low",
  blast_radius: "local",
  options: JSON.stringify([{ key: "go", label: "rename it" }]),
};

const ENV = (mode: string) => ({ TYPESAFE_API_KEY: "k", HIVE_TYPESAFE_MODE: mode }) as any;
const jev = (answers: any, status = 200) =>
  (async () =>
    new Response(JSON.stringify({ model: "jev-test", answers, usage: { input_tokens: 1, output_tokens: 1 } }), {
      status,
    })) as any;
const SCORE = (n: number) => ({ type: "score", score: n, legend: {}, probabilities: {}, confidence: 1 });
const CHOICE = (c: string) => ({ type: "choice", choice: c, probabilities: {}, confidence: 1 });
const NOUL = (n: number) => ({ type: "noul", noul: n });
const ALL = (o: { risk?: number; blast?: string; reversible?: number; needs_input?: number } = {}) => ({
  risk: SCORE(o.risk ?? 0),
  blast: CHOICE(o.blast ?? "local"),
  reversible: NOUL(o.reversible ?? 1),
  needs_input: NOUL(o.needs_input ?? 0),
});

test("regex baseline reproduces today's signals", () => {
  expect(classifyCardTextSync(CARD)).toMatchObject({ risk: "low", blast: "local", reversible: true, needs_input: false, source: "regex" });
  // unparseable prose is still forced to high; blast_radius still wins
  expect(classifyCardTextSync({ ...CARD, risk: "if these keys are real anyone can use them", blast_radius: "deploy to prod" })).toMatchObject({
    risk: "high",
    blast: "prod",
  });
  expect(classifyCardTextSync({ title: "Clean up", context: "drop table users" }).reversible).toBe(false);
  expect(classifyCardTextSync({ ...CARD, options: [{ label: "paste the API key here" }] }).needs_input).toBe(true);
});

test("typesafe off (no key) never calls out and returns the regex result", async () => {
  const c = await classifyCardText(CARD, { env: {} as any, fetch: (() => { throw new Error("must not call"); }) as any });
  expect(c.source).toBe("regex");
  expect(c.shadow).toBeUndefined();
});

test("shadow mode returns the regex verdict with Jev attached", async () => {
  const c = await classifyCardText(CARD, { env: ENV("shadow"), fetch: jev(ALL({ risk: 3, blast: "prod" })) });
  expect(c).toMatchObject({ risk: "low", blast: "local", source: "regex" });
  expect(c.shadow).toMatchObject({ risk: "high", blast: "prod", source: "typesafe" });
});

test("enforce: Jev moves blast to prod where the regex said local", async () => {
  const c = await classifyCardText(CARD, { env: ENV("enforce"), fetch: jev(ALL({ blast: "prod" })) });
  expect(c.blast).toBe("prod");
  expect(c.source).toBe("typesafe");
});

test("enforce: needs_input only ORs — Jev cannot clear the regex signal", async () => {
  const card = { ...CARD, options: [{ label: "send me the admin token" }] };
  expect(classifyCardTextSync(card).needs_input).toBe(true);
  const c = await classifyCardText(card, { env: ENV("enforce"), fetch: jev(ALL({ needs_input: 0 })) });
  expect(c.needs_input).toBe(true);
  // and it may add where the regex saw nothing
  const added = await classifyCardText(CARD, { env: ENV("enforce"), fetch: jev(ALL({ needs_input: 0.9 })) });
  expect(added.needs_input).toBe(true);
});

test("enforce: Jev may not talk an EXPLICIT high card down, but may an unparseable one", async () => {
  const explicit = await classifyCardText({ ...CARD, risk: "high" }, { env: ENV("enforce"), fetch: jev(ALL({ risk: 0 })) });
  expect(explicit.risk).toBe("high");
  const prose = await classifyCardText({ ...CARD, risk: "renames one private function" }, { env: ENV("enforce"), fetch: jev(ALL({ risk: 0 })) });
  expect(classifyCardTextSync({ ...CARD, risk: "renames one private function" }).risk).toBe("high");
  expect(prose.risk).toBe("low");
  // raising is always allowed
  const raised = await classifyCardText(CARD, { env: ENV("enforce"), fetch: jev(ALL({ risk: 3 })) });
  expect(raised.risk).toBe("high");
});

test("a null judgment (non-200, or a throw) falls back to the regex result", async () => {
  const bad = await classifyCardText(CARD, { env: ENV("enforce"), fetch: jev(ALL(), 500) });
  expect(bad).toMatchObject({ risk: "low", blast: "local", source: "regex" });
  const threw = await classifyCardText(CARD, {
    env: ENV("enforce"),
    fetch: (async () => { throw new Error("network"); }) as any,
  });
  expect(threw.source).toBe("regex");
});
