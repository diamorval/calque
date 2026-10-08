import type { Comment, ShapeBox, SlideView } from "./types.ts";

const pct = (v: number, of: number) => `${(v / of) * 100}%`;

/** What a shape is, in words: its template role, or its kind when the engine drew it. */
export const shapeLabel = (s: Pick<ShapeBox, "kind" | "role">) => (s.role === "drawn" ? s.kind : s.role);

/** The rendered slide with one clickable box per shape of the shape map; commented shapes carry a pin. */
export function SlideCanvas(props: {
  slide: SlideView;
  selected: number | null;
  comments: Comment[];
  /** Outline every shape, not only the hovered one. */
  outline?: boolean;
  onSelect: (shapeId: number | null) => void;
}) {
  const { slide, selected, comments, onSelect } = props;
  const pins = new Map<number, number>();
  for (const c of comments) if (c.shape_id !== null) pins.set(c.shape_id, (pins.get(c.shape_id) ?? 0) + 1);
  return (
    <div className="cq-canvas" data-outline={props.outline || undefined} style={{ aspectRatio: `${slide.width_px} / ${slide.height_px}` }}>
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
            data-commented={pins.get(s.shape_id)}
            style={{
              left: pct(s.bbox_px[0], slide.width_px),
              top: pct(s.bbox_px[1], slide.height_px),
              width: pct(s.bbox_px[2], slide.width_px),
              height: pct(s.bbox_px[3], slide.height_px),
            }}
            onClick={() => onSelect(selected === s.shape_id ? null : s.shape_id)}
          >
            {selected === s.shape_id && (
              <span className="cq-shape-tag" aria-hidden>
                {shapeLabel(s)} #{s.shape_id}
              </span>
            )}
          </button>
        ))}
    </div>
  );
}
