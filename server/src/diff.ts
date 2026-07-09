// Task diff: the changes on a task's branch, for the in-review approve/merge UI.
// Source is `gh pr diff <url> --patch` when the task has a PR, else a local
// `git -C <repo> diff <base>...<branch>` in the project repo. The unified-diff
// text is parsed into a structured, per-file shape the web diff viewer renders.
// Exec is injected so the whole thing is unit-testable without gh/git.
import type { DB } from "./db.ts";
import { getTask } from "./state.ts";
import type { Exec } from "./exec.ts";
import { defaultExec } from "./exec.ts";

export type LineKind = "add" | "del" | "ctx";
export interface DiffLine {
  kind: LineKind;
  text: string;
}
export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}
export interface DiffFile {
  path: string;
  additions: number;
  deletions: number;
  binary?: boolean;
  hunks: DiffHunk[];
}
export interface DiffResult {
  files: DiffFile[];
  truncated: boolean;
}

// Cap the total number of diff lines we parse/emit; a runaway diff should not
// blow up the payload or the browser. Marked `truncated` when hit.
export const MAX_DIFF_LINES = 20_000;

// Parse a unified diff (git / gh format) into the structured shape. Defensive:
// handles new/deleted files (/dev/null), renames, and binary-file stanzas.
export function parseUnifiedDiff(patch: string, maxLines = MAX_DIFF_LINES): DiffResult {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let emitted = 0;
  let truncated = false;

  const lines = patch.split("\n");
  for (const line of lines) {
    if (truncated) break;

    if (line.startsWith("diff --git ")) {
      const m = line.match(/^diff --git a\/(.*) b\/(.*)$/);
      file = { path: m ? m[2] : line.slice("diff --git ".length), additions: 0, deletions: 0, hunks: [] };
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) continue; // preamble before the first file header

    if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      file.binary = true;
      hunk = null;
      continue;
    }
    if (line.startsWith("+++ ")) {
      const p = line.slice(4).replace(/\t.*$/, "");
      if (p !== "/dev/null") file.path = p.replace(/^b\//, "");
      continue;
    }
    if (line.startsWith("--- ")) continue; // path taken from +++ / diff --git
    // Other extended headers (index, mode, rename, similarity, new/deleted file).
    if (
      line.startsWith("index ") ||
      line.startsWith("old mode ") ||
      line.startsWith("new mode ") ||
      line.startsWith("deleted file mode ") ||
      line.startsWith("new file mode ") ||
      line.startsWith("similarity index ") ||
      line.startsWith("rename from ") ||
      line.startsWith("rename to ") ||
      line.startsWith("copy from ") ||
      line.startsWith("copy to ")
    ) {
      continue;
    }

    if (line.startsWith("@@")) {
      hunk = { header: line, lines: [] };
      file.hunks.push(hunk);
      if (++emitted >= maxLines) truncated = true;
      continue;
    }
    if (!hunk) continue; // stray line outside any hunk

    if (line.startsWith("\\")) continue; // "\ No newline at end of file"

    let kind: LineKind;
    if (line.startsWith("+")) {
      kind = "add";
      file.additions++;
    } else if (line.startsWith("-")) {
      kind = "del";
      file.deletions++;
    } else {
      kind = "ctx"; // " context" or a genuinely empty context line
    }
    hunk.lines.push({ kind, text: line.slice(1) });
    if (++emitted >= maxLines) truncated = true;
  }

  return { files, truncated };
}

export type TaskDiff =
  | { ok: true; diff: DiffResult }
  | { ok: false; status: number; error: string };

// Produce the structured diff for a task. gh for PR-backed tasks, otherwise a
// local `git diff <base>...<branch>` in the project repo.
export async function taskDiff(db: DB, taskId: string, exec: Exec = defaultExec): Promise<TaskDiff> {
  const task = getTask(db, taskId);
  if (!task) return { ok: false, status: 404, error: "task not found" };

  if (task.pr_url) {
    const r = await exec(["gh", "pr", "diff", task.pr_url, "--patch"]);
    if (r.code !== 0)
      return { ok: false, status: 502, error: `gh pr diff failed: ${r.stderr.trim() || r.stdout.trim() || `exit ${r.code}`}` };
    return { ok: true, diff: parseUnifiedDiff(r.stdout) };
  }

  const project: any = db.query("SELECT * FROM projects WHERE id = ?").get(task.project_id);
  if (!project?.repo_path) return { ok: false, status: 400, error: "project has no repo_path; cannot diff" };
  if (!task.branch) return { ok: false, status: 400, error: "task has no branch and no pr_url; nothing to diff" };
  const config = JSON.parse(project.config ?? "{}");
  const base = config.default_branch || "main";

  const r = await exec(["git", "-C", project.repo_path, "diff", `${base}...${task.branch}`]);
  if (r.code !== 0)
    return { ok: false, status: 502, error: `git diff failed: ${r.stderr.trim() || r.stdout.trim() || `exit ${r.code}`}` };
  return { ok: true, diff: parseUnifiedDiff(r.stdout) };
}
