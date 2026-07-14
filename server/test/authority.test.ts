import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Evidence/brief storage in a throwaway dir before importing the modules.
const HOME = mkdtempSync(join(tmpdir(), "hive-authz-"));
process.env.HIVE_HOME = HOME;

const { openDb, newId, now } = await import("../src/db.ts");
const { authorize, resolveRule, patternMatches, resolveGrantForDecision, bootstrapAuthority } =
  await import("../src/authority.ts");
const { composeBrief } = await import("../src/briefs.ts");
const { makeHandler } = await import("../src/api.ts");
import type { DB } from "../src/db.ts";

function freshDb(): { db: DB; projectId: string; taskId: string } {
  const db = openDb(":memory:");
  const projectId = newId("proj");
  db.query("INSERT INTO projects (id, name, created_at) VALUES (?,?,?)").run(projectId, "p", now());
  const taskId = newId();
  const t = now();
  db.query(
    "INSERT INTO tasks (id, project_id, title, state, kind, created_at, updated_at) VALUES (?,?,?, 'in_progress', 'ship', ?, ?)"
  ).run(taskId, projectId, "Deploy the thing", t, t);
  return { db, projectId, taskId };
}

function addRule(db: DB, r: { project_id?: string | null; action_pattern: string; effect: string; note?: string; active?: number }) {
  const id = newId("aur");
  const project_id = r.project_id ?? null;
  db.query(
    "INSERT INTO authority_rules (id, project_id, scope, action_pattern, effect, note, active, created_at) VALUES (?,?,?,?,?,?,?,?)"
  ).run(id, project_id, project_id ? `project:${project_id}` : "global", r.action_pattern, r.effect, r.note ?? null, r.active ?? 1, now());
  return id;
}

// ---------------------------------------------------------------- matching / specificity
test("patternMatches: '*' is a wildcard, otherwise exact", () => {
  expect(patternMatches("deploy*", "deploy.prod")).toBe(true);
  expect(patternMatches("deploy.prod", "deploy.prod")).toBe(true);
  expect(patternMatches("deploy", "deploy.prod")).toBe(false); // exact, no implicit prefix
  expect(patternMatches("*", "anything.at.all")).toBe(true);
});

test("resolveRule: project beats global, longer pattern beats shorter, default is none", () => {
  const { db, projectId } = freshDb();
  addRule(db, { action_pattern: "deploy*", effect: "allow" }); // global broad
  const proj = addRule(db, { project_id: projectId, action_pattern: "deploy.prod", effect: "require_decision" });
  // project-specific wins over the broader global rule
  expect(resolveRule(db, projectId, "deploy.prod")!.id).toBe(proj);
  // a global-only action falls to the global allow
  expect(resolveRule(db, projectId, "deploy.staging")!.effect).toBe("allow");
  // unmatched action → no rule (caller defaults to allow)
  expect(resolveRule(db, projectId, "coffee.make")).toBeNull();

  // longer literal pattern wins within the same (global) scope
  const { db: db2, projectId: p2 } = freshDb();
  addRule(db2, { action_pattern: "deploy*", effect: "allow" });
  addRule(db2, { action_pattern: "deploy.prod*", effect: "deny" });
  expect(resolveRule(db2, p2, "deploy.prod")!.effect).toBe("deny");
});

// ---------------------------------------------------------------- allow / deny / require_decision
test("unmatched action defaults to allow and logs an authority_logged event", () => {
  const { db, taskId, projectId } = freshDb();
  const r = authorize(db, { project_id: projectId, action: "anything", target: "x", task_id: taskId });
  expect(r.effect).toBe("allow");
  const ev = db.query("SELECT * FROM events WHERE task_id = ? AND type = 'authority_logged'").all(taskId);
  expect(ev.length).toBe(1);
});

