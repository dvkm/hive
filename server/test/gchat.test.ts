import { test, expect, beforeEach } from "bun:test";
import { openDb, newId, now, type DB } from "../src/db.ts";
import {
  pollGchatOnce,
  startGchatPoll,
  getAccessToken,
  getCursor,
  buildPermalink,
  resetGchatState,
  type GchatSecrets,
  type FetchLike,
} from "../src/intake/gchat.ts";

beforeEach(() => resetGchatState());

const SECRETS: GchatSecrets = { clientId: "id", clientSecret: "sec", refreshToken: "rt", self: "users/me" };

function freshDb(gchat_spaces: any = [{ space: "spaces/AAA", label: "eng" }]): { db: DB; projectId: string } {
  const db = openDb(":memory:");
  const projectId = newId("proj");
  db.query("INSERT INTO projects (id, name, config, created_at) VALUES (?,?,?,?)").run(
    projectId,
    "p",
    JSON.stringify({ gchat_spaces }),
    now()
  );
  return { db, projectId };
}

// Build a fetch stub. `messages` is the list returned by messages.list; token
// refresh and media download are handled generically. `onToken` counts refreshes.
function makeFetch(opts: {
  messages?: any[];
  onToken?: () => void;
  media?: Uint8Array;
  fail?: "token" | "list";
}): FetchLike {
  return (async (input: any, init?: any) => {
    const u = String(input);
    if (u.includes("oauth2.googleapis.com/token")) {
      opts.onToken?.();
      if (opts.fail === "token") return new Response("nope", { status: 400 });
      return new Response(JSON.stringify({ access_token: "at-123", expires_in: 3600 }), { status: 200 });
    }
    if (u.includes("/messages?")) {
      if (opts.fail === "list") return new Response("boom", { status: 500 });
      return new Response(JSON.stringify({ messages: opts.messages ?? [] }), { status: 200 });
    }
    if (u.includes("/media/")) {
      return new Response(opts.media ?? new Uint8Array([1, 2, 3]), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as unknown as FetchLike;
}

const msg = (over: any = {}) => ({
  name: "spaces/AAA/messages/M1.M1",
  text: "Prod is down, please help\nmore detail",
  sender: { name: "users/henry", displayName: "Henry", type: "HUMAN" },
  createTime: "2026-07-09T10:00:00Z",
  thread: { name: "spaces/AAA/threads/T1" },
  ...over,
});

test("token refresh caches within its TTL", async () => {
  let hits = 0;
  const f = makeFetch({ onToken: () => hits++ });
  const t1 = await getAccessToken(SECRETS, f, () => 1000);
  const t2 = await getAccessToken(SECRETS, f, () => 2000); // still valid
  expect(t1).toBe("at-123");
  expect(t2).toBe("at-123");
  expect(hits).toBe(1); // only one network refresh
});

test("message maps to an unreviewed intake task with source tag", async () => {
  const { db, projectId } = freshDb();
  const f = makeFetch({ messages: [msg()] });
  const r = await pollGchatOnce(db, { fetch: f, secrets: SECRETS, notify: false });
  expect(r.created).toBe(1);

  const task = db.query("SELECT * FROM tasks WHERE project_id = ?").get(projectId) as any;
  expect(task.source).toBe("intake_gchat");
  expect(task.source_ref).toBe("spaces/AAA/messages/M1.M1");
  expect(task.title).toBe("[intake:gchat] Prod is down, please help");
  expect(task.kind).toBe("ship");
  expect(task.state).toBe("queued");
  expect(task.brief).toContain("Prod is down, please help"); // full message verbatim
  expect(task.brief).toContain("Henry");

  const note = db.query("SELECT * FROM events WHERE task_id = ? AND type = 'note'").get(task.id) as any;
  expect(JSON.parse(note.payload).note).toContain("UNREVIEWED");
});

test("dedupe: same message resource name is ingested once", async () => {
  const { db, projectId } = freshDb();
  const f = makeFetch({ messages: [msg()] });
  await pollGchatOnce(db, { fetch: f, secrets: SECRETS, notify: false });
  // Second poll returns the same message again (cursor reset by re-listing).
  await pollGchatOnce(db, { fetch: makeFetch({ messages: [msg()] }), secrets: SECRETS, notify: false });
  const tasks = db.query("SELECT * FROM tasks WHERE project_id = ?").all(projectId);
  expect(tasks.length).toBe(1);
});

test("incremental cursor advances to the newest message createTime", async () => {
  const { db } = freshDb();
  const msgs = [
    msg({ name: "spaces/AAA/messages/M1", createTime: "2026-07-09T10:00:00Z" }),
    msg({ name: "spaces/AAA/messages/M2", createTime: "2026-07-09T11:00:00Z" }),
  ];
  await pollGchatOnce(db, { fetch: makeFetch({ messages: msgs }), secrets: SECRETS, notify: false });
  expect(getCursor(db, "gchat", "spaces/AAA")).toBe("2026-07-09T11:00:00Z");
});

test("self-authored and bot messages are skipped (but still advance the cursor)", async () => {
  const { db, projectId } = freshDb();
  const msgs = [
    msg({ name: "spaces/AAA/messages/SELF", sender: { name: "users/me", type: "HUMAN" }, createTime: "2026-07-09T09:00:00Z" }),
    msg({ name: "spaces/AAA/messages/BOT", sender: { name: "users/bot", type: "BOT" }, createTime: "2026-07-09T09:30:00Z" }),
  ];
  const r = await pollGchatOnce(db, { fetch: makeFetch({ messages: msgs }), secrets: SECRETS, notify: false });
  expect(r.created).toBe(0);
  expect(db.query("SELECT COUNT(*) AS n FROM tasks").get() as any).toMatchObject({ n: 0 });
  expect(getCursor(db, "gchat", "spaces/AAA")).toBe("2026-07-09T09:30:00Z");
});

test("image attachment under the cap is stored as evidence; oversized is skipped", async () => {
  const { db, projectId } = freshDb();
  const okMsg = msg({
    name: "spaces/AAA/messages/IMG",
    attachment: [
      { contentName: "shot.png", contentType: "image/png", attachmentDataRef: { resourceName: "media/abc" } },
      { contentName: "huge.png", contentType: "image/png", attachmentDataRef: { resourceName: "media/big" } },
      { contentName: "doc.pdf", contentType: "application/pdf", attachmentDataRef: { resourceName: "media/pdf" } },
    ],
  });
  // media fetch returns a small image for all; enforce cap by patching one path.
  const f = (async (input: any, init?: any) => {
    const u = String(input);
    if (u.includes("oauth2")) return new Response(JSON.stringify({ access_token: "at", expires_in: 3600 }), { status: 200 });
    if (u.includes("/messages?")) return new Response(JSON.stringify({ messages: [okMsg] }), { status: 200 });
    if (u.includes("media/big")) return new Response(new Uint8Array(6 * 1024 * 1024), { status: 200 }); // > 5MB
    if (u.includes("media/")) return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
    return new Response("{}", { status: 200 });
  }) as unknown as FetchLike;

  await pollGchatOnce(db, { fetch: f, secrets: SECRETS, notify: false });
  const task = db.query("SELECT id FROM tasks WHERE project_id = ?").get(projectId) as any;
  const ev = db.query("SELECT * FROM evidence WHERE task_id = ?").all(task.id) as any[];
  expect(ev.length).toBe(1); // only the small png; oversized + non-image skipped
  expect(ev[0].kind).toBe("screenshot");
});

test("unconfigured is a hard no-op (no secrets resolved, no network)", async () => {
  const { db } = freshDb([]); // no gchat_spaces
  let touched = false;
  const f = (async () => { touched = true; return new Response("{}"); }) as unknown as FetchLike;
  const r = await pollGchatOnce(db, { fetch: f, notify: false });
  expect(r).toEqual({ created: 0, spaces: 0 });
  expect(touched).toBe(false);
});

test("errors emit a single diagnostic then stay quiet, recovering on success", async () => {
  const { db } = freshDb();
  const logs: string[] = [];
  const log = (m: string) => logs.push(m);
  const failing = makeFetch({ messages: [], fail: "list" });

  await pollGchatOnce(db, { fetch: failing, secrets: SECRETS, notify: false, log });
  await pollGchatOnce(db, { fetch: failing, secrets: SECRETS, notify: false, log });
  await pollGchatOnce(db, { fetch: failing, secrets: SECRETS, notify: false, log });
  expect(logs.length).toBe(1); // quiet after the first diagnostic

  // Recover, then fail again -> a fresh diagnostic is allowed.
  await pollGchatOnce(db, { fetch: makeFetch({ messages: [] }), secrets: SECRETS, notify: false, log });
  await pollGchatOnce(db, { fetch: failing, secrets: SECRETS, notify: false, log });
  expect(logs.length).toBe(2);
});

test('gchat_spaces "*" polls every space spaces.list returns, across pages', async () => {
  const { db } = freshDb("*");
  let spacePage = 0;
  // Each space must yield a distinct message name — intake dedupes on it.
  const f = (async (input: any) => {
    const u = String(input);
    if (u.includes("oauth2.googleapis.com/token"))
      return new Response(JSON.stringify({ access_token: "at", expires_in: 3600 }), { status: 200 });
    if (u.includes("/v1/spaces?")) {
      const pages = [
        { spaces: [{ name: "spaces/AAA" }, { name: "spaces/BBB" }], nextPageToken: "p2" },
        { spaces: [{ name: "spaces/CCC" }] },
      ];
      return new Response(JSON.stringify(pages[spacePage++]), { status: 200 });
    }
    if (u.includes("/messages?")) {
      const space = u.match(/v1\/(spaces\/[^/]+)\/messages/)![1];
      return new Response(JSON.stringify({ messages: [msg({ name: `${space}/messages/M1.M1` })] }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as unknown as FetchLike;
  const r = await pollGchatOnce(db, { fetch: f, secrets: SECRETS, notify: false });
  expect(r.spaces).toBe(3); // paginated to exhaustion
  expect(r.created).toBe(3); // one intake task per space
});

test('gchat_spaces "*" survives a spaces.list failure with one diagnostic', async () => {
  const { db } = freshDb("*");
  const logs: string[] = [];
  const failing = (async (input: any) => {
    const u = String(input);
    if (u.includes("oauth2.googleapis.com/token"))
      return new Response(JSON.stringify({ access_token: "at", expires_in: 3600 }), { status: 200 });
    return new Response("boom", { status: 500 }); // spaces.list 500s
  }) as unknown as FetchLike;

  const r = await pollGchatOnce(db, { fetch: failing, secrets: SECRETS, notify: false, log: (m) => logs.push(m) });
  expect(r).toEqual({ created: 0, spaces: 0 }); // no jobs, no crash
  expect(logs.length).toBe(1);
});

test("poll-path requests all carry a 20-second timeout signal", async () => {
  const { db } = freshDb("*");
  const originalTimeout = AbortSignal.timeout;
  const timeoutCalls: number[] = [];
  const timeoutSignals: AbortSignal[] = [];
  const requestSignals: (AbortSignal | null | undefined)[] = [];
  (AbortSignal as any).timeout = (ms: number) => {
    timeoutCalls.push(ms);
    const signal = new AbortController().signal;
    timeoutSignals.push(signal);
    return signal;
  };

  try {
    const f = (async (input: any, init?: RequestInit) => {
      const u = String(input);
      requestSignals.push(init?.signal);
      if (u.includes("oauth2.googleapis.com/token"))
        return new Response(JSON.stringify({ access_token: "at", expires_in: 3600 }), { status: 200 });
      if (u.includes("/v1/spaces?"))
        return new Response(JSON.stringify({ spaces: [{ name: "spaces/AAA" }] }), { status: 200 });
      if (u.includes("/messages?")) {
        const withAttachment = msg({
          attachment: [{ contentType: "image/png", attachmentDataRef: { resourceName: "media/abc" } }],
        });
        return new Response(JSON.stringify({ messages: [withAttachment] }), { status: 200 });
      }
      if (u.includes("/media/")) return new Response("unavailable", { status: 503 });
      throw new Error(`unexpected request: ${u}`);
    }) as unknown as FetchLike;

    await pollGchatOnce(db, { fetch: f, secrets: SECRETS, notify: false });
  } finally {
    (AbortSignal as any).timeout = originalTimeout;
  }

  expect(timeoutCalls).toEqual([20_000, 20_000, 20_000, 20_000]);
  expect(requestSignals).toEqual(timeoutSignals);
});

test("startGchatPoll skips a tick while a cycle is already running", async () => {
  const { db } = freshDb();
  let active = 0;
  let maxActive = 0;
  let cycles = 0;
  const logs: string[] = [];
  // Ticks are driven by hand (setInterval is stubbed) so the overlap is exact
  // instead of racing wall-clock timers on a loaded CI box.
  let tick: () => void = () => {};
  let releaseList!: () => void;
  let listStarted!: () => void;
  let listFinished!: () => void;
  const blocked = new Promise<void>((resolve) => (releaseList = resolve));
  const started = new Promise<void>((resolve) => (listStarted = resolve));
  const finished = new Promise<void>((resolve) => (listFinished = resolve));
  // The messages.list call blocks until released and runs on every cycle
  // (unlike the token fetch, which caches) — it's the reliable overlap signal.
  const slowFetch: FetchLike = (async (input: any) => {
    const u = String(input);
    if (u.includes("oauth2.googleapis.com/token"))
      return new Response(JSON.stringify({ access_token: "at", expires_in: 3600 }), { status: 200 });
    if (u.includes("/messages?")) {
      cycles++;
      active++;
      maxActive = Math.max(maxActive, active);
      listStarted();
      await blocked;
      active--;
      listFinished();
      return new Response(JSON.stringify({ messages: [] }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as unknown as FetchLike;

  const origSetInterval = globalThis.setInterval;
  const origClearInterval = globalThis.clearInterval;
  globalThis.setInterval = ((callback: () => void) => {
    tick = callback;
    return 1;
  }) as unknown as typeof setInterval;
  globalThis.clearInterval = (() => {}) as typeof clearInterval;
  let stop: () => void;
  try {
    stop = startGchatPoll(db, {
      fetch: slowFetch,
      secrets: SECRETS,
      notify: false,
      intervalMs: 15,
      log: (m: string) => logs.push(m),
    });
    tick();
    await started;
    tick(); // second tick lands mid-cycle -> must be skipped, not queued
    releaseList();
    await finished;
    await new Promise(setImmediate);
    stop();
  } finally {
    globalThis.setInterval = origSetInterval;
    globalThis.clearInterval = origClearInterval;
  }

  expect(maxActive).toBe(1); // never two cycles in flight at once
  expect(cycles).toBe(1); // the overlapping tick was skipped, not queued
  expect(logs.some((m) => m.includes("skipped"))).toBe(true);
});

test("buildPermalink reconstructs a best-effort room deep-link", () => {
  expect(buildPermalink(msg())).toBe("https://chat.google.com/room/AAA/M1.M1");
  expect(buildPermalink({ name: "" })).toBe("");
});
