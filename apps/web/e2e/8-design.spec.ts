import { expect, test } from "@playwright/test";
import { choose, signIn } from "./helpers.ts";

test("a design end to end: brief, edit a text, comment, share, the colleague comments back", async ({ page }) => {
  await signIn(page, "alice");
  await page.getByRole("link", { name: "Designs" }).first().click();
  await page.getByRole("button", { name: "New design" }).click();

  // the brief: the agent (create-design workflow) makes the design and the page opens it
  await choose(page, "Brand pack", "Acme Test");
  await page.getByLabel("Message").fill("A launch post and a banner.");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page).toHaveURL(/\/designs\/[0-9a-f-]{36}$/, { timeout: 60_000 });
  await expect(page.getByRole("heading", { name: "Launch campaign" })).toBeVisible();
  const post = page.getByRole("region", { name: "Artboard post" });
  await expect(post.getByRole("img", { name: "Artboard post" })).toBeVisible();

  // a text edited in place: a new version, laid out again
  await post.getByRole("button", { name: "Open headline" }).click();
  const node = page.getByRole("dialog", { name: "headline" });
  await node.getByLabel("Text").fill("Decks on brand");
  await node.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/acme-test · v2/)).toBeVisible({ timeout: 60_000 });

  // a comment on the artboard, then bob as commenter
  await post.getByLabel("Comment on post").fill("Try a shorter subline");
  await post.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(post.getByText("Try a shorter subline")).toBeVisible();
  await page.getByRole("button", { name: "Share", exact: true }).click();
  const share = page.getByRole("dialog", { name: "Share design" });
  await share.getByLabel("User id").fill("bob");
  await share.getByRole("combobox", { name: "Role" }).selectOption({ label: "Commenter" });
  await share.getByRole("button", { name: "Add", exact: true }).click();
  await expect(share.getByText("bob")).toBeVisible();
  const url = page.url();

  // bob finds it, reads alice's comment and replies; he cannot edit
  await signIn(page, "bob", "/designs");
  await expect(page.getByRole("link", { name: /Launch campaign/ })).toContainText("Commenter");
  await page.goto(url);
  const his = page.getByRole("region", { name: "Artboard post" });
  await expect(his.getByText("Try a shorter subline")).toBeVisible();
  await expect(page.getByRole("button", { name: "Undo" })).toHaveCount(0);
  await his.getByLabel(/Reply to/).fill("Agreed");
  await his.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(his.getByText("Agreed")).toBeVisible();
});
