// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLang } from "../i18n.ts";
import { Decks } from "./Decks.tsx";

const row = (id: string, title: string, role: string, kind: string | null, updated_at: string) => ({ id, title, pack_id: "acme-test", head: 1, owner: role === "owner" ? "me" : "alice", role, kind, updated_at });
const DECKS = [
  row("d1", "Board update", "owner", "external", "2026-10-01T10:00:00Z"),
  row("d2", "Alpha plan", "owner", null, "2026-10-03T10:00:00Z"),
  row("d3", "Shared memo", "viewer", "external", "2026-10-02T10:00:00Z"),
];

beforeEach(() => {
  setLang("en");
  localStorage.clear();
  vi.stubGlobal("fetch", async (url: string) =>
    new Response(JSON.stringify(url.includes("list_packs") ? { packs: [{ id: "acme-test", name: "Acme" }] } : { decks: DECKS })),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("decks page", () => {
  it("filters by chip with live counts, and shows a sortable table remembered across visits", async () => {
    render(<Decks />);
    const chips = await screen.findByRole("group", { name: "Filter decks" });
    expect(within(chips).getByRole("button", { name: "All 3" })).toBeTruthy();
    expect(within(chips).getByRole("button", { name: "external 2" })).toBeTruthy();

    fireEvent.click(within(chips).getByRole("button", { name: "Viewer 1" }));
    expect(screen.queryByText("Board update")).toBeNull();
    expect(screen.getByText("Shared memo")).toBeTruthy();
    fireEvent.click(within(chips).getByRole("button", { name: "All 3" }));

    fireEvent.click(screen.getByRole("button", { name: "Table" }));
    expect(localStorage.getItem("cq-decks-view")).toBe("table");
    const titles = () => screen.getAllByRole("row").slice(1).map((r) => within(r).getAllByRole("cell")[0]?.textContent);
    expect(titles()).toEqual(["Alpha plan", "Shared memo", "Board update"]); // newest first
    fireEvent.click(screen.getByRole("button", { name: /Title/ }));
    expect(titles()).toEqual(["Alpha plan", "Board update", "Shared memo"]);
    expect(within(screen.getByRole("table")).getAllByText("Acme").length).toBe(3);
  });
});
