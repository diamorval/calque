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
import type { User } from "./packs.ts";

/** OAuth resource server: tokens come from an external authorization server (Keycloak). */
export interface AuthConfig {
  issuer: string; // CALQUE_OIDC_ISSUER, e.g. https://sso.example.com/realms/acme
  audience: string; // CALQUE_OIDC_AUDIENCE: the client id / audience tokens are minted for
  resource: URL; // this server's MCP endpoint, <public url>/mcp
  teamsClaim: string; // CALQUE_TEAMS_CLAIM, default "groups"
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
        const teams = payload[cfg.teamsClaim];
        return {
          token,
          clientId: String(payload.azp ?? payload.client_id ?? payload.sub),
          scopes: typeof payload.scope === "string" ? payload.scope.split(" ") : [],
          expiresAt: payload.exp ?? 0, // no exp: the SDK refuses the token
          extra: {
            sub: payload.sub,
            // shown as the author of versions and comments (S18); the sub stays the id
            ...(typeof payload.name === "string" ? { name: payload.name } : {}),
            // Keycloak group paths look like "/team-a"
            teams: Array.isArray(teams) ? teams.map((t) => String(t).replace(/^\//, "")) : [],
          },
        };
      } catch (e) {
        throw new OAuthError(OAuthErrorCode.InvalidToken, (e as Error).message);
      }
    },
  };
}

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
