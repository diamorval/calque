# ADR 0002 — DesignSpec: one node tree for every non-slide format, laid out by Chromium

- Status: accepted
- Date: 2026-10-14

## Context

Calque makes decks. The product goal is an AI-native design platform: social posts, stories,
banners, display ads, posters, web sections, all on the company's charter. PPTX is the wrong
medium for those, and the DeckSpec (slides cloned from a template) has no free-form canvas.

We reviewed [desigma](https://github.com/deepfounder-ai/desigma) (an open-source Rust design
editor, MIT/Apache-2.0). It is not AI-native, but three of its ideas fit: a Figma-like document
model (frames with auto layout, components with variants and instances), variables with modes,
and an export pipeline (raster, vector SVG, code). We took the ideas, not the Rust code.

## Decisions

1. **A second spec, `DesignSpec`** (`packages/deckspec/src/design.ts`, JSON Schema generated for
   the engine). Artboards on a format preset; a node tree of frames (auto layout: direction,
   gap, padding, align, cross, wrap; sizes in px, `hug` or `fill`), text, images, shapes and
   component instances. Same rules as the DeckSpec: the LLM writes JSON, never pixels, and every
   colour, font and size is a pack role, never a value.
2. **Format presets are generic knowledge** (`core/formats.yaml`): size, type-scale factor,
   minimum text size, safe margin. A format scales the pack's slide type scale, so a pack needs
   nothing new to make a story or a banner.
3. **Token modes** live in each pack's `tokens.json` under `$extensions."calque.modes"` (the
   DTCG extension point): a mode overrides tokens by path. A dark artboard is a mode, not
   repainted nodes, and the code exports keep the modes as CSS variables.
4. **Layout is HTML/CSS in headless Chromium.** Auto layout maps 1:1 to flexbox, and text wraps
   with the real fonts. Chromium measures every node (box, overflow, text lines and baselines);
   the same page gives the PNG and the PDF. The SVG is written from the measurements (rects,
   paths, one `<text>` per line), so it is real vector, not a screenshot. Chromium runs on a
   generated page with a CSP that blocks any network access, images inlined as data URLs read
   from the pack or the user's own uploads.
5. **Design lint** reads the measurements: overflow, `max_lines`, off canvas, text under the
   format's minimum, WCAG contrast, safe margins, single-use colours, the anti-slop and language
   typography rules of `core/anti-slop.md`.
6. **Same doors, same engine.** Engine ops `design_*` on the JSON interface; MCP and REST tools
   `list_formats`, `create_design`, `patch_design`, `open_design`, `export_design`,
   `list_designs`, `restore_design`; the `create-design` prompt (`core/workflows/design.md`).

## Consequences

- Chromium joins LibreOffice in the server image (about 300 MB). One Chromium start per render
  (about 1 s): measure, then each output.
- Designs are versioned like decks but are **owner-only** for now: sharing, comments, approval,
  a design UI in the web app and the MCP Apps UI come next.
- Not taken from desigma: its desktop editor, GPU renderer, whiteboards and prototyping. Its
  Figma import (`.fig` / REST JSON) is the next candidate, as a CLI the engine calls, to draft a
  pack from a company's Figma design system.
