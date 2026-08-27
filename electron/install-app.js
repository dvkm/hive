const { cpSync, existsSync, mkdirSync, renameSync, rmSync } = require("node:fs");
const { homedir } = require("node:os");
const { dirname, join } = require("node:path");
const { spawnSync } = require("node:child_process");

if (process.platform === "darwin") {
  const r = spawnSync("bash", [join(__dirname, "install-app.sh")], { cwd: __dirname, stdio: "inherit" });
  process.exit(r.status ?? 1);
}

if (process.platform !== "win32") {
  console.error("install-app currently supports macOS and Windows; use the unpacked Linux build in electron/dist");
  process.exit(1);
}

const source = join(__dirname, "dist", "win-unpacked");
const local = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
const destination = process.env.HIVE_APP_DEST || join(local, "Programs", "hive");
const staged = `${destination}.new`;
const executable = join(destination, "hive.exe");
const appData = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
const shortcut = join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "hive.lnk");

if (!existsSync(join(source, "hive.exe"))) {
  console.error(`no built Windows app at ${source}; run 'bun run build' in electron first`);
  process.exit(1);
}

mkdirSync(join(destination, ".."), { recursive: true });
rmSync(staged, { recursive: true, force: true });
cpSync(source, staged, { recursive: true });
rmSync(destination, { recursive: true, force: true });
renameSync(staged, destination);

// Per-user protocol registration; no elevation is required and uninstalling
// Hive only needs this one HKCU key removed.
const root = "HKCU\\Software\\Classes\\hive";
const appPathRoot = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\hive.exe";
const command = `\"${executable}\" \"%1\"`;
for (const args of [
  ["add", root, "/ve", "/d", "URL:hive protocol", "/f"],
  ["add", root, "/v", "URL Protocol", "/d", "", "/f"],
  ["add", `${root}\\shell\\open\\command`, "/ve", "/d", command, "/f"],
  ["add", appPathRoot, "/ve", "/d", executable, "/f"],
  ["add", appPathRoot, "/v", "Path", "/d", destination, "/f"],
]) {
  const r = spawnSync("reg.exe", args, { stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

mkdirSync(dirname(shortcut), { recursive: true });
const psQuote = (value) => `'${value.replaceAll("'", "''")}'`;
const shortcutScript = [
  "$shell = New-Object -ComObject WScript.Shell",
  `$link = $shell.CreateShortcut(${psQuote(shortcut)})`,
  `$link.TargetPath = ${psQuote(executable)}`,
  `$link.WorkingDirectory = ${psQuote(destination)}`,
  `$link.IconLocation = ${psQuote(`${executable},0`)}`,
  "$link.Save()",
].join(";");
const link = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", shortcutScript], { stdio: "inherit" });
if (link.status !== 0) process.exit(link.status ?? 1);

console.log(`installed hive to ${destination} (Start Menu shortcut and hive:// registered)`);
