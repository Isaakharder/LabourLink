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
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
