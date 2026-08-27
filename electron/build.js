const { spawnSync } = require("node:child_process");
const { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } = require("node:fs");
const { homedir, tmpdir } = require("node:os");
const { join } = require("node:path");

const bin = join(__dirname, "node_modules", "electron-builder", "out", "cli", "cli.js");
const target = process.platform === "darwin" ? "--mac" : process.platform === "win32" ? "--win" : "--linux";
// Electron Builder extracts to `<output>.tmp` and renames that directory. On
// Windows, Defender/indexers commonly hold one freshly extracted file long
// enough for that rename to fail with EPERM. Stage outside the checkout, then
// move the completed app into a per-user cache. Checkout directories are
// aggressively indexed by editors and antivirus, so replacing dist/win-unpacked
// is not reliable even after the app exits. A unique cache directory never
// needs an in-use Electron file to be renamed or deleted.
const staging = process.platform === "win32" ? mkdtempSync(join(tmpdir(), "hive-electron-build-")) : null;
const args = [bin, target, "--dir"];
if (staging) args.push(`--config.directories.output=${staging}`);
const build = spawnSync(process.execPath, args, { cwd: __dirname, stdio: "inherit", shell: false });
if (build.status !== 0) process.exit(build.status || 1);

if (staging) {
  const source = join(staging, "win-unpacked");
  const local = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
  const buildRoot = process.env.HIVE_ELECTRON_BUILD_DIR || join(local, "Hive", "electron-builds");
  const destination = join(buildRoot, `win-unpacked-${Date.now()}-${process.pid}`);
  const pointer = join(buildRoot, "latest.txt");
  mkdirSync(buildRoot, { recursive: true });
  try {
    renameSync(source, destination);
  } catch (error) {
    if (existsSync(destination)) rmSync(destination, { recursive: true, force: true });
    cpSync(source, destination, { recursive: true });
  }
  writeFileSync(pointer, destination, "utf8");
  for (const entry of readdirSync(buildRoot)) {
    const old = join(buildRoot, entry);
    if (entry.startsWith("win-unpacked-") && old !== destination) {
      try { rmSync(old, { recursive: true, force: true }); } catch { /* an old smoke run may still hold it */ }
    }
  }
  try { rmSync(staging, { recursive: true, force: true }); } catch { /* transient scanner lock; OS temp cleanup can reclaim it */ }
  console.log(`Windows bundle staged at ${destination}`);
}

if (process.platform === "darwin") {
  const sign = spawnSync(
    "codesign",
    ["--force", "--sign", "-", "--requirements", '=designated => identifier "dev.hive.app"', "dist/mac-arm64/hive.app"],
    { cwd: __dirname, stdio: "inherit" }
  );
  if (sign.status !== 0) process.exit(sign.status || 1);
}
