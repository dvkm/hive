import { test, expect } from "bun:test";
import { riskDisplay } from "../../web/src/lib/decision.ts";

test("null/empty risk renders as em-dash, never 'unknown'", () => {
  expect(riskDisplay(null).label).toBe("—");
  expect(riskDisplay("").label).toBe("—");
  expect(riskDisplay("   ").label).toBe("—");
  expect(riskDisplay(undefined).label).toBe("—");
});

test("a present risk keeps its label and gets a risk-<level> class", () => {
  expect(riskDisplay("high")).toEqual({ className: "risk-high", label: "high" });
  expect(riskDisplay("Medium").className).toBe("risk-medium");
  expect(riskDisplay(null).className).toBe("risk-none");
});
