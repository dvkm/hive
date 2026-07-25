// Per-project URL monitors + post-deploy smoke checks.
//
// Monitors: from project.config.monitors = [{name,url,expect_status,
// expect_substring?,interval_s}]. A failed check opens an incident (once per
// monitor) + SSE + macOS notification; recovery resolves it. Auto-task creation
// is behind config.monitors_auto_task.
//
// Smoke: project.config.smoke = [{name,url,expect_status,expect_substring?}].
// On a task entering `verifying` the list runs once: pass -> a test_run evidence
// row; fail -> the task bounces back to in_progress.
import type { DB } from "./db.ts";
import { newId, now, evidenceDir, isOffline } from "./db.ts";
import { broadcast } from "./bus.ts";
import { writeEvent, transition, getTask } from "./state.ts";
import { recordSystemLearning } from "./learn.ts";
import { parseIncident, parseProject } from "./rows.ts";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import type { Exec } from "./exec.ts";
import { defaultExec } from "./exec.ts";
import { enqueue } from "./notifications.ts";

export type Fetcher = (url: string, timeoutMs?: number) => Promise<{ status: number; body: string }>;

export interface Check {
  name: string;
  url: string;
  expect_status?: number;
  expect_substring?: string;
  interval_s?: number;
}

export interface MonitorDeps {
  fetch?: Fetcher;
  exec?: Exec; // for osascript notifications
  notify?: boolean; // default true; disabled in tests
}

const DEFAULT_FETCH_TIMEOUT_MS = 15_000;

// Bounded (task #641): a stalled or unreachable smoke/monitor URL used to hang
// this fetch forever — for smoke checks that wedges the merge request itself,
// since POST /merge awaits smokeThenAdvance synchronously before responding.
// Same shape as the exec() timeout fix (task #621) for this separate,
// previously-unbounded await path.
export const defaultFetcher: Fetcher = async (url, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS) => {
  const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
  return { status: res.status, body: await res.text() };
};

// Run one check. Never throws; a network error is a failure with detail.
export async function runCheck(check: Check, fetcher: Fetcher = defaultFetcher): Promise<{ ok: boolean; detail: string }> {
  const wantStatus = check.expect_status ?? 200;
  try {
    const { status, body } = await fetcher(check.url);
    if (status !== wantStatus)
      return { ok: false, detail: `expected status ${wantStatus}, got ${status}` };
    if (check.expect_substring && !body.includes(check.expect_substring))
      return { ok: false, detail: `missing expected substring "${check.expect_substring}"` };
    return { ok: true, detail: `status ${status}` };
  } catch (e: any) {
    return { ok: false, detail: `request failed: ${e?.message ?? e}` };
  }
}

function openIncident(db: DB, projectId: string, monitor: string): any | null {
  return db
    .query("SELECT * FROM incidents WHERE project_id = ? AND monitor = ? AND status = 'open' ORDER BY ts DESC LIMIT 1")
    .get(projectId, monitor);
}

// Check every monitor for one project and reconcile incidents. Returns the list
// of incidents it touched (opened or resolved) so callers/tests can assert.
export async function checkProjectMonitors(
  db: DB,
  project: { id: string; config: any },
  deps: MonitorDeps = {}
): Promise<any[]> {
  const fetcher = deps.fetch ?? defaultFetcher;
  const exec = deps.exec ?? defaultExec;
  const notify = deps.notify ?? true;
  const monitors: Check[] = project.config?.monitors ?? [];
  const autoTask = !!project.config?.monitors_auto_task;
  const touched: any[] = [];

  for (const mon of monitors) {
    const result = await runCheck(mon, fetcher);
    const existing = openIncident(db, project.id, mon.name);

    if (!result.ok && !existing) {
      const row = {
        id: newId("inc"),
        project_id: project.id,
        monitor: mon.name,
        ts: now(),
        status: "open",
        detail: result.detail,
      };
      db.query(
        "INSERT INTO incidents (id, project_id, monitor, ts, status, detail) VALUES (?,?,?,?,?,?)"
      ).run(row.id, row.project_id, row.monitor, row.ts, row.status, row.detail);
      const incident = parseIncident(row);
      broadcast({ type: "incident", incident });
      touched.push(incident);
      // Incidents are urgent: push immediately (osascript via enqueue).
      if (notify)
        enqueue(db, { kind: "incident", title: `Monitor down: ${mon.name}`, body: result.detail, urgency: "urgent" }, { exec });
      if (autoTask) createIncidentTask(db, project.id, mon, result.detail);
    } else if (result.ok && existing) {
      db.query("UPDATE incidents SET status = 'resolved' WHERE id = ?").run(existing.id);
      const incident = parseIncident({ ...existing, status: "resolved" });
      broadcast({ type: "incident", incident });
      touched.push(incident);
    }
  }
  return touched;
}

