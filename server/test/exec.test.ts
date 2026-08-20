import { test, expect } from "bun:test";
import { defaultExec } from "../src/exec.ts";

test("defaultExec returns real output and code for a normal command", async () => {
  const r = await defaultExec(["echo", "hi"]);
  expect(r.code).toBe(0);
  expect(r.stdout.trim()).toBe("hi");
});

// A stalled subprocess (network hang, or a detached grandchild still holding
// the stdio pipes open after the direct child exits) used to hang the caller
// forever — observed live wedging POST /merge (task #621). This asserts the
// bound actually fires instead of waiting out the full subprocess runtime.
test("defaultExec bounds a hung subprocess with a timeout (task #621)", async () => {
  const start = Date.now();
  const r = await defaultExec(["sleep", "5"], { timeoutMs: 100 });
  expect(Date.now() - start).toBeLessThan(2000);
  expect(r.code).toBe(124);
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
