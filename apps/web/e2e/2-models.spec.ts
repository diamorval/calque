import { expect, test, type Page } from "@playwright/test";
import { choose, MODEL_URL, signIn } from "./helpers.ts";

async function configure(page: Page, provider: string, model: string, key: string) {
  await page.getByRole("tab", { name: "Providers" }).click();
  await page.getByRole("button", { name: `Configure ${provider}` }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Model" }).fill(model);
  await dialog.getByLabel(/API key/).fill(key);
  await dialog.getByLabel(/Base URL/).fill(MODEL_URL);
  await dialog.getByRole("button", { name: "Test and save" }).click();
}

async function ping(page: Page) {
  await page.goto("/new");
  await choose(page, "Brand pack", "Acme Test");
  await page.getByLabel("Message").fill("ping");
  await page.getByRole("button", { name: "Send" }).click();
}

test("configures two providers, refuses a bad key, and switches the default without a restart", async ({ page }) => {
  await signIn(page, "alice", "/settings/models");
  await expect(page.getByRole("row", { name: /gateway-e2e/ })).toContainText("Default");

  await configure(page, "Ollama", "llama-e2e", "bad-key");
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("Incorrect API key");
  await page.getByRole("dialog").getByLabel(/API key/).fill("good-key");
  await page.getByRole("dialog").getByRole("button", { name: "Test and save" }).click();
  await expect(page.getByRole("row", { name: /llama-e2e/ })).toBeVisible();

  await configure(page, "OpenAI-compatible endpoint", "compat-e2e", "good-key");
  await expect(page.getByRole("row", { name: /compat-e2e/ })).toBeVisible();

  await page.getByRole("row", { name: /llama-e2e/ }).getByRole("button", { name: "Set as default" }).click();
  await expect(page.getByRole("row", { name: /llama-e2e/ })).toContainText("Default");
  await ping(page);
  await expect(page.getByText("pong from llama-e2e")).toBeVisible();
  await expect(page.getByText("Model: ollama:llama-e2e")).toBeVisible();

  await page.goto("/settings/models");
  await page.getByRole("row", { name: /compat-e2e/ }).getByRole("button", { name: "Set as default" }).click();
  await expect(page.getByRole("row", { name: /compat-e2e/ })).toContainText("Default");
  await ping(page);
  await expect(page.getByText("pong from compat-e2e")).toBeVisible();

  // back to the gateway for the next specs
  await page.goto("/settings/models");
  await page.getByRole("row", { name: /gateway-e2e/ }).getByRole("button", { name: "Set as default" }).click();
  await expect(page.getByRole("row", { name: /gateway-e2e/ })).toContainText("Default");
});

test("a non-admin cannot change the models", async ({ page }) => {
  await signIn(page, "bob", "/settings/models");
  await expect(page.getByText("Only workspace admins change the models.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Set as default" })).toHaveCount(0);
  expect((await page.request.post("/api/models", { data: { provider: "ollama", model: "x" }, headers: { origin: new URL(page.url()).origin } })).status()).toBe(403);
});