// Auto-create a chore task for an open incident (config flag). Direct insert to
// avoid coupling to the HTTP layer; mirrors createTask's row + created event.
function createIncidentTask(db: DB, projectId: string, mon: Check, detail: string): void {
  const t = now();
  const id = newId();
  const title = `Monitor down: ${mon.name}`;
  const brief = `Automated: monitor "${mon.name}" (${mon.url}) failed.\n\n${detail}\n\nInvestigate and restore service.`;
  db.query(
    `INSERT INTO tasks (id, project_id, title, brief, state, kind, created_at, updated_at)
     VALUES (?,?,?,?, 'queued', 'chore', ?, ?)`
  ).run(id, projectId, title, brief, t, t);
  writeEvent(db, { task_id: id, source: "monitor", type: "created", payload: { title, monitor: mon.name } });
  broadcast({ type: "task", task: getTask(db, id) });
}

// Run all projects' monitors once. Isolated per project so one bad config can't
// stop the rest.
export async function checkAllMonitors(db: DB, deps: MonitorDeps = {}): Promise<void> {
  if (isOffline(db)) return; // offline mode: every URL check would false-alarm
  const projects = db.query("SELECT * FROM projects").all().map(parseProject);
  for (const p of projects) {
    try {
      await checkProjectMonitors(db, p, deps);
    } catch (e) {
      console.error(`[hive] monitor check failed for project ${p.id}:`, e);
    }
  }
}

// -------------------------------------------------------------- post-deploy smoke
// Run the project's smoke list once for a task that just entered `verifying`.
// pass -> test_run evidence (with results JSON); fail -> back to in_progress.
export async function runSmoke(db: DB, taskId: string, deps: MonitorDeps = {}): Promise<{ ran: boolean; passed: boolean }> {
  const task = getTask(db, taskId);
  if (!task) return { ran: false, passed: false };
  const project: any = db.query("SELECT * FROM projects WHERE id = ?").get(task.project_id);
  const config = JSON.parse(project?.config ?? "{}");
  const smoke: Check[] = config.smoke ?? [];
  if (smoke.length === 0) return { ran: false, passed: false };

  const fetcher = deps.fetch ?? defaultFetcher;
  const results: { name: string; ok: boolean; detail: string }[] = [];
  for (const check of smoke) {
    const r = await runCheck(check, fetcher);
    results.push({ name: check.name, ok: r.ok, detail: r.detail });
  }
  const passed = results.every((r) => r.ok);

  if (passed) {
    // Write a test_run evidence row with the results JSON.
    const id = newId("ev");
    const meta = JSON.stringify({ results });
    const summary = `smoke ${results.length}/${results.length} passing`;
    const destDir = join(evidenceDir(), taskId);
    mkdirSync(destDir, { recursive: true });
    const fileName = `smoke_${Date.now()}.json`;
    const path = join(destDir, fileName);
    Bun.write(path, JSON.stringify({ results }, null, 2));
    db.query(
      "INSERT INTO evidence (id, task_id, ts, kind, path, url, caption, meta) VALUES (?,?,?,?,?,?,?,?)"
    ).run(id, taskId, now(), "test_run", path, `/evidence/${taskId}/${fileName}`, summary, meta);
    broadcast({ type: "evidence", evidence: { id, task_id: taskId, kind: "test_run", url: `/evidence/${taskId}/${fileName}`, caption: summary, meta: { results } } });
    writeEvent(db, { task_id: taskId, source: "system", type: "smoke_passed", payload: { evidence_id: id, results } });
  } else {
    writeEvent(db, { task_id: taskId, source: "system", type: "smoke_failed", payload: { results } });
    recordSystemLearning(
      db,
      task.project_id,
      `post-merge smoke failed: ${results.filter((r) => !r.ok).map((r) => r.name).join(", ")}`,
      results.filter((r) => !r.ok).map((r) => `${r.name}: ${r.detail}`).join("\n"),
      taskId
    );
    // bounce back so the agent can fix it (verifying -> in_progress is a legal edge)
    if (task.state === "verifying")
      transition(db, taskId, "in_progress", { source: "system", reason: "post-deploy smoke failed" });
  }
  return { ran: true, passed };
}

// runSmoke + auto-advance: a verifying task with passing smoke — or with NO
// smoke configured (nothing to wait for; the merge + CI was the verification)
// — moves to done without a manual click. Before this, verifying was a dead
// end (merged corebeat tasks parked forever, pinning dispatcher slots,
// 2026-07-10). The done transition still enforces evidence; a task without any
// stays verifying for the director rather than sneaking through.
export async function smokeThenAdvance(db: DB, taskId: string, deps: MonitorDeps = {}): Promise<{ ran: boolean; passed: boolean }> {
  const r = await runSmoke(db, taskId, deps);
  const task = getTask(db, taskId);
  if (task?.state === "verifying" && (r.passed || !r.ran)) {
    try {
      transition(db, taskId, "done", {
        source: "system",
        reason: r.ran ? "post-merge smoke passed" : "merged; no smoke checks configured",
      });
    } catch {
      /* e.g. no evidence attached — stays verifying for the director */
    }
  }
  return r;
}
