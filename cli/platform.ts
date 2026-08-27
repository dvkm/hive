import { homedir } from "node:os";
import { join, win32 } from "node:path";

export function openUrlArgv(url: string, platform: NodeJS.Platform = process.platform): string[] {
  if (platform === "darwin") return ["open", url];
  if (platform === "win32") return ["explorer.exe", url];
  return ["xdg-open", url];
}

export function installedHiveAppCandidates(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string[] {
  if (env.HIVE_APP_PATH) return [env.HIVE_APP_PATH];
  if (platform === "darwin") return ["/Applications/hive.app"];
  if (platform === "win32") {
    const home = env.USERPROFILE || env.HOME || homedir();
    const local = env.LOCALAPPDATA || win32.join(home, "AppData", "Local");
    return [win32.join(local, "Programs", "hive", "hive.exe")];
  }
  return [join(env.HOME || homedir(), ".local", "opt", "hive", "hive")];
}

export function appBrowserCandidates(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string[] {
  if (platform === "darwin") return ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"];
  if (platform === "win32") {
    const home = env.USERPROFILE || env.HOME || homedir();
    const local = env.LOCALAPPDATA || win32.join(home, "AppData", "Local");
    const pf = env.ProgramFiles || "C:\\Program Files";
    const pfx86 = env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    return [
      win32.join(local, "Google", "Chrome", "Application", "chrome.exe"),
      win32.join(pf, "Google", "Chrome", "Application", "chrome.exe"),
      win32.join(pfx86, "Google", "Chrome", "Application", "chrome.exe"),
      win32.join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
      win32.join(pfx86, "Microsoft", "Edge", "Application", "msedge.exe"),
    ];
  }
  return ["google-chrome", "chromium", "chromium-browser"];
}

export function tailscaleCandidates(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string[] {
  if (platform === "darwin")
    return ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/opt/homebrew/bin/tailscale"];
  if (platform === "win32") {
    const pf = env.ProgramFiles || "C:\\Program Files";
    return ["tailscale.exe", win32.join(pf, "Tailscale", "tailscale.exe")];
  }
  return ["tailscale", "/usr/bin/tailscale", "/usr/local/bin/tailscale"];
}
