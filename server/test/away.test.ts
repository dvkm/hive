import { test, expect } from "bun:test";
import { openDb, newId, now, getSetting, type DB } from "../src/db.ts";
import { enqueue } from "../src/notifications.ts";
import { getAway, setAway, awayNow, desiredAway, inWindow, classOfKind, heldPushes, flushHeld, syncAway } from "../src/away.ts";
import type { PushPayload } from "../src/push.ts";
import { makeHandler } from "../src/api.ts";

function freshDb(): DB {
  const db = openDb(":memory:");
  db.query("INSERT INTO projects (id, name, created_at) VALUES (?,?,?)").run(newId("proj"), "p", now());
  return db;
}

// Collects every push instead of sending one.
function recordingPush(): { push: any; sent: PushPayload[] } {
  const sent: PushPayload[] = [];
  const push = async (_db: DB, payload: PushPayload) => {
    sent.push(payload);
  };
  return { push, sent };
}

const SEOUL = { start: "23:00", end: "08:00", tz: "Asia/Seoul" };
// 2026-08-25T15:00Z is 2026-08-26 00:00 in Seoul (UTC+9) — inside the window.
const NIGHT = Date.parse("2026-08-25T15:00:00Z");
// 2026-08-25T03:00Z is 12:00 in Seoul — outside it.
const DAY = Date.parse("2026-08-25T03:00:00Z");

test("defaults: away off, the four wake-me classes pass through", () => {
  const db = freshDb();
  const cfg = getAway(db);
  expect(cfg.on).toBe(false);
  expect(cfg.schedule).toBeUndefined();
  expect(cfg.always_through).toEqual(["security", "spend", "fleet_down", "second_failure"]);
  expect(desiredAway(db, NIGHT)).toBe(false);
  expect(awayNow(db)).toBe(false);
});

test("a wrapping window is inside at midnight and outside at noon", () => {
  expect(inWindow(SEOUL, NIGHT)).toBe(true);
  expect(inWindow(SEOUL, DAY)).toBe(false);
  // end is exclusive: 08:00 Seoul (= 23:00Z the previous day) is awake
  expect(inWindow(SEOUL, Date.parse("2026-08-24T23:00:00Z"))).toBe(false);
  expect(inWindow(SEOUL, Date.parse("2026-08-24T22:59:00Z"))).toBe(true);
});

test("a same-day window does not wrap", () => {
  const lunch = { start: "12:00", end: "13:00", tz: "UTC" };
  expect(inWindow(lunch, Date.parse("2026-08-25T12:30:00Z"))).toBe(true);
  expect(inWindow(lunch, Date.parse("2026-08-25T11:30:00Z"))).toBe(false);
  expect(inWindow(lunch, Date.parse("2026-08-25T23:30:00Z"))).toBe(false);
});

test("a bad timezone never holds", () => {
  expect(inWindow({ start: "23:00", end: "08:00", tz: "Not/AZone" }, NIGHT)).toBe(false);
});

test("kinds map to push classes; unknown kinds are info", () => {
  expect(classOfKind("decision")).toBe("decision");
  expect(classOfKind("review")).toBe("decision");
  expect(classOfKind("circuit_breaker")).toBe("fleet_down");
  expect(classOfKind("auth_lost")).toBe("fleet_down");
  expect(classOfKind("quiz_digest")).toBe("quiz-digest");
  expect(classOfKind("done")).toBe("info");
});

// The catch-up digest is its own class so it can be let through on its own,
// without also letting every other low-urgency push through.
test("a quiz digest is held by default but passes when allowed through", () => {
  const db = freshDb();
  setAway(db, { on: true, always_through: ["security", "spend", "fleet_down", "second_failure"] });
  const held = recordingPush();
  enqueue(db, { kind: "quiz_digest", urgency: "urgent", title: "Catch up on 3 shipped changes" }, { push: held.push });
  expect(held.sent.length).toBe(0);
  expect(heldPushes(db)[0].class).toBe("quiz-digest");

  const db2 = freshDb();
  setAway(db2, { on: true, always_through: ["quiz-digest"] });
  const through = recordingPush();
  enqueue(db2, { kind: "quiz_digest", urgency: "urgent", title: "Catch up on 3 shipped changes" }, { push: through.push });
  expect(through.sent.length).toBe(1);
  expect(heldPushes(db2).length).toBe(0);
});

test("while away, a decision push is held and a fleet_down push still goes out", () => {
  const db = freshDb();
  setAway(db, { on: true, always_through: ["security", "spend", "fleet_down", "second_failure"] });
  const { push, sent } = recordingPush();

  enqueue(db, { kind: "decision", urgency: "urgent", title: "Decision needed: pick a plan" }, { push });
  expect(sent.length).toBe(0);
  expect(heldPushes(db).length).toBe(1);
  expect(heldPushes(db)[0].class).toBe("decision");

  enqueue(db, { kind: "auth_lost", urgency: "urgent", title: "Agent authentication expired" }, { push });
  expect(sent.length).toBe(1);
  expect(sent[0].title).toBe("Agent authentication expired");
  expect(heldPushes(db).length).toBe(1);
});

