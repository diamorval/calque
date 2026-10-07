// HTTP entry: MCP (Streamable HTTP) on /mcp, REST on /api, web preview on /decks/:id.
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import type { AuthConfig } from "./auth.ts";
import { createHttp } from "./http.ts";

const app = await createApp();
const issuer = process.env.CALQUE_OIDC_ISSUER;
const auth: AuthConfig | undefined = issuer
  ? {
      issuer,
      audience: process.env.CALQUE_OIDC_AUDIENCE ?? "calque",
      resource: new URL("/mcp", app.publicUrl),
      teamsClaim: process.env.CALQUE_TEAMS_CLAIM ?? "groups",
    }
  : undefined;
const port = Number(process.env.PORT ?? 8787);
// without an issuer the server trusts every caller: listen on loopback only
const hostname = auth ? "0.0.0.0" : "127.0.0.1";
serve({ fetch: createHttp(app, auth).fetch, port, hostname }, () =>
  console.error(`calque on ${app.publicUrl} (mcp: /mcp, auth: ${auth ? issuer : "off, local only"})`),
);
