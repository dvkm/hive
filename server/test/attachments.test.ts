// File attachments on steer messages and task briefs. The contract that matters:
// the file lands on disk under HIVE_HOME, and the agent is handed its ABSOLUTE
// path (agents read files off disk, not over HTTP).
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { splitAttachments } from "../../web/src/lib/attachments.ts";

const HOME = mkdtempSync(join(tmpdir(), "hive-attach-test-"));
process.env.HIVE_HOME = HOME;

const { openDb } = await import("../src/db.ts");
const { makeHandler } = await import("../src/api.ts");
const { Herdr } = await import("../src/runtime/herdr.ts");
import type { ExecResult } from "../src/exec.ts";

// Capture what herdr would have delivered to the agent.
const sent: string[] = [];
const exec = async (argv: string[]): Promise<ExecResult> => {
  const i = argv.indexOf("send");
  if (i !== -1 && argv[i + 2] !== undefined) sent.push(argv[i + 2]);
  // A live agent has a pane; herdr.send() reads it to submit the Enter. Without
  // this the pane-less path treats every steer as undelivered (delivery receipts).
  if (argv.includes("get")) return { code: 0, stdout: '{"result":{"agent":{"pane_id":"p1","agent_status":"working"}}}', stderr: "" };
  return { code: 0, stdout: "", stderr: "" };
};

const db = openDb(":memory:");
const server = Bun.serve({ port: 0, fetch: makeHandler(db, { herdr: new Herdr(exec, "herdr") }) });
const BASE = `http://127.0.0.1:${server.port}`;
afterAll(() => server.stop(true));

const png = (name = "shot.png") => new File([new Uint8Array([137, 80, 78, 71])], name, { type: "image/png" });

