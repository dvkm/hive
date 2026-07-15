import { test, expect } from "bun:test";
import { classifyEscalation, factorsFromPlan } from "../src/policy.ts";

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
