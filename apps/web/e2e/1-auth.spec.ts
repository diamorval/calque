import { expect, test } from "@playwright/test";
import { signIn } from "./helpers.ts";

test("without a session the app and its API refuse access; SSO signs in", async ({ page }) => {
  await page.goto("/settings/packs");
  await expect(page.getByText("Sign in to Calque")).toBeVisible();
  expect((await page.request.get("/api/decks")).status()).toBe(401);
  expect((await page.request.post("/api/tools/list_packs", { data: {} })).status()).toBe(401);
  expect((await page.request.post("/api/agent/chat", { data: { messages: [{ role: "user", content: "hi" }] } })).status()).toBe(401);

  await signIn(page, "alice", "/settings/packs");
  await expect(page).toHaveURL(/\/settings\/packs$/);
  await expect(page.getByRole("heading", { name: "Brand packs" })).toBeVisible();
  expect((await page.request.get("/api/decks")).status()).toBe(200);

  // the UI in French, picked in the sidebar and kept across reloads (the run itself is in English)
  await page.getByRole("button", { name: "Language: English" }).click();
  await expect(page.getByRole("heading", { name: "Packs de marque" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "fr");
  await page.reload();
  await expect(page.getByRole("heading", { name: "Packs de marque" })).toBeVisible();
  await page.getByRole("button", { name: /^Langue/ }).click();
  await expect(page.getByRole("heading", { name: "Brand packs" })).toBeVisible();

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByText("Sign in to Calque")).toBeVisible();
  expect((await page.request.get("/api/decks")).status()).toBe(401);
});
