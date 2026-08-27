// The HTTP surface a director's board reads for a mirrored Jira ticket.
//
// The point of these endpoints is that nobody has to GUESS whether the sync
// ran, so the tests assert what the board would actually display: the ticket
// link, a persistent error, what is still queued, and that manual retry is the
// same code path as the timer rather than a second one.
import { test, expect, afterAll, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "hive-jira-api-"));
process.env.HIVE_HOME = HOME;

const { openDb, newId, now } = await import("../src/db.ts");
const { makeHandler, openRecoveryDecision } = await import("../src/api.ts");
const J = await import("../src/intake/jira.ts");

let db = openDb(":memory:");
let handler = makeHandler(db);
const server = Bun.serve({ port: 0, fetch: (request) => handler(request) });
const BASE = `http://127.0.0.1:${server.port}`;
afterAll(() => server.stop(true));
beforeEach(() => {
  db.close();
  db = openDb(":memory:");
  handler = makeHandler(db);
  seq = 0;
});

const get = async (p: string) => {
  const r = await fetch(BASE + p);
  return { status: r.status, json: (await r.json()) as any };
};
const post = async (p: string) => {
  const r = await fetch(BASE + p, { method: "POST" });
  return { status: r.status, json: (await r.json()) as any };
};
const postJson = async (p: string, body: unknown) => {
  const r = await fetch(BASE + p, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json()) as any };
};

// tasks.source_ref carries a UNIQUE index, so each seeded project needs its own
// issue key — the mirror link is one-to-one by construction.
let seq = 0;
function seed(jira?: Record<string, unknown>): { projectId: string; jiraTask: string; plainTask: string; key: string } {
  const projectId = newId("proj");
  const key = `WEB-${++seq}`;
  db.query("INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)").run(
    projectId, "p", "/repo", JSON.stringify(jira ? { jira } : {}), now()
  );
  const mk = (ref: string | null) => {
    const id = newId();
    db.query(
      "INSERT INTO tasks (id, project_id, title, brief, state, kind, source, source_ref, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
    ).run(id, projectId, "t", "b", "queued", "ship", ref ? "external" : "agent", ref, now(), now());
    return id;
  };
  return { projectId, jiraTask: mk(`jira:${key}`), plainTask: mk(null), key };
}

const CFG = { site: "https://example.atlassian.net", email: "jira@example.com", project_key: "WEB", enabled: true, write: true };

function retryJiraFetch(key: string, comments: (method: string) => Response): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const method = init.method ?? "GET";
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
    if (path === "/rest/api/3/search/jql")
      return json({ issues: [{ key, fields: { status: { name: "To Do" }, updated: "2026-01-01T00:00:00.000Z" } }], isLast: true });
    if (path === `/rest/api/3/issue/${key}`)
      return json({
        key,
        id: "1",
        fields: {
          summary: "ticket",
          description: null,
          created: "2026-01-01T00:00:00.000Z",
          updated: "2026-01-01T00:00:00.000Z",
          status: { name: "To Do" },
          labels: [],
          assignee: { displayName: "Alex Kim" },
          priority: { name: "Medium" },
          issuetype: { name: "Story" },
          project: { key: "WEB" },
        },
      });
    if (path === `/rest/api/3/issue/${key}/changelog`)
      return json({ values: [], startAt: 0, maxResults: 100, total: 0, isLast: true });
    if (path === `/rest/api/3/issue/${key}/comment`) return comments(method);
    return new Response("unexpected request", { status: 500 });
  }) as unknown as typeof fetch;
}

test("a task with no Jira link reports linked:false rather than inventing a ticket", async () => {
  const { plainTask } = seed(CFG);
  const r = await get(`/api/tasks/${plainTask}/jira`);
  expect(r.status).toBe(200);
  expect(r.json.linked).toBe(false);
});

test("a linked ticket exposes the browse URL and effective write scope", async () => {
  const { jiraTask, key } = seed({ ...CFG, write_scope: { create_subtask: true } });
  db.query("UPDATE tasks SET brief = ? WHERE id = ?").run("Assignee: Alex Kim\n\nTicket", jiraTask);
  const r = await get(`/api/tasks/${jiraTask}/jira`);
  expect(r.json.linked).toBe(true);
  expect(r.json.issue_key).toBe(key);
  expect(r.json.browse_url).toBe(`https://example.atlassian.net/browse/${key}`);
  expect(r.json.enabled).toBe(true);
  expect(r.json.assignee).toBe("Alex Kim");
  expect(r.json.write_scope).toEqual({ ...J.JIRA_WRITE_SCOPE, create_subtask: true });
});

