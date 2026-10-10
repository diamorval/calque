# Security

What the server enforces for an on-premise or cloud deployment, and what is left to the network.
Configuration is in [`apps/server/README.md`](../apps/server/README.md).

## Model endpoints (SSRF)

Admins configure AI models with a `base_url` that the **server** calls (`apps/server/src/egress.ts`).
The server checks it when a model is saved (before its test call) and every time a model is used,
including the deployment's `CALQUE_LLM_*` gateway:

- only `http` and `https`;
- `CALQUE_MODEL_HOSTS`, when set, is an allow-list: comma-separated host names or IPs, and
  `.example.com` (or `*.example.com`) for any subdomain. A model whose host is not on it is refused
  (422), whatever its provider. Ollama without a base URL is checked as `localhost`. Providers called
  without a base URL (Anthropic, OpenAI, Mistral, Gemini on their public APIs) are not checked;
- link-local and cloud metadata addresses are always refused, whether the host is an IP literal or a
  name resolving to one: `169.254.0.0/16`, `fe80::/10`, `fd00:ec2::254`, `100.100.100.200`
  (IPv4-mapped IPv6 included). Only an entry naming the host exactly in `CALQUE_MODEL_HOSTS` lifts this.

Loopback and private addresses are allowed unless the allow-list says otherwise: an internal gateway
or Ollama on the same host is a normal deployment.

The name is resolved at check time; the provider SDK resolves it again when it calls, so a hostile
DNS server could answer differently (DNS rebinding). Production deployments should also restrict
the server's egress at the network level (firewall, egress proxy) to the model hosts.

## Web sessions

Sign-in is OIDC authorization code + PKCE (`apps/server/src/session.ts`). The session is a signed,
`HttpOnly`, `SameSite=Lax` cookie, `Secure` on https, valid 8 hours. It carries a random session id
and its issue time, checked server-side on every request (`apps/server/src/access.ts`):

- **sign-out** (`/auth/logout`) revokes that session id until it would have expired, so a copied cookie
  stops working too;
- **revoke a user's sessions:** the `revoke_sessions` tool (`POST /api/tools/revoke_sessions`
  `{user}`, admins only) revokes every session issued before now for a user id (OIDC `sub`) or user
  name. The user can sign in again;
- **deprovisioning:** a user deactivated or deleted over SCIM cannot use a session, a bearer token
  (REST or MCP) or sign in.

## SCIM 2.0

With `CALQUE_SCIM_TOKEN` set, the IdP (Entra ID, Okta, Keycloak with a SCIM plugin) provisions users
on `<public url>/scim/v2/Users`, authenticated by `Authorization: Bearer <CALQUE_SCIM_TOKEN>`.
Users only, no groups:

| | |
| --- | --- |
| `GET /scim/v2/Users?filter=userName eq "…"` | list; filters `userName eq`, `externalId eq`, `id eq`; `startIndex`, `count` |
| `GET /scim/v2/Users/:id` | one user |
| `POST /scim/v2/Users` | `{userName, externalId?, displayName?, active?}`; 409 if the userName exists |
| `PUT /scim/v2/Users/:id` | replace those attributes |
| `PATCH /scim/v2/Users/:id` | `add`/`replace` on `active`, `userName`, `externalId`, `displayName` (with or without `path`; `"False"` strings accepted); others ignored |
| `DELETE /scim/v2/Users/:id` | 204; the user stays blocked here |

`active: false` or `DELETE` revokes the user's sessions and blocks sign-in; `active: true` lets them
sign in again (their earlier sessions stay revoked). A SCIM user matches a signed-in user when its
`id` or `externalId` is the OIDC `sub`, or its `userName` is the `sub`, `preferred_username`, `email` or
`upn` claim (case-insensitive): map the IdP's SCIM `userName` to the same value as one of those claims.

Teams come from one token claim (`CALQUE_TEAMS_CLAIM`). `CALQUE_TEAMS_PREFIX` keeps only the groups
whose name starts with it (and the admin team), so that a user's hundreds of directory groups do not
become Calque teams. Entra ID group GUIDs and group overage are not resolved: configure the IdP to
emit group names.

## CSRF

Besides `SameSite=Lax`, a state-changing `/api` request (not GET, HEAD or OPTIONS) authenticated by
the session cookie must carry an `Origin` header, or else a `Referer`, whose origin is exactly
`CALQUE_PUBLIC_URL`'s; otherwise it is refused with 403. Requests with an `Authorization` header (MCP
clients, API clients) carry no ambient credential and are exempt. Set `CALQUE_PUBLIC_URL` to the URL
users open: behind a proxy that rewrites the host, the browser's `Origin` must still match it. The
Vite dev server presents the server's origin to it.
