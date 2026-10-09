# @calque/server

One engine, two doors: MCP (Streamable HTTP on `/mcp`, or stdio) and REST (`/api/tools/<name>`) call
the same tools (`src/tools.ts`). Every deck change is a new DeckSpec version in Postgres.

```bash
pnpm --filter @calque/slide-ui build   # the deck UI (MCP App + web preview)
node apps/server/src/main.ts           # HTTP on :8787
node apps/server/src/stdio.ts          # stdio, for a local MCP client (bridge to the HTTP server)
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
| `CALQUE_OIDC_CLIENT_ID` | the audience | the web app's OIDC client (authorization code + PKCE) |
| `CALQUE_OIDC_CLIENT_SECRET` | unset: public client | its secret, for a confidential client |
| `CALQUE_SECRET` | random, in `$CALQUE_DATA/secret` | seals model API keys at rest (AES-256-GCM): set it in production |
| `CALQUE_ADMIN_TEAM` | `calque-admins` | team allowed to configure AI models |
| `CALQUE_LLM_MODEL` | unset | preconfigured gateway, saved as model `env`, default unless another is set |
| `CALQUE_LLM_PROVIDER` / `_BASE_URL` / `_API_KEY` | `openai-compatible` / – / – | the gateway's provider, endpoint and key |

## Connect

- **Claude Code, local:** `.mcp.json` at the repo root starts `stdio.ts`; the prompts show as
  `/calque:build-presentation`, `/calque:review-deck`… `stdio.ts` is a bridge to `/mcp` of the
  server on `127.0.0.1:$PORT` (no-auth mode), so previews, browser comments and MCP share one
  database. If no server answers, it starts `main.ts` in its own process (previews then live as long
  as that session; run `main.ts` yourself to keep them up). Only one process may open a PGlite
  directory: a second one fails with the owner's pid instead of corrupting it. On a fresh checkout
  `stdio.ts` runs `pnpm install` first (logs on stderr).
- **Claude Code, remote:** `claude mcp add --transport http calque https://<host>/mcp`.
- **Claude and Cowork:** custom connector on `https://<host>/mcp`. The server is an OAuth resource
  server: it advertises `/.well-known/oauth-protected-resource/mcp`, pointing at the issuer, and
  verifies the issuer's JWTs. No API key: the user's Claude subscription runs the model.

Hosts with MCP Apps show the deck UI (`ui://calque/deck.html`) on `create_deck`, `open_deck`,
`import_pptx`, `patch_deck`, `add_slides`, `restore_version`. The others get `preview_url`
(`/decks/:id`), the same UI over REST: comments posted there are read by `list_comments`.

### Files in

A template or deck is too big for a tool argument in base64 (a corporate template is ~14 MB).
Upload it, then pass its `file_id`:

1. The `upload_url` tool returns a one-time URL (signed ticket, 15 minutes) that uploads as the
   calling user, so a client without its own token (Claude Code's shell) can post the file:
   `curl -F file=@template.pptx '<upload_url>'`. A client holding a bearer token can also
   `POST /api/files` with it directly.
2. The answer is `{file_id, name, size, type}`. Pass `{"file_id": …}` as `file` to `import_pptx` or as
   `template` to `import_pack`, or place an image with `"image": "file:<file_id>"` in a clone value.

Files are capped at 50 MB, stored under `$CALQUE_DATA/uploads/<file_id>`, and usable only by their
uploader. `{base64}` (and `{path}` on a stdio server) still work.

## Web app

The server also serves the built web app (`apps/web/dist`) on `/`. With `CALQUE_OIDC_ISSUER` set,
the browser signs in at `/auth/login` (code + PKCE against the issuer; redirect URI
`<public url>/auth/callback`) and gets an 8-hour signed `HttpOnly` session cookie; every `/api` route
refuses a request without a session or a bearer token. The Keycloak login theme ships with the
design system: `node_modules/@diametral/design-system/keycloak/diametral`.

| Route | |
| --- | --- |
| `GET /api/me` | the signed-in user, their teams, `admin` |
| `GET /api/decks` | the user's decks |
| `POST /api/files` | multipart `file` (50 MB max, else 413) → `{file_id, name, size, type}`, owned by the caller; `?ticket=` from `upload_url` instead of credentials |
| `POST /api/packs/drafts` | multipart `template`, `id`, `name`: extracted draft (manifest with guessed roles, one PNG per template slide) |
| `POST /api/packs/drafts/:id/fonts` | multipart `font` (.ttf, .otf) |
| `POST /api/packs/drafts/:id/publish` | `{manifest, voice?, visibility, teams?}`: validated (template lint, test deck), then published |
| `POST /api/packs/:id/visibility` | `{visibility, teams?}`, owner only |

## Web agent (API door)

The web app's agent (`@calque/agent`) runs in this process and is an MCP client of this same server,
connected in memory as the calling user: same tools, same `core://` / `pack://` knowledge, same
prompts as Claude. Models go through `@calque/llm` only.

| Route | |
| --- | --- |
| `GET /api/models` | provider catalog + configured models (never their keys) |
| `POST /api/models` | `{provider, model, api_key?, base_url?, default?}`: tested with a 1-token call, refused (422) if the provider refuses |
| `POST /api/models/:id/default`, `DELETE /api/models/:id` | the default is read on every call: no restart |
| `POST /api/agent/chat` | `{messages, workflow?, pack_id?, deck_id?, model?, files?}` → `{model, text, messages}`; the client keeps the conversation. `files`: uploaded file ids; documents (txt, md, csv, docx, xlsx, pptx; not PDF yet) reach the model as text, images as `file:<id>` references. `Accept: application/x-ndjson` streams `{step}` lines, then `{done}` |
| `POST /api/agent/apply-comments` | `{deck_id, model?}`: the open comments become `patch_deck` calls |

`node apps/server/eval/agent.ts anthropic:<model> openai:<model>` runs the Phase 4 checks on real models
(same brief → 0 lint ERROR, then 5 comments applied → 0 lint ERROR). Needs the providers' keys.
