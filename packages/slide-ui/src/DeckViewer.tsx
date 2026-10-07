import { useState, type FormEvent } from "react";
import { SlideCanvas } from "./SlideCanvas.tsx";
import { Thumbnails } from "./Thumbnails.tsx";
import type { DeckView, NewComment } from "./types.ts";

/** Preview + inspector + comments. Comments anchor on the slide id and, if one is picked, a shape_id. */
export function DeckViewer(props: {
  deck: DeckView;
  onComment: (c: NewComment) => Promise<void>;
  /** Hand the open comments to the agent (MCP Apps: a message to the model). */
  onApply?: () => Promise<void>;
}) {
  const { deck } = props;
  const [current, setCurrent] = useState(0);
  const [shape, setShape] = useState<number | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const slide = deck.slides[Math.min(current, deck.slides.length - 1)];
  if (!slide) return <p>Empty deck.</p>;
  const here = deck.open_comments.filter((c) => c.slide_id === slide.id);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!text.trim() || !slide) return;
    setBusy(true);
    try {
      await props.onComment({ slide_id: slide.id, ...(shape !== null ? { shape_id: shape } : {}), text: text.trim() });
      setText("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="cq-deck">
      <header>
        <strong>{deck.title}</strong>
        <span>
          v{deck.version} · {deck.pack_id}
        </span>
        {props.onApply && deck.open_comments.length > 0 && (
          <button type="button" onClick={() => void props.onApply?.()}>
            Apply {deck.open_comments.length} comment{deck.open_comments.length > 1 ? "s" : ""}
          </button>
        )}
      </header>
      <Thumbnails
        slides={deck.slides}
        current={current}
        comments={deck.open_comments}
        onSelect={(i) => {
          setCurrent(i);
          setShape(null);
        }}
      />
      <main>
        <SlideCanvas slide={slide} selected={shape} comments={here} onSelect={setShape} />
        <form onSubmit={submit} className="cq-comment">
          <label htmlFor="cq-text">
            Comment on slide {slide.number}
            {shape !== null ? `, shape ${shape}` : ""}
          </label>
          <textarea id="cq-text" value={text} onChange={(e) => setText(e.target.value)} rows={2} />
          <button type="submit" disabled={busy || !text.trim()}>
            Comment
          </button>
        </form>
        <ul className="cq-comments">
          {here.map((c) => (
            <li key={c.id}>
              <button type="button" onClick={() => setShape(c.shape_id)}>
                {c.shape_id !== null ? `#${c.shape_id} ` : ""}
                {c.text}
              </button>
            </li>
          ))}
        </ul>
      </main>
    </div>
  );
}
