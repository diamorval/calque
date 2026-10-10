# Workflow: build (a whole deck)

**Purpose.** Produce a whole deck (cover → sections → content → closing, with a narrative arc) on
the active pack, from a prompt, documents, images or an agreed storyline. Imitate the template,
do not fill it: signatures are cloned for identity, content slides are derived from their message.

**Not this workflow:** one or a few standalone slides → [draft](draft.md); change an existing deck
→ [edit](edit.md); audit a deck → [review](review.md); design the narrative with a human first →
[storyline](storyline.md).

## Reads

| Resource | For |
| --- | --- |
| `pack://<id>/template-map` | Roles, archetypes, slot `shape_id`s, capacities. |
| `pack://<id>/DESIGN.md` | Role bindings, type scale, icon and image vocabulary. |
| `pack://<id>/exemplar` | What a finished slide and deck look like (step 2). |
| `pack://<id>/voice` | Copy rules, banned words, signatures that stay untranslated. |
| `pack://<id>/storyline` | Deck types and archetypes, when the deck follows one. |
| `core/doctrine.md`, `core/compositions.md`, `core/anti-slop.md` | Always. |

## Steps

0. **Pack.** If no pack is active, `list_packs` and ask which one (one pack → use it).
1. **Ingest.** Read every supplied document and image; mine the facts before speaking. Files the
   user attached are listed under "Attached files" (documents with their text). An uploaded image
   goes into a picture slot as `"image": "file:<file_id>"`; a file you hold yourself is uploaded
   through `upload_url` first, never pasted as base64. If an agreed storyline exists, it is the
   outline: do not re-argue it.
   **Proof comes from the slide library.** Before naming a gap for a proof point (a case study, a
   reference, a client logo, a team bio, standard boilerplate), search the pack's approved slides
   with `library_list` (words of the audience's sector, function or offer; then tags). A match is
   placed with `library_insert` after `create_deck` and adapted with `patch_deck`; only when
   nothing fits does the beat become a named gap.
2. **See what good looks like.** Read the exemplar: the moves (title length, eyebrow, where a
   number may be huge, imagery density), never the copy.
3. **Deck type and narrative.** Name the type (pitch, proposal, debrief, internal, plenary…), the
   thesis, and an ordered outline `section → message of each slide`. Slide count follows the
   argument. Unsettled language and `default_language` null → ask.
4. **Capped challenge.** One question at a time, each with your recommended answer, only on
   high-impact blind spots (audience, key message, missing figures). A clear brief means zero
   questions. "Build" / "go" ends questioning.
5. **Deck plan.** For each slide: `{message, message_type, form, source, gaps}`, form derived from
   the doctrine table. Check: no 3 consecutive same forms, 3+ same-dimension numbers are charts.
   Beyond about 6 slides, show the plan and get it validated.
6. **Write the DeckSpec.**
   - Signatures, once each: `clone` role `cover`, `summary` (if the deck has 3+ sections), one
     `divider` per section (`subsection` for a sub-level), `closing`; `appendix` before optional
     material.
   - Content: `composition`, `chart`, `diagram`, or `clone` of an archetype whose message is this
     slide's message.
   - Copy fitted to capacities; unknowns as `missing_value[<lang>]`; anti-slop checklist applied.
   - Every chart or composition carrying figures from a source names it in `params.source`
     (doctrine → Build rules).
7. **Create.** `create_deck` with the DeckSpec (or `add_slides` to extend a deck being built).
8. **Lint → render → fix** (doctrine). `lint_deck`; fix every ERROR via `patch_deck`; look at
   each rendered slide; fix and re-check only changed slides.
9. **Optional fresh eyes.** Offer `review_deck` before delivery; relay its plan, never mandatory.
10. **Deliver.** `export_pptx`, plus a short report: the `missing_value` items, anything not
    visually verified, fonts rendered with fallback.

## Stop conditions

- **Stop and ask** when: no pack can be chosen; language unknown with no default; the brief has no
  message the deck can argue; a fact needed for the thesis is missing and the user must supply it.
- **Hand off** when the request is really one slide (draft), an existing file (edit / review), or
  needs a co-designed narrative first (storyline).
- **Done** when lint has zero ERROR, every slide has been looked at once after its last change
  (or the user was told it was not visually verified), and the doctrine success test passes for
  every slide and for the deck (not interchangeable with another client's).
