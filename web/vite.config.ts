import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

// The one LabourLink production API host the "android" (Play release) mode
// is ever allowed to ship pointed at. Not a secret — the same value already
// lives in web/.env.android, which is committed to source control.
const PRODUCTION_ANDROID_API_URL = "https://server-production-a4fb.up.railway.app";

// Same contract as PRODUCTION_ANDROID_API_URL above, for the "ios" mode —
// currently the same host (one shared production API serves both native
// apps), kept as its own constant (not a reused reference) so the two
// platforms can diverge in the future without one guard silently drifting
// off the other's intent. Value lives in web/.env.ios, also committed.
const PRODUCTION_IOS_API_URL = "https://server-production-a4fb.up.railway.app";

// Release-build guard: `vite build --mode android` (web/package.json's
// build:android — the only path that feeds android:aab/cap:sync, i.e. the
// only path that produces what actually ships to Play) must never succeed
// with a missing, local, or wrong API target. Added after versionCode 11
// shipped built via the generic `npm run build` instead of `build:android`
// — VITE_API_URL was never loaded, the app silently fell back to its own
// local WebView origin ("API URL: https://localhost" in Settings > Sync
// Details on the device), and it could never reach the real server at all.
// This throws — failing the build hard, not a warning a release script
// could scroll past — specifically for the "android" mode. The
// android-qa/android-qa-emulator/android-qa-phone modes intentionally point
// at a LAN IP, 10.0.2.2, or localhost:4000 for local QA testing and are
// deliberately NOT covered by this check.
function assertProductionAndroidApiUrl(mode: string, env: Record<string, string>): void {
  if (mode !== "android") return;
  const url = env.VITE_API_URL;
  if (!url) {
    throw new Error(
      "[release-guard] VITE_API_URL is missing for the 'android' production build. Build with " +
        "`npm run build:android` (or `npm run android:aab` / `npm run cap:sync`, which both run it) — " +
        "never the generic `npm run build` — so web/.env.android is actually loaded."
    );
  }
  if (/localhost|127\.0\.0\.1|10\.0\.2\.2/i.test(url)) {
    throw new Error(
      `[release-guard] VITE_API_URL ("${url}") is a local/emulator address, not the production API. ` +
        "This is the 'android' (Play release) mode — local addresses belong only in " +
        "web/.env.android-qa*, never web/.env.android."
    );
  }
  if (!url.startsWith("https://")) {
    throw new Error(`[release-guard] VITE_API_URL ("${url}") must be an https:// URL for the production Android build.`);
  }
  if (url !== PRODUCTION_ANDROID_API_URL) {
    throw new Error(
      `[release-guard] VITE_API_URL ("${url}") does not match the configured LabourLink production API ` +
        `("${PRODUCTION_ANDROID_API_URL}"). If the production API host genuinely changed, update ` +
        "PRODUCTION_ANDROID_API_URL in vite.config.ts deliberately, in the same change as web/.env.android."
    );
  }
}

// Mirror of assertProductionAndroidApiUrl above, for `vite build --mode ios`
// (web/package.json's build:ios — the only path that feeds cap:sync:ios,
// i.e. the only path that produces what would ship to TestFlight/App
// Store). Deliberately its own function rather than a shared helper
// parameterized by mode/constant: keeping the android and ios guards
// textually independent means an edit to one (e.g. loosening a check)
// can never silently also loosen the other.
function assertProductionIosApiUrl(mode: string, env: Record<string, string>): void {
  if (mode !== "ios") return;
  const url = env.VITE_API_URL;
  if (!url) {
    throw new Error(
      "[release-guard] VITE_API_URL is missing for the 'ios' production build. Build with " +
        "`npm run build:ios` (or `npm run cap:sync:ios`, which runs it) — never the generic " +
        "`npm run build` — so web/.env.ios is actually loaded."
    );
  }
  if (/localhost|127\.0\.0\.1/i.test(url)) {
    throw new Error(
      `[release-guard] VITE_API_URL ("${url}") is a local address, not the production API. ` +
        "This is the 'ios' (App Store/TestFlight release) mode — local addresses have no equivalent " +
        "iOS QA env file yet and must never end up in web/.env.ios."
    );
  }
  if (!url.startsWith("https://")) {
    throw new Error(`[release-guard] VITE_API_URL ("${url}") must be an https:// URL for the production iOS build.`);
  }
  if (url !== PRODUCTION_IOS_API_URL) {
    throw new Error(
      `[release-guard] VITE_API_URL ("${url}") does not match the configured LabourLink production API ` +
        `("${PRODUCTION_IOS_API_URL}"). If the production API host genuinely changed, update ` +
        "PRODUCTION_IOS_API_URL in vite.config.ts deliberately, in the same change as web/.env.ios."
    );
  }
}

