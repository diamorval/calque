// The command palette (⌘K / Ctrl+K): jump to a page or a deck, or run an action, by typing.
// Ported from beautifului.dev's Search (MIT), on the design system's cmdk-based command.
import {
  CommandDialog,
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "diametral-ds/command";
import { Kbd } from "diametral-ds/kbd";
import { FileText, Moon, Plus, Search, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { t } from "../i18n.ts";
import { navigate, PAGES } from "../nav.ts";

interface DeckRow {
  id: string;
  title: string;
  pack_id: string;
}

const MOD =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.userAgent)
    ? "⌘"
    : "Ctrl+";

export function CommandPalette({
  theme,
  toggleTheme,
}: {
  theme: "light" | "dark";
  toggleTheme: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [decks, setDecks] = useState<DeckRow[] | null>(null);

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    addEventListener("keydown", on);
    return () => removeEventListener("keydown", on);
  }, []);

  // the decks are read on every opening, so a deck made since shows up
  useEffect(() => {
    if (!open) return;
    api<{ decks: DeckRow[] }>("/api/decks").then(
      (r) => setDecks(r.decks),
      () => setDecks([]),
    );
  }, [open]);

  const run = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };

  return (
    <>
      <button
        type="button"
        className="cq-nav cq-search"
        aria-label={t("Search")}
        title={`${t("Search")} (${MOD}K)`}
        onClick={() => setOpen(true)}
      >
        <Search />
        <Kbd aria-hidden className="cq-search-kbd">
          {MOD}K
        </Kbd>
        <span aria-hidden className="cq-search-short">
          {t("Search")}
        </span>
      </button>
      <CommandDialog
        open={open}
        onOpenChange={setOpen}
        title={t("Command palette")}
        description={t("Search for a page, a deck or an action")}
        className="shadow-none sm:max-w-lg"
      >
        <Command>
          <CommandInput
            className="focus-visible:shadow-none"
            placeholder={t("Search pages, decks, actions…")}
          />
          <CommandList className="max-h-[min(60vh,24rem)]">
            <CommandEmpty>{t("No results")}</CommandEmpty>
            <CommandGroup heading={t("Pages")}>
              {PAGES.filter((p) => p.href !== "/new").map((p) => (
                <CommandItem
                  key={p.href}
                  value={t(p.label)}
                  onSelect={run(() => navigate(p.href))}
                >
                  <p.icon /> {t(p.label)}
                </CommandItem>
              ))}
            </CommandGroup>
            {decks?.length !== 0 && (
              <CommandGroup heading={t("Decks")}>
                {decks === null ? (
                  <CommandItem disabled value="loading-decks">
                    {t("Loading")}
                  </CommandItem>
                ) : (
                  decks.map((d) => (
                    <CommandItem
                      key={d.id}
                      value={`${d.title} ${d.id}`}
                      keywords={[d.pack_id]}
                      onSelect={run(() => navigate(`/d/${d.id}`))}
                    >
                      <FileText /> <span className="truncate">{d.title}</span>
                      <span className="ms-auto shrink-0 text-xs text-muted-foreground">
                        {d.pack_id}
                      </span>
                    </CommandItem>
                  ))
                )}
              </CommandGroup>
            )}
            <CommandGroup heading={t("Actions")}>
              <CommandItem
                value={t("New deck")}
                onSelect={run(() => navigate("/new"))}
              >
                <Plus /> {t("New deck")}
              </CommandItem>
              <CommandItem
                value={t("Switch theme")}
                keywords={[t("Light theme"), t("Dark theme")]}
                onSelect={run(toggleTheme)}
              >
                {theme === "dark" ? <Sun /> : <Moon />}{" "}
                {theme === "dark" ? t("Light theme") : t("Dark theme")}
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </CommandDialog>
    </>
  );
}
