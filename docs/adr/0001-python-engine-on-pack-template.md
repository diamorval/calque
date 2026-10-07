# ADR 0001 — Python engine on the pack template, preview = rendered PPTX, knowledge in core/ + packs/

- Status: accepted
- Date: 2026-10-07

## Context

Calque produces native, editable PPTX that must match each company's charter. Charters come as
*brand packs*: an official `template.pptx` plus tokens, voice and lint rules. The reference
implementation (Diametral's `visual-creation` plugin) already proves the approach: clone role
slides from the official template and draw bespoke content on top with python-pptx.

## Decisions

1. **The engine is Python (uv, python-pptx).** It must open and clone an existing PPTX. PptxGenJS
   and other JS libraries only write new files from scratch. Everything else (UI, agent, MCP
   server) stays TypeScript; the server calls the engine as a subprocess with JSON on stdio.
2. **The LLM never writes PPTX.** It emits a `DeckSpec` JSON validated by one JSON Schema
   (Zod in TS, Pydantic in the engine). The engine renders it deterministically.
3. **The preview is the PPTX itself**, rendered to PNG by headless LibreOffice, with a shape map
   (`shape_id`, bbox, role). Comments anchor on `shape_id`. Preview and export cannot diverge.
4. **Knowledge lives in two layers**: `core/` (generic doctrine, compositions, anti-slop,
   workflows) and `packs/<id>/` (template, tokens, voice, exemplar, storyline, lint rules).
   Neither layer is hard-coded in a prompt; both are served over MCP and loaded into the web
   agent's system prompt. In each pack, `tokens.json` is the source of truth.

## Consequences

- Two runtimes (Node + Python) in one repo; CI runs both.
- LibreOffice is a runtime dependency of the server image; render latency must be measured
  (see Measurements below).
- Onboarding a company is data, not code: import a template, review the extracted map, publish.

## Measurements

Measured 2026-10-07 on an Apple M5 (32 GB, macOS 27.0.1), LibreOffice 26.8.1.1, poppler
`pdftoppm`, 96 dpi, `calque_engine.render.render` on a 10-slide deck built from the Diametral pack
(cover, alternating content and divider clones, closing). Median of 3 runs, each including a
fresh throwaway LibreOffice profile (pack fonts copied in) and the shape map.

- Full render, 10 slides, empty cache: **2.9 s** (2.92, 2.91, 2.96).
- Single-slide re-render after editing one slide's text: **1.2 s** (1.15, 1.22, 1.20). Only the
  changed slide is exported (PDF `PageRange` on the unmodified deck); the other nine are reused
  from the cache. The floor is LibreOffice start-up and deck load, not the slide itself.
- Nothing changed: ~0.02 s (hashing only, no LibreOffice).