async function postForm(path: string, fields: Record<string, string>, files: File[], method = "POST") {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  for (const f of files) fd.append("files", f);
  const res = await fetch(BASE + path, { method, body: fd });
  return { status: res.status, json: await res.json() };
}
async function postJson(path: string, body: unknown) {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

let projectId = "";
beforeAll(async () => {
  projectId = (await postJson("/api/projects", { name: "attach-proj", repo_path: "/tmp/x" })).json.id;
});

// The absolute path an agent is told to read must actually hold the bytes we
// uploaded — that round trip is the whole feature.
function assertReadable(path: string, bytes: number[]) {
  expect(isAbsolute(path)).toBe(true);
  expect(existsSync(path)).toBe(true);
  return Bun.file(path)
    .arrayBuffer()
    .then((b) => expect([...new Uint8Array(b)]).toEqual(bytes));
}

test("steer with an attachment: file stored, absolute path delivered to the agent", async () => {
  const taskId = (await postJson("/api/tasks", { project_id: projectId, title: "Steer me" })).json.id;
  db.query("UPDATE tasks SET agent_target = ? WHERE id = ?").run("hive-1", taskId);

  const r = await postForm(`/api/tasks/${taskId}/send`, { message: "look at this" }, [png()]);
  expect(r.status).toBe(200);
  expect(r.json.delivered).toBe(true);
  expect(r.json.attachments).toHaveLength(1);

  const path = r.json.attachments[0];
  await assertReadable(path, [137, 80, 78, 71]);
  expect(path).toContain(join(HOME, "evidence", taskId));

  // The agent receives the note AND the path.
  expect(sent.at(-1)).toContain("look at this");
  expect(sent.at(-1)).toContain(path);

  // ...and the steer event records it for the timeline.
  const events = await (await fetch(`${BASE}/api/tasks/${taskId}/events`)).json();
  const steer = events.filter((e: any) => e.type === "steer").at(-1);
  expect(steer.payload.attachments).toEqual([path]);
});

test("steer without attachments still works (json path unchanged)", async () => {
  const taskId = (await postJson("/api/tasks", { project_id: projectId, title: "Plain steer" })).json.id;
  db.query("UPDATE tasks SET agent_target = ? WHERE id = ?").run("hive-2", taskId);
  const r = await postJson(`/api/tasks/${taskId}/send`, { message: "no files" });
  expect(r.status).toBe(200);
  expect(r.json.delivered).toBe(true);
  expect(sent.at(-1)).toBe("no files");
});

test("steer still requires a message", async () => {
  const taskId = (await postJson("/api/tasks", { project_id: projectId, title: "Empty steer" })).json.id;
  const r = await postForm(`/api/tasks/${taskId}/send`, {}, [png()]);
  expect(r.status).toBe(400);
});

test("task create with attachments: paths appended to the brief under Attachments", async () => {
  const r = await postForm(
    "/api/tasks",
    { project_id: projectId, title: "Build from mockup", brief: "match the design", kind: "ship" },
    [png("mock.png"), png("creds.json")]
  );
  expect(r.status).toBe(201);
  const task = r.json;
  expect(task.brief).toContain("match the design");
  expect(task.brief).toContain("## Attachments");

  const paths = task.brief.split("\n").filter((l: string) => l.startsWith("- ")).map((l: string) => l.slice(2));
  expect(paths).toHaveLength(2);
  for (const p of paths) await assertReadable(p, [137, 80, 78, 71]);
  // Stored under the NEW task's id, so cleanup follows the task.
  expect(paths[0]).toContain(join(HOME, "evidence", task.id));

  // The composed agent brief carries them through to the agent.
  const brief = (await (await fetch(`${BASE}/api/tasks/${task.id}/brief`)).json()).brief;
  expect(brief).toContain(paths[0]);
});

test("task create with an attachment and no brief text", async () => {
  const r = await postForm("/api/tasks", { project_id: projectId, title: "Just a file" }, [png()]);
  expect(r.status).toBe(201);
  expect(r.json.brief).toContain("## Attachments");
});

test("task edit appends attachments to the existing brief", async () => {
  const taskId = (await postJson("/api/tasks", { project_id: projectId, title: "Edit me", brief: "old" })).json.id;
  const fd = new FormData();
  fd.append("brief", "new brief");
  fd.append("files", png("extra.png"));
  const res = await fetch(`${BASE}/api/tasks/${taskId}`, { method: "PUT", body: fd });
  expect(res.status).toBe(200);
  const task = await res.json();
  expect(task.brief).toContain("new brief");
  expect(task.brief).toContain("## Attachments");
  const path = task.brief.split("\n").filter((l: string) => l.startsWith("- "))[0].slice(2);
  await assertReadable(path, [137, 80, 78, 71]);
});

// A title-only PUT must not turn a NULL brief into "".
test("task edit without files leaves a null brief null", async () => {
  const taskId = (await postJson("/api/tasks", { project_id: projectId, title: "No brief" })).json.id;
  const res = await fetch(`${BASE}/api/tasks/${taskId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Renamed" }),
  });
  const task = await res.json();
  expect(task.title).toBe("Renamed");
  expect(task.brief).toBeNull();
});

// Attachments are INPUT, not proof of work. If they were recorded as evidence
// rows, attaching a screenshot to a brief would silently satisfy the
// "no done without evidence" gate.
test("attachments do not count as evidence", async () => {
  const r = await postForm("/api/tasks", { project_id: projectId, title: "Gate check" }, [png()]);
  const taskId = r.json.id;
  const detail = await (await fetch(`${BASE}/api/tasks/${taskId}`)).json();
  expect(detail.evidence).toHaveLength(0);

  db.query("UPDATE tasks SET state = 'verifying' WHERE id = ?").run(taskId);
  const done = await postJson(`/api/tasks/${taskId}/transition`, { to: "done" });
  expect(done.status).toBe(409);
  expect(done.json.error).toContain("no evidence");
});

// The task detail view lifts the paths back out of the brief to show the
// images. If the server's block format and the web parser drift, the director
// sees a wall of absolute paths instead of their screenshots — so assert the
// round trip, including that the URL the <img> hits serves the real bytes.
test("brief attachment block round-trips into displayable attachments", async () => {
  const r = await postForm(
    "/api/tasks",
    { project_id: projectId, title: "Round trip", brief: "match the design" },
    [png("mock.png"), png("creds.json")]
  );
  const { body, files } = splitAttachments(r.json.brief);
  expect(body).toBe("match the design");
  expect(files).toHaveLength(2);
  expect(files[0].name).toBe("mock.png"); // the storage timestamp prefix is not shown
  expect(files[0].image).toBe(true);
  expect(files[1].image).toBe(false); // .json is a file chip, not a broken <img>

  const res = await fetch(BASE + files[0].url);
  expect(res.status).toBe(200);
  expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([137, 80, 78, 71]);
});

// A second upload appends a second block; both must surface.
test("attachments from a later edit surface too", async () => {
  const taskId = (await postJson("/api/tasks", { project_id: projectId, title: "Two rounds" })).json.id;
  for (const n of ["one.png", "two.png"]) {
    const fd = new FormData();
    fd.append("files", png(n));
    await fetch(`${BASE}/api/tasks/${taskId}`, { method: "PUT", body: fd });
  }
  const task = await (await fetch(`${BASE}/api/tasks/${taskId}`)).json();
  const { body, files } = splitAttachments(task.brief);
  expect(files.map((f) => f.name)).toEqual(["one.png", "two.png"]);
  expect(body).toBe("");
});

test("a brief with no attachments is left alone", () => {
  expect(splitAttachments("just a brief")).toEqual({ body: "just a brief", files: [] });
  expect(splitAttachments(null)).toEqual({ body: "", files: [] });
});

// Two files uploaded in the same millisecond must not overwrite each other.
test("same-name files in one upload get distinct paths", async () => {
  const r = await postForm("/api/tasks", { project_id: projectId, title: "Dup names" }, [png("a.png"), png("a.png")]);
  const paths = r.json.brief.split("\n").filter((l: string) => l.startsWith("- ")).map((l: string) => l.slice(2));
  expect(new Set(paths).size).toBe(2);
  for (const p of paths) expect(existsSync(p)).toBe(true);
});
