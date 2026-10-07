# Map of the template (s1–s65) — shape IDs, geometry, pitfalls

Data measured on `assets/template.pptx` (the official template, python-pptx).
**Read this map instead of dumping the shapes live** — it saves the introspection
and avoids the known pitfalls.

Canvas: **10.0 × 5.62 in** (16:9). python-pptx index = slide number − 1
(s11 → `slides[10]`). All slides are **visible** (no hidden flag).

s1–s57 are the clonable library; **s58–s65 are documentation** (palette, icons,
editable-element notes, alternative backgrounds) — read them, never clone them.

## ⚠ Pitfalls (each one would otherwise cost a debug round-trip)

1. **Select by `shape_id`, never by name.** The template is a Google Slides export:
   shape _names_ (`Google Shape;185;p9`) are copied when a slide is duplicated and
   point at the wrong page — only `shape_id` (the `<p:cNvPr id>`) is reliable, and
   it is unique **within** a slide. Use `sh.shape_id`.
2. **The title/eyebrow shape_id is NOT consistent across slides.** Duplicated slides
   kept a small id (often `2`, `3` or `4`) for the title; freshly drawn slides use a
   large id. The per-slide tables below give the real id — don't assume a schema.
3. **`finalize(prs, [idx])` takes the same index you cloned.** It keeps slides by
   0-based index, so editing `slides[10]` and calling `finalize(prs, [4])` silently
   saves a _different, untouched_ slide. The deck builds, the lint passes on the
   wrong slide, and the mistake only shows in the render. Keep the two in step.
4. **Slides are visible** — there is **no un-hide step**. Cloning + reorder is
   enough; do not look for `show="0"`.
5. **Keep the decoration.** Most slides carry `<LINE>` grid rules (counted per
   slide below), empty background rectangles (e.g. s18 ids 503–505) and **Phosphor
   icon PICTUREs** (e.g. s18 ids 524–526). They have no text — leave them in place;
   they are the visual frame. Replace only the text/`PICTURE` slots listed below.
6. **Page-number footer**: at **L9.37 T5.31** (it moved from L9.52 in the previous
   template — a build that still writes to the old coordinate misses it). Six slides
   carry none at all: s1, s57, s60, s61, s62, s65. After reorder, renumber the
   footer to match the new position (or blank it).
7. **Replace text run-by-run** (never `text_frame.text = …`) to preserve the run's
   Geist/Ufficio font and size. **Two-line titles break with an `<a:br/>` element
   inside one paragraph** (python-pptx reads it back as `\x0b`). To write a break,
   pass `"Première ligne\nseconde ligne"` to `pptx_helpers.set_text` (a single
   string with `\n` → it inserts `<a:br/>`). **Never put a literal `\x0b`/`\v` in
   run text** — OOXML escapes it to the visible junk `_x000B_`. Do not split a
   wrapped title into separate paragraphs (it re-anchors and clips the top line).
8. **Narrow label boxes wrap — fit them to content.** The cover labels (MAIN
   TOPIC/KEYWORD/MM-YEAR) and other AUTO*SHAPE labels are sized for the
   \_placeholder*; a longer value wraps (`PROPOSITION` → `PROPOSITIO / N`) or
   collides. After `set_text`, call `pptx_helpers.fit_box(shape)` (or
   `fit_boxes(slide, ids)`) — it measures the real glyph width with the brand TTF
   and grows the box to one line, keeping its grid position: a box whose edge
   sits ON a grid rule keeps that edge (the divider `SUBJECT` is flush-right on
   x1.727, its duration flush-left on x8.353), otherwise LEFT labels grow right
   and CENTER labels grow both ways. Grow-only by default; pass `shrink=True`
   to also tighten short labels. **Judge these across slides, not on one**: a
   label growing from its centre looks fine alone and gives four dividers four
   different positions.
9. **Fractional font sizes mean `normAutofit` already shrank the box.** s21–s22
   (25.5 / 20.25 / 17 pt), s32 and s40 (10.13), s33–s34 (12.75 / 9.75), s42 (9.38),
   s50 (10.13) and s52 (12.75 / 10.13) report scaled sizes, not design sizes. Two
   consequences: the nominal size is larger than what you read back, and
   **LibreOffice ignores `fontScale`** — it renders the unscaled size, so an LO
   render of those slides overstates overflow. Judge them in PowerPoint, or treat
   the structural budget below as the truth.
