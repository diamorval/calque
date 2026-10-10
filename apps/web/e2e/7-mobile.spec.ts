import { expect, test, type Locator, type Page } from "@playwright/test";
import { choose, signIn } from "./helpers.ts";

// A phone (iPhone 15 width): the app as an app, a tab bar at the bottom, the editor one view at a time.
test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

/** Nothing wider than the screen: no sideways scrolling. */
async function fits(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

/** Where an element is on screen. */
async function rect(el: Locator) {
  const box = await el.boundingBox();
  if (!box) throw new Error("not on screen");
  return box;
}

/** A one-finger swipe across an element, from right to left (dx < 0) or the other way. */
async function swipe(page: Page, selector: string, dx: number) {
  const el = page.locator(selector);
  const box = await rect(el);
  const at = (x: number) => [{ identifier: 0, clientX: x, clientY: box.y + box.height / 2 }];
  const x = box.x + box.width / 2 - dx / 2;
  await el.dispatchEvent("touchstart", { touches: at(x), changedTouches: at(x) });
  await el.dispatchEvent("touchend", { touches: [], changedTouches: at(x + dx) });
}

test("on a phone: tab bar, account menu, the editor (actions, Slides | Agent, swipe, sideways), present by touch", async ({ page, request }) => {
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

  // a swipe on the slide turns it
  await swipe(page, ".cq-stage-view", -120);
  await expect(page.locator(".cq-pos")).toHaveText("2 / 7");
  await swipe(page, ".cq-stage-view", 120);
  await expect(page.locator(".cq-pos")).toHaveText("1 / 7");

  // turned sideways: the slide and the comment box side by side, nothing over the other
  await page.setViewportSize({ width: 844, height: 390 });
  await fits(page);
  const slide = await rect(page.locator(".cq-canvas"));
  const box = await rect(page.getByLabel("Comment on slide 1"));
  expect(slide.x + slide.width).toBeLessThanOrEqual(box.x);
  expect(slide.y + slide.height).toBeLessThanOrEqual(390);
  await page.setViewportSize({ width: 390, height: 844 });

  // present: a tap on the right goes forward, on the left back, the button exits
  const deck = page.url();
  await page.getByRole("button", { name: "Present" }).click(); // the actions are still unfolded
  await expect(page.getByRole("img", { name: "Slide 1" })).toBeVisible();
  await page.mouse.click(350, 422);
  await expect(page.getByRole("img", { name: "Slide 2" })).toBeVisible();
  await page.mouse.click(40, 422);
  await expect(page.getByRole("img", { name: "Slide 1" })).toBeVisible();
  await page.getByRole("button", { name: "Exit" }).click();
  await expect(page).toHaveURL(deck);

  await page.getByRole("link", { name: "Decks" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(tabs).toBeVisible();
});
