import type { DeckView } from "@calque/slide-ui";
import { Clock, X } from "lucide-react";
import { useEffect, useState } from "react";
import { tool } from "../api.ts";
import { navigate } from "../nav.ts";
import { Button, Spinner } from "../ui.tsx";

type Deck = DeckView & { spec: { slides: { id: string; notes?: string }[] } };

const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

/** Full-screen slides. → / Space next, ← previous, P presenter view (next slide, notes, timer),
F full screen, Esc back to the editor. */
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
        <Spinner label="Loading deck" />
      </div>
    );
  const slide = deck.slides[i];
  const next = deck.slides[i + 1];
  if (!slide) return null;
  const notes = deck.spec.slides.find((s) => s.id === slide.id)?.notes;
  const current = <img className="cq-present-slide" src={slide.image_url} alt={`Slide ${slide.number}`} />;

  if (!presenter) return <main className="cq-present">{current}</main>;
  return (
    <main className="cq-presenter" aria-label="Presenter view">
      <header>
        <strong className="cq-mono">
          {i + 1} / {deck.slides.length}
        </strong>
        <span className="cq-badge">
          <Clock /> <span aria-label="Elapsed">{clock(Math.floor((now - started) / 1000))}</span>
        </span>
        <span className="cq-hint">
          <kbd className="cq-kbd">←</kbd> <kbd className="cq-kbd">→</kbd> navigate · <kbd className="cq-kbd">P</kbd> audience view · <kbd className="cq-kbd">F</kbd> full
          screen
        </span>
        <Button variant="ghost" size="sm" onClick={() => navigate(`/d/${id}`)}>
          <X /> Exit
        </Button>
      </header>
      <div className="cq-presenter-now">{current}</div>
      <aside>
        <h2>Next</h2>
        {next ? <img src={next.image_url} alt={`Next: slide ${next.number}`} /> : <p className="cq-hint">End of deck</p>}
        <h2>Notes</h2>
        <p data-testid="notes">{notes || "No speaker notes."}</p>
      </aside>
    </main>
  );
}
