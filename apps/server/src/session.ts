import { createHash } from "node:crypto";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { jwtVerify, SignJWT } from "jose";
import * as oidc from "openid-client";
import type { User } from "./packs.ts";
import { teamsOf, type TeamsConfig } from "./teams.ts";

/** Web app sign-in: OIDC authorization code + PKCE against the issuer (Keycloak), then a signed,
HttpOnly session cookie. The server keeps no session state and no IdP token: the web agent runs
in process, so the cookie's user is all it needs. */
export interface SessionConfig {
  issuer: string; // CALQUE_OIDC_ISSUER
  clientId: string; // CALQUE_OIDC_CLIENT_ID, default the audience
  clientSecret?: string | undefined; // CALQUE_OIDC_CLIENT_SECRET; unset = public client
  publicUrl: string;
  teamsClaim: string;
  teams?: Omit<TeamsConfig, "claim"> | undefined; // group id -> team name (Entra ID)
  secret: string; // CALQUE_SECRET
}

const SESSION = "calque_session";
const LOGIN = "calque_login";
const HOURS = 8;

export interface Sessions {
  login(c: Context): Promise<Response>;
  callback(c: Context): Promise<Response>;
  logout(c: Context): Response;
  user(c: Context): Promise<User | undefined>;
}

export function sessions(cfg: SessionConfig): Sessions {
  const key = createHash("sha256").update(`session:${cfg.secret}`).digest();
  const secure = cfg.publicUrl.startsWith("https:");
  const redirect = `${cfg.publicUrl}/auth/callback`;
  let config: Promise<oidc.Configuration> | undefined;
  const discover = () =>
    (config ??= oidc
      .discovery(
        new URL(cfg.issuer),
        cfg.clientId,
        undefined,
        cfg.clientSecret ? oidc.ClientSecretPost(cfg.clientSecret) : oidc.None(),
        // an http issuer only exists in local tests
        cfg.issuer.startsWith("http:") ? { execute: [oidc.allowInsecureRequests] } : undefined,
      )
      .catch((e) => {
        config = undefined;
        throw e;
      }));

  const seal = (claims: Record<string, unknown>, ttl: string) =>
    new SignJWT(claims).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime(ttl).sign(key);
  const unseal = async (token: string | undefined) => {
    if (!token) return undefined;
    try {
      return (await jwtVerify(token, key, { algorithms: ["HS256"] })).payload;
    } catch {
      return undefined;
    }
  };
  const cookie = { httpOnly: true, sameSite: "Lax", secure, path: "/" } as const;

  return {
    async login(c) {
      const verifier = oidc.randomPKCECodeVerifier();
      const state = oidc.randomState();
      const back = c.req.query("return") ?? "/";
      setCookie(c, LOGIN, await seal({ verifier, state, back: back.startsWith("/") ? back : "/" }, "10m"), { ...cookie, maxAge: 600 });
      const url = oidc.buildAuthorizationUrl(await discover(), {
        redirect_uri: redirect,
        scope: "openid profile email",
        code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
        code_challenge_method: "S256",
        state,
      });
      return c.redirect(url.href);
    },

    async callback(c) {
      const login = await unseal(getCookie(c, LOGIN));
      if (!login) return c.text("sign-in expired: start again from the app", 400);
      deleteCookie(c, LOGIN, cookie);
      const current = new URL(`/auth/callback${new URL(c.req.url).search}`, cfg.publicUrl);
      const tokens = await oidc.authorizationCodeGrant(await discover(), current, {
        pkceCodeVerifier: String(login.verifier),
        expectedState: String(login.state),
      });
      const claims = tokens.claims();
      if (!claims) throw new Error("the issuer returned no ID token");
      const user = {
        sub: claims.sub,
        name: String(claims.name ?? claims.preferred_username ?? claims.sub),
        teams: teamsOf(claims, { ...cfg.teams, claim: cfg.teamsClaim }),
      };
      setCookie(c, SESSION, await seal(user, `${HOURS}h`), { ...cookie, maxAge: HOURS * 3600 });
      return c.redirect(String(login.back));
    },

    logout(c) {
      deleteCookie(c, SESSION, cookie);
      return c.redirect("/");
    },

    async user(c) {
      const s = await unseal(getCookie(c, SESSION));
      if (!s?.sub) return undefined;
      return { id: s.sub, name: String(s.name), teams: (s.teams as string[]) ?? [] };
    },
  };
}
