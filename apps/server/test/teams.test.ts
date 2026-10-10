import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifier } from "../src/auth.ts";
import { EntraGroups, entraConfig } from "../src/entra.ts";
import { resolveTeams, teamsConfig, teamsOf } from "../src/teams.ts";
import { fakeGraph } from "./fakes.ts";

const SALES = "3f2a9c1e-0b7d-4c55-9a1e-2f6b8d0c4e11";
const ADMINS = "9d8e7f6a-5b4c-4d3e-8f2a-1b0c9d8e7f6a";
const OTHER = "00000000-1111-2222-3333-444444444444";

describe("teams from group claims", () => {
  it("strips Keycloak group paths, as before", () => {
    expect(teamsOf({ groups: ["/sales", "ops"] }, { claim: "groups" })).toEqual(["sales", "ops"]);
    expect(teamsOf({}, { claim: "groups" })).toEqual([]);
  });

  it("names Entra group ids through the map, and drops unmapped ones on request", () => {
    const map = { [SALES]: "sales", [ADMINS]: "calque-admins" };
    expect(teamsOf({ groups: [SALES, ADMINS, OTHER] }, { claim: "groups", map })).toEqual(["sales", "calque-admins", OTHER]);
    expect(teamsOf({ groups: [SALES, ADMINS, OTHER] }, { claim: "groups", map, mappedOnly: true })).toEqual(["sales", "calque-admins"]);
  });

  it("warns once per user about the Entra groups overage claim, with no Graph call", () => {
    const warnings: string[] = [];
    const claims = { sub: "carol", _claim_names: { groups: "src1" }, _claim_sources: { src1: { endpoint: "https://graph.microsoft.com/…" } } };
    expect(teamsOf(claims, { claim: "groups" }, (m) => warnings.push(m))).toEqual([]);
    teamsOf(claims, { claim: "groups" }, (m) => warnings.push(m));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/overage.*Groups assigned to the application/s);
    teamsOf({ sub: "dan", hasgroups: true }, { claim: "groups" }, (m) => warnings.push(m));
    expect(warnings).toHaveLength(2);
  });

  it("reads CALQUE_TEAMS_MAP inline or from a file", () => {
    expect(teamsConfig({ CALQUE_TEAMS_MAP: `{"${SALES}": "sales"}` })).toEqual({ claim: "groups", map: { [SALES]: "sales" }, mappedOnly: false });
    const file = join(mkdtempSync(join(tmpdir(), "calque-teams-")), "teams.json");
    writeFileSync(file, JSON.stringify({ [ADMINS]: "calque-admins" }));
    expect(teamsConfig({ CALQUE_TEAMS_MAP: `file:${file}`, CALQUE_TEAMS_MAP_ONLY: "1", CALQUE_TEAMS_CLAIM: "roles" })).toEqual({
      claim: "roles",
      map: { [ADMINS]: "calque-admins" },
      mappedOnly: true,
    });
    expect(teamsConfig({ CALQUE_TEAMS_MAP: file }).map).toEqual({ [ADMINS]: "calque-admins" });
    expect(() => teamsConfig({ CALQUE_TEAMS_MAP: '{"a": 1}' })).toThrow(/JSON object/);
    expect(() => teamsConfig({ CALQUE_TEAMS_MAP_ONLY: "1" })).toThrow(/needs CALQUE_TEAMS_MAP/);
  });

  it("maps the teams of an Entra access token on the MCP door", async () => {
    const issuer = "https://login.microsoftonline.com/tenant-id/v2.0";
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };
    const token = await new SignJWT({ groups: [SALES, OTHER] })
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(issuer)
      .setAudience("api://calque")
      .setSubject("entra-oid")
      .setExpirationTime("5m")
      .sign(privateKey);
    const v = verifier(
      {
        issuer,
        audience: "api://calque",
        resource: new URL("http://calque.test/mcp"),
        teamsClaim: "groups",
        teams: { map: { [SALES]: "sales" }, mappedOnly: true },
        keys: createLocalJWKSet({ keys: [jwk] }),
      },
      async () => ({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, response_types_supported: ["code"] }),
    );
    expect((await v.verifyAccessToken(token)).extra?.teams).toEqual(["sales"]);
  });
});

