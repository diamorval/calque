import { EN_STRINGS, type SlideUiStrings } from "./strings.ts";
import type { Comment, SlideView } from "./types.ts";

export function Thumbnails(props: { slides: SlideView[]; current: number; comments: Comment[]; onSelect: (i: number) => void; strings?: SlideUiStrings }) {
  const s = props.strings ?? EN_STRINGS;
  return (
    <nav className="cq-thumbs" aria-label={s.slides}>
      {props.slides.map((slide, i) => {
        const n = props.comments.filter((c) => c.slide_id === slide.id).length;
        return (
          <button key={slide.id} type="button" aria-current={i === props.current} onClick={() => props.onSelect(i)}>
            <span className="cq-thumb-n">{slide.number}</span>
            <img src={slide.image_url} alt={s.slide(slide.number)} loading="lazy" />
            {n > 0 && (
              <span className="cq-count" aria-label={s.commentCount(n)}>
                {n}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}
