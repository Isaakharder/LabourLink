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
  appId: "com.linklogictechnologies.labourlink",
  appName: "LabourLink",
  webDir: "dist",
  server: {
    androidScheme: "https",
    // NOT overridden to "https" the way androidScheme is above — confirmed
    // by reading @capacitor/ios's own CAPInstanceDescriptor.swift
    // (node_modules/@capacitor/ios/Capacitor/Capacitor/CAPInstanceDescriptor
    // .swift): it only accepts a custom server.iosScheme when
    // `WKWebView.handlesURLScheme(scheme) == false`. "https" is a scheme
    // WKWebView natively handles, so that check always fails for it and the
    // native layer silently falls back to Capacitor's built-in default,
    // "capacitor" (i.e. the real WKWebView origin is always
    // capacitor://localhost, never https://localhost). An earlier version
    // of this config set iosScheme: "https" on the (reasonable-looking, but
    // wrong) assumption that it worked the same way androidScheme does —
    // confirmed dead on a real physical iPhone: Xcode showed the live
    // WebView origin as capacitor://localhost regardless. The fix is on the
    // server side instead — capacitor://localhost is allow-listed directly
    // in CORS_ORIGIN (see server/.env.example) — not here.
  },
  plugins: {
    CapacitorSQLite: {
      // iOS only (Android reads its own android* keys and is unaffected).
      // The plugin's default location is Documents, which iCloud backs up;
      // a custom Library location is created with isExcludedFromBackup set,
      // so the offline event queue can't be restored onto another phone —
      // same rule as Android's allowBackup="false". See AppDelegate.swift
      // for the matching WebView-storage exclusion.
      iosDatabaseLocation: "Library/CapacitorDatabase",
      // Database encryption stays off. The iOS export-compliance declaration
      // (ITSAppUsesNonExemptEncryption = false in ios/App/App/Info.plist)
      // depends on it — guarded by src/lib/exportCompliance.test.ts.
      iosIsEncryption: false,
    },
  },
  ...(isQaBuild ? { android: { allowMixedContent: true } } : {}),
};

export default config;
