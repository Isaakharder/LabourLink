import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

// The one LabourLink production API host the "android" (Play release) mode
// is ever allowed to ship pointed at. Not a secret — the same value already
// lives in web/.env.android, which is committed to source control.
const PRODUCTION_ANDROID_API_URL = "https://server-production-a4fb.up.railway.app";

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

// Vitest reads its own `test` block straight out of this file (no separate
// vitest.config.ts) so there's one source of truth for how modules resolve
// — same aliasing/extensionless-import behavior tests see as the real app
// gets built with. Most tests are pure-logic (no DOM), so the default
// "node" environment stays the default; a .test.tsx file that actually
// renders a component (first used by InputsPage's employee-switching
// tests) opts into jsdom itself via a `// @vitest-environment jsdom`
// pragma at the top of that one file, rather than paying jsdom's setup
// cost for every other test.
export default defineConfig(({ mode }) => {
  // "VITE_" prefix matches Vite's own default client-exposure filter — this
  // reads exactly the values `import.meta.env` will see in the built code,
  // from the same .env.<mode> file Vite itself loads for this mode.
  const env = loadEnv(mode, process.cwd(), "VITE_");
  assertProductionAndroidApiUrl(mode, env);

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
