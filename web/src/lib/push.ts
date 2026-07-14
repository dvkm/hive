// PWA install + web-push subscription. Registers the service worker always;
// subscribes to push only after the user opts in (enablePush), because iOS only
// grants Notification permission from a user gesture on an installed PWA.
import { api } from "./api";

const BASE = import.meta.env.VITE_HIVE_URL || "";

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;
  try {
    return await navigator.serviceWorker.register("/sw.js");
  } catch {
    return null;
  }
}

// True once the browser can do push AND the user has already granted it — so the
// UI can show "notifications on" vs an "enable" button.
export function pushState(): "unsupported" | "default" | "granted" | "denied" {
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return "unsupported";
  return Notification.permission as "default" | "granted" | "denied";
}

function urlBase64ToUint8Array(b64: string): Uint8Array {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const base64 = (b64 + pad).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

// Ask permission, subscribe with the server's VAPID key, register the sub.
// Returns a human-readable outcome for a toast.
export async function enablePush(): Promise<string> {
  if (pushState() === "unsupported") return "This browser can't do push notifications.";
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return "Notifications not allowed.";
  const reg = (await navigator.serviceWorker.ready) || (await registerServiceWorker());
  if (!reg) return "Service worker unavailable.";
  const { key } = await fetch(BASE + "/api/push/vapid", { headers: authHeader() }).then((r) => r.json());
  if (!key) return "Server has no push key.";
  const existing = await reg.pushManager.getSubscription();
  const sub =
    existing ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(key).buffer as ArrayBuffer,
    }));
  await api.subscribePush(sub.toJSON());
  return "Notifications enabled on this device.";
}

function authHeader(): Record<string, string> {
  const t = api.token?.();
  return t ? { Authorization: `Bearer ${t}` } : {};
}
