import { ConsoleLayout, Spinner, type ConsoleNavGroup } from "@diametral/design-system/react";
import { useEffect, useState } from "react";
import { api, ApiError, type Me } from "./api.ts";
import { navigate, usePath } from "./nav.ts";
import { Decks } from "./pages/Decks.tsx";
import { Editor } from "./pages/Editor.tsx";
import { Login } from "./pages/Login.tsx";
import { Models } from "./pages/Models.tsx";
import { NewDeck } from "./pages/NewDeck.tsx";
import { Packs } from "./pages/Packs.tsx";
import { Presenter } from "./pages/Presenter.tsx";

const ROUTES: Record<string, string> = { decks: "/", models: "/settings/models", packs: "/settings/packs" };
const NAV: ConsoleNavGroup[] = [
  { items: [{ id: "decks", label: "Decks" }] },
  { group: "Settings", items: [{ id: "models", label: "AI models" }, { id: "packs", label: "Brand packs" }] },
];

function page(path: string, me: Me) {
  const deck = path.match(/^\/d\/([^/]+)/)?.[1];
  if (deck) return <Editor id={deck} />;
  if (path === "/new") return <NewDeck />;
  if (path === "/settings/models") return <Models me={me} />;
  if (path === "/settings/packs") return <Packs me={me} />;
  return <Decks />;
}

export function App() {
  const path = usePath();
  const [me, setMe] = useState<Me | null | "signed-out">(null);
  useEffect(() => {
    api<Me>("/api/me").then(setMe, (e) => setMe(e instanceof ApiError && e.status === 401 ? "signed-out" : null));
  }, []);

  if (me === "signed-out") return <Login />;
  if (!me) return <Spinner label="Loading" />;
  const present = path.match(/^\/present\/([^/]+)/)?.[1];
  if (present) return <Presenter id={present} />;

  const active = Object.entries(ROUTES).find(([, p]) => p !== "/" && path.startsWith(p))?.[0] ?? "decks";
  return (
    <ConsoleLayout
      brand={{ name: "Calque", sub: "Slides" }}
      nav={NAV}
      active={active}
      onNavigate={(id) => navigate(ROUTES[id] ?? "/")}
      search={false}
      themes
      user={{
        initials: (me.name ?? me.id).slice(0, 2).toUpperCase(),
        name: me.name ?? me.id,
        ...(me.auth ? { onSignOut: () => location.assign("/auth/logout") } : {}),
      }}
    >
      {page(path, me)}
    </ConsoleLayout>
  );
}
