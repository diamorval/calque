import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In dev the API, sign-in and slide images come from the server (node apps/server/src/main.ts).
const server = process.env.CALQUE_SERVER ?? "http://localhost:8787";

export default defineConfig({
  plugins: [react()],
  server: { proxy: Object.fromEntries(["/api", "/auth", "/decks"].map((p) => [p, server])) },
});
