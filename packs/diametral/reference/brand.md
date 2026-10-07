# Diametral — brand spec (slides)

The brand lives in the official template `assets/template.pptx` — its theme
(`ppt/theme/theme1.xml`) **is** authoritative here (unlike the old deck, whose
Office theme was noise). The template was authored in Google Slides and exported
to PPTX, so shapes are named `Google Shape;N;pM` — that **name is unreliable**
(copied when a slide is duplicated). Always select shapes by **`shape_id`** (the
`<p:cNvPr id>`), which is unique within a slide. See
[references/template-map.md](references/template-map.md) for the per-slide ids.

## Palette (theme `clrScheme`, the design system)

The template fuses the print **charte** (Marron) with the digital **design
system** (red, Geist). Two tiers — **MAIN** carries the slide, **SECONDARY** is
data/status accent used sparingly (the template documents this split on slide 28).

| Tier      | Role       | Hex      | Usage                                                                |
| --------- | ---------- | -------- | -------------------------------------------------------------------- |
| MAIN      | Ink        | `161616` | Body text on light; the dark background variant.                     |
| MAIN      | White      | `FFFFFF` | Background of content slides (`lt1`).                                |
| MAIN      | Warm gray  | `D5D3C4` | Signature background wash (`dk2`); subtle surfaces.                  |
| MAIN      | Sage gray  | `AAB0A6` | Signature background wash (`lt2`) — cover, closing.                  |
| MAIN      | Marron     | `9F8667` | **Primary accent** (the Charte). Eyebrows, numerals, rules, markers. |
| MAIN      | Slate gray | `767884` | Divider background wash (`accent3`); muted text.                     |
| SECONDARY | Red        | `FF2A00` | **Active / emphasis / link** accent (design-system signature).       |
| SECONDARY | Lime       | `F4FBDA` | Summary background wash (`accent1`); positive data.                  |
| SECONDARY | Yellow     | `FFF73B` | Highlight / data accent.                                             |
| SECONDARY | Cyan       | `23E2FF` | Data accent.                                                         |
| SECONDARY | Green      | `53FF64` | Positive status / data accent.                                       |

**Discipline (replaces the old "Marron is the sole accent" rule):** Marron is the
primary brand accent; **red `FF2A00`** marks what is active/emphasised/linked; the
brights (`F4FBDA` / `FFF73B` / `23E2FF` / `53FF64`) are for **data, charts and
status only — never as body text or as a second decorative accent on the same
slide**. A slide should read as ink + one wash + Marron, with red or one bright
added only where it carries meaning. Loud everywhere = off-brand.

## Fonts

The template uses **two families** (measured run counts: Geist ≫ Ufficio):

- **Geist** — **body & UI** (dominant): paragraphs, labels, figures, table cells,
  section/chapter numbers. The digital design-system face.
- **Geist Light** — eyebrows, small labels, ordinals (`01`–`05`, `LABEL`, years).
- **Ufficio 300** — **display only**: slide titles and the largest numerals. The
  print-charte face, reserved for the typographic signature.

Measured anchors: cover title Ufficio **59 pt**, summary title **50 pt**, divider
title **47 pt**, subsection **40 pt**; body Geist **12 pt**; eyebrows Geist Light
**18 pt** (content) / 12 pt (cards); key-figure numerals Geist **60–72 pt**.

When replacing text in a cloned slide, **never alter the existing run's font** —
replace run by run, never `text_frame.text = …`. If Geist or Ufficio isn't
installed, flag it (offer the font files in `assets/fonts/`) and allow ~10% size
margin. Fonts: `assets/fonts/Geist-Regular.ttf`, `Geist-Light.ttf`,
`Ufficio-300.otf` (canonical source: `shared/branding/fonts/`).

## Language

Diametral is international: a deck may be written in **French, English, Spanish,
Portuguese, or any other language**. There is no fixed output language.

- **There is no default language.** The deck language is the user's call, every
  time.
- **Mirror the audience / source.** If the brief, RFP, documents, or the request
  are in another language, write the deck in that language. When the request
  does not settle it, **ask which language** before building — never assume one.
- This template's literal placeholder strings are **English** (`KEYWORD`,
  `MAIN TOPIC`, `MM/YEAR`, `Summary`, `First chapter title`, `Title example`,
  `Week 1`, `Phase 1`, `Appendix`, `Thanks for watching!`) — they are **defaults
  to TRANSLATE** into the deck's language, not fixed text. Keep them English only
  when the deck itself is English.
- **Brand signatures stay as the brand sets them**, independent of deck language:
  the `D I A M E T R A L` wordmark, and a closing line the brand keeps in English
  by convention unless the user asks to localise it.
- The unknown-value placeholder is written **in the deck's language**:
  `[À COMPLÉTER]` (FR) · `[TO COMPLETE]` (EN) · `[POR COMPLETAR]` (ES) ·
  `[A COMPLETAR]` (PT).

## Copy & voice (the words on the slide)

