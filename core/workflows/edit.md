# Workflow: edit (user-directed changes to an existing deck)

**Purpose.** Apply exactly the changes the user names (retitle, reword, fix a figure or typo,
replace an image, reorder, delete, duplicate) to an existing deck, preserving its formatting and
visual language. A precise editor, not a reviewer: no audit, no redesign.

**Not this workflow:** "review / proofread / make it perfect" → [review](review.md); "add a new
slide" → [draft](draft.md) then paste, or `add_slides` when the deck is on the active pack; "build
me a deck" → [build](build.md).

## Reads

- The deck itself (`open_deck` returns slides in **display order**, every shape by `shape_id`,
  text including grouped shapes, hidden flags).
- `pack://<id>/DESIGN.md` and `pack://<id>/voice` only when the deck is on a pack and the change
  needs a design or wording decision (which role for an accent, how a label is written).
- `list_comments` when the user says "apply the comments".

## Steps

1. **Load.** `open_deck` (deck already in Calque) or `import_pptx` (a file from the user). Calque
   always works on its own copy; the user's original is never overwritten. A Calque deck the
   client edited in PowerPoint comes back with `import_pptx` + `deck_id`: same deck, new version,
   charts still charts; read the `import` report and tell the user which slides were demoted.
2. **Locate the target.** Map the user's "slide 7" to **display order**, and find the exact
   `shape_id` and run(s). If the reference is ambiguous (two slides could be "the figures slide"),
   ask once.
3. **Apply** with `patch_deck`, one operation per requested change:
   - **Text**: run-level replacement scoped to `slide` + `shape_id`. A sentence may span several
     runs: match a fragment that lives in one run, or replace the paragraph's runs while keeping
     the first run's properties. Never reset the whole text frame.
   - **Structure**: reorder / move / delete / duplicate by slide id; a deleted slide drops its
     relationships so its unique media leave the file. Renumber page-number footers afterwards.
   - **Image**: swap the image bytes in place so position, size and references survive; resize only
     if asked.
4. **Verify.** `lint_deck` (on a pack deck) and re-render **only the changed slides**: the edit
   landed, no new overflow or overlap.
5. **Deliver.** `export_pptx` and a short list of exactly what changed. Mention (do not fix) any
   other defect you noticed.

## Stop conditions

- **Only the requested changes.** No "while I was in there" edits.
- **Stop and ask** when the target is ambiguous, or a text fragment cannot be located (report
  which one; never guess a nearby match).
- **Hand off** to review for audits, draft or build for new content.
- **Done** when every requested change is applied, the changed slides render cleanly, and the
  report lists them.
