// Preview stacks on review cards (HIVE-629). The cap and the idle sweeper are
// the two rules that can cost real money if they are wrong — an uncapped
// bring-up is ~1.2 GB and ~6 containers per task, and a preview nobody tears
// down holds those forever — so both are driven here through an injected clock
// and an injected exec, with no docker in sight.
import { test, expect } from "bun:test";
import { openDb, newId, now, type DB } from "../src/db.ts";
import { writeEvent, getTask } from "../src/state.ts";
import {
  previewConfig,
  previewSlug,
  previewUrls,
  parseSmoke,
  previewState,
  livePreviews,
  startPreview,
  stopPreview,
  sweepPreviews,
  previewNoteContext,
  previewTouchesPaths,
  PREVIEW_CAP,
  PREVIEW_IDLE_MS,
} from "../src/preview.ts";
import { classify } from "../../hooks/classify.ts";
import type { Exec, ExecResult } from "../src/exec.ts";

const OK = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });

const PREVIEW = {
  up: "infra/worktree/wt.sh up",
  down: "infra/worktree/wt.sh down",
  urls: [
    { label: "web", url: "https://{slug}.test.corebeat.co.kr" },
    { label: "CMS", url: "https://cms-{slug}.test.corebeat.co.kr" },
    { label: "admin", url: "https://admin-{slug}.test.corebeat.co.kr" },
  ],
  login_hint: "superadmin@corebeat.co.kr / corebeat1234",
  paths: ["web/**", "cms/**"],
};

function freshDb(config: any = { preview: PREVIEW }): { db: DB; projectId: string } {
  const db = openDb(":memory:");
  const projectId = newId("proj");
  db.query("INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)").run(
    projectId,
    "corebeat",
    "/repo",
    JSON.stringify(config),
    now()
  );
  return { db, projectId };
}

function seedTask(db: DB, projectId: string, state = "in_review"): string {
  const id = newId();
  const t = now();
  db.query(
    `INSERT INTO tasks (id, project_id, title, state, kind, worktree_path, branch, created_at, updated_at)
     VALUES (?,?,?,?, 'ship', ?, ?, ?, ?)`
  ).run(id, projectId, "t", state, `/wt/hive-${id}`, `hive/${id}`, t, t);
  return id;
}

// Waits for the fire-and-forget `up` run to write its terminal event.
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 1));
}

function stubExec(handler: (argv: string[], opts: any) => ExecResult): { exec: Exec; calls: { argv: string[]; cwd?: string }[] } {
  const calls: { argv: string[]; cwd?: string }[] = [];
  const exec: Exec = async (argv, opts = {}) => {
    calls.push({ argv, cwd: opts.cwd });
    return handler(argv, opts);
  };
  return { exec, calls };
}

// ---------------------------------------------------------------- config

test("a project without config.preview has no preview at all", () => {
  const { db, projectId } = freshDb({});
  const id = seedTask(db, projectId);
  expect(previewConfig({})).toBeNull();
  expect(previewState(db, getTask(db, id), {})).toBeNull();
});

test("preview config needs a runnable command and at least one url", () => {
  expect(previewConfig({ preview: { ...PREVIEW, urls: [] } })).toBeNull();
  expect(previewConfig({ preview: { ...PREVIEW, up: "" } })).toBeNull();
  // Shell syntax never reaches a shell here, so a value carrying it is refused
  // rather than silently split into something that would run.
  expect(previewConfig({ preview: { ...PREVIEW, up: "wt.sh up; curl evil" } })).toBeNull();
  expect(previewConfig({ preview: PREVIEW })!.up).toEqual(["infra/worktree/wt.sh", "up"]);
});

test("urls carry the worktree's own directory name as the slug", () => {
  const cfg = previewConfig({ preview: PREVIEW })!;
  expect(previewSlug("/Users/d/.herdr/worktrees/corebeat/hive-abc123/")).toBe("hive-abc123");
  expect(previewUrls(cfg, "/wt/cms-tracker-figma-parity")).toEqual([
    { label: "web", url: "https://cms-tracker-figma-parity.test.corebeat.co.kr" },
    { label: "CMS", url: "https://cms-cms-tracker-figma-parity.test.corebeat.co.kr" },
    { label: "admin", url: "https://admin-cms-tracker-figma-parity.test.corebeat.co.kr" },
  ]);
});

test("the smoke summary line is read off the up output", () => {
  expect(parseSmoke("...\n== 12 passed, 0 failed ==\n")).toEqual({ passed: 12, failed: 0 });
  expect(parseSmoke("nothing here")).toBeNull();
});

