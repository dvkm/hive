import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "hive-dedup-test-"));
process.env.HIVE_HOME = HOME;

const { openDb } = await import("../src/db.ts");
const { makeHandler } = await import("../src/api.ts");
const { normalizeTitle, titleSimilarity, NEAR_THRESHOLD, STRONG_THRESHOLD } = await import("../src/dedup.ts");

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
const mkTask = async (title: string, brief?: string) =>
  (await post("/api/tasks", { project_id: projectId, title, brief })).json;
const openDecisionsFor = async (taskId: string) =>
  (await get(`/api/tasks/${taskId}`)).json.decisions.filter((d: any) => d.status === "open");

let projectId = "";
beforeAll(async () => {
  projectId = (await post("/api/projects", { name: "dedup-proj", repo_path: "/tmp/x" })).json.id;
});

// ---- pure helpers ----
test("normalizeTitle: trim, lowercase, collapse ws, strip trailing punctuation", () => {
  expect(normalizeTitle("  Add   Intake Form!!  ")).toBe("add intake form");
  expect(normalizeTitle("Intake form.")).toBe("intake form");
  expect(normalizeTitle("intake form")).toBe(normalizeTitle("  INTAKE   form  "));
});

test("titleSimilarity: duplicates score high, distinct scores low", () => {
  expect(titleSimilarity("intake form", "Intake Form")).toBe(1);
  // near-dup: shared "intake form" plus one extra word
  expect(titleSimilarity("intake form", "intake form validation")).toBeGreaterThanOrEqual(NEAR_THRESHOLD);
  // genuinely different work → below threshold (no false positive)
  expect(titleSimilarity("Add dark mode toggle", "Fix login redirect bug")).toBeLessThan(NEAR_THRESHOLD);
  // filler words alone don't cross the bar
  expect(titleSimilarity("Old shipped task", "New shipped task")).toBeLessThan(NEAR_THRESHOLD);
  // very strong match recommends merge (one filler word apart)
  expect(titleSimilarity("Add dark mode toggle", "Add a dark mode toggle")).toBeGreaterThanOrEqual(STRONG_THRESHOLD);
});

// ---- exact auto-merge ----
test("exact duplicate of a fresh queued task is auto-merged + cancelled with pointer", async () => {
  const survivor = await mkTask("Build the intake form", "original brief");
  const dup = await mkTask("build the intake form.", "second ask, extra note");

  expect(dup.state).toBe("cancelled");
  expect(dup.duplicate_of).toBe(survivor.id);

  // survivor untouched (still queued) and carries a duplicate_merged event with
  // the folded brief, no human decision anywhere.
  const s = (await get(`/api/tasks/${survivor.id}`)).json;
  expect(s.state).toBe("queued");
  const merged = s.events.find((e: any) => e.type === "duplicate_merged" && e.payload.duplicate_task_id === dup.id);
  expect(merged).toBeTruthy();
  expect(merged.payload.note).toContain("second ask");
  expect((await openDecisionsFor(dup.id)).length).toBe(0);
  expect((await openDecisionsFor(survivor.id)).length).toBe(0);
});

test("survivor is the OLDER task", async () => {
  const first = await mkTask("Wire up billing webhook");
  const second = await mkTask("wire up billing webhook");
  expect(second.state).toBe("cancelled");
  expect(second.duplicate_of).toBe(first.id);
});

// ---- near-dup → decision, never auto-cancel ----
test("near duplicate opens a decision (does NOT auto-cancel)", async () => {
  const survivor = await mkTask("Export report as CSV");
  const near = await mkTask("Export report as CSV file");

  expect(near.state).not.toBe("cancelled");
  expect(near.duplicate_of ?? null).toBeNull();
  const decs = await openDecisionsFor(near.id);
  expect(decs.length).toBe(1);
  expect(decs[0].title).toContain("Possible duplicate");
  expect(decs[0].options.map((o: any) => o.key).sort()).toEqual(["keep-separate", "merge"]);
});

test("answering a near-dup card with 'merge' folds + cancels", async () => {
  const survivor = await mkTask("Add pagination to results list");
  const near = await mkTask("Add pagination to the results list");
  const dec = (await openDecisionsFor(near.id))[0];

  await post(`/api/decisions/${dec.id}/answer`, { answer_key: "merge" });
  const after = (await get(`/api/tasks/${near.id}`)).json;
  expect(after.state).toBe("cancelled");
  expect(after.duplicate_of).toBe(survivor.id);
});

test("answering a near-dup card with 'keep-separate' leaves both alive", async () => {
  const survivor = await mkTask("Cache the avatar images");
  const near = await mkTask("Cache the avatar images now");
  const dec = (await openDecisionsFor(near.id))[0];

  await post(`/api/decisions/${dec.id}/answer`, { answer_key: "keep-separate" });
  const after = (await get(`/api/tasks/${near.id}`)).json;
  expect(after.state).not.toBe("cancelled");
  expect(after.duplicate_of ?? null).toBeNull();
});

// ---- no false positive ----
test("a genuinely different title is untouched (no dup, no card)", async () => {
  await mkTask("Migrate the auth service to v2");
  const distinct = await mkTask("Write onboarding docs");
  expect(distinct.state).toBe("queued");
  expect(distinct.duplicate_of ?? null).toBeNull();
  expect((await openDecisionsFor(distinct.id)).length).toBe(0);
});

test("same title in a DIFFERENT project is not a duplicate", async () => {
  const other = (await post("/api/projects", { name: "other-proj", repo_path: "/tmp/y" })).json.id;
  await mkTask("Shared title across projects");
  const elsewhere = (await post("/api/tasks", { project_id: other, title: "Shared title across projects" })).json;
  expect(elsewhere.state).toBe("queued");
  expect(elsewhere.duplicate_of ?? null).toBeNull();
});

