import { expect, test } from "@playwright/test";
import { choose, signIn } from "./helpers.ts";

test("a design is a document like a deck: brief, edit, comment, the agent applies it, history, share, a guest and a colleague comment", async ({ page, browser }) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await signIn(page, "alice");
  await page.getByRole("link", { name: "Designs" }).first().click();
  await page.getByRole("button", { name: "New design" }).first().click();

  // the brief: the agent (create-design workflow) makes the design and the page opens it
  await choose(page, "Brand pack", "Acme Test");
  await page.getByLabel("Message").fill("A launch post and a banner.");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page).toHaveURL(/\/designs\/[0-9a-f-]{36}$/, { timeout: 60_000 });
  const id = page.url().split("/").pop() as string;
  await expect(page.getByRole("heading", { name: "Launch campaign" })).toBeVisible();
  const post = page.getByRole("region", { name: "Artboard post" });
  await expect(post.getByRole("img", { name: "Artboard post" })).toBeVisible();

  // a text edited in place: a new version, laid out again
  await post.getByRole("button", { name: "Open headline" }).click();
  let node = page.getByRole("dialog", { name: "headline" });
  await node.getByLabel("Text").fill("Decks on brand");
  await node.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/acme-test · v2/)).toBeVisible({ timeout: 60_000 });

  // a comment on the headline, applied by the agent: a new version, the comment resolved
  await post.getByRole("button", { name: "Open headline" }).click();
  node = page.getByRole("dialog", { name: "headline" });
  await node.getByLabel("Comment").fill("Launch faster");
  await node.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(post.getByText("Launch faster")).toBeVisible();
  await page.getByRole("button", { name: "Apply 1 comment" }).click();
  await expect(page.getByText(/acme-test · v3/)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("button", { name: "Apply 1 comment" })).toHaveCount(0);

  // the version history: back to v2, as a new version
  await page.getByRole("button", { name: /History/ }).click();
  await page.getByRole("button", { name: "Restore v2" }).click();
  await expect(page.getByText(/acme-test · v4/)).toBeVisible({ timeout: 60_000 });
  await page.keyboard.press("Escape");

  // the deck's share dialog: bob as commenter, anyone with the link may comment
  await page.getByRole("button", { name: "Share", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Share" });
  await dialog.getByRole("button", { name: "Add people or teams" }).click();
  await dialog.getByLabel("User id").fill("bob");
  await dialog.getByRole("combobox", { name: "Role", exact: true }).selectOption({ label: "Commenter" });
  await dialog.getByRole("button", { name: "Add", exact: true }).click();
  await expect(dialog.getByRole("combobox", { name: "Role of bob" })).toHaveValue("commenter");
  const general = dialog.getByRole("region", { name: "General access" });
  await general.getByRole("combobox", { name: "General access" }).selectOption({ label: "Anyone with the link" });
  await general.getByRole("combobox", { name: "Link role" }).selectOption({ label: "Can comment" });
  await general.getByRole("button", { name: "Copy link" }).click();
  const link = await page.evaluate(() => navigator.clipboard.readText());
  await dialog.getByRole("button", { name: "Done" }).click();

  // an anonymous browser opens the link: the design, through its own tools, and comments
  const anonymous = await browser.newContext();
  const guest = await anonymous.newPage();
  await guest.goto(link);
  await expect(guest).toHaveURL(new RegExp(`/designs/${id}\\?k=`));
  const theirs = guest.getByRole("region", { name: "Artboard post" });
  await expect(theirs.getByRole("img", { name: "Artboard post" })).toBeVisible();
  await expect(guest.getByRole("button", { name: /History/ })).toHaveCount(0);
  await theirs.getByLabel("Comment on post").fill("Looks good from outside");
  await theirs.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(theirs.getByText("Looks good from outside")).toBeVisible();
  await anonymous.close();

  // bob finds it, reads the guest's comment and replies; he cannot edit
  await signIn(page, "bob", "/designs");
  await expect(page.getByRole("link", { name: /Launch campaign/ })).toContainText("Commenter");
  await page.goto(`/designs/${id}`);
  const his = page.getByRole("region", { name: "Artboard post" });
  await expect(his.getByText("Looks good from outside")).toBeVisible();
  await expect(page.getByRole("button", { name: "Undo" })).toHaveCount(0);
  await his.getByLabel(/Reply to/).fill("Agreed");
  await his.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(his.getByText("Agreed")).toBeVisible();
});
