import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { signIn } from "./helpers.ts";

const DECK = new URL("../../../packs/acme-test/tests/golden/basics-en.json", import.meta.url);

test("alice shares a deck: bob as viewer, anyone with the link may comment, then she resets the link", async ({ page, browser }) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await signIn(page, "alice");
  const deck = { ...JSON.parse(readFileSync(DECK, "utf8")), title: "Board update" };
  const { deck_id: id } = await (await page.request.post("/api/tools/create_deck", { data: { deck } })).json();
  await page.goto(`/d/${id}`);
  await expect(page.getByRole("heading", { name: "Board update" })).toBeVisible();

  // people with access: bob as viewer
  await page.getByRole("button", { name: "Share", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Share" });
  const people = dialog.getByRole("region", { name: "People with access" });
  await expect(people).toContainText("alice (you)");
  await dialog.getByRole("button", { name: "Add people or teams" }).click();
  await dialog.getByLabel("User id").fill("bob");
  await dialog.getByRole("combobox", { name: "Role", exact: true }).selectOption({ label: "Viewer" });
  await dialog.getByRole("button", { name: "Add", exact: true }).click();
  await expect(people.getByRole("combobox", { name: "Role of bob" })).toHaveValue("viewer");

  // general access: anyone with the link can comment
  const general = dialog.getByRole("region", { name: "General access" });
  await expect(general).toContainText("Only you and the people with access can open the link.");
  await general.getByRole("combobox", { name: "General access" }).selectOption({ label: "Anyone with the link" });
  await general.getByRole("combobox", { name: "Link role" }).selectOption({ label: "Can comment" });
  await expect(general.getByText("The link does not expire.")).toBeVisible();
  await expect(general).toContainText("Anyone who has the link can comment, no sign-in needed.");
  await general.getByRole("button", { name: "Copy link" }).click();
  await expect(dialog.getByRole("status")).toHaveText("Link copied.");
  const link = await page.evaluate(() => navigator.clipboard.readText());
  expect(link).toMatch(new RegExp(`/decks/${id}\\?k=`));

  // an anonymous browser opens the copied link and comments
  const anonymous = await browser.newContext();
  const guest = await anonymous.newPage();
  await guest.goto(link);
  await guest.getByRole("button", { name: "Shape 2 (title)" }).click();
  await guest.getByLabel(/Comment on slide 1, shape 2/).fill("Looks good from outside");
  await guest.getByRole("button", { name: "Comment", exact: true }).click();
  const comments = async () => (await (await page.request.post("/api/tools/list_comments", { data: { deck_id: id } })).json()).comments;
  await expect.poll(comments).toEqual([expect.objectContaining({ text: "Looks good from outside", author: "guest" })]);

  // alice resets the link: the copied one opens nothing any more
  await general.getByRole("button", { name: "Reset link" }).click();
  await expect(dialog.getByRole("status")).toContainText("Link reset");
  await general.getByRole("button", { name: "Copy link" }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).not.toBe(link);
  const stale = await anonymous.newPage();
  await stale.goto(link);
  await expect(stale.getByRole("alert")).toBeVisible();
  expect((await anonymous.request.get(link.replace(`/decks/${id}?`, `/decks/${id}/data?`))).status()).toBe(404);
  await anonymous.close();
  await dialog.getByRole("button", { name: "Done" }).click();

  // bob: in Shared with me, read only
  await signIn(page, "bob");
  const shared = page.getByRole("region", { name: "Shared with me" });
  await expect(shared.getByRole("link", { name: /Board update/ })).toContainText("Viewer · from alice");
  await shared.getByRole("link", { name: /Board update/ }).click();
  await expect(page.getByRole("heading", { name: "Board update" })).toBeVisible();
  await expect(page.getByText("Viewer", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Export PPTX" })).toBeVisible();
  for (const name of ["Add slides", "Review", "Share"]) await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Comment", exact: true })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: /Agent/ })).toHaveCount(0);
  const patch = await page.request.post("/api/tools/patch_deck", { data: { deck_id: id, ops: [{ op: "set", slide: "cover", shape_id: 2, value: "x" }] } });
  expect(patch.status()).toBe(403);
});
