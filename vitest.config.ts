import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["{apps,packages,tests}/**/*.test.{ts,tsx}"], exclude: ["**/node_modules/**", "**/dist/**"] },
});
