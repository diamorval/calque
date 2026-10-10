import { defineConfig } from "vitest/config";

export default defineConfig({
  // hooks set up decks through the engine: give them the time a busy CI runner needs
  test: { include: ["{apps,packages,tests}/**/*.test.{ts,tsx}"], exclude: ["**/node_modules/**", "**/dist/**"], hookTimeout: 60_000 },
});
