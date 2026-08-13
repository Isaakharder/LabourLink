import { Capacitor } from "@capacitor/core";
import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import "./index.css";

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
