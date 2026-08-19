import { CapacitorConfig } from "@capacitor/cli";

// Bundles the built dist/ into the APK (no `server.url`) — the Android app
// ships the same compiled React app as the browser/PWA build, not a remote
// WebView pointed at a hosted site. androidScheme: "https" gives the
// WebView a stable https://localhost origin (Capacitor's modern default),
// which is what needs to be present in the API server's CORS_ORIGIN
// allow-list (see server/.env's CORS_ORIGIN and the deployment notes for
// the production Railway equivalent).
//
// That same https://localhost origin means the WebView enforces standard
// browser Mixed Content blocking against any plain-http fetch() the app
// makes — this is a WebView/Chromium-engine policy, entirely separate from
// (and not affected by) Android's OS-level network_security_config.xml
// cleartextTrafficPermitted setting, which only governs native networking
// calls, never the page's own JS fetch()/XHR (confirmed by reproduction:
// the debug-only network_security_config.xml override alone did NOT stop
// Mixed Content from blocking a plain-http request to the local dev
// server). android.allowMixedContent is the actual, documented Capacitor
// setting for this — explicitly "not intended for use in production" per
// its own doc comment, so it's only ever turned on here when
// LABOURLINK_QA_BUILD=true, set exclusively by the QA-only npm scripts
// (build:android-qa/-emulator's `cap:sync:qa*`, package.json) — never by
// build:android/cap:sync, the real production APK's own pipeline.
const isQaBuild = process.env.LABOURLINK_QA_BUILD === "true";

const config: CapacitorConfig = {
  appId: "com.labourlink.app",
  appName: "LabourLink",
  webDir: "dist",
  server: {
    androidScheme: "https",
  },
  ...(isQaBuild ? { android: { allowMixedContent: true } } : {}),
};

export default config;
