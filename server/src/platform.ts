import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

export type HostPlatform = NodeJS.Platform;

// Use both path grammars when inspecting user/config input. The active host
// still decides whether a path can actually be used, but this keeps shared
// validation and command resolution from treating `C:\\...` as relative when
// tests or migration tooling run on another OS.
export function isPortableAbsolutePath(value: string): boolean {
  return posix.isAbsolute(value) || win32.isAbsolute(value);
}

export function toShellPath(value: string, platform: HostPlatform = process.platform): string {
  return platform === "win32" ? value.replaceAll("\\", "/") : value;
}

export function resolveConfiguredCommand(repoPath: string, command: string): string {
  if (isPortableAbsolutePath(command)) return command;
  // Bare executable names resolve through PATH. Relative scripts contain a
  // separator and are anchored to the primary checkout as before.
  if (
    !command.includes("/") &&
    !command.includes("\\") &&
    !/\.(?:sh|ps1|ts|js|mjs|cjs|py|rb)$/i.test(command)
  ) return command;
  const paths = /^[A-Za-z]:[\\/]/.test(repoPath) || repoPath.startsWith("\\\\") ? win32 : posix;
  return paths.join(repoPath, command);
}

function windowsFallbacks(env: NodeJS.ProcessEnv): string[] {
  const profile = env.USERPROFILE || env.HOME || homedir();
  const local = env.LOCALAPPDATA || win32.join(profile, "AppData", "Local");
  const programFiles = env.ProgramFiles || "C:\\Program Files";
  const programFilesX86 = env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const systemRoot = env.SystemRoot || "C:\\Windows";
  return [
    win32.join(systemRoot, "System32"),
    win32.join(profile, ".bun", "bin"),
    win32.join(profile, ".local", "bin"),
    win32.join(local, "Programs", "Herdr", "bin"),
    win32.join(programFiles, "Git", "cmd"),
    win32.join(programFiles, "Git", "bin"),
    win32.join(programFiles, "GitHub CLI"),
    win32.join(programFilesX86, "GitHub CLI"),
  ];
}

function unixFallbacks(env: NodeJS.ProcessEnv): string[] {
  const home = env.HOME || homedir();
  return [
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
    posix.join(home, ".bun", "bin"),
    posix.join(home, ".local", "bin"),
  ];
}

export function buildExecutablePath(
  current: string | undefined = process.env.PATH,
  platform: HostPlatform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): string {
  const separator = platform === "win32" ? ";" : ":";
  const candidates = [
    ...(current ?? "").split(separator).filter(Boolean),
    ...(platform === "win32" ? windowsFallbacks(env) : unixFallbacks(env)),
  ];
  const seen = new Set<string>();
  return candidates
    .filter((entry) => {
      const key = platform === "win32" ? entry.toLowerCase() : entry;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join(separator);
}

export function findGitBash(
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync
): string | null {
  if (env.CLAUDE_CODE_GIT_BASH_PATH && exists(env.CLAUDE_CODE_GIT_BASH_PATH))
    return env.CLAUDE_CODE_GIT_BASH_PATH;
  const programFiles = env.ProgramFiles || "C:\\Program Files";
  const programFilesX86 = env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  for (const candidate of [
    win32.join(programFiles, "Git", "bin", "bash.exe"),
    win32.join(programFilesX86, "Git", "bin", "bash.exe"),
  ]) {
    if (exists(candidate)) return candidate;
  }
  return null;
}

// Environment explicitly passed to every Herdr-started agent. This fixes the
// common Windows case where Hive/Herdr was launched before an installer updated
// the user's PATH, and it gives native Claude Code the Git Bash location its
// Windows runtime requires.
export function agentPlatformEnv(
  env: NodeJS.ProcessEnv = process.env,
  platform: HostPlatform = process.platform,
  exists: (path: string) => boolean = existsSync
): Record<string, string> {
  const out: Record<string, string> = { PATH: buildExecutablePath(env.PATH, platform, env) };
  if (platform === "win32") {
    const gitBash = findGitBash(env, exists);
    if (gitBash) out.CLAUDE_CODE_GIT_BASH_PATH = gitBash;
  }
  return out;
}

export function commandForCurrentShell(argv: string[], platform: HostPlatform = process.platform): string {
  // Hive's agent hooks are run by a shell (Git Bash for native Claude Code on
  // Windows). `bun` is deliberately bare: agentPlatformEnv guarantees it is on
  // PATH, avoiding PowerShell's special `&` requirement for a quoted executable.
  return argv
    .map((arg, index) => {
      const value = index > 0 ? toShellPath(arg, platform) : arg;
      return /[\s"'`$;&|<>]/.test(value) ? JSON.stringify(value) : value;
    })
    .join(" ");
}