// ---- manual merge-into endpoint ----
test("POST /merge-into folds a task into a target and cancels it", async () => {
  const target = await mkTask("Keeper task A");
  const loser = await mkTask("Totally separate task B");
  const dependent = await mkTask("Task depending on loser B");
  db.query("UPDATE tasks SET depends_on = ? WHERE id = ?").run(JSON.stringify([loser.id]), target.id);
  db.query("UPDATE tasks SET depends_on = ? WHERE id = ?").run(JSON.stringify([loser.id]), dependent.id);
  const r = await post(`/api/tasks/${loser.id}/merge-into`, { target_id: target.id });
  expect(r.status).toBe(200);
  expect(r.json.state).toBe("cancelled");
  expect(r.json.duplicate_of).toBe(target.id);
  expect((await get(`/api/tasks/${target.id}`)).json.depends_on).toEqual([]);
  expect((await get(`/api/tasks/${dependent.id}`)).json.depends_on).toEqual([target.id]);
});

test("POST /merge-into does not create a dependency cycle while repointing", async () => {
  const source = await mkTask("Cycle source task");
  const target = await mkTask("Cycle target task");
  const dependent = await mkTask("Cycle dependent task");
  db.query("UPDATE tasks SET depends_on = ? WHERE id = ?").run(JSON.stringify([dependent.id]), target.id);
  db.query("UPDATE tasks SET depends_on = ? WHERE id = ?").run(JSON.stringify([source.id]), dependent.id);

  const r = await post(`/api/tasks/${source.id}/merge-into`, { target_id: target.id });

  expect(r.status).toBe(200);
  expect((await get(`/api/tasks/${dependent.id}`)).json.depends_on).toEqual([source.id]);
  const skipped = db.query("SELECT payload FROM events WHERE task_id = ? AND type = 'dependency_repoint_skipped'").get(dependent.id) as any;
  expect(JSON.parse(skipped.payload)).toMatchObject({ from_task_id: source.id, to_task_id: target.id, reason: "dependency cycle" });
  expect((await openDecisionsFor(dependent.id)).length).toBe(1);
});

test("POST /merge-into rejects self-merge and a terminal source", async () => {
  const a = await mkTask("Self merge guard task");
  const self = await post(`/api/tasks/${a.id}/merge-into`, { target_id: a.id });
  expect(self.status).toBe(400);

  const target = await mkTask("Some other keeper");
  // cancel `a` first, then merging it again is a 409 (can't cancel a cancelled task)
  await post(`/api/tasks/${a.id}/merge-into`, { target_id: target.id });
  const again = await post(`/api/tasks/${a.id}/merge-into`, { target_id: target.id });
  expect(again.status).toBe(409);
});

// ---- duplicate clusters (backfill) ----
test("GET /api/tasks/duplicates surfaces clusters among non-terminal tasks", async () => {
  const p = (await post("/api/projects", { name: "cluster-proj", repo_path: "/tmp/z" })).json.id;
  // Two near-dups that DON'T exact-match (so neither is auto-cancelled on create).
  await post("/api/tasks", { project_id: p, title: "Send weekly digest email" });
  const near = (await post("/api/tasks", { project_id: p, title: "Send the weekly digest email out" })).json;
  // near opened a decision but stays queued (non-terminal) → both cluster together.
  const r = await get("/api/tasks/duplicates");
  expect(r.status).toBe(200);
  const cluster = r.json.clusters.find((c: any) => c.project_id === p);
  expect(cluster).toBeTruthy();
  expect(cluster.tasks.length).toBeGreaterThanOrEqual(2);
  expect(cluster.tasks.some((t: any) => t.id === near.id)).toBe(true);
});

// ---- #1879: the caller is told what dedup did, and how to undo it ----
test("auto-merged create returns a warning naming the survivor, its state, and the recovery", async () => {
  const survivor = await mkTask("Expire the untagged ECR orphans");
  const dup = await mkTask("expire the untagged ECR orphans");

  expect(dup.state).toBe("cancelled");
  expect(dup.warning).toContain(`folded into ${survivor.id} (queued)`);
  expect(dup.warning).toContain(`hive task move ${survivor.id} cancelled`);
});

test("a create that does not dedup carries no warning", async () => {
  const solo = await mkTask("Rotate the staging signing key");
  expect(solo.state).toBe("queued");
  expect(solo.warning ?? null).toBeNull();
});

test("near-dup create warns that it is parked behind the card", async () => {
  const survivor = await mkTask("Retry the flaky editorial flip test");
  const near = await mkTask("Retry the flaky editorial flip test again");
  const dec = (await openDecisionsFor(near.id))[0];

  expect(near.warning).toContain(`possible duplicate of ${survivor.id} (queued)`);
  expect(near.warning).toContain("cancels this task");
  expect(near.warning).toContain(dec.id);
  expect(near.warning).toContain(`hive task move ${survivor.id} cancelled`);
});

test("following the printed recovery: cancel the survivor, recreate, task survives", async () => {
  const broken = await mkTask("Fix NON_PROD failing open on unset RUST_PROFILE");
  const refiled = await mkTask("Fix NON_PROD failing open on unset RUST_PROFILE");
  expect(refiled.state).toBe("cancelled");

  // The recovery the warning prints.
  await post(`/api/tasks/${broken.id}/transition`, { to: "cancelled", reason: "superseded" });
  const retry = await mkTask("Fix NON_PROD failing open on unset RUST_PROFILE");
  expect(retry.state).toBe("queued");
  expect(retry.duplicate_of ?? null).toBeNull();
  expect(retry.warning ?? null).toBeNull();
  expect((await openDecisionsFor(retry.id)).length).toBe(0);
});
