import { CapacitorConfig } from "@capacitor/cli";

// Bundles the built dist/ into the APK (no `server.url`) — the Android app
// ships the same compiled React app as the browser/PWA build, not a remote
// WebView pointed at a hosted site. androidScheme: "https" gives the
// WebView a stable https://localhost origin (Capacitor's modern default),
// which is what needs to be present in the API server's CORS_ORIGIN
// allow-list (see server/.env's CORS_ORIGIN and the deployment notes for
// the production Railway equivalent).
const config: CapacitorConfig = {
  appId: "com.labourlink.app",
  appName: "LabourLink",
  webDir: "dist",
  server: {
    androidScheme: "https",
  },
};

export default config;