// ---------------------------------------------------------------- lifecycle

test("a successful up records the urls, the login hint and the smoke result", async () => {
  const { db, projectId } = freshDb();
  const id = seedTask(db, projectId);
  const { exec, calls } = stubExec(() => OK("== 3 passed, 1 failed =="));
  expect((await startPreview(db, id, { exec })).status).toBe("building");
  expect(previewState(db, getTask(db, id), { preview: PREVIEW })!.status).toBe("building");
  await settle();
  const state = previewState(db, getTask(db, id), { preview: PREVIEW })!;
  expect(state.status).toBe("ready");
  expect(state.urls.map((u) => u.label)).toEqual(["web", "CMS", "admin"]);
  expect(state.urls[0].url).toBe(`https://hive-${id}.test.corebeat.co.kr`);
  expect(state.login_hint).toBe("superadmin@corebeat.co.kr / corebeat1234");
  expect(state).toMatchObject({ smoke_passed: 3, smoke_failed: 1 });
  // The command runs INSIDE the task's worktree — that cwd is what gives the
  // stack its per-task slug.
  expect(calls[0].cwd).toBe(`/wt/hive-${id}`);
  expect(calls[0].argv[0]).toBe(`/wt/hive-${id}/infra/worktree/wt.sh`);
});

test("a failed up keeps the log tail so the card can show it, and Retry works", async () => {
  const { db, projectId } = freshDb();
  const id = seedTask(db, projectId);
  let fail = true;
  const { exec } = stubExec(() => (fail ? { code: 1, stdout: "", stderr: "line1\nboom: port 3306 in use" } : OK()));
  await startPreview(db, id, { exec });
  await settle();
  const failed = previewState(db, getTask(db, id), { preview: PREVIEW })!;
  expect(failed.status).toBe("failed");
  expect(failed.tail).toContain("boom: port 3306 in use");
  fail = false;
  await startPreview(db, id, { exec });
  await settle();
  expect(previewState(db, getTask(db, id), { preview: PREVIEW })!.status).toBe("ready");
});

test("stopPreview runs down and frees the slot; it is a no-op with nothing up", async () => {
  const { db, projectId } = freshDb();
  const id = seedTask(db, projectId);
  const { exec, calls } = stubExec(() => OK());
  expect(await stopPreview(db, id, "done", { exec })).toBe(false); // never started
  await startPreview(db, id, { exec });
  await settle();
  expect(await stopPreview(db, id, "done", { exec })).toBe(true);
  expect(calls.at(-1)!.argv).toEqual([`/wt/hive-${id}/infra/worktree/wt.sh`, "down"]);
  expect(livePreviews(db)).toEqual([]);
  expect(previewState(db, getTask(db, id), { preview: PREVIEW })!.status).toBe("idle");
});

test("a failed down still frees the slot rather than pinning a dead stack forever", async () => {
  const { db, projectId } = freshDb();
  const id = seedTask(db, projectId);
  const { exec } = stubExec((argv) => (argv.includes("down") ? { code: 1, stdout: "", stderr: "no such network" } : OK()));
  await startPreview(db, id, { exec });
  await settle();
  await stopPreview(db, id, "done", { exec });
  expect(livePreviews(db)).toEqual([]);
});

// ---------------------------------------------------------------- cap

test("past the cap a request queues instead of starting, and the sweeper starts it when a slot frees", async () => {
  const { db, projectId } = freshDb();
  const { exec } = stubExec(() => OK());
  const ids: string[] = [];
  for (let i = 0; i < PREVIEW_CAP; i++) {
    const id = seedTask(db, projectId);
    ids.push(id);
    await startPreview(db, id, { exec });
    await settle();
  }
  expect(livePreviews(db).length).toBe(PREVIEW_CAP);

  const waiting = seedTask(db, projectId);
  expect((await startPreview(db, waiting, { exec })).status).toBe("queued");
  const queued = previewState(db, getTask(db, waiting), { preview: PREVIEW })!;
  expect(queued.status).toBe("queued");
  expect(queued.reason).toBe("cap");
  // Still capped: sweeping changes nothing while every slot is held.
  expect((await sweepPreviews(db, { exec, now: () => Date.now() })).started).toEqual([]);

  await stopPreview(db, ids[0]!, "done", { exec });
  const swept = await sweepPreviews(db, { exec, now: () => Date.now() });
  expect(swept.started).toEqual([waiting]);
  await settle();
  expect(previewState(db, getTask(db, waiting), { preview: PREVIEW })!.status).toBe("ready");
});