10. **s53 holds a real `TABLE` graphic frame** (8 rows × 6 cols, id 3), not drawn
    text boxes. Edit it through `shape.table`, not `shp()`/`set_text`.

## The file's own defaults are the Charte

The template is a Google Slides export, so its theme `fontScheme` and its
list-style fallbacks originally carried Office defaults (Arial, pure black)
even though every visible run was correct. `brand_template.py` rewrote them:
`majorFont` = Ufficio 300, `minorFont` = Geist, fallback ink = `161616`, and
symbol-font bullets (Wingdings `§`) → the template's own Geist `•`.

**Re-run the full procedure after any re-export of the template:**

```bash
python shared/slides/scripts/shrink_template.py shared/slides/assets/template.pptx
python shared/slides/scripts/brand_template.py  shared/slides/assets/template.pptx
python shared/slides/scripts/lint_deck.py --strict --template shared/slides/assets/template.pptx
```

Four geometry repairs were applied by hand to the current file and are **not**
scripted — redo them after a re-export if the lint flags them again:

- s13 and s54 carried shapes parked entirely off-canvas (a `New` badge, an empty
  box). Removed: invisible, but cloned into every deck built from those slides.
- s26/s27/s28 ids 2 and 3 overhung the right edge by 0.45 in (W 9.99 → **9.08**).
  The text is left-aligned, so nothing moved.
- s16 and s44 each carried **two** page-number boxes, the second at the previous
  template's L9.52. Removed the stale one — a renumber pass updates only one.
- s33/s34 ids 15 and 21 (the top-row card descriptions) were H 0.44 where their
  identical bottom-row siblings are H **0.62**. Grown to match: the short box
  clones into every deck built from those slides, and real copy runs longer than
  the Lorem ipsum. The card container has the room (new bottom 3.04 < 3.22).

The current file lints **0 errors and 0 warnings** under `--strict`.

## Checking a generated deck

`lint_deck.py` is the mechanical half of QA — it needs only python-pptx, so it
also works where LibreOffice is absent. It fails on a non-brand font, an
off-palette hex, red on more than one element, a surviving placeholder, text
off-canvas or under the footer, and a **literal** page number left stale after
a reorder (a `slidenum` field is exempt — PowerPoint recomputes it). Overflow
is reported as a WARN because it is estimated from font metrics; the estimate
honours `normAutofit/@fontScale`, since PowerPoint really does render those runs
shrunk, but ignores `lnSpcReduction` so it stays pessimistic on height. Run
`lint_deck.py --selftest` to confirm every check still fires.

## Common template for content slides

| Element       | Typical id              | Geometry (in)                              | Style                 | Safe capacity                                                                                                                                                                                                                             |
| ------------- | ----------------------- | ------------------------------------------ | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Title         | varies (2/3/4 or large) | L0.16–0.36 · T0.18–0.32 · W4.5–9.7 · H0.85 | Ufficio 300 **23 pt** | **ONE line, ≤ ~48 chars** — the box is bottom-anchored/noAutofit and Ufficio's tall metrics push a 2nd line above the canvas (verified: 2-line titles clip). Two-line titles are for cover/dividers only, whose boxes are sized for them. |
| Body          | varies                  | L0.36 · T1.5 · W4.3–7.9 · H3.49            | Geist Light **12 pt** | tighten copy; overflow = failure #1                                                                                                                                                                                                       |
| Eyebrow/label | varies                  | top band                                   | Geist Light 9–18 pt   | ≤ ~20 chars                                                                                                                                                                                                                               |

Standard content column grid: **x = 0.20 / 2.61 / 5.00 / 7.43** (4-up),
**0.20 / 3.41 / 6.63** (3-up) or **0.46 / 3.53 / 6.61** (3-up card grid, W2.93);
body band starts ~T1.5, footer line at T5.31.

Content-slide titles come in two boxes: the **narrow** one (L0.36 W4.49–6.63,
23 pt, one line) on slides with a side image or a card grid, and the **wide**
one (L0.16–0.34 W7.91–9.69, 23/24 pt, two lines via `<a:br/>`) on full-width
slides. The tables below say which.

## Slide families at a glance

