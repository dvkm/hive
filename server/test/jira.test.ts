// JIRA <-> hive bidirectional sync.
//
// These tests drive a fake HTTP layer rather than a fake JiraClient, so the real
// client is exercised: the Basic auth header, JQL construction, changelog
// paging, and the transition-id lookup are all under test, not mocked around.
//
// The fake deliberately models the two things a hand-built fixture normally
// cannot express, because they are where this connector's real bugs lived:
//   * the search index is SEPARATE from issue storage, so it can lag or lie
//     (`visible` controls what search returns, independently of the issues);
//   * time moves BETWEEN calls (`onRead` fires per per-issue read, so a test can
//     have a human move an issue mid-cycle).
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "hive-jira-"));
process.env.HIVE_HOME = HOME;

const { openDb, newId, now, setSetting } = await import("../src/db.ts");
const { writeEvent, transition } = await import("../src/state.ts");
const { addClient, removeClient } = await import("../src/bus.ts");
const J = await import("../src/intake/jira.ts");
const { TASK_PRIORITIES } = await import("../src/api.ts");
import type { DB } from "../src/db.ts";

const SITE = "https://example.atlassian.net";
const EMAIL = "jira@example.com";
const SELF = "acct-hive-sync";
const HUMAN = "acct-a-real-person";

const CFG = {
  site: SITE, email: EMAIL, project_key: "WEB", enabled: true, write: true,
};
const SCOPE_ABSENCE_SOURCE = "jira-scope-absent";

// ---------------------------------------------------------------- fake jira
interface FakeIssue {
  key: string;
  id: unknown;
  status: string;
  labels?: string[];
  assignee?: string | null;
  projectKey?: string | null; // defaults to WEB; null omits the field
  summary?: string;
  description?: any;
  properties?: Record<string, unknown>;
  parentKey?: string | null;
  created?: string | null;
  updated?: string;
  priority?: string | null; // Jira priority NAME; null = no priority set
  history?: { at: string; to: string }[]; // status transitions, oldest first
  rawHistory?: any[] | null;
  attachments?: { id: string; filename: string }[];
  comments?: { id?: string; author?: string; text?: string; created?: string; properties?: { key: string; value: unknown }[]; raw?: any }[];
}

interface FakeOpts {
  issues: FakeIssue[];
  visible?: string[]; // what SEARCH returns; defaults to every issue's key
  discoverPages?: number;
  jqlOnly?: string[]; // what the reconcileIssues membership probe returns
  failSearch?: boolean;
  failRead?: string[];
  missingRead?: string[];
  emptyRead?: string[];
  invalidJsonRead?: string[];
  omitIssueFields?: string[];
  failChangelog?: string[];
  failJqlProbe?: boolean;
  missingJqlProbe?: boolean;
  discoveryRows?: any[];
  scopeRows?: any[];
  failComments?: string[];
  missingComments?: string[];
  failCommentPosts?: number;
  failAttachmentPosts?: boolean;
  rejectCommentPosts?: number;
  rejectCommentStatus?: number;
  commentPostResponse?: any;
  throwCommentPosts?: number;
  commentPageCap?: number; // simulate a server-side page cap, to exercise fail-closed
  emptyCommentPageAt?: number;
  commentTotalAt?: Record<number, number>;
  omitDiscoveryPagination?: boolean;
  omitChangelogPagination?: boolean;
  omitCommentPagination?: boolean;
  myself?: "fail" | "missing";
  onRead?: (key: string, issue: Required<FakeIssue>, nth: number) => void; // time moves here
  beforeChangelog?: (key: string, issue: FakeIssue, nth: number) => void;
  onChangelog?: (key: string, issue: FakeIssue, nth: number) => void;
  onComments?: (key: string, issue: FakeIssue, nth: number) => void;
  onScopeProbe?: (key: string, issue: FakeIssue, nth: number) => void;
  onCreate?: () => void;
  failDelete?: boolean;
}

function fakeJira(opts: FakeOpts) {
  const byKey = new Map(opts.issues.map((i) => [i.key, { labels: [], assignee: null, projectKey: "WEB", summary: "s", description: null, properties: {}, parentKey: null, created: "2026-01-01T00:00:00.000Z", updated: "2026-01-01T00:00:00.000Z", priority: "Medium", history: [], rawHistory: null, comments: [], attachments: [], ...i } as Required<FakeIssue>]));
  const calls: { method: string; path: string; body?: any }[] = [];
  const reads = new Map<string, number>();
  const changelogReads = new Map<string, number>();
  const commentReads = new Map<string, number>();
  const scopeReads = new Map<string, number>();
  let remainingCommentFailures = opts.failCommentPosts ?? 0;
  let remainingCommentRejections = opts.rejectCommentPosts ?? 0;
  let remainingCommentThrows = opts.throwCommentPosts ?? 0;

  const fetchImpl = (async (url: string, init: any = {}) => {
    const u = new URL(String(url));
    const method = (init.method ?? "GET").toUpperCase();
    const path = u.pathname;
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: path + u.search, body });

    // Auth is asserted on EVERY call: a request that reached the network
    // without the expected Basic header is a bug worth failing loudly on.
    const expected = "Basic " + Buffer.from(`${EMAIL}:tok`).toString("base64");
    if (init.headers?.Authorization !== expected) return new Response("bad auth", { status: 401 });

    const json = (o: any, status = 200) => new Response(JSON.stringify(o), { status });

    if (path === "/rest/api/3/myself") {
      if (opts.myself === "fail") return new Response("boom", { status: 500 });
      return json(opts.myself === "missing" ? {} : { accountId: SELF });
    }

    if (path === "/rest/api/3/issue" && method === "POST") {
      opts.onCreate?.();
      return json({ id: "99", key: "WEB-99" }, 201);
    }

    if (path === "/rest/api/3/search/jql") {
      if (opts.failSearch) return new Response("boom", { status: 500 });
      const recon = u.searchParams.get("reconcileIssues");
      if (recon) {
        if (opts.missingJqlProbe) return new Response("not found", { status: 404 });
        if (opts.failJqlProbe) return new Response("boom", { status: 500 });
        const key = /\bkey\s*=\s*([A-Z][A-Z0-9_]*-\d+)\b/i.exec(u.searchParams.get("jql") ?? "")?.[1];
        if (key && byKey.has(key)) {
          const n = (scopeReads.get(key) ?? 0) + 1;
          scopeReads.set(key, n);
          opts.onScopeProbe?.(key, byKey.get(key)!, n);
        }
        if (opts.scopeRows) return json({ issues: opts.scopeRows, isLast: true });
        const projectOnly = /^\(project = WEB\) AND key =/i.test(u.searchParams.get("jql") ?? "");
        const allow = (projectOnly ? [...byKey.keys()] : opts.jqlOnly ?? [...byKey.keys()])
          .filter((candidate) => byKey.get(candidate)?.projectKey === "WEB");
        const matches = key ? allow.filter((k) => k === key) : allow;
        const page = Number(u.searchParams.get("nextPageToken") ?? 0);
        const start = page * 100;
        const issues = matches.slice(start, start + 100).map((k) => ({
          key: k,
          fields: { status: { name: byKey.get(k)?.status }, updated: byKey.get(k)?.updated },
        }));
        const isLast = start + issues.length >= matches.length;
        return json({ issues, isLast, ...(isLast ? {} : { nextPageToken: String(page + 1) }) });
      }
      if (opts.discoveryRows) return json({ issues: opts.discoveryRows, isLast: true });
      if (opts.discoverPages) {
        const page = Number(u.searchParams.get("nextPageToken") ?? 0);
        const isLast = page + 1 >= opts.discoverPages;
        return json({ issues: [], isLast, ...(isLast ? {} : { nextPageToken: String(page + 1) }) });
      }
      const vis = opts.visible ?? [...byKey.keys()];
      if (opts.omitDiscoveryPagination) return json({ issues: vis.map((k) => ({ key: k })) });
      return json({ issues: vis.map((k) => ({ key: k })), isLast: true });
    }

    const m = path.match(/^\/rest\/api\/3\/issue\/([^/]+)(\/(\w+))?$/);
    if (m) {
      const key = decodeURIComponent(m[1]);
      const sub = m[3];
      if (sub === "remotelink" && method === "POST")
        return new Response(null, { status: 201 });
      if (!sub && method === "DELETE") return opts.failDelete
        ? new Response("delete failed", { status: 500 })
        : new Response(null, { status: 204 });
      const iss = byKey.get(key);
      if (!iss) return new Response("not found", { status: 404 });

      if (!sub) {
        if (method === "GET") {
          if (opts.missingRead?.includes(key)) return new Response("not found", { status: 404 });
          if (opts.failRead?.includes(key)) return new Response("nope", { status: 500 });
          if (opts.emptyRead?.includes(key)) return new Response(null, { status: 204 });
          if (opts.invalidJsonRead?.includes(key)) return new Response("not-json", { status: 200 });
          const n = (reads.get(key) ?? 0) + 1;
          reads.set(key, n);
          opts.onRead?.(key, iss, n); // the world may move between reads
          const fields: Record<string, unknown> = {
            summary: iss.summary, description: iss.description, created: iss.created, updated: iss.updated,
            status: { name: iss.status }, labels: [...iss.labels],
            assignee: iss.assignee ? { accountId: iss.assignee } : null,
            priority: iss.priority == null ? null : { name: iss.priority }, issuetype: { name: "Story" },
            project: iss.projectKey == null ? undefined : { key: iss.projectKey },
            parent: iss.parentKey ? { key: iss.parentKey } : null,
            attachment: iss.attachments.map((a) => ({ id: a.id, filename: a.filename })),
          };
          for (const field of opts.omitIssueFields ?? []) delete fields[field];
          return json({ key, id: iss.id, fields, properties: iss.properties });
        }
        if (method === "PUT") {
          for (const op of body?.update?.labels ?? []) {
            if (op.add && !iss.labels.includes(op.add)) iss.labels.push(op.add);
            if (op.remove) iss.labels = iss.labels.filter((l) => l !== op.remove);
          }
          return new Response(null, { status: 204 });
        }
      }
      if (sub === "changelog") {
        if (opts.failChangelog?.includes(key)) return new Response("nope", { status: 500 });
        const startAt = Number(u.searchParams.get("startAt") ?? 0);
        // Real Jira caps the page server-side regardless of what you ask for.
        // Modelling that is the whole point: it is what forces the paging loop.
        const max = Math.min(Number(u.searchParams.get("maxResults") ?? 100), 20);
        const n = (changelogReads.get(key) ?? 0) + 1;
        changelogReads.set(key, n);
        opts.beforeChangelog?.(key, iss, n);
        const all = iss.rawHistory ?? iss.history.map((h) => ({ created: h.at, items: [{ field: "status", toString: h.to }] }));
        const page = all.slice(startAt, startAt + max);
        opts.onChangelog?.(key, iss, n);
        if (opts.omitChangelogPagination) return json({ values: page });
        return json({ values: page, startAt, maxResults: max, total: all.length, isLast: startAt + page.length >= all.length });
      }
      if (sub === "comment") {
        if (opts.missingComments?.includes(key)) return new Response("not found", { status: 404 });
        if (opts.failComments?.includes(key)) return new Response("nope", { status: 500 });
        if (method === "POST") {
          if (remainingCommentThrows > 0) {
            remainingCommentThrows--;
            throw new TypeError("connection reset");
          }
          if (remainingCommentRejections > 0) {
            remainingCommentRejections--;
            return new Response("comment rejected", { status: opts.rejectCommentStatus ?? 401 });
          }
          const id = `c${iss.comments.length + 1}-${key}`;
          if (remainingCommentFailures > 0) {
            remainingCommentFailures--;
            iss.comments = [...iss.comments, {
              id, author: "Hive", text: JSON.parse(init.body).body.content.map((n: any) => (n.content ?? []).map((t: any) => t.text).join("")).join("\n"),
              created: "2026-06-01T00:00:00.000Z", properties: body.properties,
            }];
            return new Response("comment exploded", { status: 500 });
          }
          iss.comments = [...iss.comments, {
            id, author: "Hive", text: JSON.parse(init.body).body.content.map((n: any) => (n.content ?? []).map((t: any) => t.text).join("")).join("\n"),
            created: "2026-06-01T00:00:00.000Z", properties: body.properties,
          }];
          return json(opts.commentPostResponse ?? { id });
        }
        const startAt = Number(u.searchParams.get("startAt") ?? 0);
        const n = (commentReads.get(key) ?? 0) + 1;
        commentReads.set(key, n);
        opts.onComments?.(key, iss, n);
        // Real Jira caps the page server-side; modelling it is what exercises
        // the fail-closed path rather than the happy path.
        const max = Math.min(Number(u.searchParams.get("maxResults") ?? 100), opts.commentPageCap ?? 100);
        const page = iss.comments.slice(startAt, startAt + max).map((comment) => comment.raw ?? ({
          id: comment.id,
          author: comment.author ? { displayName: comment.author } : undefined,
          body: J.textToAdf(comment.text ?? ""),
          created: comment.created,
          properties: comment.properties,
        }));
        if (opts.emptyCommentPageAt === startAt)
          return json({ comments: [], startAt, maxResults: max, total: opts.commentTotalAt?.[startAt] ?? iss.comments.length });
        if (opts.omitCommentPagination) return json({ comments: page });
        return json({ comments: page, startAt, maxResults: max, total: opts.commentTotalAt?.[startAt] ?? iss.comments.length });
      }
      if (sub === "attachments" && method === "POST") {
        if (opts.failAttachmentPosts) return new Response("attachment exploded", { status: 500 });
        if (init.headers?.["X-Atlassian-Token"] !== "no-check")
          return new Response("XSRF check failed", { status: 403 });
        const file = (init.body as FormData).get("file") as File;
        const id = `att${iss.attachments.length + 1}-${key}`;
        iss.attachments = [...iss.attachments, { id, filename: file.name }];
        return json([{ id, filename: file.name, size: file.size }]);
      }
      if (sub === "transitions") {
        if (method === "GET")
          return json({ transitions: ["To Do", "In Progress", "In Review", "Done"].map((n, i) => ({ id: String(i + 1), to: { name: n } })) });
        const names = ["To Do", "In Progress", "In Review", "Done"];
        const to = names[Number(body.transition.id) - 1];
        iss.history = [...iss.history, { at: new Date().toISOString(), to }];
        iss.status = to;
        iss.updated = new Date().toISOString();
        return new Response(null, { status: 204 });
      }
      if (sub === "assignee") {
        iss.assignee = body?.accountId ?? null;
        return new Response(null, { status: 204 });
      }
    }
    return new Response("unhandled " + path, { status: 404 });
  }) as unknown as typeof fetch;

  const writes = () => calls.filter((c) => c.method !== "GET");
  return { fetchImpl, calls, writes, byKey };
}

// ---------------------------------------------------------------- db helpers
function freshDb(jira?: any): { db: DB; projectId: string } {
  const db = openDb(":memory:");
  const projectId = newId("proj");
  db.query("INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)").run(
    projectId, "p", "/repo", JSON.stringify(jira ? { jira } : {}), now()
  );
  return { db, projectId };
}

function client(fetchImpl: typeof fetch, cfg: any = CFG) {
  return new J.JiraClient(J.jiraConfig({ jira: cfg })!, "tok", fetchImpl);
}

const run = (db: DB, projectId: string, f: typeof fetch, cfg: any = CFG, deps: any = {}) =>
  J.syncProjectOnce(db, projectId, J.jiraConfig({ jira: cfg })!, client(f, cfg), deps);

const tasks = (db: DB) => db.query("SELECT * FROM tasks ORDER BY created_at").all() as any[];
const syncEvents = (db: DB) =>
  (db.query("SELECT payload FROM events WHERE type = 'jira_sync' ORDER BY ts, id").all() as { payload: string }[])
    .map((r) => JSON.parse(r.payload));

// ============================================================================
// CREDENTIAL GATE  (the security-critical path)
// ============================================================================
test("credential gate: only a well-formed https site + email passes", () => {
  expect(J.credentialTargetValid(SITE, EMAIL)).toBe(true);
  // any Jira Cloud/Data Center host is legitimate now — the target is per-project
  expect(J.credentialTargetValid("https://other.atlassian.net", EMAIL)).toBe(true);
  expect(J.credentialTargetValid("https://jira.example.co.uk", EMAIL)).toBe(true);

  // http is rejected outright — Basic auth over http is base64, not encryption.
  expect(J.credentialTargetValid("http://example.atlassian.net", EMAIL)).toBe(false);

  // userinfo trick: parses to host evil.tld, reads as the real site to a human.
  expect(J.credentialTargetValid("https://example.atlassian.net@evil.tld/", EMAIL)).toBe(false);
  // new URL() reports username="" for a bare delimiter, so a falsy-userinfo
  // check alone lets these through; the parse must not be laxer than it reads.
  expect(J.credentialTargetValid("https://@example.atlassian.net", EMAIL)).toBe(false);
  expect(J.credentialTargetValid("https://:@example.atlassian.net", EMAIL)).toBe(false);
  // not a hostname
  expect(J.credentialTargetValid("https://localhost", EMAIL)).toBe(false);
  // garbage / empty
  expect(J.credentialTargetValid("not a url", EMAIL)).toBe(false);
  expect(J.credentialTargetValid("", EMAIL)).toBe(false);
  expect(J.credentialTargetValid(null, EMAIL)).toBe(false);

  // the gate covers the WHOLE credential pair, not just the host
  expect(J.credentialTargetValid(SITE, "not-an-email")).toBe(false);
  expect(J.credentialTargetValid(SITE, "")).toBe(false);
  expect(J.credentialTargetValid(SITE, null)).toBe(false);

  // canonicalSite rebuilds the string that reaches fetch(), dropping path/query
  expect(J.canonicalSite(SITE + "/wiki?x=1")).toBe(SITE);
});

test("credential gate: a malformed config is a hard no-op, and jiraConfig canonicalizes", () => {
  // jiraConfig returns null (not a throw a catch could swallow into 'carry on')
  expect(J.jiraConfig({ jira: { ...CFG, site: "http://example.atlassian.net" } })).toBeNull();
  expect(J.jiraConfig({ jira: { ...CFG, site: "https://example.atlassian.net@evil.tld" } })).toBeNull();
  expect(J.jiraConfig({ jira: { ...CFG, email: "not-an-email" } })).toBeNull();
  expect(J.jiraConfig({ jira: { ...CFG, project_key: "web" } })).toBeNull();
  expect(J.jiraConfig({ jira: { ...CFG, project_key: "" } })).toBeNull();
  expect(J.jiraConfig({ jira: { ...CFG, jql: "labels = sync) OR project = OPS OR (project = WEB" } })).toBeNull();

  // a passing config carries the CANONICALIZED site forward, not the caller's
  // string, so no unvalidated remnant can reach fetch().
  const ok = J.jiraConfig({ jira: { ...CFG, site: SITE + "/" } });
  expect(ok!.site).toBe(SITE);
  expect(ok!.email).toBe(EMAIL);
  expect(ok!.project_key).toBe("WEB");

  // the client refuses a hand-built config that bypassed jiraConfig()
  expect(() => new J.JiraClient({ ...CFG, site: "http://evil.tld" } as any, "tok")).toThrow(/malformed/);
  expect(() => new J.JiraClient({ ...CFG, project_key: "lower" } as any, "tok")).toThrow(/malformed/);
  expect(() => new J.JiraClient({ ...CFG, jql: "labels = sync) OR project = OPS OR (project = WEB" } as any, "tok")).toThrow(/malformed/);
});

test("SECURITY: escaping JQL disables sync before an outside project can be observed", async () => {
  const jql = "labels = sync) OR project = OPS OR (project = WEB";
  const jira = fakeJira({ issues: [{ key: "OPS-1", id: "1", status: "To Do", projectKey: "OPS" }] });
  const { db } = freshDb({ ...CFG, jql });

  expect(await J.syncJiraOnce(db, { fetch: jira.fetchImpl, token: "tok" })).toEqual([]);
  expect(jira.calls).toEqual([]);
  expect(tasks(db)).toEqual([]);
  expect(jira.writes()).toEqual([]);
  const project = db.query("SELECT id FROM projects").get() as { id: string };
  expect(J.readSyncState(db, project.id).last_error).toContain(`config.jira.jql is invalid: ${JSON.stringify(jql)}`);
});

test("an invalid JQL filter turns the automatic cycle OFF instead of failing one every interval", async () => {
  // The old behaviour ran a doomed cycle per tick: it burned a poll, pushed
  // consecutive_failures up forever, and the schedule still advertised a next
  // sync that could never succeed. Invalid config is a stop, not a retry loop.
  const jql = "labels = sync) OR project = OPS OR (project = WEB";
  const jira = fakeJira({ issues: [{ key: "WEB-1", id: "1", status: "To Do" }] });
  const { db, projectId } = freshDb({ ...CFG, jql });
  // a schedule left over from when the same config still parsed
  J.writeSyncState(db, projectId, { next_due_at: "2026-01-01T00:00:00.000Z", interval_ms: 60_000 });

  for (let tick = 0; tick < 3; tick++) await J.syncJiraOnce(db, { fetch: jira.fetchImpl, token: "tok" });

  const state = J.readSyncState(db, projectId);
  expect(jira.calls).toEqual([]);
  expect(state.last_attempt_at).toBeNull(); // no cycle was attempted at all
  expect(state.consecutive_failures).toBe(0); // so there is nothing to count
  expect(state.next_due_at).toBeNull(); // and no sync is promised
  expect(state.last_error).toContain(`config.jira.jql is invalid: ${JSON.stringify(jql)}`);

  // Manual retry still runs the real cycle, so it still reports the real error.
  const retry = await J.runProjectCycle(db, projectId, { fetch: jira.fetchImpl, token: "tok" });
  expect(retry.ok).toBe(false);
  expect(retry.error).toContain(`config.jira.jql is invalid: ${JSON.stringify(jql)}`);
});

