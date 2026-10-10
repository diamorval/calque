# Doctrine: form follows the message

The rules every authoring workflow (`build`, `draft`) obeys, and that `review` audits against.
Brand-free: it speaks only in the roles of [pack-contract.md](pack-contract.md). The active pack
binds those roles to values; this file never names a colour, a font or a company.

## The LLM's job, the engine's job

The LLM never writes PPTX. It writes a **DeckSpec** (JSON, schema in `packages/deckspec`), one
entry per slide:

```json
{ "message": "One-line claim the slide proves.",
  "message_type": "quantity",
  "form": "chart",
  "source": { "kind": "composition", "id": "chart_takeaway", "params": { } } }
```

`source.kind` is one of:

| kind | What the engine does | Typical use |
| --- | --- | --- |
| `clone` | Clones a template slide by **pack role** (`cover`, `summary`, `divider`, `subsection`, `closing`, `appendix`, `content`) or **archetype name** (`roles.archetypes.*`), then fills its slots by `shape_id`. | Signatures; an archetype whose message **is** this slide's message. |
| `composition` | Clones the pack `content` slide and draws a recipe from [compositions.md](compositions.md) on the grid. | Most content slides. |
| `chart` | Clones `content`, draws one native, editable chart across the body band. | Data with no verdict column (the title is the verdict). |
| `diagram` | Clones `content`, draws one native diagram (`flow`, `swimlane`, `layers`, `hub`, `matrix2x2`, `funnel`, `cycle`, `before_after`). | Process, system, positioning. |

The engine is deterministic: same DeckSpec + same pack = same PPTX.

## Language

Write in the language the request or source calls for. If `pack.yaml` `default_language` is null
and the request does not settle it, **ask**. Template placeholder labels are translated into the
deck language; brand signatures stay as the pack sets them (see the pack's `voice`).

## Look at the exemplar before designing

The template shows where the shapes **are**; it cannot show a finished slide. Before designing,
read the pack's `exemplar` (and look at its contact sheets if the pack ships them): density of
imagery, the eyebrow, the type scale (one large statement, small dense support, nothing in
between), fills versus strokes. Never clone from the exemplar, only from the template.

## Message type → allowed forms

Derive the form from the message type. Never pick a form for variety, never default to a text
well.

| Message type | Candidate forms (choose **within** the row) |
| --- | --- |
| quantity · share · trend · ranking | **chart** (line for evolution, bar for comparison/ranking, horizontal bar when labels are long, doughnut for share of whole with at most ~5 slices, scatter for correlation); one dominant number → archetype `key_figure`; three or four peer figures → archetype `key_figures` or composition `kpi_sparkband` |
| process · sequence · method | diagram `flow` / `swimlane`; a calendar → archetype `timeline` or `gantt`; few steps each needing detail → archetype `numbered_steps` / `cards` |
| system · architecture · stack | diagram `layers` / `hub`, composition `layers_rail`; capability coverage → archetype `domains_capabilities` |
| positioning · trade-off | diagram `matrix2x2` (composition `matrix_2x2`); two or three named options → archetype `pros_cons`; feature by feature → archetype `comparison_matrix` or composition `comparison_table` |
| conversion · selection | diagram `funnel` (composition `funnel_rail`); absolute volumes matter more than drop-off → composition `chart_takeaway` with a bar chart |
| recurring loop | diagram `cycle` |
| transformation · contrast | diagram `before_after`, or archetype `before_after` |
| single proof point | archetype `key_figure`; a person or place behind the number → archetype `image_split` with the figure as the text half; a said thing → archetype `quote` |
| catalogue · feature set | archetype `cards`, composition `comparison_table`, or archetype `comparison_matrix` when entries must be compared row by row |
| pricing | archetype `pricing`, or composition `comparison_table` |
| narrative · context | archetype `text_well` / `image_split`; one idea carrying the slide → archetype `statement` |

Archetype names above are the conventional names; use whatever the active pack declares under
`roles.archetypes`. If the pack has no such archetype, fall back to a composition or a diagram,
never to a text well.

Rules:

- **The table lists candidates, not a lookup.** Choose by the shape of the data, the slide's weight
  in the arc, and what neighbouring slides already use. What the table forbids is the underived
  default: a text well standing in for any row above.
- **Clone an archetype only when the message is that archetype's message** (a real roadmap → a
  timeline is right), and adapt it.
- **3+ numbers sharing a dimension must be a chart.** A slide whose source has three or more
  numbers on one dimension (a trend, shares, a ranking) is a chart unless the DeckSpec entry
  justifies otherwise in one line.
- **No 3 consecutive slides of the same form.** It means distinct message types were flattened:
  rework the content, not the decoration.
- A bullet list where a chart or diagram belongs is a defect; so is a chart with no real data
  behind it, or a chart for a single number.
- Two slides of one deck on the same composition must differ in geometry (split, orientation,
  element count), or one of them is filler.

## Build rules

- **Edit by `shape_id`**, never by shape name (names are copied on duplication and lie). Slot
  ids come from the pack's `template-map.yaml`; never assume the title has the same id on two
  slides.
- **Replace text run by run.** Never reset a whole text frame: it drops run styling and with it the
  pack fonts. Line breaks inside one paragraph are soft breaks, never a literal control character.
