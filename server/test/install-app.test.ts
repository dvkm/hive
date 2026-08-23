import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Executes the real electron/install-app.sh with the destination and lsregister
// binary redirected into a sandbox, so the install contract (wipe stale bundle,
// copy fresh one, register canonical, unregister worktree copy) is exercised
// end to end without touching /Applications or the LaunchServices database.
const SCRIPT = join(import.meta.dir, "../../electron/install-app.sh");

function sandbox(lsExit: number) {
  const root = mkdtempSync(join(tmpdir(), "hive-install-"));
  const src = join(root, "electron/dist/mac-arm64/hive.app/Contents");
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "Info.plist"), "<plist>fresh</plist>");

  const dest = join(root, "Applications/hive.app");
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, "STALE"), "stale");

  const log = join(root, "lsregister.log");
  const ls = join(root, "lsregister");
  writeFileSync(ls, `#!/bin/bash\necho "$@" >> ${JSON.stringify(log)}\nexit ${lsExit}\n`);
  chmodSync(ls, 0o755);

  const script = join(root, "electron/install-app.sh");
  copyFileSync(SCRIPT, script);
  chmodSync(script, 0o755);

  return { root, script, dest, log, appSrc: join(root, "electron/dist/mac-arm64/hive.app") };
}

const run = (script: string, env: Record<string, string>) =>
  Bun.spawnSync([script], { env: { ...process.env, ...env } });

test.skipIf(process.platform !== "darwin")("install-app replaces the canonical bundle and fixes registrations", () => {
  const s = sandbox(0);
  const proc = run(s.script, { HIVE_APP_DEST: s.dest, LSREGISTER: join(s.root, "lsregister") });

  expect(proc.exitCode).toBe(0);
  expect(readFileSync(join(s.dest, "Contents/Info.plist"), "utf8")).toBe("<plist>fresh</plist>");
  expect(existsSync(join(s.dest, "STALE"))).toBe(false);
  expect(readFileSync(s.log, "utf8").trim().split("\n")).toEqual([`-f ${s.dest}`, `-u ${s.appSrc}`]);
});

test.skipIf(process.platform !== "darwin")("install-app survives a failing lsregister", () => {
  const s = sandbox(1);
  const proc = run(s.script, { HIVE_APP_DEST: s.dest, LSREGISTER: join(s.root, "lsregister") });

  expect(proc.exitCode).toBe(0);
  expect(readFileSync(join(s.dest, "Contents/Info.plist"), "utf8")).toBe("<plist>fresh</plist>");
});

test.skipIf(process.platform !== "darwin")("install-app keeps the installed bundle when nothing has been built", () => {
  const s = sandbox(0);
  rmSync(s.appSrc, { recursive: true });

  const proc = run(s.script, { HIVE_APP_DEST: s.dest, LSREGISTER: join(s.root, "lsregister") });

  expect(proc.exitCode).not.toBe(0);
  expect(existsSync(join(s.dest, "STALE"))).toBe(true);
  expect(existsSync(s.log)).toBe(false);
});

test.skipIf(process.platform !== "darwin")("install-app keeps the installed bundle when the copy fails", () => {
  const s = sandbox(0);
  const unreadable = join(s.appSrc, "Contents/Resources");
  mkdirSync(unreadable, { recursive: true });
  writeFileSync(join(unreadable, "app.asar"), "payload");
  chmodSync(unreadable, 0o000);

  const proc = run(s.script, { HIVE_APP_DEST: s.dest, LSREGISTER: join(s.root, "lsregister") });
  chmodSync(unreadable, 0o755);

  expect(proc.exitCode).not.toBe(0);
  expect(readFileSync(join(s.dest, "STALE"), "utf8")).toBe("stale");
  expect(existsSync(s.log)).toBe(false);
  expect(existsSync(`${s.dest}.new`)).toBe(false);
});