test("a malformed config reports unconfigured, and never echoes that host", async () => {
  // The credential gate refused it, so the board must not imply the site it
  // names is in use — that would make an attacker-supplied host look adopted.
  const { jiraTask } = seed({ ...CFG, site: "https://example.atlassian.net@evil.atlassian.net" });
  const r = await get(`/api/tasks/${jiraTask}/jira`);
  expect(r.json.configured).toBe(false);
  expect(r.json.browse_url).toBeNull();
  expect(JSON.stringify(r.json)).not.toContain("evil.atlassian.net");
});

test("the project payload carries the canonicalized Jira site, never the configured host", async () => {
  // The board card builds its browse chip from the project payload, so this
  // field has to survive the same credential gate the per-task browse_url does.
  const allowed = seed(CFG);
  const evil = seed({ ...CFG, site: "https://example.atlassian.net@evil.atlassian.net" });

  const one = await get(`/api/projects/${allowed.projectId}`);
  expect(one.json.jira_site).toBe("https://example.atlassian.net");

  const bad = await get(`/api/projects/${evil.projectId}`);
  expect(bad.json.jira_site).toBeNull();
  expect(JSON.stringify(bad.json)).not.toContain("evil.atlassian.net/browse");

  const list = await get("/api/projects");
  expect(list.json.find((p: any) => p.id === allowed.projectId).jira_site).toBe("https://example.atlassian.net");
  expect(list.json.find((p: any) => p.id === evil.projectId).jira_site).toBeNull();
});

test("an invalid Jira filter is surfaced through sync state and manual retry", async () => {
  const jql = "labels = sync) OR project = OPS OR (project = WEB";
  const { jiraTask } = seed({ ...CFG, jql });

  // The FIRST read names the invalid setting. Nothing has failed yet, so a
  // board that waited for consecutive_failures to climb would show only
  // "not configured" while the director hunted for a missing setup.
  const state = await get(`/api/tasks/${jiraTask}/jira`);
  expect(state.json.configured).toBe(false);
  expect(state.json.config_error).toContain(`config.jira.jql is invalid: ${JSON.stringify(jql)}`);
  expect(state.json.sync.consecutive_failures).toBe(0);
  expect(state.json.sync.last_error).toContain(`config.jira.jql is invalid: ${JSON.stringify(jql)}`);

  const retry = await post(`/api/tasks/${jiraTask}/jira/sync`);
  expect(retry.status).toBe(502);
  expect(retry.json.error).toContain(`config.jira.jql is invalid: ${JSON.stringify(jql)}`);
});

test("pending outbound work is visible before it is sent, so nobody re-submits it", async () => {
  const { jiraTask } = seed(CFG);
  db.query("INSERT INTO events (id, task_id, ts, source, type, payload) VALUES (?,?,?,?,?,?)").run(
    newId("evt"), jiraTask, now(), "director", "jira_comment",
    JSON.stringify({ direction: "outbound", text: "not sent yet", delivery: "queued" })
  );
  db.query("INSERT INTO evidence (id, task_id, ts, kind, path, url, caption, meta) VALUES (?,?,?,?,?,?,?,'{}')").run(
    newId("ev"), jiraTask, now(), "report", "/tmp/r", "/evidence/x/r.md", "the report"
  );
  const r = await get(`/api/tasks/${jiraTask}/jira`);
  expect(r.json.pending).toEqual({ comments: 1, receipts: 1, unknown: [] });
});

test("legacy comment receipts remain delivered in the Jira task API", async () => {
  const { jiraTask } = seed(CFG);
  const eventId = newId("evt");
  db.query("INSERT INTO events (id, task_id, ts, source, type, payload) VALUES (?,?,?,?,?,?)").run(
    eventId, jiraTask, now(), "director", "jira_comment",
    JSON.stringify({ direction: "outbound", text: "already delivered", delivery: "queued" })
  );
  db.query("INSERT INTO events (id, task_id, ts, source, type, payload) VALUES (?,?,?,?,?,?)").run(
    newId("evt"), jiraTask, now(), "jira-sync", "jira_sync",
    JSON.stringify({ action: "comment_push", event_id: eventId, jira_comment_id: "legacy-42" })
  );

  const response = await get(`/api/tasks/${jiraTask}/jira`);
  expect(response.json.pending).toEqual({ comments: 0, receipts: 0, unknown: [] });
  expect(response.json.delivered).toContainEqual(expect.objectContaining({ event_id: eventId, jira_comment_id: "legacy-42" }));
});