- **Replace every placeholder.** No string listed in `pack.yaml` `lint.placeholders` (nor any
  lorem ipsum) may survive.
- **Respect capacities.** Each slot in `template-map.yaml` carries an estimated capacity; the
  title box carries `grid.title.max_chars`. Write the copy to fit before building: tightening
  copy is cheaper than a QA loop. Overflow is failure #1. Never enlarge a box to rescue copy.
  Lint warns (`capacity`) on a slot over its capacity and on a fit label grown into other text.
- **Narrow labels fit to content** and keep their grid edge; judge them across slides (four
  dividers must not end up with four different label positions).
- **Text in blocks, not fragments.** One text frame per idea group (a label paragraph, then its
  lines, separated by paragraph spacing), never a second box at a second top to fake a line break.
  When the message is prose, keep and fill the archetype's body well.
- **Native lists.** Bullets and numbering are paragraph properties on the template's own indent,
  never typed glyphs or hand-written "1.". One sub-level at most.
- **Never fabricate a fact.** Unknown value → the pack's `missing_value[<lang>]` placeholder, kept
  in the format of the slot (unit, ordinal, date pattern), and listed in the delivery report.
- **Cite where the numbers come from.** A chart or composition whose figures come from a document,
  a system or a study carries `params.source`, written in full in the deck language ("Source: CRM,
  Sept. 2026"): who measured it, and when. The engine draws it as a small line at the bottom of
  the body band (the pack's `source` slot, or `grid.source`) and shrinks the drawing above it. An
  unknown source is a `missing_value[<lang>]` in that line, never omitted silently. A comment
  asking for a source is a `set_params` patch with `source`. On a cloned archetype, write the
  source into one of its caption slots. A pack may opt in to a lint WARN on any chart without one
  (`lint.chart_source`).
- **Keep the decoration.** Grid rules, background rectangles and icons on a cloned slide are its
  frame; replace only the text and picture slots.
- **Reorder, then renumber** page-number footers (`grid.page_number`), or blank them. A build
  writes every page number as a slide-number field, so PowerPoint keeps it right after a reorder.
- **Fonts.** Display role (`role.font.display`) for titles and large numerals, body role for text
  and figures, label role for eyebrows and small labels. Never set a font outside the pack; if the
  pack font file is absent, rendering uses `fonts.fallback` and the report says so.

## Palette discipline (in roles)

- A slide reads as **`role.color.ink` + one `role.color.wash.*` (or `background`) +
  `role.color.accent`**. Nothing else unless it carries meaning.
- **`role.color.highlight` marks the one active element** of a slide: the bar, step, dot or cell
  the slide is about. Stroke, numeral, icon or arrow, never a large fill. A bar's stroke plus its
  own numeral is one element; two unrelated highlights are a violation. `pack.yaml`
  `lint.single_use_colors` enforces it.
- **`role.color.status.*` only for data with status meaning** (positive / warning / info). Never
  body text, never decoration, never "to make a chart more colourful".
- Washes belong to signature slides (cover, summary, divider, closing). Content slides sit on
  `role.color.background`; rotate washes so the deck reads as light content punctuated by
  signatures. Never an accent as a background fill on a content slide.
- Charts: primary series `accent`, the highlighted point `highlight`, further series
  `series.1…n`; axes and value gridlines `rule` at `role.stroke.hairline`; category gridlines off;
  no 3D, no shadow, no chart-internal title (the verdict is the slide title), no border; label
  bars directly and skip the legend for one series; legend at the bottom only when two or more
  series need naming. Doughnut over pie.
- Diagrams: boxes `background` or `surface` fill with a `rule` hairline; links `muted` at
  `role.stroke.link`; the active element `highlight` at `role.stroke.emphasis`; a wash may mark an
  emphasis or foundation tier. Icons from the pack set, tinted one colour per surface, small,
  never illustration. At most three visible grid axes.

## Lint → render → fix

1. **`lint_deck`** first. It decides mechanically what pixels cannot: off-pack font, off-palette
   colour, surviving placeholder, text off canvas or under `grid.footer_top_in`, stale page
   number, single-use colour used twice, banned words, the anti-slop machine rules. **Fix every
   ERROR before looking at a render.** WARNs need eyes on the render.
2. **Render** (PNG per slide) and look at each slide: hierarchy, whitespace, palette discipline,
   overflow, repeated forms, legibility. Fix with `patch_deck`, re-render **only changed
   slides**, loop.
3. If rendering is unavailable, lint is the structural QA: fix every ERROR and **tell the user the
   deck was not visually verified**.
4. Stop after one clean lint and one clean render pass. Do not chase sub-pixel perfection.

## Success test (before delivery)

Per slide:

1. **Could it have been designed without reading the source?** If yes it decorates instead of
   communicating: pick the form that carries this message and redraw.
2. **Is it at the template's level?** Composition, controlled density, zero overflow, zero
   placeholder, disciplined palette.
3. **Does it sit next to the exemplar** as if from the same deck (same imagery density, same
   eyebrow, same fills)? Outlined boxes on a blank background do not, however correct the palette.

Per deck: **could it belong to another client or topic?** If interchangeable, you filled a
template: revisit the narrative and redraw.
