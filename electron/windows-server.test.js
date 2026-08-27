const { expect, test } = require("bun:test");
const { mkdtempSync, mkdirSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { isDefaultLocalBase, launchWindowsServer, readServerLaunchConfig } = require("./windows-server.js");

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "hive-windows-server-"));
  const repo = join(root, "repo");
  const bun = join(root, "bun.exe");
  const config = join(root, "server-launch.json");
  mkdirSync(repo);
  writeFileSync(join(repo, "package.json"), "{}");
  writeFileSync(bun, "");
  writeFileSync(config, JSON.stringify({ bun, cwd: repo }));
  return { root, repo, bun, config };
}

test("only the default loopback Hive URL may start the bundled server", () => {
  expect(isDefaultLocalBase("http://127.0.0.1:4700")).toBe(true);
  expect(isDefaultLocalBase("http://localhost:4700/")).toBe(true);
  expect(isDefaultLocalBase("https://127.0.0.1:4700")).toBe(false);
  expect(isDefaultLocalBase("http://127.0.0.1:9999")).toBe(false);
  expect(isDefaultLocalBase("https://hive.example.com")).toBe(false);
});

test("invalid or stale launch metadata fails closed", () => {
  const f = fixture();
  expect(readServerLaunchConfig(f.config)).toEqual({ bun: f.bun, cwd: f.repo });
  writeFileSync(f.config, JSON.stringify({ bun: join(f.root, "missing.exe"), cwd: f.repo }));
  expect(readServerLaunchConfig(f.config)).toBeNull();
  writeFileSync(f.config, "not-json");
  expect(readServerLaunchConfig(f.config)).toBeNull();
});

test("Windows launches the configured server hidden and detached", () => {
  const f = fixture();
  const calls = [];
  let unref = false;
  const result = launchWindowsServer({
    platform: "win32",
    base: "http://127.0.0.1:4700",
    configPath: f.config,
    localAppData: join(f.root, "local"),
    spawn: (...args) => {
      calls.push(args);
      return { pid: 42, unref: () => (unref = true) };
    },
  });

  expect(result).toEqual({ started: true, pid: 42 });
  expect(unref).toBe(true);
  expect(calls).toHaveLength(1);
  expect(calls[0][0]).toBe(f.bun);
  expect(calls[0][1]).toEqual(["run", "server"]);
  expect(calls[0][2]).toMatchObject({ cwd: f.repo, detached: true, windowsHide: true });

  const duplicate = launchWindowsServer({
    platform: "win32",
    base: "http://127.0.0.1:4700",
    configPath: f.config,
    localAppData: join(f.root, "local"),
    spawn: (...args) => {
      calls.push(args);
      return { unref() {} };
    },
  });
  expect(duplicate).toEqual({ started: false, reason: "launch-in-progress" });
  expect(calls).toHaveLength(1);
});

test("macOS/Linux and remote Hive URLs never spawn a local server", () => {
  let calls = 0;
  const spawn = () => {
    calls += 1;
    return { unref() {} };
  };
  expect(launchWindowsServer({ platform: "darwin", spawn }).reason).toBe("not-windows");
  expect(launchWindowsServer({ platform: "linux", spawn }).reason).toBe("not-windows");
  expect(launchWindowsServer({ platform: "win32", base: "https://hive.example.com", spawn }).reason).toBe("non-local-base");
  expect(calls).toBe(0);
});