Slide copy follows the Diametral **verbal identity** (Confluence-governed source
of truth, bundled in this skill). **Read [`voice-core.md`](voice-core.md)** — the
complete hard rules in digest form (naming, mechanics, register, the 4 tone
profiles, banned words). It is sufficient for slide copy; open the full
[`writing-rules.md`](writing-rules.md) / [`tone-of-voice.md`](tone-of-voice.md)
only for long-form prose or a contested call — they carry the worked ❌/✅ examples.

Slide-specific application: nominal, verdict-like titles; end full sentences with
a period but **short labels/eyebrows need none**. These rules apply per-language:
translate the copy, keep the rules.

## Structure of the template (65 slides)

The template is **all-placeholder** (Lorem ipsum) — zero confidential content, so
it is **both** the visual quality bar **and** the clone source. Slides are
**visible** (no hidden flag): cloning needs no un-hide step.

`template.pptx` = the whole template, 65 slides: **s1–s57 and s64** are the
clonable signatures + content archetypes, s59–s63 are template documentation
(see below). Shape IDs and per-slide geometry:
[references/template-map.md](references/template-map.md).

| Slide   | Role                                                                                                                | Use       |
| ------- | ------------------------------------------------------------------------------------------------------------------- | --------- |
| s1      | Cover — title (2 lines) · `KEYWORD` · `MAIN TOPIC` · `MM/YEAR`                                                      | signature |
| s2–s3   | Summary / table of contents — 4 chapters (s2) or 5 + photo (s3)                                                     | signature |
| s4–s9   | Chapter dividers — act number, question, `SUBJECT`, and the act's **duration**                                      | signature |
| s10     | Subsection title divider — `SUBJECT`, subsection title                                                              | signature |
| s11–s12 | Title + one full text well — **the slide to clone for a bespoke composition**                                       | content   |
| s13–s16 | Title + half text well, with a full-bleed image left or right                                                       | content   |
| s17     | Centred statement + body + two corner images                                                                        | content   |
| s18–s20 | Cards — 3 with icons / 3 numbered (two weight variants)                                                             | content   |
| s21–s22 | 4 numbered steps over a full-width band photo                                                                       | content   |
| s23–s24 | 4 numbered columns                                                                                                  | content   |
| s25     | Pull quote + attribution                                                                                            | content   |
| s26–s28 | One key result — a single number at 106 pt                                                                          | content   |
| s29–s30 | Key figures — 3 × `XX`+`LABEL` / 4 × `XX %`                                                                         | content   |
| s31     | 6 metric tiles with `▲ ▼` deltas                                                                                    | content   |
| s32     | SWOT 2×2                                                                                                            | content   |
| s33–s34 | 5 icon cards + portrait image (image left / right)                                                                  | content   |
| s35     | Keyword cloud                                                                                                       | content   |
| s36     | Feature comparison matrix — 3 options × 4 features                                                                  | content   |
| s37     | Journey map — 5 stages × 3 rows                                                                                     | content   |
| s38     | 3 domains × 4 capabilities                                                                                          | content   |
| s39     | Value chain — 5 primary + 3 support activities                                                                      | content   |
| s40     | Before / After                                                                                                      | content   |
| s41     | Org chart                                                                                                           | content   |
| s42     | 3 options with `PROS` / `CONS` and a `RECOMMENDED` badge                                                            | content   |
| s43     | Pricing — 3 plans with CTA                                                                                          | content   |
| s44     | Stacked bar chart mock (prefer `charts.py` for real data)                                                           | content   |
| s45–s46 | Gantt — 6 weeks × phases, with or without descriptions                                                              | content   |
| s47–s49 | Year-step timelines — 3 / 4 / 5 steps                                                                               | content   |
| s50     | Kanban — 3 columns                                                                                                  | content   |
| s51     | OKR — objective + 3 key results with progress bars                                                                  | content   |
| s52–s53 | Action table (drawn) / a real 8×6 `TABLE` graphic frame                                                             | content   |
| s54     | 5 numbered rows (`01`–`05`)                                                                                         | content   |
| s55     | Pricing — `XX €` rows                                                                                               | content   |
| s56     | 8-item image grid                                                                                                   | content   |
| s57     | Closing — "Thanks for watching!"                                                                                    | signature |
| s58     | Appendix divider                                                                                                    | signature |
| s59–s63 | **Meta/reference** (palette · Phosphor icons · editable-element notes · alternative backgrounds) — **never cloned** | reference |
| s64     | 3 numbered cards on a Kaki wash — an accent break in a long white run                                               | content   |
| s65     | Full-bleed Noir end card with the logo                                                                              | signature |

## Eyebrow grammar (top-of-slide label)

Section / chapter dividers use a **number + label** grammar in Geist Light, caps:

```
0X   ·   [SECTION]   /   [SUBJECT]
```

