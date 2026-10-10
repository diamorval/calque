import { Avatar, AvatarFallback } from "diametral-ds/avatar";
import { Cpu, Languages, LayoutGrid, LogOut, Moon, Palette, Plus, Sun, type LucideIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { api, ApiError, NEUTRAL, type Branding, type Me } from "./api.ts";
import { LANGS, setLang, t, useLang } from "./i18n.ts";
import { go, usePath } from "./nav.ts";
import { Decks } from "./pages/Decks.tsx";
import { Editor } from "./pages/Editor.tsx";
import { Login } from "./pages/Login.tsx";
import { Models } from "./pages/Models.tsx";
import { NewDeck } from "./pages/NewDeck.tsx";
import { Packs } from "./pages/Packs.tsx";
import { PackPortal } from "./pages/PackPortal.tsx";
import { Compliance } from "./pages/Compliance.tsx";
import { Presenter } from "./pages/Presenter.tsx";
import { Logo, Spinner } from "./ui.tsx";

function page(path: string, me: Me) {
  const deck = path.match(/^\/d\/([^/]+)/)?.[1];
  if (deck) return <Editor id={deck} />;
  if (path === "/new") return <NewDeck />;
  if (path === "/settings/models") return <Models me={me} />;
  if (path === "/settings/packs") return <Packs me={me} />;
  const pack = path.match(/^\/settings\/packs\/([^/]+)$/)?.[1];
  if (pack) return <PackPortal id={decodeURIComponent(pack)} />;
  if (path === "/settings/compliance") return <Compliance />;
  return <Decks />;
}

function NavItem(props: { href: string; label: string; short: string; icon: LucideIcon; active: boolean }) {
  const Icon = props.icon;
  return (
    <a className="cq-nav" href={props.href} aria-label={props.label} title={props.label} aria-current={props.active ? "page" : undefined} onClick={(e) => go(e, props.href)}>
      <Icon />
      <span aria-hidden>{props.short}</span>
    </a>
  );
}

type Theme = "light" | "dark";
const THEME_KEY = "cq-theme";
function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const saved = localStorage.getItem(THEME_KEY);
      if (saved === "light" || saved === "dark") return saved;
    } catch {
      // storage blocked: follow the system
    }
    return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.classList.toggle("dark", theme === "dark"); // the design system's dark theme
  }, [theme]);
  const toggle = () =>
    setTheme((t) => {
      const next = t === "dark" ? "light" : "dark";
      try {
        localStorage.setItem(THEME_KEY, next);
      } catch {
        // the choice lasts for this page only
      }
      return next;
    });
  return [theme, toggle];
}

export function App() {
  const path = usePath();
  const lang = useLang(); // a switch re-renders every page in the new language
  const [theme, toggleTheme] = useTheme();
  const [me, setMe] = useState<Me | null | "signed-out">(null);
  const [brand, setBrand] = useState<Branding>(NEUTRAL);
  useEffect(() => {
    api<Me>("/api/me").then(setMe, (e) => setMe(e instanceof ApiError && e.status === 401 ? "signed-out" : null));
    // the deployment's name and logo (white-label); the neutral one if it cannot be read
    api<Branding>("/api/branding").then(setBrand, () => setBrand(NEUTRAL));
  }, []);
  useEffect(() => {
    document.title = brand.name;
  }, [brand.name]);

  if (me === "signed-out") return <Login brand={brand} />;
  if (!me)
    return (
      <div className="cq-center">
        <Spinner label={t("Loading")} />
      </div>
    );
  const present = path.match(/^\/present\/([^/]+)/)?.[1];
  if (present) return <Presenter id={present} />;

  const name = me.name ?? me.id;
  return (
    <div className="cq-app">
      <nav className="cq-side" aria-label={t("Main")}>
        <a className="cq-logo" href="/" aria-label={t("{name} home", { name: brand.name })} title={brand.name} onClick={(e) => go(e, "/")}>
          <Logo brand={brand} />
        </a>
        <NavItem href="/" label={t("Decks")} short={t("Decks (short)")} icon={LayoutGrid} active={path === "/" || path.startsWith("/d/")} />
        <NavItem href="/new" label={t("New deck")} short={t("New (short)")} icon={Plus} active={path === "/new"} />
        <span className="cq-side-gap" />
        <NavItem href="/settings/models" label={t("AI models")} short={t("Models (short)")} icon={Cpu} active={path === "/settings/models"} />
        <NavItem href="/settings/packs" label={t("Brand packs")} short={t("Packs (short)")} icon={Palette} active={path.startsWith("/settings/packs") || path === "/settings/compliance"} />
        <span className="cq-side-rule" />
        <button type="button" className="cq-nav" aria-label={theme === "dark" ? t("Light theme") : t("Dark theme")} title={t("Switch theme")} onClick={toggleTheme}>
          {theme === "dark" ? <Sun /> : <Moon />}
        </button>
        <button
          type="button"
          className="cq-nav"
          aria-label={t("Language: {name}", { name: LANGS[lang] })}
          title={t("Switch to {name}", { name: LANGS[lang === "fr" ? "en" : "fr"] })}
          onClick={() => setLang(lang === "fr" ? "en" : "fr")}
        >
          <Languages />
          <span aria-hidden>{lang.toUpperCase()}</span>
        </button>
        <Avatar className="cq-avatar" aria-label={t("Signed in as {name}", { name })} title={name}>
          <AvatarFallback>{name.slice(0, 2).toUpperCase()}</AvatarFallback>
        </Avatar>
        {me.auth && (
          <button type="button" className="cq-nav" aria-label={t("Sign out")} title={t("Sign out")} onClick={() => location.assign("/auth/logout")}>
            <LogOut />
          </button>
        )}
      </nav>
      <main className="cq-main" data-full={path.startsWith("/d/") || undefined}>
        {page(path, me)}
      </main>
    </div>
  );
}
