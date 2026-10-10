import { defineConfig } from "vitest/config";

export default defineConfig({
  // hooks set up decks through the engine: give them the time a busy CI runner needs;
  // CALQUE_TEST_PACKS: the server seeds the acme-test pack the tests build on
  test: {
    include: ["{apps,packages,tests}/**/*.test.{ts,tsx}"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    hookTimeout: 60_000,
    env: { CALQUE_TEST_PACKS: "1" },
  },
});
