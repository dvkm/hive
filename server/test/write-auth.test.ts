// Config/secret writes are token-gated even over loopback (task #1025, scout
// #991): those two stores are where a caller-supplied value gets paired with a
// credential. Everything else — reads, task flow — stays trustless. These run
// over a real 127.0.0.1 socket so the loopback path itself is exercised, and
// assert the STORE is unchanged, not just the status code.
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HIVE_HOME = mkdtempSync(join(tmpdir(), "hive-write-auth-"));

const { openDb, setSetting } = await import("../src/db.ts");
const { makeHandler } = await import("../src/api.ts");

const TOKEN = "test-token";
const db = openDb(":memory:");
setSetting(db, "api_token", TOKEN);
const server = Bun.serve({ port: 0, fetch: makeHandler(db) });
const BASE = `http://127.0.0.1:${server.port}`;
afterAll(() => server.stop(true));

const call = (path: string, init: RequestInit & { token?: string } = {}) =>
  fetch(BASE + path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
    },
  });

const project = await (await call("/api/projects", {
  method: "POST",
  body: JSON.stringify({ name: "gated", repo_path: "/repo", config: { auto_dispatch: true } }),
})).json();
const configOf = () =>
  (db.query("SELECT config FROM projects WHERE id = ?").get(project.id) as { config: string }).config;
const secretNames = () =>
  db.query("SELECT name FROM secrets WHERE project_id = ?").all(project.id).map((r: any) => r.name);

test("loopback PUT /api/projects/:id without the token is rejected and changes nothing", async () => {
  const before = configOf();
  const res = await call(`/api/projects/${project.id}`, {
    method: "PUT",
    body: JSON.stringify({ name: "pwned", repo_path: "/evil", config: { auto_dispatch: false, env: { EXFIL: "1" } } }),
  });
  expect(res.status).toBe(401);
  expect(configOf()).toBe(before);
  expect((db.query("SELECT name FROM projects WHERE id = ?").get(project.id) as any).name).toBe("gated");
});

test("loopback POST /secrets without the token is rejected and stores no secret", async () => {
  const res = await call(`/api/projects/${project.id}/secrets`, {
    method: "POST",
    body: JSON.stringify({ name: "AWS_KEY", provider: "keychain" }),
  });
  expect(res.status).toBe(401);
  expect(secretNames()).toEqual([]);
});

test("a wrong token is rejected the same way", async () => {
  const res = await call(`/api/projects/${project.id}/secrets`, {
    method: "POST",
    token: "not-the-token",
    body: JSON.stringify({ name: "AWS_KEY", provider: "keychain" }),
  });
  expect(res.status).toBe(401);
  expect(secretNames()).toEqual([]);
});

test("the token lets the same writes through, and DELETE /secrets is gated too", async () => {
  const put = await call(`/api/projects/${project.id}`, {
    method: "PUT",
    token: TOKEN,
    body: JSON.stringify({ name: "gated", repo_path: "/repo", config: { auto_dispatch: false } }),
  });
  expect(put.status).toBe(200);
  expect(JSON.parse(configOf()).auto_dispatch).toBe(false);

  const created = await call(`/api/projects/${project.id}/secrets`, {
    method: "POST",
    token: TOKEN,
    body: JSON.stringify({ name: "AWS_KEY", provider: "keychain" }),
  });
  expect(created.status).toBe(201);
  expect(secretNames()).toEqual(["AWS_KEY"]);

  const unauthedDelete = await call(`/api/projects/${project.id}/secrets/AWS_KEY`, { method: "DELETE" });
  expect(unauthedDelete.status).toBe(401);
  expect(secretNames()).toEqual(["AWS_KEY"]); // still there

  const authedDelete = await call(`/api/projects/${project.id}/secrets/AWS_KEY`, { method: "DELETE", token: TOKEN });
  expect(authedDelete.status).toBe(200);
  expect(secretNames()).toEqual([]);
});

// The gate's regexes must agree with the router's own path patterns; a variant
// that slips past the gate must also miss the route (404), never write.
test("path variants never reach a write without the token", async () => {
  const variants: [string, string][] = [
    ["PUT", `/api/projects/${project.id}/`],
    ["PUT", `//api/projects/${project.id}`],
    ["POST", `/api/projects/${project.id}/secrets/`],
    ["DELETE", `/api/projects/${project.id}/secrets/a%2Fb`],
    ["DELETE", `/api/projects/${project.id}/secrets/AWS_KEY?token=wrong`],
  ];
  const before = configOf();
  for (const [method, path] of variants) {
    const res = await call(path, { method, body: JSON.stringify({ name: "pwned", provider: "keychain" }) });
    expect([401, 404]).toContain(res.status);
  }
  expect(configOf()).toBe(before);
  expect(secretNames()).toEqual([]);
});

test("reads and the task flow stay trustless on loopback", async () => {
  expect((await call("/api/projects")).status).toBe(200);
  expect((await call(`/api/projects/${project.id}`)).status).toBe(200);
  expect((await call(`/api/projects/${project.id}/secrets`)).status).toBe(200);
  const task = await call("/api/tasks", {
    method: "POST",
    body: JSON.stringify({ project_id: project.id, title: "untokened task" }),
  });
  expect(task.status).toBe(201);
  const id = (await task.json()).id;
  const event = await call(`/api/tasks/${id}/events`, {
    method: "POST",
    body: JSON.stringify({ type: "status", note: "still trustless" }),
  });
  expect(event.status).toBe(201);
});

test("no token minted → the gate fails closed while reads keep working", async () => {
  const bare = openDb(":memory:");
  const bareServer = Bun.serve({ port: 0, fetch: makeHandler(bare) });
  const p: any = await (await fetch(`http://127.0.0.1:${bareServer.port}/api/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "bare", repo_path: "/repo" }),
  })).json();
  const res = await fetch(`http://127.0.0.1:${bareServer.port}/api/projects/${p.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: "Bearer anything" },
    body: JSON.stringify({ name: "pwned" }),
  });
  expect(res.status).toBe(401);
  expect((bare.query("SELECT name FROM projects WHERE id = ?").get(p.id) as any).name).toBe("bare");
  expect((await fetch(`http://127.0.0.1:${bareServer.port}/api/projects/${p.id}`)).status).toBe(200);
  bareServer.stop(true);
});
