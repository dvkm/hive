// Web-push subscription storage + VAPID key persistence.
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "hive-push-"));
process.env.HIVE_HOME = HOME;

const { openDb } = await import("../src/db.ts");
const { vapidPublicKey, saveSubscription, removeSubscription } = await import("../src/push.ts");

const SUB = {
  endpoint: "https://push.example.com/abc",
  keys: { p256dh: "BPabc123", auth: "authtoken" },
};

test("VAPID key is minted once and stable across calls", () => {
  const db = openDb(":memory:");
  const k1 = vapidPublicKey(db);
  const k2 = vapidPublicKey(db);
  expect(k1).toBeTruthy();
  expect(k1).toBe(k2);
  expect(db.query("SELECT value FROM settings WHERE key='vapid_private_key'").get()).toBeTruthy();
});

test("subscriptions upsert by endpoint and delete", () => {
  const db = openDb(":memory:");
  saveSubscription(db, SUB);
  saveSubscription(db, { ...SUB, keys: { p256dh: "BPnew", auth: "auth2" } }); // same endpoint
  const rows = db.query("SELECT * FROM push_subscriptions").all() as any[];
  expect(rows).toHaveLength(1);
  expect(rows[0].p256dh).toBe("BPnew");
  removeSubscription(db, SUB.endpoint);
  expect(db.query("SELECT * FROM push_subscriptions").all()).toHaveLength(0);
});

test("a malformed subscription is rejected", () => {
  const db = openDb(":memory:");
  expect(() => saveSubscription(db, { endpoint: "", keys: { p256dh: "", auth: "" } })).toThrow();
});

test("the /api/push routes serve the key, subscribe, and unsubscribe", async () => {
  const { makeHandler } = await import("../src/api.ts");
  const db = openDb(":memory:");
  const handle = makeHandler(db, {});
  const vapid = await (await handle(new Request("http://x/api/push/vapid"))).json();
  expect(vapid.key).toBeTruthy();
  const sub = await handle(
    new Request("http://x/api/push/subscribe", { method: "POST", body: JSON.stringify(SUB) })
  );
  expect((await sub.json()).ok).toBe(true);
  expect(db.query("SELECT * FROM push_subscriptions").all()).toHaveLength(1);
  await handle(new Request("http://x/api/push/unsubscribe", { method: "POST", body: JSON.stringify({ endpoint: SUB.endpoint }) }));
  expect(db.query("SELECT * FROM push_subscriptions").all()).toHaveLength(0);
});