describe("Entra group overage: groups read from Microsoft Graph", () => {
  let graph: Awaited<ReturnType<typeof fakeGraph>>;
  const map = { [SALES]: "sales", [ADMINS]: "calque-admins" };
  const overage = (oid: string) => ({ sub: `pairwise-${oid}`, oid, _claim_names: { groups: "src1" }, _claim_sources: { src1: { endpoint: "https://graph.windows.net/…" } } });
  const groups = (cfg: Partial<Parameters<typeof entraConfig>[0]> = {}) =>
    new EntraGroups(entraConfig({ CALQUE_ENTRA_AUTHORITY: graph.authority, CALQUE_ENTRA_GRAPH: graph.graph, ...cfg }));
  const app = { CALQUE_ENTRA_TENANT: "contoso.test", CALQUE_ENTRA_CLIENT_ID: "calque-groups", CALQUE_ENTRA_CLIENT_SECRET: "app-secret" };
  beforeAll(async () => {
    graph = await fakeGraph();
    // past one page of Graph results, nested groups included
    graph.members.set("oid-carol", [OTHER, SALES, "aaaaaaaa-0000-0000-0000-000000000001", ADMINS]);
    graph.members.set("oid-dan", [SALES]);
  });
  afterAll(() => graph.server.close());

  it("with the sign-in's Graph token when it may read memberships (web sign-in)", async () => {
    const warnings: string[] = [];
    const cfg = { claim: "groups", map, mappedOnly: true, groups: groups() };
    const token = graph.delegated("oid-carol", "openid profile email User.Read GroupMember.Read.All");
    expect(await resolveTeams(overage("oid-carol"), cfg, token, (m) => warnings.push(m))).toEqual(["sales", "calque-admins"]);
    expect(graph.requests.filter((r) => r.path.startsWith("/v1.0/me/transitiveMemberOf"))).toHaveLength(2); // two pages
    expect(warnings).toEqual([]);
    // a token that may not read them, and no app credentials: no teams, and the warning
    const weak = graph.delegated("oid-dan", "openid profile email User.Read");
    expect(await resolveTeams(overage("oid-dan"), { ...cfg, groups: groups() }, weak, (m) => warnings.push(m))).toEqual([]);
    expect(warnings[0]).toMatch(/could not read them from Microsoft Graph.*CALQUE_ENTRA_CLIENT_ID/s);
  });

  it("app-only with client credentials (any door), one token, cached per user", async () => {
    const cfg = { claim: "groups", map, groups: groups(app) };
    const before = graph.requests.length;
    expect(await resolveTeams(overage("oid-carol"), cfg)).toEqual([OTHER, "sales", "aaaaaaaa-0000-0000-0000-000000000001", "calque-admins"]);
    expect(await resolveTeams(overage("oid-dan"), cfg)).toEqual(["sales"]);
    const calls = graph.requests.slice(before);
    expect(calls.map((r) => r.path.split("?")[0])).toEqual([
      "/v1.0/users/oid-carol/transitiveMemberOf/microsoft.graph.group",
      "/v1.0/users/oid-carol/transitiveMemberOf/microsoft.graph.group",
      "/v1.0/users/oid-dan/transitiveMemberOf/microsoft.graph.group",
    ]);
    expect(new Set(calls.map((r) => r.auth)).size).toBe(1); // one app token
    // kept 10 minutes: no new Graph call
    await resolveTeams(overage("oid-carol"), cfg);
    expect(graph.requests.length).toBe(before + 3);
    // a token with its groups needs no Graph call at all
    expect(await resolveTeams({ sub: "x", oid: "oid-x", groups: [SALES] }, cfg)).toEqual(["sales"]);
    expect(graph.requests.length).toBe(before + 3);
  });

  it("a Graph failure leaves the user without teams, not without sign-in", async () => {
    const warnings: string[] = [];
    expect(await resolveTeams(overage("oid-nobody"), { claim: "groups", groups: groups(app) }, undefined, (m) => warnings.push(m))).toEqual([]);
    expect(warnings[0]).toMatch(/reading their groups from Microsoft Graph failed: Microsoft Graph: Resource 'oid-nobody' does not exist/);
    const bad = await resolveTeams(overage("oid-carol"), { claim: "groups", groups: groups({ ...app, CALQUE_ENTRA_CLIENT_SECRET: "wrong" }) }, undefined, (m) => warnings.push(m));
    expect(bad).toEqual([]);
    expect(warnings.some((w) => /Invalid client secret/.test(w))).toBe(true);
  });

  it("resolves the overage on the MCP door, app-only (the bearer token is for Calque)", async () => {
    const issuer = "https://login.microsoftonline.com/tenant-id/v2.0";
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };
    const token = await new SignJWT({ oid: "oid-dan", _claim_names: { groups: "src1" } })
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(issuer)
      .setAudience("api://calque")
      .setSubject("pairwise-dan")
      .setExpirationTime("5m")
      .sign(privateKey);
    const v = verifier(
      {
        issuer,
        audience: "api://calque",
        resource: new URL("http://calque.test/mcp"),
        teamsClaim: "groups",
        teams: { map, mappedOnly: true, groups: groups(app) },
        keys: createLocalJWKSet({ keys: [jwk] }),
      },
      async () => ({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, response_types_supported: ["code"] }),
    );
    expect((await v.verifyAccessToken(token)).extra?.teams).toEqual(["sales"]);
  });
});
