// The DesignSpec: what the LLM produces for any canvas that is not a PPTX deck (social posts, ads,
// banners, posters, web sections). One node tree with auto layout, components and token modes;
// the engine lays it out (HTML/CSS in headless Chromium) and exports PNG, PDF, SVG, HTML, React
// and Tailwind. Colours, fonts and sizes are pack roles, never values: the brand stays in the pack.
// designspec.schema.json is generated from this file (pnpm --filter @calque/deckspec schema).
import { z } from "zod";

const id = z.string().regex(/^[A-Za-z0-9_-]+$/);

/** A colour role of the pack: a key under `role.color` in tokens.json, e.g. accent, ink, series.1. */
export const ColorRole = z
  .string()
  .regex(/^[a-z0-9_]+(\.[a-z0-9_]+)*$/)
  .describe("Pack colour role (role.color.<name> in tokens.json), e.g. ink, background, accent, highlight, series.1.");

export const Paint = z.union([ColorRole, z.strictObject({ color: ColorRole, opacity: z.number().min(0).max(1) })]);

/** px, or hug the content, or fill the space the parent's auto layout leaves. */
export const Size = z.union([z.number().positive(), z.enum(["hug", "fill"])]);

export const AutoLayout = z.strictObject({
  direction: z.enum(["row", "column"]),
  gap: z.number().min(0).optional(),
  padding: z.union([z.number().min(0), z.tuple([z.number().min(0), z.number().min(0), z.number().min(0), z.number().min(0)])]).optional().describe("px, or [top, right, bottom, left]."),
  align: z.enum(["start", "center", "end", "space_between"]).optional().describe("Along the direction."),
  cross: z.enum(["start", "center", "end", "stretch"]).optional().describe("Across the direction; default start."),
  wrap: z.boolean().optional(),
});

export const TextStyle = z.enum(["cover_title", "divider_title", "title", "body", "label", "caption", "numeral", "numeral_xl"]);

const common = {
  id: id.describe("Stable id: patches and lint findings anchor on it."),
  name: z.string().optional(),
  width: Size.optional(),
  height: Size.optional(),
  position: z.strictObject({ x: z.number(), y: z.number() }).optional().describe("Absolute px from the parent's top-left: out of the parent's auto layout."),
  opacity: z.number().min(0).max(1).optional(),
};

const radius = z.union([z.number().min(0), z.tuple([z.number().min(0), z.number().min(0), z.number().min(0), z.number().min(0)])]);
const Stroke = z.strictObject({ color: ColorRole, width: z.number().positive().optional().describe("px; default: the pack's hairline.") });

export const TextNode = z.strictObject({
  type: z.literal("text"),
  ...common,
  text: z.string().min(1).describe("\\n is a line break. In a component, {prop} is replaced by the instance's prop."),
  style: TextStyle.describe("Type scale role (role.size.<style>), scaled to the artboard's format."),
  font: z.enum(["display", "body", "label"]).optional().describe("Font role; default follows the style."),
  color: ColorRole.optional(),
  align: z.enum(["left", "center", "right"]).optional(),
  bold: z.boolean().optional(),
  uppercase: z.boolean().optional(),
  max_lines: z.number().int().min(1).optional().describe("Lint fails when the text needs more lines."),
  size: z.number().positive().optional().describe("px, overriding the style's size (needs a reason: lint warns)."),
});

export const ImageNode = z.strictObject({
  type: z.literal("image"),
  ...common,
  src: z.string().min(1).describe("An uploaded file as `file:<file_id>`, or a path relative to the pack's folder."),
  alt: z.string().describe("What the image shows; empty for a decorative image."),
  fit: z.enum(["cover", "contain"]).optional(),
  radius: radius.optional(),
});

export const ShapeNode = z.strictObject({
  type: z.literal("shape"),
  ...common,
  shape: z.enum(["rect", "ellipse", "line"]),
  fill: Paint.optional(),
  stroke: Stroke.optional(),
  radius: radius.optional(),
});

export const InstanceNode = z.strictObject({
  type: z.literal("instance"),
  ...common,
  component: z.string().min(1).describe("A key of the DesignSpec's components."),
  variant: z.string().optional().describe("One of the component's variants; default: its main node."),
  props: z.record(z.string(), z.string()).optional().describe("Values for the component's {prop} placeholders."),
});

