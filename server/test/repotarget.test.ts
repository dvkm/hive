import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "hive-repotarget-test-"));
process.env.HIVE_HOME = HOME;

const { openDb } = await import("../src/db.ts");
const { makeHandler } = await import("../src/api.ts");
const { extractPaths, repoMismatchUnresolved } = await import("../src/repoTarget.ts");

const db = openDb(":memory:");
const server = Bun.serve({ port: 0, fetch: makeHandler(db) });
const BASE = `http://127.0.0.1:${server.port}`;
afterAll(() => server.stop(true));

async function post(path: string, body: unknown) {
  const res = await fetch(BASE + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
}
async function get(path: string) {
  const res = await fetch(BASE + path);
  return { status: res.status, json: await res.json() };
}

// Two real repos on disk, so the check resolves against real files the way it
// does in production. `hive` owns server/src/intake/jira.ts (the incident's
// file); `acme` owns app/api/tickets.ts. Both carry a README.md, the
// shared-path case.
const mkRepo = (name: string, files: string[]) => {
  const root = mkdtempSync(join(tmpdir(), `hive-repotarget-${name}-`));
  for (const f of files) {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    writeFileSync(join(root, f), "x");
  }
  return root;
};

let hiveId = "";
let acmeId = "";
beforeAll(async () => {
  const hiveRepo = mkRepo("hive", ["server/src/intake/jira.ts", "server/src/api.ts", "README.md"]);
  const acmeRepo = mkRepo("acme", ["app/api/tickets.ts", "README.md"]);
  hiveId = (await post("/api/projects", { name: "hive", repo_path: hiveRepo })).json.id;
  acmeId = (await post("/api/projects", { name: "acme", repo_path: acmeRepo })).json.id;
});

// Distinct titles per case: similar titles trip the duplicate detector and put
// a second, unrelated card on the task.
const mkTask = async (title: string, brief?: string, project_id = acmeId) =>
  (await post("/api/tasks", { project_id, title, brief })).json;
const openCards = async (taskId: string) =>
  (await get(`/api/tasks/${taskId}`)).json.decisions.filter((d: any) => d.status === "open");
const mismatchCard = async (taskId: string) =>
  (await openCards(taskId)).find((d: any) => d.title.includes("Wrong target repo"));
const events = async (taskId: string) => (await get(`/api/tasks/${taskId}`)).json.events as any[];

// ---- extraction ----
test("extractPaths: only repo-relative paths with a source extension", () => {
  expect(extractPaths("edits server/src/intake/jira.ts in the HIVE repo")).toEqual(["server/src/intake/jira.ts"]);
  expect(extractPaths("see `web/src/lib/eventText.ts` and docs/spec.md.")).toEqual(["web/src/lib/eventText.ts", "docs/spec.md"]);
  // no slash, no extension, bare directory → not a path
  expect(extractPaths("update jira.ts and the server/src dir and the intake module")).toEqual([]);
  // absolute / home paths are not repo-relative
  expect(extractPaths("open /Users/you/projects/hive/server/src/api.ts or ~/projects/hive/README.md")).toEqual([]);
  // never resolve outside the repo
  expect(extractPaths("../other/thing.ts")).toEqual([]);
  expect(extractPaths(null)).toEqual([]);
});

// ---- the incident: hive paths, acme project ----
test("brief referencing only another project's files warns and names that project", async () => {
  const t = await mkTask("Add the Jira assignee marker", "Edit server/src/intake/jira.ts to add the assignee marker.");
  expect(t.warning).toContain("server/src/intake/jira.ts");
  expect(t.warning).toContain('"hive"');
  expect(t.warning).toContain('"acme"');

  const ev = (await events(t.id)).find((e) => e.type === "repo_mismatch");
  expect(ev).toBeTruthy();
  expect(ev.payload.likely_project_id).toBe(hiveId);
  expect(ev.payload.likely_project_name).toBe("hive");
  expect(ev.payload.paths).toEqual(["server/src/intake/jira.ts"]);

  const cards = await openCards(t.id);
  expect(cards.length).toBe(1);
  expect(cards[0].title).toContain("Wrong target repo?");
  expect(cards[0].options.map((o: any) => o.key).sort()).toEqual(["cancel", "keep"]);
  // the open card is what holds dispatch
  expect(repoMismatchUnresolved(db, t.id)).toBe(true);
  // never auto-switched
  expect((await get(`/api/tasks/${t.id}`)).json.project_id).toBe(acmeId);
});

// ---- paths in the chosen project ----
test("brief referencing the chosen project's own files produces no warning", async () => {
  const t = await mkTask("Show a ticket status column", "Add a status column in app/api/tickets.ts.");
  expect(t.warning).toBeUndefined();
  expect((await events(t.id)).some((e) => e.type === "repo_mismatch")).toBe(false);
  expect(await mismatchCard(t.id)).toBeUndefined();
  expect(repoMismatchUnresolved(db, t.id)).toBe(false);
});

// ---- no extractable paths (scout / report tasks) ----
test("brief with no extractable paths produces no warning", async () => {
  const t = await mkTask("Investigate the late weekly report", "Investigate why the weekly report is late and write up what you find.");
  expect(t.warning).toBeUndefined();
  expect(repoMismatchUnresolved(db, t.id)).toBe(false);

  const none = await mkTask("Draft the onboarding checklist");
  expect(none.warning).toBeUndefined();
  expect(repoMismatchUnresolved(db, none.id)).toBe(false);
});

// ---- mixed: any hit in the chosen project wins ----
test("brief referencing BOTH repos does not warn when one path is in the chosen project", async () => {
  const brief = "Mirror what server/src/intake/jira.ts does, over in app/api/tickets.ts.";
  // Both paths must actually be extracted, or this test would pass for the
  // wrong reason (extraction missing them is not the same as the mixed rule).
  expect(extractPaths(brief).sort()).toEqual(["app/api/tickets.ts", "server/src/intake/jira.ts"]);
  const t = await mkTask("Mirror the intake behaviour locally", brief);
  expect(t.warning).toBeUndefined();
  expect((await events(t.id)).some((e) => e.type === "repo_mismatch")).toBe(false);
  expect(repoMismatchUnresolved(db, t.id)).toBe(false);
});

// ---- paths that exist nowhere are new files, not a wrong repo ----
test("brief referencing files that exist in no project produces no warning", async () => {
  const t = await mkTask("Add a brand new handler endpoint", "Create app/api/brand-new-thing.ts with the new handler.");
  expect(t.warning).toBeUndefined();
  expect(repoMismatchUnresolved(db, t.id)).toBe(false);
});

// ---- answering the card releases (or cancels) the task ----
test("answering keep closes the card and releases dispatch; project is untouched", async () => {
  const t = await mkTask("Port the routing logic across", "Port the logic in server/src/api.ts here.");
  expect(t.warning).toBeTruthy();
  const card = await mismatchCard(t.id);
  await post(`/api/decisions/${card.id}/answer`, { answer_key: "keep" });
  expect(repoMismatchUnresolved(db, t.id)).toBe(false);
  const after = (await get(`/api/tasks/${t.id}`)).json;
  expect(after.state).toBe("queued");
  expect(after.project_id).toBe(acmeId);
});

test("answering cancel cancels the mis-filed task without moving it", async () => {
  const t = await mkTask("Rewrite intake from scratch", "Rewrite server/src/intake/jira.ts end to end.");
  const card = await mismatchCard(t.id);
  await post(`/api/decisions/${card.id}/answer`, { answer_key: "cancel" });
  const after = (await get(`/api/tasks/${t.id}`)).json;
  expect(after.state).toBe("cancelled");
  expect(after.project_id).toBe(acmeId);
  expect(repoMismatchUnresolved(db, t.id)).toBe(false);
});

// ---- tracking-only mirrors are never dispatched, so never carded ----
test("source=external tracking tasks are not checked", async () => {
  const t = (await post("/api/tasks", {
    project_id: acmeId,
    title: "external mirror",
    brief: "Edit server/src/intake/jira.ts.",
    source: "external",
  })).json;
  expect(t.warning).toBeUndefined();
  expect(await mismatchCard(t.id)).toBeUndefined();
});