| Slides  | Family                                      | Wash             |
| ------- | ------------------------------------------- | ---------------- |
| s1      | Cover                                       | Kaki `AAB0A6`    |
| s2–s3   | Summary / TOC (4 and 5 chapters)            | `F4FBDA`         |
| s4–s9   | Chapter dividers `01`–`05` + `XX`           | full-bleed photo |
| s10     | Subsection divider                          | Beige `D5D3C4`   |
| s11–s17 | Text slides (full well, halves, images)     | white            |
| s18–s24 | Card grids (3 and 4 up), numbered steps     | white / `F4FBDA` |
| s25     | Pull quote + attribution                    | Gris `767884`    |
| s26–s31 | Figures: one big result, 3-up, 4-up, tiles  | `F4FBDA` / white |
| s32–s43 | Frameworks: SWOT, journey, chain, pricing   | white / Beige    |
| s44–s49 | Time: chart, Gantt, timelines, year steps   | white            |
| s50–s56 | Delivery: kanban, OKR, actions, table, grid | white            |
| s57     | Closing                                     | Kaki `AAB0A6`    |
| s58     | Appendix divider                            | Gris `767884`    |
| s59–s63 | **Documentation — never clone**             | white / `F4FBDA` |
| s64     | 3 cards, alternative style                  | Kaki `AAB0A6`    |
| s65     | Full-bleed logo end card                    | Noir `161616`    |

---

## Signatures (s1–s10, s57–s58)

### s1 · Cover (idx 0) — wash `AAB0A6`, no page number

| id     | Slot                   | Style                          | Capacity                                        |
| ------ | ---------------------- | ------------------------------ | ----------------------------------------------- |
| 26     | Title (2 §)            | Ufficio **52 pt**, W9.21×H1.60 | ~19 chars/line, 2 lines                         |
| 30     | `MAIN TOPIC`           | Geist Light 16 pt              | narrow box; longer text → `fit_box` (pitfall 8) |
| 27     | `KEYWORD`              | Geist Light 16 pt              | narrow box; longer text → `fit_box`             |
| 31     | `MM/YEAR`              | Geist Light 16 pt              | `fit_box` grows it both ways                    |
| 28, 29 | Logo / footer PICTUREs | —                              | keep                                            |

### s2 · Summary, 4 chapters (idx 1) — wash `F4FBDA`

id **36** `Summary` (Ufficio 50 pt) · chapters (number, title): **(55, 51) (56, 52)
(57, 53) (58, 54)** — number Geist, title Geist Light **24 pt** at x3.41 W6.43.
Page-num id 3. Delete an unused chapter's number+title pair.

### s3 · Summary, 5 chapters + photo (idx 2) — wash `F4FBDA`

id **36** `Summary` · chapters (number, title): **(11, 3) (12, 4) (13, 5) (14, 6)
(9, 8)** — number Geist Light 11 pt at x6.05, title 16 pt at x6.49. PICTURE id 2
(L3.28 T1.30 W3.15×H3.11). Page-num 7. Prefer s3 when there are 5 sections.

### s4–s9 · Chapter dividers (idx 3–8) — full-bleed photo

Same frame six times; only the act numeral differs (s4 `01` … s8 `05`, s9 `XX`).

| id    | Slot                                      | Style                                                  |
| ----- | ----------------------------------------- | ------------------------------------------------------ |
| 17    | The question (2 §)                        | Ufficio **50 pt**, W6.47×H1.51                         |
| 19    | Act number `01`                           | Ufficio 32 pt                                          |
| 16    | `SUBJECT`                                 | Geist Light 12 pt — box flush-right on the x1.727 rule |
| 11/12 | `Chapter title as written in the summary` | Geist Light 12 pt                                      |
| 20    | `xx’` — the act's **duration in minutes** | Geist Light 12 pt — box flush-left on the x8.353 rule  |
| 2     | Full-canvas photo AUTO_SHAPE              | keep (swap the fill)                                   |

Page-num id varies: 18 (s4), 14 (s5, s7, s8), 11 (s6, s9). The `xx’` slot is what
makes a deck read as a meeting — fill it or delete it, never leave `xx`.

### s10 · Subsection divider (idx 9) — wash `D5D3C4`

id **170** `SUBJECT` (Geist Light) · **157** title (Ufficio **40 pt**, W6.28×H1.28).
Page-num 3.

### s57 · Closing (idx 56) — wash `AAB0A6`, no page number

id **1710** `Thanks for watching!` (Ufficio 24 pt, 2 §) · **3** logo PICTURE ·
**1700** bottom-band PICTURE (L0.20 T3.62 W9.65×H1.82).

### s58 · Appendix divider (idx 57) — wash `767884`

