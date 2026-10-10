import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { verifier } from "../src/auth.ts";
import { teamsConfig, teamsOf } from "../src/teams.ts";

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