test("an unknown delivery is surfaced and a human can resolve it", async () => {
  const { jiraTask } = seed(CFG);
  const sourceId = newId("evt");
  db.query("INSERT INTO events (id, task_id, ts, source, type, payload) VALUES (?,?,?,?,?,?)").run(
    sourceId, jiraTask, now(), "director", "jira_comment",
    JSON.stringify({ direction: "outbound", text: "maybe landed", delivery: "queued" })
  );
  db.query("INSERT INTO events (id, task_id, ts, source, type, payload) VALUES (?,?,?,?,?,?)").run(
    newId("evt"), jiraTask, now(), "jira-sync", "jira_sync",
    JSON.stringify({ action: "comment_push", source_id: sourceId, text: "maybe landed", outcome: "terminal_unknown", error: "request timed out" })
  );

  const before = await get(`/api/tasks/${jiraTask}/jira`);
  expect(before.json.pending.comments).toBe(1);
  expect(before.json.pending.unknown).toEqual([
    expect.objectContaining({ action: "comment_push", source_id: sourceId, error: "request timed out" }),
  ]);

  const resolved = await postJson(`/api/tasks/${jiraTask}/jira/delivery/resolve`, {
    action: "comment_push",
    source_id: sourceId,
  });
  expect(resolved.status).toBe(200);
  expect(resolved.json.pending).toEqual({ comments: 0, receipts: 0, unknown: [] });
  expect(resolved.json.delivered).toEqual([]);
});

test("a whitespace-only Jira comment is rejected before it enters the outbox", async () => {
  const { jiraTask } = seed(CFG);

  const response = await postJson(`/api/tasks/${jiraTask}/send`, { message: " \n\t " });

  expect(response.status).toBe(400);
  expect(response.json.error).toBe("message is required");
  expect(db.query("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = 'jira_comment'").get(jiraTask)).toEqual({ n: 0 });
});

test("an oversized Jira comment is rejected before it enters the outbox", async () => {
  const { jiraTask } = seed(CFG);

  const response = await postJson(`/api/tasks/${jiraTask}/send`, {
    message: "x".repeat(J.JIRA_COMMENT_MAX_LENGTH + 1),
  });

  expect(response.status).toBe(413);
  expect(response.json.error).toBe(`Jira comments are limited to ${J.JIRA_COMMENT_MAX_LENGTH} characters`);
  expect(db.query("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = 'jira_comment'").get(jiraTask)).toEqual({ n: 0 });
});

test("a persistent sync error is served to the board and survives until a success", async () => {
  const { projectId, jiraTask } = seed(CFG);
  J.writeSyncState(db, projectId, { last_error: "jira GET /search/jql -> 500", consecutive_failures: 3, last_error_at: now() });
  const r = await get(`/api/tasks/${jiraTask}/jira`);
  expect(r.json.sync.last_error).toContain("500");
  expect(r.json.sync.consecutive_failures).toBe(3);

  J.writeSyncState(db, projectId, { last_error: null, consecutive_failures: 0, last_success_at: now() });
  const after = await get(`/api/tasks/${jiraTask}/jira`);
  expect(after.json.sync.last_error).toBeNull();
});

test("manual retry reports the real failure instead of a cheerful 200", async () => {
  // A retry button that always says "done" is worse than no button: it teaches
  // the director the sync is fine when it is not.
  const { jiraTask } = seed({ ...CFG, enabled: false });
  const r = await post(`/api/tasks/${jiraTask}/jira/sync`);
  expect(r.status).toBe(502);
  expect(r.json.ok).toBe(false);
  expect(String(r.json.error)).toContain("disabled");
});

test("a definite Jira rejection stays retryable after credentials recover", async () => {
  const { jiraTask, key } = seed(CFG);
  db.query("INSERT INTO events (id, task_id, ts, source, type, payload) VALUES (?,?,?,?,?,?)").run(
    newId("evt"), jiraTask, now(), "director", "jira_comment",
    JSON.stringify({ direction: "outbound", text: "fail visibly", delivery: "queued" })
  );
  let rejected = true;
  const jiraFetch = retryJiraFetch(key, (method) => method === "POST"
    ? rejected
      ? new Response("credentials rejected", { status: 403 })
      : new Response(JSON.stringify({ id: "posted-after-recovery" }), { status: 200 })
    : new Response(JSON.stringify({ comments: [], startAt: 0, maxResults: 100, total: 0 }), { status: 200 }));
  const retryServer = Bun.serve({ port: 0, fetch: makeHandler(db, { jira: { fetch: jiraFetch, token: "tok" } }) });
  try {
    const response = await fetch(`http://127.0.0.1:${retryServer.port}/api/tasks/${jiraTask}/jira/sync`, { method: "POST" });
    const body = await response.json() as any;
    expect(response.status).toBe(502);
    expect(body.ok).toBe(false);
    expect(body.error).toContain(`${key} comment_push`);
    expect(body.error).toContain("403 credentials rejected");
    const failedState = await (await fetch(`http://127.0.0.1:${retryServer.port}/api/tasks/${jiraTask}/jira`)).json() as any;
    expect(failedState.pending).toEqual({ comments: 1, receipts: 0, unknown: [] });

    rejected = false;
    const recovered = await fetch(`http://127.0.0.1:${retryServer.port}/api/tasks/${jiraTask}/jira/sync`, { method: "POST" });
    expect(recovered.status).toBe(200);
    const recoveredState = await (await fetch(`http://127.0.0.1:${retryServer.port}/api/tasks/${jiraTask}/jira`)).json() as any;
    expect(recoveredState.pending).toEqual({ comments: 0, receipts: 0, unknown: [] });
  } finally {
    retryServer.stop(true);
  }
});

