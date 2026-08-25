import { describe, expect, test } from "bun:test";
import { classifyPr, DEFAULT_SENSITIVE_PATHS, matchesSensitivePath, type ClassifierInput } from "./prGardener.ts";
import { validateProjectConfig } from "./projectConfig.ts";

const ready: ClassifierInput = {
  draft: false,
  mergeState: "CLEAN",
  ci: "passing",
  stale: false,
  superseded: false,
  sensitive: false,
  linkedTaskState: "in_review",
};

describe("PR Gardener classifier", () => {
  test("lands only a green, clean, linked PR", () => {
    expect(classifyPr(ready).action).toBe("land");
    expect(classifyPr({ ...ready, linkedTaskState: null }).action).toBe("decision");
  });

  test("never lands while the director is still deciding", () => {
    expect(classifyPr({ ...ready, directorDeciding: true }).action).toBe("wait");
    expect(classifyPr({ ...ready, directorDeciding: true, mergeState: "DIRTY" }).action).toBe("wait");
    // The director's own explicit choice still wins over the wait.
    expect(classifyPr({ ...ready, directorDeciding: true, override: "force_land" }).action).toBe("land");
    expect(classifyPr({ ...ready, directorDeciding: true, override: "force_close" }).action).toBe("close");
  });

  test("sensitive paths always need a decision", () => {
    expect(classifyPr({ ...ready, sensitive: true }).action).toBe("decision");
  });

  test("stale alone is never enough to close", () => {
    expect(classifyPr({ ...ready, ci: "pending", stale: true }).action).toBe("decision");
  });

  test("closes a proven superseded PR only when enabled", () => {
    const superseded = { ...ready, ci: "pending" as const, superseded: true };
    expect(classifyPr(superseded).action).toBe("decision");
    expect(classifyPr({ ...superseded, autoCloseSuperseded: true }).action).toBe("close");
  });

  test("does not dispatch duplicate or unbounded repair work", () => {
    expect(classifyPr({ ...ready, mergeState: "DIRTY", actionInFlight: true }).action).toBe("wait");
    expect(classifyPr({ ...ready, ci: "failing", fixAttempts: 2, maxFixAttempts: 2 }).action).toBe("decision");
  });

  test("does not repeat work while a repair or decision is active", () => {
    expect(classifyPr({ ...ready, override: "force_close", actionInFlight: true }).action).toBe("wait");
    expect(classifyPr({ ...ready, decisionOpen: true }).action).toBe("wait");
  });
});

describe("PR Gardener sensitive path denylist", () => {
  test("matches exact files and nested globs", () => {
    const paths = ["src/auth/tokens.ts", "deploy/prod/service.yaml", "README.md"];
    expect(matchesSensitivePath(paths, ["src/auth/**"])).toBe(true);
    expect(matchesSensitivePath(paths, ["deploy/prod/**"])).toBe(true);
    expect(matchesSensitivePath(paths, ["newsletter/SEND_LIVE"])).toBe(false);
  });

  test("protects workflows, env files, and secrets by default", () => {
    expect(matchesSensitivePath([".github/workflows/ci.yml"], DEFAULT_SENSITIVE_PATHS)).toBe(true);
    expect(matchesSensitivePath([".env", "config/prod.env"], DEFAULT_SENSITIVE_PATHS)).toBe(true);
    expect(matchesSensitivePath(["secrets/token", "config/secrets/token"], DEFAULT_SENSITIVE_PATHS)).toBe(true);
  });
});

test("PR Gardener config validates its guarded settings", () => {
  expect(validateProjectConfig({ pr_gardener: { enabled: true, cadence: "30m", sensitive_paths: ["src/auth/**"], max_gardener_agents: 1 } })).toBeNull();
  expect(validateProjectConfig({ pr_gardener: { max_gardener_agents: 0 } })).toContain("positive integer");
  expect(validateProjectConfig({ pr_gardener: { max_actions_per_sweep: 0 } })).toContain("positive integer");
  expect(validateProjectConfig({ pr_gardener: { surprise: true } })).toContain("not a known PR gardener key");
});
