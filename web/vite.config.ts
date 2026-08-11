import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Vitest reads its own `test` block straight out of this file (no separate
// vitest.config.ts) so there's one source of truth for how modules resolve
// — same aliasing/extensionless-import behavior tests see as the real app
// gets built with. Only pure-logic modules are unit tested today (no DOM),
// so the default "node" environment is enough; add jsdom only if a test
// ever needs to render a component.
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
    include: ["src/**/*.test.ts"],
  },
});
