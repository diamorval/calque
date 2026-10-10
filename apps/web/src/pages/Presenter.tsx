import type { DeckView } from "@calque/slide-ui";
import { Button } from "diametral-ds/button";
import { Kbd } from "diametral-ds/kbd";
import { Tag } from "diametral-ds/tag";
import { Clock, X } from "lucide-react";
import { useEffect, useState, type MouseEvent } from "react";
import { tool } from "../api.ts";
import { t } from "../i18n.ts";
import { navigate } from "../nav.ts";
import { Spinner } from "../ui.tsx";

type Deck = DeckView & { spec: { slides: { id: string; notes?: string }[] } };

const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

/** Full-screen slides. → / Space next, ← previous, P presenter view (next slide, notes, timer),
F full screen, Esc back to the editor. By touch or click: the slide's left third goes back, the rest
forward, and a button goes back to the editor. */
export function Presenter({ id }: { id: string }) {
  const [deck, setDeck] = useState<Deck | null>(null);
  const [i, setI] = useState(0);
  const [presenter, setPresenter] = useState(false);
  const [started] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    tool<Deck>("open_deck", { deck_id: id }).then(setDeck);
  }, [id]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    const last = (deck?.slides.length ?? 1) - 1;
    const on = (e: KeyboardEvent) => {
      if (["ArrowRight", " ", "PageDown"].includes(e.key)) setI((n) => Math.min(n + 1, last));
      else if (["ArrowLeft", "PageUp"].includes(e.key)) setI((n) => Math.max(n - 1, 0));
      else if (e.key === "p" || e.key === "P") setPresenter((p) => !p);
      else if (e.key === "f" || e.key === "F") void document.documentElement.requestFullscreen?.();
      else if (e.key === "Escape") navigate(`/d/${id}`);
      else return;
      e.preventDefault();
    };
    addEventListener("keydown", on);
    return () => removeEventListener("keydown", on);
  }, [deck, id]);

  if (!deck)
    return (
      <div className="cq-center">
        <Spinner label={t("Loading deck")} />
      </div>
    );
  const slide = deck.slides[i];
  const next = deck.slides[i + 1];
  if (!slide) return null;
  const notes = deck.spec.slides.find((s) => s.id === slide.id)?.notes;
  const current = <img className="cq-present-slide" src={slide.image_url} alt={t("Slide {n}", { n: slide.number })} />;
  const tap = (e: MouseEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const step = e.clientX - r.left < r.width / 3 ? -1 : 1;
    setI((n) => Math.max(0, Math.min(n + step, deck.slides.length - 1)));
  };

  if (!presenter)
    return (
      <main className="cq-present" onClick={tap}>
        {current}
        <button
          type="button"
          className="cq-present-exit"
          aria-label={t("Exit")}
          onClick={(e) => {
            e.stopPropagation();
            navigate(`/d/${id}`);
          }}
        >
          <X />
        </button>
      </main>
    );
  return (
    <main className="cq-presenter dark" aria-label={t("Presenter view")}>
      <header>
        <strong className="cq-mono">
          {i + 1} / {deck.slides.length}
        </strong>
        <Tag tone="neutral" className="cq-mono">
          <Clock /> <span aria-label={t("Elapsed")}>{clock(Math.floor((now - started) / 1000))}</span>
        </Tag>
        <span className="cq-hint">
          <Kbd>←</Kbd> <Kbd>→</Kbd> {t("navigate")} · <Kbd>P</Kbd> {t("audience view")} · <Kbd>F</Kbd> {t("full screen")}
        </span>
        <Button variant="ghost" size="sm" onClick={() => navigate(`/d/${id}`)}>
          <X /> {t("Exit")}
        </Button>
      </header>
      <div className="cq-presenter-now" onClick={tap}>
        {current}
      </div>
      <aside>
        <h2>{t("Next")}</h2>
        {next ? <img src={next.image_url} alt={t("Next: slide {n}", { n: next.number })} /> : <p className="cq-hint">{t("End of deck")}</p>}
        <h2>{t("Notes")}</h2>
        <p data-testid="notes">{notes || t("No speaker notes.")}</p>
      </aside>
    </main>
  );
}