const FrameProps = z.strictObject({
  type: z.literal("frame"),
  ...common,
  layout: AutoLayout.optional().describe("Auto layout; without it children need a position."),
  fill: Paint.optional(),
  stroke: Stroke.optional(),
  radius: radius.optional(),
  shadow: z.enum(["sm", "md", "lg"]).optional(),
  clip: z.boolean().optional(),
});

type Leaf = typeof TextNode | typeof ImageNode | typeof ShapeNode | typeof InstanceNode;
export type DesignNode = (z.output<typeof FrameProps> & { children: DesignNode[] }) | z.output<Leaf>;
type DesignNodeInput = (z.input<typeof FrameProps> & { children?: DesignNodeInput[] | undefined }) | z.input<Leaf>;

/** A node: a frame (with children) or a leaf. Recursive, hence lazy and typed by hand. */
export const Node: z.ZodType<DesignNode, DesignNodeInput> = z.lazy(() =>
  z.discriminatedUnion("type", [FrameNode, TextNode, ImageNode, ShapeNode, InstanceNode]),
);

export const FrameNode = FrameProps.extend({ children: z.array(Node).default([]) });

export const Component = z.strictObject({
  props: z.record(z.string(), z.string()).optional().describe("Default value of each {prop}."),
  node: Node,
  variants: z.record(z.string(), Node).optional().describe("Alternative nodes, e.g. primary / secondary."),
});

export const Artboard = z.strictObject({
  id,
  name: z.string().optional(),
  format: z.string().min(1).describe("A core/formats.yaml preset (list_formats), or 'custom' with width and height."),
  width: z.number().int().positive().max(8000).optional(),
  height: z.number().int().positive().max(8000).optional(),
  mode: z.string().optional().describe("Token mode for this artboard (e.g. dark); default: the spec's mode."),
  fill: Paint.optional().describe("Background; default: the background role."),
  layout: AutoLayout.optional(),
  children: z.array(Node).default([]),
});

export const DesignSpec = z.strictObject({
  pack_id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  language: z.string().min(2).describe("BCP 47 code of the text language."),
  title: z.string().min(1),
  mode: z.string().optional().describe("Token mode of every artboard (a pack's tokens.json $extensions calque.modes); default: the base values."),
  components: z.record(id, Component).optional(),
  artboards: z.array(Artboard).min(1).describe("One per format or per frame of a carousel."),
});

export type DesignSpec = z.infer<typeof DesignSpec>;
export type Artboard = z.infer<typeof Artboard>;

/** One patch_design operation (engine/src/calque_engine/design.py), applied in order. */
export const DesignPatchOp = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("set_node"), artboard: z.string(), node_id: z.string(), props: z.record(z.string(), z.unknown()) })
    .describe("Merge props into a node (not its children, not its type)."),
  z.strictObject({ op: z.literal("replace_node"), artboard: z.string(), node_id: z.string(), with: Node }),
  z.strictObject({ op: z.literal("insert_node"), artboard: z.string(), parent_id: z.string().optional().describe("Default: the artboard."), at: z.number().int().min(0).optional(), node: Node }),
  z.strictObject({ op: z.literal("delete_node"), artboard: z.string(), node_id: z.string() }),
  z.strictObject({ op: z.literal("set_artboard"), artboard: z.string(), props: z.record(z.string(), z.unknown()) })
    .describe("Merge format, width, height, mode, fill, layout or name into an artboard."),
  z.strictObject({ op: z.literal("add_artboard"), at: z.number().int().min(0).optional(), artboard: Artboard }),
  z.strictObject({ op: z.literal("delete_artboard"), artboard: z.string() }),
  z.strictObject({ op: z.literal("adapt_artboard"), artboard: z.string(), id, format: z.string(), width: z.number().int().positive().optional(), height: z.number().int().positive().optional() })
    .describe("Copy an artboard to another format: auto layout reflows, absolute positions scale."),
  z.strictObject({ op: z.literal("set_component"), name: id, component: Component.nullable().describe("null deletes it.") }),
  z.strictObject({ op: z.literal("set_field"), field: z.enum(["title", "mode"]), value: z.string().nullable() }),
]);
export type DesignPatchOp = z.infer<typeof DesignPatchOp>;