id **149** `Appendix` (Ufficio **47 pt**). Page-num 2.

---

## Text slides (s11–s17)

### s11–s12 · Title + full text well (idx 10–11) — the default content slide

id **3** title (narrow, L0.36 W6.63, 23 pt) · **186** body well (L0.36 T1.50
W7.91×H3.49, Geist Light 12 pt). Page-num 4. One LINE rule at T1.16.

**This is the slide to clone for a bespoke composition**: delete id 186 and draw
into the freed band (`compositions.md`). s11 and s12 are identical — use s12 when
you need two of them.

### s13 · Title + left-half text (idx 12)

id **4** title (L0.36 W4.49) · **281** body (L0.36 T1.50 W4.26×H3.49). Page-num 12.
Vertical rule at x5.00 splits the canvas; the right half is yours to draw in.

### s14 · Title + right-half text + full-bleed LEFT image (idx 13)

id **4** title (L5.15 W4.49) · **331** body (L5.15 T1.50 W4.47×H3.49) · **7**
image PICTURE (L0.20 T0.22 W4.80×H5.21). Page-num 5.

### s15 · Title + left-half text + full-bleed RIGHT image (idx 14)

id **4** title (L0.36 W4.49) · **281** body (L0.36 T1.50 W4.26×H3.49) · **5**
image PICTURE (L5.04 T0.21 W4.80×H5.21). Page-num 12.

### s16 · Title + 2 stacked text blocks + image (idx 15)

id **6** title (L0.36 W4.49) · **386** upper block (T1.58 H1.01) · **385** lower
block (T3.01 H1.97) · **3** image PICTURE (L5.00 T3.02 W4.84×H2.40) · **2** panel
AUTO_SHAPE (L5.00 T0.22 W4.84×H2.38, the upper-right fill). Page-num 7.

### s17 · Centred statement + body + 2 corner images (idx 16)

id **450** statement (L2.79 T2.05 W4.43×H0.85, Ufficio 23 pt) · **451** body
(L2.01 T3.17 W6.03×H2.03, Geist 12 pt) · images **434** (top-left) / **6**
(bottom-right). Page-num 3.

---

## Card grids and numbered steps (s18–s24)

### s18 · 3 cards with icons (idx 17)

title **523** (wide, L0.16 W9.69) · cards (title, desc): **(515, 514) (517, 516)
(519, 518)** — title Geist Light 18 pt, desc 12 pt (W2.31×H2.03). Icon PICTUREs
**526, 525, 524** (left→right); background rects **503, 504, 505** (keep).
Page-num 2. Card grid x = 1.00 / 3.71 / 6.43, W2.61.

### s19–s20 · 3 numbered cards (idx 18–19)

title **2** (wide) · numbers **600 601 602** (`01 02 03`) · titles **599 604 606** ·
descs **598 603 605**. Page-num 4. Same geometry on both; s19 sets its copy in
Geist Light, s20 in Geist — pick the one whose weight you want.

### s21–s22 · 4 numbered steps + full-width band photo (idx 20–21)

title **4** (wide, 23 pt) · per step (marker, number, title, desc):
**(5, 6, 7, 8) (21, 38, 23, 24) (25, 39, 27, 28) (29, 40, 31, 32)** at
x = 0.35 / 2.78 / 5.21 / 7.67. Band PICTURE id **9** (s21) / **12** (s22) at
T3.23 W10.0×H1.68. Page-num 49 (s21) / 11 (s22).
⚠ Sizes read back scaled (25.5 / 20.25 / 17 pt) — see pitfall 9.

### s23–s24 · 4 numbered columns (idx 22–23)

title **3** (wide, 2 §) · per column (number, title, desc): **(681, 680, 679)
(685, 684, 683) (688, 687, 686) (691, 690, 689)** — number Geist Light 12 pt at
T1.07, title 18 pt, desc 12 pt (W2.25×H2.66). Page-num 2. Grid x = 0.20 / 2.61 /
5.00 / 7.43. Identical layouts; s24 is the spare.

---

## Figures (s25–s31)

### s25 · Pull quote + attribution (idx 24) — wash `767884`

id **3** opening `“` (Ufficio 54 pt) · **4** the quote (Ufficio **24 pt**,
L0.37 T2.38 W8.28×H1.48) · **8** `Name SURNAME` · **9** `Role` (Geist Light 12 pt).
Page-num 10. The quote box holds ~3 lines — cut, don't shrink.

