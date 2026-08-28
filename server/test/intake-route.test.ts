import { test, expect } from "bun:test";
import { openDb } from "../src/db.ts";
import { newId, now } from "../src/db.ts";
import { makeHandler } from "../src/api.ts";
import { routeIntakeProject } from "../src/intake/route.ts";

function mkProject(db: any, name: string, opts: { repo_path?: string; keywords?: string[] } = {}): string {
  const id = newId("proj");
  db.query("INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)").run(
    id,
    name,
    opts.repo_path ?? null,
    JSON.stringify(opts.keywords ? { intake_keywords: opts.keywords } : {}),
    now()
  );
  return id;
}

// The bug: an acme braindump filed under hive. The fix must re-route it.
test("re-routes an acme braindump away from the requested hive project", () => {
  const db = openDb(":memory:");
  const hive = mkProject(db, "hive", { repo_path: "/Users/ada/projects/hive" });
  const acme = mkProject(db, "acme", {
    repo_path: "/Users/ada/projects/acme",
    keywords: ["coredata", "figma.com/file/CoreData"],
  });

  const text =
    "New homepage hero for the CoreData sharing flow — see https://figma.com/file/CoreData/CoreData-공유";
  const r = routeIntakeProject(db, text, hive); // requested = hive (the default)
  expect(r.project_id).toBe(acme);
  expect(r.rerouted).toBe(true);
  expect(r.matched.length).toBeGreaterThan(0);
});

test("keeps the requested project when text matches nothing", () => {
  const db = openDb(":memory:");
  const hive = mkProject(db, "hive");
  mkProject(db, "acme", { keywords: ["coredata"] });
  const r = routeIntakeProject(db, "refactor the scheduler retry backoff", hive);
  expect(r.project_id).toBe(hive);
  expect(r.rerouted).toBe(false);
});

test("keeps the requested project when it is the best match", () => {
  const db = openDb(":memory:");
  const hive = mkProject(db, "hive");
  mkProject(db, "acme", { keywords: ["coredata"] });
  const r = routeIntakeProject(db, "the hive dispatcher drops queued tasks", hive);
  expect(r.project_id).toBe(hive);
  expect(r.rerouted).toBe(false);
});

test("short project names only match on word boundaries", () => {
  const db = openDb(":memory:");
  const hive = mkProject(db, "hive");
  const acme = mkProject(db, "ux"); // must NOT match inside "flux"/"luxury"
  const r = routeIntakeProject(db, "improve the flux capacitor luxury settings", hive);
  expect(r.project_id).toBe(hive);
  expect(r.rerouted).toBe(false);
});

// End-to-end through POST /api/intake: the created task lands in acme and
// carries an audit note. Planner is stubbed so the test never spawns `claude`.
test("POST /api/intake files the braindump in the routed project", async () => {
  const db = openDb(":memory:");
  const hive = mkProject(db, "hive");
  const acme = mkProject(db, "acme", { keywords: ["coredata"] });
  const handler = makeHandler(db, { plannerExec: async () => ({ code: 0, stdout: "{}", stderr: "" }) });

  const res = await handler(
    new Request("http://x/api/intake", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: hive, text: "redesign the CoreData share sheet" }),
    })
  );
  const body: any = await res.json();
  expect(res.status).toBe(202);
  expect(body.task.project_id).toBe(acme);

  const note: any = db
    .query("SELECT payload FROM events WHERE task_id = ? AND type = 'note'")
    .get(body.task.id);
  expect(note).toBeTruthy();
  expect(JSON.parse(note.payload).note).toContain("auto-routed");
});

test("ambiguous tie keeps the requested project", () => {
  const db = openDb(":memory:");
  const hive = mkProject(db, "hive");
  mkProject(db, "alpha", { keywords: ["shared"] });
  mkProject(db, "beta", { keywords: ["shared"] });
  const r = routeIntakeProject(db, "the shared component", hive);
  expect(r.project_id).toBe(hive); // both alpha and beta match "shared" → ambiguous, keep caller's
  expect(r.rerouted).toBe(false);
});