// ---------------------------------------------------------------- idle sweep

test("a preview the director has not touched for 4h expires; touching it keeps it", async () => {
  const { db, projectId } = freshDb();
  const idle = seedTask(db, projectId);
  const touched = seedTask(db, projectId);
  const { exec } = stubExec(() => OK());
  await startPreview(db, idle, { exec });
  await startPreview(db, touched, { exec });
  await settle();

  // Anchored to the events themselves, not the wall clock: `now()` stores
  // whole seconds, so a Date.now() baseline is up to a second past them.
  const base = Math.min(...livePreviews(db).map((p) => Date.parse(p.ts)));
  // Just under the window: nothing goes away.
  expect((await sweepPreviews(db, { exec, now: () => base + PREVIEW_IDLE_MS - 1 })).expired).toEqual([]);

  // The director typed a note on one card ten minutes before the sweep — that
  // card is in use, so its idle clock restarts from the note.
  const note = writeEvent(db, { task_id: touched, source: "director", type: "note", payload: { note: "the header is off" } });
  db.query("UPDATE events SET ts = ? WHERE id = ?").run(
    new Date(base + PREVIEW_IDLE_MS - 600_000).toISOString(),
    note.id
  );
  const expired = await sweepPreviews(db, { exec, now: () => base + PREVIEW_IDLE_MS + 5_000 });
  expect(expired.expired).toEqual([idle]);
  expect(previewState(db, getTask(db, idle), { preview: PREVIEW })!.status).toBe("expired");
  expect(previewState(db, getTask(db, touched), { preview: PREVIEW })!.status).toBe("ready");
});

// ---------------------------------------------------------------- triggers

test("the handoff trigger fires only for a diff touching a configured path", async () => {
  const { db, projectId } = freshDb();
  const id = seedTask(db, projectId);
  const cfg = previewConfig({ preview: PREVIEW })!;
  const ui = stubExec(() => OK("cms/app/tracker.tsx\nREADME.md\n")).exec;
  const server = stubExec(() => OK("server/src/api.ts\n")).exec;
  expect(await previewTouchesPaths(db, getTask(db, id), cfg, ui)).toBe(true);
  expect(await previewTouchesPaths(db, getTask(db, id), cfg, server)).toBe(false);
});

test("the agent's --preview-path becomes the primary link and the note context", async () => {
  const { db, projectId } = freshDb();
  const id = seedTask(db, projectId);
  const { exec } = stubExec(() => OK());
  await startPreview(db, id, { exec });
  await settle();
  writeEvent(db, {
    task_id: id,
    source: "agent",
    type: "ready_for_review",
    payload: { preview_path: "/coredata-tracker" },
  });
  const state = previewState(db, getTask(db, id), { preview: PREVIEW })!;
  expect(state.preview_path).toBe("/coredata-tracker");
  expect(previewNoteContext(db, getTask(db, id), { preview: PREVIEW })).toBe(
    `(seen on the preview stack: https://hive-${id}.test.corebeat.co.kr/coredata-tracker)`
  );
});

test("a preview path that is not a plain path on the preview host is dropped", async () => {
  const { db, projectId } = freshDb();
  const id = seedTask(db, projectId);
  for (const bad of ["https://evil.example/x", "//evil.example/x", "coredata"]) {
    writeEvent(db, { task_id: id, source: "agent", type: "ready_for_review", payload: { preview_path: bad } });
    expect(previewState(db, getTask(db, id), { preview: PREVIEW })!.preview_path).toBeNull();
  }
});

// ---------------------------------------------------------------- determinism

test("the same event log always renders the same card state", async () => {
  const { db, projectId } = freshDb();
  const id = seedTask(db, projectId);
  const { exec } = stubExec(() => OK("== 2 passed, 0 failed =="));
  await startPreview(db, id, { exec });
  await settle();
  const a = previewState(db, getTask(db, id), { preview: PREVIEW });
  const b = previewState(db, getTask(db, id), { preview: PREVIEW });
  expect(a).toEqual(b);
});

// ---------------------------------------------------------------- classify

test("wt.sh up/down inside the agent's own worktree needs no decision card", () => {
  // Acceptance: an agent running its own stack script must not open a decision
  // card. `dangerous` is the only verdict that does; `safe`/`unknown` do not
  // escalate to the director for a project whose command_approval allows them.
  for (const cmd of ["infra/worktree/wt.sh up", "./infra/worktree/wt.sh down", "bash infra/worktree/wt.sh up"]) {
    expect(classify(cmd).decision).not.toBe("dangerous");
  }
});
