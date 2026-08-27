const { spawnSync } = require("node:child_process");
const { cpSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const bin = join(__dirname, "node_modules", "electron-builder", "out", "cli", "cli.js");
const target = process.platform === "darwin" ? "--mac" : process.platform === "win32" ? "--win" : "--linux";
// Electron Builder extracts to `<output>.tmp` and renames that directory. On
// Windows, Defender/indexers commonly hold one freshly extracted file long
// enough for that rename to fail with EPERM. Stage outside the checkout, then
// copy the completed app into dist; this also keeps partial builds out of dist.
const staging = process.platform === "win32" ? mkdtempSync(join(tmpdir(), "hive-electron-build-")) : null;
const args = [bin, target, "--dir"];
if (staging) args.push(`--config.directories.output=${staging}`);
const build = spawnSync(process.execPath, args, { cwd: __dirname, stdio: "inherit", shell: false });
if (build.status !== 0) process.exit(build.status || 1);

if (staging) {
  const source = join(staging, "win-unpacked");
  const destination = join(__dirname, "dist", "win-unpacked");
  const previous = join(__dirname, "dist", `win-unpacked.previous-${process.pid}`);
  mkdirSync(join(__dirname, "dist"), { recursive: true });
  // Never hollow out the previous usable build one file at a time. Rename it
  // first (atomic on the same volume), install the new directory, then remove
  // the backup. If Windows has the app open, the rename fails before damage.
  if (existsSync(destination)) renameSync(destination, previous);
  try {
    cpSync(source, destination, { recursive: true });
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    if (existsSync(previous)) renameSync(previous, destination);
    throw error;
  }
  try { rmSync(previous, { recursive: true, force: true }); } catch { /* a scanner may release the old build later */ }
  try { rmSync(staging, { recursive: true, force: true }); } catch { /* transient scanner lock; OS temp cleanup can reclaim it */ }
}

if (process.platform === "darwin") {
  const sign = spawnSync(
    "codesign",
    ["--force", "--sign", "-", "--requirements", '=designated => identifier "dev.hive.app"', "dist/mac-arm64/hive.app"],
    { cwd: __dirname, stdio: "inherit" }
  );
  if (sign.status !== 0) process.exit(sign.status || 1);
}
