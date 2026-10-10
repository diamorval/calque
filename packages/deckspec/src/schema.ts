// The DeckSpec: what the LLM produces. The engine turns it into PPTX deterministically.
// This file is the single source; deckspec.schema.json is generated from it (pnpm --filter @calque/deckspec schema)
// and the Python engine validates against that JSON Schema.
import { z } from "zod";

const text = z.string().min(1);
const index = z.number().int().min(0);

/** A step / box label: plain text, or a title with a sublabel and an optional icon name. */
export const Item = z.union([
  text,
  z.strictObject({ label: text, sublabel: z.string().optional(), icon: z.string().optional() }),
]);

export const Series = z.strictObject({ name: text, values: z.array(z.number()).min(1) });

export const ChartParams = z.strictObject({
  categories: z.array(z.string()).min(1).optional(),
  series: z.array(Series).min(1).optional(),
  /** scatter only */
  points: z.array(z.strictObject({ label: z.string(), x: z.number(), y: z.number() })).min(1).optional(),
  highlight: index.optional().describe("Index of the category / point the slide is about."),
  highlight_series: index.optional(),
  stacked: z.boolean().optional(),
  unit: z.string().optional(),
  number_format: z.string().optional(),
  x_title: z.string().optional(),
  y_title: z.string().optional(),
});

export const ChartSource = z.strictObject({
  kind: z.literal("chart"),
  type: z.enum(["line", "bar", "bar_horizontal", "doughnut", "scatter"]),
  params: ChartParams,
});

const Panel = z.strictObject({ title: text, lines: z.array(z.string()) });
const Axis = z.array(z.string()).length(2);

export const DiagramSource = z.discriminatedUnion("id", [
  z.strictObject({ kind: z.literal("diagram"), id: z.literal("flow"), params: z.strictObject({ steps: z.array(Item).min(2).max(7), active: index.optional(), numbered: z.boolean().optional() }) }),
  z.strictObject({ kind: z.literal("diagram"), id: z.literal("swimlane"), params: z.strictObject({ lanes: z.array(z.strictObject({ label: text, steps: z.array(Item).min(1) })).min(2).max(5), active: z.array(index).length(2).optional() }) }),
  z.strictObject({ kind: z.literal("diagram"), id: z.literal("layers"), params: z.strictObject({ layers: z.array(Item).min(2).max(6), active: index.optional() }) }),
  z.strictObject({ kind: z.literal("diagram"), id: z.literal("hub"), params: z.strictObject({ center: Item, spokes: z.array(Item).min(3).max(8), active: index.optional() }) }),
  z.strictObject({ kind: z.literal("diagram"), id: z.literal("matrix2x2"), params: z.strictObject({ x_axis: Axis, y_axis: Axis, quadrants: z.array(z.string()).length(4), items: z.array(z.strictObject({ label: text, x: z.number().min(0).max(1), y: z.number().min(0).max(1) })).optional(), active: index.optional() }) }),
  z.strictObject({ kind: z.literal("diagram"), id: z.literal("funnel"), params: z.strictObject({ stages: z.array(Item).min(2).max(6), values: z.array(z.number()).optional(), active: index.optional() }) }),
  z.strictObject({ kind: z.literal("diagram"), id: z.literal("cycle"), params: z.strictObject({ steps: z.array(Item).min(3).max(6), active: index.optional() }) }),
  z.strictObject({ kind: z.literal("diagram"), id: z.literal("before_after"), params: z.strictObject({ before: Panel, after: Panel, arrow_label: z.string().optional() }) }),
]);

const Block = z.strictObject({ label: z.string().optional(), lines: z.array(z.string()).min(1).max(4) });

export const CompositionSource = z.discriminatedUnion("id", [
  z.strictObject({ kind: z.literal("composition"), id: z.literal("chart_takeaway"), params: z.strictObject({ chart_type: ChartSource.shape.type, chart: ChartParams, takeaway: Block.optional(), split: z.enum(["2/1", "3/1", "full"]).optional() }) }),
  z.strictObject({ kind: z.literal("composition"), id: z.literal("flow_detail"), params: z.strictObject({ steps: z.array(Item).min(3).max(6), active: index, detail: Block, orientation: z.enum(["horizontal", "vertical"]).optional() }) }),
  z.strictObject({ kind: z.literal("composition"), id: z.literal("matrix_2x2"), params: z.strictObject({ x_axis: Axis, y_axis: Axis, quadrants: z.array(z.string()).length(4), items: z.array(z.strictObject({ label: text, x: z.number().min(0).max(1), y: z.number().min(0).max(1) })).min(1), active: index.optional() }) }),
  z.strictObject({ kind: z.literal("composition"), id: z.literal("kpi_sparkband"), params: z.strictObject({ figures: z.array(z.strictObject({ value: text, label: text })).min(3).max(4), trend: z.strictObject({ categories: z.array(z.string()).min(2), values: z.array(z.number()).min(2) }) }) }),
  z.strictObject({ kind: z.literal("composition"), id: z.literal("layers_rail"), params: z.strictObject({ layers: z.array(Item).min(3).max(5), active: index.optional(), annotations: z.array(z.strictObject({ layer: index, icon: z.string().optional(), text })).max(2).optional() }) }),
  z.strictObject({ kind: z.literal("composition"), id: z.literal("comparison_table"), params: z.strictObject({ header: z.array(z.string()).min(2), rows: z.array(z.array(z.string())).min(1), col_weights: z.array(z.number().positive()).optional(), align: z.array(z.enum(["left", "center", "right"])).optional(), recommend: z.strictObject({ row: index.optional(), col: index.optional() }).optional() }) }),
  z.strictObject({ kind: z.literal("composition"), id: z.literal("funnel_rail"), params: z.strictObject({ stages: z.array(z.strictObject({ label: text, value: z.number() })).min(2).max(6), conversions: z.array(z.string()).optional(), active: index.optional(), rail: Block.optional() }) }),
]);