test("deny rule → deny + authority_denied event", () => {
  const { db, taskId, projectId } = freshDb();
  addRule(db, { project_id: projectId, action_pattern: "destroy*", effect: "deny", note: "never" });
  const r = authorize(db, { project_id: projectId, action: "destroy.db", target: "prod-db", task_id: taskId });
  expect(r.effect).toBe("deny");
  if (r.effect === "deny") expect(r.reason).toContain("never");
  expect(db.query("SELECT * FROM events WHERE task_id = ? AND type = 'authority_denied'").all(taskId).length).toBe(1);
});

test("require_decision opens ONE card naming the exact target and parks the task", () => {
  const { db, taskId, projectId } = freshDb();
  addRule(db, { project_id: projectId, action_pattern: "flag.prod*", effect: "require_decision" });
  const r = authorize(db, { project_id: projectId, action: "flag.prod", target: "insights-redesign on PROD", task_id: taskId });
  expect(r.effect).toBe("require_decision");
  const decisionId = r.effect === "require_decision" ? r.decision_id : "";
  const d: any = db.query("SELECT * FROM decisions WHERE id = ?").get(decisionId);
  expect(d.status).toBe("open");
  expect(d.blast_radius).toContain("insights-redesign on PROD");
  expect(JSON.parse(d.options).some((o: any) => o.key === "approve")).toBe(true);
  // task parked
  expect((db.query("SELECT state FROM tasks WHERE id = ?").get(taskId) as any).state).toBe("needs_decision");
  // a retry returns the SAME card, not a duplicate
  const r2 = authorize(db, { project_id: projectId, action: "flag.prod", target: "insights-redesign on PROD", task_id: taskId });
  expect(r2.effect === "require_decision" && r2.decision_id).toBe(decisionId);
  expect((db.query("SELECT COUNT(*) AS n FROM decisions WHERE task_id = ?").get(taskId) as any).n).toBe(1);
});

test("summary becomes the card title (truncated); detail stays in context", () => {
  const { db, taskId, projectId } = freshDb();
  addRule(db, { project_id: projectId, action_pattern: "command.dangerous*", effect: "require_decision" });
  const r = authorize(db, {
    project_id: projectId,
    action: "command.dangerous",
    target: "pkill -f 'vite --mode dev'; ...",
    task_id: taskId,
    detail: "command approval (dangerous): process kill",
    summary: "Kill the stale dev server so the port frees up for the e2e run",
  });
  const d: any = db.query("SELECT * FROM decisions WHERE id = ?").get(r.effect === "require_decision" ? r.decision_id : "");
  expect(d.title).toBe("Kill the stale dev server so the port frees up for the e2e run");
  expect(d.context).toContain("command approval (dangerous): process kill");
  expect(d.context).toContain("pkill -f");

  // long summaries truncate; missing summaries fall back to detail
  const r2 = authorize(db, {
    project_id: projectId, action: "command.dangerous", target: "x", task_id: taskId,
    detail: "command approval (dangerous): recursive/forced rm",
    summary: "A".repeat(200),
  });
  const d2: any = db.query("SELECT * FROM decisions WHERE id = ?").get(r2.effect === "require_decision" ? r2.decision_id : "");
  expect(d2.title.length).toBeLessThanOrEqual(110);
  expect(d2.title.endsWith("…")).toBe(true);
});

// ---------------------------------------------------------------- deny-safe defaults
test("command.dangerous requires a decision with NO rule in the db", () => {
  const { db, taskId, projectId } = freshDb();
  expect(resolveRule(db, projectId, "command.dangerous")).toBeNull(); // nothing seeded
  const r = authorize(db, { project_id: projectId, action: "command.dangerous", target: "rm -rf /", task_id: taskId });
  expect(r.effect).toBe("require_decision");
  const d: any = db.query("SELECT * FROM decisions WHERE id = ?").get(r.effect === "require_decision" ? r.decision_id : "");
  expect(d.blast_radius).toContain("rm -rf /");
  // sibling namespaces are untouched: an unknown command still default-allows
  const { db: db2, taskId: t2, projectId: p2 } = freshDb();
  expect(authorize(db2, { project_id: p2, action: "command", target: "frobnicate", task_id: t2 }).effect).toBe("allow");
});

