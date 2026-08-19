import { Capacitor } from "@capacitor/core";
import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { getLocalEventStore } from "./lib/localEventStore";
import { initSyncLifecycleTriggers } from "./lib/syncEngine";
import "./index.css";

// Kicked off here, not awaited — React still renders immediately (same
// "never block first paint" convention as everything else in this file).
// Every real caller (WorkSessionContext) awaits getLocalEventStore()'s own
// internal init promise, which is already warm by the time anyone needs it
// for anything past the very first cold app launch.
void getLocalEventStore()
  .init()
  .catch((err) => console.error("[local-event-store] init failed:", err));

// Native-only (no-ops immediately on browser/PWA) — wires @capacitor/network
// and @capacitor/app listeners so a background sync attempt starts the
// moment connectivity returns or the app is foregrounded again, on top of
// the browser 'online'/visibilitychange triggers WorkSessionContext already
// has. See syncEngine.ts's own comment for the honest caveat about Android
// background-execution limits this does NOT get around.
void initSyncLifecycleTriggers().catch((err) => console.error("[sync-engine] lifecycle trigger init failed:", err));

// Available for any Android-specific styling that isn't safe to apply
// everywhere (unlike the top-safe-area padding in index.css's
// .mobile-content/.message-overlay rules, which now applies unconditionally
// since env(safe-area-inset-top) is already a no-op anywhere it doesn't
// apply).
if (Capacitor.getPlatform() === "android") {
  document.documentElement.classList.add("platform-android");
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js");
  });
}

// Logged with a fresh random tag per page load — the cheapest possible
// signal for "did this page/WebView actually load and run main.tsx more
// than once," which a device-identity duplication bug would otherwise be
// very hard to distinguish from a single page load calling something twice.
console.log(`[device-identity] main.tsx executing, load=${Math.random().toString(36).slice(2, 8)}`);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);
