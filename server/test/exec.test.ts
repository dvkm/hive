import { test, expect } from "bun:test";
import { defaultExec } from "../src/exec.ts";

const echoArgv = () => process.platform === "win32"
  ? ["cmd.exe", "/d", "/c", "echo", "hi"]
  : ["echo", "hi"];

test("defaultExec returns real output and code for a normal command", async () => {
  const r = await defaultExec(echoArgv());
  expect(r.code).toBe(0);
  expect(r.stdout.trim()).toBe("hi");
});

// task #1096: `gh` resolved via a healthy inherited PATH everywhere except
// inside the actual running server (bun --watch), throwing ENOENT on every
// reconciler cycle. defaultExec no longer trusts inheritance for PATH — it
// builds one explicitly — so a bare binary name must still resolve even when
// the calling process's own PATH is stripped down to nothing.
test("defaultExec resolves a PATH-only binary name even with a stripped-down inherited PATH (task #1096)", async () => {
  const original = process.env.PATH;
  try {
    process.env.PATH = "";
    const r = await defaultExec(echoArgv());
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("hi");
  } finally {
    process.env.PATH = original;
  }
});

// A stalled subprocess (network hang, or a detached grandchild still holding
// the stdio pipes open after the direct child exits) used to hang the caller
// forever — observed live wedging POST /merge (task #621). This asserts the
// bound actually fires instead of waiting out the full subprocess runtime.
test("defaultExec bounds a hung subprocess with a timeout (task #621)", async () => {
  const start = Date.now();
  const command = process.platform === "win32"
    ? ["ping.exe", "-n", "6", "127.0.0.1"]
    : ["sleep", "5"];
  const r = await defaultExec(command, { timeoutMs: 100 });
  expect(Date.now() - start).toBeLessThan(2000);
  expect(r.code).toBe(124);
});

test("defaultExec reports a missing optional executable instead of throwing", async () => {
  const r = await defaultExec([`hive-command-that-does-not-exist-${Date.now()}`]);
  expect(r.code).toBe(127);
  expect(r.stderr.length).toBeGreaterThan(0);
});

test("Windows executable PATH keeps drive-letter entries intact and uses semicolons", async () => {
  const { buildExecutablePath } = await import("../src/platform.ts");
  const path = buildExecutablePath("C:\\Tools;D:\\More", "win32", {
    USERPROFILE: "C:\\Users\\Ada",
    LOCALAPPDATA: "C:\\Users\\Ada\\AppData\\Local",
    SystemRoot: "C:\\Windows",
    ProgramFiles: "C:\\Program Files",
    "ProgramFiles(x86)": "C:\\Program Files (x86)",
  });
  expect(path.split(";").slice(0, 2)).toEqual(["C:\\Tools", "D:\\More"]);
  expect(path).toContain("C:\\Users\\Ada\\.bun\\bin");
  expect(path).toContain("C:\\Users\\Ada\\AppData\\Local\\Programs\\Herdr\\bin");
});

// Config-sourced branch names become positional git arguments; git parses a
// leading `-` as an option, not a ref (task #1024).
test("isSafeRef rejects option-shaped and malformed refs, accepts real branch names", async () => {
  const { isSafeRef, safeBranch } = await import("../src/exec.ts");
  for (const bad of [
    "--upload-pack=/tmp/pwn.sh",
    "--output=/tmp/x",
    "--exec=whoami",
    "-q",
    "main..evil", // would smuggle a range into `${base}...${branch}`
    "main branch",
    "main;whoami",
    "$(whoami)",
    "../../etc/passwd",
    ".hidden",
    "/abs",
    "",
    null,
    undefined,
    42,
  ]) {
    expect(isSafeRef(bad)).toBe(false);
    expect(safeBranch(bad)).toBe("main");
  }
  for (const good of ["main", "staging", "trunk", "release/2.1", "feature_x.y", "hive/df796fcb262a", "v2-rc1"]) {
    expect(isSafeRef(good)).toBe(true);
    expect(safeBranch(good)).toBe(good);
  }
});

// GitHub-sourced refs (a PR's live baseRefName) hit the same argv risk as
// config-sourced ones (task #1086, same bug class as #1024).
test("preferSafeRef uses the candidate only when safe, else the given fallback", async () => {
  const { preferSafeRef } = await import("../src/exec.ts");
  expect(preferSafeRef("staging", "main")).toBe("staging");
  expect(preferSafeRef("--upload-pack=/tmp/evil", "main")).toBe("main");
  expect(preferSafeRef(undefined, "main")).toBe("main");
});

test("projectBaseBranch inherits the promotion source before falling back to main", async () => {
  const { projectBaseBranch, projectComparisonBase } = await import("../src/exec.ts");
  expect(projectBaseBranch({ default_branch: "release", promote: { from: "staging" } })).toBe("release");
  expect(projectBaseBranch({ promote: { from: "staging", to: "main" } })).toBe("staging");
  expect(projectBaseBranch({})).toBe("main");
  expect(projectComparisonBase({ promote: { from: "staging", to: "main" } })).toBe("origin/staging");
});

// safeBranch/preferSafeRef used to fall back silently everywhere except
// promoter.ts, so a malformed default_branch quietly diffed against the wrong
// branch with no operator signal (task #1086).
test("safeBranch and preferSafeRef warn when rejecting a present-but-unsafe value", async () => {
  const { safeBranch, preferSafeRef } = await import("../src/exec.ts");
  const calls: unknown[][] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => calls.push(args);
  try {
    safeBranch("--output=/tmp/x");
    preferSafeRef("--output=/tmp/y", "main");
    safeBranch(undefined); // missing, not malformed — no warning
  } finally {
    console.error = orig;
  }
  expect(calls.length).toBe(2);
  expect(calls[0].join(" ")).toContain("--output=/tmp/x");
  expect(calls[1].join(" ")).toContain("--output=/tmp/y");
});
