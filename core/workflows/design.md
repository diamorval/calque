# Workflow: design (social posts, stories, banners, ads, posters, web sections)

**Purpose.** Make on-brand visuals that are not slides: one or several artboards (a campaign in
several formats, a carousel) from a brief, laid out by the engine and checked by its lint.

**Not this workflow:** slides or a deck → [draft](draft.md) or [build](build.md).

## Reads

`list_formats` with the pack id (formats, colour roles, text styles, modes),
`pack://<id>/DESIGN.md`, `pack://<id>/voice`; `core/anti-slop.md`.

## Steps

0. **Pack.** If none is active, `list_packs` and ask (one pack → use it).
1. **Understand the ask.** Channel(s) → format(s). One message per artboard: a headline the
   reader gets in two seconds, at most one supporting line, one call to action. Mine any facts
   supplied. Ask one question, with your recommended answer, only on a real blind spot.
2. **Write the DesignSpec.**
   - One artboard per format. Start from auto layout (`layout` on the artboard and frames):
     `direction`, `gap`, `padding`, `align` (along), `cross` (across). Use `position` only for
     what must sit at a fixed place (a logo corner, a decorative shape).
   - Text styles are the pack's type scale (`cover_title`, `title`, `body`, `label`, `caption`,
     `numeral`...), scaled to each format. Never set `size` without a reason.
   - Colours are roles (`ink`, `background`, `accent`, `muted`...), never hex. A dark canvas is
     a mode (`mode: "dark"` on the artboard or the spec), not repainted nodes.
   - Repeated pieces (a button, a tag, a card) are `components` with `{prop}` placeholders and
     `variants`; artboards hold `instance` nodes.
   - `max_lines` on headlines, `alt` on every image (empty for decorative ones).
3. **Create.** `create_design`. Look at every artboard's `image_url`.
4. **Fix → re-check.** Every `errors` entry must go: shorten text, give it room, switch to a
   role that reads on its background, a larger style. Use `patch_design`. Weigh the
   `warnings`. A second format of the same message is `adapt_artboard`, then fix its lint.
5. **Deliver.** `export_design`: `png` (scale 2 for retina) for social and ads, `pdf` for print,
   `svg` for designers, `react` / `tailwind` for developers (one artboard each).

## Stop conditions

- **Done** when no artboard has an ERROR, each artboard was looked at after its last change, and
  each would pass for a finished piece of the brand, not a filled template.
