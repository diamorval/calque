import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { choose, signIn } from "./helpers.ts";

// an existing deck to import: the acme-test template, its sample copy still in place
const DECK = fileURLToPath(new URL("../../../packs/acme-test/template.pptx", import.meta.url));

test("imports a PPTX on a pack, opens it in the editor and reviews it", async ({ page }) => {
  await signIn(page, "alice");
  await page.getByRole("button", { name: "Import PPTX" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Import a PPTX" });
  await dialog.getByLabel("PPTX file").setInputFiles(DECK);
  await choose(page, "Brand pack", "Acme Test");
  await expect(dialog.getByLabel("Language")).toHaveValue("en"); // the pack's default language
  await dialog.getByRole("button", { name: "Import", exact: true }).click();

  await expect(page).toHaveURL(/\/d\/[0-9a-f-]{36}$/, { timeout: 60_000 });
  await expect(page.getByText("acme-test · v1")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Slides" }).getByRole("button")).toHaveCount(4);

  // review: the template's sample copy is left, a judgment call (no safe fix on placeholders)
  await page.getByRole("button", { name: "Review", exact: true }).click();
  const review = page.getByRole("dialog", { name: "Review" });
  await expect(review.getByRole("region", { name: "Judgment calls" })).toContainText("template placeholder left", { timeout: 60_000 });
  await expect(review.getByRole("button", { name: /Apply \d+ safe fix/ })).toHaveCount(0);
  await review.getByRole("button", { name: "Close" }).first().click();

  // the deck list has it
  await page.getByRole("link", { name: "Decks" }).click();
  await expect(page.getByRole("link", { name: /Presentation title/ })).toContainText("acme-test · v1");
});

test("adds slides to a deck through the agent", async ({ page }) => {
  await signIn(page, "alice", "/new");
  await choose(page, "Brand pack", "Acme Test");
  await page.getByLabel("Message").fill("Quarterly review, to add slides to.");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page).toHaveURL(/\/d\/[0-9a-f-]{36}$/, { timeout: 60_000 });
  await expect(page.getByRole("navigation", { name: "Slides" }).getByRole("button")).toHaveCount(7);

  await page.getByRole("button", { name: "Add slides", exact: true }).click();
  await page.getByLabel("What should the new slides say?").fill("Growth by region: the north led.");
  await page.getByRole("button", { name: "Ask the agent" }).click();
  await expect(page.getByText("Added 1 slide before the closing slide.")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("acme-test · v2")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("navigation", { name: "Slides" }).getByRole("button")).toHaveCount(8);
});
