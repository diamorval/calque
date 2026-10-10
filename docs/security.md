# Security and data handling

This page is for IT and security teams reviewing a Calque deployment. It covers where content goes,
what is stored and logged, the knobs that decide where data lives, and the controls in place.
Every variable mentioned here is described in [apps/server/README.md](../apps/server/README.md).

## Data flow: two doors, two model paths

Calque has two doors onto one engine. The **Calque server never calls a model through the MCP
door**. Only the web door's agent calls a model.

| | MCP door (`/mcp`, stdio) | Web door (`apps/web`, `/api/agent/*`) |
| --- | --- | --- |
| Who runs the model | The user's Claude client (Claude Code, Cowork, Claude), on **their Claude subscription**: the model runs at **Anthropic** | The **Calque server**, on the model an admin configured in Settings > AI Models, or on `CALQUE_LLM_*` |
| What reaches the model provider | Whatever the client puts in the conversation: the user's prompts and files, plus Calque's tool results (DeckSpec JSON, lint findings, comments, slide image URLs, pack resources such as `DESIGN.md` and the voice) | The conversation the browser sends, the text extracted from attached files, Calque's doctrine and pack resources, and tool results (DeckSpec, lint findings, comments). Images are sent as `file:<id>` references, not as bytes |
| Who reaches Calque | The client calls `/mcp`. A web client (Claude, Cowork) calls it from Anthropic's infrastructure, so the server must be reachable from there. Claude Code with stdio calls it from the user's machine | The browser, after OIDC sign-in |
| Where that provider's data terms come from | The user's or organisation's Anthropic plan | The provider the admin picked: Anthropic, OpenAI, Mistral, Gemini, Ollama or any OpenAI-compatible endpoint (for example an Azure OpenAI deployment or an internal gateway) |

To keep deck content away from a third-party model, use only the web door, on a model you host
(Ollama, or an `openai-compatible` endpoint inside your network), and do not register the MCP
server in Claude clients. The server has no switch that turns the MCP door off: only the
clients you register reach it.

### Microsoft 365 (OneDrive, SharePoint)

Off unless `CALQUE_M365_CLIENT_ID` is set. Each user connects their own account (OAuth code +
PKCE against Entra ID, delegated scopes `User.Read Files.ReadWrite.All Sites.Read.All
offline_access`); the server then calls Microsoft Graph **as that user**, from its own network:

- **In**: a file the user picks (`m365_import`) is downloaded once into their uploads, like a file
  they uploaded, and follows the uploads' rules (owner only, 50 MB, retention). Through the web
  door its text may then reach the configured model as an attachment.
- **Out**: `m365_save` uploads the built PPTX or PDF into the folder the user picks. It never
  overwrites a file, and is recorded in the audit log (`save_m365`: deck, version, format, file
  name, drive; a PPTX with lint ERRORs also as an export with its reason).
- **Stored**: the user's refresh token (sealed with AES-256-GCM under `CALQUE_SECRET`, deleted on
  disconnect or when Entra refuses it) and their account name. Access tokens stay in memory. The
  server reaches only the files and sites the user can, and only when the user calls a tool.
  Revoking the app's consent in Entra, or `DELETE /api/m365`, ends it.

Slide renders (LibreOffice and pdftoppm) and every PPTX operation run inside the server's
container. The engine itself makes no network calls. A PPTX that links to remote content could
make the renderer try to fetch it, so lint reports such links (see Controls).

## What is stored

Everything lives in two places the operator chooses:

- **The database** (`DATABASE_URL`, Postgres in production; embedded PGlite in `$CALQUE_DATA/pg`
  otherwise): decks, every DeckSpec version (deck text, which may include personal data), comments,
  shares, pack registry, slide library entries, uploaded files' metadata, AI model configuration,
  Microsoft 365 connections (sealed refresh tokens), the audit log.
- **The data directory** (`CALQUE_DATA`, a volume): built PPTX per version, slide PNGs, imported
  decks, uploads, imported brand packs and pack drafts.

Model API keys are sealed with AES-256-GCM under `CALQUE_SECRET` and never returned by the API.
Web sessions are signed with the same secret: an 8-hour HttpOnly cookie, Secure over HTTPS. When
`CALQUE_OIDC_ISSUER` is set, the server refuses to start without `CALQUE_SECRET`, so an ephemeral
data directory cannot silently rotate the key.

