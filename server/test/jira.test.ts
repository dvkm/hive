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
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "hive-jira-"));
process.env.HIVE_HOME = HOME;

const { openDb, newId, now, setSetting } = await import("../src/db.ts");
const { writeEvent, transition } = await import("../src/state.ts");
const { addClient, removeClient } = await import("../src/bus.ts");
const J = await import("../src/intake/jira.ts");
import type { DB } from "../src/db.ts";

const SITE = "https://corebeat.atlassian.net";
const EMAIL = "corebeat@vid.kim";
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
  created?: string | null;
  updated?: string;
  history?: { at: string; to: string }[]; // status transitions, oldest first
  rawHistory?: any[] | null;
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
}

function fakeJira(opts: FakeOpts) {
  const byKey = new Map(opts.issues.map((i) => [i.key, { labels: [], assignee: null, projectKey: "WEB", summary: "s", created: "2026-01-01T00:00:00.000Z", updated: "2026-01-01T00:00:00.000Z", history: [], rawHistory: null, comments: [], ...i } as Required<FakeIssue>]));
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
    const body = init.body ? JSON.parse(init.body) : undefined;
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
        const allow = (opts.jqlOnly ?? [...byKey.keys()]).filter((candidate) => byKey.get(candidate)?.projectKey === "WEB");
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
            summary: iss.summary, description: null, created: iss.created, updated: iss.updated,
            status: { name: iss.status }, labels: [...iss.labels],
            assignee: iss.assignee ? { accountId: iss.assignee } : null,
            priority: { name: "Medium" }, issuetype: { name: "Story" },
            project: iss.projectKey == null ? undefined : { key: iss.projectKey },
          };
          for (const field of opts.omitIssueFields ?? []) delete fields[field];
          return json({ key, id: iss.id, fields });
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
test("credential gate: only the exact compiled-in https host + email is allowed", () => {
  expect(J.credentialTargetAllowed(SITE, EMAIL)).toBe(true);

  // http is rejected outright — Basic auth over http is base64, not encryption.
  expect(J.credentialTargetAllowed("http://corebeat.atlassian.net", EMAIL)).toBe(false);

  // A SUFFIX check would pass these. Atlassian Cloud sites are self-serve, so an
  // attacker registers `evil.atlassian.net` for free; that is exactly why the
  // check is an exact host match and not `*.atlassian.net`.
  expect(J.credentialTargetAllowed("https://evil.atlassian.net", EMAIL)).toBe(false);
  expect(J.credentialTargetAllowed("https://corebeat.atlassian.net.evil.com", EMAIL)).toBe(false);
  expect(J.credentialTargetAllowed("https://notcorebeat.atlassian.net", EMAIL)).toBe(false);

  // userinfo trick: parses to host evil.tld, reads as the real site to a human.
  expect(J.credentialTargetAllowed("https://corebeat.atlassian.net@evil.tld/", EMAIL)).toBe(false);
  // new URL() reports username="" for a bare delimiter, so a falsy-userinfo
  // check alone lets these through. Not an exfil path (the host still resolves
  // correctly) but the parse must not be laxer than it reads.
  expect(J.credentialTargetAllowed("https://@corebeat.atlassian.net", EMAIL)).toBe(false);
  expect(J.credentialTargetAllowed("https://:@corebeat.atlassian.net", EMAIL)).toBe(false);
  // a different port is a different endpoint
  expect(J.credentialTargetAllowed("https://corebeat.atlassian.net:8443", EMAIL)).toBe(false);
  // garbage / empty
  expect(J.credentialTargetAllowed("not a url", EMAIL)).toBe(false);
  expect(J.credentialTargetAllowed("", EMAIL)).toBe(false);
  expect(J.credentialTargetAllowed(null, EMAIL)).toBe(false);

  // the gate covers the WHOLE credential pair, not just the host
  expect(J.credentialTargetAllowed(SITE, "attacker@evil.tld")).toBe(false);
  expect(J.credentialTargetAllowed(SITE, "")).toBe(false);
  expect(J.credentialTargetAllowed(SITE, null)).toBe(false);
});

test("credential gate: a mutated config is a hard no-op, and jiraConfig canonicalizes", () => {
  // jiraConfig returns null (not a throw a catch could swallow into 'carry on')
  expect(J.jiraConfig({ jira: { ...CFG, site: "https://evil.atlassian.net" } })).toBeNull();
  expect(J.jiraConfig({ jira: { ...CFG, site: "http://corebeat.atlassian.net" } })).toBeNull();
  expect(J.jiraConfig({ jira: { ...CFG, email: "attacker@evil.tld" } })).toBeNull();
  expect(J.jiraConfig({ jira: { ...CFG, project_key: "OTHER" } })).toBeNull();
  expect(J.jiraConfig({ jira: { ...CFG, jql: "labels = sync) OR project = OPS OR (project = WEB" } })).toBeNull();

  // and a passing config carries hive's OWN constants forward, not the caller's
  // string, so no unvalidated remnant can reach fetch().
  const ok = J.jiraConfig({ jira: { ...CFG, site: SITE + "/" } });
  expect(ok!.site).toBe(SITE);
  expect(ok!.email).toBe(EMAIL);
  expect(ok!.project_key).toBe("WEB");

  // the client refuses a hand-built config that bypassed jiraConfig()
  expect(() => new J.JiraClient({ ...CFG, site: "https://evil.tld" } as any, "tok")).toThrow(/allowlisted/);
  expect(() => new J.JiraClient({ ...CFG, project_key: "OTHER" } as any, "tok")).toThrow(/allowlisted/);
  expect(() => new J.JiraClient({ ...CFG, jql: "labels = sync) OR project = OPS OR (project = WEB" } as any, "tok")).toThrow(/allowlisted/);
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

test("SECURITY: a mutated target NEVER produces a request, even on the read path", async () => {
  // This is the actual guarantee, so this asserts the OUTPUT (no network call at
  // all) rather than merely that the validator exists. write:false is included
  // deliberately because shadow mode still exercises the read path.
  for (const target of [{ site: "https://evil.atlassian.net" }, { project_key: "OTHER" }]) {
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

  const observed = new Set<string>();
  for (const call of jira.writes()) {
    if (call.path.includes("/transitions")) observed.add("status");
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
    labels: [J.NEEDS_DECISION_LABEL],
    assignee: false,
  });
  expect([...observed].sort()).toEqual(["comments", "labels", "status"]);
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
      { id: "j1", author: "Sohee", text: "please start with the CMS bits", created: "2026-05-01T00:00:00.000Z" },
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
      { id: "j1", author: "Sohee", text: "out of scope" },
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

test("a disabled or non-allowlisted project reports WHY rather than failing silently", async () => {
  const off = freshDb({ ...CFG, enabled: false });
  const r1 = await J.runProjectCycle(off.db, off.projectId, { token: "tok" });
  expect(r1.ok).toBe(false);
  expect(r1.state.last_error).toContain("disabled");

  const bad = freshDb({ ...CFG, site: "https://evil.atlassian.net" });
  let called = 0;
  const spy = (async () => { called++; return new Response("{}"); }) as unknown as typeof fetch;
  const r2 = await J.runProjectCycle(bad.db, bad.projectId, { fetch: spy, token: "tok" });
  expect(r2.ok).toBe(false);
  expect(r2.state.last_error).toMatch(/allow-listed|config missing/);
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
