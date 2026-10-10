# Workflow: draft (one or a few standalone slides)

**Purpose.** Draw one or a handful of standalone slides on the active pack (a key figure, a
comparison, a use case, a team slide) that the user drops into their own deck. No narrative arc,
no deck ceremony.

**Not this workflow:** a whole deck → [build](build.md); change slides already in a deck →
[edit](edit.md).

## Reads

`pack://<id>/template-map`, `pack://<id>/DESIGN.md`, `pack://<id>/exemplar`,
`pack://<id>/voice`; `core/doctrine.md`, `core/compositions.md`, `core/anti-slop.md`.

## Steps

0. **Pack.** If none is active, `list_packs` and ask (one pack → use it).
1. **Understand the ask.** Read the exemplar: the slide must pass for a finished slide, not a
   filled template. For each slide: what does it say, which message type, which form (doctrine
   table). Mine any supplied facts. One question at a time, with your recommended answer, only on
   a real blind spot (a missing figure, the audience). A clear ask means zero questions.
2. **Write the DeckSpec**: one entry per slide, `{message, message_type, form, source}`. No
   `cover`, `summary`, `divider` or `closing` unless that exact slide was requested. Copy fitted to
   capacities, unknowns as `missing_value[<lang>]`, anti-slop checklist applied.
3. **Create.** `create_deck` with the DeckSpec (a fresh deck holding only these slides). When
   the user asks to add the slides to a deck open in Calque, `add_slides` them into that deck
   instead (its pack and language; by default before the closing slide).
4. **Lint → render → fix** (doctrine), re-checking only the changed slide.
5. **Deliver.** `export_pptx`, the list of `missing_value` items, and the reminder: to place the
   slides in an existing deck, copy-paste them in the presentation software (native paste keeps
   layout and fonts), or `import_pptx` the target deck and use [edit](edit.md).

## Stop conditions

- **Hand off to build** when the request is really a presentation (an arc, sections, a cover).
- **Never change the slides already in a deck** here; that is edit. Adding new slides to an
  open deck with `add_slides` is this workflow.
- **Done** when lint has zero ERROR, each slide was looked at after its last change (or the user
  was told it was not), and each slide could drop into a real deck without looking like a filled
  template.
