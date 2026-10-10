import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In dev the API, sign-in and slide images come from the server (node apps/server/src/main.ts).
const server = process.env.CALQUE_SERVER ?? "http://localhost:8787";

export default defineConfig({
  plugins: [react()],
  // the GitHub Pages demo (VITE_DEMO=1) serves the responses saved by demo/snapshot.ts
  publicDir: process.env.VITE_DEMO ? "demo/out" : "public",
  // the server refuses cookie writes from another origin (CSRF): the proxy presents the server's own
  server: { proxy: Object.fromEntries(["/api", "/auth", "/decks"].map((p) => [p, { target: server, headers: { origin: server } }])) },
});