test("an explicit rule still overrides the deny-safe default", () => {
  const { db, taskId, projectId } = freshDb();
  addRule(db, { action_pattern: "command.dangerous*", effect: "allow", note: "yolo" });
  expect(authorize(db, { project_id: projectId, action: "command.dangerous", target: "sudo rm", task_id: taskId }).effect).toBe("allow");
});

test("require_decision with no task to answer it fails closed (deny, no crash)", () => {
  const { db, projectId } = freshDb();
  const r = authorize(db, { project_id: projectId, action: "command.dangerous", target: "rm -rf /", task_id: null });
  expect(r.effect).toBe("deny");
});

test("bootstrapAuthority seeds the standing rules and is idempotent", () => {
  const { db, projectId } = freshDb();
  expect(bootstrapAuthority(db)).toBe(1);
  expect(bootstrapAuthority(db)).toBe(0); // second boot is a no-op
  const rule = resolveRule(db, projectId, "command.dangerous")!;
  expect(rule.effect).toBe("require_decision");
  expect(db.query("SELECT COUNT(*) AS n FROM authority_rules").get() as any).toMatchObject({ n: 1 });
});

// ---------------------------------------------------------------- grants: single-use + expiry
test("a granted grant lets exactly one action through (single-use)", () => {
  const { db, taskId, projectId } = freshDb();
  const future = new Date(Date.now() + 3600_000).toISOString();
  db.query(
    "INSERT INTO authority_grants (id, task_id, action, target, status, created_at, expires_at) VALUES (?,?,?,?, 'granted', ?, ?)"
  ).run(newId("agr"), taskId, "deploy.prod", "acme PROD", now(), future);
  const first = authorize(db, { project_id: projectId, action: "deploy.prod", target: "acme PROD", task_id: taskId });
  expect(first.effect === "allow" && first.via_grant).toBe(true);
  const second = authorize(db, { project_id: projectId, action: "deploy.prod", target: "acme PROD", task_id: taskId });
  // grant is spent → falls through to default allow (not via a grant)
  expect(second.effect === "allow" && !second.via_grant).toBe(true);
});

test("grant expiry respects the injected clock", () => {
  const { db, taskId, projectId } = freshDb();
  const expiresAt = new Date(Date.parse("2026-01-01T00:00:00.000Z")).toISOString();
  db.query(
    "INSERT INTO authority_grants (id, task_id, action, target, status, created_at, expires_at) VALUES (?,?,?,?, 'granted', ?, ?)"
  ).run(newId("agr"), taskId, "deploy.prod", "acme PROD", now(), expiresAt);
  const before = () => "2025-12-31T23:00:00.000Z";
  const after = () => "2026-01-01T01:00:00.000Z";
  // before expiry → grant valid
  const ok = authorize(db, { project_id: projectId, action: "deploy.prod", target: "acme PROD", task_id: taskId }, before);
  expect(ok.effect === "allow" && ok.via_grant).toBe(true);
  // re-arm a fresh grant, now test the expired path with the same expiry
  db.query(
    "INSERT INTO authority_grants (id, task_id, action, target, status, created_at, expires_at) VALUES (?,?,?,?, 'granted', ?, ?)"
  ).run(newId("agr"), taskId, "deploy.prod", "acme PROD", now(), expiresAt);
  const expired = authorize(db, { project_id: projectId, action: "deploy.prod", target: "acme PROD", task_id: taskId }, after);
  expect(expired.effect === "allow" && !expired.via_grant).toBe(true); // expired grant ignored
});

