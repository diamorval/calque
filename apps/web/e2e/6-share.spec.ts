import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { signIn } from "./helpers.ts";

const DECK = new URL("../../../packs/acme-test/tests/golden/basics-en.json", import.meta.url);

test("alice shares a deck with bob as viewer: he finds it in Shared with me and cannot edit it", async ({ page }) => {
  await signIn(page, "alice");
  const deck = { ...JSON.parse(readFileSync(DECK, "utf8")), title: "Board update" };
  const { deck_id: id } = await (await page.request.post("/api/tools/create_deck", { data: { deck } })).json();
  await page.goto(`/d/${id}`);
  await expect(page.getByRole("heading", { name: "Board update" })).toBeVisible();

  // share with bob as viewer
  await page.getByRole("button", { name: "Share", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Share" });
  await dialog.getByLabel("User id").fill("bob");
  await dialog.getByRole("combobox", { name: "Role", exact: true }).selectOption({ label: "Viewer" });
  await dialog.getByRole("button", { name: "Share", exact: true }).click();
  await expect(dialog.getByRole("combobox", { name: "Role of bob" })).toHaveValue("viewer");

  // a guest link: listed with copy and revoke
  const links = dialog.getByRole("region", { name: "Guest links" }).getByRole("row");
  const before = await links.count();
  await dialog.getByRole("button", { name: "Create link" }).click();
  await expect(links).toHaveCount(before + 1);
  await expect(links.first().getByRole("button", { name: /^Copy/ })).toBeVisible();
  await links.first().getByRole("button", { name: /^Revoke/ }).click();
  await expect(links).toHaveCount(before);
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
