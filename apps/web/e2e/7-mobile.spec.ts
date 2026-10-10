import { expect, test, type Page } from "@playwright/test";
import { choose, signIn } from "./helpers.ts";

// A phone (iPhone 15 width): the app as an app, a tab bar at the bottom, the editor one view at a time.
test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

/** Nothing wider than the screen: no sideways scrolling. */
async function fits(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
}

test("on a phone: tab bar, account menu, the editor's actions and Slides | Agent switch", async ({ page, request }) => {
  const manifest = await request.get("/manifest.webmanifest");
  expect(manifest.headers()["content-type"]).toBe("application/manifest+json");
  expect((await manifest.json()).display).toBe("standalone");

  await signIn(page, "alice");
  const tabs = page.getByRole("navigation", { name: "Main" });
  await expect(tabs.getByRole("link", { name: "Decks" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeHidden();
  await page.getByRole("button", { name: "Account" }).click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  await fits(page);

  await tabs.getByRole("link", { name: "New deck" }).click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeHidden(); // the menu closes on a page change
  await choose(page, "Brand pack", "Acme Test");
  await page.getByLabel("Message").fill("Quarterly review: north led growth, deals close in four steps.");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page).toHaveURL(/\/d\/[0-9a-f-]{36}$/, { timeout: 60_000 });

  // the editor: full screen, its actions folded, the slide first
  await expect(page.getByRole("heading", { name: "Quarterly review" })).toBeVisible();
  await expect(tabs).toBeHidden();
  await expect(page.getByRole("button", { name: "Export PPTX" })).toBeHidden();
  await fits(page);
  await page.getByRole("button", { name: "More actions" }).click();
  await expect(page.getByRole("button", { name: "Export PPTX" })).toBeVisible();
  await fits(page);

  await expect(page.getByRole("img", { name: "Slide 1" }).first()).toBeVisible();
  await page.getByRole("button", { name: "Agent", exact: true }).click();
  await expect(page.getByText("Deck ready on acme-test: 0 lint error.")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Slides" })).toBeHidden();
  await page.getByRole("button", { name: "Slides", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Slides" })).toBeVisible();

  await page.getByRole("link", { name: "Decks" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(tabs).toBeVisible();
});
