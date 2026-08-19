import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Vitest reads its own `test` block straight out of this file (no separate
// vitest.config.ts) so there's one source of truth for how modules resolve
// — same aliasing/extensionless-import behavior tests see as the real app
// gets built with. Most tests are pure-logic (no DOM), so the default
// "node" environment stays the default; a .test.tsx file that actually
// renders a component (first used by InputsPage's employee-switching
// tests) opts into jsdom itself via a `// @vitest-environment jsdom`
// pragma at the top of that one file, rather than paying jsdom's setup
// cost for every other test.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Bind all interfaces (not just localhost) so a phone on the same Wi-Fi
    // can reach this dev server via the host machine's LAN IP. Vite prints
    // the actual LAN address(es) on startup — no IP is hardcoded here.
    host: true,
  },
  optimizeDeps: {
    // jeep-sqlite (the browser/PWA backend behind @capacitor-community/
    // sqlite — see web/src/lib/sqlite/bootstrap.ts) ships a hand-built
    // Emscripten/wasm glue module (sql.js). Vite's default esbuild-based
    // dependency pre-bundling rewrites that glue in a way that breaks its
    // expected WebAssembly imports — confirmed by reproducing a genuine
    // `LinkError: WebAssembly.instantiate(): ... function import requires a
    // callable` with these excluded from optimizeDeps. Excluding lets Vite
    // serve them as-is; a known, documented category of issue for
    // Emscripten-generated wasm packages under Vite's dev-time optimizer,
    // not specific to this one plugin.
    exclude: ["jeep-sqlite", "sql.js", "@capacitor-community/sqlite"],
  },
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
