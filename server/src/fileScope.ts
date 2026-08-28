// Predicted file scope at DISPATCH time (HIVE-509).
//
// The dispatcher used to start up to max_agents tasks with no idea what files
// they would touch, so two agents could edit the same region and only find out
// at merge time — or, worse, merge cleanly and contradict each other (PR #5 and
// PR #48 both added a handler for the same condition in server/src/sidecar.ts;
// git saw no conflict, three tests on main did).
//
// This guesses a task's file scope from the cheapest signals available before
// any code exists:
//
//   brief      — paths named in the title/brief ("server/src/api.ts", "api.ts",
//                "web/src/"). Most briefs name where the work goes.
//   predecessor— for a requeue, the files the parent task's branch actually
//                touched (the `branch_scope` event the rebase guard records).
//
// It is deliberately coarse and deliberately advisory. The dispatcher only uses
// it to ORDER work — prefer a non-overlapping task — never to block one, so a
// wrong guess costs one dispatch cycle, not a stuck queue. scoreScopePrediction
// then compares the guess against the branch's real file list, so the whole idea
// can be tuned or dropped on evidence.
import type { DB } from "./db.ts";
import { writeEvent } from "./state.ts";

export interface FileScope {
  files: string[]; // paths named, as written (may be bare basenames)
  dirs: string[]; // directory prefixes named, always trailing-slashed
  from: string[]; // which signals produced this ("brief", "predecessor")
}

export const EMPTY_SCOPE: FileScope = { files: [], dirs: [], from: [] };

// Extensions worth treating as "a file this task will edit". Anything outside
// this list (a version number, a domain) is not a path we care about.
const CODE_EXT =
  "ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|java|kt|swift|c|h|cc|cpp|cs|php|css|scss|html|json|yaml|yml|toml|sql|sh|md|txt";
