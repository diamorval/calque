import { expect, type Page } from "@playwright/test";

export const MODEL_URL = "http://127.0.0.1:4320/v1"; // the fake model started by serve.ts

export async function signIn(page: Page, user: "alice" | "bob", path = "/") {
  await page.context().clearCookies();
  await page.goto(path);
  await page.getByRole("button", { name: "Sign in with SSO" }).click();
  await page.getByRole("link", { name: `Sign in as ${user}` }).click();
  await expect(page.getByRole("button", { name: "Sign out" })).toHaveText(user === "alice" ? "AL" : "BO");
}

/** Pick an option in a design-system Select (base-ui: a combobox and a listbox). */
export async function choose(page: Page, label: string | RegExp, option: string) {
  await page.getByRole("combobox", { name: label }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}
