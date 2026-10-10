import { defineConfig } from "@playwright/test";

const PORT = 4319;

// One server for the whole run (fake IdP + fake model + the real server and engine), tests in order.
export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 30_000 },
  // English whatever the machine's language: the UI follows the browser's until the user picks one
  use: { baseURL: `http://localhost:${PORT}`, trace: "retain-on-failure", locale: "en-US" },
  webServer: {
    command: `node e2e/serve.ts ${PORT}`,
    url: `http://localhost:${PORT}/api/tools`,
    timeout: 120_000,
    stdout: "pipe",
  },
});
