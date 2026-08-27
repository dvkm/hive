// Repo paths are entered in the browser but consumed by the local Hive server.
// Accept the absolute forms supported by Hive's desktop platforms instead of
// assuming that every absolute path starts with `/` (Unix only).
export function isAbsoluteRepoPath(value: string): boolean {
  const path = value.trim();
  if (!path) return false;
  if (path.startsWith("/")) return true; // macOS/Linux (including WSL)
  if (/^[A-Za-z]:[\\/]/.test(path)) return true; // Windows drive path
  return /^\\\\[^\\/]+[\\/][^\\/]+/.test(path); // Windows UNC share
}

export const repoPathPlaceholder =
  typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent)
    ? "C:\\Users\\you\\code\\project"
    : "/Users/you/code/project";