### s26–s28 · One key result (idx 25–27)

id **2** eyebrow `KEY RESULT` (Geist Light **9 pt**) · **3** the number
(Ufficio **106 pt**, L0.46 T2.24 W9.08×H1.47) · **4** the gloss (Geist Light
16.5 pt, W6.44). Page-num 5. Three identical slides — the deck's loudest move;
spend it at most twice. Nothing else belongs on this canvas.

### s29 · 3 key figures `XX` + LABEL (idx 28)

title **3** (wide, 2 §) · numerals **869 871 873** (Geist Light **72 pt**) ·
labels **870 872 874** (`LABEL`, 12 pt, at T1.50) · contexts **877 878 879**
(12 pt, T3.89). Page-num 4. Columns x = 0.23 / 3.45 / 6.66.

### s30 · 4 key figures `XX %` (idx 29)

title **3** · numerals **948 950 952 954** (Geist Light **60 pt**) · `%`
**949 951 953 955** (24 pt) · contexts **958 959 960 961** (12 pt, above the
numerals at T1.96). Page-num 4. Columns x = 0.24 / 2.64 / 5.05 / 7.44.

### s31 · 6 metric tiles (idx 30) — wash `D5D3C4`

title **33** (wide) · per tile (panel, label, value, delta):
**(4, 5, 6, 7) (8, 9, 10, 11) (12, 13, 14, 15) (16, 17, 18, 19) (20, 21, 22, 23)
(24, 25, 26, 27)** — label Geist Light 9 pt, value Ufficio 31.5 pt, delta 9 pt
(`▲ +XX% vs. LY` / `▼ −XX%`). Page-num 2. Grid x = 0.46 / 3.53 / 6.61, rows
T1.12 / T3.21, tile W2.93×H1.95. The `▲ ▼` glyphs are Geist — keep them.

---

## Frameworks (s32–s43)

### s32 · SWOT 2×2 (idx 31)

title **21** (wide) · quadrants (panel, heading, body): **(4, 5, 6) Strengths ·
(7, 8, 9) Weaknesses · (10, 11, 12) Opportunities · (13, 14, 15) Threats**.
Page-num 2. Panels W4.47×H1.86 at x0.46/5.07, y1.21/3.19. Body reads back at
10.13 pt (pitfall 9).

### s33–s34 · 5 icon cards + portrait image (idx 32–33)

Image left (s33, PICTURE **19** at L6.62) or right (s34, PICTURE **3** at L0.43) —
read the id, the layouts mirror. Per card (panel, badge, number, title, desc):
**(10, 11, 12, 14, 15) (16, 17, 18, 20, 21) (4, 5, 6, 8, 9) (23, 24, 25, 27, 28)**
plus a fifth, image-side card (**19/33, 26/34, 29/35**) that has **no description**.
Title Geist 12.75 pt, desc Geist Light 8 pt. Title id **13** (narrow). Page-num 2
(s33) / 30 (s34). Icon PICTUREs 7, 22, 31, 40 — keep.

### s35 · Keyword cloud (idx 34)

title **2** (wide) · keywords **1149–1162** (13 shapes, Geist 18 / 30 / **48** pt —
1149 is the big one). Page-num 3. Drop unused shapes for a sparser cloud; keep the
size mix or it stops reading as a cloud.

### s36 · Feature comparison matrix (idx 35)

title **39** (narrow, W6.23) · option headers **4** `Option A` / **6** `Option B` /
**7** `Option C` · feature rows **9 15 21 28** (Geist Light 10.5 pt, L0.46 W3.03) ·
cells (A, B, C) per row: **(10, 12, 13) (16, 18, 19) (22, 24, 25) (29, 31, 32)** —
each holds `✓` or `—` (Geist 12 pt). Page-num 2.

### s37 · Journey map, 5 stages × 3 rows (idx 36)

title **54** (narrow) · stage headers **5 7 9 11 13** (`Awareness … Advocate`) ·
row labels **14** `Actions` / **25** `Pain points` / **36** `Opportunities` ·
cells left→right: Actions **16 18 20 22 24**, Pain points **27 29 31 33 35**,
Opportunities **38 40 42 44 46** (Geist Light 9 pt). Page-num 2.
Columns x = 1.46 / 3.09 / 4.72 / 6.35 / 7.97, W1.57.

### s38 · 3 domains × 4 capabilities (idx 37)

