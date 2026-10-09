import { expect, test } from "@playwright/test";
import { choose, signIn } from "./helpers.ts";

test("a deck end to end: brief, build, comment, apply, history, export, present", async ({ page }) => {
  await signIn(page, "alice");
  await page.getByRole("button", { name: "New deck" }).first().click();

  // pack per deck, then the brief: the agent builds the deck and the editor opens
  await choose(page, "Brand pack", "Acme Test");
  await page.getByLabel("Message").fill("Quarterly review: north led growth, deals close in four steps.");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page).toHaveURL(/\/d\/[0-9a-f-]{36}$/, { timeout: 60_000 });
  await expect(page.getByRole("heading", { name: "Quarterly review" })).toBeVisible();
  await expect(page.getByText("Lint clean")).toBeVisible();
  await expect(page.getByText("Deck ready on acme-test: 0 lint error.")).toBeVisible(); // the conversation followed the deck
  await expect(page.getByRole("navigation", { name: "Slides" }).getByRole("button")).toHaveCount(7);

  // inspector: comment on the cover title, then let the agent apply it
  await page.getByRole("button", { name: "Shape 2 (title)" }).click();
  await page.getByLabel(/Comment on slide 1, shape 2/).fill("Sales grew 12% where we invested");
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await page.getByRole("button", { name: "Apply 1 comment" }).click();
  await expect(page.getByText("acme-test · v2")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("button", { name: /Apply \d comment/ })).toHaveCount(0);
  await expect(page.getByText("Lint clean")).toBeVisible();

  // version history: back to v1, as a new version
  await page.getByRole("button", { name: "History" }).click();
  await expect(page.getByRole("dialog").getByRole("row")).toHaveCount(3);
  await page.getByRole("button", { name: "Restore v1" }).click();
  await expect(page.getByText("acme-test · v3")).toBeVisible({ timeout: 60_000 });

  // export
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export PPTX" }).click();
  expect((await download).suggestedFilename()).toBe("Quarterly review v3.pptx");

  // presenter mode
  await page.getByRole("button", { name: "Present" }).click();
  await expect(page.getByRole("img", { name: "Slide 1" })).toBeVisible();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("img", { name: "Slide 2" })).toBeVisible();
  await page.keyboard.press("p");
  await expect(page.getByRole("main", { name: "Presenter view" })).toContainText("2 / 7");
  await expect(page.getByRole("img", { name: "Next: slide 3" })).toBeVisible();
  await expect(page.getByTestId("notes")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { name: "Quarterly review" })).toBeVisible();

  // the deck list
  await page.getByRole("link", { name: "Decks" }).click();
  await expect(page.getByRole("link", { name: /Quarterly review/ })).toContainText("v3");
});
