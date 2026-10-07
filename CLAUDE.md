# Calque

Co-editing slides with an AI. Outputs native, editable PPTX that follows each company's charter,
supplied as a **brand pack**. Diametral is the first pack. Two entry points: **MCP** (Claude Code,
Cowork, Claude, using the user's Claude subscription) and **API** (our web app, any model provider).

## Non-negotiable rules

1. **Two doors, one engine.** MCP mode and the web app call the same tools. No business logic in
   the UI or the agent.
2. **Provider-agnostic.** In the app, every LLM call goes through `packages/llm`, a provider
   registry. No provider SDK anywhere else.
3. **The LLM never writes PPTX.** It produces a `DeckSpec` JSON validated by one JSON Schema
   (Zod in TS, Pydantic in the engine). The engine clones the pack template and draws slides
   deterministically.
4. **No brand in code.** Everything company-specific lives in its brand pack (`packs/<id>/`), and
   in each pack `tokens.json` is the source of truth. CI fails if `engine/` or `core/` contains a
   brand name, a hex colour or a font name.
5. **Knowledge has two layers, never hard-coded in a prompt:** `core/` (generic) and
   `packs/<id>/` (company-specific).
6. **One slide UI.** `packages/slide-ui` (rendered preview, inspector, comments) is embedded in
   both `apps/web` and the MCP Apps UI.

## Layout

```text
apps/server        TS: MCP server (tools, resources, prompts, MCP Apps UI), REST API, DeckSpec versions, preview /decks/:id
apps/agent         TS: web-app agent, tool-calling loop
apps/web           TS: React UI (design-system vite-react starter), AI Models and Brand packs pages
engine/            Python: DeckSpec -> PPTX, import, patch by shape_id, lint, PNG render + shape map, template extractor
packages/slide-ui  rendered preview, thumbnails, inspector, comments
packages/llm       provider registry, the only access to models
packages/deckspec  Zod schemas + JSON Schema shared with the engine
packages/design    DTCG tokens -> PPTX theme and DESIGN.md, per pack
core/              doctrine, compositions, anti-slop, workflows: generic, brand-free
packs/<id>/        one brand pack per company (diametral is the first)
docs/adr/          architecture decisions
```

## Adding a new company

Add a brand pack under `packs/<id>/`, never touch `engine/` or `core/`. In the product this
is done without code: import the company's `template.pptx` (+ `tokens.json` if any), let the
extractor draft `template-map.yaml` and `tokens.json`, review roles in the Brand packs page,
validate (lint passes on the template, a test deck renders), publish.

A pack contains `pack.yaml` (manifest), `template.pptx`, `template-map.yaml`, `tokens.json`
(DTCG, source of truth), generated `DESIGN.md`, optional `voice.md`, `exemplar.md`,
`storyline.md`, and `fonts/`.

## Commands

```bash
pnpm install
pnpm lint            # eslint + typecheck (turbo)
pnpm test            # vitest
pnpm engine:test     # cd engine && uv run pytest
pnpm engine:lint     # ruff check + format check
pnpm design:check    # template theme vs tokens.json gaps, DESIGN.md freshness (every pack)
pnpm pack:sync <id>  # re-sync a pack from the pinned sources in its source.yaml
cd engine && uv run pytest -m golden             # render golden decks, compare to committed PNGs
CALQUE_UPDATE_GOLDEN=1 uv run pytest -m golden   # accept a deliberate visual change
uv run python -m calque_engine build deck.json --pack ../packs/<id> --out deck.pptx
uv run python -m calque_engine lint deck.pptx --pack ../packs/<id> --language fr
echo '{"op": "build", ...}' | uv run python -m calque_engine call   # the server's JSON interface
node apps/server/src/main.ts          # MCP (/mcp) + REST (/api) + preview (/decks/:id), see apps/server/README.md
node apps/server/src/stdio.ts         # MCP over stdio (.mcp.json)
pnpm --filter @calque/slide-ui build  # deck UI bundle, served as ui:// and /decks/:id
pnpm --filter @calque/web dev         # web app on Vite, proxied to the server on :8787
pnpm e2e                              # Playwright: fake IdP + fake model + the real server and engine
node apps/server/eval/agent.ts anthropic:<model> openai:<model>  # web agent on real models (needs keys)
```

DeckSpec source of truth: `packages/deckspec/src/schema.ts` (Zod). After editing it, run
`pnpm --filter @calque/deckspec schema` to regenerate the JSON Schema used by the engine.

## Working method

The build follows the implementation plan phase by phase. A phase is done only when all of its
`verify` checks pass.
