// Minimal service worker — required by Android/Chrome for "Add to Home Screen"
// installability. Intentionally does not cache anything: offline mode is out
// of scope for V1. Every request just passes straight through to the network.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});

// Web Push — installed PWA / browser (including iPhone Home Screen PWA
// where Apple supports it). The payload is deliberately generic (title +
// body only, see server/src/lib/pushDelivery.ts) — it is a delivery alert
// only, never the message content itself; the real content always comes
// from GET /api/mobile/messages/outstanding once the app is open (see
// MessagesContext.tsx), the same source of truth every other entry point
// (app start, resume, Android push) uses.
self.addEventListener("push", (event) => {
  let payload = { title: "LabourLink", body: "You have a new message." };
  try {
    if (event.data) payload = { ...payload, ...event.data.json() };
  } catch {
    // Non-JSON or empty payload — fall back to the generic text above
    // rather than failing the whole push event.
  }
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      tag: "labourlink-message",
    })
  );
});

// Tapping the notification focuses an already-open LabourLink tab/window if
// one exists, or opens a new one at /mobile/home otherwise — it never
// navigates based on anything in the push payload. Once focused, the app's
// own visibilitychange-driven refresh (MessagesContext.tsx) fetches
// outstanding messages and shows the blocking overlay, exactly as it would
// on any other resume.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client) return client.focus();
      }
      return self.clients.openWindow("/mobile/home");
    })
  );
});