test("resolveGrantForDecision mints a 24h grant on approve, denies otherwise", () => {
  const { db, taskId, projectId } = freshDb();
  addRule(db, { project_id: projectId, action_pattern: "deploy.prod", effect: "require_decision" });
  const r = authorize(db, { project_id: projectId, action: "deploy.prod", target: "acme PROD", task_id: taskId });
  const decisionId = r.effect === "require_decision" ? r.decision_id : "";
  expect(resolveGrantForDecision(db, decisionId, "approve")).toBe(true);
  const g: any = db.query("SELECT * FROM authority_grants WHERE decision_id = ?").get(decisionId);
  expect(g.status).toBe("granted");
  expect(g.expires_at).toBeTruthy();

  // a deny answer marks the pending grant denied
  const { db: db2, taskId: t2, projectId: p2 } = freshDb();
  addRule(db2, { project_id: p2, action_pattern: "deploy.prod", effect: "require_decision" });
  const rr = authorize(db2, { project_id: p2, action: "deploy.prod", target: "x", task_id: t2 });
  const did = rr.effect === "require_decision" ? rr.decision_id : "";
  resolveGrantForDecision(db2, did, "deny");
  expect((db2.query("SELECT status FROM authority_grants WHERE decision_id = ?").get(did) as any).status).toBe("denied");
});

// ---------------------------------------------------------------- brief injection
test("brief injects the standing-authority section + guarded-action protocol", () => {
  const { db, taskId, projectId } = freshDb();
  addRule(db, { project_id: projectId, action_pattern: "deploy.prod", effect: "require_decision", note: "confirm exact target" });
  const brief = composeBrief(db, taskId);
  expect(brief).toContain("Standing authority");
  expect(brief).toContain("guarded-action");
  expect(brief).toContain("deploy.prod");
  expect(brief).toContain("require_decision");
});

// ---------------------------------------------------------------- HTTP round trip
const rt = openDb(":memory:");
const server = Bun.serve({ port: 0, fetch: makeHandler(rt) });
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

let projectId = "";
let taskId = "";
beforeAll(async () => {
  const p = await post("/api/projects", { name: "rt", repo_path: "/r" });
  projectId = p.json.id;
  const t = await post("/api/tasks", { project_id: projectId, title: "ship it" });
  taskId = t.json.id;
  await post(`/api/tasks/${taskId}/transition`, { to: "in_progress" });
});

