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

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByText("Sign in to Calque")).toBeVisible();
  expect((await page.request.get("/api/decks")).status()).toBe(401);
});
