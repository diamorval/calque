import type { Comment, SlideView } from "./types.ts";

const pct = (v: number, of: number) => `${(v / of) * 100}%`;

/** The rendered slide with one clickable box per shape of the shape map. */
export function SlideCanvas(props: {
  slide: SlideView;
  selected: number | null;
  comments: Comment[];
  onSelect: (shapeId: number | null) => void;
}) {
  const { slide, selected, comments, onSelect } = props;
  const commented = new Set(comments.map((c) => c.shape_id));
  return (
    <div className="cq-canvas" style={{ aspectRatio: `${slide.width_px} / ${slide.height_px}` }}>
      <img src={slide.image_url} alt={`Slide ${slide.number}`} onClick={() => onSelect(null)} />
      {slide.shapes
        .filter((s) => s.bbox_px[2] > 0 && s.bbox_px[3] > 0)
        .map((s) => (
          <button
            key={s.shape_id}
            type="button"
            className="cq-shape"
            aria-label={`Shape ${s.shape_id} (${s.role})`}
            aria-pressed={selected === s.shape_id}
            data-commented={commented.has(s.shape_id) || undefined}
            style={{
              left: pct(s.bbox_px[0], slide.width_px),
              top: pct(s.bbox_px[1], slide.height_px),
              width: pct(s.bbox_px[2], slide.width_px),
              height: pct(s.bbox_px[3], slide.height_px),
            }}
            onClick={() => onSelect(s.shape_id)}
          />
        ))}
    </div>
  );
}
