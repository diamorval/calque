import type { Comment, SlideView } from "./types.ts";

export function Thumbnails(props: { slides: SlideView[]; current: number; comments: Comment[]; onSelect: (i: number) => void }) {
  return (
    <nav className="cq-thumbs" aria-label="Slides">
      {props.slides.map((s, i) => {
        const n = props.comments.filter((c) => c.slide_id === s.id).length;
        return (
          <button key={s.id} type="button" aria-current={i === props.current} onClick={() => props.onSelect(i)}>
            <img src={s.image_url} alt={`Slide ${s.number}`} loading="lazy" />
            <span>{s.number}</span>
            {n > 0 && <span className="cq-badge" aria-label={`${n} comments`}>{n}</span>}
          </button>
        );
      })}
    </nav>
  );
}
