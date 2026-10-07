# Compositions: grid-relative recipes

Bespoke compositions for content slides whose message matches no pack archetype. Each recipe has
a stable snake_case `id` that a DeckSpec references (`source: {kind: "composition", id, params}`)
and that the engine implements. Coordinates are **grid-relative**: they resolve against the active
pack's `pack.yaml` `grid` and canvas size, never against one company's inches.

## Frame (from `pack.yaml` `grid`)

| Symbol | Definition |
| --- | --- |
| `W`, `H` | Canvas width and height (from the template). |
| `m` | `grid.margin_in`. |
| `g` | `grid.gutter_in`; if absent, the gap between consecutive `grid.columns[n]` edges minus column width. |
| `col(n, i)` | `grid.columns["n"][i]`, left edge of column `i` (0-based) in the `n`-column grid. |
| `cw(n)` | Column width in the `n` grid: `(W − 2m − (n−1)g) / n`. |
| `span(n, i, k)` | Width of `k` columns from `i`: `k·cw(n) + (k−1)g`. |
| `top` | `grid.body_top_in`. |
| `bot` | `grid.footer_top_in`. |
| `bh` | Body band height: `bot − top`. |
| `bw` | Body band width: `W − 2m`. |
| `y(f)` | `top + f·bh`, a fraction `f ∈ [0, 1]` of the band. |
| `x(f)` | `m + f·bw`. |

Every recipe:

- Clones the pack role `content`, keeps its title box (`grid.title`) and rewrites the title as the
  **verdict**, one line, within `grid.title.max_chars`.
- Draws inside `[m, W − m] × [top, bot]` only. Nothing crosses `bot` (footer, page number).
- Uses `n = 3` or `n = 4` column grids, whichever the pack declares; if a recipe asks for `n = 3`
  and the pack has only `"4"`, use spans of the declared grid (`span(4, 0, 3)` for a two-thirds
  block, etc.).
- Lays text in blocks: one frame per idea group (label paragraph in `role.font.label` at
  `role.size.label` in `role.color.muted`, then lines in body role), native bullets.
- Puts `role.color.highlight` on at most **one** element (`active` param).

**The numbers are one instance of the frame, never the composition's identity.** Change the split,
orientation, element count and density to fit the message. Two slides of one deck on the same
recipe must differ in geometry.

---

## `chart_takeaway`: chart + verdict column

The default data slide: the chart carries the evidence, the column carries the verdict.

| Element | Box (left, top, width, height) |
| --- | --- |
| chart | `col(3,0)`, `top`, `span(3,0,2)`, `≈0.95·bh` |
| takeaway block | `col(3,2)`, `y(0.07)`, `cw(3)`, `≈0.85·bh` |

Params: `chart_type` (`bar` · `bar_horizontal` · `line` · `doughnut` · `scatter`), `categories`,
`series` (name → values), `highlight` (index of the active point/bar, optional), `takeaway`
(label + 1–3 lines), `split` (`2/1` default, `3/1` on a 4 grid).
Roles: `accent` (primary series), `highlight` (active point), `series.*`, `rule`, `ink`, `muted`,
`font.body`, `font.label`, `stroke.hairline`.
Variant `full`: chart spans `bw`, no column; the title must then be the verdict.

## `flow_detail`: full-band process + detail of the active step

| Element | Box |
| --- | --- |
| flow band | `m`, `y(0.05)`, `bw`, `≈0.40·bh` |
| detail block | `col(3,0)`, `y(0.58)`, `span(3,0,2)`, `≈0.35·bh` |

Params: `steps` (3–6 items: label, sublabel e.g. duration, optional icon), `active` (index),
`detail` (label + 1–2 lines about the active step), `orientation` (`horizontal` default,
`vertical` puts the flow in `col(3,0)` full band height and the detail in `span(3,1,2)`).
Roles: `surface` / `background` (step fill), `rule`, `muted` (arrows, `stroke.link`), `highlight`
(active step stroke and numeral, `stroke.emphasis`), `accent` (ordinals), `font.label`, `font.body`.

## `matrix_2x2`: positioning matrix

| Element | Box |
| --- | --- |
| plot | `x(0.09)`, `top`, `≈0.82·bw`, `bh` |

Axis end labels need about `0.07·bw` outside the plot on the left; keep the plot within
`[x(0.09), x(0.91)]`.
Params: `x_axis` (low, high labels), `y_axis` (low, high labels), `quadrants` (4 labels),
`items` (label, x ∈ [0,1], y ∈ [0,1]), `active` (index of the item the slide is about).
Roles: `rule` (axes), `muted` (quadrant labels), `accent` (item dots), `highlight` (active dot),
`font.label`, `font.body`.

## `kpi_sparkband`: KPI row + trend band

Figures say *what*, the band says *since when*.

| Element | Box |
| --- | --- |
| figure `i` (3 or 4) | `col(n,i)`, `top`, `cw(n)`, `≈0.27·bh` |
| spark band | `m`, `y(0.42)`, `bw`, `≈0.55·bh` |

Params: `figures` (3–4 × value with unit, label), `trend` (categories, one series), `n` (3 or 4).
Roles: `font.display` at `size.numeral` (figures), `ink`, `muted` (labels), `accent` (trend line),
`rule`, `stroke.hairline`. No legend on the band.

## `layers_rail`: architecture layers + annotated rail

| Element | Box |
| --- | --- |
| layers | `col(3,0)`, `y(0.05)`, `span(3,0,2)`, `≈0.92·bh` |
| rail (icon + note) | `col(3,2) + 0.05·cw(3)`, aligned on the layer it annotates, `≈0.95·cw(3)` |

Params: `layers` (3–5 × name, sublabel; top = closest to the user), `active` (index),
`annotations` (0–2 × layer index, icon, one line).
Roles: `surface` or a `wash.*` (foundation tier), `rule`, `highlight` (active layer stroke),
`accent` (icon tint), `font.label`, `font.body`.

## `comparison_table`: native table

| Element | Box |
| --- | --- |
| table | `m`, `y(0.05)`, `bw`, rows × row height ≤ `0.95·bh` |

Params: `header` (column labels), `rows`, `col_weights` (relative widths), `align` (per column;
numbers right-aligned), `recommend` (row or column index, optional).
Roles: `ink`, `muted` (header label), `rule` (row hairlines only), `font.label`, `font.body`.
To recommend, set **one** cell's text in `highlight`: never a filled band, never a decorative rule.
Overflow guard: if `rows × row height > 0.95·bh`, cut rows or split the slide, never shrink type
below `role.size.caption`.

## `funnel_rail`: funnel + conversion rail

| Element | Box |
| --- | --- |
| funnel | `col(3,0)`, `top`, `span(3,0,2)`, `bh` |
| rail | `col(3,2)`, `y(0.10)`, `cw(3)`, `≈0.80·bh` (optional) |

Params: `stages` (label, value), `conversions` (stage-to-stage rates, shown as sublabels),
`active` (the stage the story is about), `rail` (label + 1–2 lines, optional; without it the funnel
spans `bw`).
Widths encode the values. Roles: `surface`, `rule`, `highlight` (active stage stroke and numeral),
`accent`, `font.display` (numerals), `font.body`.

---

## Rules of thumb

- One message per slide. The title states the verdict, the drawing proves it.
- Whitespace is part of the grid: do not fill the band because it exists.
- Fills over strokes: prefer `surface` / wash panels and images to thin outlined rectangles.
- Check every bespoke slide against the doctrine success test (designed-without-the-source,
  interchangeable-deck).
