import { test, expect } from "bun:test";
import { runDoctor, doctorOk, formatDoctor } from "../src/doctor.ts";

const nothing = { which: () => null, exists: () => false, herdrAlive: () => false, writable: () => false, env: {} as NodeJS.ProcessEnv };

test("a bare machine fails every required check and names the fix", () => {
  const checks = runDoctor(nothing);
  expect(doctorOk(checks)).toBe(false);
  const failed = checks.filter((c) => !c.ok && c.required).map((c) => c.name);
  expect(failed).toEqual(["git", "herdr", "herdr daemon", "agent CLI", "data dir"]);
  for (const c of checks.filter((c) => !c.ok)) expect(c.fix).toBeTruthy();
  expect(formatDoctor(checks)).toContain("FAIL  herdr");
  expect(formatDoctor(checks)).toContain("fix: install Herdr");
});

test("gh is optional: everything else present is ok", () => {
  const bins: Record<string, string> = { git: "/usr/bin/git", herdr: "/opt/herdr", codex: "/usr/local/bin/codex" };
  const checks = runDoctor({
    which: (n) => bins[n] ?? null,
    exists: (p) => Object.values(bins).includes(p),
    herdrAlive: (bin) => bin === "/opt/herdr",
    writable: () => true,
    env: {} as NodeJS.ProcessEnv,
  });
  expect(doctorOk(checks)).toBe(true);
  expect(checks.find((c) => c.name === "gh")).toMatchObject({ ok: false, required: false });
  expect(checks.find((c) => c.name === "agent CLI")?.detail).toBe("codex /usr/local/bin/codex");
  expect(checks.find((c) => c.name === "herdr daemon")?.detail).toBe("running");
});

test("an installed but stopped herdr is a daemon failure, not an install failure", () => {
  const checks = runDoctor({ ...nothing, which: (n) => (n === "herdr" ? "/opt/herdr" : null), exists: (p) => p === "/opt/herdr" });
  expect(checks.find((c) => c.name === "herdr")?.ok).toBe(true);
  expect(checks.find((c) => c.name === "herdr daemon")).toMatchObject({ ok: false, detail: "not responding: agents cannot spawn" });
});