/** A value written into a cloned shape, keyed by shape_id. null deletes the shape. */
export const ShapeValue = z.union([
  z.null(),
  z.string().describe("One paragraph; \\n is a line break inside it."),
  z.array(z.string()).describe("One entry per paragraph."),
  z.strictObject({
    text: z.union([z.string(), z.array(z.string())]).optional(),
    color: z.string().optional().describe("A colour role, e.g. accent or highlight."),
    bold: z.boolean().optional(),
    size: z.union([z.string(), z.number().positive()]).optional().describe("A size role or points."),
    fit: z.boolean().optional().describe("Grow the box to keep the text on one line."),
    image: z.string().optional().describe("Image replacing a picture, cropped to fill: an uploaded file as `file:<file_id>`, or a path relative to the deck's, the uploads' or the pack's folder."),
    table: z.array(z.array(z.string())).optional(),
    width_frac: z.number().min(0).max(1).optional().describe("Bar/progress width as a fraction of the original."),
  }),
]);

export const CloneSource = z
  .strictObject({
    kind: z.literal("clone"),
    role: z.string().optional().describe("Pack role or archetype name."),
    slide: z.number().int().min(1).optional().describe("Template (or imported deck) slide number, 1-based."),
    from: z.enum(["template", "base"]).optional().describe("base = the imported deck this DeckSpec edits."),
    values: z.record(z.string().regex(/^\d+$/), ShapeValue).default({}),
  })
  .refine((s) => s.role !== undefined || s.slide !== undefined, { message: "clone needs a role or a slide" });

export const Source = z.discriminatedUnion("kind", [CloneSource, ChartSource, DiagramSource, CompositionSource]);

export const Fact = z.strictObject({ label: z.string(), value: z.number(), unit: z.string().optional() });

export const MessageType = z.enum([
  "quantity", "share", "trend", "ranking", "process", "sequence", "system", "positioning", "tradeoff",
  "conversion", "loop", "transformation", "proof", "catalogue", "pricing", "narrative",
  "cover", "summary", "divider", "closing", "appendix",
  "imported",
]);

export const Slide = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9_-]+$/).describe("Stable id: comments and patches anchor on it."),
  message: text.describe("The one thing this slide says, as a sentence."),
  message_type: MessageType,
  form: text.describe("core/forms.yaml form name: chart type, diagram, composition, role or archetype."),
  source: Source,
  title: z.string().optional().describe("Verdict title for chart, diagram and composition slides."),
  eyebrow: z.string().optional(),
  notes: z.string().optional().describe("Speaker notes."),
  facts: z.array(Fact).optional().describe("The numbers the slide carries; 3+ sharing a unit must be a chart."),
  justification: z.string().optional().describe("Why this slide may break a form rule."),
});

export const DeckSpec = z.strictObject({
  pack_id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  language: z.string().min(2).describe("BCP 47 code of the deck language."),
  title: text,
  base: z.string().regex(/^[\w-]+\.pptx$/).optional().describe("Imported deck this spec edits, a file in the deck's folder (set by import_pptx)."),
  slides: z.array(Slide).min(1),
});

export type DeckSpec = z.infer<typeof DeckSpec>;
export type Slide = z.infer<typeof Slide>;
export type Source = z.infer<typeof Source>;
export type ShapeValue = z.infer<typeof ShapeValue>;

/** One patch_deck operation (engine/src/calque_engine/patch.py), applied in order. */
export const PatchOp = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("set"), slide: z.string(), shape_id: z.number().int(), value: ShapeValue })
    .describe("Write into a cloned shape."),
  z.strictObject({ op: z.literal("set_field"), slide: z.string(), field: z.enum(["title", "eyebrow", "notes", "message"]), value: z.string() }),
  z.strictObject({ op: z.literal("set_params"), slide: z.string(), params: z.record(z.string(), z.unknown()) })
    .describe("Merge into a chart, diagram or composition source's params."),
  z.strictObject({ op: z.literal("replace_slide"), slide: z.string(), with: Slide }),
  z.strictObject({ op: z.literal("insert_slide"), at: z.number().int().min(0).describe("0-based position."), slide: Slide }),
  z.strictObject({ op: z.literal("delete_slide"), slide: z.string() }),
  z.strictObject({ op: z.literal("move_slide"), slide: z.string(), to: z.number().int().min(0) }),
]);
export type PatchOp = z.infer<typeof PatchOp>;
