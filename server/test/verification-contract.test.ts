// HIVE-401: the verification contract as data — validated on the task, rendered
// into the brief, and echoed back on evidence via --verify-name. Nothing is
// gated on it yet (that is A2).
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "hive-verify-test-"));
process.env.HIVE_HOME = HOME;

const { openDb } = await import("../src/db.ts");
const { makeHandler } = await import("../src/api.ts");
const { composeBrief } = await import("../src/briefs.ts");

const db = openDb(":memory:");
const server = Bun.serve({ port: 0, fetch: makeHandler(db) });
const BASE = `http://127.0.0.1:${server.port}`;
afterAll(() => server.stop(true));

async function post(path: string, body: unknown) {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any };
}
async function put(path: string, body: unknown) {
  const res = await fetch(BASE + path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any };
}
async function get(path: string) {
  const res = await fetch(BASE + path);
  return { status: res.status, json: (await res.json()) as any };
}

let projectId = "";
beforeAll(async () => {
  projectId = (await post("/api/projects", { name: "verify-proj", repo_path: "/tmp/vp" })).json.id;
});

const CMDS = [
  { name: "unit", cmd: "bun test server/test/verification-contract.test.ts" },
  { name: "typecheck", cmd: "bun run tsc --noEmit" },
];

test("createTask stores verification_cmds and GET returns them parsed", async () => {
  const created = await post("/api/tasks", {
    project_id: projectId,
    title: "Task with a contract",
    verification_cmds: CMDS,
  });
  expect(created.status).toBe(201);
  expect(created.json.verification_cmds).toEqual(CMDS);

  const fetched = await get(`/api/tasks/${created.json.id}`);
  expect(fetched.json.verification_cmds).toEqual(CMDS);
});

test("a task without a contract reports null, not an empty array", async () => {
  const created = await post("/api/tasks", { project_id: projectId, title: "No contract" });
  expect(created.json.verification_cmds).toBeNull();
});

test("createTask rejects malformed verification_cmds with 400", async () => {
  const bad: [string, unknown][] = [
    ["not an array", { name: "unit", cmd: "bun test" }],
    ["entry is not an object", ["bun test"]],
    ["name has invalid chars", [{ name: "Unit Tests", cmd: "bun test" }]],
    ["name too long", [{ name: "a".repeat(33), cmd: "bun test" }]],
    ["empty name", [{ name: "", cmd: "bun test" }]],
    ["duplicate names", [{ name: "unit", cmd: "a" }, { name: "unit", cmd: "b" }]],
    ["blank cmd", [{ name: "unit", cmd: "   " }]],
    ["missing cmd", [{ name: "unit" }]],
  ];
  for (const [why, value] of bad) {
    const res = await post("/api/tasks", {
      project_id: projectId,
      title: `bad: ${why}`,
      verification_cmds: value,
    });
    expect(`${why}: ${res.status}`).toBe(`${why}: 400`);
  }
});

test("updateTask replaces, preserves on omission, and clears on null", async () => {
  const id = (await post("/api/tasks", { project_id: projectId, title: "Editable", verification_cmds: CMDS })).json.id;

  // omitted → untouched
  const titleOnly = await put(`/api/tasks/${id}`, { title: "Editable (renamed)" });
  expect(titleOnly.json.verification_cmds).toEqual(CMDS);

  // sent → full replace
  const replaced = await put(`/api/tasks/${id}`, { verification_cmds: [{ name: "smoke", cmd: "./smoke.sh" }] });
  expect(replaced.json.verification_cmds).toEqual([{ name: "smoke", cmd: "./smoke.sh" }]);

  // invalid → 400, and the stored contract survives
  const rejected = await put(`/api/tasks/${id}`, { verification_cmds: [{ name: "BAD NAME", cmd: "x" }] });
  expect(rejected.status).toBe(400);
  expect((await get(`/api/tasks/${id}`)).json.verification_cmds).toEqual([{ name: "smoke", cmd: "./smoke.sh" }]);

  // null / [] → cleared
  expect((await put(`/api/tasks/${id}`, { verification_cmds: null })).json.verification_cmds).toBeNull();
  const back = await put(`/api/tasks/${id}`, { verification_cmds: CMDS });
  expect(back.json.verification_cmds).toEqual(CMDS);
  expect((await put(`/api/tasks/${id}`, { verification_cmds: [] })).json.verification_cmds).toBeNull();
});

test("the brief renders the contract with every exact command", async () => {
  const id = (await post("/api/tasks", { project_id: projectId, title: "Briefed", verification_cmds: CMDS })).json.id;
  const brief = composeBrief(db, id);
  expect(brief).toContain("## Verification contract");
  for (const c of CMDS) {
    expect(brief).toContain(c.name);
    expect(brief).toContain(c.cmd);
  }
  expect(brief).toContain("--verify-name");
  expect(brief).toContain("before you emit `ready`");
});

test("the brief omits the contract section when the task has none", async () => {
  const id = (await post("/api/tasks", { project_id: projectId, title: "Unbriefed" })).json.id;
  expect(composeBrief(db, id)).not.toContain("Verification contract");
});

test("emit evidence --verify-name lands on the evidence event payload", async () => {
  const id = (await post("/api/tasks", { project_id: projectId, title: "Evidence", verification_cmds: CMDS })).json.id;

  const form = new FormData();
  form.set("type", "evidence");
  form.set("verify_name", "unit");
  form.set("caption", "unit output");
  form.set("file", new File([new TextEncoder().encode("42 pass 0 fail")], "unit.txt", { type: "text/plain" }));
  const res = await fetch(`${BASE}/api/tasks/${id}/events`, { method: "POST", body: form });
  expect(res.status).toBe(201);
  expect(((await res.json()) as any).event.payload.verify_name).toBe("unit");

  // JSON path (no file) carries it too, and an untagged item has no key at all.
  const tagged = await post(`/api/tasks/${id}/events`, { type: "evidence", note: "link", url: "https://example.com/ci", verify_name: "typecheck" });
  expect(tagged.json.event.payload.verify_name).toBe("typecheck");
  const untagged = await post(`/api/tasks/${id}/events`, { type: "evidence", note: "just a note" });
  expect(untagged.json.event.payload).not.toHaveProperty("verify_name");

  const events = (await get(`/api/tasks/${id}/events`)).json.filter((e: any) => e.type === "evidence");
  expect(events.map((e: any) => e.payload.verify_name)).toEqual(["unit", "typecheck", undefined]);
});
