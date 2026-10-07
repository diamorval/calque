# Workflow: review (audit and polish an existing deck)

**Purpose.** Turn a "finished" deck into a polished one. Two deliverables, in order: (1) a review
report, a fix plan grouped by severity, each item naming the slide and the exact before → after;
(2) on approval, the deck with the safe fixes applied and re-verified. Read as a proofreader
(text) and a designer (layout). Audit against the deck's own conventions; impose the pack only
when the deck is on a pack.

**Not this workflow:** the user names a specific change → [edit](edit.md).

## Reads

- The deck (`open_deck` / `import_pptx`): display order, hidden slides, all text including grouped
  shapes, shapes by `shape_id`.
- `list_comments`: open comments are review input.
- On a pack deck: `pack://<id>/voice`, `pack://<id>/DESIGN.md`, `core/doctrine.md`,
  `core/anti-slop.md`.

## Steps

1. **Inspect.** Load the deck; read everything before judging. Note hidden slides (backup
   variants): their numbering still matters if un-hidden.
2. **Lint.** `lint_deck` on a pack deck: ERRORs (off-pack font, off-palette colour, surviving
   placeholder, off-canvas text, stale page number, anti-slop ERROR) go in the report as bugs;
   WARNs are confirmed on the render first. On a deck not on any pack, skip pack rules and audit
   against the deck's own conventions.
3. **Render and look** at every visible slide. Beyond about 8 slides, `review_deck` gives a
   fresh-eyes pass with the visual checklist below; merge its findings.
4. **Audit**, slide by slide, roughly by how badly each embarrasses:
   - **Spelling and grammar** in the deck's language, including grouped-shape text.
   - **Numbering and structure**: narrative order; closing slide last among visible slides;
     section eyebrows matching the divider they sit under; sequence labels (`1/4`…) without gaps
     once hidden slides are removed; section numbers that skip.
   - **Typography consistency**: one style for apostrophes, quotes, spacing around punctuation,
     number writing, units, arrows, dates.
   - **Voice**: on a pack deck, the pack `voice` rules; always, the [anti-slop](../anti-slop.md)
     tells, including those no regex sees (agenda of nouns, takeaways or thank-you closer,
     symmetric bullets, topic titles, cliché icons).
   - **Narrative coherence**: one thing named two ways, contradictory claims, a metric stated
     differently twice, "4 phases" that lists 3.
   - **Layout** (from the render): overflow or clipping, overlaps, inconsistent cards in a row,
     lopsided grids, misaligned columns, low contrast, margins under `grid.margin_in` (about 5% of
     the canvas width on a non-pack deck).
   - **Form–content fit**: runs of 3+ same-form slides; 3+ same-dimension numbers as prose
     (propose the chart); process or system as bullets (propose the diagram); a chart with no real
     data; `role.color.status.*` used decoratively; `role.color.highlight` on more than one
     element.
   - **Facts to verify**: striking figures and named sources, flagged for the user, never
     asserted as correct.
5. **Report.** Findings grouped by the categories above, each with slide, `shape_id` where useful,
   and exact before → after. Separate **safe auto-fixes** (typos, normalisation, eyebrow tags,
   numbering once a rule is chosen) from **judgment calls** (renumber vs un-hide, renaming, any
   redraw, fact checks). Ask one consolidated question on the judgment calls. Anything that could
   expose sensitive information defaults to the cautious option.
6. **Apply** the approved fixes with `patch_deck` (run-level text, structure). A form redraw is a
   judgment call: apply it only if approved, as a DeckSpec change.
7. **Verify** by re-rendering only changed slides; `lint_deck` again on a pack deck.
8. **Deliver.** `export_pptx`, the list of applied fixes, and the judgment calls left to the user.

## Visual checklist (render pass, or `review_deck`)

User-visible defects only: overflow or clipping; overlaps (text over shapes, lines through words);
a decoration sized for a one-line title that wrapped; footers colliding with content; uneven gaps
and lopsided grids; misaligned or inconsistent repeated cards; low-contrast text or icons; margins
too tight; leftover placeholders; 3+ same-form slides, or numeric/process content shipped as
bullets (judgment call). Skip sub-pixel nitpicks.

## Stop conditions

- **Report first, never fix before approval** (except when the user asked for "fix everything
  safe", then still list what was applied).
- **Never auto-apply a redesign.** Form changes are proposals with a concrete alternative.
- Audit **visible** slides by default; report hidden-slide issues separately.
- **One fix-and-verify cycle** is enough.
- **Done** when the report is delivered and, if approved, the fixes are applied, lint is clean
  (pack deck) and the changed slides were re-rendered.
