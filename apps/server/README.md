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
| `CALQUE_SECRET` | random, in `$CALQUE_DATA/secret` | seals model API keys at rest (AES-256-GCM) and sessions: required when `CALQUE_OIDC_ISSUER` is set (the server refuses to start without it) |
| `CALQUE_ADMIN_TEAM` | `calque-admins` | team allowed to configure AI models and, on any deck, see who has access, make it private, reset its link and transfer it (never to read it) |
| `CALQUE_LLM_MODEL` | unset | preconfigured gateway, saved as model `env`, default unless another is set |
| `CALQUE_LLM_PROVIDER` / `_BASE_URL` / `_API_KEY` | `openai-compatible` / – / – | the gateway's provider, endpoint and key |
| `CALQUE_RETENTION_DAYS` | unset: keep everything | delete decks untouched for that many days and uploads older than that, at start and daily (the audit log is kept) |
| `CALQUE_RATE_LIMIT` | on | `off` lifts the per-minute limits on `/auth/*` (30 per address), agent runs (30 per user) and model tests (10 per user) |
| `CALQUE_TRUST_PROXY` | unset | `1`: rate-limit by the first `X-Forwarded-For` hop (behind your reverse proxy) instead of the socket address |

## Deploy

One image (`Dockerfile` at the repo root): this server, the built web app and deck UI, the Python
engine (locked dependencies) and LibreOffice + pdftoppm for renders. Not one image each for web,
agent and engine: the web app is static files served here, the agent runs in this process and the
engine is a subprocess per call (`src/engine.ts`), so they ship together. It runs as `node`, keeps
its state in the `/data` volume (`CALQUE_DATA`) and serves the packs baked in `/app/packs`
(`CALQUE_PACKS`; brand fonts in `packs/<id>/fonts/` are baked too when present at build time).

```bash
docker compose up -d --build   # calque + Postgres; needs CALQUE_SECRET, CALQUE_OIDC_ISSUER,
                               # CALQUE_PUBLIC_URL, POSTGRES_PASSWORD (URL-safe) in .env
docker compose logs -f calque
```

The compose file refuses to start without those. Without an issuer the server only listens on
loopback, so a bare `docker run` is for a smoke test only:

```bash
docker build -t calque .
docker run -d --name calque --network host -e CALQUE_SECRET=dev calque
node scripts/docker-smoke.ts   # a deck built and rendered end to end (also run in CI)
```