const PATH_RE = new RegExp(String.raw`(?:^|[\s(\[\`"'<,])((?:[\w.@-]+/)*[\w.-]+\.(?:${CODE_EXT}))\b`, "gi");
// A bare directory mention: "server/src/", "web/src/views/". Needs the trailing
// slash — without it every word pair would look like a path.
const DIR_RE = /(?:^|[\s(\[`"'<,])((?:[\w.-]+\/){1,6})(?=[\s)\]`"'>,.]|$)/g;
// A brief can name a lot of files (this one names five). Cap so a pathological
// brief cannot make the overlap scan expensive.
const MAX_FILES = 40;

function uniq(xs: string[], cap = MAX_FILES): string[] {
  return [...new Set(xs)].slice(0, cap);
}

export function basename(p: string): string {
  return (p.split("/").pop() ?? p).toLowerCase();
}

// Paths and directories named in free text. URLs are stripped first: a doc link
// ending in .md is a reference, not a file this task edits.
export function pathsInText(text: string | null | undefined): { files: string[]; dirs: string[] } {
  if (!text) return { files: [], dirs: [] };
  const clean = text.replace(/https?:\/\/\S+/g, " ");
  const files = [...clean.matchAll(PATH_RE)].map((m) => m[1]);
  const dirs = [...clean.matchAll(DIR_RE)].map((m) => m[1]);
  return { files: uniq(files), dirs: uniq(dirs) };
}

// The files a task's branch actually touched, from the rebase guard's
// `branch_scope` snapshot. Null when nothing was ever captured.
export function actualFiles(db: DB, taskId: string): string[] | null {
  const row = db
    .query("SELECT payload FROM events WHERE task_id = ? AND type = 'branch_scope' ORDER BY ts DESC, rowid DESC LIMIT 1")
    .get(taskId) as { payload: string } | undefined;
  if (!row) return null;
  try {
    const files = JSON.parse(row.payload).files;
    return Array.isArray(files) ? files.filter((f: unknown) => typeof f === "string") : null;
  } catch {
    return null;
  }
}

// The guess recorded for a task when it was dispatched.
export function recordedScope(db: DB, taskId: string): FileScope | null {
  const row = db
    .query("SELECT payload FROM events WHERE task_id = ? AND type = 'dispatch_scope' ORDER BY ts DESC, rowid DESC LIMIT 1")
    .get(taskId) as { payload: string } | undefined;
  if (!row) return null;
  try {
    const p = JSON.parse(row.payload);
    return { files: p.files ?? [], dirs: p.dirs ?? [], from: p.from ?? [] };
  } catch {
    return null;
  }
}

// Guess what a queued task will touch. Brief first, then the predecessor's real
// file list for a requeue (whose brief is often just "try again").
export function predictScope(db: DB, task: { id: string; title?: string | null; brief?: string | null; source?: string | null; parent_task_id?: string | null }): FileScope {
  const from: string[] = [];
  const { files, dirs } = pathsInText(`${task.title ?? ""}\n${task.brief ?? ""}`);
  if (files.length || dirs.length) from.push("brief");
  const all = [...files];
  if (task.source === "requeue" && task.parent_task_id) {
    const prior = actualFiles(db, task.parent_task_id);
    if (prior?.length) {
      all.push(...prior);
      from.push("predecessor");
    }
  }
  return { files: uniq(all), dirs, from };
}

// The scope of a task that is ALREADY running: its real branch files if we have
// them, else the guess we made when it was dispatched.
export function inFlightScope(db: DB, taskId: string): FileScope {
  const actual = actualFiles(db, taskId);
  if (actual?.length) return { files: uniq(actual), dirs: [], from: ["branch"] };
  return recordedScope(db, taskId) ?? EMPTY_SCOPE;
}

// Do two paths name the same file? Exact match when both are qualified; a bare
// name matches on the basename, so a brief saying "api.ts" collides with one
// saying "server/src/api.ts". Two qualified paths must agree in full, otherwise
// every project's index.ts would look like one file.
function samePath(a: string, b: string): boolean {
  if (a === b) return true;
  const bare = (p: string) => !p.includes("/");
  if (!bare(a) && !bare(b)) return false;
  return basename(a) === basename(b);
}

// The shared file/directory names between two scopes, capped for display.
// Empty means "no predicted overlap" — including when either side is empty,
// which is the honest answer for a brief that names no paths at all.
export function scopeOverlap(a: FileScope, b: FileScope): string[] {
  const shared = new Set<string>();
  for (const f of a.files) for (const g of b.files) if (samePath(f, g)) shared.add(basename(f));
  for (const d of a.dirs) {
    if (b.dirs.includes(d) || b.files.some((f) => f.startsWith(d))) shared.add(d);
  }
  for (const d of b.dirs) if (a.files.some((f) => f.startsWith(d))) shared.add(d);
  return [...shared].sort().slice(0, 5);
}

// Score the guess against what the branch really touched, once per task. Written
// as an event so the hit rate can be read off the timeline, and logged so it
// shows up in the server log without a query.
// ponytail: basename-level scoring, same coarseness the matcher uses.
export function scoreScopePrediction(db: DB, taskId: string, actual: string[]): void {
  const predicted = recordedScope(db, taskId);
  if (!predicted?.files.length || !actual.length) return;
  const already = db
    .query("SELECT 1 FROM events WHERE task_id = ? AND type = 'scope_prediction_scored' LIMIT 1")
    .get(taskId);
  if (already) return;
  const actualNames = new Set(actual.map(basename));
  const hits = predicted.files.filter((f) => actualNames.has(basename(f)));
  const precision = hits.length / predicted.files.length;
  const recall = hits.length / actualNames.size;
  writeEvent(db, {
    task_id: taskId,
    source: "reconciler",
    type: "scope_prediction_scored",
    payload: {
      note: `predicted ${predicted.files.length} file(s), ${hits.length} were really touched (of ${actualNames.size})`,
      predicted: predicted.files,
      hits,
      actual_count: actualNames.size,
      precision: Number(precision.toFixed(2)),
      recall: Number(recall.toFixed(2)),
      from: predicted.from,
    },
  });
  console.log(
    `[hive] scope prediction task=${taskId} predicted=${predicted.files.length} actual=${actualNames.size} hits=${hits.length} precision=${precision.toFixed(2)} recall=${recall.toFixed(2)}`
  );
}

// Record WHY a queued task was held back, so the board can show it. Deduped on
// the note (same shape as noteDependencyBlock): the dispatcher runs every 30s
// and the same hold must not write an event per cycle.
export function noteOverlapHold(
  db: DB,
  taskId: string,
  peer: { id: string; number: number },
  files: string[]
): void {
  const note = `waiting for #${peer.number} to finish — both look like they touch ${files.join(", ")}`;
  const last = db
    .query("SELECT payload FROM events WHERE task_id = ? AND type = 'dispatch_hold_overlap' ORDER BY ts DESC, rowid DESC LIMIT 1")
    .get(taskId) as { payload: string } | undefined;
  if (last) {
    try {
      if (JSON.parse(last.payload).note === note) return;
    } catch {}
  }
  writeEvent(db, {
    task_id: taskId,
    source: "dispatcher",
    type: "dispatch_hold_overlap",
    payload: { note, held_by: peer.id, held_by_number: peer.number, files },
  });
}

// The hold to show on a queued card: the most recent overlap hold, but only
// while the task it is waiting on is still working. A hold whose peer has
// finished is stale — the next dispatch cycle will start this task.
export function overlapHold(db: DB, taskId: string): { number: number; files: string[] } | null {
  const row = db
    .query("SELECT payload FROM events WHERE task_id = ? AND type = 'dispatch_hold_overlap' ORDER BY ts DESC, rowid DESC LIMIT 1")
    .get(taskId) as { payload: string } | undefined;
  if (!row) return null;
  try {
    const p = JSON.parse(row.payload);
    const peer = db.query("SELECT number, state FROM tasks WHERE id = ?").get(p.held_by) as { number: number; state: string } | undefined;
    if (!peer || !["in_progress", "needs_decision"].includes(peer.state)) return null;
    return { number: peer.number, files: p.files ?? [] };
  } catch {
    return null;
  }
}
