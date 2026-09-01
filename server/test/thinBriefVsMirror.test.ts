// HIVE-551: a work task filed from a Jira issue's TITLE while the real spec
// sits unread in the linked mirror task's brief must be refused, not silently
// created with a thin brief (root cause of WEB-118).
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HIVE_HOME = mkdtempSync(join(tmpdir(), "hive-thin-brief-"));

const { openDb, newId, now } = await import("../src/db.ts");
import type { DB } from "../src/db.ts";
const { makeHandler, thinBriefReason } = await import("../src/api.ts");

function freshDb(): { db: DB; projectId: string } {
  const db = openDb(":memory:");
  const projectId = newId("proj");
  db.query("INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)")
    .run(projectId, "p", "/repo", "{}", now());
  return { db, projectId };
}

function makeMirror(db: DB, projectId: string, key: string, brief: string): string {
  const id = newId();
  const t = now();
  db.query(
    `INSERT INTO tasks (id, project_id, title, brief, state, kind, source, priority, jira_key, jira_link_kind, created_at, updated_at)
     VALUES (?,?,?,?,'queued','chore',NULL,'normal',?,'mirror',?,?)`
  ).run(id, projectId, `[${key}] some title`, brief, key, t, t);
  return id;
}

function serve(db: DB) {
  const server = Bun.serve({ port: 0, fetch: makeHandler(db) });
  const BASE = `http://127.0.0.1:${server.port}`;
  return {
    server,
    post: (path: string, body: unknown) =>
      fetch(BASE + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  };
}

test("refuses a title-only brief when the linked mirror has a substantial spec", async () => {
  const { db, projectId } = freshDb();
  const spec = "x".repeat(300);
  makeMirror(db, projectId, "WEB-118", spec);
  const { server, post } = serve(db);
  try {
    const res = await post("/api/tasks", {
      project_id: projectId,
      title: "[WEB-118] fix the thing",
      kind: "chore",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(String(body.error)).toContain("mirror task");
  } finally {
    server.stop();
  }
});

test("allows creation when the new brief already carries the spec", async () => {
  const { db, projectId } = freshDb();
  const spec = "x".repeat(300);
  makeMirror(db, projectId, "WEB-119", spec);
  const { server, post } = serve(db);
  try {
    const res = await post("/api/tasks", {
      project_id: projectId,
      title: "[WEB-119] fix the thing",
      kind: "chore",
      brief: spec,
    });
    expect(res.status).toBe(201);
  } finally {
    server.stop();
  }
});

test("allows creation when no mirror is linked", async () => {
  const { db, projectId } = freshDb();
  const { server, post } = serve(db);
  try {
    const res = await post("/api/tasks", {
      project_id: projectId,
      title: "just a normal task",
      kind: "chore",
    });
    expect(res.status).toBe(201);
  } finally {
    server.stop();
  }
});

// The shape that actually got through in production: a long, confident brief
// whose whole content is "this ticket has no description, ask the reporter".
// A length-only guard passes this; the phrase arm is what catches it.
test("refuses a long brief that claims the ticket has no spec", async () => {
  const { db, projectId } = freshDb();
  makeMirror(db, projectId, "WEB-218", "x".repeat(300));
  const { server, post } = serve(db);
  try {
    const res = await post("/api/tasks", {
      project_id: projectId,
      title: "[WEB-218] fix the thing",
      kind: "chore",
      brief:
        "WEB-218 carries only a title and there is no description on the Jira issue, so we cannot tell what the reporter wants here. " +
        "The right move is to ask the reporter for a spec before any code is written. " +
        "Until then this task should stay parked and nobody should guess at requirements.",
    });
    expect(res.status).toBe(400);
    expect(String((await res.json()).error)).toContain("mirror task");
  } finally {
    server.stop();
  }
});

// WEB-113 shape: both sides substantial and consistent. Stays quiet.
test("allows a substantial brief that does not claim the spec is missing", async () => {
  const { db, projectId } = freshDb();
  makeMirror(db, projectId, "WEB-113", "x".repeat(300));
  const { server, post } = serve(db);
  try {
    const res = await post("/api/tasks", {
      project_id: projectId,
      title: "[WEB-113] add the column",
      kind: "chore",
      brief:
        "Add a new text column beside the existing one in the tracker form, save it when the value is a single dash, " +
        "and map it through to the public reader. Rename the old field and stop publishing it. Done when the e2e spec passes.",
    });
    expect(res.status).toBe(201);
  } finally {
    server.stop();
  }
});

// WEB-2 shape: the mirror itself is title-only, so a thin work brief is honest.
test("stays quiet when the mirror brief is itself thin", async () => {
  const { db, projectId } = freshDb();
  makeMirror(db, projectId, "WEB-2", "tweak the footer");
  const { server, post } = serve(db);
  try {
    const res = await post("/api/tasks", {
      project_id: projectId,
      title: "[WEB-2] tweak the footer",
      kind: "chore",
    });
    expect(res.status).toBe(201);
  } finally {
    server.stop();
  }
});

// The false positives the risk check named. This guard REFUSES with a 400, so
// an over-eager match blocks a legitimate filing outright and the caller has no
// way around it. A substantial spec that merely uses the words "no description"
// or "ask the reporter" about the PRODUCT must be accepted.
test("does not fire on a real spec that talks about a missing description in the UI", () => {
  const brief =
    "When the tracker field is empty the card renders no description of the run below the title, which reads as a bug. " +
    "Render the placeholder copy instead, keep the row height fixed, and cover it with a snapshot test in the card spec.";
  expect(thinBriefReason(brief)).toBeNull();
});

test("does not fire on a brief that says there is no need to ask the reporter", () => {
  const brief =
    "The spec is already on the mirror task and it is complete, so there is no need to ask the reporter for a spec here. " +
    "Add the new column to the tracker form, persist a single dash as an empty value, and expose it through the public reader.";
  expect(thinBriefReason(brief)).toBeNull();
});

test("still fires on the real WEB-118 shape", () => {
  const brief =
    "WEB-118 carries only a title and there is no description on the Jira issue, so we cannot tell what the reporter wants. " +
    "The right move is to ask the reporter for a spec before any code is written.";
  expect(thinBriefReason(brief)).not.toBeNull();
});

test("a substantial brief is accepted end to end even when it mentions a missing description", async () => {
  const { db, projectId } = freshDb();
  makeMirror(db, projectId, "WEB-314", "x".repeat(300));
  const { server, post } = serve(db);
  try {
    const res = await post("/api/tasks", {
      project_id: projectId,
      title: "[WEB-314] show placeholder copy on empty cards",
      kind: "chore",
      brief:
        "When the tracker field is empty the card renders no description of the run below the title, which reads as a bug. " +
        "Render the placeholder copy instead, keep the row height fixed, and cover it with a snapshot test in the card spec.",
    });
    expect(res.status).toBe(201);
  } finally {
    server.stop();
  }
});
