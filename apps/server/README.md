# @calque/server

One engine, two doors: MCP (Streamable HTTP on `/mcp`, or stdio) and REST (`/api/tools/<name>`) call
the same tools (`src/tools.ts`). Every deck change is a new DeckSpec version in Postgres.

```bash
pnpm --filter @calque/slide-ui build   # the deck UI (MCP App + web preview)
node apps/server/src/main.ts           # HTTP on :8787
node apps/server/src/stdio.ts          # stdio, for a local MCP client
```

| Variable | Default | |
| --- | --- | --- |
| `DATABASE_URL` | PGlite in `$CALQUE_DATA/pg` | `postgres://…` in production |
| `CALQUE_DATA` | `.data/` | decks, renders, uploads, imported packs |
| `CALQUE_PACKS` | `packs/` | packs registered for the whole workspace at start-up |
| `CALQUE_PUBLIC_URL` | `http://localhost:$PORT` | base of preview, PNG and download links |
| `CALQUE_ENGINE` | `uv run … calque_engine call` | engine command (e.g. `python -m calque_engine call`) |
| `CALQUE_OIDC_ISSUER` | unset: no auth, loopback only | e.g. `https://sso.example.com/realms/<realm>` |
| `CALQUE_OIDC_AUDIENCE` | `calque` | audience the access tokens carry (Keycloak: audience mapper) |
| `CALQUE_TEAMS_CLAIM` | `groups` | token claim listing the user's teams (pack visibility) |

## Connect

- **Claude Code, local:** `.mcp.json` at the repo root starts the stdio server; the prompts show as
  `/calque:build-presentation`, `/calque:review-deck`… Previews need `main.ts` running too.
- **Claude Code, remote:** `claude mcp add --transport http calque https://<host>/mcp`.
- **Claude and Cowork:** custom connector on `https://<host>/mcp`. The server is an OAuth resource
  server: it advertises `/.well-known/oauth-protected-resource/mcp`, pointing at the issuer, and
  verifies the issuer's JWTs. No API key: the user's Claude subscription runs the model.

Hosts with MCP Apps show the deck UI (`ui://calque/deck.html`) on `create_deck`, `open_deck`,
`import_pptx`, `patch_deck`, `add_slides`, `restore_version`. The others get `preview_url`
(`/decks/:id`), the same UI over REST: comments posted there are read by `list_comments`.