title **40** (narrow) · domain headers **5 15 25** · capabilities per domain:
**(7, 9, 11, 13) (17, 19, 21, 23) (27, 29, 31, 33)** (Geist Light 10 pt).
Page-num 2. Columns x = 0.46 / 3.53 / 6.60, W2.94.

### s39 · Value chain — 5 primary + 3 support (idx 38)

title **33** (narrow) · **4** `PRIMARY ACTIVITIES` eyebrow · activities
(title, kind): **(6, 7) (9, 10) (12, 13) (15, 16) (18, 19)** · **20**
`SUPPORT ACTIVITIES` eyebrow · support rows **22 24 26** (full width, W9.00).
Page-num 2.

### s40 · Before / After (idx 39)

title **16** (narrow, W6.23) · **5** `BEFORE` + **6** its body · **8** `AFTER` +
**9** its body (both W4.08×H1.15, reads back 10.13 pt). Panels **4** / **7**
(W4.46×H3.63), pills **17** / **19**. Page-num 2.

### s41 · Org chart (idx 40)

title **48** (narrow) · root (box, title, role): **(18, 19, 20)** · three branches
**(24, 25, 26) (49, 50, 51) (56, 57, 58)** each with two member pills
**(27, 28)+(29, 30)**, **(52, 53)+(54, 55)**, **(59, 60)+(61, 62)**. Page-num 79.

### s42 · 3 options with PROS / CONS (idx 41)

title **39** (narrow) · per option (panel, header bar, name, summary, `PROS`,
pro rows, `CONS`, con row):
**(4, 5, 6, 7, 8, [9, 10], 11, [12])** · **(13, 14, 15, 18, 19, [20, 21], 22, [23])**
· **(24, 25, 26, 27, 28, [29, 30], 31, [32])**. The middle option carries the
**`RECOMMENDED` badge (16, 17)** — move it, don't duplicate it. Page-num 2.

### s43 · Pricing, 3 plans (idx 42)

title **50** (narrow) · per plan (panel, name, price, period, 4 bullets, CTA):
**(33, 34, 35, 36, [39, 41, 43, 45], 47)** · **(51, 52, 53, 54, [56, 58, 60, 62], 64)**
· **(65, 66, 67, 68, [70, 72, 74, 76], 78)**. Price Geist Light **40 pt**.
Page-num 79. Bullet dots (38, 40, 42, 44 …) are AUTO_SHAPEs — keep.

---

## Time (s44–s49)

### s44 · Stacked bar chart mock (idx 43)

title **4** (narrow) · bars per category, bottom→top: Cat A **(5, 6, 7)**, Cat B
**(31, 32, 33)**, Cat C **(35, 36, 37)**, Cat D **(39, 40, 41)** · category labels
**8 34 38 42** · legend swatches+labels **(25, 26) (27, 28) (29, 30)** · **43** the
right-hand panel (L6.28 W3.72, full height). Page-num 47.
Set each bar's `.top`/`.height` to encode the values. For a real chart prefer
`charts.py` on a cloned s11 — this slide is for a hand-tuned mock.

### s45 · Gantt — 6 weeks × 5 phases (idx 44)

