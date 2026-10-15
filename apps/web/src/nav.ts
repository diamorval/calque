import { Cpu, LayoutGrid, Palette, Plus, Shapes, type LucideIcon } from "lucide-react";
import { useEffect, useState, type MouseEvent } from "react";
import type { Key } from "./i18n/fr.ts";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, ""); // "" unless served under a sub-path (the demo)
const here = () => location.pathname.slice(BASE.length) || "/";

// A handful of routes: history.pushState is enough, no router.
export function navigate(path: string) {
  history.pushState(null, "", BASE + path);
  dispatchEvent(new PopStateEvent("popstate"));
}

export function usePath(): string {
  const [path, setPath] = useState(here);
  useEffect(() => {
    const on = () => setPath(here());
    addEventListener("popstate", on);
    return () => removeEventListener("popstate", on);
  }, []);
  return path;
}

/** An in-app link's click: pushState for a plain click, the browser's way for a new tab. */
export function go(e: MouseEvent, href: string) {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  navigate(href);
}

/** The app's pages, as the sidebar (a tab bar on a phone) and the command palette list them. */
export const PAGES = [
  { href: "/", label: "Decks", short: "Decks (short)", icon: LayoutGrid, active: (p: string) => p === "/" || p.startsWith("/d/") },
  { href: "/new", label: "New deck", short: "New (short)", icon: Plus, active: (p: string) => p === "/new" },
  { href: "/designs", label: "Designs", short: "Designs (short)", icon: Shapes, active: (p: string) => p.startsWith("/designs") },
  { href: "/settings/models", label: "AI models", short: "Models (short)", icon: Cpu, active: (p: string) => p === "/settings/models" },
  { href: "/settings/packs", label: "Brand packs", short: "Packs (short)", icon: Palette, active: (p: string) => p.startsWith("/settings/packs") || p === "/settings/compliance" },
] as const satisfies readonly { href: string; label: Key; short: Key; icon: LucideIcon; active: (path: string) => boolean }[];
