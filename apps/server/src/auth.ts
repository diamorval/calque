import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import {
  OAuthError,
  OAuthErrorCode,
  getOAuthProtectedResourceMetadataUrl,
  requireBearerAuth,
  type AuthInfo,
  type OAuthMetadata,
  type OAuthTokenVerifier,
} from "@modelcontextprotocol/server";
import type { Identity } from "./access.ts";
import type { User } from "./packs.ts";
import { resolveTeams, type TeamsConfig } from "./teams.ts";

/** OAuth resource server: tokens come from an external authorization server (Keycloak, Entra ID). */
export interface AuthConfig {
  issuer: string; // CALQUE_OIDC_ISSUER, e.g. https://sso.example.com/realms/acme
  audience: string; // CALQUE_OIDC_AUDIENCE: the client id / audience tokens are minted for
  resource: URL; // this server's MCP endpoint, <public url>/mcp
  teamsClaim: string; // CALQUE_TEAMS_CLAIM, default "groups"
  teams?: Omit<TeamsConfig, "claim"> | undefined; // CALQUE_TEAMS_MAP, CALQUE_TEAMS_MAP_ONLY (Entra group ids), CALQUE_TEAMS_PREFIX
  keys?: JWTVerifyGetKey; // tests inject a local key set...
  metadata?: OAuthMetadata; // ...and the authorization server metadata
}

export function verifier(cfg: AuthConfig, metadata: () => Promise<OAuthMetadata>): OAuthTokenVerifier {
  let keys = cfg.keys;
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      keys ??= createRemoteJWKSet(new URL((await metadata()).jwks_uri as string));
      try {
        const { payload } = await jwtVerify(token, keys, { issuer: cfg.issuer, audience: cfg.audience });
        return {
          token,
          clientId: String(payload.azp ?? payload.client_id ?? payload.sub),
          scopes: typeof payload.scope === "string" ? payload.scope.split(" ") : [],
          expiresAt: payload.exp ?? 0, // no exp: the SDK refuses the token
          extra: {
            sub: payload.sub,
            names: namesOf(payload),
            // shown as the author of versions and comments (S18); the sub stays the id
            ...(typeof payload.name === "string" ? { name: payload.name } : {}),
            // over the Entra group overage, read from Graph (app-only: this token is for Calque)
            teams: await resolveTeams(payload, { ...cfg.teams, claim: cfg.teamsClaim }),
          },
        };
      } catch (e) {
        throw new OAuthError(OAuthErrorCode.InvalidToken, (e as Error).message);
      }
    },
  };
}

/** The names SCIM may know the user by (access.ts). */
export const namesOf = (claims: Record<string, unknown>): string[] =>
  ["preferred_username", "email", "upn"].map((k) => claims[k]).filter((v): v is string => typeof v === "string");

export const identityOf = (auth: AuthInfo): Identity => ({
  sub: String(auth.extra?.sub ?? auth.clientId),
  names: (auth.extra?.names as string[]) ?? [],
});

export function userOf(auth: AuthInfo | undefined): User {
  if (!auth) return { id: "local", teams: [], local: true };
  const name = auth.extra?.name;
  return { id: String(auth.extra?.sub ?? auth.clientId), ...(typeof name === "string" ? { name } : {}), teams: (auth.extra?.teams as string[]) ?? [] };
}

/** The authorization server's metadata (OIDC discovery), fetched once. */
export function discovery(cfg: AuthConfig): () => Promise<OAuthMetadata> {
  let cached: Promise<OAuthMetadata> | undefined = cfg.metadata && Promise.resolve(cfg.metadata);
  return () =>
    (cached ??= fetch(`${cfg.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`).then((r) => {
      if (!r.ok) throw new Error(`OIDC discovery failed: ${r.status}`);
      return r.json() as Promise<OAuthMetadata>;
    }));
}

export function gate(cfg: AuthConfig, metadata: () => Promise<OAuthMetadata>) {
  return requireBearerAuth({
    verifier: verifier(cfg, metadata),
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(cfg.resource),
  });
}