// Mirror of the guard above for the *other* direction: the plain browser
// build (`npm run build` — what web/railway.json's buildCommand actually
// runs for the deployed web app) must NEVER have VITE_API_URL set. Vite
// inlines it at build time, so setting it — e.g. by copying the Android
// service's env vars onto the web Railway service, or by following an
// out-of-date deployment note — silently makes every browser request
// cross-site again (see resolveApiUrl() in src/lib/api.ts), which is
// exactly what web/serve-static.js's same-origin proxy exists to prevent.
// Safari's Intelligent Tracking Prevention then silently drops the session
// cookie on that cross-site request while Chrome, which doesn't block it by
// default, keeps working — a real production incident this reproduces
// exactly, and one a missing/wrong env var should fail loudly for instead
// of only surfacing as "auth is broken, but only in Safari."
function assertNoBrowserApiUrlOverride(command: string, mode: string, env: Record<string, string>): void {
  if (command !== "build" || mode !== "production") return;
  if (env.VITE_API_URL) {
    throw new Error(
      `[same-origin-guard] VITE_API_URL ("${env.VITE_API_URL}") is set for the browser production build. ` +
        "Leave it unset here — the deployed web app must stay same-origin with the API " +
        "(see resolveApiUrl() in src/lib/api.ts) and reach it through web/serve-static.js's proxy " +
        "instead, configured via the runtime API_URL env var on the web Railway service. " +
        "VITE_API_URL belongs only in the native build env files (web/.env.android*, web/.env.ios), never here."
    );
  }
}

// Vitest reads its own `test` block straight out of this file (no separate
// vitest.config.ts) so there's one source of truth for how modules resolve
// — same aliasing/extensionless-import behavior tests see as the real app
// gets built with. Most tests are pure-logic (no DOM), so the default
// "node" environment stays the default; a .test.tsx file that actually
// renders a component (first used by InputsPage's employee-switching
// tests) opts into jsdom itself via a `// @vitest-environment jsdom`
// pragma at the top of that one file, rather than paying jsdom's setup
// cost for every other test.
export default defineConfig(({ command, mode }) => {
  // "VITE_" prefix matches Vite's own default client-exposure filter — this
  // reads exactly the values `import.meta.env` will see in the built code,
  // from the same .env.<mode> file Vite itself loads for this mode.
  const env = loadEnv(mode, process.cwd(), "VITE_");
  assertProductionAndroidApiUrl(mode, env);
  assertProductionIosApiUrl(mode, env);
  assertNoBrowserApiUrlOverride(command, mode, env);

  return {
    plugins: [react()],
    server: {
      port: 5173,
      // Bind all interfaces (not just localhost) so a phone on the same
      // Wi-Fi can reach this dev server via the host machine's LAN IP. Vite
      // prints the actual LAN address(es) on startup — no IP is hardcoded
      // here.
      host: true,
    },
    optimizeDeps: {
      // jeep-sqlite (the browser/PWA backend behind @capacitor-community/
      // sqlite — see web/src/lib/sqlite/bootstrap.ts) ships a hand-built
      // Emscripten/wasm glue module (sql.js). Vite's default esbuild-based
      // dependency pre-bundling rewrites that glue in a way that breaks its
      // expected WebAssembly imports — confirmed by reproducing a genuine
      // `LinkError: WebAssembly.instantiate(): ... function import requires
      // a callable` with these excluded from optimizeDeps. Excluding lets
      // Vite serve them as-is; a known, documented category of issue for
      // Emscripten-generated wasm packages under Vite's dev-time optimizer,
      // not specific to this one plugin.
      exclude: ["jeep-sqlite", "sql.js", "@capacitor-community/sqlite"],
    },
    test: {
      include: ["src/**/*.test.{ts,tsx}"],
    },
  };
});
