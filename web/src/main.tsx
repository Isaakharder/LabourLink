import { Capacitor } from "@capacitor/core";
import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import "./index.css";

// Scopes the Android-only top-safe-area CSS (see index.css's .mobile-content/
// .message-overlay rules) so it never applies to the PWA/browser or a future
// iOS build — only the Android APK gets this class.
if (Capacitor.getPlatform() === "android") {
  document.documentElement.classList.add("platform-android");
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js");
  });
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);
