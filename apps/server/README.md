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
| `CALQUE_PACKS` | `packs/` | packs registered for the whole workspace at start-up (see [Client workspaces](#client-workspaces-white-label)) |
| `CALQUE_TEST_PACKS` | unset | `1`: also seed the test packs (`test: true` in pack.yaml, e.g. `acme-test`); the tests and e2e set it. Unset, a test pack seeded earlier is archived |
| `CALQUE_DEFAULT_PACK` | unset | the pack New deck preselects, until an admin chooses another (Brand packs page) |
| `CALQUE_APP_NAME` | `Calque` | the app's name in the web chrome (sign-in page, sidebar, tab title) |
| `CALQUE_APP_LOGO` | unset: Calque's mark | an image URL for the logo in the web chrome |
| `CALQUE_PUBLIC_URL` | `http://localhost:$PORT` | base of preview, PNG and download links |
| `CALQUE_ENGINE` | `uv run … calque_engine call` | engine command (e.g. `python -m calque_engine call`) |
| `CALQUE_OIDC_ISSUER` | unset: no auth, loopback only | e.g. `https://sso.example.com/realms/<realm>` |
| `CALQUE_OIDC_AUDIENCE` | `calque` | audience the access tokens carry (Keycloak: audience mapper) |
| `CALQUE_TEAMS_CLAIM` | `groups` | token claim listing the user's teams (pack visibility) |
| `CALQUE_TEAMS_MAP` | unset | group id → team name, inline JSON or a JSON file path (Entra ID group GUIDs, see below) |
| `CALQUE_TEAMS_MAP_ONLY` | unset | `1`: drop the groups the map does not name |
| `CALQUE_OIDC_CLIENT_ID` | the audience | the web app's OIDC client (authorization code + PKCE) |
| `CALQUE_OIDC_CLIENT_SECRET` | unset: public client | its secret, for a confidential client |
| `CALQUE_OIDC_SCOPE` | `openid profile email` | scopes the web sign-in asks for; with Entra, add `GroupMember.Read.All` to read the groups over the overage with the sign-in's own token |
| `CALQUE_ENTRA_TENANT` / `_CLIENT_ID` / `_CLIENT_SECRET` | unset | an Entra app (application permission `GroupMember.Read.All`, admin consent) that reads a user's groups from Graph when the token leaves them out (group overage), on both doors (see [Microsoft Entra ID](#microsoft-entra-id)) |
| `CALQUE_ENTRA_AUTHORITY` / `_GRAPH` | `https://login.microsoftonline.com` / `https://graph.microsoft.com/v1.0` | sign-in and Graph endpoints for those lookups (national clouds, tests) |
| `CALQUE_SECRET` | random, in `$CALQUE_DATA/secret` | seals model API keys and Microsoft 365 refresh tokens at rest (AES-256-GCM) and sessions: required when `CALQUE_OIDC_ISSUER` is set (the server refuses to start without it) |
| `CALQUE_ADMIN_TEAM` | `calque-admins` | team allowed to configure AI models, to manage every brand pack (seeded ones included) and, on any deck, see who has access, make it private, reset its link and transfer it (never to read it) |
| `CALQUE_LLM_MODEL` | unset | preconfigured gateway, saved as model `env`, default unless another is set |
| `CALQUE_LLM_PROVIDER` / `_BASE_URL` / `_API_KEY` | `openai-compatible` / – / – | the gateway's provider, endpoint and key |
| `CALQUE_LLM_HEADERS` | unset | JSON object of extra request headers (e.g. `{"Ocp-Apim-Subscription-Key": "…"}`), sealed at rest |
| `CALQUE_LLM_AZURE_RESOURCE` / `_API_VERSION` / `_MANAGED_IDENTITY` | – / `v1` / – | Azure OpenAI (`CALQUE_LLM_PROVIDER=azure`, the model is the deployment): resource name, `api-version`, `1` to sign in with the managed identity |
| `CALQUE_M365_CLIENT_ID` | unset: no Microsoft 365 | the Entra app registration that lets users connect OneDrive and SharePoint (see [Microsoft 365](#microsoft-365-onedrive-sharepoint-and-teams)) |
| `CALQUE_M365_CLIENT_SECRET` | unset: public client | its secret, for a confidential (Web) client |
| `CALQUE_M365_TENANT` | `organizations` | tenant id or domain to sign in against (`organizations`: any work account) |
| `CALQUE_M365_AUTHORITY` / `_GRAPH` | `https://login.microsoftonline.com` / `https://graph.microsoft.com/v1.0` | sign-in and Graph endpoints (national clouds, tests) |
| `CALQUE_LINK_DAYS` | unset: no expiry | days a deck's share link keeps opening for general access when a private deck is opened up (`set_general_access`); the owner may change it per deck |
| `CALQUE_RETENTION_DAYS` | unset: keep everything | delete decks untouched for that many days and uploads older than that, at start and daily (the audit log is kept) |
| `CALQUE_RATE_LIMIT` | on | `off` lifts the per-minute limits on `/auth/*` (30 per address), agent runs (30 per user) and model tests (10 per user) |
| `CALQUE_TRUST_PROXY` | unset | `1`: rate-limit by the first `X-Forwarded-For` hop (behind your reverse proxy) instead of the socket address |
| `CALQUE_MODEL_HOSTS` | unset: any host | allow-list of model endpoint hosts (`api.example.com,.openai.azure.com`); metadata addresses are always refused ([security](../../docs/security.md)) |
| `CALQUE_TEAMS_PREFIX` | unset: every group | keep only the teams starting with it (after `CALQUE_TEAMS_MAP`), and `CALQUE_ADMIN_TEAM` |
| `CALQUE_SCIM_TOKEN` | unset: no SCIM | bearer token of the SCIM 2.0 endpoint `/scim/v2/Users` (deprovisioning) |

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

### Client workspaces (white-label)

A deployment for a client shows neither Diametral nor its pack unless it chooses to:

- **Packs**: every folder of `CALQUE_PACKS` with a `pack.yaml` is seeded workspace-wide at
  start-up. Point it at a folder holding only the client's pack(s) (mount it, e.g.
  `-v ./client-packs:/app/client-packs:ro -e CALQUE_PACKS=/app/client-packs`) so the `diametral`
  pack is not offered; or import the client's template on the Brand packs page and archive the
  others. Test packs (`test: true`, e.g. `acme-test`) are never seeded unless `CALQUE_TEST_PACKS=1`.
  A pack already seeded stays registered when it leaves `CALQUE_PACKS`: archive it there.
- **Default pack**: `CALQUE_DEFAULT_PACK=<id>` (or an admin's "Make default" on the Brand packs
  page) preselects it in New deck and Import PPTX.
- **App chrome**: the name and logo on the sign-in page, the sidebar and the tab title come from
  `CALQUE_APP_NAME` (default `Calque`) and `CALQUE_APP_LOGO` (an image URL; default Calque's
  mark), served at `GET /api/branding`. The web app keeps its UI kit (diametral-ds) but shows no
  Diametral mark: Diametral appears only as a pack, when that pack is seeded.

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

### PowerPoint round trip

The engine tags every slide it builds (PowerPoint slide tags: the slide id, and the spec of a drawn
slide). `import_pptx` with `deck_id` brings an exported deck edited in PowerPoint back as the next
version of that deck: history and comments are kept, tagged slides keep their ids, and charts,
diagrams and compositions stay drawn with the client's text, notes, table and chart-data edits
merged into their spec (`set_params` keeps working). A drawn slide whose shapes were added,
removed, moved, resized or restyled, or whose text the spec cannot hold, becomes an `imported`
clone kept exactly as the client left it. The result's `import` report lists `drawn`, `imported`,
`demoted` (with the reason) and `conflicts` (drawn slides changed in Calque after the export: the
file wins). `copy_slides` copies slides between decks: drawn slides to any pack, template and
imported clones to the same pack (imported ones are grafted into the target's base file). Images
another user uploaded are copied into the caller's uploads.

### Slide library

Each brand pack has a library of approved slides people reuse: case studies, references, client
logos, team bios, boilerplate. `library_add` copies one slide of a deck you edit into it, with a
title and tags; the pack's owner or an admin approves it (`library_review`, `approve`), and their
own additions are approved at once. Everyone who sees the pack searches the approved entries
(`library_list`: words of the title or tags, `tags`) and inserts one into a deck
(`library_insert`, the `copy_slides` rules). A pending entry is visible only to its author and the
pack's managers; `library_review` `remove` rejects or retires an entry (its author may withdraw a
pending one). An entry is a copy: a hidden one-slide deck owned by `library:<pack id>` (its images
and imported slide copied with it), so editing or deleting the source deck leaves it as it was, and
`CALQUE_RETENTION_DAYS` keeps it. `GET /api/library/:id/slide.png` is its thumbnail. The workflows
(core/workflows) look there for proof points before naming a gap.

### Image library

Next to it, each pack has a library of approved images (photography, client logos, product
shots). `image_library_add` takes an image the caller uploaded (`file_id`: `upload_url`,
`POST /api/files`, `m365_import`) with a title and tags, copied into the library (a file owned by
`library:<pack id>`, kept by `CALQUE_RETENTION_DAYS`); the pack's owner or an admin approves it
(`image_library_review`), their own additions approved at once. Everyone who sees the pack searches
the approved images (`image_library_list`: words of the title or tags, `tags`) and places one in a
picture slot as its `ref` (`"image": "file:<file_id>"`). On save the deck gets its own copy, so a
pending image is never placed and removing an image (`image_library_review` `remove`, which deletes
its file) never breaks a deck. `GET /api/library/images/:id` serves the image (sandboxed). In the
web app: the *Images* section of the editor's Library tab.

### Sharing

Artifact style: people with access, and one share link per deck. Roles, each including the ones
before it: **viewer** (open, lint, export, list comments, present), **commenter** (+ comment),
**editor** (+ `patch_deck`, `add_slides`, `copy_slides` (viewer on the source deck), `import_pptx` with `deck_id`, `restore_version`, `review_deck`), **owner** (+ manage
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
  general role `viewer` or `commenter`, never editor. **Expiry**: `set_general_access
  {expires_in_days}` (0: none) makes the link stop opening for general access after that many days
  (people with access still open it; a holder of the expired link gets 403 "share link expired");
  when a private deck opens up without it, `CALQUE_LINK_DAYS` sets the default (unset: no expiry).
  The Share dialog shows the date and changes it. `reset_link` rotates the key, and
  every copy of the old link stops working at once. Comments through an anonymous link are signed
  `guest`. `list_shares` returns the owner, the people, the general access (with `expires_at`) and, for the
  owner, the link `url`.
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

### Finding and managing decks

- **Search**: `list_decks {query?, pack_id?}` (or `GET /api/decks?q=&pack_id=`, the search box and
  pack filter on the Decks page) keeps the decks whose name or current slides contain every word of
  `query`, case and accents ignored: a client's name finds the decks made for it (cover, slide
  text), with no client field to fill in.
- **Rename** (`rename_deck {deck_id, title}`, editor): the name the lists, the editor and the export
  file names show. It is stored on the deck, apart from its DeckSpec: no new version, and later
  versions keep it. By default (and after renaming to `""`) a deck shows its DeckSpec title.
- **Duplicate** (`duplicate_deck {deck_id, title?}`, viewer, signed in): a new deck owned by the
  caller, a copy of the current version as its v1, titled `<name> (copy)` by default. History,
  comments, shares and approval stay with the original. An imported deck's file comes along, and the
  uploaded images it places are copied to the caller's uploads.

### Audit log and deletion

The `audit` table records who did what, never the content: deck `create`, `edit` (version, note),
`export`, `rename`, `delete`, the sharing actions above; pack `publish`, `edit`, `visibility`, `default`; model `add`,
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

Outputs: `export_pptx` (`/decks/:id/deck.pptx`) and `export_pdf` (`/decks/:id/deck.pdf`, rendered by
LibreOffice with the pack's fonts, like the previews; one file per version), `m365_save` to
OneDrive or SharePoint and `m365_share_teams` to a Teams channel or chat (below).

### Microsoft 365: OneDrive, SharePoint and Teams

With `CALQUE_M365_CLIENT_ID` set, each user connects their own Microsoft 365 account once, then:

- `m365_list` browses their OneDrive (default), a folder (`folder_id`, `drive_id`), a search in a
  drive (`search`), SharePoint sites by name (`sites`) and a site's document libraries (`site_id`).
- `m365_import` copies a file (PowerPoint, Word, Excel, PDF, CSV, text, image; 50 MB max) into
  their uploads and returns a `file_id`, used like an upload: `import_pptx`, `import_pack`, chat
  attachments, `file:<file_id>` images.
- `m365_save` saves a deck as PPTX or PDF into a folder (default: their OneDrive root) through an
  upload session, never overwriting (a taken name gets a new one), and returns its `web_url`. A
  PPTX with lint ERRORs takes a `reason`, recorded like `export_pptx`.
- `m365_teams` lists the user's joined teams, a team's channels (`team_id`) or their recent chats
  (`chats: true`); `m365_share_teams` posts, as the user, a message with the deck's link in a
  channel (`team_id`, `channel_id`) or a chat (`chat_id`), with their `message` and the saved file's
  `web_url` (`file_url`) if given. The link is the share link when the caller owns the deck and its
  general access is open (not expired); otherwise the app's page of the deck (`/d/:id`), which opens
  for the people with access only, and the result says so. Logged as `share_teams`.

In the web app: *From Microsoft 365* in the Import PPTX dialog and next to the chat's attach button,
*Save to SharePoint* and *Share to Teams* next to Export (and *Share to Teams* after a save, with
the saved file's link).

**Connecting.** This is separate from sign-in (which may use another issuer, and keeps no token):
OAuth authorization code + PKCE against Entra, scopes `offline_access User.Read
Files.ReadWrite.All Sites.Read.All Team.ReadBasic.All Channel.ReadBasic.All ChannelMessage.Send
Chat.ReadBasic ChatMessage.Send` (delegated, no admin consent needed; `Files.ReadWrite.All`
because saving into a SharePoint library is a write outside the user's OneDrive). A user connected
before the Teams scopes were added is asked to connect again (the refresh is refused for the new
scopes). The web app links
to `/auth/m365/connect?return=<path>`; an MCP client gets that URL in the tool's error, for the
user to open in a browser (signed in to Calque first, through `/auth/login`: a bearer link could
bind a Microsoft account to the wrong Calque user). The callback,
`<public url>/auth/m365/callback`, stores the user's refresh token sealed with AES-256-GCM under
`CALQUE_SECRET` (set it: a rotated secret means reconnecting), keeps access tokens in memory only,
and calls Graph with plain `fetch` as the user, so Calque reaches only what they can open. A
revoked or expired grant deletes the stored token and asks to connect again.

**App registration.** In Entra, *App registrations > New registration*: redirect URI (Web)
`<public url>/auth/m365/callback`; *API permissions* > Microsoft Graph > Delegated: `User.Read`,
`Files.ReadWrite.All`, `Sites.Read.All`, `Team.ReadBasic.All`, `Channel.ReadBasic.All`,
`ChannelMessage.Send`, `Chat.ReadBasic`, `ChatMessage.Send`, `offline_access`; a client secret for
`CALQUE_M365_CLIENT_SECRET`. It may be the sign-in registration with this redirect URI added.

| Route | |
| --- | --- |
| `GET /api/m365` | `{configured, connected, account}` for the caller |
| `DELETE /api/m365` | disconnect: the stored refresh token is deleted |
| `GET /auth/m365/connect` | start connecting as the signed-in user (else sign-in first); `?return=` a path on this site |
| `GET /auth/m365/callback` | Entra's redirect: tokens kept, back to `return` |

## Web app

The server also serves the built web app (`apps/web/dist`) on `/`. With `CALQUE_OIDC_ISSUER` set,
the browser signs in at `/auth/login` (code + PKCE against the issuer; redirect URI
`<public url>/auth/callback`) and gets an 8-hour signed `HttpOnly` session cookie; every `/api` route
refuses a request without a session or a bearer token. The Keycloak login theme ships with the
design system: `node_modules/@diametral/design-system/keycloak/diametral`.

Sessions are checked server-side on each request: sign-out revokes the session, the
`revoke_sessions` tool (admins) revokes all of a user's sessions, and a user deactivated over SCIM
(`/scim/v2/Users`, with `CALQUE_SCIM_TOKEN`) can neither sign in nor use a session or a token. A
cookie-authenticated write (`POST`, `DELETE`… on `/api` and `/decks`) must come from `CALQUE_PUBLIC_URL`'s origin
(`Origin`, else `Referer`): 403 otherwise. Details in [docs/security.md](../../docs/security.md).

### Microsoft Entra ID

Entra ID works as the issuer for both doors, next to Keycloak:

1. **App registration** (single tenant). Web redirect URI `<public url>/auth/callback`; a client
   secret for `CALQUE_OIDC_CLIENT_SECRET`. *Expose an API* with a scope (e.g. `access_as_user`), and
   set `"accessTokenAcceptedVersion": 2` in the manifest so access tokens carry the v2 issuer.
2. **Groups claim.** *Token configuration > Add groups claim*, and prefer *Groups assigned to the
   application*: past 200 groups Entra leaves `groups` out of the token (the overage claim,
   `_claim_names.groups` or `hasgroups`). Calque then reads the user's groups (transitive, nested
   groups included) from Microsoft Graph, kept 10 minutes per user:
   - **app-only** (both doors; the MCP door's bearer token is for Calque, not Graph): set
     `CALQUE_ENTRA_TENANT`, `CALQUE_ENTRA_CLIENT_ID`, `CALQUE_ENTRA_CLIENT_SECRET` for an app
     registration (it may be this one) with the Graph *application* permission
     `GroupMember.Read.All`, admin-consented; Calque calls
     `/users/{oid}/transitiveMemberOf/microsoft.graph.group` with a client-credentials token;
   - **delegated** (web sign-in only): add `GroupMember.Read.All` to `CALQUE_OIDC_SCOPE`
     (`openid profile email GroupMember.Read.All`, admin consent): the sign-in's access token is
     then a Graph token, and Calque calls `/me/transitiveMemberOf/microsoft.graph.group` with it.

   With neither, or when Graph fails, Calque logs a warning naming the user, who then has no teams
   (they still sign in).
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

4. **Claude's MCP connector.** Claude (claude.ai, Desktop, Cowork) registers itself as an OAuth
   client through dynamic client registration (DCR) unless it is given one. Entra has no DCR, so a
   custom connector pointing at `<public url>/mcp` cannot sign in on its own. Workaround: a
   pre-registered client. Simplest is this same app registration: under *Authentication*, add
   Claude's OAuth callback `https://claude.ai/api/mcp/auth_callback` as a Web redirect URI, and
   create a client secret for Claude. In Claude, *Settings > Connectors > Add custom connector*:
   URL `<public url>/mcp` and, under *Advanced settings*, its **OAuth Client ID** (the application
   id) and **OAuth Client Secret**. The connector then asks Entra for this API's scope, and its
   access tokens carry the audience Calque checks (`CALQUE_OIDC_AUDIENCE`). Another MCP client
   without DCR takes the same pre-registered client (see its documentation for where to enter it).
   Alternatively, broker Entra through Keycloak, which supports DCR.

Limits: to cut a removed user's
access before their 8-hour cookie expires, provision the enterprise application over SCIM to
`<public url>/scim/v2` with `CALQUE_SCIM_TOKEN` as the secret token, and map `userName` to the
`preferred_username` (UPN) the tokens carry.

| Route | |
| --- | --- |
| `GET /api/me` | the signed-in user, their teams, `admin` |
| `GET /api/decks` | the user's decks and the decks shared with them, each with `role` and `owner`; `?q=` and `?pack_id=` filter them as `list_decks` does |
| `GET /api/branding` | `{name, logo}` for the web chrome (`CALQUE_APP_NAME`, `CALQUE_APP_LOGO`), no sign-in needed |
| `POST /api/files` | multipart `file` (50 MB max, else 413) → `{file_id, name, size, type}`, owned by the caller; `?ticket=` from `upload_url` instead of credentials |
| `GET /api/library/:id/slide.png` | a slide library entry's image, for whoever may see the entry |
| `GET /api/library/images/:id` | an image library image, for whoever may see it (sandboxed CSP) |
| `POST /api/packs/drafts` | multipart `template` (.pptx or .potx), `id`, `name`, optional `tokens` (tokens.json): extracted draft (manifest with guessed roles and the fonts/colours the slides use, resolved colours and fonts to review, archetype names, one PNG per template slide) |
| `POST /api/packs/drafts/:id/fonts` | multipart `font` (.ttf, .otf): its family is allowed by lint (`lint.extra_fonts`) on publish |
| `POST /api/packs/drafts/:id/template` | multipart `template`: a new template.pptx; the map and template-bound manifest fields are re-extracted |
| `POST /api/packs/drafts/:id/tokens` | multipart `tokens`: a new tokens.json (DTCG), checked at publish |
| `POST /api/packs/drafts/:id/publish` | `{manifest, voice?, note?, visibility, teams?}`: validated (template lint, test deck), DESIGN.md regenerated, then published as the pack's next release |
| `GET /api/packs` | the Brand packs page: packs the user sees or manages, archived ones included, with `owner`, `pack_version`, `archived`, `editable` |
| `POST /api/packs/:id/edit` | an edit draft of the current release, owner or admin |
| `POST /api/packs/:id/visibility` | `{visibility, teams?}`, owner or admin |
| `POST /api/packs/:id/archive` | `{archived}`: hidden from pickers and new decks, its decks still open; owner or admin |
| `POST /api/packs/:id/default` | `{default}` (default `true`): the pack New deck preselects for everyone (workspace-wide, not archived); `false` clears it; admins. `list_packs` and `GET /api/packs` mark it `default` |
| `GET /api/packs/:id/versions` | the pack's releases (changelog), newest first; owner or admin |
| `POST /api/packs/:id/restore` | `{version, note?}`: that release becomes current again, as a new release; owner or admin |

## Web agent (API door)

The web app's agent (`@calque/agent`) runs in this process and is an MCP client of this same server,
connected in memory as the calling user: same tools, same `core://` / `pack://` knowledge, same
prompts as Claude. Models go through `@calque/llm` only.

| Route | |
| --- | --- |
| `GET /api/models` | provider catalog + configured models (never their keys) |
| `POST /api/models` | `{id?, provider, model, label?, api_key?, base_url?, headers?, resource?, api_version?, managed_identity?, default?}`: tested with a 1-token call, refused (422) if the provider refuses. With `id`: edits that configuration (an unset key or `headers` keeps the stored ones). Without: id `provider:model`, `@<label>` if labelled; the same model on another endpoint gets `@2`, `@3`… instead of overwriting |
| `POST /api/models/:id/default`, `DELETE /api/models/:id` | the default is read on every call: no restart; removing the default promotes the most recently configured model |
| `POST /api/agent/chat` | `{messages, workflow?, pack_id?, deck_id?, model?, files?}` → `{model, text, messages}`; the client keeps the conversation. `files`: uploaded file ids; documents (txt, md, csv, docx, xlsx, pptx; not PDF yet) reach the model as text, images as `file:<id>` references. `Accept: application/x-ndjson` streams `{step: {text, tools: [{name, error?}]}}` lines, then `{done}` |
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
