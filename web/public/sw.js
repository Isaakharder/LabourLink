// Minimal service worker — required by Android/Chrome for "Add to Home Screen"
// installability. Intentionally does not cache anything: offline mode is out
// of scope for V1. Every request just passes straight through to the network.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
