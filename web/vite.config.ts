import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Proxies API calls to the Express backend during local dev (see
// scripts/dev-web.ts at the repo root). The browser only ever talks to this
// dev server's own origin — Vite relays requests/responses (including
// Set-Cookie for the web session cookie) to/from the backend server-side, so
// no CORS configuration is needed for local dev at all. In production, the
// same is true for a different reason: the backend serves this app's own
// build output directly (see src/api/server.ts), so there is only ever one
// origin in play, dev or prod.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": { target: "http://localhost:3000", changeOrigin: true },
      "/oauth": { target: "http://localhost:3000", changeOrigin: true },
    },
  },
});
