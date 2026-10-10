import { Avatar, AvatarFallback } from "diametral-ds/avatar";
import { Cpu, LayoutGrid, LogOut, Moon, Palette, Plus, Sun, type LucideIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { api, ApiError, NEUTRAL, type Branding, type Me } from "./api.ts";
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
        <Spinner label="Loading" />
      </div>
    );
  const present = path.match(/^\/present\/([^/]+)/)?.[1];
  if (present) return <Presenter id={present} />;

  const name = me.name ?? me.id;
  return (
    <div className="cq-app">
      <nav className="cq-side" aria-label="Main">
        <a className="cq-logo" href="/" aria-label={`${brand.name} home`} title={brand.name} onClick={(e) => go(e, "/")}>
          <Logo brand={brand} />
        </a>
        <NavItem href="/" label="Decks" short="Decks" icon={LayoutGrid} active={path === "/" || path.startsWith("/d/")} />
        <NavItem href="/new" label="New deck" short="New" icon={Plus} active={path === "/new"} />
        <span className="cq-side-gap" />
        <NavItem href="/settings/models" label="AI models" short="Models" icon={Cpu} active={path === "/settings/models"} />
        <NavItem href="/settings/packs" label="Brand packs" short="Packs" icon={Palette} active={path.startsWith("/settings/packs") || path === "/settings/compliance"} />
        <span className="cq-side-rule" />
        <button type="button" className="cq-nav" aria-label={theme === "dark" ? "Light theme" : "Dark theme"} title="Switch theme" onClick={toggleTheme}>
          {theme === "dark" ? <Sun /> : <Moon />}
        </button>
        <Avatar className="cq-avatar" aria-label={`Signed in as ${name}`} title={name}>
          <AvatarFallback>{name.slice(0, 2).toUpperCase()}</AvatarFallback>
        </Avatar>
        {me.auth && (
          <button type="button" className="cq-nav" aria-label="Sign out" title="Sign out" onClick={() => location.assign("/auth/logout")}>
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
