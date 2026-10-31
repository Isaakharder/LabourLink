/// <reference types="vitest" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri serves the built files from dist/; in development the window points
// at the Vite dev server on 5174 (5173 is the LabourLink web app).
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 5174, strictPort: true },
  build: { target: "es2021", outDir: "dist", sourcemap: false },
  test: { environment: "jsdom" },
});