test("an explicit class overrides the kind mapping", () => {
  const db = freshDb();
  setAway(db, { on: true, always_through: ["security", "spend", "fleet_down", "second_failure"] });
  const { push, sent } = recordingPush();
  // kind 'decision' would normally be held; classified as security it passes.
  enqueue(db, { kind: "decision", class: "security", urgency: "urgent", title: "Leaked token in a PR" }, { push });
  expect(sent.length).toBe(1);
  expect(heldPushes(db).length).toBe(0);
});

test("normal (non-urgent) notifications never pushed, so away mode holds nothing", () => {
  const db = freshDb();
  setAway(db, { on: true, always_through: [] });
  const { push, sent } = recordingPush();
  enqueue(db, { kind: "done", title: "Task done" }, { push });
  expect(sent.length).toBe(0);
  expect(heldPushes(db).length).toBe(0);
});

test("the schedule flips away mode on and off across a reconciler tick", () => {
  const db = freshDb();
  setAway(db, { on: false, schedule: SEOUL, always_through: [] });
  const { push, sent } = recordingPush();

  expect(syncAway(db, NIGHT, { push })).toEqual({ active: true, flushed: 0 });
  expect(getSetting(db, "away_active")).toBe("1");
  // a second tick inside the window changes nothing
  expect(syncAway(db, NIGHT, { push })).toEqual({ active: true, flushed: 0 });

  enqueue(db, { kind: "decision", urgency: "urgent", title: "a" }, { push });
  enqueue(db, { kind: "decision", urgency: "urgent", title: "b" }, { push });
  expect(sent.length).toBe(0);

  // morning: one summary push, held list cleared
  expect(syncAway(db, DAY, { push })).toEqual({ active: false, flushed: 2 });
  expect(sent.length).toBe(1);
  expect(sent[0].title).toBe("While you were away: 2 items");
  expect(sent[0].url).toBe("/inbox");
  expect(heldPushes(db).length).toBe(0);

  // waking again with nothing held sends nothing
  syncAway(db, NIGHT, { push });
  expect(syncAway(db, DAY, { push })).toEqual({ active: false, flushed: 0 });
  expect(sent.length).toBe(1);
});

test("flushing an empty held list is a no-op", () => {
  const db = freshDb();
  const { push, sent } = recordingPush();
  expect(flushHeld(db, { push })).toEqual({ count: 0, summary: "" });
  expect(sent.length).toBe(0);
});

test("one held item reads 'item', not 'items'", () => {
  const db = freshDb();
  setAway(db, { on: true, always_through: [] });
  const { push, sent } = recordingPush();
  enqueue(db, { kind: "decision", urgency: "urgent", title: "a" }, { push });
  expect(flushHeld(db, { push }).count).toBe(1);
  expect(sent[0].title).toBe("While you were away: 1 item");
});

test("GET/POST /api/away toggles, holds, and flushes on the way out", async () => {
  const db = freshDb();
  const herdr = { send: async () => ({ code: 0, stdout: "{}", stderr: "" }), run: async () => ({ code: 0, stdout: "{}", stderr: "" }) } as any;
  const { push, sent } = recordingPush();
  const server = Bun.serve({ port: 0, fetch: makeHandler(db, { herdr }) });
  const BASE = `http://127.0.0.1:${server.port}`;
  const post = (body: any): Promise<any> =>
    fetch(`${BASE}/api/away`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
  try {
    let r: any = await (await fetch(`${BASE}/api/away`)).json();
    expect(r.on).toBe(false);
    expect(r.active).toBe(false);
    expect(r.always_through).toEqual(["security", "spend", "fleet_down", "second_failure"]);

    r = await post({ on: true, schedule: SEOUL });
    expect(r.on).toBe(true);
    expect(r.active).toBe(true);
    expect(r.schedule).toEqual(SEOUL);

    enqueue(db, { kind: "decision", urgency: "urgent", title: "held one" }, { push });
    expect(sent.length).toBe(0);
    r = await (await fetch(`${BASE}/api/away`)).json();
    expect(r.held).toBe(1);

    // omitted fields keep their value: this only clears the manual switch
    r = await post({ on: false, schedule: null });
    expect(r.on).toBe(false);
    expect(r.active).toBe(false);
    expect(r.flushed).toBe(1);
    expect(r.always_through).toEqual(["security", "spend", "fleet_down", "second_failure"]);
    expect(heldPushes(db).length).toBe(0);
  } finally {
    server.stop(true);
  }
});
