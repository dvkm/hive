import { test, expect } from "bun:test";
import { openDb, newId, now, type DB } from "../src/db.ts";
import {
  JiraClient,
  adfToText,
  applyJiraState,
  decideStatusSync,
  jiraConfig,
  jiraStatusToState,
  lastStateChangeAt,
  lastStatusChangeAt,
  stateToJiraStatus,
  syncProjectOnce,
  textToAdf,
  NEEDS_DECISION_LABEL,
  REF_PREFIX,
  type FetchLike,
  type JiraConfig,
} from "../src/intake/jira.ts";

const CFG: JiraConfig = {
  site: "https://acme.atlassian.net",
  email: "bot@acme.com",
  project_key: "WEB",
  enabled: true,
  write: true,
};

function freshDb(): { db: DB; projectId: string } {
  const db = openDb(":memory:");
  const projectId = newId("proj");
  db.query("INSERT INTO projects (id, name, config, created_at) VALUES (?,?,?,?)").run(
    projectId,
    "p",
    JSON.stringify({ jira: { ...CFG } }),
    now()
  );
  return { db, projectId };
}

// A Jira issue with a changelog. `statusAt` is when status last changed.
function issue(opts: {
  key?: string;
  status?: string;
  statusAt?: string;
  created?: string;
  updated?: string;
  labels?: string[];
  assignee?: any;
  summary?: string;
}): any {
  return {
    key: opts.key ?? "WEB-1",
    fields: {
      summary: opts.summary ?? "Do the thing",
      description: null,
      status: { name: opts.status ?? "To Do" },
      assignee: opts.assignee ?? null,
      labels: opts.labels ?? [],
      priority: { name: "Medium" },
      issuetype: { name: "Story" },
      created: opts.created ?? "2026-01-01T00:00:00.000+0000",
      updated: opts.updated ?? "2026-01-01T00:00:00.000+0000",
    },
    changelog: {
      histories: opts.statusAt
        ? [{ created: opts.statusAt, items: [{ field: "status", fromString: "To Do", toString: opts.status }] }]
        : [],
    },
  };
}

// Records every write the sync attempts, so shadow mode is provable.
function makeFetch(issues: any[], calls: string[] = [], failFor?: string, comments: any[] = []): { fetch: FetchLike; calls: string[] } {
  const f = (async (input: any, init?: any) => {
    const u = String(input);
    const method = init?.method ?? "GET";
    if (u.includes("/search/jql")) return new Response(JSON.stringify({ issues, isLast: true }), { status: 200 });
    if (u.includes("/comment") && method === "GET")
      return new Response(JSON.stringify({ comments, total: comments.length }), { status: 200 });
    if (u.includes("/comment") && method === "POST") {
      const body = JSON.parse(init.body);
      calls.push(`POST comment ${body.properties?.[0]?.value ?? "?"}`);
      return new Response(JSON.stringify({ id: "comment-new", ...body }), { status: 201 });
    }
    if (u.includes("/myself")) return new Response(JSON.stringify({ accountId: "acct-1" }), { status: 200 });
    if (u.includes("/transitions") && method === "GET") {
      calls.push("GET transitions");
      if (failFor && u.includes(failFor)) return new Response("boom", { status: 500 });
      return new Response(
        JSON.stringify({
          transitions: [
            { id: "11", to: { name: "To Do" } },
            { id: "21", to: { name: "In Progress" } },
            { id: "31", to: { name: "In Review" } },
            { id: "41", to: { name: "Done" } },
          ],
        }),
        { status: 200 }
      );
    }
    if (u.includes("/transitions") && method === "POST") {
      calls.push(`POST transition ${JSON.parse(init.body).transition.id}`);
      return new Response("", { status: 204 });
    }
    if (u.includes("/assignee")) {
      calls.push(`PUT assignee ${JSON.parse(init.body).accountId ?? "null"}`);
      return new Response("", { status: 204 });
    }
    if (method === "PUT") {
      calls.push(`PUT ${JSON.parse(init.body).update?.labels?.[0] ? Object.keys(JSON.parse(init.body).update.labels[0])[0] : "?"} label`);
      return new Response("", { status: 204 });
    }
    return new Response("{}", { status: 200 });
  }) as FetchLike;
  return { fetch: f, calls };
}

