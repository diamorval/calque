import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { choose, signIn } from "./helpers.ts";

// a template no pack is built on yet: the acme-test file, imported as a new company
const TEMPLATE = fileURLToPath(new URL("../../../packs/acme-test/template.pptx", import.meta.url));

test("imports an unknown template, assigns roles, builds a clean deck; another team does not see it", async ({ page }) => {
  await signIn(page, "alice", "/settings/packs");
  await page.getByRole("button", { name: "Import a template" }).click();
  await page.getByLabel("Pack id").fill("newco");
  await page.getByLabel("Name").fill("NewCo");
  await page.getByLabel("Template file").setInputFiles(TEMPLATE);
  await page.getByRole("button", { name: "Read the template" }).click();

  // review: one card per template slide, its rendered image and a drafted role
  await expect(page.getByRole("img", { name: "Template slide 4" })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("combobox", { name: "Role of slide 1" })).toHaveValue("cover");
  await expect(page.getByRole("combobox", { name: "Role of slide 4" })).toHaveValue("closing");
  // assign roles: without a content slide the pack does not validate
  await choose(page, "Role of slide 3", "No role");
  await page.getByRole("button", { name: "Validate and publish" }).click();
  await expect(page.getByRole("alert")).toContainText("content");
  await choose(page, "Role of slide 3", "content");
  await choose(page, "Role of slide 2", "divider");
  await page.getByLabel("Voice").fill("# Voice\n\nShort sentences. No jargon.");
  await expect(page.getByRole("radio", { name: /These teams/ })).toBeChecked(); // restricted by default
  await page.getByRole("button", { name: "Validate and publish" }).click();

  await expect(page.getByRole("row", { name: /NewCo/ })).toContainText("sales, calque-admins", { timeout: 60_000 });

  // its charter, read-only: voice and template slides
  await page.getByRole("link", { name: "NewCo" }).click();
  await expect(page.getByRole("heading", { name: "Voice" })).toBeVisible();
  await expect(page.getByText("Short sentences. No jargon.")).toBeVisible();
  await expect(page.getByRole("img", { name: "Template slide 1" })).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "Brand packs" }).click();
  // restricted to one of her teams only
  await page.getByRole("row", { name: /NewCo/ }).getByRole("button", { name: "Teams" }).click();
  await page.getByRole("checkbox", { name: "calque-admins" }).uncheck();
  await page.getByRole("button", { name: "Restrict to sales" }).click();
  await expect(page.getByRole("row", { name: /NewCo/ })).toContainText("sales");
  await expect(page.getByRole("row", { name: /NewCo/ })).not.toContainText("calque-admins");

  // a deck on the new pack, lint clean
  await page.goto("/new");
  await choose(page, "Brand pack", "NewCo");
  await page.getByLabel("Message").fill("Quarterly review on the NewCo template.");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page).toHaveURL(/\/d\//, { timeout: 60_000 });
  await expect(page.getByText("newco · v1")).toBeVisible();
  await expect(page.getByText("Lint clean")).toBeVisible();

  // Bob is in ops: the pack does not exist for him
  await signIn(page, "bob", "/settings/packs");
  await expect(page.getByRole("row", { name: /Acme Test/ })).toBeVisible();
  await expect(page.getByRole("row", { name: /NewCo/ })).toHaveCount(0);
  await page.goto("/new");
  const packs = page.getByRole("combobox", { name: "Brand pack" });
  await expect(packs.getByRole("option", { name: "Acme Test" })).toHaveCount(1);
  await expect(packs.getByRole("option", { name: "NewCo" })).toHaveCount(0);
});
