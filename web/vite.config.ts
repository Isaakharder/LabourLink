import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Bind all interfaces (not just localhost) so a phone on the same Wi-Fi
    // can reach this dev server via the host machine's LAN IP. Vite prints
    // the actual LAN address(es) on startup — no IP is hardcoded here.
    host: true,
  },
});
