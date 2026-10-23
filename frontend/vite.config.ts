/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Vite config for the production frontend.
//
// The dev server proxies the WebSocket endpoint (/ws) and the HTTP API (/api,
// used for logo upload/serve) to the Go daemon on http://localhost:8080 so that
// `npm run dev` talks to a locally running `officed` without CORS or port
// juggling. In production the Vite build output is copied into daemon/web/dist
// and embedded into the daemon, so the UI is served from the same origin and no
// proxy is needed.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/ws": {
        target: "http://localhost:8080",
        ws: true,
        changeOrigin: true,
      },
      "/api": {
        target: "http://localhost:8080",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
