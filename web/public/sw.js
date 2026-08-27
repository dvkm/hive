// hive service worker: makes the PWA installable and delivers web-push
// notifications when the app is closed. No offline caching (hive is useless
// without the live server anyway) — a passthrough fetch handler is here only so
// the browser treats this as a real, installable SW.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});

self.addEventListener("push", (event) => {
  let data = { title: "hive", body: "", url: "/" };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch {
    /* non-JSON payload: keep defaults */
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: "/icon-512.png",
      badge: "/icon-512.png",
      actions: data.actions || [],
      data: { url: data.url, decisionId: data.decisionId, answerToken: data.answerToken },
      tag: data.url, // collapse repeats for the same target
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  event.waitUntil(answerOrOpen(event.action, data));
});

async function answerOrOpen(answerKey, data) {
  if (answerKey && data.decisionId && data.answerToken) {
    try {
      const response = await fetch(`/api/decisions/${encodeURIComponent(data.decisionId)}/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${data.answerToken}` },
        body: JSON.stringify({ answer_key: answerKey, source: "director", actor: "web-push" }),
      });
      if (response.ok) return;
    } catch {
      /* fall through to the decision card */
    }
  }

  return openUrl(data.url || "/");
}

async function openUrl(url) {
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of clients) {
    if ("focus" in client) {
      await client.navigate(url);
      return client.focus();
    }
  }
  return self.clients.openWindow(url);
}
