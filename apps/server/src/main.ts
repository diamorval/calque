// HTTP entry: MCP (Streamable HTTP) on /mcp, REST on /api, web preview on /decks/:id.
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { audit } from "./audit.ts";
import type { AuthConfig } from "./auth.ts";
import { createHttp } from "./http.ts";
import { seededPacks } from "./packs.ts";
import { purge, retentionDays } from "./retention.ts";
import { sessions } from "./session.ts";
import { teamsConfig } from "./teams.ts";

const app = await createApp();
// a client deployment sets CALQUE_PACKS to its own packs: say which ones every user is offered
console.error(
  `packs seeded for the whole workspace from ${process.env.CALQUE_PACKS ?? "packs/ (CALQUE_PACKS unset)"}: ${(await seededPacks(app.db)).join(", ") || "none"}`,
);
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
      access: app.access,
      onSignIn: (u) => audit(app.db, u, "sign_in", "user", u.id, { name: u.name }),
    })
  : undefined;
// CALQUE_RETENTION_DAYS: purge stale decks and uploads at start, then daily
const days = retentionDays();
if (days) {
  const run = () => purge(app, days).then((r) => console.error(`retention (${days} days): ${r.decks} deck(s), ${r.files} upload(s) purged`), console.error);
  void run();
  setInterval(run, 86_400_000).unref();
}
const port = Number(process.env.PORT ?? 8787);
// without an issuer the server trusts every caller: listen on loopback only
const hostname = auth ? "0.0.0.0" : "127.0.0.1";
serve({ fetch: createHttp(app, auth, web).fetch, port, hostname }, () =>
  console.error(`calque on ${app.publicUrl} (mcp: /mcp, auth: ${auth ? issuer : "off, local only"})`),
);