Put an HTTPS reverse proxy in front of `:8787` at `CALQUE_PUBLIC_URL`; the health check is
`GET /api/tools`.

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
(`/decks/:id?t=…`, the caller's URL token, see below), the same UI over REST: comments posted there
are read by `list_comments`.

### Sharing

Artifact style: people with access, and one share link per deck. Roles, each including the ones
before it: **viewer** (open, lint, export, list comments, present), **commenter** (+ comment),
**editor** (+ `patch_deck`, `add_slides`, `restore_version`, `review_deck`), **owner** (+ manage
access, transfer). A deck the caller has no role on does not exist for them (404); a tool needing
more than their role answers 403. The caller's role is the best of the ones below.

- **People with access** (`deck_shares`): the owner gives a user id or a team viewer, commenter or
  editor (`share_deck`, `unshare_deck`). A grant counts only while the user sees the deck's pack.
  `list_decks` (and `GET /api/decks`) returns the caller's decks and the decks shared with them,
  each with `role` and `owner` ("Shared with me" in the web app).
- **Share link**: each deck has exactly one, `/decks/:id?k=<link_key>`, a random secret stored on
  the deck. Its **general access** (`set_general_access {access, role}`) says who else it opens for:
  `private` (default: only the owner and people with access, signed in), `workspace` (anyone signed
  in who sees the deck's pack gets the general role) or `anyone` (no sign-in, no pack gate), with the
  general role `viewer` or `commenter`, never editor. No expiry: `reset_link` rotates the key, and
  every copy of the old link stops working at once. Comments through an anonymous link are signed
  `guest`. `list_shares` returns the owner, the people, the general access and, for the owner, the
  link `url`.
- **URL tokens** (internal): the URLs in tool results (`preview_url`, `image_url`, `download_url`)
  and the MCP App's PNGs must work with no browser session, so they carry `?t=`, a per-user token
  (HMAC with `CALQUE_SECRET`, 24 h, bound to the user and the deck). It is no grant: every request
  re-checks that user's current access, so removing their access kills it, and it never gives more
  than they have. A caller who came through the share link gets URLs with that link instead. Never
  shown in the Share dialog. Without `CALQUE_OIDC_ISSUER` (local only) neither `?k=` nor `?t=` is
  checked.
- **Transfer** (`transfer_deck`): the owner, or an admin, gives the deck to another user id; the
  former owner keeps editor access through a grant.
- **Admins** (`CALQUE_ADMIN_TEAM`) have no access to deck content. On any deck they see who has
  access (never the link), set general access to private, reset the link and transfer it:
  `list_shares`, `set_general_access {access: "private"}`, `reset_link`, `transfer_deck`, or
  `GET /api/admin/decks/:id/access`, `POST /api/admin/decks/:id/private`,
  `POST /api/admin/decks/:id/reset-link`, `POST /api/admin/decks/:id/transfer` `{to}`.

Every grant, revocation, general access change, link reset and transfer is logged in the `audit` table
(deck, actor, action, detail).

### Review

- **Comment threads**: `add_comment {parent_id, text}` replies in a thread (one level, on the
  first comment's slide and shape). `list_comments {status: open | resolved | all}` and `open_deck`
  (`open_comments`, `resolved_comments`) return threads with their `replies`. `resolve_comments
  {comment_ids, status}` resolves or reopens threads one by one without editing the deck: an editor
  any thread, a signed-in commenter only their own. `patch_deck {resolves}` still resolves what it
  applied. The slide UI applies the selected threads or all of them
  (`POST /api/agent/apply-comments {deck_id, comment_ids?}` in the web app).
- **Authors**: versions and comments keep the author's id (`author`, the token's `sub`) and store
  their display name (`author_name`, the `name` claim of the session or bearer token); the UIs show
  the name. Comments through an anonymous link stay `guest`.
- **Approval** (opt-in, M9): only on packs whose `pack.yaml` sets `approval: true` (default off, so
  consultants are never blocked). A deck is `draft`, `in_review` or `approved` (`set_approval`,
  status and allowed moves in `open_deck`'s `approval`). An editor requests the review and may
  withdraw it; the approver is the pack's owner or an admin, with at least view access to the deck
  (share it with them), who approves or sends it back to draft. A new version of an approved deck
  is a draft again. Approval never gates an export. Each move is logged in the `audit` table.
- **Export gate** (soft, M18): `export_pptx` always exports. When the version has lint ERRORs it
  answers `lint_errors` (and a `warning` without `reason`) and logs `export_with_errors` (version,
  error count, `reason` or null) in the `audit` table. The web app asks for the reason before exporting.

### Audit log and deletion

The `audit` table records who did what, never the content: deck `create`, `edit` (version, note),
`export`, `delete`, the sharing actions above; pack `publish`, `edit`, `visibility`; model `add`,
`update`, `default`, `remove`; `sign_in`; retention `purge`. Rows outlive what they name. Admins
read it at `GET /api/admin/audit?actor=&action=&target_type=&target_id=&since=&until=&limit=`
(newest first, at most 1000).

`delete_deck` (or `DELETE /api/decks/:id`, the Delete action on the Decks page): the owner, or an
admin, erases a deck with its versions, comments, shares and its folder under `$CALQUE_DATA/decks`
(built PPTX, renders, imported base). Uploads are the uploader's: `CALQUE_RETENTION_DAYS` removes
them by age. See [docs/security.md](../../docs/security.md).

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
| `GET /api/decks` | the user's decks and the decks shared with them, each with `role` and `owner` |
| `POST /api/files` | multipart `file` (50 MB max, else 413) → `{file_id, name, size, type}`, owned by the caller; `?ticket=` from `upload_url` instead of credentials |
| `POST /api/packs/drafts` | multipart `template` (.pptx or .potx), `id`, `name`, optional `tokens` (tokens.json): extracted draft (manifest with guessed roles and the fonts/colours the slides use, resolved colours and fonts to review, archetype names, one PNG per template slide) |
| `POST /api/packs/drafts/:id/fonts` | multipart `font` (.ttf, .otf): its family is allowed by lint (`lint.extra_fonts`) on publish |
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
| `POST /api/models/:id/default`, `DELETE /api/models/:id` | the default is read on every call: no restart; removing the default promotes the most recently configured model |
| `POST /api/agent/chat` | `{messages, workflow?, pack_id?, deck_id?, model?, files?}` → `{model, text, messages}`; the client keeps the conversation. `files`: uploaded file ids; documents (txt, md, csv, docx, xlsx, pptx; not PDF yet) reach the model as text, images as `file:<id>` references. `Accept: application/x-ndjson` streams `{step: {text, tools: [{name, error?}]}}` lines, then `{done}` |
| `POST /api/agent/apply-comments` | `{deck_id, model?}`: the open comments become `patch_deck` calls |

`node apps/server/eval/agent.ts anthropic:<model> openai:<model>` runs the Phase 4 checks on real models
(same brief → 0 lint ERROR, then 5 comments applied → 0 lint ERROR). Needs the providers' keys.
