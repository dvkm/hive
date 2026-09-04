// Preview stacks for review cards (HIVE-629).
//
// A UI change is verified by LOOKING at it. Before this, the director read a
// PR or waited for staging, because the only way to see the branch running was
// to hand-run the project's worktree stack script and guess the URLs.
//
// A project opts in with config.preview:
//
//   preview: {
//     up:   "infra/worktree/wt.sh up",
//     down: "infra/worktree/wt.sh down",
//     urls: [{ label: "web", url: "https://{slug}.test.corebeat.co.kr" }, ...],
//     login_hint: "superadmin@corebeat.co.kr / corebeat1234",
//     paths: ["web/**", "cms/**"]
//   }
//
// No `preview` key means no preview UI anywhere — the card renders exactly as
// it did before. Both commands run with cwd = the TASK'S OWN WORKTREE, which is
// what makes the URLs unique per task: the stack script derives its slug from
// the directory it runs in, and hive worktrees are one per task.
//
// State is DERIVED FROM EVENTS, not a table: the newest preview_* event on a
// task is its status. That keeps the feature migration-free and makes the card
// deterministic — the same event log always renders the same text.
import type { DB } from "./db.ts";
import { getTask, writeEvent } from "./state.ts";
import { broadcastTask } from "./health.ts";
import type { Exec } from "./exec.ts";
import { defaultExec, projectComparisonBase } from "./exec.ts";
import { resolveConfiguredCommand } from "./platform.ts";

export type PreviewUrl = { label: string; url: string };

export type PreviewConfig = {
  up: string[];
  down: string[];
  urls: PreviewUrl[];
  login_hint: string | null;
  paths: string[];
};

export type PreviewStatus = "idle" | "queued" | "building" | "ready" | "failed" | "expired";

export type PreviewState = {
  status: PreviewStatus;
  urls: PreviewUrl[];
  login_hint: string | null;
  // The page the agent changed ("open the page I changed"), if it named one.
  preview_path: string | null;
  smoke_passed: number | null;
  smoke_failed: number | null;
  // Log tail, only on failure.
  tail: string | null;
  // Why a queued preview is waiting, or why a ready one went away.
  reason: string | null;
  at: string | null;
};

// How many stacks may be up at once on this machine. Each corebeat stack is
// ~6 containers and ~1.2 GB, so this is a memory ceiling, not a policy.
// ponytail: a flat machine-wide cap. Hive runs one fleet per laptop.
export const PREVIEW_CAP = Number(process.env.HIVE_PREVIEW_CAP || 3);
// A preview nobody has looked at for this long is torn down. There is no way to
// observe a URL being hit, so "looked at" means the director touched the card.
export const PREVIEW_IDLE_MS = Number(process.env.HIVE_PREVIEW_IDLE_MS || 4 * 3_600_000);
const UP_TIMEOUT_MS = Number(process.env.HIVE_PREVIEW_UP_TIMEOUT_MS || 900_000);
const DOWN_TIMEOUT_MS = Number(process.env.HIVE_PREVIEW_DOWN_TIMEOUT_MS || 180_000);
const TAIL_LINES = 15;

// The states in which a stack is actually running (or about to be), so they
// count against the cap and are worth tearing down.
const LIVE: PreviewStatus[] = ["building", "ready"];

// ---------------------------------------------------------------- config