test("SECURITY: a mutated target NEVER produces a request, even on the read path", async () => {
  // This is the actual guarantee, so this asserts the OUTPUT (no network call at
  // all) rather than merely that the validator exists. write:false is included
  // deliberately because shadow mode still exercises the read path.
  for (const target of [{ site: "http://example.atlassian.net" }, { project_key: "lower" }]) {
    for (const write of [true, false]) {
      const { db } = freshDb({ ...CFG, write, ...target });
      let called = 0;
      const spy = (async () => {
        called++;
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch;

      const out = await J.syncJiraOnce(db, { fetch: spy, token: "tok" });
      expect(called).toBe(0); // no request was made to ANY host
      expect(out).toEqual([]); // project skipped entirely
    }
  }
});

test("config defaults to enabled:false AND write:false, and disabled means no traffic", async () => {
  const cfg = J.jiraConfig({ jira: { site: SITE, email: EMAIL, project_key: "WEB" } })!;
  expect(cfg.enabled).toBe(false);
  expect(cfg.write).toBe(false);

  // The output, not just the flag: an unconfigured/disabled project is silent.
  const { db } = freshDb({ site: SITE, email: EMAIL, project_key: "WEB" });
  let called = 0;
  const spy = (async () => { called++; return new Response("{}"); }) as unknown as typeof fetch;
  expect(await J.syncJiraOnce(db, { fetch: spy, token: "tok" })).toEqual([]);
  expect(called).toBe(0);
});

test("offline mode prevents Jira traffic", async () => {
  const { db } = freshDb({ ...CFG });
  setSetting(db, "offline", "1");
  let called = 0;
  const spy = (async () => {
    called++;
    return new Response("{}");
  }) as unknown as typeof fetch;

  expect(await J.syncJiraOnce(db, { fetch: spy, token: "tok" })).toEqual([]);
  expect(called).toBe(0);
});



test("shadow mode still imports and still logs a would-be status push", async () => {
  const jira = fakeJira({ issues: [{ key: "WEB-1", id: "1", status: "To Do" }] });
  const { db, projectId } = freshDb();
  await run(db, projectId, jira.fetchImpl, { ...CFG, write: false });

  // hive moves ahead; Jira stays put. Next cycle should want to push.
  const t = tasks(db)[0];
  db.query("UPDATE tasks SET state = 'in_progress' WHERE id = ?").run(t.id);
  writeEvent(db, { task_id: t.id, source: "test", type: "state_change", payload: { from: "queued", to: "in_progress" } });

  const stats = await run(db, projectId, jira.fetchImpl, { ...CFG, write: false });
  const push = syncEvents(db).find((e) => e.action === "push");
  expect(push.shadow).toBe(true);
  expect(push.to).toBe("In Progress");
  expect(stats.pushed).toBe(0);
  expect(jira.writes()).toEqual([]);
  expect(jira.byKey.get("WEB-1")!.status).toBe("To Do"); // untouched
});

// ============================================================================
// IMPORT + BOTH DIRECTIONS
// ============================================================================
test("import mirrors an issue as a tracking-only task with the mapped state", async () => {
  const jira = fakeJira({ issues: [{ key: "WEB-1", id: "1", status: "In Review", summary: "뉴스레터 기획" }] });
  const { db, projectId } = freshDb();
  await run(db, projectId, jira.fetchImpl);

  const [t] = tasks(db);
  expect(t.source).toBe("external"); // tracking-only: never dispatched, no evidence gate
  expect(t.source_ref).toBe("jira:WEB-1");
  expect(t.state).toBe("in_review");
  expect(t.title).toBe("[WEB-1] 뉴스레터 기획");
  expect(t.brief).toContain(`${SITE}/browse/WEB-1`);
});

test("Jira priority reaches tasks.priority, so the dispatcher can actually order the queue", async () => {
  const jira = fakeJira({
    issues: [
      { key: "WEB-1", id: "1", status: "To Do", priority: "Highest" },
      { key: "WEB-2", id: "2", status: "To Do", priority: "High" },
      { key: "WEB-3", id: "3", status: "To Do", priority: "Medium" },
      { key: "WEB-4", id: "4", status: "To Do", priority: "Low" },
      { key: "WEB-5", id: "5", status: "To Do", priority: "Lowest" },
      { key: "WEB-6", id: "6", status: "To Do", priority: null }, // no priority set in Jira
    ],
  });
  const { db, projectId } = freshDb();
  await run(db, projectId, jira.fetchImpl);

  expect(Object.fromEntries(tasks(db).map((t) => [t.jira_key, t.priority]))).toEqual({
    "WEB-1": "now", "WEB-2": "next", "WEB-3": "normal", "WEB-4": "later", "WEB-5": "later", "WEB-6": "normal",
  });
  // The brief keeps carrying the Jira name — it is still context for an agent.
  expect(tasks(db)[0].brief).toContain("Priority: Highest");
  // Nothing in the priority copy may look like a status decision.
  expect(syncEvents(db).some((e) => e.action === "pull" || e.action === "push")).toBe(false);
});

test("a priority change in Jira moves the hive priority and moves nothing else", async () => {
  const jira = fakeJira({ issues: [{ key: "WEB-1", id: "1", status: "In Progress", priority: "Medium" }] });
  const { db, projectId } = freshDb();
  await run(db, projectId, jira.fetchImpl);
  const before = tasks(db)[0];
  expect(before.priority).toBe("normal");

  jira.byKey.get("WEB-1")!.priority = "Highest";
  await run(db, projectId, jira.fetchImpl);

  const after = tasks(db)[0];
  expect(after.priority).toBe("now");
  expect(after.state).toBe(before.state);
  expect(jira.calls.some((c) => c.method === "POST" && c.path.includes("/transitions"))).toBe(false);
});

test("an unrecognised Jira priority lands on normal and is logged ONCE, not every cycle", async () => {
  const jira = fakeJira({ issues: [{ key: "WEB-1", id: "1", status: "To Do", priority: "Blocker" }] });
  const { db, projectId } = freshDb();
  await run(db, projectId, jira.fetchImpl);
  await run(db, projectId, jira.fetchImpl);

  expect(tasks(db)[0].priority).toBe("normal");
  const unmapped = syncEvents(db).filter((e) => e.action === "unmapped_priority");
  expect(unmapped).toEqual([{ action: "unmapped_priority", issue: "WEB-1", jira_priority: "Blocker" }]);
});

test("the priority map covers Jira's default scheme and refuses to guess anything else", () => {
  expect(J.jiraPriorityToPriority("Highest")).toBe("now");
  expect(J.jiraPriorityToPriority("  high ")).toBe("next"); // case + whitespace tolerant
  expect(J.jiraPriorityToPriority("Medium")).toBe("normal");
  expect(J.jiraPriorityToPriority("Low")).toBe("later");
  expect(J.jiraPriorityToPriority("Lowest")).toBe("later");
  expect(J.jiraPriorityToPriority("P0")).toBe(null);
  expect(J.jiraPriorityToPriority(null)).toBe(null);
  // Every value it CAN produce has to be a rank the dispatcher understands.
  for (const p of Object.values(J.JIRA_TO_PRIORITY)) expect(TASK_PRIORITIES).toContain(p);
});

test("import broadcasts via broadcastTask, so the live-pushed card already carries never_dispatched", async () => {
  const jira = fakeJira({ issues: [{ key: "WEB-1", id: "1", status: "In Review" }] });
  const { db, projectId } = freshDb();
  const messages: any[] = [];
  const c = { id: "jira-import-broadcast-test", send: (data: string) => messages.push(JSON.parse(data)) };
  addClient(c);
  try {
    await run(db, projectId, jira.fetchImpl);
  } finally {
    removeClient(c);
  }
  const imported = messages.find((m) => m.type === "task" && m.task.source_ref === "jira:WEB-1");
  expect(imported).toBeTruthy();
  // A raw broadcast (pre-fix) omits this field entirely (undefined), which
  // client-side !task.never_dispatched checks misread as false.
  expect(imported.task.never_dispatched).toBe(true);
});

test("an import carries Jira's status time instead of the observation time", async () => {
  const jira = fakeJira({
    issues: [{ key: "WEB-1", id: "1", status: "To Do", created: "2026-01-01T00:00:00.000Z" }],
  });
  const { db, projectId } = freshDb();
  await run(db, projectId, jira.fetchImpl);

  const issue = jira.byKey.get("WEB-1")!;
  issue.status = "Done";
  issue.history = [{ at: "2026-02-01T00:00:00.000Z", to: "Done" }];

  const stats = await run(db, projectId, jira.fetchImpl);
  expect(stats.pulled).toBe(1);
  expect(stats.pushed).toBe(0);
  expect(tasks(db)[0].state).toBe("done");
  expect(jira.calls.some((c) => c.method === "POST" && c.path.includes("/transitions"))).toBe(false);
});

test("pull: Jira wins when its status changed more recently", async () => {
  const jira = fakeJira({
    issues: [{ key: "WEB-1", id: "1", status: "To Do", created: "2026-01-01T00:00:00.000Z" }],
  });
  const { db, projectId } = freshDb();
  await run(db, projectId, jira.fetchImpl);
  const t = tasks(db)[0];

  // hive moved a while ago; a human moved Jira just now.
  db.query("UPDATE tasks SET state = 'in_progress' WHERE id = ?").run(t.id);
  db.query("INSERT INTO events (id, task_id, ts, source, type, payload) VALUES (?,?,?,?,?,?)").run(
    newId("evt"), t.id, "2026-02-01T00:00:00.000Z", "test", "state_change",
    JSON.stringify({ from: "queued", to: "in_progress" })
  );
  const iss = jira.byKey.get("WEB-1")!;
  iss.status = "Done";
  iss.history = [{ at: "2026-03-01T00:00:00.000Z", to: "Done" }];

  const stats = await run(db, projectId, jira.fetchImpl);
  expect(stats.pulled).toBe(1);
  expect(tasks(db)[0].state).toBe("done");
  const pull = syncEvents(db).find((e) => e.action === "pull");
  expect(pull.winner).toBe("jira");
  expect(pull.from).toBe("in_progress");
  expect(pull.to).toBe("done");
});

test("a legacy Jira import without a status clock defers to fresh Jira state", async () => {
  const jira = fakeJira({
    issues: [{ key: "WEB-1", id: "1", status: "To Do", created: "2026-01-01T00:00:00.000Z" }],
  });
  const { db, projectId } = freshDb();
  await run(db, projectId, jira.fetchImpl);
  const imported = db.query(
    "SELECT id, payload FROM events WHERE source = 'jira-sync' AND type = 'jira_sync' AND json_extract(payload, '$.action') = 'import'"
  ).get() as { id: string; payload: string };
  const payload = JSON.parse(imported.payload);
  delete payload.jira_status_at;
  db.query("UPDATE events SET payload = ? WHERE id = ?").run(JSON.stringify(payload), imported.id);

  const issue = jira.byKey.get("WEB-1")!;
  issue.status = "Done";
  issue.history = [{ at: "2026-03-01T00:00:00.000Z", to: "Done" }];

  const stats = await run(db, projectId, jira.fetchImpl);
  expect(stats.pulled).toBe(1);
  expect(stats.pushed).toBe(0);
  expect(tasks(db)[0].state).toBe("done");
});

test("Jira pull rolls back the state when its clock event cannot commit", () => {
  const { db, projectId } = freshDb();
  const id = newId();
  const t = now();
  db.query(
    `INSERT INTO tasks (id, project_id, title, state, kind, source, source_ref, created_at, updated_at)
     VALUES (?,?,?,?,?, 'external', ?, ?, ?)`
  ).run(id, projectId, "[WEB-1] s", "queued", "ship", "jira:WEB-1", t, t);
  db.exec(`CREATE TRIGGER reject_jira_state_event BEFORE INSERT ON events
    WHEN NEW.type = 'state_change' BEGIN SELECT RAISE(ABORT, 'event rejected'); END`);

  expect(() => J.applyJiraState(db, tasks(db)[0], "done", "jira WEB-1 -> Done", Date.now())).toThrow(/event rejected/);
  expect(tasks(db)[0].state).toBe("queued");
  expect(db.query("SELECT COUNT(*) AS n FROM events WHERE task_id = ?").get(id)).toEqual({ n: 0 });
});

test("a rolled-back Jira pull does not leave a successful pull audit", async () => {
  const jira = fakeJira({ issues: [{ key: "WEB-1", id: "1", status: "To Do" }] });
  const { db, projectId } = freshDb();
  await run(db, projectId, jira.fetchImpl);
  const issue = jira.byKey.get("WEB-1")!;
  issue.status = "Done";
  issue.history = [{ at: "2026-09-01T00:00:00.000Z", to: "Done" }];
  db.exec(`CREATE TRIGGER reject_jira_pull_event BEFORE INSERT ON events
    WHEN NEW.type = 'state_change' BEGIN SELECT RAISE(ABORT, 'event rejected'); END`);

  const stats = await run(db, projectId, jira.fetchImpl);
  expect(stats.errors).toBe(1);
  expect(tasks(db)[0].state).toBe("queued");
  expect(syncEvents(db).some((event) => event.action === "pull")).toBe(false);
});

test("push: hive wins when its status changed more recently, and Jira really moves", async () => {
  const jira = fakeJira({
    issues: [{ key: "WEB-1", id: "1", status: "To Do", history: [{ at: "2026-01-01T00:00:00.000Z", to: "To Do" }] }],
  });
  const { db, projectId } = freshDb();
  await run(db, projectId, jira.fetchImpl);
  const t = tasks(db)[0];
  db.query("UPDATE tasks SET state = 'in_progress' WHERE id = ?").run(t.id);
  db.query("INSERT INTO events (id, task_id, ts, source, type, payload) VALUES (?,?,?,?,?,?)").run(
    newId("evt"), t.id, "2026-05-01T00:00:00.000Z", "test", "state_change",
    JSON.stringify({ from: "queued", to: "in_progress" })
  );

  const stats = await run(db, projectId, jira.fetchImpl);
  expect(stats.pushed).toBe(1);
  expect(jira.byKey.get("WEB-1")!.status).toBe("In Progress");

  const ev = syncEvents(db);
  // intent is logged BEFORE the call and the outcome after, so an
  // accepted-but-unacknowledged write is never invisible.
  expect(ev.some((e) => e.action === "push" && e.outcome === "sending")).toBe(true);
  expect(ev.some((e) => e.action === "push" && e.outcome === "ok")).toBe(true);
});

test("status transition lookup precedes the guarded boundary read", async () => {
  const jira = fakeJira({
    issues: [{
      key: "WEB-1",
      id: "1",
      status: "To Do",
      assignee: HUMAN,
      history: [{ at: "2026-01-01T00:00:00.000Z", to: "To Do" }],
    }],
  });
  const { db, projectId } = freshDb();
  await run(db, projectId, jira.fetchImpl);
  const task = tasks(db)[0];
  db.query("UPDATE tasks SET state = 'in_progress' WHERE id = ?").run(task.id);
  db.query("INSERT INTO events (id, task_id, ts, source, type, payload) VALUES (?,?,?,?,?,?)").run(
    newId("evt"), task.id, "2026-05-01T00:00:00.000Z", "test", "state_change",
    JSON.stringify({ from: "queued", to: "in_progress" })
  );
  jira.calls.length = 0;

  await run(db, projectId, jira.fetchImpl);

  const lookup = jira.calls.findIndex((c) => c.method === "GET" && c.path.endsWith("/transitions"));
  const post = jira.calls.findIndex((c) => c.method === "POST" && c.path.endsWith("/transitions"));
  const boundaryRead = jira.calls.findIndex((c, i) => i > lookup && c.method === "GET" && c.path.includes("/issue/WEB-1?"));
  expect(lookup).toBeGreaterThanOrEqual(0);
  expect(boundaryRead).toBeGreaterThan(lookup);
  expect(post).toBeGreaterThan(boundaryRead);
  expect(jira.calls[post - 1]).toMatchObject({ method: "GET" });
  expect(jira.calls[post - 1].path).toContain("/search/jql?");
  expect(jira.calls[post - 1].path).toContain("reconcileIssues=1");
});

test("converged sides do nothing at all (structural loop prevention)", async () => {
  const jira = fakeJira({ issues: [{ key: "WEB-1", id: "1", status: "To Do" }] });
  const { db, projectId } = freshDb();
  await run(db, projectId, jira.fetchImpl);
  const before = jira.writes().length;
  const s2 = await run(db, projectId, jira.fetchImpl);
  const s3 = await run(db, projectId, jira.fetchImpl);
  expect(jira.writes().length).toBe(before);
  for (const s of [s2, s3]) expect([s.pushed, s.pulled, s.labeled, s.imported]).toEqual([0, 0, 0, 0]);
});

// ============================================================================
// MANY-TO-ONE MAPPING BOUNDARY  (in_review AND verifying -> "In Review")
// ============================================================================
test("verifying vs 'In Review' counts as AGREEMENT, so the sync stops rewriting it", () => {
  // Comparing hive states would say verifying !== in_review and push forever, or
  // revert a merged task. The comparison happens in Jira-status space instead.
  expect(J.decideStatusSync({ jiraStatusName: "In Review", hiveState: "verifying", jiraAt: 1, hiveAt: 999 })).toBe("none");
  expect(J.decideStatusSync({ jiraStatusName: "In Review", hiveState: "verifying", jiraAt: 999, hiveAt: 1 })).toBe("none");
  expect(J.decideStatusSync({ jiraStatusName: "In Review", hiveState: "in_review", jiraAt: 999, hiveAt: 1 })).toBe("none");
  // and a genuine divergence at that boundary still resolves
  expect(J.decideStatusSync({ jiraStatusName: "Done", hiveState: "verifying", jiraAt: 999, hiveAt: 1 })).toBe("pull");
});

test("a merged (verifying) task is not reverted by a stale 'In Review' in Jira", async () => {
  const jira = fakeJira({ issues: [{ key: "WEB-1", id: "1", status: "In Review" }] });
  const { db, projectId } = freshDb();
  await run(db, projectId, jira.fetchImpl);
  const t = tasks(db)[0];
  db.query("UPDATE tasks SET state = 'verifying' WHERE id = ?").run(t.id);

  const stats = await run(db, projectId, jira.fetchImpl);
  expect(tasks(db)[0].state).toBe("verifying"); // not reverted to in_review
  expect(stats.pushed + stats.pulled).toBe(0); // and not rewritten either
});

test("states with no Jira meaning never push and are never overwritten", () => {
  for (const s of ["needs_decision", "failed", "cancelled"]) {
    expect(J.decideStatusSync({ jiraStatusName: "To Do", hiveState: s, jiraAt: 999, hiveAt: 1 })).toBe("none");
    expect(J.decideStatusSync({ jiraStatusName: "Done", hiveState: s, jiraAt: 1, hiveAt: 999 })).toBe("none");
  }
});

// ============================================================================
// TIMESTAMPS
// ============================================================================
test("a needs_decision round trip does NOT refresh hive's status timestamp", () => {
  const { db, projectId } = freshDb();
  const id = newId();
  db.query(
    "INSERT INTO tasks (id, project_id, title, state, kind, source_ref, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)"
  ).run(id, projectId, "t", "in_progress", "ship", "jira:WEB-1", "2026-01-01T00:00:00.000Z", now());

  const ev = (ts: string, from: string, to: string) =>
    db.query("INSERT INTO events (id, task_id, ts, source, type, payload) VALUES (?,?,?,?,?,?)").run(
      newId("evt"), id, ts, "test", "state_change", JSON.stringify({ from, to })
    );

  ev("2026-02-01T00:00:00.000Z", "queued", "in_progress"); // To Do -> In Progress: real move
  const afterRealMove = J.lastStateChangeAt(db, id);
  expect(new Date(afterRealMove!).toISOString()).toBe("2026-02-01T00:00:00.000Z");

  // needs_decision has no Jira status; it rides as a label. Neither leg of the
  // round trip changes what Jira SHOWS, so neither may refresh the timestamp.
  ev("2026-06-01T00:00:00.000Z", "in_progress", "needs_decision");
  ev("2026-07-01T00:00:00.000Z", "needs_decision", "in_progress");
  expect(J.lastStateChangeAt(db, id)).toBe(afterRealMove);
});

test("a requeue (failed -> queued) DOES count: the carried Jira status genuinely moves", () => {
  // The naive fix — discard any event whose endpoint is unmapped — would also
  // discard this, because it walks through `failed`. Tracking the CARRIED value
  // keeps it.
  const { db, projectId } = freshDb();
  const id = newId();
  db.query(
    "INSERT INTO tasks (id, project_id, title, state, kind, source_ref, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)"
  ).run(id, projectId, "t", "queued", "ship", "jira:WEB-1", "2026-01-01T00:00:00.000Z", now());
  const ev = (ts: string, from: string, to: string) =>
    db.query("INSERT INTO events (id, task_id, ts, source, type, payload) VALUES (?,?,?,?,?,?)").run(
      newId("evt"), id, ts, "test", "state_change", JSON.stringify({ from, to })
    );

  ev("2026-02-01T00:00:00.000Z", "queued", "in_progress");
  ev("2026-03-01T00:00:00.000Z", "in_progress", "failed"); // unmapped: carried stays "In Progress"
  ev("2026-04-01T00:00:00.000Z", "failed", "queued"); // "To Do" != "In Progress": a real move
  expect(new Date(J.lastStateChangeAt(db, id)!).toISOString()).toBe("2026-04-01T00:00:00.000Z");
});

test("changelog beyond 20 entries is paged, not truncated to creation time", async () => {
  // Search's expand=changelog caps at 20. Falling back to creation time would
  // make Jira look permanently ancient and let hive win every future tiebreak.
  const history = Array.from({ length: 45 }, (_, i) => ({
    at: `2026-01-${String((i % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
    to: i % 2 ? "In Progress" : "To Do",
  }));
  history.push({ at: "2026-11-30T00:00:00.000Z", to: "Done" }); // the newest, entry 46
  const jira = fakeJira({
    issues: [{ key: "WEB-1", id: "1", status: "Done", created: "2020-01-01T00:00:00.000Z", history }],
  });

  const read = await J.readIssue(client(jira.fetchImpl), J.jiraConfig({ jira: CFG })!, "WEB-1");
  expect(!("moved" in read) && !("missing" in read)).toBe(true);
  if ("moved" in read || "missing" in read) throw new Error("expected a coherent issue read");
  expect(new Date(read.statusAt).toISOString()).toBe("2026-11-30T00:00:00.000Z");
  expect(read.statusName).toBe("Done");
  // it really paged rather than reading one page
  expect(jira.calls.filter((c) => c.path.includes("/changelog")).length).toBeGreaterThan(1);
});

test("an over-limit changelog fails the issue instead of treating it as complete", async () => {
  const history = Array.from({ length: 401 }, (_, i) => ({
    at: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
    to: i === 400 ? "Done" : i % 2 ? "In Progress" : "To Do",
  }));
  const jira = fakeJira({
    issues: [
      { key: "WEB-1", id: "1", status: "Done", history },
      { key: "WEB-2", id: "2", status: "To Do" },
    ],
  });
  const { db, projectId } = freshDb();

  const stats = await run(db, projectId, jira.fetchImpl);
  expect(stats.errors).toBe(1);
  expect(stats.skipped).toBe(0);
  expect(stats.imported).toBe(1);
  expect(tasks(db).map((t) => t.source_ref)).toEqual(["jira:WEB-2"]);
  expect(jira.writes()).toEqual([]);
});

test("a torn status read is skipped until the field and changelog agree", async () => {
  const jira = fakeJira({
    issues: [{ key: "WEB-1", id: "1", status: "To Do", history: [{ at: "2026-09-09T00:00:00.000Z", to: "Done" }] }],
  });
  const read = await J.readIssue(client(jira.fetchImpl), J.jiraConfig({ jira: CFG })!, "WEB-1");
  expect(read).toMatchObject({ moved: true, initialStatus: "To Do", finalStatus: "To Do" });
});

test("a status move after changelog read aborts until a coherent next cycle", async () => {
  const jira = fakeJira({
    issues: [{
      key: "WEB-1",
      id: "1",
      status: "To Do",
      history: [{ at: "2026-03-01T00:00:00.000Z", to: "To Do" }],
    }],
    onChangelog: (_key, issue, nth) => {
      if (nth === 1) {
        issue.status = "Done";
        issue.updated = "2026-04-01T00:00:00.000Z";
        issue.history = [...(issue.history ?? []), { at: "2026-04-01T00:00:00.000Z", to: "Done" }];
      }
    },
  });
  const { db, projectId } = freshDb();
  const id = newId();
  db.query(
    `INSERT INTO tasks (id, project_id, title, state, kind, source, source_ref, created_at, updated_at)
     VALUES (?,?,?,?,?, 'external', ?, ?, ?)`
  ).run(id, projectId, "[WEB-1] s", "in_progress", "ship", "jira:WEB-1", "2026-01-01T00:00:00.000Z", now());
  db.query("INSERT INTO events (id, task_id, ts, source, type, payload) VALUES (?,?,?,?,?,?)").run(
    newId("evt"), id, "2026-02-01T00:00:00.000Z", "test", "state_change",
    JSON.stringify({ from: "queued", to: "in_progress" })
  );

  const stale = await run(db, projectId, jira.fetchImpl);
  expect(stale.skipped).toBe(1);
  expect(stale.pulled).toBe(0);
  expect(tasks(db)[0].state).toBe("in_progress");

  const converged = await run(db, projectId, jira.fetchImpl);
  expect(converged.pulled).toBe(1);
  expect(converged.pushed).toBe(0);
  expect(tasks(db)[0].state).toBe("done");
  expect(jira.byKey.get("WEB-1")!.status).toBe("Done");
  expect(jira.calls.some((c) => c.method === "POST" && c.path.includes("/transitions"))).toBe(false);
});

test("an ABA Jira move during the write-boundary read aborts the status write", async () => {
  const jira = fakeJira({
    issues: [{
      key: "WEB-1",
      id: "1",
      status: "To Do",
      updated: "2026-03-01T00:00:00.000Z",
      history: [{ at: "2026-03-01T00:00:00.000Z", to: "To Do" }],
    }],
    onChangelog: (_key, issue, nth) => {
      if (nth === 2) {
        issue.history = [
          ...(issue.history ?? []),
          { at: "2026-04-01T00:00:00.000Z", to: "Done" },
          { at: "2026-05-01T00:00:00.000Z", to: "To Do" },
        ];
        issue.status = "To Do";
        issue.updated = "2026-05-01T00:00:00.000Z";
      }
    },
  });
  const { db, projectId } = freshDb();
  const id = newId();
  db.query(
    `INSERT INTO tasks (id, project_id, title, state, kind, source, source_ref, created_at, updated_at)
     VALUES (?,?,?,?,?, 'external', ?, ?, ?)`
  ).run(id, projectId, "[WEB-1] s", "in_progress", "ship", "jira:WEB-1", "2026-01-01T00:00:00.000Z", now());
  db.query("INSERT INTO events (id, task_id, ts, source, type, payload) VALUES (?,?,?,?,?,?)").run(
    newId("evt"), id, "2026-06-01T00:00:00.000Z", "director", "state_change",
    JSON.stringify({ from: "queued", to: "in_progress" })
  );

  const stats = await run(db, projectId, jira.fetchImpl);
  expect(stats.aborted).toBe(1);
  expect(stats.pushed).toBe(0);
  expect(jira.writes()).toEqual([]);
  expect(syncEvents(db)).toContainEqual(expect.objectContaining({
    action: "push",
    initial_status: "To Do",
    final_status: "To Do",
    initial_version: "2026-03-01T00:00:00.000Z",
    final_version: "2026-05-01T00:00:00.000Z",
  }));
});

// ============================================================================
// JQL
// ============================================================================
test("a user jql filter is parenthesized so an OR cannot escape the project scope", () => {
  const c = client(fakeJira({ issues: [] }).fetchImpl, { ...CFG, jql: "labels = CMS OR labels = Website" });
  // unparenthesized this is `(project = WEB AND labels = CMS) OR labels = Website`,
  // which matches issues in OTHER projects and hands hive write access to them.
  expect(c.jql()).toBe("project = WEB AND (labels = CMS OR labels = Website)");
  expect(client(fakeJira({ issues: [] }).fetchImpl).jql()).toBe("project = WEB");
});

test("membership checks remain complete when the configured JQL matches more than one page", async () => {
  const target = "WEB-999";
  const jira = fakeJira({
    issues: [{ key: target, id: "999", status: "To Do" }],
    jqlOnly: [...Array.from({ length: 100 }, (_, i) => `WEB-${i + 1}`), target],
  });
  const cfg = J.jiraConfig({ jira: { ...CFG, jql: "labels = CMS" } })!;

  const read = await J.readIssue(client(jira.fetchImpl, { ...CFG, jql: "labels = CMS" }), cfg, target);
  expect(!("moved" in read) && !("missing" in read) ? read.scope : null).toBe("in");
});

// ============================================================================
// SCOPE + EVENTUAL CONSISTENCY
// ============================================================================
test("an issue that has left the project is not imported, even if search still lists it", async () => {
  const jira = fakeJira({ issues: [{ key: "WEB-1", id: "1", status: "To Do", projectKey: "OTHER" }] });
  const { db, projectId } = freshDb();
  const stats = await run(db, projectId, jira.fetchImpl);
  expect(tasks(db)).toHaveLength(0); // import is a write too
  expect(stats.imported).toBe(0);
  expect(jira.writes()).toEqual([]);
});

test("a scope query cannot override the issue's direct project", async () => {
  const jira = fakeJira({
    issues: [{ key: "OPS-1", id: "1", status: "To Do", projectKey: "OPS" }],
    scopeRows: [{ key: "OPS-1", fields: { status: { name: "To Do" }, updated: "2026-01-01T00:00:00.000Z" } }],
  });
  const { db, projectId } = freshDb();

  const stats = await run(db, projectId, jira.fetchImpl, { ...CFG, jql: "labels = sync" });

  expect(stats.imported).toBe(0);
  expect(tasks(db)).toEqual([]);
  expect(jira.writes()).toEqual([]);
});

test("an out-of-project read still takes a final scope observation", async () => {
  const jira = fakeJira({
    issues: [{ key: "WEB-1", id: "1", status: "To Do", projectKey: "OTHER" }],
    onScopeProbe: (_key, issue) => {
      issue.projectKey = "WEB";
      issue.updated = "2026-02-01T00:00:00.000Z";
    },
  });
  const { db, projectId } = freshDb();

  const stats = await run(db, projectId, jira.fetchImpl);

  expect(stats.skipped).toBe(1);
  expect(stats.imported).toBe(0);
  expect(jira.byKey.get("WEB-1")!.projectKey).toBe("WEB");
  expect(tasks(db)).toEqual([]);
});

test("a final in-project observation cannot advance a linked issue's absence streak", async () => {
  const opts: FakeOpts = { issues: [{ key: "WEB-1", id: "1", status: "To Do" }] };
  const jira = fakeJira(opts);
  const { db, projectId } = freshDb();
  await run(db, projectId, jira.fetchImpl);
  db.query("INSERT INTO intake_cursors (source, key, cursor) VALUES (?,?,?)").run(SCOPE_ABSENCE_SOURCE, "WEB-1", "2");
  const remote = jira.byKey.get("WEB-1")!;
  remote.projectKey = "OTHER";
  opts.visible = [];
  opts.onScopeProbe = (_key, issue) => {
    issue.projectKey = "WEB";
    issue.updated = "2026-02-01T00:00:00.000Z";
  };

  const stats = await run(db, projectId, jira.fetchImpl);

  expect(stats.skipped).toBe(1);
  expect(db.query("SELECT cursor FROM intake_cursors WHERE source = ? AND key = ?").get(SCOPE_ABSENCE_SOURCE, "WEB-1")).toBeNull();
  expect(syncEvents(db).filter((event) => event.action === "sync_stopped")).toEqual([]);
});

test("a torn move out cannot advance a linked issue's absence streak", async () => {
  const opts: FakeOpts = { issues: [{ key: "WEB-1", id: "1", status: "To Do" }] };
  const jira = fakeJira(opts);
  const { db, projectId } = freshDb();
  await run(db, projectId, jira.fetchImpl);
  db.query("INSERT INTO intake_cursors (source, key, cursor) VALUES (?,?,?)").run(SCOPE_ABSENCE_SOURCE, "WEB-1", "2");
  opts.visible = [];
  opts.onScopeProbe = (_key, issue) => {
    issue.projectKey = "OTHER";
    issue.updated = "2026-02-01T00:00:00.000Z";
  };

  const stats = await run(db, projectId, jira.fetchImpl);

  expect(stats.skipped).toBe(1);
  expect(db.query("SELECT cursor FROM intake_cursors WHERE source = ? AND key = ?").get(SCOPE_ABSENCE_SOURCE, "WEB-1")).toBeNull();
  expect(syncEvents(db).filter((event) => event.action === "sync_stopped")).toEqual([]);
});

test("every requested Jira issue field is required before reconciliation", async () => {
  for (const field of J.JIRA_ISSUE_FIELDS) {
    const jira = fakeJira({
      issues: [{ key: "WEB-1", id: "1", status: "To Do" }],
      omitIssueFields: [field],
    });
    const { db, projectId } = freshDb();

    const stats = await run(db, projectId, jira.fetchImpl);

    expect(stats.errors).toBe(1);
    expect(stats.failures[0]).toContain(`incomplete Jira ${field} response`);
    expect(tasks(db)).toEqual([]);
    expect(jira.writes()).toEqual([]);
  }
});

test("an operational scope check failure fails the issue visibly", async () => {
  const jira = fakeJira({
    issues: [{ key: "WEB-1", id: "1", status: "To Do" }],
    failJqlProbe: true, // the strongly-consistent membership answer is unavailable
  });
  const { db, projectId } = freshDb();
  const stats = await run(db, projectId, jira.fetchImpl, { ...CFG, jql: "labels = CMS" });
  expect(stats.errors).toBe(1);
  expect(stats.blocked).toBe(0);
  expect(tasks(db)).toHaveLength(0);
  expect(jira.writes()).toEqual([]); // never falls back to the stale snapshot
});

test("JQL scope is confirmed after changelog reads before an import", async () => {
  const inScope = ["WEB-1"];
  const jira = fakeJira({
    issues: [{ key: "WEB-1", id: "1", status: "To Do" }],
    jqlOnly: inScope,
    onChangelog: () => inScope.splice(0),
  });
  const { db, projectId } = freshDb();

  const stats = await run(db, projectId, jira.fetchImpl, { ...CFG, jql: "labels = CMS" });
  expect(stats.imported).toBe(0);
  expect(tasks(db)).toEqual([]);
  expect(jira.writes()).toEqual([]);
});

test("an issue that returns 404 is skipped alone; the rest of the batch proceeds", async () => {
  const jira = fakeJira({
    issues: [
      { key: "WEB-1", id: "1", status: "To Do" },
      { key: "WEB-2", id: "2", status: "To Do" },
      { key: "WEB-3", id: "3", status: "To Do" },
    ],
    missingRead: ["WEB-2"],
  });
  const { db, projectId } = freshDb();
  const stats = await run(db, projectId, jira.fetchImpl);
  expect(stats.skipped).toBe(1);
  expect(stats.imported).toBe(2);
  expect(tasks(db).map((t) => t.source_ref).sort()).toEqual(["jira:WEB-1", "jira:WEB-3"]);
});

test("a direct issue 404 returns a typed missing observation", async () => {
  const jira = fakeJira({
    issues: [{ key: "WEB-1", id: "1", status: "To Do" }],
    missingRead: ["WEB-1"],
  });

  const read = await J.readIssue(client(jira.fetchImpl), J.jiraConfig({ jira: CFG })!, "WEB-1");

  expect(read).toEqual({ missing: true, key: "WEB-1", httpStatus: 404 });
});

test("an import rolls back the task when its event cannot commit", async () => {
  const jira = fakeJira({ issues: [{ key: "WEB-1", id: "1", status: "To Do" }] });
  const { db, projectId } = freshDb();
  db.exec(`CREATE TRIGGER reject_jira_import_event BEFORE INSERT ON events
    WHEN NEW.type = 'jira_sync' BEGIN SELECT RAISE(ABORT, 'event rejected'); END`);

  const stats = await run(db, projectId, jira.fetchImpl);
  expect(stats.errors).toBe(1);
  expect(tasks(db)).toEqual([]);
});

test("a changelog read failure fails the issue rather than guessing a timestamp", async () => {
  const jira = fakeJira({ issues: [{ key: "WEB-1", id: "1", status: "To Do" }], failChangelog: ["WEB-1"] });
  const { db, projectId } = freshDb();
  const stats = await run(db, projectId, jira.fetchImpl);
  expect(stats.errors).toBe(1);
  expect(stats.skipped).toBe(0);
  expect(tasks(db)).toHaveLength(0);
});

test("empty and non-JSON issue reads fail instead of becoming missing issues", async () => {
  for (const failure of ["emptyRead", "invalidJsonRead"] as const) {
    const jira = fakeJira({
      issues: [{ key: "WEB-1", id: "1", status: "To Do" }],
      [failure]: ["WEB-1"],
    });
    const { db, projectId } = freshDb();
    const stats = await run(db, projectId, jira.fetchImpl);
    expect(stats.errors).toBe(1);
    expect(stats.skipped).toBe(0);
    expect(tasks(db)).toHaveLength(0);
  }
});

test("malformed Jira issue ids fail instead of becoming evidence of absence", async () => {
  for (const id of [{}, true]) {
    const jira = fakeJira({ issues: [{ key: "WEB-1", id, status: "To Do" }] });
    const { db, projectId } = freshDb();

    const stats = await run(db, projectId, jira.fetchImpl);

    expect(stats.errors).toBe(1);
    expect(stats.skipped).toBe(0);
    expect(stats.failures[0]).toContain("invalid Jira issue id for WEB-1");
    expect(tasks(db)).toHaveLength(0);
    expect(jira.calls.some((call) => call.path.includes("reconcileIssues"))).toBe(false);
    expect(jira.writes()).toEqual([]);
  }
});

test("unprovable Jira status clocks fail the issue", async () => {
  const cases: { issue: FakeIssue; message: string }[] = [
    { issue: { key: "WEB-1", id: "1", status: "To Do", created: null }, message: "incomplete Jira created response" },
    { issue: { key: "WEB-1", id: "1", status: "To Do", created: "not-a-date" }, message: "invalid Jira status clock" },
    { issue: { key: "WEB-1", id: "1", status: "To Do", updated: "not-a-date" }, message: "incomplete Jira updated response" },
    {
      issue: { key: "WEB-1", id: "1", status: "To Do", history: [{ at: "not-a-date", to: "To Do" }] },
      message: "invalid Jira status history timestamp",
    },
    {
      issue: { key: "WEB-1", id: "1", status: "To Do", rawHistory: [{ created: "2026-01-02T00:00:00.000Z" }] },
      message: "invalid Jira changelog record",
    },
    {
      issue: {
        key: "WEB-1", id: "1", status: "To Do",
        rawHistory: [{ created: "2026-01-02T00:00:00.000Z", items: [{ field: "status" }] }],
      },
      message: "invalid Jira status history destination",
    },
  ];

  for (const { issue, message } of cases) {
    const jira = fakeJira({ issues: [issue] });
    const { db, projectId } = freshDb();
    const stats = await run(db, projectId, jira.fetchImpl);
    expect(stats.errors).toBe(1);
    expect(stats.skipped).toBe(0);
    expect(stats.failures[0]).toContain(message);
    expect(tasks(db)).toHaveLength(0);
    expect(jira.writes()).toEqual([]);
  }
});

test("missing discovery completion metadata aborts without advancing absence state", async () => {
  const issue = [{ key: "WEB-1", id: "1", status: "To Do" }];
  const { db, projectId } = freshDb();
  await run(db, projectId, fakeJira({ issues: issue }).fetchImpl);

  const broken = fakeJira({ issues: issue, omitDiscoveryPagination: true });
  await expect(run(db, projectId, broken.fetchImpl)).rejects.toThrow(/incomplete Jira discovery pagination/);
  const cursorCount = db
    .query("SELECT COUNT(*) AS n FROM intake_cursors WHERE source = ? AND key = ?")
    .get(SCOPE_ABSENCE_SOURCE, "WEB-1") as { n: number };
  expect(cursorCount.n).toBe(0);
});

test("malformed discovery rows abort before the absence sweep", async () => {
  const issue = [{ key: "WEB-1", id: "1", status: "To Do" }];
  const { db, projectId } = freshDb();
  await run(db, projectId, fakeJira({ issues: issue }).fetchImpl);

  const malformed = fakeJira({ issues: issue, discoveryRows: [{}] });
  await expect(run(db, projectId, malformed.fetchImpl)).rejects.toThrow(/incomplete Jira discovery issue response/);
  const cursorCount = db
    .query("SELECT COUNT(*) AS n FROM intake_cursors WHERE source = ? AND key = ?")
    .get(SCOPE_ABSENCE_SOURCE, "WEB-1") as { n: number };
  expect(cursorCount.n).toBe(0);
});

test("missing changelog completion metadata fails the issue visibly", async () => {
  const jira = fakeJira({
    issues: [{ key: "WEB-1", id: "1", status: "To Do" }],
    omitChangelogPagination: true,
  });
  const { db, projectId } = freshDb();
  const stats = await run(db, projectId, jira.fetchImpl);
  expect(stats.errors).toBe(1);
  expect(stats.skipped).toBe(0);
  expect(tasks(db)).toHaveLength(0);
});

test("a failed discovery aborts the cycle and cannot be mistaken for an absence", async () => {
  const jira = fakeJira({ issues: [{ key: "WEB-1", id: "1", status: "To Do" }] });
  const { db, projectId } = freshDb();
  await run(db, projectId, jira.fetchImpl);
  expect(tasks(db)).toHaveLength(1);

  const broken = fakeJira({ issues: [{ key: "WEB-1", id: "1", status: "To Do" }], failSearch: true });
  await expect(run(db, projectId, broken.fetchImpl)).rejects.toThrow();
  // the absence streak was never touched, so a run of API outages can never
  // accumulate into "this issue is gone"
  const stopped = syncEvents(db).filter((e) => e.action === "sync_stopped");
  expect(stopped).toEqual([]);
});

test("truncated discovery aborts without advancing absence state", async () => {
  const issue = [{ key: "WEB-1", id: "1", status: "To Do" }];
  const { db, projectId } = freshDb();
  await run(db, projectId, fakeJira({ issues: issue }).fetchImpl);

  const truncated = fakeJira({ issues: issue, discoverPages: 21 });
  await expect(run(db, projectId, truncated.fetchImpl)).rejects.toThrow(/pagination limit/);
  const cursorCount = db
    .query("SELECT COUNT(*) AS n FROM intake_cursors WHERE source = ? AND key = ?")
    .get(SCOPE_ABSENCE_SOURCE, "WEB-1") as { n: number };
  expect(cursorCount.n).toBe(0);
  expect(syncEvents(db).filter((e) => e.action === "sync_stopped")).toEqual([]);
});

// ============================================================================
// ABSENCE  (never destructive, but never silent either)
// ============================================================================
test("a vanished issue is dispositioned but never deleted, and nothing is written to Jira", async () => {
  const present = fakeJira({ issues: [{ key: "WEB-1", id: "1", status: "In Progress" }] });
  const { db, projectId } = freshDb();
  await run(db, projectId, present.fetchImpl);
  const before = tasks(db)[0];

  // A direct 404 is positive proof, so this needs no streak (hive-1007). The
  // ROW is still never deleted - its comments, evidence and receipts are the
  // only surviving record that the work existed.
  const gone = fakeJira({ issues: [{ key: "WEB-1", id: "1", status: "In Progress" }], visible: [], missingRead: ["WEB-1"] });
  await run(db, projectId, gone.fetchImpl, CFG, { log: () => {} });

  expect(tasks(db)).toHaveLength(1);
  expect(tasks(db)[0].id).toBe(before.id);
  expect(tasks(db)[0].state).toBe("cancelled");
  expect(gone.writes()).toEqual([]); // hive never writes to an issue it cannot read

  // and it stays quiet rather than re-cancelling every cycle
  await run(db, projectId, gone.fetchImpl, CFG, { log: () => {} });
  expect(syncEvents(db).filter((e) => e.action === "source_deleted")).toHaveLength(1);
});

test("a stopped absence marker rolls back when its event cannot commit", async () => {
  const issue = [{ key: "WEB-1", id: "1", status: "To Do" }];
  const cfg = { ...CFG, jql: "labels = CMS" };
  const { db, projectId } = freshDb();
  await run(db, projectId, fakeJira({ issues: issue, jqlOnly: ["WEB-1"] }).fetchImpl, cfg);
  const outOfScope = () => fakeJira({ issues: issue, visible: [], jqlOnly: [] });
  await run(db, projectId, outOfScope().fetchImpl, cfg);
  await run(db, projectId, outOfScope().fetchImpl, cfg);
  db.exec(`CREATE TRIGGER reject_sync_stopped_event BEFORE INSERT ON events
    WHEN NEW.type = 'jira_sync' BEGIN SELECT RAISE(ABORT, 'event rejected'); END`);

  await expect(run(db, projectId, outOfScope().fetchImpl, cfg)).rejects.toThrow(/event rejected/);
  const cursor = db.query("SELECT cursor FROM intake_cursors WHERE source = ? AND key = ?").get(SCOPE_ABSENCE_SOURCE, "WEB-1");
  expect(cursor).toEqual({ cursor: "2" });
});

test("an issue that reappears clears the streak and resumes syncing", async () => {
  const { db, projectId } = freshDb();
  const iss = [{ key: "WEB-1", id: "1", status: "To Do" }];
  await run(db, projectId, fakeJira({ issues: iss }).fetchImpl);
  await run(db, projectId, fakeJira({ issues: iss, visible: [], missingRead: ["WEB-1"] }).fetchImpl);
  await run(db, projectId, fakeJira({ issues: iss, visible: [], missingRead: ["WEB-1"] }).fetchImpl);
  // back before the limit
  await run(db, projectId, fakeJira({ issues: iss }).fetchImpl);
  // two more misses would now have to start over
  await run(db, projectId, fakeJira({ issues: iss, visible: [], missingRead: ["WEB-1"] }).fetchImpl);
  await run(db, projectId, fakeJira({ issues: iss, visible: [], missingRead: ["WEB-1"] }).fetchImpl);
  expect(syncEvents(db).filter((e) => e.action === "sync_stopped")).toHaveLength(0);
});

test("a direct 404 and a scope absence drive different consequences and never blend", async () => {
  const issue = [{ key: "WEB-1", id: "1", status: "To Do" }];
  const cfg = { ...CFG, jql: "labels = CMS" };
  const { db, projectId } = freshDb();
  await run(db, projectId, fakeJira({ issues: issue, jqlOnly: ["WEB-1"] }).fetchImpl, cfg);
  const outOfScope = () => fakeJira({ issues: issue, visible: [], jqlOnly: [] });

  // Scope absence accrues a streak and NEVER cancels: it is not evidence.
  await run(db, projectId, outOfScope().fetchImpl, cfg);
  await run(db, projectId, outOfScope().fetchImpl, cfg);
  expect(db.query("SELECT cursor FROM intake_cursors WHERE source = ? AND key = ?").get(SCOPE_ABSENCE_SOURCE, "WEB-1")).toEqual({ cursor: "2" });
  expect(tasks(db)[0].state).not.toBe("cancelled");

  // A direct 404 is proof: it disposes immediately AND clears the scope streak,
  // rather than adding to it. Two signals, two consequences, no blending.
  await run(db, projectId, fakeJira({ issues: issue, visible: [], missingRead: ["WEB-1"] }).fetchImpl, cfg, { log: () => {} });
  expect(db.query("SELECT cursor FROM intake_cursors WHERE source = ? AND key = ?").get(SCOPE_ABSENCE_SOURCE, "WEB-1")).toBeNull();
  expect(tasks(db)[0].state).toBe("cancelled");
  expect(syncEvents(db).filter((e) => e.action === "sync_stopped")).toEqual([]);
});

test("scope absence stops syncing without changing the mirrored task", async () => {
  const issue = [{ key: "WEB-1", id: "1", status: "In Progress" }];
  const cfg = { ...CFG, jql: "labels = CMS" };
  const { db, projectId } = freshDb();
  await run(db, projectId, fakeJira({ issues: issue, jqlOnly: ["WEB-1"] }).fetchImpl, cfg);
  const before = tasks(db)[0];

  for (let i = 0; i < 3; i++)
    await run(db, projectId, fakeJira({ issues: issue, visible: [], jqlOnly: [] }).fetchImpl, cfg);

  expect(tasks(db)[0]).toMatchObject({ id: before.id, state: before.state, source_ref: before.source_ref });
  expect(syncEvents(db).filter((event) => event.action === "sync_stopped")).toEqual([
    expect.objectContaining({ issue: "WEB-1", absence_kind: "scope" }),
  ]);
  expect(tasks(db)[0].state).not.toBe("cancelled"); // scope absence is not evidence, so it never disposes
});

test("a search omission cannot advance absence while the strong read remains in scope", async () => {
  const issue = [{ key: "WEB-1", id: "1", status: "To Do" }];
  const { db, projectId } = freshDb();
  await run(db, projectId, fakeJira({ issues: issue }).fetchImpl);
  db.query("INSERT INTO intake_cursors (source, key, cursor) VALUES (?,?,?)").run(SCOPE_ABSENCE_SOURCE, "WEB-1", "2");

  await run(db, projectId, fakeJira({ issues: issue, visible: [] }).fetchImpl);

  expect(db.query("SELECT cursor FROM intake_cursors WHERE source = ? AND key = ?").get(SCOPE_ABSENCE_SOURCE, "WEB-1")).toBeNull();
  expect(syncEvents(db).filter((e) => e.action === "sync_stopped")).toEqual([]);
});

test("a linked issue omitted by search still fully reconciles", async () => {
  const opts: FakeOpts = { issues: [{ key: "WEB-1", id: "1", status: "To Do", summary: "old" }] };
  const jira = fakeJira(opts);
  const { db, projectId } = freshDb();
  await run(db, projectId, jira.fetchImpl);
  const remote = jira.byKey.get("WEB-1")!;
  opts.visible = [];
  remote.status = "In Progress";
  remote.summary = "new";
  remote.updated = "2026-02-01T00:00:00.000Z";
  remote.history = [{ at: "2026-02-01T00:00:00.000Z", to: "In Progress" }];
  remote.comments = [{ id: "human-1", author: "Human", text: "still sync me" }];

  const stats = await run(db, projectId, jira.fetchImpl);

  expect(stats.pulled).toBe(1);
  expect(stats.comments_pulled).toBe(1);
  expect(tasks(db)[0]).toMatchObject({ state: "in_progress", title: "[WEB-1] new" });
  expect(db.query("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = 'jira_comment'").get(tasks(db)[0].id)).toEqual({ n: 1 });
});

test("an in-scope torn read clears an existing absence streak", async () => {
  const issue = [{ key: "WEB-1", id: "1", status: "To Do" }];
  const { db, projectId } = freshDb();
  await run(db, projectId, fakeJira({ issues: issue }).fetchImpl);
  db.query("INSERT INTO intake_cursors (source, key, cursor) VALUES (?,?,?)").run(SCOPE_ABSENCE_SOURCE, "WEB-1", "2");
  const moved = fakeJira({
    issues: issue,
    visible: [],
    onScopeProbe: (_key, remote) => {
      remote.status = "In Progress";
      remote.updated = "2026-02-01T00:00:00.000Z";
    },
  });

  await run(db, projectId, moved.fetchImpl);
  expect(db.query("SELECT cursor FROM intake_cursors WHERE source = ? AND key = ?").get(SCOPE_ABSENCE_SOURCE, "WEB-1")).toBeNull();
  expect(syncEvents(db).filter((event) => event.action === "sync_stopped")).toEqual([]);
});

test("a scope-query 404 is operational and cannot prove issue absence", async () => {
  const issue = [{ key: "WEB-1", id: "1", status: "To Do" }];
  const { db, projectId } = freshDb();
  await run(db, projectId, fakeJira({ issues: issue }).fetchImpl);
  db.query("INSERT INTO intake_cursors (source, key, cursor) VALUES (?,?,?)").run(SCOPE_ABSENCE_SOURCE, "WEB-1", "2");

  const stats = await run(
    db,
    projectId,
    fakeJira({ issues: issue, visible: [], missingJqlProbe: true }).fetchImpl,
    CFG,
    { log: () => {} }
  );

  expect(stats.errors).toBe(1);
  expect(stats.failures[0]).toContain("search/jql");
  expect(stats.failures[0]).toContain("404 not found");
  expect(db.query("SELECT cursor FROM intake_cursors WHERE source = ? AND key = ?").get(SCOPE_ABSENCE_SOURCE, "WEB-1")).toEqual({ cursor: "2" });
  expect(syncEvents(db).filter((event) => event.action === "sync_stopped")).toEqual([]);
});

test("an operational absence read failure is visible and does not advance the streak", async () => {
  const issue = [{ key: "WEB-1", id: "1", status: "To Do" }];
  const { db, projectId } = freshDb();
  await run(db, projectId, fakeJira({ issues: issue }).fetchImpl);
  db.query("INSERT INTO intake_cursors (source, key, cursor) VALUES (?,?,?)").run(SCOPE_ABSENCE_SOURCE, "WEB-1", "1");

  const stats = await run(db, projectId, fakeJira({ issues: issue, visible: [], failRead: ["WEB-1"] }).fetchImpl, CFG, { log: () => {} });

  expect(stats.errors).toBe(1);
  expect(stats.failures[0]).toContain("500 nope");
  expect(db.query("SELECT cursor FROM intake_cursors WHERE source = ? AND key = ?").get(SCOPE_ABSENCE_SOURCE, "WEB-1")).toEqual({ cursor: "1" });
  expect(syncEvents(db).filter((e) => e.action === "sync_stopped")).toEqual([]);
});

test("malformed and unexpected scope rows are not evidence that an issue disappeared", async () => {
  const issue = [{ key: "WEB-1", id: "1", status: "To Do" }];
  const valid = { key: "WEB-1", fields: { status: { name: "To Do" }, updated: "2026-01-01T00:00:00.000Z" } };
  for (const scopeRows of [
    [{}],
    [{ key: "WEB-2" }],
    [valid, valid],
    [{ key: "WEB-1", fields: { status: { name: { value: "To Do" } }, updated: "2026-01-01T00:00:00.000Z" } }],
    [{ key: "WEB-1", fields: { status: { name: "To Do" }, updated: { value: "2026-01-01T00:00:00.000Z" } } }],
    // `updated` is the VERSION GUARD, so a nonempty-but-unparseable clock is not
    // good enough: two identical junk values compare equal and would let an
    // A->B->A change slip past the coherence check. Fails against a bare
    // typeof-string check, which is the point of the case.
    [{ key: "WEB-1", fields: { status: { name: "To Do" }, updated: "not-a-date" } }],
  ]) {
    const { db, projectId } = freshDb();
    await run(db, projectId, fakeJira({ issues: issue }).fetchImpl);
    db.query("INSERT INTO intake_cursors (source, key, cursor) VALUES (?,?,?)").run(SCOPE_ABSENCE_SOURCE, "WEB-1", "1");

    const malformed = fakeJira({ issues: issue, visible: [], scopeRows });
    const stats = await run(db, projectId, malformed.fetchImpl, CFG, { log: () => {} });

    expect(stats.errors).toBe(1);
    expect(db.query("SELECT cursor FROM intake_cursors WHERE source = ? AND key = ?").get(SCOPE_ABSENCE_SOURCE, "WEB-1")).toEqual({ cursor: "1" });
    expect(syncEvents(db).filter((e) => e.action === "sync_stopped")).toEqual([]);
  }
});

// ============================================================================
// WRITE BOUNDARY
// ============================================================================
test("a push aborts (visibly) when Jira moves between the decision and the write", async () => {
  // The race the boundary re-read exists for: a human transitions the issue
  // while hive's write is in flight. Aborting must be DISTINCT in the log from
  // "nothing to do" — both would otherwise look like silence.
  const jira = fakeJira({
    issues: [{ key: "WEB-1", id: "1", status: "To Do", history: [{ at: "2026-01-01T00:00:00.000Z", to: "To Do" }] }],
    beforeChangelog: (_key, issue, nth) => {
      // read 1 = cycle-1 import, read 2 = cycle-2 decision, read 3 = cycle-2
      // write boundary. The human moves the issue between 2 and 3, which is
      // exactly the window the boundary re-read exists to catch.
      if (nth === 3) {
        issue.status = "Done";
        issue.updated = "2026-06-01T00:00:00.000Z";
        issue.history = [...issue.history, { at: "2026-06-01T00:00:00.000Z", to: "Done" }];
      }
    },
  });
  const { db, projectId } = freshDb();
  await run(db, projectId, jira.fetchImpl); // import (read #1)

  const t = tasks(db)[0];
  db.query("UPDATE tasks SET state = 'in_progress' WHERE id = ?").run(t.id);
  db.query("INSERT INTO events (id, task_id, ts, source, type, payload) VALUES (?,?,?,?,?,?)").run(
    newId("evt"), t.id, "2026-05-01T00:00:00.000Z", "test", "state_change",
    JSON.stringify({ from: "queued", to: "in_progress" })
  );

  const stats = await run(db, projectId, jira.fetchImpl);
  expect(stats.aborted).toBeGreaterThan(0);
  expect(stats.pushed).toBe(0);
  const abort = syncEvents(db).find((e) => e.aborted);
  expect(abort.action).toBe("push");
  expect(abort.aborted).toBe("Jira changed during the coherent read");
  expect(abort.from).toBe("To Do");
  expect(abort.initial_status).toBe("To Do");
  expect(abort.final_status).toBe("Done");
  expect(abort.initial_version).toBe("2026-01-01T00:00:00.000Z");
  expect(abort.final_version).toBe("2026-06-01T00:00:00.000Z");
  // no transition POST was sent
  expect(jira.calls.some((c) => c.method === "POST" && c.path.includes("/transitions"))).toBe(false);
});

test("a push aborts when a same-status Jira round trip changes the winner", async () => {
  const jira = fakeJira({
    issues: [{
      key: "WEB-1",
      id: "1",
      status: "To Do",
      assignee: HUMAN,
      history: [{ at: "2026-01-01T00:00:00.000Z", to: "To Do" }],
    }],
    beforeChangelog: (_key, issue, nth) => {
      if (nth === 3) {
        issue.history = [
          ...(issue.history ?? []),
          { at: "2026-06-01T00:00:00.000Z", to: "Done" },
          { at: "2026-07-01T00:00:00.000Z", to: "To Do" },
        ];
      }
    },
  });
  const { db, projectId } = freshDb();
  await run(db, projectId, jira.fetchImpl);
  const task = tasks(db)[0];
  db.query("UPDATE tasks SET state = 'in_progress' WHERE id = ?").run(task.id);
  db.query("INSERT INTO events (id, task_id, ts, source, type, payload) VALUES (?,?,?,?,?,?)").run(
    newId("evt"), task.id, "2026-05-01T00:00:00.000Z", "test", "state_change",
    JSON.stringify({ from: "queued", to: "in_progress" })
  );

  const stats = await run(db, projectId, jira.fetchImpl);
  const abort = syncEvents(db).find((e) => e.action === "push" && e.aborted);
  expect(stats.aborted).toBe(1);
  expect(stats.pushed).toBe(0);
  expect(abort.fresh_status).toBe("To Do");
  expect(abort.fresh_action).toBe("pull");
  expect(abort.fresh_jira_at).toBe("2026-07-01T00:00:00.000Z");
  expect(jira.calls.some((c) => c.method === "POST" && c.path.includes("/transitions"))).toBe(false);
});

test("a push aborts when Hive changes its target at the write boundary", async () => {
  let boundaryDb: DB;
  let taskId = "";
  const jira = fakeJira({
    issues: [{
      key: "WEB-1",
      id: "1",
      status: "To Do",
      assignee: HUMAN,
      history: [{ at: "2026-01-01T00:00:00.000Z", to: "To Do" }],
    }],
    onRead: (_key, _issue, nth) => {
      if (nth === 3) {
        boundaryDb.query("UPDATE tasks SET state = 'done' WHERE id = ?").run(taskId);
        writeEvent(boundaryDb, {
          task_id: taskId,
          source: "test",
          type: "state_change",
          payload: { from: "in_progress", to: "done" },
        });
      }
    },
  });
  const fresh = freshDb();
  boundaryDb = fresh.db;
  await run(boundaryDb, fresh.projectId, jira.fetchImpl);
  const task = tasks(boundaryDb)[0];
  taskId = task.id;
  boundaryDb.query("UPDATE tasks SET state = 'in_progress' WHERE id = ?").run(taskId);
  boundaryDb.query("INSERT INTO events (id, task_id, ts, source, type, payload) VALUES (?,?,?,?,?,?)").run(
    newId("evt"), taskId, "2026-05-01T00:00:00.000Z", "test", "state_change",
    JSON.stringify({ from: "queued", to: "in_progress" })
  );

  const stats = await run(boundaryDb, fresh.projectId, jira.fetchImpl);
  const abort = syncEvents(boundaryDb).find((e) => e.action === "push" && e.aborted);
  expect(stats.aborted).toBe(1);
  expect(stats.pushed).toBe(0);
  expect(abort.to).toBe("In Progress");
  expect(abort.fresh_hive_state).toBe("done");
  expect(abort.fresh_target).toBe("Done");
  expect(jira.calls.some((c) => c.method === "POST" && c.path.includes("/transitions"))).toBe(false);
});

// ============================================================================
// LABELS + ASSIGNEE
// ============================================================================
test("needs_decision rides as a label, added and removed", async () => {
  const jira = fakeJira({ issues: [{ key: "WEB-1", id: "1", status: "In Progress" }] });
  const { db, projectId } = freshDb();
  await run(db, projectId, jira.fetchImpl);
  const t = tasks(db)[0];

  db.query("UPDATE tasks SET state = 'needs_decision' WHERE id = ?").run(t.id);
  await run(db, projectId, jira.fetchImpl);
  expect(jira.byKey.get("WEB-1")!.labels).toContain(J.NEEDS_DECISION_LABEL);
  // ...and the status was NOT pushed, because needs_decision has no Jira status
  expect(jira.byKey.get("WEB-1")!.status).toBe("In Progress");

  db.query("UPDATE tasks SET state = 'in_progress' WHERE id = ?").run(t.id);
  await run(db, projectId, jira.fetchImpl);
  expect(jira.byKey.get("WEB-1")!.labels).not.toContain(J.NEEDS_DECISION_LABEL);
});

test("the declared Jira write scope matches observed connector mutations", async () => {
  const jira = fakeJira({ issues: [{ key: "WEB-1", id: "1", status: "To Do" }] });
  const { db, projectId } = freshDb();
  await run(db, projectId, jira.fetchImpl);
  const task = tasks(db)[0];

  queueComment(db, task.id, "scope proof");
  db.query("UPDATE tasks SET state = 'in_progress' WHERE id = ?").run(task.id);
  writeEvent(db, { task_id: task.id, source: "director", type: "state_change", payload: { from: "queued", to: "in_progress" } });
  await run(db, projectId, jira.fetchImpl);
  db.query("UPDATE tasks SET state = 'needs_decision' WHERE id = ?").run(task.id);
  await run(db, projectId, jira.fetchImpl);
  db.query("UPDATE tasks SET state = 'in_progress' WHERE id = ?").run(task.id);
  await run(db, projectId, jira.fetchImpl);

  // and the image-proof path: a UI change reaching review uploads a screenshot
  const shot = join(HOME, `${task.id}-scope.png`);
  await Bun.write(shot, PNG_1PX);
  db.query("INSERT INTO evidence (id, task_id, ts, kind, path, url, caption, meta) VALUES (?,?,?,?,?,?,?,'{}')")
    .run(newId("ev"), task.id, now(), "screenshot", shot, `/evidence/${task.id}/scope.png`, "scope proof");
  db.query("UPDATE tasks SET state = 'in_review', branch = 'hive/x' WHERE id = ?").run(task.id);
  writeEvent(db, { task_id: task.id, source: "director", type: "state_change", payload: { from: "in_progress", to: "in_review" } });
  await run(db, projectId, jira.fetchImpl, CFG, { exec: execWithPatch(UI_PATCH) });

  const observed = new Set<string>();
  for (const call of jira.writes()) {
    if (call.path.includes("/transitions")) observed.add("status");
    else if (call.path.includes("/attachments")) observed.add("attachments");
    else if (call.path.includes("/comment")) observed.add("comments");
    else {
      const labelOps = call.body?.update?.labels;
      expect(Array.isArray(labelOps)).toBe(true);
      for (const operation of labelOps) {
        const label = operation.add ?? operation.remove;
        expect(J.JIRA_WRITE_SCOPE.labels).toContain(label);
      }
      observed.add("labels");
    }
  }

  expect(J.JIRA_WRITE_SCOPE).toEqual({
    status: true,
    comments: true,
    attachments: true,
    labels: [J.NEEDS_DECISION_LABEL],
    assignee: false,
    create_subtask: false,
  });
  expect([...observed].sort()).toEqual(["attachments", "comments", "labels", "status"]);
  expect(jira.calls.some((call) => call.path.includes("/assignee") || call.path.includes("/myself"))).toBe(false);
});

// ============================================================================
// UNMAPPED STATUS
// ============================================================================
test("an unmapped Jira status is recorded with its real value, never presented as 'queued' fact", async () => {
  const jira = fakeJira({ issues: [{ key: "WEB-1", id: "1", status: "Blocked" }] });
  const { db, projectId } = freshDb();
  const stats = await run(db, projectId, jira.fetchImpl);

  expect(stats.unmapped).toBeGreaterThan(0);
  const imp = syncEvents(db).find((e) => e.action === "import");
  expect(imp.jira_status).toBe("Blocked"); // the REAL value survives
  expect(imp.unmapped).toBe(true);
  expect(imp.coerced_to).toBe("queued"); // the guess is labelled as a guess
  expect(syncEvents(db).some((e) => e.action === "unmapped_status" && e.jira_status === "Blocked")).toBe(true);
  expect(jira.writes()).toEqual([]); // and nothing is written on a status we do not understand
});

test("prototype-named Jira statuses follow the ordinary unmapped path", async () => {
  for (const status of ["constructor", "__proto__"]) {
    const jira = fakeJira({ issues: [{ key: "WEB-1", id: "1", status }] });
    const { db, projectId } = freshDb();
    const stats = await run(db, projectId, jira.fetchImpl);

    expect(stats.errors).toBe(0);
    expect(stats.unmapped).toBeGreaterThan(0);
    expect(tasks(db)[0].state).toBe("queued");
    expect(syncEvents(db).some((e) => e.action === "unmapped_status" && e.jira_status === status)).toBe(true);
    expect(jira.writes()).toEqual([]);
  }
});

test("a persistently unmapped status does not write one event per cycle forever", async () => {
  const jira = fakeJira({ issues: [{ key: "WEB-1", id: "1", status: "Blocked" }] });
  const { db, projectId } = freshDb();
  await run(db, projectId, jira.fetchImpl);
  await run(db, projectId, jira.fetchImpl);
  await run(db, projectId, jira.fetchImpl);
  expect(syncEvents(db).filter((e) => e.action === "unmapped_status")).toHaveLength(1);
});

// ============================================================================
// OPEN DECISIONS
// ============================================================================
test("a terminal pull is deferred while a decision is open (expiry is irreversible)", async () => {
  const jira = fakeJira({ issues: [{ key: "WEB-1", id: "1", status: "To Do" }] });
  const { db, projectId } = freshDb();
  await run(db, projectId, jira.fetchImpl);
  const t = tasks(db)[0];
  db.query("INSERT INTO decisions (id, task_id, ts, title, status) VALUES (?,?,?,?,'open')").run(
    newId("dec"), t.id, now(), "which way?"
  );
  // Backdate the task so Jira's transition is genuinely the newer change and
  // this is unambiguously a PULL to a terminal state, which is the case at issue.
  db.query("UPDATE tasks SET created_at = '2026-01-01T00:00:00.000Z' WHERE id = ?").run(t.id);
  const iss = jira.byKey.get("WEB-1")!;
  iss.status = "Done";
  iss.history = [{ at: "2026-03-01T00:00:00.000Z", to: "Done" }];

  const stats = await run(db, projectId, jira.fetchImpl);
  expect(stats.pulled).toBe(0);
  expect(tasks(db)[0].state).toBe("queued"); // NOT forced terminal
  expect(syncEvents(db).some((e) => e.action === "pull_deferred")).toBe(true);
});

// ============================================================================
// POLL LOOP
// ============================================================================
test("manual and scheduled entry points share a per-target single-flight lock", async () => {
  const { db, projectId } = freshDb({ ...CFG });
  db.query("UPDATE projects SET created_at = ? WHERE id = ?").run("2020-01-01T00:00:00.000Z", projectId);
  let release: () => void = () => {};
  let entered: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const started = new Promise<void>((resolve) => (entered = resolve));
  const slow = (async () => {
    entered();
    await gate;
    return new Response(JSON.stringify({ issues: [], isLast: true }), { status: 200 });
  }) as unknown as typeof fetch;

  const first = J.runProjectCycle(db, projectId, { fetch: slow, token: "tok", log: () => {} });
  await started;
  const overlap = await J.runProjectCycle(db, projectId, { fetch: slow, token: "tok", log: () => {} });
  expect(overlap.ok).toBe(false);
  expect(overlap.error).toContain("already running");
  expect(overlap.state.running).toBe(true);

  const otherProject = newId("proj");
  db.query("INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)").run(
    otherProject, "other", "/repo", JSON.stringify({ jira: CFG }), "2021-01-01T00:00:00.000Z"
  );
  const otherJira = fakeJira({ issues: [] });
  const sameTarget = await J.runProjectCycle(db, otherProject, { fetch: otherJira.fetchImpl, token: "tok" });
  expect(sameTarget.ok).toBe(false);
  expect(sameTarget.error).toContain("already running for target");

  release();
  expect((await first).ok).toBe(true);
});

test("a cycle whose every request hangs aborts within its budget, and the next tick runs", async () => {
  // The wedge this guards: with no cycle budget, dozens of issues x a 20s
  // per-request timeout runs one cycle for minutes, and the single-flight guard
  // then drops EVERY subsequent tick ("previous cycle still running").
  const issues = Array.from({ length: 12 }, (_, i) => ({ key: `WEB-${i + 1}`, id: String(i + 1), status: "To Do" }));
  const { db, projectId } = freshDb({ ...CFG });

  // Discovery answers instantly; every per-issue request hangs until aborted, so
  // only the budget can end the cycle.
  const hang = (async (url: string, init: RequestInit = {}) => {
    if (String(url).includes("/search/jql"))
      return new Response(JSON.stringify({ issues: issues.map((i) => ({ key: i.key })), isLast: true }), { status: 200 });
    return await new Promise<Response>((_resolve, reject) => {
      const signal = init.signal;
      if (signal?.aborted) return reject(new Error("aborted"));
      signal?.addEventListener("abort", () => reject(new Error("aborted")));
    });
  }) as unknown as typeof fetch;

  const budgetMs = 200;
  const started = Date.now();
  const first = await J.runProjectCycle(db, projectId, {
    fetch: hang, token: "tok", budgetMs, log: () => {},
  });
  const elapsed = Date.now() - started;

  // It stopped on the budget, not on 12 x REQUEST_TIMEOUT_MS.
  expect(elapsed).toBeLessThan(budgetMs * 4);
  // ...and it says how much work it deferred rather than dropping it silently.
  expect(first.stats!.budget_skipped).toBeGreaterThan(0);
  expect(first.stats!.budget_skipped + first.stats!.errors).toBe(issues.length);

  // The whole point: the NEXT tick actually starts instead of being skipped by
  // the in-flight guard, and it picks up where the last one stopped.
  const jira = fakeJira({ issues });
  const second = await J.runProjectCycle(db, projectId, { fetch: jira.fetchImpl, token: "tok" });
  expect(second.ok).toBe(true);
  expect(second.error).toBeUndefined();
});

test("a budget-truncated cycle resumes at the deferred issue, so late issues are not starved", async () => {
  const issues = Array.from({ length: 6 }, (_, i) => ({ key: `WEB-${i + 1}`, id: String(i + 1), status: "To Do" }));
  const { db, projectId } = freshDb({ ...CFG });
  const readOrder: string[] = [];

  // Let exactly two issues through per cycle, then blow the budget.
  const makeFetch = (allow: number) => {
    let reads = 0;
    const inner = fakeJira({ issues }).fetchImpl;
    return (async (url: string, init: RequestInit = {}) => {
      const m = /\/rest\/api\/3\/issue\/(WEB-\d+)(\?|$)/.exec(String(url));
      if (m && !String(url).includes("/comment") && !String(url).includes("/changelog")) {
        readOrder.push(m[1]);
        if (++reads > allow)
          return await new Promise<Response>((_r, reject) => {
            init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          });
      }
      return inner(url as any, init as any);
    }) as unknown as typeof fetch;
  };

  await J.runProjectCycle(db, projectId, { fetch: makeFetch(2), token: "tok", budgetMs: 200, log: () => {} });
  const firstPass = [...readOrder];
  readOrder.length = 0;
  await J.runProjectCycle(db, projectId, { fetch: makeFetch(2), token: "tok", budgetMs: 200, log: () => {} });

  // The second cycle must NOT restart at WEB-1; it continues at the first issue
  // the budget stopped it from reaching.
  expect(firstPass[0]).toBe("WEB-1");
  expect(readOrder[0]).not.toBe("WEB-1");
  expect(firstPass).not.toContain(readOrder[0]); // an issue pass 1 never reached
  const nextUnreached = issues.map((i) => i.key).find((k) => !firstPass.includes(k));
  expect(readOrder[0]).toBe(nextUnreached);
});

test("an invalid JSON body is a named per-issue skip, not an opaque failure", async () => {
  const jira = fakeJira({
    issues: [{ key: "WEB-1", id: "1", status: "To Do" }, { key: "WEB-2", id: "2", status: "To Do" }],
    invalidJsonRead: ["WEB-1"],
  });
  const { db, projectId } = freshDb();

  const stats = await run(db, projectId, jira.fetchImpl);

  // Contained to the one issue: WEB-2 still imported.
  expect(stats.errors).toBe(1);
  expect(stats.imported).toBe(1);
  // The failure names the method, the path and the key, so a systemic Jira
  // fault is diagnosable instead of a bare SyntaxError.
  expect(stats.failures).toHaveLength(1);
  expect(stats.failures[0]).toContain("WEB-1");
  expect(stats.failures[0]).toContain("invalid JSON body");
  expect(stats.failures[0]).toContain("GET");
});

test("a second Hive project cannot adopt an owned Jira target", async () => {
  const jira = fakeJira({ issues: [{ key: "WEB-1", id: "1", status: "To Do" }] });
  const { db, projectId } = freshDb({ ...CFG });
  await J.runProjectCycle(db, projectId, { fetch: jira.fetchImpl, token: "tok" });
  const otherProject = newId("proj");
  db.query("INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)").run(
    otherProject, "other", "/repo", JSON.stringify({ jira: CFG }), now()
  );
  const callsBefore = jira.calls.length;

  const result = await J.runProjectCycle(db, otherProject, { fetch: jira.fetchImpl, token: "tok", log: () => {} });

  expect(result.ok).toBe(false);
  expect(result.error).toContain(`owned by Hive project ${projectId}`);
  expect(jira.calls).toHaveLength(callsBefore);
  expect(tasks(db)).toHaveLength(1);
  expect(tasks(db)[0].project_id).toBe(projectId);
});

test("an overlapping tick is SKIPPED, not queued, so a slow cycle cannot double-apply", async () => {
  const { db, projectId } = freshDb({ ...CFG });
  let inFlight = 0;
  let maxInFlight = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const slow = (async () => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await gate;
    inFlight--;
    return new Response(JSON.stringify({ issues: [], isLast: true }), { status: 200 });
  }) as unknown as typeof fetch;

  const logs: string[] = [];
  const before = Date.now();
  const stop = J.startJiraSync(db, { fetch: slow, token: "tok", intervalMs: 5, log: (m) => logs.push(m) });
  const initialDue = Date.parse(J.readSyncState(db, projectId).next_due_at ?? "");
  expect(initialDue).toBeGreaterThanOrEqual(before + 5);
  await new Promise((r) => setTimeout(r, 60)); // several ticks fire while cycle 1 is stuck
  expect(maxInFlight).toBe(1); // no overlap
  expect(logs.some((l) => l.includes("skipping this tick"))).toBe(true); // and it is visible
  expect(Date.parse(J.readSyncState(db, projectId).next_due_at ?? "")).toBeGreaterThan(initialDue);
  release();
  stop();
  expect(J.readSyncState(db, projectId).next_due_at).toBeNull();
  await new Promise((r) => setTimeout(r, 10));
});

test("the poll loop is per-instance: two loops do not share an in-flight guard", async () => {
  // A module-level singleton would wrongly serialize unrelated instances and
  // leak state across test invocations.
  const a = freshDb({ ...CFG });
  const b = freshDb({ ...CFG });
  let concurrent = 0;
  let peak = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const slow = (async () => {
    concurrent++;
    peak = Math.max(peak, concurrent);
    await gate;
    concurrent--;
    return new Response(JSON.stringify({ issues: [], isLast: true }), { status: 200 });
  }) as unknown as typeof fetch;

  const stopA = J.startJiraSync(a.db, { fetch: slow, token: "tok", intervalMs: 5, log: () => {} });
  const stopB = J.startJiraSync(b.db, { fetch: slow, token: "tok", intervalMs: 5, log: () => {} });
  await new Promise((r) => setTimeout(r, 40));
  expect(peak).toBe(2); // both instances ran; neither blocked the other
  release();
  stopA();
  stopB();
  await new Promise((r) => setTimeout(r, 10));
});

// ============================================================================
// MISC
// ============================================================================
test("adfToText flattens an Atlassian document to readable text", () => {
  const adf = {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "line one" }] },
      { type: "paragraph", content: [{ type: "text", text: "line two" }] },
    ],
  };
  expect(J.adfToText(adf).trim()).toBe("line one\nline two");
  expect(J.adfToText(null)).toBe("");
});

test("status mapping is total over the real WEB workflow, in both directions", () => {
  expect(J.jiraStatusToState("To Do")).toBe("queued");
  expect(J.jiraStatusToState("in progress")).toBe("in_progress"); // case-insensitive
  expect(J.jiraStatusToState("In Review")).toBe("in_review");
  expect(J.jiraStatusToState("Done")).toBe("done");
  expect(J.jiraStatusToState("Blocked")).toBeNull();
  expect(J.jiraStatusToState("constructor")).toBeNull();
  expect(J.jiraStatusToState("__proto__")).toBeNull();
  expect(J.stateToJiraStatus("needs_decision")).toBeNull();
  expect(J.stateToJiraStatus("constructor")).toBeNull();
  expect(J.stateToJiraStatus("__proto__")).toBeNull();
  expect(J.stateToJiraStatus("verifying")).toBe("In Review");
});


// ============================================================================
// ASSIGNEE IS NEVER WRITTEN  (dec_234877ea4617 = "disable")
// ============================================================================
test("hive never writes the assignee field, in any state, in either direction", async () => {
  // The guarantee "a human's assignment is never touched" only holds absolutely
  // if hive never writes the field. So the test is not "does hive pick the right
  // moment to write" — it is that no assignee request is EVER issued.
  for (const [start, assignee] of [["In Progress", null], ["In Progress", HUMAN], ["To Do", SELF]] as const) {
    const jira = fakeJira({ issues: [{ key: "WEB-1", id: "1", status: start, assignee }] });
    const { db, projectId } = freshDb();
    await run(db, projectId, jira.fetchImpl);
    const t = tasks(db)[0];
    // walk it through every state that used to trigger an assign or unassign
    for (const st of ["in_progress", "needs_decision", "in_review", "verifying", "queued", "failed"]) {
      db.query("UPDATE tasks SET state = ? WHERE id = ?").run(st, t.id);
      await run(db, projectId, jira.fetchImpl);
    }
    expect(jira.calls.some((c) => c.path.includes("/assignee"))).toBe(false);
    expect(jira.byKey.get("WEB-1")!.assignee).toBe(assignee); // untouched, whatever it was
    // and hive never even asks who it is
    expect(jira.calls.some((c) => c.path.includes("/myself"))).toBe(false);
  }
});

test("the mirrored brief displays Jira's assignee without writing it", async () => {
  const jira = fakeJira({ issues: [{ key: "WEB-1", id: "1", status: "To Do", assignee: HUMAN }] });
  const { db, projectId } = freshDb();
  await run(db, projectId, jira.fetchImpl);
  expect(tasks(db)[0].brief).toContain(`Assignee: ${HUMAN}`);
  expect(jira.writes()).toEqual([]);
});

// ============================================================================
// FIRST-CYCLE FALL-THROUGH  (import must not skip reconciliation)
// ============================================================================
test("an imported issue is reconciled on the SAME cycle, so its comments arrive immediately", async () => {
  // Import used to `continue` past reconciliation, so everything an issue
  // already carried waited a full cycle. The first cycle is the one a director
  // actually reads, and on it EVERY issue takes the import path.
  const jira = fakeJira({
    issues: [{ key: "WEB-1", id: "1", status: "To Do", comments: [
      { id: "j1", author: "Alex", text: "please start with the CMS bits", created: "2026-05-01T00:00:00.000Z" },
    ] }],
  });
  const { db, projectId } = freshDb();
  const stats = await run(db, projectId, jira.fetchImpl, { ...CFG, write: false });
  expect(stats.imported).toBe(1);
  expect(stats.comments_pulled).toBe(1); // same cycle, not the next one
  expect(jira.writes()).toEqual([]); // and shadow mode still sent nothing
});

test("comments fetched before the final scope check are not imported after the issue leaves scope", async () => {
  const inScope = ["WEB-1"];
  const jira = fakeJira({
    issues: [{ key: "WEB-1", id: "1", status: "To Do", comments: [
      { id: "j1", author: "Alex", text: "out of scope" },
    ] }],
    jqlOnly: inScope,
    onComments: () => inScope.splice(0),
  });
  const { db, projectId } = freshDb();
  const stats = await run(db, projectId, jira.fetchImpl, { ...CFG, jql: "labels = CMS" });
  expect(stats.imported).toBe(0);
  expect(stats.comments_pulled).toBe(0);
  expect(tasks(db)).toEqual([]);
});

// ============================================================================
// COMMENTS: IDEMPOTENT DELIVERY WITH CONTAINED UNKNOWNS
// ============================================================================
const queueComment = (db: DB, taskId: string, text: string) =>
  writeEvent(db, { task_id: taskId, source: "director", type: "jira_comment", payload: { direction: "outbound", text, delivery: "queued" } });

test("link creation sends Jira's sub-task payload and stores the link", async () => {
  const jira = fakeJira({ issues: [] });
  const { db, projectId } = freshDb({ ...CFG, write_scope: { create_subtask: true } });
  const taskId = newId();
  const ts = now();
  db.query(
    `INSERT INTO tasks (id, project_id, title, pr_url, state, kind, created_at, updated_at)
     VALUES (?, ?, 'Ship outbound links', 'https://github.com/acme/hive/pull/1', 'queued', 'ship', ?, ?)`
  ).run(taskId, projectId, ts, ts);

  const linked = await J.linkTaskToJira(db, taskId, "web-7", { fetch: jira.fetchImpl, token: "tok" });

  expect(linked).toMatchObject({ jira_key: "WEB-99", browse_url: `${SITE}/browse/WEB-99`, warnings: [] });
  expect(db.query("SELECT jira_key, jira_link_kind FROM tasks WHERE id = ?").get(taskId)).toEqual({
    jira_key: "WEB-99", jira_link_kind: "subtask",
  });
  const create = jira.calls.find((call) => call.method === "POST" && call.path === "/rest/api/3/issue");
  expect(create?.body.fields).toMatchObject({
    project: { key: "WEB" }, parent: { key: "WEB-7" }, issuetype: { id: "10002" },
    reporter: { accountId: SELF }, summary: "P-1 · Ship outbound links",
  });
  expect(J.adfToText(create?.body.fields.description)).toContain(`hive-task: ${taskId}`);
  expect(create?.body.properties).toEqual([{ key: "hive.task_id", value: taskId }]);
  expect(jira.calls.filter((call) => call.method === "POST" && call.path.endsWith("/remotelink"))).toHaveLength(2);
});

test("link creation deletes the Jira sub-task when another link wins the database race", async () => {
  const { db, projectId } = freshDb({ ...CFG, write_scope: { create_subtask: true } });
  const taskId = newId();
  db.query(
    `INSERT INTO tasks (id, project_id, title, state, kind, created_at, updated_at)
     VALUES (?, ?, 'Race', 'queued', 'ship', ?, ?)`
  ).run(taskId, projectId, now(), now());
  const jira = fakeJira({
    issues: [],
    onCreate: () => db.query("UPDATE tasks SET jira_key = 'WEB-98', jira_link_kind = 'subtask' WHERE id = ?").run(taskId),
  });

  await expect(J.linkTaskToJira(db, taskId, "WEB-7", { fetch: jira.fetchImpl, token: "tok" })).rejects.toThrow(/was deleted/);
  expect(db.query("SELECT jira_key FROM tasks WHERE id = ?").get(taskId)).toEqual({ jira_key: "WEB-98" });
  expect(jira.calls).toContainEqual(expect.objectContaining({ method: "DELETE", path: "/rest/api/3/issue/WEB-99" }));
});

test("link creation reports an orphan when race cleanup fails", async () => {
  const { db, projectId } = freshDb({ ...CFG, write_scope: { create_subtask: true } });
  const taskId = newId();
  db.query(
    `INSERT INTO tasks (id, project_id, title, state, kind, created_at, updated_at)
     VALUES (?, ?, 'Race cleanup', 'queued', 'ship', ?, ?)`
  ).run(taskId, projectId, now(), now());
  const jira = fakeJira({
    issues: [],
    failDelete: true,
    onCreate: () => db.query("UPDATE tasks SET jira_key = 'WEB-98', jira_link_kind = 'subtask' WHERE id = ?").run(taskId),
  });

  await expect(J.linkTaskToJira(db, taskId, "WEB-7", { fetch: jira.fetchImpl, token: "tok" }))
    .rejects.toThrow(/cleanup of the unlinked sub-task failed/);
  expect(db.query("SELECT jira_key FROM tasks WHERE id = ?").get(taskId)).toEqual({ jira_key: "WEB-98" });
});

test("linking an already-cancelled task queues its cancellation comment once", async () => {
  const jira = fakeJira({ issues: [{ key: "WEB-99", id: "99", status: "To Do" }] });
  const { db, projectId } = freshDb({ ...CFG, write_scope: { create_subtask: true } });
  const taskId = newId();
  db.query(
    `INSERT INTO tasks (id, project_id, title, state, kind, created_at, updated_at)
     VALUES (?, ?, 'Already cancelled', 'cancelled', 'ship', ?, ?)`
  ).run(taskId, projectId, now(), now());

  await J.linkTaskToJira(db, taskId, "WEB-7", { fetch: jira.fetchImpl, token: "tok" });
  await run(db, projectId, jira.fetchImpl);
  await run(db, projectId, jira.fetchImpl);

  expect(jira.byKey.get("WEB-99")!.comments).toHaveLength(1);
  expect(db.query(
    `SELECT COUNT(*) AS count FROM events WHERE task_id = ? AND type = 'jira_comment'
       AND json_extract(payload, '$.linked_cancelled') = 1`
  ).get(taskId)).toEqual({ count: 1 });
});

test("cancelling a linked task queues one comment for normal outbound delivery", async () => {
  const jira = fakeJira({ issues: [{ key: "WEB-23", id: "23", status: "To Do" }] });
  const { db, projectId } = freshDb();
  const taskId = newId();
  db.query(
    `INSERT INTO tasks (id, project_id, title, state, kind, jira_key, jira_link_kind, created_at, updated_at)
     VALUES (?, ?, 'Cancel linked task', 'queued', 'ship', 'WEB-23', 'subtask', ?, ?)`
  ).run(taskId, projectId, now(), now());

  transition(db, taskId, "cancelled", { source: "director", reason: "no longer needed" });

  const queued = db.query("SELECT source, payload FROM events WHERE task_id = ? AND type = 'jira_comment'").all(taskId) as any[];
  expect(queued).toHaveLength(1);
  expect(queued[0].source).toBe("director");
  expect(JSON.parse(queued[0].payload)).toMatchObject({
    direction: "outbound", linked_cancelled: true, text: "Hive marked this task cancelled.",
  });

  await run(db, projectId, jira.fetchImpl);
  await run(db, projectId, jira.fetchImpl);

  expect(jira.byKey.get("WEB-23")!.status).toBe("Done");
  expect(jira.byKey.get("WEB-23")!.comments).toHaveLength(1);
  expect(db.query(
    `SELECT COUNT(*) AS count FROM events WHERE task_id = ? AND type = 'jira_sync'
     AND json_extract(payload, '$.action') = 'comment_push' AND json_extract(payload, '$.outcome') = 'ok'`
  ).get(taskId)).toEqual({ count: 1 });
});

test("a Jira marker discovers a native task and linked writes are delivered once", async () => {
  const taskId = newId();
  const jira = fakeJira({ issues: [{
    key: "WEB-23", id: "23", status: "To Do", parentKey: "WEB-7",
    description: J.textToAdf(`implementation notes\nhive-task: ${taskId}`),
  }], jqlOnly: [] });
  const { db, projectId } = freshDb();
  const ts = now();
  db.query(
    "INSERT INTO tasks (id, project_id, title, state, kind, created_at, updated_at) VALUES (?, ?, 'Native task', 'queued', 'ship', ?, ?)"
  ).run(taskId, projectId, ts, ts);
  db.query(
    `INSERT INTO tasks (id, project_id, title, state, kind, source, source_ref, jira_key, jira_link_kind, created_at, updated_at)
     VALUES (?, ?, 'Mirror', 'queued', 'ship', 'external', 'jira:WEB-23', 'WEB-23', 'mirror', ?, ?)`
  ).run(newId(), projectId, ts, ts);

  const cfg = { ...CFG, jql: "labels = CMS" };
  const first = await run(db, projectId, jira.fetchImpl, cfg);
  expect(first.errors).toBe(0);
  expect(first.failures).toEqual([]);
  expect(db.query("SELECT jira_link_kind FROM tasks WHERE jira_key = 'WEB-23' ORDER BY jira_link_kind").all()).toEqual([
    { jira_link_kind: "mirror" }, { jira_link_kind: "subtask" },
  ]);
  expect(db.query("SELECT jira_key, jira_link_kind FROM tasks WHERE id = ?").get(taskId)).toEqual({
    jira_key: "WEB-23", jira_link_kind: "subtask",
  });
  expect(syncEvents(db)).toContainEqual(expect.objectContaining({ action: "link_discovered", issue: "WEB-23", parent: "WEB-7" }));

  db.query("UPDATE tasks SET state = 'in_progress' WHERE id = ?").run(taskId);
  writeEvent(db, { task_id: taskId, source: "director", type: "state_change", payload: { from: "queued", to: "in_progress" } });
  queueComment(db, taskId, "status note");
  await run(db, projectId, jira.fetchImpl, cfg);
  await run(db, projectId, jira.fetchImpl, cfg);

  expect(jira.byKey.get("WEB-23")!.status).toBe("In Progress");
  expect(jira.calls.filter((call) => call.method === "POST" && call.path.endsWith("/transitions"))).toHaveLength(1);
  expect(jira.byKey.get("WEB-23")!.comments).toHaveLength(1);
  expect(new URL(jira.calls.find((call) => call.path.startsWith("/rest/api/3/search/jql?"))!.path, SITE).searchParams.get("jql"))
    .toBe("project = WEB");
});

test("a rejected marker link does not stop the rest of the sync cycle", async () => {
  const taskId = newId();
  const jira = fakeJira({ issues: [
    { key: "WEB-23", id: "23", status: "To Do", description: J.textToAdf(`hive-task: ${taskId}`) },
    { key: "WEB-24", id: "24", status: "To Do" },
  ] });
  const { db, projectId } = freshDb();
  db.query(
    "INSERT INTO tasks (id, project_id, title, state, kind, created_at, updated_at) VALUES (?, ?, 'Rejected marker', 'queued', 'ship', ?, ?)"
  ).run(taskId, projectId, now(), now());
  db.exec(`CREATE TRIGGER reject_marker BEFORE UPDATE OF jira_key ON tasks WHEN NEW.id = '${taskId}' BEGIN SELECT RAISE(FAIL, 'marker rejected'); END`);

  const stats = await run(db, projectId, jira.fetchImpl);

  expect(stats.errors).toBe(1);
  expect(stats.imported).toBe(1);
  expect(db.query("SELECT jira_key FROM tasks WHERE id = ?").get(taskId)).toEqual({ jira_key: null });
  expect(db.query("SELECT id FROM tasks WHERE jira_key = 'WEB-24'").get()).toBeTruthy();
});

test("an acknowledged outbound comment is not redelivered across repeated cycles", async () => {
  const jira = fakeJira({ issues: [{ key: "WEB-1", id: "1", status: "To Do" }] });
  const { db, projectId } = freshDb();
  await run(db, projectId, jira.fetchImpl);
  queueComment(db, tasks(db)[0].id, "hive says hello");

  const s1 = await run(db, projectId, jira.fetchImpl);
  expect(s1.comments_pushed).toBe(1);
  expect(jira.byKey.get("WEB-1")!.comments).toHaveLength(1);

  for (let i = 0; i < 3; i++) await run(db, projectId, jira.fetchImpl);
  expect(jira.byKey.get("WEB-1")!.comments).toHaveLength(1);
});

test("outbound comments use Jira's object-valued property wire format", async () => {
  const jira = fakeJira({ issues: [{ key: "WEB-1", id: "1", status: "To Do" }] });
  const { db, projectId } = freshDb();
  await run(db, projectId, jira.fetchImpl);
  const event = queueComment(db, tasks(db)[0].id, "wire contract");

  await run(db, projectId, jira.fetchImpl);

  const request = jira.calls.find((call) => call.method === "POST" && call.path.includes("/comment"));
  expect(request?.body?.properties).toEqual([
    { key: "hive.event_id", value: { id: event.id } },
  ]);
  expect(typeof request?.body?.properties?.[0]?.value).toBe("object");
});

test("a legacy comment receipt remains delivered after upgrade", async () => {
  const jira = fakeJira({ issues: [{ key: "WEB-1", id: "1", status: "To Do" }] });
  const { db, projectId } = freshDb();
  await run(db, projectId, jira.fetchImpl);
  const task = tasks(db)[0];
  const comment = queueComment(db, task.id, "already delivered by the old connector");
  writeEvent(db, {
    task_id: task.id,
    source: "jira-sync",
    type: "jira_sync",
    payload: { action: "comment_push", event_id: comment.id, jira_comment_id: "legacy-7" },
  });

  expect(J.pendingOutbound(db, task.id)).toEqual({ comments: 0, receipts: 0, unknown: [] });
  const stats = await run(db, projectId, jira.fetchImpl);
  expect(stats.comments_pushed).toBe(0);
  expect(jira.byKey.get("WEB-1")!.comments).toEqual([]);
  expect(J.deliveredOutbound(db, task.id)).toContainEqual(expect.objectContaining({ event_id: comment.id, jira_comment_id: "legacy-7" }));
});

test("a comment posted but whose receipt was lost is NOT posted twice", async () => {
  // The crash window: Jira accepted the write, hive died before recording it.
  // The comment property is what makes this recoverable, and a local-only
  // "sent?" flag could not have survived it.
  const jira = fakeJira({ issues: [{ key: "WEB-1", id: "1", status: "To Do" }] });
  const { db, projectId } = freshDb();
  await run(db, projectId, jira.fetchImpl);
  const t = tasks(db)[0];
  const ev = queueComment(db, t.id, "delivered but unacknowledged");

  writeEvent(db, {
    task_id: t.id,
    source: "jira-sync",
    type: "jira_sync",
    payload: { action: "comment_push", source_id: ev.id, outcome: "sending" },
  });
  writeEvent(db, {
    task_id: t.id,
    source: "jira-sync",
    type: "jira_sync",
    payload: { action: "comment_push", source_id: ev.id, outcome: "unknown", error: "connection reset" },
  });

  // simulate: the comment IS on Jira carrying hive's property, but hive has no receipt
  jira.byKey.get("WEB-1")!.comments = [
    { id: "j99", author: "Hive", text: "delivered but unacknowledged", properties: [{ key: "hive.event_id", value: { id: ev.id } }] },
  ];

  const stats = await run(db, projectId, jira.fetchImpl);
  expect(stats.comments_pushed).toBe(0); // nothing re-sent
  expect(jira.byKey.get("WEB-1")!.comments).toHaveLength(1);
  const rec = syncEvents(db).find((e) => e.action === "comment_push" && e.recovered);
  expect(rec.jira_comment_id).toBe("j99"); // and the receipt was healed
});

test("property reads accept object ids and reject bare scalar ids", async () => {
  for (const encoded of [true, false]) {
    const jira = fakeJira({ issues: [{ key: "WEB-1", id: "1", status: "To Do" }] });
    const { db, projectId } = freshDb();
    await run(db, projectId, jira.fetchImpl);
    const task = tasks(db)[0];
    const event = queueComment(db, task.id, "property contract");
    jira.byKey.get("WEB-1")!.comments = [{
      raw: {
        id: "remote-1",
        body: J.textToAdf("property contract"),
        properties: [{ key: "hive.event_id", value: encoded ? { id: event.id } : event.id }],
      },
    }];

    const stats = await run(db, projectId, jira.fetchImpl, CFG, { log: () => {} });

    expect(stats.errors).toBe(encoded ? 0 : 1);
    expect(J.pendingOutbound(db, task.id).comments).toBe(encoded ? 0 : 1);
    expect(jira.writes()).toEqual([]);
  }
});

test("malformed Jira comments cannot prove delivery", async () => {
  const malformedComments = [
    (sourceId: string) => ({ body: J.textToAdf("forged"), properties: [{ key: "hive.event_id", value: { id: sourceId } }] }),
    (sourceId: string) => ({ id: "remote-1", body: { type: "doc", version: 1, content: "bad" }, properties: [{ key: "hive.event_id", value: { id: sourceId } }] }),
    (sourceId: string) => ({ id: "remote-1", body: J.textToAdf("forged"), properties: { key: "hive.event_id", value: { id: sourceId } } }),
    (sourceId: string) => ({ id: "remote-1", body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text" }] }] }, properties: [{ key: "hive.event_id", value: { id: sourceId } }] }),
    (sourceId: string) => ({ id: "remote-1", body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "" }] }] }, properties: [{ key: "hive.event_id", value: { id: sourceId } }] }),
  ];

  for (const malformed of malformedComments) {
    const jira = fakeJira({ issues: [{ key: "WEB-1", id: "1", status: "To Do" }] });
    const { db, projectId } = freshDb();
    await run(db, projectId, jira.fetchImpl);
    const task = tasks(db)[0];
    const sourceId = queueComment(db, task.id, "must remain pending").id;
    jira.byKey.get("WEB-1")!.comments = [{ raw: malformed(sourceId) }];

    const stats = await run(db, projectId, jira.fetchImpl, CFG, { log: () => {} });

    expect(stats.errors).toBe(1);
    expect(stats.failures[0]).toContain("invalid Jira comment");
    expect(stats.comments_pushed).toBe(0);
    expect(J.pendingOutbound(db, task.id)).toEqual({ comments: 1, receipts: 0, unknown: [] });
    expect(J.deliveredOutbound(db, task.id)).toEqual([]);
    expect(jira.writes()).toEqual([]);
  }
});

test("an unknown comment outcome is contained through the late-arrival window", async () => {
  let sourceId = "";
  const jira = fakeJira({
    issues: [{ key: "WEB-1", id: "1", status: "To Do" }],
    throwCommentPosts: 1,
    onScopeProbe: (_key, issue, nth) => {
      if (nth === 4) issue.comments = [{
        id: "late",
        author: "Hive",
        text: "arrived after timeout",
        properties: [{ key: "hive.event_id", value: { id: sourceId } }],
      }];
    },
  });
  const { db, projectId } = freshDb();
  await run(db, projectId, jira.fetchImpl);
  const t = tasks(db)[0];
  sourceId = queueComment(db, t.id, "arrived after timeout").id;

  const failed = await run(db, projectId, jira.fetchImpl);
  expect(failed.errors).toBe(1);
  expect(J.pendingOutbound(db, t.id).comments).toBe(1);
  expect(J.pendingOutbound(db, t.id).unknown).toHaveLength(1);
  expect(jira.byKey.get("WEB-1")!.comments).toHaveLength(0);

  const contained = await run(db, projectId, jira.fetchImpl);
  expect(contained.comments_pushed).toBe(0);
  expect(jira.byKey.get("WEB-1")!.comments).toHaveLength(1);
  expect(J.pendingOutbound(db, t.id).unknown).toHaveLength(1);

  const recovered = await run(db, projectId, jira.fetchImpl);
  expect(recovered.comments_pushed).toBe(0);
  expect(J.pendingOutbound(db, t.id).comments).toBe(0);
  expect(J.pendingOutbound(db, t.id).unknown).toEqual([]);
  expect(jira.byKey.get("WEB-1")!.comments).toHaveLength(1);
});

test("a definite Jira rejection stays visible and retries after recovery", async () => {
  const jira = fakeJira({ issues: [{ key: "WEB-1", id: "1", status: "To Do" }], rejectCommentPosts: 1 });
  const { db, projectId } = freshDb();
  await run(db, projectId, jira.fetchImpl);
  const task = tasks(db)[0];
  queueComment(db, task.id, "retry after Jira recovers");

  const rejected = await run(db, projectId, jira.fetchImpl);
  expect(rejected.errors).toBe(1);
  expect(J.pendingOutbound(db, task.id)).toEqual({ comments: 1, receipts: 0, unknown: [] });
  expect(syncEvents(db)).toContainEqual(expect.objectContaining({ action: "comment_push", outcome: "failed" }));

  const retried = await run(db, projectId, jira.fetchImpl);
  expect(retried.comments_pushed).toBe(1);
  expect(J.pendingOutbound(db, task.id)).toEqual({ comments: 0, receipts: 0, unknown: [] });
  expect(jira.byKey.get("WEB-1")!.comments).toHaveLength(1);
});

test("systemic Jira comment rejections stay pending until recovery", async () => {
  for (const status of [405, 410, 415]) {
    const jira = fakeJira({
      issues: [{ key: "WEB-1", id: "1", status: "To Do" }],
      rejectCommentPosts: 1,
      rejectCommentStatus: status,
    });
    const { db, projectId } = freshDb();
    await run(db, projectId, jira.fetchImpl);
    const task = tasks(db)[0];
    queueComment(db, task.id, `retry after Jira ${status}`);

    const rejected = await run(db, projectId, jira.fetchImpl);
    expect(rejected.errors).toBe(1);
    expect(J.pendingOutbound(db, task.id)).toEqual({ comments: 1, receipts: 0, unknown: [] });
    expect(syncEvents(db)).toContainEqual(expect.objectContaining({ action: "comment_push", outcome: "failed" }));

    const retried = await run(db, projectId, jira.fetchImpl);
    expect(retried.comments_pushed).toBe(1);
    expect(J.pendingOutbound(db, task.id)).toEqual({ comments: 0, receipts: 0, unknown: [] });
  }
});

test("a permanent Jira rejection settles an immutable legacy comment", async () => {
  const jira = fakeJira({
    issues: [{ key: "WEB-1", id: "1", status: "To Do" }],
    rejectCommentPosts: 1,
    rejectCommentStatus: 413,
  });
  const { db, projectId } = freshDb();
  await run(db, projectId, jira.fetchImpl);
  const task = tasks(db)[0];
  const comment = queueComment(db, task.id, "legacy payload Jira rejects as too large");

  const rejected = await run(db, projectId, jira.fetchImpl);

  expect(rejected.errors).toBe(0);
  expect(J.pendingOutbound(db, task.id)).toEqual({ comments: 0, receipts: 0, unknown: [] });
  expect(syncEvents(db)).toContainEqual(expect.objectContaining({
    action: "comment_push",
    source_id: comment.id,
    outcome: "rejected",
    error: expect.stringContaining("413 comment rejected"),
  }));
  const posts = () => jira.calls.filter((call) => call.method === "POST" && call.path.includes("/comment")).length;
  expect(posts()).toBe(1);
  await run(db, projectId, jira.fetchImpl);
  expect(posts()).toBe(1);
});

test("a Jira 5xx after committing a comment is contained without reposting", async () => {
  const jira = fakeJira({ issues: [{ key: "WEB-1", id: "1", status: "To Do" }], failCommentPosts: 1 });
  const { db, projectId } = freshDb();
  await run(db, projectId, jira.fetchImpl);
  const task = tasks(db)[0];
  queueComment(db, task.id, "committed before Jira returned 500");

  const failed = await run(db, projectId, jira.fetchImpl);
  expect(failed.errors).toBe(1);
  expect(jira.byKey.get("WEB-1")!.comments).toHaveLength(1);
  expect(J.pendingOutbound(db, task.id).unknown).toHaveLength(1);
  expect(syncEvents(db)).toContainEqual(expect.objectContaining({ action: "comment_push", outcome: "terminal_unknown" }));

  const recovered = await run(db, projectId, jira.fetchImpl);
  expect(recovered.comments_pushed).toBe(0);
  expect(jira.byKey.get("WEB-1")!.comments).toHaveLength(1);
  expect(J.pendingOutbound(db, task.id)).toEqual({ comments: 0, receipts: 0, unknown: [] });
});

test("a malformed Jira comment acknowledgement is contained and recovered", async () => {
  const jira = fakeJira({
    issues: [{ key: "WEB-1", id: "1", status: "To Do" }],
    commentPostResponse: {},
  });
  const { db, projectId } = freshDb();
  await run(db, projectId, jira.fetchImpl);
  const task = tasks(db)[0];
  queueComment(db, task.id, "committed with a malformed acknowledgement");

  const failed = await run(db, projectId, jira.fetchImpl);
  expect(failed.errors).toBe(1);
  expect(failed.failures[0]).toContain("invalid Jira comment response for WEB-1");
  expect(jira.byKey.get("WEB-1")!.comments).toHaveLength(1);
  expect(J.pendingOutbound(db, task.id).unknown).toHaveLength(1);
  expect(syncEvents(db)).toContainEqual(expect.objectContaining({ action: "comment_push", outcome: "terminal_unknown" }));
  expect(syncEvents(db)).not.toContainEqual(expect.objectContaining({ action: "comment_push", outcome: "ok" }));

  const recovered = await run(db, projectId, jira.fetchImpl);
  expect(recovered.comments_pushed).toBe(0);
  expect(jira.byKey.get("WEB-1")!.comments).toHaveLength(1);
  expect(J.pendingOutbound(db, task.id)).toEqual({ comments: 0, receipts: 0, unknown: [] });
});

test("delivery containment keeps ambiguous rows visible until resolution", async () => {
  const jira = fakeJira({ issues: [{ key: "WEB-1", id: "1", status: "To Do" }] });
  const { db, projectId } = freshDb();
  await run(db, projectId, jira.fetchImpl);
  const t = tasks(db)[0];
  const outcomes = ["sending", "unknown", "terminal_unknown", "ok", "recovered", "rejected", "resolved"] as const;
  for (const outcome of outcomes) {
    const comment = queueComment(db, t.id, outcome);
    const evidence = addEvidence(db, t.id, "report", outcome);
    const payload = outcome === "recovered" ? { outcome, recovered: true } : { outcome };
    writeEvent(db, {
      task_id: t.id,
      source: "jira-sync",
      type: "jira_sync",
      payload: { action: "comment_push", source_id: comment.id, ...payload },
    });
    writeEvent(db, {
      task_id: t.id,
      source: "jira-sync",
      type: "jira_sync",
      payload: { action: "receipt", source_id: evidence, ...payload },
    });
  }

  expect(J.pendingOutbound(db, t.id)).toMatchObject({ comments: 3, receipts: 3 });
  expect(J.pendingOutbound(db, t.id).unknown).toHaveLength(4);
  for (const row of J.pendingOutbound(db, t.id).unknown)
    expect(J.resolveUnknownOutbound(db, t.id, row.action, row.source_id)).toBe(true);
  const stats = await run(db, projectId, jira.fetchImpl);
  expect(stats.comments_pushed).toBe(0);
  expect(stats.receipts).toBe(0);
  expect(jira.byKey.get("WEB-1")!.comments).toHaveLength(0);
  expect(J.pendingOutbound(db, t.id).unknown).toHaveLength(2);
  for (const row of J.pendingOutbound(db, t.id).unknown)
    expect(J.resolveUnknownOutbound(db, t.id, row.action, row.source_id)).toBe(true);
  expect(J.pendingOutbound(db, t.id)).toEqual({ comments: 0, receipts: 0, unknown: [] });
});

test("the latest delivery outcome reopens a previously resolved row", async () => {
  const jira = fakeJira({ issues: [{ key: "WEB-1", id: "1", status: "To Do" }] });
  const { db, projectId } = freshDb();
  await run(db, projectId, jira.fetchImpl);
  const task = tasks(db)[0];
  const comment = queueComment(db, task.id, "retry after the latest failure");
  writeEvent(db, {
    task_id: task.id,
    source: "jira-sync",
    type: "jira_sync",
    payload: { action: "comment_push", source_id: comment.id, outcome: "sending" },
  });
  expect(J.resolveUnknownOutbound(db, task.id, "comment_push", comment.id)).toBe(false);
  writeEvent(db, {
    task_id: task.id,
    source: "jira-sync",
    type: "jira_sync",
    payload: { action: "comment_push", source_id: comment.id, outcome: "terminal_unknown" },
  });
  expect(J.resolveUnknownOutbound(db, task.id, "comment_push", comment.id)).toBe(true);
  writeEvent(db, {
    task_id: task.id,
    source: "jira-sync",
    type: "jira_sync",
    payload: { action: "comment_push", source_id: comment.id, outcome: "failed", error: "rejected after resolution" },
  });

  expect(J.pendingOutbound(db, task.id)).toEqual({ comments: 1, receipts: 0, unknown: [] });
  const stats = await run(db, projectId, jira.fetchImpl);
  expect(stats.comments_pushed).toBe(1);
  expect(J.pendingOutbound(db, task.id)).toEqual({ comments: 0, receipts: 0, unknown: [] });
});

test("an invalid queued comment receives a terminal rejection", async () => {
  const jira = fakeJira({ issues: [{ key: "WEB-1", id: "1", status: "To Do" }] });
  const { db, projectId } = freshDb();
  await run(db, projectId, jira.fetchImpl);
  const t = tasks(db)[0];
  const comment = queueComment(db, t.id, "   ");

  await run(db, projectId, jira.fetchImpl);

  expect(J.pendingOutbound(db, t.id)).toEqual({ comments: 0, receipts: 0, unknown: [] });
  expect(syncEvents(db)).toContainEqual(expect.objectContaining({
    action: "comment_push",
    source_id: comment.id,
    outcome: "rejected",
    error: "empty outbound Jira comment",
  }));
  expect(jira.byKey.get("WEB-1")!.comments).toEqual([]);
});

test("comment and receipt writes abort when the issue leaves scope at their boundary", async () => {
  let leaveScope = false;
  const jira = fakeJira({
    issues: [{ key: "WEB-1", id: "1", status: "To Do" }],
    onRead: (_key, issue, nth) => {
      if (leaveScope && nth >= 3) issue.projectKey = "OTHER";
    },
  });
  const { db, projectId } = freshDb();
  await run(db, projectId, jira.fetchImpl);
  const t = tasks(db)[0];
  queueComment(db, t.id, "do not post");
  addEvidence(db, t.id, "report", "do not post");
  leaveScope = true;

  const stats = await run(db, projectId, jira.fetchImpl);
  expect(stats.blocked).toBe(2);
  expect(jira.writes()).toEqual([]);
  expect(J.pendingOutbound(db, t.id)).toEqual({ comments: 1, receipts: 1, unknown: [] });
});

test("JQL scope is the final network check before comment writes", async () => {
  const inScope = ["WEB-1"];
  let armed = false;
  const jira = fakeJira({
    issues: [{ key: "WEB-1", id: "1", status: "To Do" }],
    jqlOnly: inScope,
    onChangelog: (_key, _issue, nth) => {
      if (armed && nth >= 3) inScope.splice(0);
    },
  });
  const { db, projectId } = freshDb();
  const cfg = { ...CFG, jql: "labels = CMS" };
  await run(db, projectId, jira.fetchImpl, cfg);
  const t = tasks(db)[0];
  queueComment(db, t.id, "do not post after scope moves");
  armed = true;

  const stats = await run(db, projectId, jira.fetchImpl, cfg);
  expect(stats.blocked).toBe(1);
  expect(jira.writes()).toEqual([]);
  expect(J.pendingOutbound(db, t.id).comments).toBe(1);
});

test("hive never re-imports its own comment as though a human wrote it", async () => {
  const jira = fakeJira({ issues: [{ key: "WEB-1", id: "1", status: "To Do" }] });
  const { db, projectId } = freshDb();
  await run(db, projectId, jira.fetchImpl);
  queueComment(db, tasks(db)[0].id, "hive speaking");
  await run(db, projectId, jira.fetchImpl);
  const s2 = await run(db, projectId, jira.fetchImpl);
  expect(s2.comments_pulled).toBe(0);
});

test("an incomplete comment page chain fails closed rather than re-posting", async () => {
  // A truncated comment list would hide the receipts that prove delivery, so
  // reading it as complete is how duplicates get created.
  const many = Array.from({ length: 60 }, (_, i) => ({ id: `j${i}`, author: "Someone", text: `c${i}` }));
  const jira = fakeJira({ issues: [{ key: "WEB-1", id: "1", status: "To Do", comments: many }], commentPageCap: 1 });
  const { db, projectId } = freshDb();
  const stats = await run(db, projectId, jira.fetchImpl);
  expect(stats.errors).toBe(1);
  expect(stats.skipped).toBe(0);
  expect(stats.failures[0]).toContain("exceeded pagination limit");
  expect(jira.writes()).toEqual([]);
});

test("an empty comment page before the advertised total cannot cause a duplicate", async () => {
  const opts: FakeOpts = {
    issues: [{ key: "WEB-1", id: "1", status: "To Do" }],
    commentPageCap: 1,
  };
  const jira = fakeJira(opts);
  const { db, projectId } = freshDb();
  await run(db, projectId, jira.fetchImpl);
  const t = tasks(db)[0];
  const ev = queueComment(db, t.id, "already delivered");
  jira.byKey.get("WEB-1")!.comments = [
    { id: "j1", author: "Someone", text: "first" },
    { id: "j2", author: "Hive", text: "already delivered", properties: [{ key: "hive.event_id", value: { id: ev.id } }] },
  ];
  opts.emptyCommentPageAt = 1;

  const stats = await run(db, projectId, jira.fetchImpl);
  expect(stats.errors).toBe(1);
  expect(stats.skipped).toBe(0);
  expect(stats.failures[0]).toContain("incomplete Jira comment history");
  expect(jira.byKey.get("WEB-1")!.comments).toHaveLength(2);
  expect(jira.writes()).toEqual([]);
  expect(J.pendingOutbound(db, t.id).comments).toBe(1);
});

test("a later comment page cannot revise an earlier total and hide a delivery property", async () => {
  const opts: FakeOpts = {
    issues: [{ key: "WEB-1", id: "1", status: "To Do" }],
    commentPageCap: 100,
  };
  const jira = fakeJira(opts);
  const { db, projectId } = freshDb();
  await run(db, projectId, jira.fetchImpl);
  const task = tasks(db)[0];
  const event = queueComment(db, task.id, "already delivered");
  jira.byKey.get("WEB-1")!.comments = [
    ...Array.from({ length: 100 }, (_, i) => ({ id: `j${i}`, author: "Someone", text: `c${i}` })),
    { id: "j100", author: "Hive", text: "already delivered", properties: [{ key: "hive.event_id", value: { id: event.id } }] },
  ];
  opts.emptyCommentPageAt = 100;
  opts.commentTotalAt = { 100: 100 };

  const stats = await run(db, projectId, jira.fetchImpl);

  expect(stats.errors).toBe(1);
  expect(stats.failures[0]).toContain("incomplete Jira comment history");
  expect(jira.byKey.get("WEB-1")!.comments).toHaveLength(101);
  expect(jira.writes()).toEqual([]);
  expect(J.pendingOutbound(db, task.id).comments).toBe(1);
});

test("comment pagination without completion metadata fails closed", async () => {
  const opts: FakeOpts = { issues: [{ key: "WEB-1", id: "1", status: "To Do" }] };
  const jira = fakeJira(opts);
  const { db, projectId } = freshDb();
  await run(db, projectId, jira.fetchImpl);
  const t = tasks(db)[0];
  queueComment(db, t.id, "wait for a provable page chain");
  opts.omitCommentPagination = true;

  const stats = await run(db, projectId, jira.fetchImpl);
  expect(stats.errors).toBe(1);
  expect(stats.skipped).toBe(0);
  expect(stats.failures[0]).toContain("incomplete Jira comment history");
  expect(jira.writes()).toEqual([]);
  expect(J.pendingOutbound(db, t.id).comments).toBe(1);
});

test("a comment-subresource 404 is operational rather than issue absence", async () => {
  const jira = fakeJira({
    issues: [{ key: "WEB-1", id: "1", status: "To Do" }],
    missingComments: ["WEB-1"],
  });
  const { db, projectId } = freshDb();

  const stats = await run(db, projectId, jira.fetchImpl);
  expect(stats.errors).toBe(1);
  expect(stats.skipped).toBe(0);
  expect(stats.failures[0]).toContain("/comment");
  expect(stats.failures[0]).toContain("404 not found");
  expect(jira.writes()).toEqual([]);
});

test("an operational comment read failure fails the issue", async () => {
  const jira = fakeJira({
    issues: [{ key: "WEB-1", id: "1", status: "To Do" }],
    failComments: ["WEB-1"],
  });
  const { db, projectId } = freshDb();

  const stats = await run(db, projectId, jira.fetchImpl);
  expect(stats.errors).toBe(1);
  expect(stats.skipped).toBe(0);
  expect(stats.failures[0]).toContain("comment");
  expect(stats.failures[0]).toContain("500 nope");
});

// ============================================================================
// RECEIPTS: IDEMPOTENT DELIVERY WITH CONTAINED UNKNOWNS
// ============================================================================
const addEvidence = (db: DB, taskId: string, kind: string, caption: string) => {
  const id = newId("ev");
  db.query("INSERT INTO evidence (id, task_id, ts, kind, path, url, caption, meta) VALUES (?,?,?,?,?,?,?,'{}')")
    .run(id, taskId, now(), kind, "/tmp/x", `/evidence/${taskId}/x.png`, caption);
  return id;
};

const adfLinks = (adf: any): { text: string; href: string }[] =>
  (adf?.content ?? []).flatMap((block: any) => (block.content ?? []).flatMap((node: any) =>
    (node.marks ?? []).filter((mark: any) => mark.type === "link").map((mark: any) => ({ text: node.text, href: mark.attrs?.href }))
  ));

test("an acknowledged report/evidence row is not redelivered", async () => {
  const jira = fakeJira({ issues: [{ key: "WEB-1", id: "1", status: "To Do" }] });
  const { db, projectId } = freshDb();
  await run(db, projectId, jira.fetchImpl);
  const t = tasks(db)[0];
  addEvidence(db, t.id, "report", "shadow cycle output");

  const s1 = await run(db, projectId, jira.fetchImpl);
  expect(s1.receipts).toBe(1);
  const posted = jira.byKey.get("WEB-1")!.comments;
  expect(posted).toHaveLength(1);
  expect(posted[0].text).toContain("shadow cycle output");
  const request = jira.calls.find((call) => call.method === "POST" && call.path.includes("/comment"));
  expect(adfLinks(request?.body?.body)).toEqual([
    { text: `${J.hiveBaseUrl()}/tasks/${t.id}`, href: `${J.hiveBaseUrl()}/tasks/${t.id}` },
    { text: `${J.hiveBaseUrl()}/evidence/${t.id}/x.png`, href: `${J.hiveBaseUrl()}/evidence/${t.id}/x.png` },
  ]);

  for (let i = 0; i < 3; i++) await run(db, projectId, jira.fetchImpl);
  expect(jira.byKey.get("WEB-1")!.comments).toHaveLength(1); // never re-delivered
});

test("receipt links resolve URLs into marked ADF link nodes", () => {
  const task = { id: "task-1", number: 1, title: "report", state: "done" };
  const row = { kind: "report", caption: "result", ts: "2026-01-01T00:00:00.000Z" };
  for (const [url, direct] of [
    ["/evidence/task-1/report.md", `${J.hiveBaseUrl()}/evidence/task-1/report.md`],
    ["https://example.com/report", "https://example.com/report"],
  ]) {
    const links = adfLinks(J.textToAdf(J.receiptText(task, { ...row, url })));
    expect(links).toContainEqual({ text: `${J.hiveBaseUrl()}/tasks/task-1`, href: `${J.hiveBaseUrl()}/tasks/task-1` });
    expect(links).toContainEqual({ text: direct, href: direct });
  }
});

test("a malformed legacy evidence URL does not block its receipt", async () => {
  const jira = fakeJira({ issues: [{ key: "WEB-1", id: "1", status: "To Do" }] });
  const { db, projectId } = freshDb();
  await run(db, projectId, jira.fetchImpl);
  const task = tasks(db)[0];
  db.query("INSERT INTO evidence (id, task_id, ts, kind, path, url, caption, meta) VALUES (?,?,?,?,?,?,?,'{}')")
    .run(newId("ev"), task.id, now(), "report", null, "http://[", "legacy report");

  const stats = await run(db, projectId, jira.fetchImpl);

  expect(stats.errors).toBe(0);
  expect(stats.receipts).toBe(1);
  const request = jira.calls.find((call) => call.method === "POST" && call.path.includes("/comment"));
  expect(adfLinks(request?.body?.body)).toEqual([
    { text: `${J.hiveBaseUrl()}/tasks/${task.id}`, href: `${J.hiveBaseUrl()}/tasks/${task.id}` },
  ]);
});

test("an oversized legacy receipt stays bounded and preserves its Hive link", async () => {
  const jira = fakeJira({ issues: [{ key: "WEB-1", id: "1", status: "To Do" }] });
  const { db, projectId } = freshDb();
  await run(db, projectId, jira.fetchImpl);
  const task = tasks(db)[0];
  db.query("INSERT INTO evidence (id, task_id, ts, kind, path, url, caption, meta) VALUES (?,?,?,?,?,?,?,'{}')")
    .run(
      newId("ev"),
      task.id,
      now(),
      "report",
      null,
      `https://example.com/${"u".repeat(J.JIRA_COMMENT_MAX_LENGTH)}`,
      "c".repeat(J.JIRA_COMMENT_MAX_LENGTH)
    );

  const stats = await run(db, projectId, jira.fetchImpl);

  expect(stats.errors).toBe(0);
  expect(stats.receipts).toBe(1);
  const request = jira.calls.find((call) => call.method === "POST" && call.path.includes("/comment"));
  const rendered = J.adfToText(request?.body?.body).trim();
  expect(rendered.length).toBeLessThanOrEqual(J.JIRA_COMMENT_MAX_LENGTH);
  expect(rendered).toContain("Caption and direct link omitted");
  expect(adfLinks(request?.body?.body)).toEqual([
    { text: `${J.hiveBaseUrl()}/tasks/${task.id}`, href: `${J.hiveBaseUrl()}/tasks/${task.id}` },
  ]);
});

test("a receipt whose acknowledgement was lost is not delivered twice", async () => {
  const jira = fakeJira({ issues: [{ key: "WEB-1", id: "1", status: "To Do" }] });
  const { db, projectId } = freshDb();
  await run(db, projectId, jira.fetchImpl);
  const t = tasks(db)[0];
  const evId = addEvidence(db, t.id, "screenshot", "before/after");
  jira.byKey.get("WEB-1")!.comments = [
    { id: "j50", author: "Hive", text: "already there", properties: [{ key: "hive.evidence_id", value: { id: evId } }] },
  ];
  const stats = await run(db, projectId, jira.fetchImpl);
  expect(stats.receipts).toBe(0);
  expect(jira.byKey.get("WEB-1")!.comments).toHaveLength(1);
});

test("shadow mode logs the receipt it WOULD deliver, and sends nothing", async () => {
  const jira = fakeJira({ issues: [{ key: "WEB-1", id: "1", status: "To Do" }] });
  const { db, projectId } = freshDb();
  await run(db, projectId, jira.fetchImpl, { ...CFG, write: false });
  addEvidence(db, tasks(db)[0].id, "report", "the thing hive found");
  const stats = await run(db, projectId, jira.fetchImpl, { ...CFG, write: false });
  const intent = syncEvents(db).find((e) => e.action === "receipt_shadow");
  expect(intent).toBeDefined();
  expect(intent.shadow).toBe(true);
  expect(String(intent.text)).toContain("the thing hive found");
  expect(stats.receipts).toBe(0);
  expect(jira.writes()).toEqual([]); // the real client was never invoked
});

// ============================================================================
// IMAGE PROOFS: SCREENSHOTS ON THE JIRA ISSUE
// ============================================================================
// Status and text told the reporter what happened; nothing SHOWED it. A UI task
// reaching review uploads the screenshots hive already holds, at most once, and
// only when the change actually touched UI.
const UI_PATCH = [
  "diff --git a/web/src/App.tsx b/web/src/App.tsx",
  "--- a/web/src/App.tsx",
  "+++ b/web/src/App.tsx",
  "@@ -1 +1 @@",
  "-old",
  "+new",
].join("\n");
const SERVER_PATCH = UI_PATCH.replaceAll("web/src/App.tsx", "server/src/api.ts");

const execWithPatch = (patch: string) => async () => ({ code: 0, stdout: patch, stderr: "" });

// A real 1x1 PNG on disk: the upload reads the file, so a fixture path is not enough.
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

async function uiTaskInReview(jira: any, name = "shot.png"): Promise<{ db: DB; projectId: string; task: any; path: string }> {
  const { db, projectId } = freshDb();
  await run(db, projectId, jira.fetchImpl);
  const task = tasks(db)[0];
  const path = join(HOME, `${task.id}-${name}`);
  await Bun.write(path, PNG_1PX);
  const id = newId("ev");
  db.query("INSERT INTO evidence (id, task_id, ts, kind, path, url, caption, meta) VALUES (?,?,?,?,?,?,?,'{}')")
    .run(id, task.id, now(), "screenshot", path, `/evidence/${task.id}/${name}`, "board after the change");
  db.query("UPDATE tasks SET branch = ? WHERE id = ?").run("hive/x", task.id);
  return { db, projectId, task, path };
}

test("a UI task at In Review attaches its screenshot once; a second sync adds nothing", async () => {
  const jira = fakeJira({ issues: [{ key: "WEB-1", id: "1", status: "In Review" }] });
  const { db, projectId, task } = await uiTaskInReview(jira);
  const deps = { exec: execWithPatch(UI_PATCH) };

  const first = await run(db, projectId, jira.fetchImpl, CFG, deps);
  expect(first.errors).toBe(0);
  expect(first.attachments).toBe(1);
  const uploaded = jira.byKey.get("WEB-1")!.attachments;
  expect(uploaded).toHaveLength(1);
  expect(uploaded[0].filename).toStartWith("hive-");

  const second = await run(db, projectId, jira.fetchImpl, CFG, deps);
  expect(second.attachments).toBe(0);
  expect(jira.byKey.get("WEB-1")!.attachments).toHaveLength(1);

  // and the context comment names the image, so the reporter knows to scroll
  const comment = jira.byKey.get("WEB-1")!.comments.find((c: any) => String(c.text).includes("Screenshot"));
  expect(String(comment?.text)).toContain(uploaded[0].filename);
  expect(String(comment?.text)).toContain("board after the change");
});

test("a task whose diff touches no UI attaches nothing", async () => {
  const jira = fakeJira({ issues: [{ key: "WEB-1", id: "1", status: "In Review" }] });
  const { db, projectId } = await uiTaskInReview(jira);
  const stats = await run(db, projectId, jira.fetchImpl, CFG, { exec: execWithPatch(SERVER_PATCH) });
  expect(stats.attachments).toBe(0);
  expect(jira.byKey.get("WEB-1")!.attachments).toEqual([]);
  expect(syncEvents(db).find((e) => e.action === "attachment_scope")?.ui).toBe(0);
});

test("only the first few screenshots go up, never every viewport", async () => {
  const jira = fakeJira({ issues: [{ key: "WEB-1", id: "1", status: "In Review" }] });
  const { db, projectId, task } = await uiTaskInReview(jira);
  for (const n of [2, 3, 4, 5]) {
    const path = join(HOME, `${task.id}-shot${n}.png`);
    await Bun.write(path, PNG_1PX);
    db.query("INSERT INTO evidence (id, task_id, ts, kind, path, url, caption, meta) VALUES (?,?,?,?,?,?,?,'{}')")
      .run(newId("ev"), task.id, now(), "screenshot", path, `/evidence/${task.id}/shot${n}.png`, `viewport ${n}`);
  }
  const stats = await run(db, projectId, jira.fetchImpl, CFG, { exec: execWithPatch(UI_PATCH) });
  expect(stats.attachments).toBe(3);
});

test("an upload whose acknowledgement was lost is not uploaded twice", async () => {
  const jira = fakeJira({ issues: [{ key: "WEB-1", id: "1", status: "In Review" }] });
  const { db, projectId } = await uiTaskInReview(jira);
  const deps = { exec: execWithPatch(UI_PATCH) };
  // The file is already on the issue under hive's stamped name, but hive has no receipt.
  const evidenceId = (db.query("SELECT id FROM evidence").get() as any).id;
  const path = (db.query("SELECT path FROM evidence").get() as any).path;
  jira.byKey.get("WEB-1")!.attachments = [{ id: "att-old", filename: J.attachmentName(evidenceId, path) }];

  const stats = await run(db, projectId, jira.fetchImpl, CFG, deps);
  expect(stats.attachments).toBe(0);
  expect(jira.byKey.get("WEB-1")!.attachments).toHaveLength(1);
  expect(syncEvents(db).find((e) => e.action === "attachment")?.recovered).toBe(true);
});

test("an upload interrupted mid-flight is settled as unknown, not re-uploaded", async () => {
  const jira = fakeJira({ issues: [{ key: "WEB-1", id: "1", status: "In Review" }] });
  const { db, projectId } = await uiTaskInReview(jira);
  const task = tasks(db)[0];
  const evidenceId = (db.query("SELECT id FROM evidence").get() as any).id;
  // hive recorded the intent and then died before Jira answered.
  writeEvent(db, {
    task_id: task.id, source: "jira-sync", type: "jira_sync",
    payload: { action: "attachment", issue: "WEB-1", source_id: evidenceId, outcome: "sending" },
  });

  const stats = await run(db, projectId, jira.fetchImpl, CFG, { exec: execWithPatch(UI_PATCH) });
  expect(stats.attachments).toBe(0);
  expect(jira.byKey.get("WEB-1")!.attachments).toEqual([]);
  expect(syncEvents(db).some((e) => e.action === "attachment" && e.outcome === "terminal_unknown")).toBe(true);
});

test("shadow mode logs the upload it WOULD make, and sends nothing", async () => {
  const jira = fakeJira({ issues: [{ key: "WEB-1", id: "1", status: "In Review" }] });
  const { db, projectId } = freshDb();
  const shadow = { ...CFG, write: false };
  await run(db, projectId, jira.fetchImpl, shadow);
  const task = tasks(db)[0];
  const path = join(HOME, `${task.id}-shadow.png`);
  await Bun.write(path, PNG_1PX);
  db.query("INSERT INTO evidence (id, task_id, ts, kind, path, url, caption, meta) VALUES (?,?,?,?,?,?,?,'{}')")
    .run(newId("ev"), task.id, now(), "screenshot", path, `/evidence/${task.id}/shadow.png`, "would be attached");
  db.query("UPDATE tasks SET branch = ? WHERE id = ?").run("hive/x", task.id);

  const stats = await run(db, projectId, jira.fetchImpl, shadow, { exec: execWithPatch(UI_PATCH) });
  expect(stats.attachments).toBe(0);
  expect(jira.writes()).toEqual([]);
  const intent = syncEvents(db).find((e) => e.action === "attachment_shadow");
  expect(intent?.shadow).toBe(true);
  expect(String(intent?.filename)).toContain("shadow.png");
});

// ============================================================================
// REVIEW CONTEXT: THE ONE COMMENT THAT EXPLAINS A STATUS FLIP
// ============================================================================
// A mirror used to reach "In Review" with nothing but the column change: no PR,
// no summary, no evidence, so the reporter opened the ticket and learned
// nothing. Composition is at most once per JIRA STATUS and delivery rides the
// ordinary outbound-comment ledger, so re-syncs stay silent.
const reachReview = (db: DB, taskId: string, reason: string) => {
  transition(db, taskId, "in_progress", { source: "director", reason: "starting" });
  transition(db, taskId, "in_review", { source: "director", reason });
};

test("a mirror reaching In Review gets exactly ONE context comment, and re-syncs post nothing", async () => {
  const jira = fakeJira({ issues: [{ key: "WEB-1", id: "1", status: "To Do" }] });
  const { db, projectId } = freshDb();
  await run(db, projectId, jira.fetchImpl);
  const task = tasks(db)[0];
  db.query("UPDATE tasks SET pr_url = ? WHERE id = ?").run("https://github.com/acme/x/pull/815", task.id);
  addEvidence(db, task.id, "screenshot", "member list after the merge");
  writeEvent(db, {
    task_id: task.id, source: "agent", type: "review_summary",
    payload: { done: ["unified member list"], iffy: [{ what: "deletion is soft-flagged", why: "send suppression lands separately" }] },
  });
  reachReview(db, task.id, "PR #815 (CI green): unified member list, counts conserved");

  const s1 = await run(db, projectId, jira.fetchImpl);
  const context = jira.byKey.get("WEB-1")!.comments.filter((c: any) => String(c.text).includes("Hive moved this to In Review"));
  expect(context).toHaveLength(1);
  expect(context[0].text).toContain("PR #815 (CI green): unified member list, counts conserved");
  expect(context[0].text).toContain("https://github.com/acme/x/pull/815");
  expect(context[0].text).toContain("deletion is soft-flagged: send suppression lands separately");
  expect(context[0].text).toContain(`${J.hiveBaseUrl()}/evidence/${task.id}/x.png`);
  expect(s1.comments_pushed).toBe(1);

  // Second cycle (and a few more): the status already agrees and the ledger
  // already holds the delivery, so nothing new is composed or posted.
  for (let i = 0; i < 3; i++) await run(db, projectId, jira.fetchImpl);
  expect(jira.byKey.get("WEB-1")!.comments.filter((c: any) => String(c.text).includes("Hive moved this to In Review"))).toHaveLength(1);
});

test("verifying shares In Review's comment, and Done gets its own", async () => {
  // in_review and verifying both render as "In Review", so keying composition on
  // the hive state would say the same thing twice for one visible column.
  const jira = fakeJira({ issues: [{ key: "WEB-1", id: "1", status: "To Do" }] });
  const { db, projectId } = freshDb();
  await run(db, projectId, jira.fetchImpl);
  const task = tasks(db)[0];
  // The fake stamps a pushed transition with the wall clock, which ties with
  // hive's next transition at millisecond resolution and lets Jira win the
  // status race. Backdating keeps THIS test about comments, not clocks.
  const jiraClockBehind = () => {
    const iss = jira.byKey.get("WEB-1")!;
    iss.history = iss.history.map((h) => ({ ...h, at: "2026-01-01T00:00:00.000Z" }));
  };

  reachReview(db, task.id, "PR is up");
  await run(db, projectId, jira.fetchImpl);
  jiraClockBehind();

  transition(db, task.id, "verifying", { source: "director", reason: "merged, smoke pending" });
  await run(db, projectId, jira.fetchImpl);
  jiraClockBehind();
  const texts = () => jira.byKey.get("WEB-1")!.comments.map((c: any) => String(c.text));
  expect(texts().filter((t) => t.includes("Hive moved this to In Review"))).toHaveLength(1);

  transition(db, task.id, "done", { source: "director", reason: "smoke checks pass" });
  await run(db, projectId, jira.fetchImpl);
  jiraClockBehind();
  expect(texts().filter((t) => t.includes("Hive finished this: smoke checks pass"))).toHaveLength(1);
  for (let i = 0; i < 2; i++) await run(db, projectId, jira.fetchImpl);
  expect(texts().filter((t) => t.startsWith("Hive"))).toHaveLength(2); // one per Jira status, ever
});

test("a human's own move to In Review gets no comment when hive has nothing to add", async () => {
  // The reporter moved the column themselves and hive never worked the ticket.
  // Telling them what they just did is noise, so nothing is composed.
  const jira = fakeJira({ issues: [{ key: "WEB-1", id: "1", status: "In Review" }] });
  const { db, projectId } = freshDb();
  const stats = await run(db, projectId, jira.fetchImpl);
  expect(tasks(db)[0].state).toBe("in_review");
  expect(stats.comments_pushed).toBe(0);
  expect(jira.byKey.get("WEB-1")!.comments).toEqual([]);
});

test("a context comment Jira committed but did not acknowledge is never posted twice", async () => {
  // The queued event is the COMPOSITION ledger and the delivery receipts are the
  // DELIVERY ledger. A 5xx after Jira already stored the comment trips neither
  // into writing a second one; the next cycle recovers it by its property.
  const jira = fakeJira({ issues: [{ key: "WEB-1", id: "1", status: "To Do" }], failCommentPosts: 1 });
  const { db, projectId } = freshDb();
  await run(db, projectId, jira.fetchImpl);
  const task = tasks(db)[0];
  reachReview(db, task.id, "PR #815 is up");

  const failed = await run(db, projectId, jira.fetchImpl);
  expect(failed.errors).toBe(1);
  expect(jira.byKey.get("WEB-1")!.comments).toHaveLength(1);
  expect(J.pendingOutbound(db, task.id).unknown).toHaveLength(1); // visible, not silently dropped

  for (let i = 0; i < 3; i++) await run(db, projectId, jira.fetchImpl);
  expect(jira.byKey.get("WEB-1")!.comments).toHaveLength(1);
  expect(J.pendingOutbound(db, task.id)).toEqual({ comments: 0, receipts: 0, unknown: [] });
});

test("the context comment stays short: evidence is capped and long reasons are clipped", async () => {
  const { db, projectId } = freshDb();
  const id = newId();
  db.query(
    `INSERT INTO tasks (id, project_id, title, brief, state, kind, source, source_ref, created_at, updated_at)
     VALUES (?,?,?,?, 'in_review', 'ship', 'external', 'jira:WEB-1', ?, ?)`
  ).run(id, projectId, "[WEB-1] t", "b", now(), now());
  writeEvent(db, { task_id: id, source: "director", type: "state_change", payload: { from: "in_progress", to: "in_review", reason: "x".repeat(900) } });
  for (let i = 0; i < 9; i++) addEvidence(db, id, "screenshot", `shot ${i}`);

  const text = J.reviewContextText(db, { id, pr_url: null }, "In Review")!;
  expect(text.split("\n").filter((line) => line.startsWith("- ")).filter((l) => !l.includes("more in Hive"))).toHaveLength(5);
  expect(text).toContain("- +4 more in Hive");
  expect(text.split("\n")[0].length).toBeLessThan(450);
});

// ============================================================================
// VISIBLE SYNC STATE + MANUAL RETRY
// ============================================================================
test("a successful cycle records last_success_at and clears any prior error", async () => {
  const jira = fakeJira({ issues: [{ key: "WEB-1", id: "1", status: "To Do" }] });
  const { db, projectId } = freshDb({ ...CFG });
  const r = await J.runProjectCycle(db, projectId, { fetch: jira.fetchImpl, token: "tok", intervalMs: 60_000 });
  expect(r.ok).toBe(true);
  expect(r.state.last_success_at).not.toBeNull();
  expect(r.state.last_error).toBeNull();
  expect(r.state.next_due_at).toBeNull();
  expect(J.readSyncState(db, projectId).stats?.imported).toBe(1);
});

test("a cycle with an issue write failure remains failed and names the write", async () => {
  const jira = fakeJira({ issues: [{ key: "WEB-1", id: "1", status: "To Do" }], failCommentPosts: 1 });
  const { db, projectId } = freshDb({ ...CFG });
  await J.runProjectCycle(db, projectId, { fetch: jira.fetchImpl, token: "tok" });
  queueComment(db, tasks(db)[0].id, "fail visibly");

  const result = await J.runProjectCycle(db, projectId, { fetch: jira.fetchImpl, token: "tok", log: () => {} });
  expect(result.ok).toBe(false);
  expect(result.error).toContain("completed with 1 issue failure");
  expect(result.error).toContain("WEB-1 comment_push");
  expect(result.error).toContain("comment exploded");
  expect(result.state.last_error).toBe(result.error);
  expect(result.state.consecutive_failures).toBe(1);
});

test("an operational issue read failure remains visible as a cycle failure", async () => {
  const jira = fakeJira({ issues: [{ key: "WEB-1", id: "1", status: "To Do" }], failRead: ["WEB-1"] });
  const { db, projectId } = freshDb({ ...CFG });
  const result = await J.runProjectCycle(db, projectId, { fetch: jira.fetchImpl, token: "tok", log: () => {} });
  expect(result.ok).toBe(false);
  expect(result.error).toContain("completed with 1 issue failure");
  expect(result.error).toContain("jira GET /rest/api/3/issue/WEB-1?");
  expect(result.error).toContain("500 nope");
  expect(result.state.last_error).toBe(result.error);
  expect(result.state.consecutive_failures).toBe(1);
});

test("a failing cycle records a PERSISTENT error a director can see, and counts failures", async () => {
  const jira = fakeJira({ issues: [{ key: "WEB-1", id: "1", status: "To Do" }], failSearch: true });
  const { db, projectId } = freshDb({ ...CFG });
  const r1 = await J.runProjectCycle(db, projectId, { fetch: jira.fetchImpl, token: "tok", log: () => {} });
  expect(r1.ok).toBe(false);
  expect(r1.state.last_error).toBeTruthy();
  expect(r1.state.consecutive_failures).toBe(1);
  const r2 = await J.runProjectCycle(db, projectId, { fetch: jira.fetchImpl, token: "tok", log: () => {} });
  expect(r2.state.consecutive_failures).toBe(2);

  // and a later success clears it, so a stale error never lingers
  const ok = fakeJira({ issues: [{ key: "WEB-1", id: "1", status: "To Do" }] });
  const r3 = await J.runProjectCycle(db, projectId, { fetch: ok.fetchImpl, token: "tok" });
  expect(r3.ok).toBe(true);
  expect(r3.state.last_error).toBeNull();
  expect(r3.state.consecutive_failures).toBe(0);
});

test("a disabled or malformed project reports WHY rather than failing silently", async () => {
  const off = freshDb({ ...CFG, enabled: false });
  const r1 = await J.runProjectCycle(off.db, off.projectId, { token: "tok" });
  expect(r1.ok).toBe(false);
  expect(r1.state.last_error).toContain("disabled");

  const bad = freshDb({ ...CFG, site: "http://example.atlassian.net" });
  let called = 0;
  const spy = (async () => { called++; return new Response("{}"); }) as unknown as typeof fetch;
  const r2 = await J.runProjectCycle(bad.db, bad.projectId, { fetch: spy, token: "tok" });
  expect(r2.ok).toBe(false);
  expect(r2.state.last_error).toMatch(/malformed|config missing/);
  expect(called).toBe(0); // still no request to the mutated host
});

test("pendingOutbound reports work that has not reached Jira, and clears once it has", async () => {
  const jira = fakeJira({ issues: [{ key: "WEB-1", id: "1", status: "To Do" }] });
  const { db, projectId } = freshDb();
  await run(db, projectId, jira.fetchImpl);
  const t = tasks(db)[0];
  queueComment(db, t.id, "not yet sent");
  addEvidence(db, t.id, "report", "also not yet sent");
  expect(J.pendingOutbound(db, t.id)).toEqual({ comments: 1, receipts: 1, unknown: [] });

  await run(db, projectId, jira.fetchImpl);
  expect(J.pendingOutbound(db, t.id)).toEqual({ comments: 0, receipts: 0, unknown: [] });
});

// ------------------------------------------------- disposition of a deleted issue
// A mirror whose Jira issue is deleted used to sit queued forever with one
// import event on it. These tests pin the distinction that makes dispositioning
// it safe: a direct per-issue 404 is positive proof of removal, while absence
// from a search result is not evidence of anything. Ported from hive-1007 onto
// this file's fake, which already models search and issue storage separately
// (`visible` controls what SEARCH returns, `missingRead`/`failRead` control what
// the DIRECT read does) — the disagreement is the whole point of these tests.
const taskFor = (db: DB, key: string): any =>
  db.query("SELECT * FROM tasks WHERE source_ref = ?").get(J.REF_PREFIX + key) as any;
const stateChanges = (db: DB, taskId: string) =>
  (db.query("SELECT source, payload FROM events WHERE task_id = ? AND type = 'state_change' ORDER BY ts, rowid").all(taskId) as any[])
    .map((e) => ({ source: e.source, ...JSON.parse(e.payload) }));

test("an issue proven deleted by a direct 404 cancels its mirror, keeping the row", async () => {
  const issues = [{ key: "WEB-14", id: "14", status: "To Do" }];
  const { db, projectId } = freshDb();
  await run(db, projectId, fakeJira({ issues }).fetchImpl);
  const before = taskFor(db, "WEB-14");
  expect(before.state).toBe("queued");

  // Gone from search AND the direct read says 404 — positive proof of removal.
  const gone = fakeJira({ issues, visible: [], missingRead: ["WEB-14"] });
  const stats = await run(db, projectId, gone.fetchImpl, CFG, { log: () => {} });
  expect(stats.cancelled).toBe(1);
  expect(stats.errors).toBe(0);

  const after = taskFor(db, "WEB-14");
  expect(after).toBeTruthy(); // the row is NEVER deleted: its comments/evidence are the only record left
  expect(after.id).toBe(before.id);
  expect(after.state).toBe("cancelled"); // terminal, so it also leaves the board and the attention tray
  expect(stateChanges(db, after.id).at(-1)!.source).toBe("jira-sync");
  expect(syncEvents(db).some((e) => e.action === "source_deleted" && e.issue === "WEB-14")).toBe(true);
});

test("an issue merely missing from search is left completely untouched", async () => {
  const issues = [{ key: "WEB-14", id: "14", status: "To Do" }];
  const { db, projectId } = freshDb();
  await run(db, projectId, fakeJira({ issues }).fetchImpl);
  const before = taskFor(db, "WEB-14");

  // Absent from search, but the direct read finds it alive. Absence from an
  // eventually-consistent index is not evidence, so nothing may happen.
  const stats = await run(db, projectId, fakeJira({ issues, visible: [] }).fetchImpl, CFG, { log: () => {} });
  expect(stats.cancelled ?? 0).toBe(0);

  const after = taskFor(db, "WEB-14");
  expect(after.state).toBe(before.state);
  expect(after.state).not.toBe("cancelled");
  expect(syncEvents(db).some((e) => e.action === "source_deleted")).toBe(false);
});

test("an unreachable Jira never cancels a mirror", async () => {
  const issues = [{ key: "WEB-14", id: "14", status: "To Do" }];
  const { db, projectId } = freshDb();
  await run(db, projectId, fakeJira({ issues }).fetchImpl);

  // "hive could not tell" must never reach a caller as "it is gone".
  const unreachable = fakeJira({ issues, visible: [], failRead: ["WEB-14"] });
  const stats = await run(db, projectId, unreachable.fetchImpl, CFG, { log: () => {} });
  expect(stats.cancelled ?? 0).toBe(0);
  expect(taskFor(db, "WEB-14").state).not.toBe("cancelled");
  expect(syncEvents(db).some((e) => e.action === "source_deleted")).toBe(false);
});

test("hive undoes its own deletion cancel when the issue comes back", async () => {
  // Jira answers 404 rather than 403 for an issue you have lost permission to
  // see, so the cancellation is presumptive and must be reversible, or a
  // permission blip becomes a permanent one-way trapdoor.
  const issues = [{ key: "WEB-14", id: "14", status: "To Do" }];
  const { db, projectId } = freshDb();
  await run(db, projectId, fakeJira({ issues }).fetchImpl);
  await run(db, projectId, fakeJira({ issues, visible: [], missingRead: ["WEB-14"] }).fetchImpl, CFG, { log: () => {} });
  expect(taskFor(db, "WEB-14").state).toBe("cancelled");

  await run(db, projectId, fakeJira({ issues }).fetchImpl);
  expect(taskFor(db, "WEB-14").state).toBe("queued");
  expect(syncEvents(db).some((e) => e.action === "source_restored" && e.issue === "WEB-14")).toBe(true);
});

test("a director's cancellation is never undone by the sync", async () => {
  // Only hive's OWN disposition is reversible. A human who cancels a mirrored
  // task means it, and a later poll must not resurrect it.
  const issues = [{ key: "WEB-14", id: "14", status: "To Do" }];
  const { db, projectId } = freshDb();
  await run(db, projectId, fakeJira({ issues }).fetchImpl);
  const task = taskFor(db, "WEB-14");
  transition(db, task.id, "cancelled", { source: "director", reason: "not doing this" });

  await run(db, projectId, fakeJira({ issues }).fetchImpl);
  expect(taskFor(db, "WEB-14").state).toBe("cancelled"); // stays cancelled
  expect(syncEvents(db).some((e) => e.action === "source_restored")).toBe(false);
});

// ============================================================================
// A UI task that attached NO screenshot used to leave its ticket picture-less.
// Hive now renders one at review time with the target repo's own Playwright
// harness, saves it as ordinary evidence, and the upload path above carries it.
const { routesFromFiles } = await import("../src/intake/renderProof.ts");
const { existsSync, mkdirSync: mkdirSyncT, readFileSync: readFileSyncT, readdirSync: readdirSyncT, writeFileSync: writeFileSyncT, rmSync: rmSyncT, symlinkSync: symlinkSyncT } = await import("node:fs");

test("the route to shoot comes from the changed files, and a guessable one is skipped", () => {
  expect(routesFromFiles(["web/src/app/(main)/insights/page.tsx"])).toEqual(["/insights"]);
  // A [id] segment has no value hive can supply; a guessed one renders a 404.
  expect(routesFromFiles(["web/src/app/posts/[id]/page.tsx"])).toEqual(["/"]);
  // Two at most, never a contact sheet.
  expect(
    routesFromFiles(["web/app/a/page.tsx", "web/app/b/page.tsx", "web/app/c/page.tsx"])
  ).toEqual(["/a", "/b"]);
  // Nothing route-shaped in the diff still gets the home page.
  expect(routesFromFiles(["web/src/components/Button.tsx"])).toEqual(["/"]);
  // An API path answers with JSON or an error, never a page. Both spellings.
  expect(routesFromFiles(["web/pages/api/users.ts"])).toEqual(["/"]);
  expect(routesFromFiles(["web/src/app/users/route.ts"])).toEqual(["/"]);
  expect(routesFromFiles(["web/app/api/users/route.ts", "web/app/insights/page.tsx"])).toEqual(["/insights"]);
});

// Corebeat web is TanStack Router: the file name is part of the URL, and the
// `_page` folder is a layout with no path of its own. Before this, every one of
// these fell through to `/` and the ticket got a front-page picture captioned
// with the route it never opened.
test("TanStack src/routes files map to their real URLs", () => {
  expect(routesFromFiles(["web/src/routes/_page/pricing.tsx"])).toEqual(["/pricing"]);
  expect(
    routesFromFiles(["web/src/routes/_page/pricing.tsx", "web/src/routes/_page/search.tsx"])
  ).toEqual(["/pricing", "/search"]);
  // index.tsx is the parent path, not a segment.
  expect(routesFromFiles(["web/src/routes/_page/news/index.tsx"])).toEqual(["/news"]);
  expect(routesFromFiles(["web/src/routes/_page/index.tsx"])).toEqual(["/"]);
  // $news_idx is a parameter hive cannot fill, so the file is skipped.
  expect(routesFromFiles(["web/src/routes/_page/article/$news_idx.tsx"])).toEqual(["/"]);
  // A Storybook story is not a route.
  expect(routesFromFiles(["web/src/routes/_page/news/index.stories.tsx"])).toEqual(["/"]);
  // Dots are TanStack's flat spelling of nesting.
  expect(routesFromFiles(["web/src/routes/posts.index.tsx"])).toEqual(["/posts"]);
  expect(routesFromFiles(["web/src/routes/posts.$postId.tsx"])).toEqual(["/"]);
});

// A worktree that looks like a repo with a Playwright harness. `harness: false`
// makes it a repo with none, which is the quiet-degrade case. The webServer
// block is what lets hive serve the PR branch itself, so a real harness has one.
function fakeWorktree(name: string, harness: boolean, config?: string, installed = true): string {
  const root = join(HOME, `wt-${name}-${newId()}`);
  mkdirSyncT(join(root, "web"), { recursive: true });
  if (harness) {
    mkdirSyncT(join(root, "web", "e2e"), { recursive: true });
    writeFileSyncT(
      join(root, "web", "playwright.config.ts"),
      config ?? "export default { testDir: './e2e', webServer: { command: 'npm start' } };\n"
    );
    // A real checkout only runs if its deps are installed. `installed: false`
    // is the fresh-worktree case, where hive must refuse rather than fall back
    // to whatever `playwright` happens to sit on the host PATH.
    if (installed) {
      mkdirSyncT(join(root, "web", "node_modules", ".bin"), { recursive: true });
      writeFileSyncT(join(root, "web", "node_modules", ".bin", "playwright"), "#!/bin/sh\n");
    }
  }
  return root;
}

// The harness run is now the repo's own binary by absolute path, not `npx`.
const isHarnessRun = (argv: string[]) => argv.some((a) => a.endsWith("/.bin/playwright"));

function trustRepo(db: DB, projectId: string): void {
  const row = db.query("SELECT config FROM projects WHERE id = ?").get(projectId) as { config: string };
  const config = { ...JSON.parse(row.config), render_proof: true };
  db.query("UPDATE projects SET config = ? WHERE id = ?").run(JSON.stringify(config), projectId);
}

// Stands in for the repo's Playwright: writes the PNG the real one would, and
// answers every other command (the diff read) with the UI patch. `code` fakes a
// red run, which must never become evidence.
const execRendering = (root: string, shots: number, code = 0) => async (argv: string[]) => {
  if (isHarnessRun(argv)) {
    const out = join(root, readdirSyncT(root).find((name) => name.startsWith(".hive-proof-"))!);
    for (let i = 1; i <= shots; i++) await Bun.write(join(out, `proof-${i}.png`), PNG_1PX);
    return { code, stdout: code ? "1 failed\nError: connect ECONNREFUSED" : "1 passed", stderr: "" };
  }
  return { code: 0, stdout: UI_PATCH, stderr: "" };
};

async function uiTaskWithNoShots(
  jira: any, harness: boolean, config?: string
): Promise<{ db: DB; projectId: string; root: string }> {
  const { db, projectId } = freshDb();
  await run(db, projectId, jira.fetchImpl);
  const task = tasks(db)[0];
  const root = fakeWorktree(task.id, harness, config);
  db.query("UPDATE tasks SET branch = ?, worktree_path = ? WHERE id = ?").run("hive/x", root, task.id);
  // Rendering executes the repo's own harness, so it only runs for a repo the
  // director marked trusted. Every test below is on a trusted repo except the
  // one that checks the gate itself.
  trustRepo(db, projectId);
  return { db, projectId, root };
}

test.skipIf(process.platform !== "darwin")("a UI task with no screenshot gets one rendered, and a second sync renders nothing", async () => {
  const jira = fakeJira({ issues: [{ key: "WEB-1", id: "1", status: "In Review" }] });
  const { db, projectId, root } = await uiTaskWithNoShots(jira, true);
  const deps = { exec: execRendering(root, 1) };

  const first = await run(db, projectId, jira.fetchImpl, CFG, deps);
  expect(first.rendered).toBe(1);
  expect(first.attachments).toBe(1);
  const uploaded = jira.byKey.get("WEB-1")!.attachments;
  expect(uploaded).toHaveLength(1);
  const evidence = db.query("SELECT caption FROM evidence").all() as any[];
  expect(evidence).toHaveLength(1);
  expect(evidence[0].caption).toBe("Rendered at review: /");

  const second = await run(db, projectId, jira.fetchImpl, CFG, deps);
  expect(second.rendered).toBe(0);
  expect(second.attachments).toBe(0);
  expect(jira.byKey.get("WEB-1")!.attachments).toHaveLength(1);
  expect((db.query("SELECT id FROM evidence").all() as any[])).toHaveLength(1);
});

test("a repo with no Playwright harness attaches nothing and says why", async () => {
  const jira = fakeJira({ issues: [{ key: "WEB-1", id: "1", status: "In Review" }] });
  const { db, projectId, root } = await uiTaskWithNoShots(jira, false);
  const stats = await run(db, projectId, jira.fetchImpl, CFG, { exec: execRendering(root, 1) });

  expect(stats.rendered).toBe(0);
  expect(stats.attachments).toBe(0);
  expect(stats.errors).toBe(0);
  expect(db.query("SELECT id FROM evidence").all()).toHaveLength(0);
  const logged = syncEvents(db).find((e) => e.action === "render_proof");
  expect(String(logged?.reason)).toContain("no Playwright config");
});

// The seatbelt profile IS the boundary, so it is checked by running it, not by
// reading it. macOS only: on any other host renderProofs refuses outright.
test.skipIf(process.platform !== "darwin")("the sandbox really refuses a write outside the worktree", async () => {
  const { seatbelt } = await import("../src/intake/renderProof.ts");
  const root = join(HOME, `sbx-${newId()}`);
  mkdirSyncT(root, { recursive: true });
  const fence = seatbelt(root) as { argv: string[] };
  const run = (path: string) =>
    Bun.spawn([...fence.argv, "/bin/sh", "-c", `echo hi > ${path}`], { stdout: "pipe", stderr: "pipe" }).exited;

  expect(await run(join(root, "inside.txt"))).toBe(0);
  // Outside the worktree: a fresh name directly under the real home dir, which
  // the profile never lists. NOT derived from cwd, so the test still means
  // something when the checkout itself sits in a whitelisted dir like /tmp.
  // Cleaned up either way, so a broken fence leaves nothing behind.
  const outside = join(homedir(), `sandbox-probe-${newId()}`);
  expect(await run(outside)).not.toBe(0);
  rmSyncT(outside, { force: true });
});

test.skipIf(process.platform !== "darwin")("an untrusted repo never starts a browser, and the gate does not burn the one attempt", async () => {
  const jira = fakeJira({ issues: [{ key: "WEB-1", id: "1", status: "In Review" }] });
  const { db, projectId, root } = await uiTaskWithNoShots(jira, true);
  db.query("UPDATE projects SET config = ? WHERE id = ?").run(JSON.stringify({ jira: CFG }), projectId);
  let browserRuns = 0;
  const render = execRendering(root, 1);
  const exec = async (argv: string[]) => {
    if (isHarnessRun(argv)) browserRuns++;
    return render(argv);
  };

  const blocked = await run(db, projectId, jira.fetchImpl, CFG, { exec });
  expect(blocked.rendered).toBe(0);
  expect(browserRuns).toBe(0);
  expect(syncEvents(db).some((e) => e.action === "render_proof")).toBe(false);
  expect(String(syncEvents(db).find((e) => e.action === "render_proof_scope")?.reason)).toContain("render_proof: true");

  // Turning the flag on later still renders: the gate logged, it did not
  // consume the single render attempt.
  trustRepo(db, projectId);
  const allowed = await run(db, projectId, jira.fetchImpl, CFG, { exec });
  expect(allowed.rendered).toBe(1);
  expect(browserRuns).toBe(1);
});

test("a task that already has a screenshot never starts a browser", async () => {
  const jira = fakeJira({ issues: [{ key: "WEB-1", id: "1", status: "In Review" }] });
  const { db, projectId } = await uiTaskInReview(jira);
  let browserRuns = 0;
  const exec = async (argv: string[]) => {
    if (isHarnessRun(argv)) browserRuns++;
    return { code: 0, stdout: UI_PATCH, stderr: "" };
  };
  const stats = await run(db, projectId, jira.fetchImpl, CFG, { exec });
  expect(stats.attachments).toBe(1);
  expect(stats.rendered).toBe(0);
  expect(browserRuns).toBe(0);
});

test.skipIf(process.platform !== "darwin")("the harness is forced to boot the app itself, so the picture is the PR branch", async () => {
  const jira = fakeJira({ issues: [{ key: "WEB-1", id: "1", status: "In Review" }] });
  const { db, projectId, root } = await uiTaskWithNoShots(jira, true);
  const seen: { argv: string[]; config?: string; cwd?: string }[] = [];
  const render = execRendering(root, 1);
  const exec = async (argv: string[], opts: any = {}) => {
    const configAt = argv.indexOf("--config");
    seen.push({
      argv,
      cwd: opts.cwd,
      ...(configAt >= 0 ? { config: readFileSyncT(join(opts.cwd, argv[configAt + 1]), "utf8") } : {}),
    });
    return render(argv);
  };

  const stats = await run(db, projectId, jira.fetchImpl, CFG, { exec });
  expect(stats.rendered).toBe(1);

  // The empty environment prevents the PR branch from inheriting Hive secrets.
  // Four non-secret values are restored so Playwright can find its tools and
  // browser cache while booting the app from this worktree.
  const harness = seen.find((c) => isHarnessRun(c.argv))!;
  expect(harness.argv.slice(3, 5)).toEqual(["/usr/bin/env", "-i"]);
  const binAt = harness.argv.findIndex((a: string) => a.endsWith("/.bin/playwright"));
  expect(harness.argv.slice(5, binAt).map((entry) => entry.split("=", 1)[0])).toEqual(["HOME", "PATH", "TMPDIR", "CI"]);
  expect(harness.argv.slice(5, binAt).join("\n")).not.toContain("HIVE_");
  // The repo's OWN binary, by absolute path inside this worktree. `npx` would
  // fall back to a host-global playwright when the worktree has no deps.
  expect(harness.argv[binAt]).toBe(join(root, "web", "node_modules", ".bin", "playwright"));
  expect(harness.argv[binAt + 1]).toBe("test");
  expect(harness.argv).toContain("--config");
  expect(harness.config).toContain("reuseExistingServer: false");
  expect(harness.cwd).toBe(join(root, "web"));

  // And it runs fenced: seatbelt may write to the worktree, not to the rest of
  // the Mac. Anything else would let a PR branch's config touch the machine.
  expect(harness.argv[0]).toBe("/usr/bin/sandbox-exec");
  const profile = harness.argv[2];
  expect(profile).toContain("(deny network*)");
  expect(profile).toContain('(allow network-inbound (local ip "localhost:*"))');
  expect(profile).toContain('(allow network-outbound (remote ip "localhost:*"))');
  expect(profile).toContain("(deny file-write*)");
  expect(profile).toContain(`(subpath "${root}")`);
  expect(profile).not.toContain(`(subpath "/")`);
});

test("a harness that cannot serve the PR branch renders nothing and says why", async () => {
  const jira = fakeJira({ issues: [{ key: "WEB-1", id: "1", status: "In Review" }] });
  const { db, projectId, root } = await uiTaskWithNoShots(
    jira, true, "export default { testDir: './e2e' };\n" // no webServer block
  );
  const stats = await run(db, projectId, jira.fetchImpl, CFG, { exec: execRendering(root, 1) });

  expect(stats.rendered).toBe(0);
  expect(stats.attachments).toBe(0);
  expect(stats.errors).toBe(0);
  expect(db.query("SELECT id FROM evidence").all()).toHaveLength(0);
  const logged = syncEvents(db).find((e) => e.action === "render_proof");
  expect(String(logged?.reason)).toContain("no webServer");
});

test("a Playwright testDir outside the worktree is refused", async () => {
  const jira = fakeJira({ issues: [{ key: "WEB-1", id: "1", status: "In Review" }] });
  const { db, projectId, root } = await uiTaskWithNoShots(
    jira, true, "export default { testDir: '../../../', webServer: { command: 'npm start' } };\n"
  );
  const stats = await run(db, projectId, jira.fetchImpl, CFG, { exec: execRendering(root, 1) });

  expect(stats.rendered).toBe(0);
  expect(String(syncEvents(db).find((e) => e.action === "render_proof")?.reason)).toContain("outside the task worktree");
});

test("a Playwright testDir symlink outside the worktree is refused", async () => {
  const jira = fakeJira({ issues: [{ key: "WEB-1", id: "1", status: "In Review" }] });
  const { db, projectId, root } = await uiTaskWithNoShots(jira, true);
  rmSyncT(join(root, "web", "e2e"), { recursive: true });
  symlinkSyncT(HOME, join(root, "web", "e2e"), "dir");

  const stats = await run(db, projectId, jira.fetchImpl, CFG, { exec: execRendering(root, 1) });

  expect(stats.rendered).toBe(0);
  expect(String(syncEvents(db).find((e) => e.action === "render_proof")?.reason)).toContain("outside the task worktree");
});

test.skipIf(process.platform !== "darwin")("a failed harness run never becomes a picture on the issue", async () => {
  const jira = fakeJira({ issues: [{ key: "WEB-1", id: "1", status: "In Review" }] });
  const { db, projectId, root } = await uiTaskWithNoShots(jira, true);
  // The run wrote a PNG and THEN went red: an error page is still a PNG.
  const stats = await run(db, projectId, jira.fetchImpl, CFG, { exec: execRendering(root, 1, 1) });

  expect(stats.rendered).toBe(0);
  expect(stats.attachments).toBe(0);
  expect(jira.byKey.get("WEB-1")!.attachments).toHaveLength(0);
  expect(db.query("SELECT id FROM evidence").all()).toHaveLength(0);
  const logged = syncEvents(db).find((e) => e.action === "render_proof");
  expect(String(logged?.reason)).toContain("exit 1");
  expect(readdirSyncT(root).some((name) => name.startsWith(".hive-proof-"))).toBe(false);
});

test.skipIf(process.platform !== "darwin")("the reason names the real failure, not node's deprecation noise", async () => {
  const jira = fakeJira({ issues: [{ key: "WEB-1", id: "1", status: "In Review" }] });
  const { db, projectId, root } = await uiTaskWithNoShots(jira, true);
  // Playwright reports the failure on stdout; node writes deprecation warnings
  // to stderr. Reading stderr first buried the only line worth showing.
  const exec = async (argv: string[]) => {
    if (!isHarnessRun(argv)) return { code: 0, stdout: UI_PATCH, stderr: "" };
    return {
      code: 1,
      stdout: "\u001b[1A\u001b[2K1 failed\n  Error: page could not load its data, 47 request(s) failed: https://api.example.test/v1/news",
      stderr: "(node:123) [DEP0205] DeprecationWarning: `module.register()` is deprecated.\n(Use `node --trace-deprecation ...` to show where the warning was created)",
    };
  };

  const stats = await run(db, projectId, jira.fetchImpl, CFG, { exec });

  expect(stats.rendered).toBe(0);
  const reason = String(syncEvents(db).find((e) => e.action === "render_proof")?.reason);
  expect(reason).toContain("page could not load its data");
  expect(reason).not.toContain("DeprecationWarning");
  expect(reason).not.toContain("\u001b");
});

// Capture the spec hive generates for a real sync, then RUN it against a fake
// page. Matching on the source text only proves the guard was written; running
// it proves the guard decides correctly, which is the part that posts or
// withholds a picture on a live ticket.
async function generatedSpec(root: string, db: DB, projectId: string, jira: ReturnType<typeof fakeJira>) {
  let spec = "";
  const exec = async (argv: string[]) => {
    if (!isHarnessRun(argv)) return { code: 0, stdout: UI_PATCH, stderr: "" };
    const dir = join(root, "web", "e2e");
    const name = readdirSyncT(dir).find((f) => f.startsWith("hive-proof-"))!;
    spec = await Bun.file(join(dir, name)).text();
    return { code: 0, stdout: "1 passed", stderr: "" };
  };
  await run(db, projectId, jira.fetchImpl, CFG, { exec });
  return spec;
}

// Playwright's own `test` and the import of it are the only things the spec
// needs from outside, so both are stubbed and the body runs as plain JS.
function runSpec(spec: string, page: unknown): Promise<void> {
  const body = spec
    .replace(/^import .*$/m, "")
    .replace(/^test\.use\(.*$/m, "");
  const cases: Array<(args: { page: unknown }) => Promise<void>> = [];
  const test = (_name: string, fn: (args: { page: unknown }) => Promise<void>) => cases.push(fn);
  (test as { use?: () => void }).use = () => {};
  new Function("test", body)(test);
  return cases[0]({ page });
}

// A failed request carries the three facts the filter reads.
const failedRequest = (url: string, resourceType: string, errorText = "net::ERR_FAILED") => ({
  url: () => url,
  resourceType: () => resourceType,
  failure: () => ({ errorText }),
});

// `overlayText` non-null makes the page look like a dev server showing a
// compile error over the app: HTTP 200, no failed request, still not proof.
// `content` is what the browser reports back about what the page painted: how
// many characters of text the body shows, and how many visible images it has.
// The default is an ordinary page with plenty of both.
function fakePage(
  url: string,
  failures: Array<ReturnType<typeof failedRequest>>,
  overlayText: string | null = null,
  content: { text: number; media: number } = { text: 500, media: 3 }
) {
  let onFailed: (r: unknown) => void = () => {};
  let shot = false;
  return {
    page: {
      locator: (_selector: string) => ({
        first: () => ({
          count: async () => (overlayText ? 1 : 0),
          evaluate: async () => overlayText ?? "",
        }),
      }),
      on: (event: string, fn: (r: unknown) => void) => {
        if (event === "requestfailed") onFailed = fn;
      },
      goto: async () => {
        for (const f of failures) onFailed(f);
        return { ok: () => true, status: () => 200 };
      },
      waitForLoadState: async () => {},
      evaluate: async () => content,
      url: () => url,
      screenshot: async () => {
        shot = true;
      },
    },
    tookShot: () => shot,
  };
}

const PAGE_URL = "http://localhost:3000/insights";

// A fresh hive worktree has no node_modules. `npx --no-install playwright` did
// not stop there: it walked PATH and ran the host's own playwright, a different
// package whose CLI has no `test` command. Hive must refuse instead.
test.skipIf(process.platform !== "darwin")("an uninstalled repo is refused, never run off the host PATH", async () => {
  const jira = fakeJira({ issues: [{ key: "WEB-1", id: "1", status: "In Review" }] });
  const { db, projectId } = freshDb();
  await run(db, projectId, jira.fetchImpl);
  const task = tasks(db)[0];
  const root = fakeWorktree(task.id, true, undefined, false); // harness, but no deps
  db.query("UPDATE tasks SET branch = ?, worktree_path = ? WHERE id = ?").run("hive/x", root, task.id);
  trustRepo(db, projectId);

  const seen: string[][] = [];
  const exec = async (argv: string[]) => {
    seen.push(argv);
    return { code: 0, stdout: UI_PATCH, stderr: "" };
  };
  const stats = await run(db, projectId, jira.fetchImpl, CFG, { exec });

  expect(stats.rendered).toBe(0);
  expect(stats.errors).toBe(0);
  expect(db.query("SELECT id FROM evidence").all()).toHaveLength(0);
  expect(seen.some(isHarnessRun)).toBe(false); // no browser was started at all
  const reason = String(syncEvents(db).find((e) => e.action === "render_proof")?.reason);
  expect(reason).toContain("no installed Playwright");
  expect(reason).toContain("host PATH");
});

// A fresh worktree has no node_modules, but the main checkout it was cut from
// does. Hive borrows those for the render (it cannot install: the fence denies
// the network) and unlinks them again as soon as the run is over.
test.skipIf(process.platform !== "darwin")("a fresh worktree borrows the main checkout's installed deps", async () => {
  const jira = fakeJira({ issues: [{ key: "WEB-1", id: "1", status: "In Review" }] });
  const { db, projectId } = freshDb();
  await run(db, projectId, jira.fetchImpl);
  const task = tasks(db)[0];
  const root = fakeWorktree(task.id, true, undefined, false); // harness, no deps
  writeFileSyncT(join(root, "web", "package.json"), "{}\n");

  // The main checkout: same layout, deps installed, one real package to link.
  const main = join(HOME, `main-${newId()}`);
  mkdirSyncT(join(main, "web", "node_modules", ".bin"), { recursive: true });
  mkdirSyncT(join(main, "web", "node_modules", "react"), { recursive: true });
  // A dev-server cache. Linking it would send Vite's startup rewrite to the
  // main checkout, which the seatbelt denies and Vite dies on.
  mkdirSyncT(join(main, "web", "node_modules", ".vite", "deps"), { recursive: true });
  writeFileSyncT(join(main, "web", "package.json"), "{}\n");
  writeFileSyncT(join(main, "web", "node_modules", ".bin", "playwright"), "#!/bin/sh\n");
  writeFileSyncT(join(root, ".git"), `gitdir: ${join(main, ".git", "worktrees", "wt")}\n`);

  db.query("UPDATE tasks SET branch = ?, worktree_path = ? WHERE id = ?").run("hive/x", root, task.id);
  trustRepo(db, projectId);

  const render = execRendering(root, 1);
  const seen: string[][] = [];
  const stats = await run(db, projectId, jira.fetchImpl, CFG, {
    exec: async (argv: string[], opts: any) => {
      seen.push(argv);
      if (isHarnessRun(argv)) {
        // The borrowed packages are in place while the harness runs, reachable
        // from inside the worktree.
        expect(readFileSyncT(join(root, "web", "node_modules", ".bin", "playwright"), "utf8")).toBe("#!/bin/sh\n");
        expect(existsSync(join(root, "web", "node_modules", "react"))).toBe(true);
        expect(existsSync(join(root, "web", "node_modules", ".vite"))).toBe(false);
      }
      return render(argv);
    },
  });

  expect(stats.rendered).toBe(1);
  const harness = seen.find(isHarnessRun)!;
  expect(harness[harness.findIndex((a) => a.endsWith("/.bin/playwright"))]).toBe(
    join(root, "web", "node_modules", ".bin", "playwright")
  );
  // Gone again afterwards: a branch left wired to another checkout's deps is a
  // mystery build waiting to happen.
  expect(existsSync(join(root, "web", "node_modules"))).toBe(false);
  // And the main checkout is untouched.
  expect(existsSync(join(main, "web", "node_modules", ".bin", "playwright"))).toBe(true);
});

test.skipIf(process.platform !== "darwin")(
  "the generated spec still shoots when only third-party and cancelled requests failed",
  async () => {
    const jira = fakeJira({ issues: [{ key: "WEB-1", id: "1", status: "In Review" }] });
    const { db, projectId, root } = await uiTaskWithNoShots(jira, true);
    const spec = await generatedSpec(root, db, projectId, jira);

    // Every one of these fails on EVERY run, because the seatbelt allows only
    // localhost. None of them means the page is broken.
    const { page, tookShot } = fakePage(PAGE_URL, [
      failedRequest("https://us.i.posthog.com/e/", "fetch"), // analytics beacon
      failedRequest("https://www.google-analytics.com/g/collect", "xhr"),
      failedRequest("https://fonts.gstatic.com/s/inter.woff2", "font"),
      failedRequest("http://localhost:3000/hero.png", "image"), // same-origin, but not needed to render
      failedRequest("http://localhost:3000/_next/data/next.json", "fetch", "net::ERR_ABORTED"), // cancelled prefetch
    ]);

    await runSpec(spec, page);

    expect(tookShot()).toBe(true);
  }
);

test.skipIf(process.platform !== "darwin")(
  "the generated spec refuses a page whose own data failed to load",
  async () => {
    const jira = fakeJira({ issues: [{ key: "WEB-1", id: "1", status: "In Review" }] });
    const { db, projectId, root } = await uiTaskWithNoShots(jira, true);
    const spec = await generatedSpec(root, db, projectId, jira);

    // A single-page app renders its own error boundary with HTTP 200, so the
    // spec itself has to fail the shot; exit code alone would call that proof.
    const { page, tookShot } = fakePage(PAGE_URL, [
      failedRequest("https://us.i.posthog.com/e/", "fetch"), // noise, alongside the real one
      failedRequest("http://localhost:3000/api/insights", "xhr"),
    ]);

    let thrown = "";
    await runSpec(spec, page).catch((e) => {
      thrown = String(e?.message ?? e);
    });

    expect(thrown).toContain("page could not load its data");
    expect(thrown).toContain("1 request(s) failed"); // the beacon was not counted
    expect(thrown).toContain("http://localhost:3000/api/insights");
    expect(tookShot()).toBe(false);
  }
);

// Found by running this code against a real checkout: the dev server answered
// 200, no request failed, and the screenshot was a full-page Vite overlay
// reading "Failed to resolve import". Exactly the picture that must not ship.
test.skipIf(process.platform !== "darwin")("the generated spec refuses a dev-server error overlay", async () => {
  const jira = fakeJira({ issues: [{ key: "WEB-1", id: "1", status: "In Review" }] });
  const { db, projectId, root } = await uiTaskWithNoShots(jira, true);
  const spec = await generatedSpec(root, db, projectId, jira);

  const { page, tookShot } = fakePage(
    PAGE_URL,
    [],
    '[plugin:vite:import-analysis] Failed to resolve import "lexical-schema"'
  );

  let thrown = "";
  await runSpec(spec, page).catch((e) => {
    thrown = String(e?.message ?? e);
  });

  expect(thrown).toContain("dev-server error overlay");
  expect(thrown).toContain("Failed to resolve import"); // the reason names the real cause
  expect(tookShot()).toBe(false);
});

test.skipIf(process.platform !== "darwin")("the generated spec refuses a non-2xx page", async () => {
  const jira = fakeJira({ issues: [{ key: "WEB-1", id: "1", status: "In Review" }] });
  const { db, projectId, root } = await uiTaskWithNoShots(jira, true);
  const spec = await generatedSpec(root, db, projectId, jira);

  const { page, tookShot } = fakePage(PAGE_URL, []);
  page.goto = async () => ({ ok: () => false, status: () => 500 });

  let thrown = "";
  await runSpec(spec, page).catch((e) => {
    thrown = String(e?.message ?? e);
  });

  expect(thrown).toContain("page answered HTTP 500");
  expect(tookShot()).toBe(false);
});

// The corebeat run that prompted this: the app's API is unreachable inside the
// seatbelt, so the page answered 200, failed no request hive counts, showed no
// overlay, and painted a blank white 1280x800. A blank picture is worse than no
// picture, so the spec fails the shot.
test.skipIf(process.platform !== "darwin")("the generated spec refuses a blank page", async () => {
  const jira = fakeJira({ issues: [{ key: "WEB-1", id: "1", status: "In Review" }] });
  const { db, projectId, root } = await uiTaskWithNoShots(jira, true);
  const spec = await generatedSpec(root, db, projectId, jira);

  const { page, tookShot } = fakePage(PAGE_URL, [], null, { text: 0, media: 0 });

  let thrown = "";
  await runSpec(spec, page).catch((e) => {
    thrown = String(e?.message ?? e);
  });

  expect(thrown).toContain("page rendered nothing");
  expect(tookShot()).toBe(false);
});

// A page can be nearly wordless and still be a real picture, so text alone does
// not condemn it: one visible image is enough to shoot.
test.skipIf(process.platform !== "darwin")("the generated spec still shoots a wordless page that shows an image", async () => {
  const jira = fakeJira({ issues: [{ key: "WEB-1", id: "1", status: "In Review" }] });
  const { db, projectId, root } = await uiTaskWithNoShots(jira, true);
  const spec = await generatedSpec(root, db, projectId, jira);

  const { page, tookShot } = fakePage(PAGE_URL, [], null, { text: 3, media: 1 });

  await runSpec(spec, page);

  expect(tookShot()).toBe(true);
});

// End to end: the spec hive generated, run against a blank page, makes the
// harness go red, and the ticket falls back to text with a reason that names
// the empty page.
test.skipIf(process.platform !== "darwin")("a blank page renders nothing and the reason names it", async () => {
  const jira = fakeJira({ issues: [{ key: "WEB-1", id: "1", status: "In Review" }] });
  const { db, projectId, root } = await uiTaskWithNoShots(jira, true);
  const exec = async (argv: string[]) => {
    if (!isHarnessRun(argv)) return { code: 0, stdout: UI_PATCH, stderr: "" };
    const dir = join(root, "web", "e2e");
    const name = readdirSyncT(dir).find((f) => f.startsWith("hive-proof-"))!;
    const spec = await Bun.file(join(dir, name)).text();
    const { page } = fakePage(PAGE_URL, [], null, { text: 0, media: 0 });
    let thrown = "";
    await runSpec(spec, page).catch((e) => {
      thrown = String(e?.message ?? e);
    });
    return { code: 1, stdout: `1 failed\n  Error: ${thrown}`, stderr: "" };
  };

  const stats = await run(db, projectId, jira.fetchImpl, CFG, { exec });

  expect(stats.rendered).toBe(0);
  expect(db.query("SELECT id FROM evidence").all()).toHaveLength(0);
  expect(jira.byKey.get("WEB-1")!.attachments).toHaveLength(0);
  const reason = String(syncEvents(db).find((e) => e.action === "render_proof")?.reason);
  expect(reason).toContain("page rendered nothing");
  expect(reason).toContain("blank");
});

test("the scratch directory is gone even when the harness throws", async () => {
  const jira = fakeJira({ issues: [{ key: "WEB-1", id: "1", status: "In Review" }] });
  const { db, projectId, root } = await uiTaskWithNoShots(jira, true);
  const exec = async (argv: string[]) => {
    if (isHarnessRun(argv)) throw new Error("spawn npx ENOENT");
    return { code: 0, stdout: UI_PATCH, stderr: "" };
  };

  const stats = await run(db, projectId, jira.fetchImpl, CFG, { exec });
  expect(stats.rendered).toBe(0);
  expect(stats.errors).toBe(0);
  expect(readdirSyncT(root).some((name) => name.startsWith(".hive-proof-"))).toBe(false);
  expect(readdirSyncT(join(root, "web", "e2e")).some((name) => name.startsWith("hive-proof-"))).toBe(false);
});

test.skipIf(process.platform !== "darwin")("the task's diff is read once per cycle, not once per check", async () => {
  const jira = fakeJira({ issues: [{ key: "WEB-1", id: "1", status: "In Review" }] });
  const { db, projectId, root } = await uiTaskWithNoShots(jira, true);
  let diffReads = 0;
  const render = execRendering(root, 1);
  const exec = async (argv: string[]) => {
    if (!isHarnessRun(argv)) diffReads++;
    return render(argv);
  };

  const stats = await run(db, projectId, jira.fetchImpl, CFG, { exec });
  expect(stats.rendered).toBe(1);
  expect(diffReads).toBe(1); // the UI-scope check and the renderer share one read
});

// ============================================================================
// REQUEUE CARRIES THE JIRA LINK  (hive-1872)
// ============================================================================
// Ten WEB sub-tasks sat at In Progress while their work was merged on main. The
// tasks had died to infrastructure and been requeued; the successor that
// finished the work carried no jira_key, and the failed row that did could
// never push (failed maps to no Jira status). So nothing ever closed the issue.
const { requeueTask } = await import("../src/api.ts");

// A task linked to WEB-23 as a sub-task, plus the tracking-only mirror row the
// importer creates for the same issue.
function linkedSubtask(db: DB, projectId: string, key = "WEB-23"): string {
  const taskId = newId();
  const ts = now();
  db.query(
    `INSERT INTO tasks (id, project_id, title, state, kind, jira_key, jira_link_kind, created_at, updated_at)
     VALUES (?, ?, 'Linked work', 'in_progress', 'ship', ?, 'subtask', ?, ?)`
  ).run(taskId, projectId, key, ts, ts);
  db.query(
    `INSERT INTO tasks (id, project_id, title, state, kind, source, source_ref, jira_key, jira_link_kind, created_at, updated_at)
     VALUES (?, ?, 'Mirror', 'in_progress', 'ship', 'external', ?, ?, 'mirror', ?, ?)`
  ).run(newId(), projectId, `jira:${key}`, key, ts, ts);
  return taskId;
}

const finish = (db: DB, taskId: string) => {
  db.query("UPDATE tasks SET state = 'done', updated_at = ? WHERE id = ?").run(now(), taskId);
  writeEvent(db, { task_id: taskId, source: "director", type: "state_change", payload: { from: "in_progress", to: "done" } });
};

const linkOf = (db: DB, taskId: string) =>
  db.query("SELECT jira_key, jira_link_kind FROM tasks WHERE id = ?").get(taskId) as any;

const subtaskOwners = (db: DB, key = "WEB-23") =>
  (db.query("SELECT id FROM tasks WHERE jira_key = ? AND jira_link_kind = 'subtask'").all(key) as any[]).map((r) => r.id);

test("a requeue MOVES the Jira link to the successor, and the successor closes the issue", async () => {
  const jira = fakeJira({ issues: [{ key: "WEB-23", id: "23", status: "In Progress", parentKey: "WEB-7" }] });
  const { db, projectId } = freshDb();
  const original = linkedSubtask(db, projectId);

  transition(db, original, "failed", { source: "reconciler", reason: "agent died" });
  const successor = requeueTask(db, db.query("SELECT * FROM tasks WHERE id = ?").get(original));

  // the link moved: the dead row no longer claims it, exactly one task holds it
  expect(linkOf(db, original)).toEqual({ jira_key: null, jira_link_kind: null });
  expect(linkOf(db, successor)).toEqual({ jira_key: "WEB-23", jira_link_kind: "subtask" });
  expect(subtaskOwners(db)).toEqual([successor]);

  finish(db, successor);
  await run(db, projectId, jira.fetchImpl);

  // assert on the ISSUE, not on hive's own state
  expect(jira.byKey.get("WEB-23")!.status).toBe("Done");
});

test("the link survives a multi-hop recovery chain and lands on the task that finishes", async () => {
  const jira = fakeJira({ issues: [{ key: "WEB-43", id: "43", status: "In Progress" }] });
  const { db, projectId } = freshDb();
  const first = linkedSubtask(db, projectId, "WEB-43");

  transition(db, first, "failed", { source: "reconciler", reason: "died" });
  const second = requeueTask(db, db.query("SELECT * FROM tasks WHERE id = ?").get(first));
  expect(subtaskOwners(db, "WEB-43")).toEqual([second]);

  transition(db, second, "in_progress", { source: "reconciler" });
  transition(db, second, "failed", { source: "reconciler", reason: "died again" });
  const third = requeueTask(db, db.query("SELECT * FROM tasks WHERE id = ?").get(second));

  expect(linkOf(db, first)).toEqual({ jira_key: null, jira_link_kind: null });
  expect(linkOf(db, second)).toEqual({ jira_key: null, jira_link_kind: null });
  expect(subtaskOwners(db, "WEB-43")).toEqual([third]);

  finish(db, third);
  await run(db, projectId, jira.fetchImpl);
  expect(jira.byKey.get("WEB-43")!.status).toBe("Done");
});

test("a task that fails and is never requeued leaves its Jira issue alone", async () => {
  const jira = fakeJira({ issues: [{ key: "WEB-23", id: "23", status: "In Progress" }] });
  const { db, projectId } = freshDb();
  const taskId = linkedSubtask(db, projectId);

  transition(db, taskId, "failed", { source: "reconciler", reason: "gave up" });
  await run(db, projectId, jira.fetchImpl);

  expect(jira.byKey.get("WEB-23")!.status).toBe("In Progress");
  expect(jira.writes().filter((c) => c.path.endsWith("/transitions"))).toEqual([]);
});

test("the issue's hive-task marker does not re-link the dead predecessor after a requeue", async () => {
  const { db, projectId } = freshDb();
  const original = linkedSubtask(db, projectId);
  // the sub-task hive created names the ORIGINAL task forever
  const jira = fakeJira({ issues: [{
    key: "WEB-23", id: "23", status: "In Progress",
    description: J.textToAdf(`hive-task: ${original}`),
  }] });

  transition(db, original, "failed", { source: "reconciler", reason: "agent died" });
  const successor = requeueTask(db, db.query("SELECT * FROM tasks WHERE id = ?").get(original));

  const stats = await run(db, projectId, jira.fetchImpl);
  expect(stats.errors).toBe(0);
  expect(stats.failures).toEqual([]);
  expect(subtaskOwners(db)).toEqual([successor]);

  finish(db, successor);
  await run(db, projectId, jira.fetchImpl);
  expect(jira.byKey.get("WEB-23")!.status).toBe("Done");
});

// The pull direction needs no change, and this test pins why: for a sub-task
// link hive is authoritative and reconcileLinkedTask only ever PUSHES. Pulls
// happen on the mirror row, and a mirror can never be requeued, so moving the
// sub-task key cannot point a pull at the wrong row.
test("only the mirror pulls, and a mirror is never requeued, so the pull side is unaffected", async () => {
  const jira = fakeJira({ issues: [{
    key: "WEB-23", id: "23", status: "In Review",
    history: [{ at: "2099-01-01T00:00:00.000Z", to: "In Review" }],
  }] });
  const { db, projectId } = freshDb();
  const original = linkedSubtask(db, projectId);
  const mirror = db.query("SELECT * FROM tasks WHERE jira_link_kind = 'mirror'").get() as any;

  transition(db, original, "failed", { source: "reconciler", reason: "agent died" });
  const successor = requeueTask(db, db.query("SELECT * FROM tasks WHERE id = ?").get(original));

  expect(() => requeueTask(db, mirror)).toThrow();
  expect(db.query("SELECT id FROM tasks WHERE jira_key = 'WEB-23' AND jira_link_kind = 'mirror'").all())
    .toEqual([{ id: mirror.id }]);

  await run(db, projectId, jira.fetchImpl);

  // Jira moved most recently, so the mirror pulls; the sub-task side pushes,
  // and it is the successor that does it.
  expect((db.query("SELECT state FROM tasks WHERE id = ?").get(mirror.id) as any).state).toBe("in_review");
  expect(syncEvents(db).filter((e: any) => e.linked)).toContainEqual(
    expect.objectContaining({ action: "push", issue: "WEB-23", to: "To Do", linked: true, outcome: "ok" })
  );
  expect(db.query(
    "SELECT COUNT(*) AS count FROM events WHERE task_id = ? AND type = 'jira_sync'"
  ).get(successor)).toEqual({ count: 2 });
});
