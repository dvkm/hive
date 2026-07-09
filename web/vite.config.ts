import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In dev, proxy /api, /evidence, /api/stream to the hive daemon so the app can
// use same-origin paths in both dev and the production (server-served) build.
const target = process.env.VITE_HIVE_URL || "http://127.0.0.1:4700";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": { target, changeOrigin: true },
      "/evidence": { target, changeOrigin: true },
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
