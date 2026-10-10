// @vitest-environment jsdom
import { DeckViewer, type DeckView } from "@calque/slide-ui";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.tsx";
import { ago, dateTime, getLang, setLang, slideUiStrings, t, tn } from "./i18n.ts";

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

/** The server, for the decks page: one deck edited 3 minutes ago. */
function fakeServer() {
  const routes: Record<string, unknown> = {
    "/api/me": { id: "alice", name: "Alice", teams: [], admin: false, auth: true },
    "/api/branding": { name: "Calque", logo: null },
    "/api/decks": { decks: [{ id: "d1", title: "Q3 review", pack_id: "acme-test", head: 2, updated_at: minutesAgo(3), owner: "alice", role: "owner" }] },
    "/api/tools/list_packs": { packs: [] },
  };
  vi.stubGlobal("fetch", async (path: string) => new Response(JSON.stringify(routes[path] ?? {}), { status: path in routes ? 200 : 404 }));
}

beforeEach(() => {
  localStorage.clear();
  setLang("en");
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("i18n", () => {
  it("defaults to the browser language, French only when it says fr", async () => {
    for (const [language, want] of [
      ["fr-CA", "fr"],
      ["de-DE", "en"],
      ["en-US", "en"],
    ]) {
      localStorage.clear();
      vi.spyOn(navigator, "language", "get").mockReturnValue(language as string);
      vi.resetModules();
      const fresh = await import("./i18n.ts");
      expect(fresh.getLang()).toBe(want);
      expect(document.documentElement.lang).toBe(want);
    }
  });

  it("keeps the user's choice over the browser's", async () => {
    setLang("fr");
    expect(localStorage.getItem("cq-lang")).toBe("fr");
    vi.spyOn(navigator, "language", "get").mockReturnValue("en-US");
    vi.resetModules();
    expect((await import("./i18n.ts")).getLang()).toBe("fr");
  });

  it("fills, pluralises and spaces French the French way", () => {
    expect(t("Delete {title}?", { title: "Q3" })).toBe("Delete Q3?");
    setLang("fr");
    expect(t("Delete {title}?", { title: "Q3" })).toBe("Supprimer Q3 ?");
    expect(t("Lint: {summary}", { summary: "Conforme" })).toBe("Contrôle : Conforme");
    // French singular covers 0 and 1, English plural covers 0
    expect(tn(0, "{n} error", "{n} errors")).toBe("0 erreur");
    expect(tn(2, "{n} error", "{n} errors")).toBe("2 erreurs");
    setLang("en");
    expect(tn(0, "{n} error", "{n} errors")).toBe("0 errors");
  });

  it("formats dates in the UI language, never the browser's", () => {
    vi.spyOn(navigator, "language", "get").mockReturnValue("de-DE");
    expect(ago(minutesAgo(4))).toBe("4 minutes ago");
    setLang("fr");
    expect(ago(minutesAgo(4))).toBe("il y a 4 minutes");
    expect(ago(new Date(Date.now() - 86_400_000).toISOString())).toBe("hier");
    expect(dateTime("2026-10-05T14:30:00Z")).toMatch(/oct\. 2026/);
  });

  it("gives the deck UI its words", () => {
    setLang("fr");
    const deck: DeckView = {
      deck_id: "d1",
      title: "Q3",
      pack_id: "acme-test",
      version: 1,
      head: 1,
      preview_url: "",
      slides: [{ id: "s1", number: 1, image_url: "/1.png", width_px: 1280, height_px: 720, shapes: [] }],
      open_comments: [],
      approval: { enabled: true, status: "in_review", can_request: false, can_withdraw: false, can_approve: false },
    };
    render(<DeckViewer deck={deck} strings={slideUiStrings()} onComment={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Diapositive précédente" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /Commentaires/ })).toBeTruthy();
    expect(screen.getByText("Aucun commentaire ouvert")).toBeTruthy();
    expect(screen.getByText("En relecture")).toBeTruthy();
    expect(screen.getByLabelText("Commenter la diapositive 1")).toBeTruthy();
  });

  it("switches the whole app to French from the sidebar, dates included", async () => {
    fakeServer();
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Decks" })).toBeTruthy();
    expect(await screen.findByText(/3 minutes ago/)).toBeTruthy();
    expect(document.documentElement.lang).toBe("en");

    fireEvent.click(screen.getByRole("button", { name: "Language: English" }));
    expect(await screen.findByRole("heading", { name: "Présentations" })).toBeTruthy();
    expect(screen.getByText(/il y a 3 minutes/)).toBeTruthy();
    expect(screen.queryByText(/minutes ago/)).toBeNull();
    expect(screen.getByRole("link", { name: "Nouvelle présentation" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Supprimer Q3 review" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Langue : Français" })).toBeTruthy();
    expect(document.documentElement.lang).toBe("fr");
    expect(getLang()).toBe("fr");
    expect(localStorage.getItem("cq-lang")).toBe("fr");
  });
});