// A command may be written as a string ("infra/worktree/wt.sh up") or an argv
// array. Strings are SPLIT ON WHITESPACE, never handed to a shell, so a value
// carrying shell syntax is rejected rather than silently interpreted.
function commandArgv(v: unknown): string[] | null {
  const parts = Array.isArray(v) ? v.map((x) => String(x)) : typeof v === "string" ? v.trim().split(/\s+/) : null;
  if (!parts || !parts.length || parts.some((p) => !p || /[;&|`$<>(){}\n]/.test(p))) return null;
  return parts;
}

// Returns the project's preview config, or null when the project has not opted
// in (or its config is malformed — validateProjectConfig already refuses that
// at the API boundary, so this is belt and braces).
export function previewConfig(config: any): PreviewConfig | null {
  const p = config?.preview;
  if (!p || typeof p !== "object" || Array.isArray(p)) return null;
  const up = commandArgv(p.up);
  const down = commandArgv(p.down);
  if (!up || !down) return null;
  const urls: PreviewUrl[] = Array.isArray(p.urls)
    ? p.urls
        .filter((u: any) => u && typeof u.label === "string" && typeof u.url === "string")
        .map((u: any) => ({ label: u.label, url: u.url }))
    : [];
  if (!urls.length) return null;
  return {
    up,
    down,
    urls,
    login_hint: typeof p.login_hint === "string" ? p.login_hint : null,
    paths: Array.isArray(p.paths) ? p.paths.filter((x: any) => typeof x === "string") : [],
  };
}

// SLUG is the worktree's own directory name — hive worktrees live at
// ~/.herdr/worktrees/<project>/<slug>, one per task, so every task's URLs differ.
export function previewSlug(worktreePath: string): string {
  return worktreePath.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
}

export function previewUrls(cfg: PreviewConfig, worktreePath: string): PreviewUrl[] {
  const slug = previewSlug(worktreePath);
  return cfg.urls.map((u) => ({ label: u.label, url: u.url.replaceAll("{slug}", slug) }));
}

// A deep link is a path on the preview host, so anything that could redirect it
// somewhere else (a scheme, a host, a protocol-relative "//evil") is dropped.
function normalizePath(path: string): string {
  const trimmed = String(path).trim();
  if (!trimmed || !trimmed.startsWith("/") || trimmed.startsWith("//")) return "";
  return trimmed;
}

// ---------------------------------------------------------------- state

type PreviewEvent = { type: string; ts: string; payload: any };

function latestPreviewEvent(db: DB, taskId: string): PreviewEvent | null {
  const r = db
    .query(
      `SELECT type, ts, payload FROM events
        WHERE task_id = ? AND type IN ('preview_started','preview_ready','preview_failed','preview_queued','preview_down')
        ORDER BY rowid DESC LIMIT 1`
    )
    .get(taskId) as { type: string; ts: string; payload: string } | undefined;
  if (!r) return null;
  let payload: any = {};
  try {
    payload = JSON.parse(r.payload ?? "{}");
  } catch {}
  return { type: r.type, ts: r.ts, payload };
}

const STATUS_OF: Record<string, PreviewStatus> = {
  preview_started: "building",
  preview_ready: "ready",
  preview_failed: "failed",
  preview_queued: "queued",
  preview_down: "idle",
};

// The deep link the agent named, from `hive emit ... ready --preview-path /x`
// (or `preview_path` in the handoff JSON). Latest one wins.
export function agentPreviewPath(db: DB, taskId: string): string | null {
  const r = db
    .query(
      `SELECT json_extract(payload, '$.preview_path') AS p FROM events
        WHERE task_id = ? AND json_extract(payload, '$.preview_path') IS NOT NULL
        ORDER BY rowid DESC LIMIT 1`
    )
    .get(taskId) as { p: string | null } | undefined;
  return r?.p ? normalizePath(r.p) || null : null;
}

// The whole preview story for one task, or null when its project never opted
// in — the card renders nothing at all in that case.
export function previewState(db: DB, task: any, config: any): PreviewState | null {
  const cfg = previewConfig(config);
  if (!cfg) return null;
  const event = latestPreviewEvent(db, task.id);
  const status: PreviewStatus =
    event && event.type === "preview_down" && event.payload?.reason === "idle"
      ? "expired"
      : (event && STATUS_OF[event.type]) || "idle";
  const path = agentPreviewPath(db, task.id);
  const urls =
    status === "ready" && Array.isArray(event?.payload?.urls)
      ? (event!.payload.urls as PreviewUrl[])
      : task.worktree_path
      ? previewUrls(cfg, task.worktree_path)
      : [];
  return {
    status,
    urls,
    login_hint: cfg.login_hint,
    preview_path: path,
    smoke_passed: typeof event?.payload?.smoke_passed === "number" ? event.payload.smoke_passed : null,
    smoke_failed: typeof event?.payload?.smoke_failed === "number" ? event.payload.smoke_failed : null,
    tail: status === "failed" ? String(event?.payload?.tail ?? "") || null : null,
    reason: event?.payload?.reason ? String(event.payload.reason) : null,
    at: event?.ts ?? null,
  };
}

// Every task whose stack is up or coming up, newest first. One row per task.
export function livePreviews(db: DB): { task_id: string; status: PreviewStatus; ts: string }[] {
  const rows = db
    .query(
      `SELECT e.task_id AS task_id, e.type AS type, e.ts AS ts FROM events e
        WHERE e.type IN ('preview_started','preview_ready','preview_failed','preview_queued','preview_down')
          AND e.rowid = (SELECT MAX(x.rowid) FROM events x WHERE x.task_id = e.task_id
                          AND x.type IN ('preview_started','preview_ready','preview_failed','preview_queued','preview_down'))
        ORDER BY e.rowid DESC`
    )
    .all() as { task_id: string; type: string; ts: string }[];
  return rows
    .map((r) => ({ task_id: r.task_id, status: STATUS_OF[r.type]!, ts: r.ts }))
    .filter((r) => LIVE.includes(r.status));
}

// ---------------------------------------------------------------- running

// In-process guard against two `up` runs racing on one task (the Preview button
// double-tapped, or the button pressed while the handoff trigger is in flight).
// The event log is the durable record; this only covers the in-flight window
// before the first event is written.
const running = new Set<string>();

type PreviewDeps = { exec?: Exec; now?: () => number };

function projectOf(db: DB, task: any): { repo_path: string | null; config: any } | null {
  const p: any = db.query("SELECT * FROM projects WHERE id = ?").get(task.project_id);
  if (!p) return null;
  let config: any = {};
  try {
    config = JSON.parse(p.config ?? "{}");
  } catch {}
  return { repo_path: p.repo_path ?? null, config };
}

function tail(text: string): string {
  return text.trim().split("\n").slice(-TAIL_LINES).join("\n").slice(0, 2000);
}

// wt.sh up ends with a smoke summary line: `== 3 passed, 0 failed ==`.
export function parseSmoke(output: string): { passed: number; failed: number } | null {
  const m = /==\s*(\d+)\s+passed,\s*(\d+)\s+failed\s*==/.exec(output);
  return m ? { passed: Number(m[1]), failed: Number(m[2]) } : null;
}

async function runPreviewCmd(
  argv: string[],
  worktreePath: string,
  exec: Exec,
  timeoutMs: number
): Promise<{ code: number; output: string }> {
  // Resolved against the WORKTREE, not the main checkout: the script has to see
  // the branch's own copy, and its cwd is what gives the stack its slug.
  const resolved = [resolveConfiguredCommand(worktreePath, argv[0]!), ...argv.slice(1)];
  const r = await exec(resolved, { cwd: worktreePath, timeoutMs });
  return { code: r.code, output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

export type StartResult = { ok: boolean; status: PreviewStatus; error?: string };

// Bring a task's preview stack up. Returns as soon as the decision is made
// (started / queued / refused); the `up` run itself continues in the background
// and writes preview_ready or preview_failed when it finishes.
export async function startPreview(db: DB, taskId: string, deps: PreviewDeps = {}): Promise<StartResult> {
  const task = getTask(db, taskId);
  if (!task) return { ok: false, status: "idle", error: "task not found" };
  const project = projectOf(db, task);
  const cfg = project ? previewConfig(project.config) : null;
  if (!cfg) return { ok: false, status: "idle", error: "this project has no preview config" };
  if (!task.worktree_path) return { ok: false, status: "idle", error: "task has no worktree to preview" };
  const current = previewState(db, task, project!.config)!;
  if (current.status === "building" || current.status === "ready") return { ok: true, status: current.status };
  if (running.has(taskId)) return { ok: true, status: "building" };

  // Cap check. Beyond it the request QUEUES rather than failing: the sweeper
  // starts it the moment a slot frees, and the card says it is waiting.
  const live = livePreviews(db).filter((p) => p.task_id !== taskId);
  if (live.length >= PREVIEW_CAP) {
    if (current.status !== "queued")
      writeEvent(db, {
        task_id: taskId,
        source: "hive",
        type: "preview_queued",
        payload: { reason: "cap", cap: PREVIEW_CAP, waiting_behind: live.length },
      });
    return { ok: true, status: "queued" };
  }

  running.add(taskId);
  const exec = deps.exec ?? defaultExec;
  const worktree = task.worktree_path as string;
  writeEvent(db, { task_id: taskId, source: "hive", type: "preview_started", payload: { argv: cfg.up, worktree } });
  broadcastTask(db, getTask(db, taskId));
  // Fire and forget: the caller (a button press, a review handoff) must not wait
  // out a multi-minute docker bring-up.
  void (async () => {
    try {
      const r = await runPreviewCmd(cfg.up, worktree, exec, UP_TIMEOUT_MS);
      const smoke = parseSmoke(r.output);
      if (r.code !== 0) {
        writeEvent(db, { task_id: taskId, source: "hive", type: "preview_failed", payload: { tail: tail(r.output), code: r.code } });
      } else {
        writeEvent(db, {
          task_id: taskId,
          source: "hive",
          type: "preview_ready",
          payload: {
            urls: previewUrls(cfg, worktree),
            ...(cfg.login_hint ? { login_hint: cfg.login_hint } : {}),
            smoke_passed: smoke?.passed ?? null,
            smoke_failed: smoke?.failed ?? null,
          },
        });
      }
    } catch (e: any) {
      writeEvent(db, { task_id: taskId, source: "hive", type: "preview_failed", payload: { tail: String(e?.message ?? e).slice(0, 2000) } });
    } finally {
      running.delete(taskId);
      broadcastTask(db, getTask(db, taskId));
    }
  })();
  return { ok: true, status: "building" };
}

// Tear a task's stack down. Safe to call on a task that never had one — a
// project with no preview config, or one whose latest event is already down,
// is a no-op, so every terminal path can call this unconditionally.
export async function stopPreview(db: DB, taskId: string, reason: string, deps: PreviewDeps = {}): Promise<boolean> {
  const task = getTask(db, taskId);
  if (!task) return false;
  const project = projectOf(db, task);
  const cfg = project ? previewConfig(project.config) : null;
  if (!cfg) return false;
  const event = latestPreviewEvent(db, taskId);
  const status = event ? STATUS_OF[event.type] : null;
  // `queued` never started a stack, so it just stops waiting. Anything already
  // down (or never up) needs nothing.
  if (!status || status === "idle") return false;
  const worktree = task.worktree_path as string | null;
  if (status === "queued" || !worktree) {
    writeEvent(db, { task_id: taskId, source: "hive", type: "preview_down", payload: { reason, ran: false } });
    broadcastTask(db, getTask(db, taskId));
    return true;
  }
  const r = await runPreviewCmd(cfg.down, worktree, deps.exec ?? defaultExec, DOWN_TIMEOUT_MS).catch((e: any) => ({
    code: 1,
    output: String(e?.message ?? e),
  }));
  // A failed `down` is still recorded as down. Leaving the task in `ready`
  // would keep a dead stack against the cap forever — the same mistake that
  // once left 256 orphaned containers nothing ever tore down.
  writeEvent(db, {
    task_id: taskId,
    source: "hive",
    type: "preview_down",
    payload: { reason, ran: true, ok: r.code === 0, ...(r.code === 0 ? {} : { tail: tail(r.output) }) },
  });
  broadcastTask(db, getTask(db, taskId));
  return true;
}

// ---------------------------------------------------------------- triggers

// Does this task's branch touch anything the project wants previewed? Cheap
// name-only diff in the task's own worktree; no `gh`, no network.
export async function previewTouchesPaths(
  db: DB,
  task: any,
  cfg: PreviewConfig,
  exec: Exec = defaultExec
): Promise<boolean> {
  if (!cfg.paths.length) return false;
  if (!task.worktree_path) return false;
  const project = projectOf(db, task);
  const base = projectComparisonBase(project?.config ?? {});
  const r = await exec(["git", "diff", "--name-only", `${base}...HEAD`], { cwd: task.worktree_path });
  if (r.code !== 0) return false;
  const files = r.stdout.split("\n").map((f) => f.trim()).filter(Boolean);
  return cfg.paths.some((pattern) => {
    const glob = new Bun.Glob(pattern);
    return files.some((f) => glob.match(f));
  });
}

// Trigger (a) from the brief: a task landing in review whose diff touches a
// previewed path brings its stack up on its own. Everything else is a no-op, so
// this is safe to call on every state change.
export async function autoPreviewOnHandoff(db: DB, taskId: string, deps: PreviewDeps = {}): Promise<boolean> {
  const task = getTask(db, taskId);
  if (!task || task.state !== "in_review") return false;
  const project = projectOf(db, task);
  const cfg = project ? previewConfig(project.config) : null;
  if (!cfg) return false;
  if (!(await previewTouchesPaths(db, task, cfg, deps.exec ?? defaultExec))) return false;
  const r = await startPreview(db, taskId, deps);
  return r.ok;
}

// The review window: while the task is in one of these the stack stays up.
const REVIEW_STATES = ["in_review", "verifying"];

// Every state change routes through here. Reaching review brings the stack up;
// leaving the review window for ANY other state takes it down. "Any other" is
// the point: a changes-requested review sends the task straight back to
// in_progress, and a stack left running there shows the pre-fix commit — and
// then blocks its own rebuild, because startPreview no-ops on an already-ready
// preview. Tearing down on the way out is what makes the next handoff rebuild.
export async function previewOnStateChange(db: DB, taskId: string, to: string, deps: PreviewDeps = {}): Promise<void> {
  if (to === "in_review") await autoPreviewOnHandoff(db, taskId, deps);
  else if (!REVIEW_STATES.includes(to)) await stopPreview(db, taskId, to, deps);
}

// ---------------------------------------------------------------- sweeper

// Newest director-sourced event on a task, which is what "the director looked
// at the card" reduces to: a note, a steer, an answer, a merge. There is no way
// to observe a URL being hit, so this is the interaction signal the brief names.
function lastDirectorTouch(db: DB, taskId: string, since: string): string | null {
  const r = db
    .query("SELECT MAX(ts) AS ts FROM events WHERE task_id = ? AND ts > ? AND source IN ('director','web','cli','')")
    .get(taskId, since) as { ts: string | null } | undefined;
  return r?.ts ?? null;
}

// Tears down every preview nobody has touched for PREVIEW_IDLE_MS, then starts
// as many queued previews as the freed slots allow. Runs on the reaper's sweep.
// `now` is injectable so the idle rule is testable without waiting four hours.
export async function sweepPreviews(db: DB, deps: PreviewDeps = {}): Promise<{ expired: string[]; started: string[] }> {
  const nowMs = (deps.now ?? Date.now)();
  const expired: string[] = [];
  for (const p of livePreviews(db)) {
    if (p.status !== "ready") continue;
    const touched = lastDirectorTouch(db, p.task_id, p.ts) ?? p.ts;
    if (nowMs - Date.parse(touched) < PREVIEW_IDLE_MS) continue;
    if (await stopPreview(db, p.task_id, "idle", deps)) expired.push(p.task_id);
  }
  // Queued requests, oldest first, into whatever room is left.
  const started: string[] = [];
  const waiting = db
    .query(
      `SELECT e.task_id AS task_id FROM events e
        WHERE e.type = 'preview_queued'
          AND e.rowid = (SELECT MAX(x.rowid) FROM events x WHERE x.task_id = e.task_id
                          AND x.type IN ('preview_started','preview_ready','preview_failed','preview_queued','preview_down'))
        ORDER BY e.rowid`
    )
    .all() as { task_id: string }[];
  for (const w of waiting) {
    if (livePreviews(db).length >= PREVIEW_CAP) break;
    const r = await startPreview(db, w.task_id, deps);
    if (r.status === "building") started.push(w.task_id);
  }
  return { expired, started };
}

// Exported for the note path: a note typed while a preview is open should carry
// which preview the director was looking at, so the agent reads the feedback
// with the same context the director had.
export function previewNoteContext(db: DB, task: any, config: any): string | null {
  const state = previewState(db, task, config);
  if (!state || state.status !== "ready" || !state.urls.length) return null;
  const primary = state.preview_path
    ? `${state.urls[0]!.url}${state.preview_path}`
    : state.urls[0]!.url;
  return `(seen on the preview stack: ${primary})`;
}