- `0X` → section/chapter number (`01`, `02`…), Geist 24 pt on dividers.
- `[SECTION]` / `[SUBJECT]` → section or subsection name in capitals (the
  template's `SUBJECT` / `OTHER` placeholders).
- Keep one consistent eyebrow form within a deck.

## Tokens (this is content: replace them)

This template uses **readable English placeholders** rather than `[bracket]`
tokens — replace the visible placeholder text, keeping the run's font/size:

- `Document title…`, `First chapter title`, `Title of the subsection…`,
  `Title example`, `Lorem ipsum…` — replace with real copy.
- `KEYWORD`, `MAIN TOPIC`, `SUBJECT`, `OTHER`, `LABEL` — replace with real labels.
- `MM/YEAR`, `2023`–`2027`, `Week 1`–`Week 6`, `Phase 1`–`Phase 5` — replace
  dates/periods, **keep the format**.
- `XX`, `XX %`, `XX €`, `01`–`05` — metrics/ordinals: replace the digits, **keep
  the unit/format**. Unknown → `[À COMPLÉTER]` (in the deck's language), never an
  invented value.

## Structural motifs (for custom slides)

- **Colored washes for signatures**: cover/closing on sage `AAB0A6`, summary on
  lime `F4FBDA`, dividers on slate `767884` / warm gray `D5D3C4`; a dark `161616`
  variant exists (s34). **Content slides stay white `FFFFFF`.** Rotate washes so a
  deck reads as light content punctuated by colored signatures — don't wash every
  slide.
- **The grid is part of the language**: thin rules divide the canvas (vertical
  thirds at ~x 3.41 / 6.63, horizontal bands). Keep custom slides on that grid.
- Sparing accents: Marron for numerals/rules/eyebrows; red `FF2A00` only on the
  active element; brights only in data. Never an accent as a background fill on a
  content slide.
- Generous margins, one idea per block, left-aligned body; display (Ufficio) can be
  very large. Standard content grid: **x = 0.20 / 2.61 / 5.00 / 7.43**, columns
  ~2.3–2.6 wide; eyebrow/title band at top, body below.
- Capacity: slots are hand-calibrated → **tighten the copy before enlarging a
  box**; overflow is failure mode #1. Budgets per slot are in
  [references/template-map.md](references/template-map.md).

## Data visualization (charts)

Charts are **native and editable** (`scripts/charts.py` — python-pptx charts
with an embedded workbook, never a rendered image) and come pre-styled; the
rules below are what that style encodes, and what any manual tweak must keep:

- **Series-role → colour**: the primary series is **Marron**; **red `FF2A00`
  is the ONE highlighted element** (the bar/slice/line the slide is about —
  `highlight=` / `highlight_series=`); further series take the quiet ramp
  GRIS → KAKI → BEIGE. The **brights** (`FFF73B` warn / `23E2FF` info /
  `53FF64` ok, `DATA_BRIGHTS`) are allowed **only with status semantics** —
  never to make a chart "more colourful".
- **Typography**: everything Geist, ink `161616`, 9–10 pt; axis lines hairline
  GRIS 0.75 pt; value gridlines only, hairline BEIGE; category gridlines off.
- **No chart junk**: no 3D, no shadows, no chart-internal title (the verdict
  belongs in the slide title), no border. Doughnut over pie. Label bars
  directly (`data_labels`) and skip the legend when one series; legend bottom
  only when ≥2 series need naming.
- **Form by relationship**: evolution → line · comparison/ranking → bar
  (horizontal when labels are long) · share of whole → doughnut (≤ ~5 slices)
  · correlation/positioning → scatter. ≥3 numbers sharing a dimension in the
  source → the slide must justify NOT being a chart.

## Diagram language (schematization)

Schemas are drawn with `scripts/diagrams.py` (flow · layers · matrix2x2 ·
funnel · cycle · hub · before_after · swimlane) on the primitives in
`pptx_helpers.py` (`add_box`, `add_arrow`, `add_icon`, `add_table`,
`add_dot`, `draw_grid_axes`) — native shapes, on-grid, editable:

- **Stroke weights**: 0.75 pt hairline for structure (box outlines, grid
  axes), 1–1.25 pt GRIS for arrows/links, 1.25–1.5 pt for the emphasised
  stroke. **No decorative rule** above or under a text block: the short
  Marron bar is a generated-deck marker, not a brand motif.
- **Fill vocabulary**: boxes are WHITE + hairline GRIS; JAUNE_CLAIRE / BEIGE
  washes mark an emphasis or foundation tier. **Accents never fill large
  areas** — `ROUGE` appears as a stroke, numeral, icon or arrow on **the one
  active element per slide** (`active=`), never as a box fill.
- **Icons**: the vendored Phosphor set (`assets/icons/`, `add_icon`), tinted
  to a brand colour — line marks ≤ ~0.5 in, one colour per surface, never
  decorative illustration.
- **The visible grid** (`draw_grid_axes`) may materialise a FEW axes (≤ 3) —
  it structures, it never decorates: « too much system kills the system ».
- Worked bespoke compositions (chart + takeaway, KPI row + sparkband, matrix,
  layers + annotations…) with real coordinates:
  [references/compositions.md](references/compositions.md).
