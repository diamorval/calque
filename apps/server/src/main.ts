// HTTP entry: MCP (Streamable HTTP) on /mcp, REST on /api, web preview on /decks/:id.
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import type { AuthConfig } from "./auth.ts";
import { createHttp } from "./http.ts";
import { sessions } from "./session.ts";
import { teamsConfig } from "./teams.ts";

const app = await createApp();
const issuer = process.env.CALQUE_OIDC_ISSUER;
const { claim, ...teams } = teamsConfig();
const auth: AuthConfig | undefined = issuer
  ? {
      issuer,
      audience: process.env.CALQUE_OIDC_AUDIENCE ?? "calque",
      resource: new URL("/mcp", app.publicUrl),
      teamsClaim: claim,
      teams,
    }
  : undefined;
// the web app signs in against the same issuer (CALQUE_OIDC_CLIENT_ID: its client, default the audience)
const web = auth
  ? sessions({
      issuer: auth.issuer,
      clientId: process.env.CALQUE_OIDC_CLIENT_ID ?? auth.audience,
      clientSecret: process.env.CALQUE_OIDC_CLIENT_SECRET,
      publicUrl: app.publicUrl,
      teamsClaim: auth.teamsClaim,
      teams: auth.teams,
      secret: app.secret,
    })
  : undefined;
const port = Number(process.env.PORT ?? 8787);
// without an issuer the server trusts every caller: listen on loopback only
const hostname = auth ? "0.0.0.0" : "127.0.0.1";
serve({ fetch: createHttp(app, auth, web).fetch, port, hostname }, () =>
  console.error(`calque on ${app.publicUrl} (mcp: /mcp, auth: ${auth ? issuer : "off, local only"})`),
);
