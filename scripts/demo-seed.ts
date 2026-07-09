// Seed a reviewable board: one project, a task in every state, an open decision
// with options + recommendation + risk/blast radius, and evidence images.
// Writes directly to the DB (this is a dev script; the daemon is normally the
// only writer). Run: bun run scripts/demo-seed.ts   [--reset]
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { openDb, newId, now, evidenceDir } from "../server/src/db.ts";
import { transition, writeEvent } from "../server/src/state.ts";
import { createDecision } from "../server/src/api.ts";

// Two tiny 1x1 PNG placeholders (red, blue) so the evidence gallery renders.
const PNG_RED =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG_BLUE =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const db = openDb();

if (process.argv.includes("--reset")) {
  for (const t of ["events", "evidence", "decisions", "policies", "incidents", "tasks", "projects"])
    db.exec(`DELETE FROM ${t}`);
}

function insertTask(projectId: string, title: string, kind = "ship", brief = "") {
  const id = newId();
  const t = now();
  db.query(
    `INSERT INTO tasks (id, project_id, title, brief, state, kind, created_at, updated_at)
     VALUES (?,?,?,?,'queued',?,?,?)`
  ).run(id, projectId, title, brief, kind, t, t);
  writeEvent(db, { task_id: id, source: "director", type: "created", payload: { title } });
  return id;
}

function addEvidence(taskId: string, kind: string, filename: string, b64: string, caption: string) {
  const destDir = join(evidenceDir(), taskId);
  mkdirSync(destDir, { recursive: true });
  const dest = join(destDir, filename);
  Bun.write(dest, Buffer.from(b64, "base64"));
  const id = newId("ev");
  db.query(
    "INSERT INTO evidence (id, task_id, ts, kind, path, url, caption, meta) VALUES (?,?,?,?,?,?,?, '{}')"
  ).run(id, taskId, now(), kind, dest, `/evidence/${taskId}/${filename}`, caption);
  writeEvent(db, { task_id: taskId, source: "agent", type: "evidence", payload: { evidence_id: id, kind, caption } });
}

// ---- project ----
const projectId = newId("proj");
db.query(
  "INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)"
).run(
  projectId,
  "acme-web",
  "/Users/david/code/acme-web",
  JSON.stringify({
    default_branch: "main",
    deploy_notes: "Vercel prod deploy on merge to main.",
    monitors: [{ name: "homepage", url: "https://acme.example.com", expect_status: 200, interval_s: 60 }],
  }),
  now()
);

// ---- policies ----
for (const p of [
  { scope: "global", title: "Always write tests", body: "Every code change ships with tests. No exceptions for logic changes." },
  { scope: "global", title: "No em-dashes", body: "Prose uses commas and periods, never em-dashes." },
  { scope: `project:${projectId}`, title: "Prod deploys need a decision card", body: "Never deploy acme-web to prod without an approved decision naming the exact target." },
]) {
  const t = now();
  db.query(
    "INSERT INTO policies (id, scope, title, body, active, created_at, updated_at) VALUES (?,?,?,?,1,?,?)"
  ).run(newId("pol"), p.scope, p.title, p.body, t, t);
}

// ---- one task per state ----
// queued
insertTask(projectId, "Add password reset flow", "ship", "Users need to reset forgotten passwords via email link.");

// in_progress
const inProg = insertTask(projectId, "Refactor auth middleware", "chore", "Consolidate duplicate auth checks into one middleware.");
transition(db, inProg, "in_progress", { source: "herdr" });
writeEvent(db, { task_id: inProg, source: "agent", type: "status", payload: { note: "Mapped the 3 duplicate checks; extracting now." } });

// needs_decision (full decision card)
const needsDec = insertTask(projectId, "Upgrade database to Postgres 16", "ship", "Move from PG14 to PG16 for logical replication.");
transition(db, needsDec, "in_progress", { source: "herdr" });
createDecision(db, {
  task_id: needsDec,
  title: "Upgrade prod DB now or stage first?",
  context: "PG16 upgrade is ready in staging and green. Prod upgrade requires a ~2 min write freeze.",
  risk: "high",
  blast_radius: "Production database acme-prod-db. Reversible via PITR snapshot taken pre-upgrade. Names exact target: acme-prod-db (us-east-1).",
  options: [
    { key: "stage", label: "Run in staging one more week", detail: "Safest. Delays logical replication work by a week.", recommended: true },
    { key: "prod_now", label: "Upgrade prod tonight in the 2am window", detail: "Unblocks replication now. 2 min write freeze, PITR snapshot first." },
    { key: "abort", label: "Abort the upgrade", detail: "Stay on PG14. Lose logical replication capability." },
  ],
});

// in_review
const inReview = insertTask(projectId, "Add rate limiting to API", "ship", "Add token-bucket rate limiting to public endpoints.");
transition(db, inReview, "in_progress", { source: "herdr" });
transition(db, inReview, "in_review", { source: "hook" });
db.query("UPDATE tasks SET pr_url = ?, ci_status = ? WHERE id = ?").run(
  "https://github.com/acme/web/pull/412", "passing", inReview
);
addEvidence(inReview, "screenshot", "ratelimit.png", PNG_RED, "Rate limit headers in response");

// verifying
const verifying = insertTask(projectId, "Fix checkout total rounding bug", "ship", "Totals off by a cent on multi-item carts.");
transition(db, verifying, "in_progress", { source: "herdr" });
transition(db, verifying, "in_review", { source: "hook" });
transition(db, verifying, "verifying", { source: "hook" });
db.query("UPDATE tasks SET pr_url = ?, ci_status = ? WHERE id = ?").run(
  "https://github.com/acme/web/pull/410", "passing", verifying
);

// done (needs evidence first)
const doneTask = insertTask(projectId, "Add dark mode toggle", "ship", "User-facing dark mode toggle in settings.");
transition(db, doneTask, "in_progress", { source: "herdr" });
transition(db, doneTask, "in_review", { source: "hook" });
transition(db, doneTask, "verifying", { source: "hook" });
addEvidence(doneTask, "screenshot", "darkmode.png", PNG_BLUE, "Dark mode enabled on settings page");
addEvidence(doneTask, "test_run", "tests.png", PNG_RED, "42 passing, 0 failing");
db.query("UPDATE tasks SET summary = ? WHERE id = ?").run("Shipped dark mode toggle; all tests green.", doneTask);
transition(db, doneTask, "done", { source: "director", reason: "verified" });

// failed
const failed = insertTask(projectId, "Migrate to new email provider", "ship", "Swap SendGrid for Postmark.");
transition(db, failed, "in_progress", { source: "herdr" });
transition(db, failed, "failed", { source: "agent", reason: "Postmark account not provisioned; blocked on billing." });

// cancelled
const cancelled = insertTask(projectId, "Rewrite everything in Rust", "scout", "Investigate a full rewrite.");
transition(db, cancelled, "cancelled", { source: "director", reason: "Out of scope for this quarter." });

// a scout in progress with a report, for variety
const scout = insertTask(projectId, "Research CDN options", "scout", "Compare Cloudflare vs Fastly for our traffic.");
transition(db, scout, "in_progress", { source: "herdr" });
addEvidence(scout, "report", "cdn-report.png", PNG_BLUE, "CDN comparison report");

console.log(`Seeded project ${projectId} with tasks in every state, 3 policies, 1 open decision, and evidence images.`);
console.log(`DB: ${process.env.HIVE_DB || "~/.hive/hive.db"}`);
