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
| `CALQUE_TEAMS_MAP` | unset | group id → team name, inline JSON or a JSON file path (Entra ID group GUIDs, see below) |
| `CALQUE_TEAMS_MAP_ONLY` | unset | `1`: drop the groups the map does not name |
| `CALQUE_OIDC_CLIENT_ID` | the audience | the web app's OIDC client (authorization code + PKCE) |
| `CALQUE_OIDC_CLIENT_SECRET` | unset: public client | its secret, for a confidential client |
| `CALQUE_SECRET` | random, in `$CALQUE_DATA/secret` | seals model API keys at rest (AES-256-GCM): set it in production |
| `CALQUE_ADMIN_TEAM` | `calque-admins` | team allowed to configure AI models |
| `CALQUE_LLM_MODEL` | unset | preconfigured gateway, saved as model `env`, default unless another is set |
| `CALQUE_LLM_PROVIDER` / `_BASE_URL` / `_API_KEY` | `openai-compatible` / – / – | the gateway's provider, endpoint and key |
| `CALQUE_LLM_HEADERS` | unset | JSON object of extra request headers (e.g. `{"Ocp-Apim-Subscription-Key": "…"}`), sealed at rest |
| `CALQUE_LLM_AZURE_RESOURCE` / `_API_VERSION` / `_MANAGED_IDENTITY` | – / `v1` / – | Azure OpenAI (`CALQUE_LLM_PROVIDER=azure`, the model is the deployment): resource name, `api-version`, `1` to sign in with the managed identity |

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

Outputs: `export_pptx` (`/decks/:id/deck.pptx`) and `export_pdf` (`/decks/:id/deck.pdf`, rendered by
LibreOffice with the pack's fonts, like the previews; one file per version). Saving to
SharePoint/OneDrive/Teams is not built: it needs Microsoft Graph credentials.

## Web app

The server also serves the built web app (`apps/web/dist`) on `/`. With `CALQUE_OIDC_ISSUER` set,
the browser signs in at `/auth/login` (code + PKCE against the issuer; redirect URI
`<public url>/auth/callback`) and gets an 8-hour signed `HttpOnly` session cookie; every `/api` route
refuses a request without a session or a bearer token. The Keycloak login theme ships with the
design system: `node_modules/@diametral/design-system/keycloak/diametral`.

### Microsoft Entra ID

Entra ID works as the issuer for both doors, next to Keycloak:

1. **App registration** (single tenant). Web redirect URI `<public url>/auth/callback`; a client
   secret for `CALQUE_OIDC_CLIENT_SECRET`. *Expose an API* with a scope (e.g. `access_as_user`), and
   set `"accessTokenAcceptedVersion": 2` in the manifest so access tokens carry the v2 issuer.
2. **Groups claim.** *Token configuration > Add groups claim*, and prefer *Groups assigned to the
   application*: past 200 groups Entra leaves `groups` out of the token (the overage claim). Calque
   makes no Graph call: it logs a warning naming the user, who then has no teams.
3. **Environment.**

   ```bash
   CALQUE_OIDC_ISSUER=https://login.microsoftonline.com/<tenant id>/v2.0
   CALQUE_OIDC_AUDIENCE=<application (client) id>   # the aud of v2 access tokens
   CALQUE_OIDC_CLIENT_ID=<application (client) id>
   CALQUE_OIDC_CLIENT_SECRET=<secret>
   CALQUE_TEAMS_MAP=/etc/calque/teams.json            # or inline: {"<group object id>": "sales", …}
   CALQUE_TEAMS_MAP_ONLY=1                            # unmapped GUIDs never show as teams
   CALQUE_ADMIN_TEAM=calque-admins                    # a mapped team name
   ```

   Entra sends group object ids (GUIDs): `CALQUE_TEAMS_MAP` names them, so pack visibility reads
   `sales` rather than `3f2a…`.

Limits: Entra has no dynamic client registration, so an MCP client that relies on it cannot sign in
on its own (pre-register a client for it, or broker Entra through Keycloak). There is no SCIM and
no server-side session: a user removed from Entra keeps access until the 8-hour cookie expires.

| Route | |
| --- | --- |
| `GET /api/me` | the signed-in user, their teams, `admin` |
| `GET /api/decks` | the user's decks |
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
| `POST /api/models` | `{id?, provider, model, label?, api_key?, base_url?, headers?, resource?, api_version?, managed_identity?, default?}`: tested with a 1-token call, refused (422) if the provider refuses. With `id`: edits that configuration (an unset key or `headers` keeps the stored ones). Without: id `provider:model`, `@<label>` if labelled; the same model on another endpoint gets `@2`, `@3`… instead of overwriting |
| `POST /api/models/:id/default`, `DELETE /api/models/:id` | the default is read on every call: no restart |
| `POST /api/agent/chat` | `{messages, workflow?, pack_id?, deck_id?, model?}` → `{model, text, messages}`; the client keeps the conversation. `Accept: application/x-ndjson` streams `{step}` lines, then `{done}` |
| `POST /api/agent/apply-comments` | `{deck_id, model?}`: the open comments become `patch_deck` calls |

**Azure OpenAI.** The model is the deployment name. Give the resource name (or a base URL: an APIM
gateway, a private endpoint). An empty API version uses the v1 API; a dated one (`2024-10-21`) calls
`/openai/deployments/<deployment>/chat/completions?api-version=…`. Gateway headers such as
`Ocp-Apim-Subscription-Key` go in the custom headers, sealed like the keys. Instead of a key, the
server can sign in with its managed identity (App Service, Container Apps via `IDENTITY_ENDPOINT`;
VMs and AKS nodes via the instance metadata endpoint; `AZURE_CLIENT_ID` for a user-assigned
identity), which needs the *Cognitive Services OpenAI User* role on the resource. Not covered: AKS
workload identity (federated tokens) and service-principal secrets: use a key or a gateway for those.

`node apps/server/eval/agent.ts anthropic:<model> openai:<model>` runs the Phase 4 checks on real models
(same brief → 0 lint ERROR, then 5 comments applied → 0 lint ERROR). Needs the providers' keys.