function client(issues: any[], cfg: JiraConfig = CFG, failFor?: string, comments: any[] = []) {
  const { fetch, calls } = makeFetch(issues, [], failFor, comments);
  return { client: new JiraClient(cfg, "tok", fetch), calls };
}

// ------------------------------------------------------------------- mapping
test("status mapping round-trips the four real WEB workflow states", () => {
  expect(jiraStatusToState("To Do")).toBe("queued");
  expect(jiraStatusToState("in progress")).toBe("in_progress"); // case-insensitive
  expect(jiraStatusToState("In Review")).toBe("in_review");
  expect(jiraStatusToState("Done")).toBe("done");
  expect(jiraStatusToState("Blocked")).toBeNull(); // unknown status: never guessed
  expect(stateToJiraStatus("verifying")).toBe("In Review"); // merged != Done to a human
  expect(stateToJiraStatus("needs_decision")).toBeNull(); // carried as a label
  expect(stateToJiraStatus("failed")).toBeNull(); // no Jira meaning
});

test("adfToText flattens the nested description tree", () => {
  const adf = {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "first" }] },
      { type: "paragraph", content: [{ type: "text", text: "second" }] },
    ],
  };
  expect(adfToText(adf).trim()).toBe("first\nsecond");
  expect(adfToText(null)).toBe("");
  expect(adfToText(textToAdf("first\nsecond")).trim()).toBe("first\nsecond");
});

// -------------------------------------------------------------- the conflict
test("agreement short-circuits regardless of timestamps (structural loop prevention)", () => {
  // Both sides already say in_progress, but Jira's clock is far newer. If this
  // returned an action, a sync-driven write would re-fire every single cycle.
  expect(
    decideStatusSync({ jiraState: "in_progress", hiveState: "in_progress", jiraAt: 9_000, hiveAt: 1 })
  ).toBe("none");
});

test("newer status-change timestamp wins", () => {
  expect(decideStatusSync({ jiraState: "done", hiveState: "queued", jiraAt: 500, hiveAt: 100 })).toBe("pull");
  expect(decideStatusSync({ jiraState: "queued", hiveState: "in_review", jiraAt: 100, hiveAt: 500 })).toBe("push");
});

test("ties resolve to Jira, the human-curated side", () => {
  expect(decideStatusSync({ jiraState: "done", hiveState: "queued", jiraAt: 100, hiveAt: 100 })).toBe("pull");
});

test("unmappable and hive-only states never move status", () => {
  expect(decideStatusSync({ jiraState: null, hiveState: "queued", jiraAt: 9, hiveAt: 1 })).toBe("none");
  // needs_decision must not be pushed as a status, and must not be overwritten
  // by Jira merely for having no equivalent.
  expect(decideStatusSync({ jiraState: "queued", hiveState: "needs_decision", jiraAt: 9, hiveAt: 1 })).toBe("none");
  expect(decideStatusSync({ jiraState: "queued", hiveState: "failed", jiraAt: 1, hiveAt: 9 })).toBe("none");
});

// ---------------------------------------------------------------- timestamps
test("lastStatusChangeAt reads the changelog, NOT fields.updated", () => {
  // The regression this guards: a comment or label edit bumps `updated` without
  // touching status. Reading `updated` would let that unrelated edit win a
  // status tiebreak. (This really happened — a write-scope test comment bumped
  // WEB-7's `updated` while its status sat untouched.)
  const i = issue({
    status: "In Progress",
    statusAt: "2026-01-02T00:00:00.000+0000",
    updated: "2026-06-01T00:00:00.000+0000", // much newer, unrelated edit
  });
  expect(lastStatusChangeAt(i)).toBe(Date.parse("2026-01-02T00:00:00.000+0000"));
  expect(lastStatusChangeAt(i)).toBeLessThan(Date.parse(i.fields.updated));
});

test("an issue that never transitioned falls back to its creation time", () => {
  const i = issue({ created: "2026-03-03T00:00:00.000+0000" });
  expect(lastStatusChangeAt(i)).toBe(Date.parse("2026-03-03T00:00:00.000+0000"));
});