test("authority rules CRUD over HTTP", async () => {
  const c = await post("/api/authority/rules", { project_id: projectId, action_pattern: "deploy.prod", effect: "require_decision", note: "prod" });
  expect(c.status).toBe(201);
  expect(c.json.scope).toBe(`project:${projectId}`);
  const list = await get(`/api/authority/rules?project_id=${projectId}`);
  expect(list.json.some((x: any) => x.id === c.json.id)).toBe(true);
  const upd = await fetch(`${BASE}/api/authority/rules/${c.json.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ active: false }) });
  expect((await upd.json()).active).toBe(false);
});

test("guarded-action: require_decision → approve → retry passes → single-use", async () => {
  // re-activate a prod rule (the CRUD test deactivated the first one)
  await post("/api/authority/rules", { project_id: projectId, action_pattern: "deploy.prod", effect: "require_decision" });

  const first = await post(`/api/tasks/${taskId}/guarded-action`, { action: "deploy.prod", target: "acme-web on PROD", detail: "Release v1.2.3 to PROD" });
  expect(first.status).toBe(409);
  const decisionId = first.json.decision_id;
  expect(decisionId).toBeTruthy();

  // retry before answering → same card, still 409
  const again = await post(`/api/tasks/${taskId}/guarded-action`, { action: "deploy.prod", target: "acme-web on PROD" });
  expect(again.status).toBe(409);
  expect(again.json.decision_id).toBe(decisionId);

  // approve the card
  const ans = await post(`/api/decisions/${decisionId}/answer`, { answer_key: "approve" });
  expect(ans.status).toBe(200);

  // retry now passes
  const pass = await post(`/api/tasks/${taskId}/guarded-action`, { action: "deploy.prod", target: "acme-web on PROD" });
  expect(pass.status).toBe(200);
  expect(pass.json.effect).toBe("allow");

  // grant is single-use → a further attempt opens a new card again
  const third = await post(`/api/tasks/${taskId}/guarded-action`, { action: "deploy.prod", target: "acme-web on PROD" });
  expect(third.status).toBe(409);
});

test("guarded-action: deny rule → 403, never passes", async () => {
  await post("/api/authority/rules", { project_id: projectId, action_pattern: "destroy*", effect: "deny", note: "no destructive ops" });
  const r = await post(`/api/tasks/${taskId}/guarded-action`, { action: "destroy.everything", target: "prod-db" });
  expect(r.status).toBe(403);
  expect(r.json.effect).toBe("deny");
});

// ---------------------------------------------------------------- approve_always
test("gated commands offer approve_always; answering it mints a standing project rule", () => {
  const { db, taskId, projectId } = freshDb();
  const input = { project_id: projectId, action: "command.dangerous.process-kill", target: "pkill -f 'vite --mode dev'", task_id: taskId };
  const r = authorize(db, input);
  expect(r.effect).toBe("require_decision");
  const decisionId = r.effect === "require_decision" ? r.decision_id : "";
  const d: any = db.query("SELECT * FROM decisions WHERE id = ?").get(decisionId);
  expect(JSON.parse(d.options).some((o: any) => o.key === "approve_always")).toBe(true);

  resolveGrantForDecision(db, decisionId, "approve_always");
  // the parked retry passes (single-use grant, same as plain approve)
  expect(authorize(db, input).effect).toBe("allow");
  // a DIFFERENT command in the same category now passes via the standing rule
  const other = authorize(db, { ...input, target: "pkill -f chrome" });
  expect(other.effect).toBe("allow");
  // the rule is project-scoped allow on the exact category action
  const rule: any = db.query("SELECT * FROM authority_rules WHERE action_pattern = ?").get("command.dangerous.process-kill");
  expect(rule.project_id).toBe(projectId);
  expect(rule.effect).toBe("allow");
  expect(db.query("SELECT * FROM events WHERE task_id = ? AND type = 'authority_rule_minted'").all(taskId).length).toBe(1);
});

test("approve_always is idempotent across two parked cards of the same category", () => {
  const { db, taskId, projectId } = freshDb();
  const base = { project_id: projectId, action: "command.dangerous.recursive-forced-rm", task_id: taskId };
  const r1 = authorize(db, { ...base, target: "rm -rf /srv/a" });
  const r2 = authorize(db, { ...base, target: "rm -rf /srv/b" }); // different target → its own card
  const d1 = r1.effect === "require_decision" ? r1.decision_id : "";
  const d2 = r2.effect === "require_decision" ? r2.decision_id : "";
  expect(d1).not.toBe(d2);
  resolveGrantForDecision(db, d1, "approve_always");
  resolveGrantForDecision(db, d2, "approve_always");
  const n = (db.query("SELECT COUNT(*) AS n FROM authority_rules WHERE action_pattern = ?").get("command.dangerous.recursive-forced-rm") as any).n;
  expect(n).toBe(1);
});

test("non-command actions do NOT offer approve_always", () => {
  const { db, taskId, projectId } = freshDb();
  addRule(db, { project_id: projectId, action_pattern: "deploy.prod*", effect: "require_decision" });
  const r = authorize(db, { project_id: projectId, action: "deploy.prod", target: "acme-web", task_id: taskId });
  const decisionId = r.effect === "require_decision" ? r.decision_id : "";
  const d: any = db.query("SELECT * FROM decisions WHERE id = ?").get(decisionId);
  expect(JSON.parse(d.options).some((o: any) => o.key === "approve_always")).toBe(false);
});

test("plain approve never mints a rule (single-use only)", () => {
  const { db, taskId, projectId } = freshDb();
  const input = { project_id: projectId, action: "command.dangerous.process-kill", target: "pkill -f x", task_id: taskId };
  const r = authorize(db, input);
  resolveGrantForDecision(db, r.effect === "require_decision" ? r.decision_id : "", "approve");
  expect(authorize(db, input).effect).toBe("allow"); // grant consumed
  const again = authorize(db, input); // same command again → cards again
  expect(again.effect).toBe("require_decision");
  expect(db.query("SELECT COUNT(*) AS n FROM authority_rules").get() as any).toEqual({ n: 0 });
});
