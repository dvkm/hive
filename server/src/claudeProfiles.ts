// Route Claude Code authentication by the ORIGINAL project repository path.
//
// Claude Code's CLAUDE_CONFIG_DIR is process-scoped, while Hive runs project
// work in Herdr worktrees whose paths no longer sit under the original repo.
// A user's interactive shell can therefore select the right account while a
// background planner/worker silently inherits another one. Keep the routing in
// HIVE_HOME/claude-profiles.json so it is machine-local and never committed:
//
// {
//   "default_config_dir": "C:\\Users\\me\\.claude",
//   "routes": [
//     { "root": "C:\\Users\\me\\work\\company", "config_dir": "C:\\Users\\me\\.claude-company" }
//   ]
// }
//
// The longest containing root wins. Outside every route, CLAUDE_CONFIG_DIR is
// omitted (unless default_config_dir is explicitly configured), which preserves
// Claude Code's normal personal-profile layout.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix, win32 } from "node:path";
import type { DB } from "./db.ts";

export interface ClaudeProfileRoute {
  root: string;
  config_dir: string;
}

export interface ClaudeProfilesConfig {
  default_config_dir?: string;
  routes: ClaudeProfileRoute[];
}

function windowsPath(value: string): boolean {
  return win32.isAbsolute(value);
}

function absolute(value: string): boolean {
  return windowsPath(value) || posix.isAbsolute(value);
}

function containsPath(root: string, candidate: string): boolean {
  const path = windowsPath(root) || windowsPath(candidate) ? win32 : posix;
  let normalizedRoot = path.resolve(root);
  let normalizedCandidate = path.resolve(candidate);
  if (path === win32) {
    normalizedRoot = normalizedRoot.toLowerCase();
    normalizedCandidate = normalizedCandidate.toLowerCase();
  }
  const relative = path.relative(normalizedRoot, normalizedCandidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function validateConfig(raw: unknown): ClaudeProfilesConfig {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("Claude profile routing must be a JSON object");
  const value = raw as Record<string, unknown>;
  for (const key of Object.keys(value))
    if (key !== "default_config_dir" && key !== "routes")
      throw new Error(`Claude profile routing has unknown key '${key}'`);
  if (value.default_config_dir !== undefined && (typeof value.default_config_dir !== "string" || !absolute(value.default_config_dir)))
    throw new Error("Claude profile default_config_dir must be an absolute path");
  if (!Array.isArray(value.routes)) throw new Error("Claude profile routes must be an array");
  const routes = value.routes.map((item, index) => {
    if (item === null || typeof item !== "object" || Array.isArray(item))
      throw new Error(`Claude profile routes[${index}] must be an object`);
    const route = item as Record<string, unknown>;
    for (const key of Object.keys(route))
      if (key !== "root" && key !== "config_dir")
        throw new Error(`Claude profile routes[${index}] has unknown key '${key}'`);
    if (typeof route.root !== "string" || !absolute(route.root))
      throw new Error(`Claude profile routes[${index}].root must be an absolute path`);
    if (typeof route.config_dir !== "string" || !absolute(route.config_dir))
      throw new Error(`Claude profile routes[${index}].config_dir must be an absolute path`);
    return { root: route.root, config_dir: route.config_dir };
  });
  return { default_config_dir: value.default_config_dir as string | undefined, routes };
}

export function claudeProfilesPath(
  env: NodeJS.ProcessEnv = process.env,
  userHome: string = homedir()
): string {
  const hiveHome = env.HIVE_HOME || join(userHome, ".hive");
  return env.HIVE_CLAUDE_PROFILES || join(hiveHome, "claude-profiles.json");
}

export function loadClaudeProfiles(file: string = claudeProfilesPath()): ClaudeProfilesConfig {
  if (!existsSync(file)) return { routes: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error: any) {
    throw new Error(`Could not read Claude profile routing at ${file}: ${error?.message ?? error}`);
  }
  const config = validateConfig(parsed);
  return config;
}

export function selectClaudeConfigDir(
  repoPath: string | null | undefined,
  config: ClaudeProfilesConfig
): string | null {
  const fallback = config.default_config_dir || null;
  if (!repoPath) return fallback;
  const matches = config.routes.filter((route) => containsPath(route.root, repoPath));
  matches.sort((a, b) => b.root.length - a.root.length);
  return matches[0]?.config_dir || fallback;
}

export function claudeProfileEnvForRepo(repoPath?: string | null): Record<string, string> {
  const configDir = selectClaudeConfigDir(repoPath, loadClaudeProfiles());
  return configDir ? { CLAUDE_CONFIG_DIR: configDir } : {};
}

export function claudeProfileEnvForProject(db: DB, projectId: string): Record<string, string> {
  const project = db.query("SELECT repo_path FROM projects WHERE id = ?").get(projectId) as { repo_path: string | null } | undefined;
  return claudeProfileEnvForRepo(project?.repo_path);
}
