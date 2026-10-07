import { exportJWK, generateKeyPair, SignJWT, createLocalJWKSet } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHttp } from "../src/http.ts";
import type { App } from "../src/tools.ts";
import { testApp } from "./helpers.ts";

const ISSUER = "https://sso.test/realms/acme";

describe("OAuth resource server", () => {
  let app: App;
  let http: ReturnType<typeof createHttp>;
  let sign: (claims: Record<string, unknown>, aud?: string) => Promise<string>;
  beforeAll(async () => {
    app = await testApp();
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };
    sign = (claims, aud = "calque") =>
      new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(ISSUER).setAudience(aud)
        .setSubject(String(claims.sub ?? "alice")).setExpirationTime("5m").sign(privateKey);
    http = createHttp(app, {
      issuer: ISSUER,
      audience: "calque",
      resource: new URL("http://calque.test/mcp"),
      teamsClaim: "groups",
      keys: createLocalJWKSet({ keys: [jwk] }),
      metadata: {
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/protocol/openid-connect/auth`,
        token_endpoint: `${ISSUER}/protocol/openid-connect/token`,
        response_types_supported: ["code"],
      },
    });
  });
  afterAll(() => app.db.close());

  const listPacks = (token?: string) =>
    http.request("/api/tools/list_packs", { method: "POST", body: "{}", headers: token ? { authorization: `Bearer ${token}` } : {} });

  it("challenges an anonymous MCP client towards the protected resource metadata", async () => {
    const res = await http.request("/mcp", { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("resource_metadata=");
    const meta = await http.request("/.well-known/oauth-protected-resource/mcp");
    expect(await meta.json()).toMatchObject({ resource: "http://calque.test/mcp", authorization_servers: [ISSUER] });
  });

  it("accepts a token from the issuer for this audience, and maps groups to teams", async () => {
    const res = await listPacks(await sign({ sub: "alice", groups: ["/sales"] }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { packs: unknown[] }).packs).toHaveLength(2);
  });

  it("refuses other audiences and missing tokens", async () => {
    expect((await listPacks(await sign({}, "someone-else"))).status).toBe(401);
    expect((await listPacks()).status).toBe(401);
  });
});