title **2** (wide, 2 §) · week headers **1175–1180** · phase bars **1188–1192**
(`Phase 1`–`Phase 5`; the bar's `.left`/`.width` encodes the span). Page-num 4.
Week columns x = 0.20 / 1.80 / 3.41 / 5.02 / 6.63 / 8.23, W1.61.

### s46 · Timeline with descriptions (idx 45)

title **4** (wide) · week headers **1205–1210** (at T4.23, **below** the band) ·
phase bars **1213 1214** · descriptions **1221–1226** alternating high/low
(T1.24 / T2.24). Page-num 5.

### s47–s49 · Year-step timelines (idx 46–48)

Pairs (description, year label) — the ids are **not** in left→right order, so
verify `.left` before mapping content:

- **s47**, 3 steps: **(1240, 1241) (1243, 1244) (1246, 1247)** at x = 1.00 / 4.21 / 7.43.
- **s48**, 4 steps: **(1263, 1264) (1269, 1270) (1272, 1273) (1266, 1267)** at
  x = 0.43 / 3.05 / 5.67 / 8.23 — note 1266/1267 is the **last** column.
- **s49**, 5 steps: **(1289, 1290) (1292, 1293) (1295, 1296) (1298, 1299)
  (1301, 1302)** at x = 0.43 / 2.37 / 4.31 / 6.27 / 8.23, plus band PICTURE **9**.

Title id 5 (s47) / 4 (s48, s49); page-num 6 / 5 / 6. Each step has a small marker
square (1239, 1262, 1288 …) — keep.

---

## Delivery (s50–s56)

### s50 · Kanban, 3 columns (idx 49)

title **30** (narrow) · column headers **5** `To do` / **13** `In progress` /
**19** `Done` · cards (panel, text): To do **(6, 7) (8, 9) (10, 11)**, In progress
**(14, 15) (16, 17)**, Done **(20, 21) (22, 23)**. Page-num 2.
Columns x = 0.46 / 3.53 / 6.61, W2.93.

### s51 · OKR — objective + 3 key results (idx 50)

title **34** (narrow) · **5** `OBJECTIVE` eyebrow + **6** the objective
(Ufficio 16.5 pt, in panel 4) · per key result (panel, label, percent, text,
track, fill): **(7, 8, 9, 10, 11, 12) (14, 15, 16, 17, 18, 19)
(21, 22, 23, 24, 25, 26)**. Page-num 2.
The progress bar is two AUTO_SHAPEs: the **track** (W4.75) and the **fill** —
set the fill's `.width` to `4.75 × percent` and keep the percent label in step.

### s52 · Action table, 4 rows (idx 51)

title **36** (narrow) · header row **5** `#` / **6** `Action` / **7** `Owner` /
**8** `Timeline` · rows (number, action, owner, timeline): **(11, 12, 13, 14)
(16, 17, 18, 19) (21, 22, 23, 24) (26, 27, 28, 29)**. Page-num 2.
Columns: `#` L0.58, action L1.00 W6.32, owner L7.38, timeline L8.52.

### s53 · Real table (idx 52)

title **36** (narrow) · **id 3 is a `TABLE` graphic frame, 8 rows × 6 columns**
(L0.42 T1.47 W9.15×H3.24). Edit via `shape.table.cell(r, c)`; `shp()`/`set_text`
do not apply. Page-num 2. For a branded drawn table instead, see `add_table` in
`compositions.md` recipe 6.

### s54 · 5 numbered rows (idx 53)

title **3** (wide, 2 §) · rows (number, title, desc): **(765, 764, 763)
(769, 768, 767) (773, 772, 771) (777, 776, 775) (781, 780, 779)** — number Geist
Light 12 pt at L0.20, title 18 pt and desc 12 pt at L4.21 W5.59. Page-num 5.
Delete a row's 3 texts to shorten.

### s55 · Pricing rows (idx 54)

title **3** (wide) · prices **1042–1046** (Geist **48 pt** `XX €`, L4.21) · row
titles **1050 1052 1054 1056 1058** (18 pt, L0.20 W4.01) · row descs
**1049 1051 1053 1055 1057** (12 pt, L7.34). Page-num 4.

### s56 · 8-image grid (idx 55)

title **2** (wide) · captions **1623–1630** (Geist Light 11 pt) · images: top row
AUTO_SHAPEs **5, 7, 9, 11** (T0.67) and bottom row PICTUREs **6, 14, 16, 3**
(T3.15). Page-num 4. Replace image bytes in place to keep position (see
edit-slides). Columns x = 0.20 / 2.60 / 5.01 / 7.42, W2.41.

---

## Alternative style and documentation (s59–s65)

- **s59** palette reference (`MAIN PALETTE` / `SECONDARY PALETTE` swatches).
- **s60** the icon set and its source (`https://phosphoricons.com`).
- **s61 / s62** "all elements are editable" notes, dark and white versions.
- **s63** alternative background styles.
- **s64** the s19 card layout on a Kaki `AAB0A6` wash — the one **clonable** slide
  in this range, for an accent break inside a long white run.
- **s65** full-bleed Noir end card with the logo, no page number.

s59–s63 are documentation: read them for the Charte, never clone them into a deck.

## Recommended build pattern

A single idempotent `build.py` that restarts from the copy of `template.pptx` on
every run: open the copy → clone the chosen slides → edit by `shape_id` (tables
above) → `finalize(prs, [same indices you edited])` (pitfall 3) → renumber the
page-number footers → `fit_box` the narrow label boxes → save. No un-hide step is
needed (slides are visible). Every QA fix = a full re-run. Helpers in
`scripts/pptx_helpers.py`.
