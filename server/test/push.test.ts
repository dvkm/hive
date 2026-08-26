// Web-push subscription storage + VAPID key persistence.
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "hive-push-"));
process.env.HIVE_HOME = HOME;

const { openDb, setSetting } = await import("../src/db.ts");
const { decisionAnswerTokenOk, vapidPublicKey, saveSubscription, removeSubscription, pushToAll } = await import("../src/push.ts");

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

test("a decision push carries its actions and a decision-scoped answer token", async () => {
  const db = openDb(":memory:");
  setSetting(db, "api_token", "phone-secret");
  saveSubscription(db, SUB);
  let sent = "";

  await pushToAll(
    db,
    {
      title: "Ship it?",
      url: "/decisions#dcard-dec_1",
      decisionId: "dec_1",
      actions: [{ action: "approve", title: "Approve" }],
    },
    async (_subscription, payload) => {
      sent = payload as string;
      return {} as any;
    }
  );

  const payload = JSON.parse(sent);
  expect(payload).toEqual({
    title: "Ship it?",
    body: "",
    url: "/decisions#dcard-dec_1",
    decisionId: "dec_1",
    actions: [{ action: "approve", title: "Approve" }],
    answerToken: expect.any(String),
  });
  expect(payload.answerToken).not.toBe("phone-secret");
  expect(decisionAnswerTokenOk(db, "dec_1", payload.answerToken)).toBe(true);
  expect(decisionAnswerTokenOk(db, "dec_2", payload.answerToken)).toBe(false);
});

test("the /api/push routes serve the key, subscribe, and unsubscribe", async () => {
  const { makeHandler } = await import("../src/api.ts");
  const db = openDb(":memory:");
  setSetting(db, "api_token", "phone-secret");
  const handle = makeHandler(db, {});
  const vapid = await (await handle(new Request("http://x/api/push/vapid"))).json() as any;
  expect(vapid.key).toBeTruthy();
  const unauthenticated = await handle(
    new Request("http://x/api/push/subscribe", { method: "POST", body: JSON.stringify(SUB) })
  );
  expect(unauthenticated.status).toBe(401);
  const sub = await handle(
    new Request("http://x/api/push/subscribe", {
      method: "POST",
      headers: { authorization: "Bearer phone-secret" },
      body: JSON.stringify(SUB),
    })
  );
  expect((await sub.json() as any).ok).toBe(true);
  expect(db.query("SELECT * FROM push_subscriptions").all()).toHaveLength(1);
  await handle(new Request("http://x/api/push/unsubscribe", { method: "POST", body: JSON.stringify({ endpoint: SUB.endpoint }) }));
  expect(db.query("SELECT * FROM push_subscriptions").all()).toHaveLength(0);
});