The agent's conversation is not stored on the server: the browser keeps it and sends it with
each turn.

## What is logged

- **The audit log** (`audit` table): who did what, when, never the content itself. Deck create,
  edit (version and note), export, delete, share, unshare, general access change, link reset and
  transfer; pack publish, edit and visibility change; model add, update, default and remove;
  sign-in; Microsoft 365 connect, disconnect and saves; slide library add, approve and remove;
  retention purges. Rows outlive what they name: a deleted deck's history stays. Admins
  (`CALQUE_ADMIN_TEAM`) read it at `GET /api/admin/audit`, filtered by `actor`, `action`,
  `target_type`, `target_id`, `since` and `until`.
- **Process output** (stderr): start-up, retention summaries, and the engine's error output when an
  engine call crashes. That output is a Python traceback, which may quote deck text. Send stderr
  to a log store with the same access rules as the data.
- **No prompt logging.** The server does not log prompts, model answers or DeckSpecs. The model
  provider's own retention applies to what it receives (see the table above).

## Deletion and retention

- `delete_deck`, `DELETE /api/decks/:id`, or Delete on the Decks page: the deck's owner, or an
  admin, erases the deck with its versions, comments, shares and its folder (built PPTX, renders,
  imported base). This cannot be undone. The audit log keeps a record that the deck existed and
  who deleted it.
- `CALQUE_RETENTION_DAYS=N` (off by default) runs at start-up and then daily. It deletes decks
  whose latest version is more than N days old, and uploads older than N days, including leftover
  inline imports. An upload that a remaining deck still uses is kept. Slide library entries are
  kept until a pack manager removes them: an entry is a copy, so deleting its source deck does not
  remove it.
- Postgres backups and volume snapshots are the operator's to expire.

## Residency knobs

| Knob | Decides |
| --- | --- |
| `DATABASE_URL` | where the database lives (the region of your Postgres) |
| `CALQUE_DATA` | where files live (the volume's region) |
| Settings > AI Models, `CALQUE_LLM_PROVIDER` / `_BASE_URL` / `_MODEL` | which provider, which endpoint and so which region the web door's model runs in. An EU endpoint, an Azure OpenAI deployment in your tenant, or an on-premise Ollama keeps prompts in that region |
| Which Claude clients register `/mcp` | whether content reaches Anthropic through the MCP door |
| `CALQUE_PUBLIC_URL` and your reverse proxy | which network can reach the server |

## Controls

- **Authentication**: OIDC. The web app uses the authorization code flow with PKCE. MCP clients
  send bearer tokens, checked for issuer and audience. Without an issuer, the server listens on
  loopback only.
- **Authorization**: decks are private to their owner unless shared. Admins manage a deck's access
  and may delete it, but never read it. Only admins configure models.
- **Request limits**: uploads (`/api/files`, pack template, fonts) are capped at 50 MB. JSON calls
  that may carry a file in base64 (`/api/tools/*`, `/mcp`) are capped at the same file size, and
  the tool checks the decoded size again.
- **Rate limits** (in memory, per minute): 30 sign-in requests per address, 30 agent runs per user,
  10 model tests per user. A 429 response carries `Retry-After`. Behind a reverse proxy, set
  `CALQUE_TRUST_PROXY=1`.
- **PPTX content checks** (`lint_deck`, run on imported and exported decks): an OLE object or an
  ActiveX control, a remote template, and any picture, media or data fetched from elsewhere when
  the file opens are reported as ERROR. A hyperlink out of the deck is reported as WARN.
- **Supply chain**: the CI `audit` job runs `pnpm audit --prod` (it fails on critical advisories)
  and `pip-audit --strict` on the engine's locked dependencies. It also builds a CycloneDX SBOM of
  the repository (TypeScript and Python, from `pnpm-lock.yaml` and `uv.lock`), kept as the
  `calque-sbom.cdx.json` build artifact.

## Known limits

- Rate limits and per-deck locks live in one process. Running several server instances needs a
  shared store.
- There is no egress allow-list for a model's `base_url`. An admin can point it at any host the
  server reaches.
- CSRF protection relies on `SameSite=Lax` cookies and JSON bodies. There is no token and no
  `Origin` check.
- A user removed from the identity provider keeps a valid session until it expires (8 hours).