test("a rejected tracking-only recovery answer leaves its card open", async () => {
  const { jiraTask } = seed(CFG);
  const source = db.query("SELECT * FROM tasks WHERE id = ?").get(jiraTask) as any;
  const decision = openRecoveryDecision(db, source, 2);
  const taskCount = (db.query("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n;

  const response = await postJson(`/api/decisions/${decision.id}/answer`, { answer_key: "requeue", source: "director" });

  expect(response.status).toBe(409);
  expect(response.json.error).toContain("mirrored Jira task");
  expect((db.query("SELECT status FROM decisions WHERE id = ?").get(decision.id) as any).status).toBe("open");
  expect(db.query("SELECT 1 FROM events WHERE type = 'decision_answered' AND json_extract(payload, '$.decision_id') = ?").get(decision.id)).toBeFalsy();
  expect((db.query("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n).toBe(taskCount);
});

test("manual retry returns 502 when the comment list read fails", async () => {
  const { jiraTask, key } = seed(CFG);
  const jiraFetch = retryJiraFetch(key, () => new Response("comment read exploded", { status: 500 }));
  const retryServer = Bun.serve({ port: 0, fetch: makeHandler(db, { jira: { fetch: jiraFetch, token: "tok" } }) });
  try {
    const response = await fetch(`http://127.0.0.1:${retryServer.port}/api/tasks/${jiraTask}/jira/sync`, { method: "POST" });
    const body = await response.json() as any;
    expect(response.status).toBe(502);
    expect(body.ok).toBe(false);
    expect(body.error).toContain(`${key}: jira GET`);
    expect(body.error).toContain("500 comment read exploded");
  } finally {
    retryServer.stop(true);
  }
});

test("manual retry treats incomplete comment pagination as an operational failure", async () => {
  const { jiraTask, key } = seed(CFG);
  const jiraFetch = retryJiraFetch(key, () => new Response(JSON.stringify({ comments: [] }), { status: 200 }));
  const retryServer = Bun.serve({ port: 0, fetch: makeHandler(db, { jira: { fetch: jiraFetch, token: "tok" } }) });
  try {
    const response = await fetch(`http://127.0.0.1:${retryServer.port}/api/tasks/${jiraTask}/jira/sync`, { method: "POST" });
    const body = await response.json() as any;
    expect(response.status).toBe(502);
    expect(body.ok).toBe(false);
    expect(body.error).toContain(`${key}: incomplete Jira comment history`);
  } finally {
    retryServer.stop(true);
  }
});

test("manual retry returns 502 with the operational issue read failure", async () => {
  const { jiraTask, key } = seed(CFG);
  const jiraFetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname === "/rest/api/3/search/jql")
      return new Response(JSON.stringify({ issues: [{ key }], isLast: true }), { status: 200 });
    if (url.pathname === `/rest/api/3/issue/${key}`)
      return new Response("read exploded", { status: 500 });
    return new Response("unexpected request", { status: 500 });
  }) as unknown as typeof fetch;
  const retryServer = Bun.serve({ port: 0, fetch: makeHandler(db, { jira: { fetch: jiraFetch, token: "tok" } }) });
  try {
    const response = await fetch(`http://127.0.0.1:${retryServer.port}/api/tasks/${jiraTask}/jira/sync`, { method: "POST" });
    const body = await response.json() as any;
    expect(response.status).toBe(502);
    expect(body.ok).toBe(false);
    expect(body.error).toContain(`${key}: jira GET`);
    expect(body.error).toContain("500 read exploded");
  } finally {
    retryServer.stop(true);
  }
});

test("manual retry refuses a task that is not linked to Jira", async () => {
  const { plainTask } = seed(CFG);
  const r = await post(`/api/tasks/${plainTask}/jira/sync`);
  expect(r.status).toBe(400);
});