test("lastStateChangeAt prefers the newest state_change event over created_at", () => {
  const { db, projectId } = freshDb();
  const id = newId();
  db.query(
    "INSERT INTO tasks (id, project_id, title, state, kind, created_at, updated_at) VALUES (?,?,?,?,?,?,?)"
  ).run(id, projectId, "t", "queued", "ship", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
  expect(lastStateChangeAt(db, id)).toBe(Date.parse("2026-01-01T00:00:00.000Z"));
  db.query("INSERT INTO events (id, task_id, ts, source, type, payload) VALUES (?,?,?,?,?,?)").run(
    newId("evt"), id, "2026-05-05T00:00:00.000Z", "director", "state_change", "{}"
  );
  expect(lastStateChangeAt(db, id)).toBe(Date.parse("2026-05-05T00:00:00.000Z"));
});

// -------------------------------------------------------------- config gates
test("config requires site, email and project_key, and defaults both switches off", () => {
  expect(jiraConfig({})).toBeNull();
  expect(jiraConfig({ jira: { site: "s", email: "e" } })).toBeNull(); // no project_key
  const c = jiraConfig({ jira: { site: "https://x.atlassian.net/", email: "e", project_key: "WEB" } })!;
  expect(c.enabled).toBe(false); // hard no-op until explicitly turned on
  expect(c.write).toBe(false); // shadow by default
  expect(c.site).toBe("https://x.atlassian.net"); // trailing slash trimmed
});

// -------------------------------------------------------------- the bypass
test("applyJiraState refuses to force state on a non-jira task", () => {
  const { db, projectId } = freshDb();
  const id = newId();
  db.query(
    "INSERT INTO tasks (id, project_id, title, state, kind, created_at, updated_at) VALUES (?,?,?,?,?,?,?)"
  ).run(id, projectId, "real hive work", "queued", "ship", now(), now());
  const task = db.query("SELECT * FROM tasks WHERE id = ?").get(id) as any;
  expect(() => applyJiraState(db, task, "done", "nope")).toThrow(/non-jira task/);
  expect((db.query("SELECT state FROM tasks WHERE id = ?").get(id) as any).state).toBe("queued");
});

test("applyJiraState mirrors an illegal-in-hive jump in one tagged event", () => {
  const { db, projectId } = freshDb();
  const id = newId();
  db.query(
    "INSERT INTO tasks (id, project_id, title, state, kind, source, source_ref, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)"
  ).run(id, projectId, "[WEB-1] x", "queued", "ship", "external", REF_PREFIX + "WEB-1", now(), now());
  const task = db.query("SELECT * FROM tasks WHERE id = ?").get(id) as any;
  // queued -> done is NOT a legal hive transition, but is one human click in Jira.
  applyJiraState(db, task, "done", "jira WEB-1 -> Done");
  expect((db.query("SELECT state FROM tasks WHERE id = ?").get(id) as any).state).toBe("done");
  const evs = db.query("SELECT * FROM events WHERE task_id = ? AND type = 'state_change'").all(id) as any[];
  expect(evs.length).toBe(1); // one event, not a four-hop walk
  expect(evs[0].source).toBe("jira-sync");
  expect(JSON.parse(evs[0].payload)).toMatchObject({ from: "queued", to: "done" });
});

// ------------------------------------------------------------ the sync cycle
test("import creates a tracking-only task carrying the Jira status", async () => {
  const { db, projectId } = freshDb();
  const { client: c } = client([issue({ key: "WEB-3", status: "In Progress", statusAt: "2026-02-02T00:00:00.000+0000" })]);
  const stats = await syncProjectOnce(db, projectId, CFG, c);
  expect(stats.imported).toBe(1);
  const t = db.query("SELECT * FROM tasks WHERE source_ref = ?").get(REF_PREFIX + "WEB-3") as any;
  expect(t.state).toBe("in_progress");
  expect(t.source).toBe("external"); // tracking-only: dispatcher skips, evidence gate skipped
  expect(t.title).toBe("[WEB-3] Do the thing");
});

test("import is idempotent — a second cycle imports nothing and writes nothing", async () => {
  const { db, projectId } = freshDb();
  const iss = [issue({ key: "WEB-3", status: "To Do" })];
  const a = client(iss);
  await syncProjectOnce(db, projectId, CFG, a.client);
  const b = client(iss);
  const stats = await syncProjectOnce(db, projectId, CFG, b.client);
  expect(stats.imported).toBe(0);
  expect(b.calls).toEqual([]); // converged: no outbound calls at all
  expect((db.query("SELECT COUNT(*) n FROM tasks").get() as any).n).toBe(1);
});

test("Jira comments import once into the task timeline", async () => {
  const { db, projectId } = freshDb();
  const comments = [{
    id: "10001",
    author: { displayName: "David" },
    created: "2026-08-18T12:00:00.000Z",
    body: textToAdf("please ship this"),
    properties: [],
  }];
  const iss = [issue({ key: "WEB-3" })];
  expect((await syncProjectOnce(db, projectId, CFG, client(iss, CFG, undefined, comments).client)).comments_pulled).toBe(1);
  expect((await syncProjectOnce(db, projectId, CFG, client(iss, CFG, undefined, comments).client)).comments_pulled).toBe(0);
  const task = db.query("SELECT id FROM tasks WHERE source_ref = ?").get(REF_PREFIX + "WEB-3") as any;
  const rows = db.query("SELECT source, payload FROM events WHERE task_id = ? AND type = 'jira_comment'").all(task.id) as any[];
  expect(rows).toHaveLength(1);
  expect(rows[0].source).toBe("jira");
  expect(JSON.parse(rows[0].payload)).toMatchObject({ jira_id: "10001", author: "David", text: "please ship this" });
});

test("a Hive comment reaches Jira once and carries a crash-safe event marker", async () => {
  const { db, projectId } = freshDb();
  const iss = [issue({ key: "WEB-3" })];
  await syncProjectOnce(db, projectId, CFG, client(iss).client);
  const task = db.query("SELECT id FROM tasks WHERE source_ref = ?").get(REF_PREFIX + "WEB-3") as any;
  const eventId = newId("evt");
  db.query("INSERT INTO events (id, task_id, ts, source, type, payload) VALUES (?,?,?,?,?,?)").run(
    eventId, task.id, now(), "director", "jira_comment", JSON.stringify({ direction: "outbound", text: "looks good" })
  );

  const first = client(iss);
  expect((await syncProjectOnce(db, projectId, CFG, first.client)).comments_pushed).toBe(1);
  expect(first.calls).toContain(`POST comment ${eventId}`);

  const second = client(iss);
  expect((await syncProjectOnce(db, projectId, CFG, second.client)).comments_pushed).toBe(0);
  expect(second.calls.some((call) => call.startsWith("POST comment"))).toBe(false);
});

test("a remote Hive marker repairs a missing local comment receipt without reposting", async () => {
  const { db, projectId } = freshDb();
  const iss = [issue({ key: "WEB-3" })];
  await syncProjectOnce(db, projectId, CFG, client(iss).client);
  const task = db.query("SELECT id FROM tasks WHERE source_ref = ?").get(REF_PREFIX + "WEB-3") as any;
  const eventId = newId("evt");
  db.query("INSERT INTO events (id, task_id, ts, source, type, payload) VALUES (?,?,?,?,?,?)").run(
    eventId, task.id, now(), "director", "jira_comment", JSON.stringify({ direction: "outbound", text: "already sent" })
  );
  const remote = [{ id: "10002", body: textToAdf("already sent"), properties: [{ key: "hive.event_id", value: eventId }] }];
  const run = client(iss, CFG, undefined, remote);
  expect((await syncProjectOnce(db, projectId, CFG, run.client)).comments_pushed).toBe(0);
  expect(run.calls.some((call) => call.startsWith("POST comment"))).toBe(false);
  expect((db.query("SELECT COUNT(*) n FROM events WHERE task_id = ? AND type = 'jira_sync' AND json_extract(payload, '$.action') = 'comment_push'").get(task.id) as any).n).toBe(1);
});

test("JIRA -> hive: a status change upstream pulls onto the mirrored task", async () => {
  const { db, projectId } = freshDb();
  await syncProjectOnce(db, projectId, CFG, client([issue({ key: "WEB-3", status: "To Do" })]).client);
  // Human moves it To Do -> Done in Jira, well after hive's own last change.
  const moved = issue({ key: "WEB-3", status: "Done", statusAt: "2030-01-01T00:00:00.000+0000" });
  const stats = await syncProjectOnce(db, projectId, CFG, client([moved]).client);
  expect(stats.pulled).toBe(1);
  const t = db.query("SELECT * FROM tasks WHERE source_ref = ?").get(REF_PREFIX + "WEB-3") as any;
  expect(t.state).toBe("done");
});

test("hive -> JIRA: a newer hive state pushes a real transition", async () => {
  const { db, projectId } = freshDb();
  await syncProjectOnce(db, projectId, CFG, client([issue({ key: "WEB-3", status: "To Do" })]).client);
  const t = db.query("SELECT * FROM tasks WHERE source_ref = ?").get(REF_PREFIX + "WEB-3") as any;
  // hive side moves now (newer than the Jira issue's 2026 creation).
  db.query("UPDATE tasks SET state = 'in_review' WHERE id = ?").run(t.id);
  db.query("INSERT INTO events (id, task_id, ts, source, type, payload) VALUES (?,?,?,?,?,?)").run(
    newId("evt"), t.id, "2030-06-06T00:00:00.000Z", "director", "state_change", JSON.stringify({ to: "in_review" })
  );
  const { client: c, calls } = client([issue({ key: "WEB-3", status: "To Do" })]);
  const stats = await syncProjectOnce(db, projectId, CFG, c);
  expect(stats.pushed).toBe(1);
  expect(calls).toContain("POST transition 31"); // 31 = In Review
});

test("shadow mode (write:false) computes the push but sends nothing", async () => {
  const { db, projectId } = freshDb();
  const shadow: JiraConfig = { ...CFG, write: false };
  await syncProjectOnce(db, projectId, shadow, client([issue({ key: "WEB-3", status: "To Do" })]).client);
  const t = db.query("SELECT * FROM tasks WHERE source_ref = ?").get(REF_PREFIX + "WEB-3") as any;
  db.query("UPDATE tasks SET state = 'in_review' WHERE id = ?").run(t.id);
  db.query("INSERT INTO events (id, task_id, ts, source, type, payload) VALUES (?,?,?,?,?,?)").run(
    newId("evt"), t.id, "2030-06-06T00:00:00.000Z", "director", "state_change", JSON.stringify({ to: "in_review" })
  );
  const { client: c, calls } = client([issue({ key: "WEB-3", status: "To Do" })]);
  const stats = await syncProjectOnce(db, projectId, shadow, c);
  expect(stats.pushed).toBe(0);
  expect(stats.shadow).toBeGreaterThan(0);
  expect(calls).toEqual([]); // nothing reached Jira
  // ...but the intent is logged so the director can read a dry cycle.
  const logged = db
    .query("SELECT payload FROM events WHERE task_id = ? AND type = 'jira_sync'")
    .all(t.id) as any[];
  expect(logged.some((r) => JSON.parse(r.payload).shadow === true)).toBe(true);
});

test("every status overwrite is logged with both sides and the winner", async () => {
  const { db, projectId } = freshDb();
  await syncProjectOnce(db, projectId, CFG, client([issue({ key: "WEB-3", status: "To Do" })]).client);
  const moved = issue({ key: "WEB-3", status: "Done", statusAt: "2030-01-01T00:00:00.000+0000" });
  await syncProjectOnce(db, projectId, CFG, client([moved]).client);
  const t = db.query("SELECT * FROM tasks WHERE source_ref = ?").get(REF_PREFIX + "WEB-3") as any;
  const row = (db.query("SELECT payload FROM events WHERE task_id = ? AND type = 'jira_sync'").all(t.id) as any[])
    .map((r) => JSON.parse(r.payload))
    .find((p) => p.action === "pull");
  expect(row).toMatchObject({ issue: "WEB-3", field: "status", winner: "jira", from: "queued", to: "done" });
  expect(row.jira_at).toBeTruthy();
  expect(row.hive_at).toBeTruthy();
});

test("needs_decision is added and removed as a label, never as a status", async () => {
  const { db, projectId } = freshDb();
  await syncProjectOnce(db, projectId, CFG, client([issue({ key: "WEB-3", status: "To Do" })]).client);
  const t = db.query("SELECT * FROM tasks WHERE source_ref = ?").get(REF_PREFIX + "WEB-3") as any;
  db.query("UPDATE tasks SET state = 'needs_decision' WHERE id = ?").run(t.id);

  const add = client([issue({ key: "WEB-3", status: "To Do" })]);
  const s1 = await syncProjectOnce(db, projectId, CFG, add.client);
  expect(s1.labeled).toBe(1);
  expect(add.calls).toContain("PUT add label");
  expect(add.calls.some((c) => c.startsWith("POST transition"))).toBe(false); // status untouched

  // Once the label is present upstream and hive still says needs_decision, it converges.
  const settled = client([issue({ key: "WEB-3", status: "To Do", labels: [NEEDS_DECISION_LABEL] })]);
  expect((await syncProjectOnce(db, projectId, CFG, settled.client)).labeled).toBe(0);
  expect(settled.calls).toEqual([]);

  // Decision answered -> hive leaves needs_decision -> label is removed.
  db.query("UPDATE tasks SET state = 'in_progress' WHERE id = ?").run(t.id);
  const rm = client([issue({ key: "WEB-3", status: "In Progress", labels: [NEEDS_DECISION_LABEL] })]);
  await syncProjectOnce(db, projectId, CFG, rm.client);
  expect(rm.calls).toContain("PUT remove label");
});

test("assignee sync clears only Hive's own marker and never a human", async () => {
  const own = freshDb();
  const ownRun = client([issue({ key: "WEB-3", status: "Done", assignee: { accountId: "acct-1" } })]);
  await syncProjectOnce(own.db, own.projectId, CFG, ownRun.client);
  expect(ownRun.calls).toContain("PUT assignee null");

  const human = freshDb();
  const humanRun = client([issue({ key: "WEB-3", status: "Done", assignee: { accountId: "human-1" } })]);
  await syncProjectOnce(human.db, human.projectId, CFG, humanRun.client);
  expect(humanRun.calls.some((call) => call.startsWith("PUT assignee"))).toBe(false);
});

test("JIRA-owned fields flow to hive and are never written back", async () => {
  const { db, projectId } = freshDb();
  await syncProjectOnce(db, projectId, CFG, client([issue({ key: "WEB-3", summary: "old" })]).client);
  const renamed = client([issue({ key: "WEB-3", summary: "renamed upstream" })]);
  await syncProjectOnce(db, projectId, CFG, renamed.client);
  const t = db.query("SELECT * FROM tasks WHERE source_ref = ?").get(REF_PREFIX + "WEB-3") as any;
  expect(t.title).toBe("[WEB-3] renamed upstream");
  expect(renamed.calls).toEqual([]); // summary is JIRA-owned: no write back
});

test("a failing outbound write is isolated: the rest of the cycle still runs", async () => {
  const { db, projectId } = freshDb();
  // Import two issues first so both are linked.
  await syncProjectOnce(db, projectId, CFG, client([issue({ key: "WEB-1" }), issue({ key: "WEB-2" })]).client);
  // Both now need a push (hive moved more recently than either Jira issue).
  for (const key of ["WEB-1", "WEB-2"]) {
    const t = db.query("SELECT * FROM tasks WHERE source_ref = ?").get(REF_PREFIX + key) as any;
    db.query("UPDATE tasks SET state = 'in_review' WHERE id = ?").run(t.id);
    db.query("INSERT INTO events (id, task_id, ts, source, type, payload) VALUES (?,?,?,?,?,?)").run(
      newId("evt"), t.id, "2030-06-06T00:00:00.000Z", "director", "state_change", JSON.stringify({ to: "in_review" })
    );
  }
  // WEB-1's transition endpoint is down; WEB-2's is fine.
  const { client: c, calls } = client([issue({ key: "WEB-1" }), issue({ key: "WEB-2" })], CFG, "WEB-1");
  const stats = await syncProjectOnce(db, projectId, CFG, c, { log: () => {} });
  expect(stats.errors).toBe(1); // WEB-1 failed
  expect(stats.pushed).toBe(1); // WEB-2 still went through
  expect(calls).toContain("POST transition 31");
});

test("a malformed issue payload degrades instead of throwing", async () => {
  const { db, projectId } = freshDb();
  const bad = issue({ key: "WEB-2" });
  bad.fields = null; // every field access is optional-chained, so this must not throw
  const stats = await syncProjectOnce(db, projectId, CFG, client([bad, issue({ key: "WEB-1" })]).client, { log: () => {} });
  expect(stats.errors).toBe(0);
  expect(stats.imported).toBe(2);
  const t = db.query("SELECT * FROM tasks WHERE source_ref = ?").get(REF_PREFIX + "WEB-2") as any;
  expect(t.title).toBe("[WEB-2] (no summary)");
  expect(t.state).toBe("queued"); // unmappable status falls back to queued
});
