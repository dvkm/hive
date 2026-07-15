// Web push for the mobile PWA: urgent notifications reach the phone even when
// hive isn't open. VAPID keypair is minted once and stored in settings; the
// public key is handed to the browser to subscribe, the private key signs the
// push. Payloads are the notification title/body (web-push does the ECDH+GCM
// encryption). A subscription that 404/410s is dead (app uninstalled / permission
// revoked) and is pruned. Best-effort: a push failure never touches the
// server-side notification row.
import webpush from "web-push";
import type { DB } from "./db.ts";
import { getSetting, setSetting, now } from "./db.ts";

let configured = false;

function ensureVapid(db: DB): { publicKey: string } | null {
  let pub = getSetting(db, "vapid_public_key");
  let priv = getSetting(db, "vapid_private_key");
  if (!pub || !priv) {
    const keys = webpush.generateVAPIDKeys();
    setSetting(db, "vapid_public_key", keys.publicKey);
    setSetting(db, "vapid_private_key", keys.privateKey);
    pub = keys.publicKey;
    priv = keys.privateKey;
  }
  if (!configured) {
    // The `mailto:` subject is a VAPID requirement (push services use it to
    // contact the sender about abuse); the address is not otherwise used.
    webpush.setVapidDetails("mailto:hive@localhost", pub, priv);
    configured = true;
  }
  return { publicKey: pub };
}

export function vapidPublicKey(db: DB): string | null {
  return ensureVapid(db)?.publicKey ?? null;
}

export interface PushSub {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export function saveSubscription(db: DB, sub: PushSub): void {
  if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) throw new Error("invalid subscription");
  db.query(
    `INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at) VALUES (?,?,?,?)
     ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth`
  ).run(sub.endpoint, sub.keys.p256dh, sub.keys.auth, now());
}

export function removeSubscription(db: DB, endpoint: string): void {
  db.query("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint);
}

// Fan a notification out to every subscribed device. Dead subscriptions
// (404/410) are pruned. Fire-and-forget from the notification path.
export async function pushToAll(db: DB, payload: { title: string; body?: string | null; url?: string }): Promise<void> {
  if (!ensureVapid(db)) return;
  const subs = db.query("SELECT endpoint, p256dh, auth FROM push_subscriptions").all() as {
    endpoint: string;
    p256dh: string;
    auth: string;
  }[];
  if (!subs.length) return;
  const body = JSON.stringify({ title: payload.title, body: payload.body ?? "", url: payload.url ?? "/" });
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, {
          TTL: 600,
        });
        db.query("UPDATE push_subscriptions SET last_ok = ? WHERE endpoint = ?").run(now(), s.endpoint);
      } catch (e: any) {
        if (e?.statusCode === 404 || e?.statusCode === 410) removeSubscription(db, s.endpoint);
      }
    })
  );
}
