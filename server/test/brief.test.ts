import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "hive-brief-test-"));
process.env.HIVE_HOME = HOME;

const { openDb, newId, now } = await import("../src/db.ts");
const { makeHandler } = await import("../src/api.ts");

const db = openDb(":memory:");
const server = Bun.serve({ port: 0, fetch: makeHandler(db) });
const BASE = `http://127.0.0.1:${server.port}`;
afterAll(() => server.stop(true));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function post(path: string, body: unknown) {
  const res = await fetch(BASE + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
}
async function get(path: string) {
  const res = await fetch(BASE + path);
  return { status: res.status, json: await res.json() };
}
function addEvidence(taskId: string) {
  db.query("INSERT INTO evidence (id, task_id, ts, kind, path, url, caption, meta) VALUES (?,?,?,?,?,?,?, '{}')")
    .run(newId("ev"), taskId, now(), "screenshot", null, "/x.png", "shot");
}

let projectId = "";
let doneOld = "";
let doneNew = "";
let failedId = "";
let fleetId = "";
let cutoff = "";

beforeAll(async () => {
  projectId = (await post("/api/projects", { name: "brief-proj", repo_path: "/tmp/x" })).json.id;

  // ---- an OLD done task (before the cutoff) ----
  doneOld = (await post("/api/tasks", { project_id: projectId, title: "Old shipped task" })).json.id;
  await post(`/api/tasks/${doneOld}/transition`, { to: "in_progress" });
  await post(`/api/tasks/${doneOld}/transition`, { to: "in_review" });
  await post(`/api/tasks/${doneOld}/transition`, { to: "verifying" });
  addEvidence(doneOld);
  await post(`/api/tasks/${doneOld}/events`, { type: "done", note: "old summary" });

  // ---- a failed task awaiting triage ----
  failedId = (await post("/api/tasks", { project_id: projectId, title: "Broken task" })).json.id;
  await post(`/api/tasks/${failedId}/transition`, { to: "in_progress" });
  await post(`/api/tasks/${failedId}/transition`, { to: "failed", reason: "blew up" });

  // ---- a live healthy agent (fleet), plus a stuck one (attention) ----
  fleetId = (await post("/api/tasks", { project_id: projectId, title: "Live agent task" })).json.id;
  await post(`/api/tasks/${fleetId}/transition`, { to: "in_progress" });
  db.query("UPDATE tasks SET agent_target = 'sess:1' WHERE id = ?").run(fleetId);
  await post(`/api/tasks/${fleetId}/events`, { type: "status", note: "working" });

  const stuck = (await post("/api/tasks", { project_id: projectId, title: "Stuck agent task" })).json.id;
  await post(`/api/tasks/${stuck}/transition`, { to: "in_progress" });
  db.query("UPDATE tasks SET agent_target = 'sess:2' WHERE id = ?").run(stuck);
  db.query("INSERT INTO events (id, task_id, ts, source, type, payload) VALUES (?,?,?,?,?,?)")
    .run(newId(), stuck, now(), "reconciler", "agent_status", JSON.stringify({ status: "blocked" }));

  // ---- an open decision (the action item) ----
  await post("/api/decisions", {
    task_id: fleetId, title: "Ship prod now?", context: "ready", risk: "high",
    blast_radius: "acme-prod-db", options: [{ key: "yes", label: "Yes", recommended: true }, { key: "no", label: "No" }],
  });

  // ---- unreviewed + reviewed intake tasks ----
  const intakeUnrev = newId();
  db.query("INSERT INTO tasks (id, project_id, title, state, kind, source, source_ref, created_at, updated_at) VALUES (?,?,?, 'queued','ship','intake_gchat', ?, ?, ?)")
    .run(intakeUnrev, projectId, "[intake:gchat] please add X", "spaces/1/msg1", now(), now());
  db.query("INSERT INTO events (id, task_id, ts, source, type, payload) VALUES (?,?,?,?,?,?)")
    .run(newId(), intakeUnrev, now(), "system", "note", JSON.stringify({ note: "UNREVIEWED external message" }));
  const intakeRev = newId();
  db.query("INSERT INTO tasks (id, project_id, title, state, kind, source, source_ref, created_at, updated_at) VALUES (?,?,?, 'queued','ship','intake_gchat', ?, ?, ?)")
    .run(intakeRev, projectId, "[intake:gchat] already triaged", "spaces/1/msg2", now(), now());
  db.query("INSERT INTO events (id, task_id, ts, source, type, payload) VALUES (?,?,?,?,?,?)")
    .run(newId(), intakeRev, now(), "director", "reviewed", "{}");

  // ---- OLD usage / incident / learning (before cutoff) ----
  db.query("INSERT INTO usage (id, task_id, ts, model, input_tokens, output_tokens, cache_read_tokens, cost_usd, source) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(newId("use"), doneOld, now(), "claude-sonnet-4-5", 1000, 200, 0, 0.01, "agent");
  db.query("INSERT INTO incidents (id, project_id, monitor, ts, status, detail) VALUES (?,?,?,?,?,?)")
    .run(newId("inc"), projectId, "old-monitor", now(), "resolved", "recovered");
  db.query("INSERT INTO learnings (id, project_id, title, body, occurrences, first_seen, last_seen, status) VALUES (?,?,?,?,?,?,?,?)")
    .run(newId("lrn"), projectId, "Old learning", null, 1, now(), now(), "active");

  // ---- CUTOFF ----
  await sleep(10);
  cutoff = new Date().toISOString();
  await sleep(10);

  // ---- NEW done task + usage + incident + learning (after cutoff) ----
  doneNew = (await post("/api/tasks", { project_id: projectId, title: "New shipped task" })).json.id;
  await post(`/api/tasks/${doneNew}/transition`, { to: "in_progress" });
  await post(`/api/tasks/${doneNew}/transition`, { to: "in_review" });
  await post(`/api/tasks/${doneNew}/transition`, { to: "verifying" });
  addEvidence(doneNew);
  addEvidence(doneNew);
  await post(`/api/tasks/${doneNew}/events`, { type: "done", note: "new summary" });

  db.query("INSERT INTO usage (id, task_id, ts, model, input_tokens, output_tokens, cache_read_tokens, cost_usd, source) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(newId("use"), doneNew, now(), "claude-opus-4-1", 5000, 900, 100, 0.5, "agent");
  db.query("INSERT INTO incidents (id, project_id, monitor, ts, status, detail) VALUES (?,?,?,?,?,?)")
    .run(newId("inc"), projectId, "homepage", now(), "open", "got 503");
  db.query("INSERT INTO learnings (id, project_id, title, body, occurrences, first_seen, last_seen, status) VALUES (?,?,?,?,?,?,?,?)")
    .run(newId("lrn"), projectId, "New learning", null, 2, now(), now(), "active");
});

test("brief composes every section from existing data", async () => {
  const { status, json } = await get("/api/brief");
  expect(status).toBe(200);

  // done: both done tasks, with evidence count + summary
  const dn = json.done.find((d: any) => d.id === doneNew);
  expect(dn).toBeTruthy();
  expect(dn.summary).toBe("new summary");
  expect(dn.evidence_count).toBe(2);
  expect(dn.project_name).toBe("brief-proj");
  expect(json.done.some((d: any) => d.id === doneOld)).toBe(true);

  // failed_or_attention: the failed task + the stuck live agent, NOT the healthy one
  expect(json.failed_or_attention.some((t: any) => t.id === failedId)).toBe(true);
  expect(json.failed_or_attention.some((t: any) => t.health?.status === "stuck")).toBe(true);
  expect(json.failed_or_attention.some((t: any) => t.id === fleetId)).toBe(false);

  // decisions: the open card, full object with options
  expect(json.decisions.length).toBe(1);
  expect(json.decisions[0].title).toBe("Ship prod now?");
  expect(json.decisions[0].options.length).toBe(2);

  // fleet: the live healthy agent, with computed health
  const live = json.fleet.find((t: any) => t.id === fleetId);
  expect(live).toBeTruthy();
  expect(live.health?.status).toBe("healthy");

  // incidents: both
  expect(json.incidents.some((i: any) => i.monitor === "homepage")).toBe(true);
  expect(json.incidents.some((i: any) => i.monitor === "old-monitor")).toBe(true);
  expect(json.incidents[0].project_name).toBe("brief-proj");

  // intake: only the unreviewed one
  expect(json.intake.length).toBe(1);
  expect(json.intake[0].title).toBe("[intake:gchat] please add X");

  // spend: totals over all usage + top model
  expect(json.spend.totals.calls).toBe(2);
  expect(json.spend.by_model[0].model).toBe("claude-opus-4-1"); // most expensive first

  // learnings: both
  expect(json.learnings_new.length).toBe(2);
  expect(json.learnings_new[0].project_name).toBe("brief-proj");
});

test("since window scopes the 'what changed' sections but not action-state ones", async () => {
  const { json } = await get(`/api/brief?since=${encodeURIComponent(cutoff)}`);

  // windowed sections drop the old rows
  expect(json.done.some((d: any) => d.id === doneNew)).toBe(true);
  expect(json.done.some((d: any) => d.id === doneOld)).toBe(false);
  expect(json.incidents.every((i: any) => i.monitor !== "old-monitor")).toBe(true);
  expect(json.incidents.some((i: any) => i.monitor === "homepage")).toBe(true);
  expect(json.learnings_new.length).toBe(1);
  expect(json.learnings_new[0].title).toBe("New learning");

  // spend only counts the post-cutoff call
  expect(json.spend.totals.calls).toBe(1);
  expect(json.spend.by_model.length).toBe(1);
  expect(json.spend.by_model[0].model).toBe("claude-opus-4-1");

  // action-state sections are unchanged by the window
  expect(json.decisions.length).toBe(1);
  expect(json.failed_or_attention.some((t: any) => t.id === failedId)).toBe(true);
  expect(json.fleet.some((t: any) => t.id === fleetId)).toBe(true);
  expect(json.intake.length).toBe(1);
});

test("empty brief on a fresh DB has all sections empty", async () => {
  const fresh = openDb(":memory:");
  const srv = Bun.serve({ port: 0, fetch: makeHandler(fresh) });
  try {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/brief`);
    const json = await res.json();
    expect(json.done).toEqual([]);
    expect(json.failed_or_attention).toEqual([]);
    expect(json.decisions).toEqual([]);
    expect(json.fleet).toEqual([]);
    expect(json.incidents).toEqual([]);
    expect(json.intake).toEqual([]);
    expect(json.learnings_new).toEqual([]);
    expect(json.spend.totals.calls).toBe(0);
    expect(json.spend.by_model).toEqual([]);
  } finally {
    srv.stop(true);
  }
});
