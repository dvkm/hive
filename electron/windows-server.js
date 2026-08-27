const { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync } = require("node:fs");
const { dirname, join } = require("node:path");
const { spawn } = require("node:child_process");

const CONFIG_NAME = "server-launch.json";
const START_LOCK_MS = 30_000;

function isDefaultLocalBase(base) {
  try {
    const url = new URL(base);
    return url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost") &&
      url.port === "4700";
  } catch {
    return false;
  }
}

function readServerLaunchConfig(configPath, exists = existsSync) {
  if (!configPath || !exists(configPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8"));
    if (typeof parsed?.bun !== "string" || typeof parsed?.cwd !== "string") return null;
    if (!exists(parsed.bun) || !exists(join(parsed.cwd, "package.json"))) return null;
    return { bun: parsed.bun, cwd: parsed.cwd };
  } catch {
    return null;
  }
}

function acquireStartLock(lockPath, now = Date.now()) {
  const create = () => {
    const fd = openSync(lockPath, "wx");
    closeSync(fd);
  };
  try {
    create();
    return true;
  } catch (error) {
    if (error?.code !== "EEXIST") return false;
  }
  try {
    if (now - statSync(lockPath).mtimeMs < START_LOCK_MS) return false;
    unlinkSync(lockPath);
    create();
    return true;
  } catch {
    return false;
  }
}

function launchWindowsServer(options = {}) {
  const platform = options.platform ?? process.platform;
  const base = options.base ?? "http://127.0.0.1:4700";
  if (platform !== "win32") return { started: false, reason: "not-windows" };
  if (!isDefaultLocalBase(base)) return { started: false, reason: "non-local-base" };

  const configPath = options.configPath ?? join(dirname(options.execPath ?? process.execPath), CONFIG_NAME);
  const config = readServerLaunchConfig(configPath, options.existsSync ?? existsSync);
  if (!config) return { started: false, reason: "missing-config" };

  const stateDir = join(options.localAppData ?? process.env.LOCALAPPDATA ?? config.cwd, "Hive", "logs");
  (options.mkdirSync ?? mkdirSync)(stateDir, { recursive: true });
  if (!acquireStartLock(join(dirname(stateDir), "server-start.lock"), options.now ?? Date.now()))
    return { started: false, reason: "launch-in-progress" };
  const open = options.openSync ?? openSync;
  const close = options.closeSync ?? closeSync;
  const stdout = open(join(stateDir, "server.stdout.log"), "a");
  const stderr = open(join(stateDir, "server.stderr.log"), "a");
  try {
    const child = (options.spawn ?? spawn)(config.bun, ["run", "server"], {
      cwd: config.cwd,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", stdout, stderr],
    });
    child.unref?.();
    return { started: true, pid: child.pid ?? null };
  } catch (error) {
    return { started: false, reason: "spawn-failed", error: String(error) };
  } finally {
    close(stdout);
    close(stderr);
  }
}

module.exports = { CONFIG_NAME, START_LOCK_MS, isDefaultLocalBase, readServerLaunchConfig, acquireStartLock, launchWindowsServer };
