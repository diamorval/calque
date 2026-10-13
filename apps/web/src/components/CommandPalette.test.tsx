// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLang } from "../i18n.ts";
import { CommandPalette } from "./CommandPalette.tsx";

beforeEach(() => {
  setLang("en");
  history.replaceState(null, "", "/");
  // cmdk measures and scrolls its list; jsdom has neither
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollIntoView = () => {};
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ decks: [{ id: "d1", title: "Q3 review", pack_id: "acme-test" }] })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("command palette", () => {
  it("opens on Ctrl+K, filters as you type, and goes to the page picked", async () => {
    render(<CommandPalette theme="light" toggleTheme={vi.fn()} />);
    expect(screen.queryByRole("combobox")).toBeNull();

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const input = await screen.findByRole("combobox");
    expect(await screen.findByText("Q3 review")).toBeTruthy();

    fireEvent.change(input, { target: { value: "models" } });
    expect(screen.queryByText("Q3 review")).toBeNull();
    fireEvent.click(screen.getByText("AI models"));
    expect(location.pathname).toBe("/settings/models");
  });
});
