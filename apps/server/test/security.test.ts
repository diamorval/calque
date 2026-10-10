import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { teamsOf } from "../src/auth.ts";
import { checkEndpoint, isMetadata } from "../src/egress.ts";
import { createHttp } from "../src/http.ts";
import { InvalidModel } from "../src/models.ts";
import { sessions } from "../src/session.ts";
import type { App } from "../src/tools.ts";
import { fakeModel, fakeOidc } from "./fakes.ts";
import { LOCAL, testApp } from "./helpers.ts";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("model egress policy (SSRF)", () => {
  let app: App;
  let model: Awaited<ReturnType<typeof fakeModel>>;
  beforeAll(async () => {
    model = await fakeModel(() => ({ content: "OK" }));
    app = await testApp();
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    model.server.close();
    await app.db.close();
  });

  it("refuses link-local and metadata addresses, literal or resolved", async () => {
    for (const ip of ["169.254.169.254", "169.254.0.1", "fd00:ec2::254", "fe80::1", "::ffff:169.254.169.254", "100.100.100.200"]) {
      expect(isMetadata(ip), ip).toBe(true);
    }
    for (const ip of ["127.0.0.1", "10.0.0.5", "192.168.1.10", "::1", "203.0.113.7"]) expect(isMetadata(ip), ip).toBe(false);
    await expect(checkEndpoint("http://169.254.169.254/latest/meta-data", [])).rejects.toThrow(/metadata/);
    await expect(checkEndpoint("http://[fd00:ec2::254]/", [])).rejects.toThrow(/metadata/);
    await expect(checkEndpoint("http://metadata.internal/v1", [], async () => ["169.254.169.254"])).rejects.toThrow(/metadata/);
    await expect(checkEndpoint("file:///etc/passwd", [])).rejects.toThrow(/http or https/);
    await expect(checkEndpoint("http://gateway.corp/v1", [], async () => ["10.1.2.3"])).resolves.toBeUndefined();
    // named exactly: an admin who really means it
    await expect(checkEndpoint("http://169.254.10.10/v1", ["169.254.10.10"])).resolves.toBeUndefined();
  });

  it("applies CALQUE_MODEL_HOSTS: exact hosts and .suffixes", async () => {
    const allow = ["api.example.com", ".openai.azure.com"];
    await expect(checkEndpoint("https://api.example.com/v1", allow, async () => ["203.0.113.7"])).resolves.toBeUndefined();
    await expect(checkEndpoint("https://acme.openai.azure.com/", allow, async () => ["203.0.113.8"])).resolves.toBeUndefined();
    await expect(checkEndpoint("https://evil.example.org/v1", allow)).rejects.toThrow(/not allowed/);
    await expect(checkEndpoint("https://api.example.com.evil.org/v1", allow)).rejects.toThrow(/not allowed/);
    await expect(checkEndpoint("https://acme.openai.azure.com/", allow, async () => ["169.254.169.254"])).rejects.toThrow(/metadata/);
  });

  it("is enforced by the server when a model is saved, tested and used", async () => {
    const save = (base_url: string) => app.models.configure(LOCAL, { provider: "openai-compatible", model: "m", base_url, api_key: "good-key" });
    await expect(save("http://169.254.169.254/v1")).rejects.toThrow(InvalidModel);
    expect(model.requests).toHaveLength(0);
    await expect(save(model.url)).resolves.toMatchObject({ id: "openai-compatible:m" });

    vi.stubEnv("CALQUE_MODEL_HOSTS", "llm.example.com");
    await expect(save(model.url)).rejects.toThrow(/not allowed/);
    await expect(app.models.resolve("openai-compatible:m")).rejects.toThrow(InvalidModel); // saved before the policy
    // Ollama's default endpoint is checked too
    await expect(app.models.configure(LOCAL, { provider: "ollama", model: "x" })).rejects.toThrow(/localhost is not allowed/);
    vi.stubEnv("CALQUE_MODEL_HOSTS", "127.0.0.1");
    await expect(app.models.resolve("openai-compatible:m")).resolves.toMatchObject({ baseURL: model.url });
  });
});

describe("teams from the groups claim", () => {
  it("strips Keycloak's leading slash and keeps only the prefixed groups, plus the admin team", () => {
    expect(teamsOf(["/sales", "ops"])).toEqual(["sales", "ops"]);
    expect(teamsOf(["/calque-sales", "/all-staff", "/calque-admins", "Domain Users"], "calque-")).toEqual(["calque-sales", "calque-admins"]);
    expect(teamsOf(["/team-a", "/all-staff", "/calque-admins"], "team-")).toEqual(["team-a", "calque-admins"]);
    expect(teamsOf(undefined, "x")).toEqual([]);
  });
});

describe("web sessions: CSRF, revocation, SCIM deprovisioning", () => {
  let app: App;
  let http: ReturnType<typeof createHttp>;
  let idp: Awaited<ReturnType<typeof fakeOidc>>;
  const SCIM = "scim-secret";

  const req = (path: string, init: RequestInit & { cookie?: string; bearer?: string } = {}) => {
    const headers = new Headers(init.headers);
    if (init.cookie) headers.set("cookie", init.cookie);
    if (init.bearer) headers.set("authorization", `Bearer ${init.bearer}`);
    return http.request(path, { ...init, headers });
  };
  const post = (path: string, body: unknown, cookie: string, headers: Record<string, string> = { origin: "http://calque.test" }) =>
    req(path, { method: "POST", cookie, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const cookieOf = (res: Response, name: string) => res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`))?.split(";")[0] ?? "";

  /** The whole sign-in: login, the IdP's page, callback. Returns the session cookie, or the refusal. */
  async function signIn(user: string): Promise<string | Response> {
    const login = await req("/auth/login");
    const page = await (await fetch(new URL(login.headers.get("location") ?? ""))).text();
    const back = new URL((page.match(new RegExp(`href="([^"]+)">Sign in as ${user}`))?.[1] ?? "").replace(/&amp;/g, "&"));
    const callback = await req(back.pathname + back.search, { cookie: cookieOf(login, "calque_login") });
    return callback.status === 302 ? cookieOf(callback, "calque_session") : callback;
  }
  const session = async (user: string) => (await signIn(user)) as string;
  const me = async (cookie: string) => (await req("/api/me", { cookie })).status;
  const scim = (path: string, method = "GET", body?: unknown, token = SCIM) =>
    req(`/scim/v2${path}`, {
      method,
      bearer: token,
      headers: { "content-type": "application/scim+json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  beforeAll(async () => {
    idp = await fakeOidc();
    vi.stubEnv("CALQUE_SCIM_TOKEN", SCIM);
    app = await testApp();
    const auth = { issuer: idp.issuer, audience: "calque", resource: new URL("/mcp", app.publicUrl), teamsClaim: "groups" };
    http = createHttp(app, auth, sessions({ issuer: idp.issuer, clientId: "calque-web", publicUrl: app.publicUrl, teamsClaim: "groups", secret: app.secret, access: app.access }));
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    idp.server.close();
    await app.db.close();
  });

  it("refuses a cookie-authenticated write from a foreign or missing origin", async () => {
    const alice = await session("alice");
    expect((await post("/api/tools/list_packs", {}, alice)).status).toBe(200);
    expect((await post("/api/tools/list_packs", {}, alice, { referer: "http://calque.test/settings/models" })).status).toBe(200);
    const foreign = await post("/api/tools/list_packs", {}, alice, { origin: "https://evil.test" });
    expect(foreign.status).toBe(403);
    expect(((await foreign.json()) as Json).message).toMatch(/cross-site/);
    expect((await post("/api/tools/list_packs", {}, alice, { origin: "null" })).status).toBe(403);
    expect((await post("/api/tools/list_packs", {}, alice, { referer: "https://evil.test/calque.test" })).status).toBe(403);
    expect((await post("/api/tools/list_packs", {}, alice, {})).status).toBe(403); // neither Origin nor Referer
    expect((await req("/api/models/env", { method: "DELETE", cookie: alice, headers: { origin: "https://evil.test" } })).status).toBe(403);
    // reads, bearer clients and anonymous requests are not concerned
    expect(await me(alice)).toBe(200);
    expect((await req("/api/tools/list_packs", { method: "POST", bearer: await idp.token("bob"), body: "{}" })).status).toBe(200);
    expect((await req("/api/tools/list_packs", { method: "POST", body: "{}" })).status).toBe(401);
  });

  it("sign-out revokes that session only; an admin revokes all of a user's sessions", async () => {
    const [bob1, bob2, alice] = [await session("bob"), await session("bob"), await session("alice")];
    const out = await req("/auth/logout", { cookie: bob1 });
    expect(out.status).toBe(302);
    expect(await me(bob1)).toBe(401); // a copy of the cookie is dead too
    expect(await me(bob2)).toBe(200);

    expect((await post("/api/tools/revoke_sessions", { user: "alice" }, bob2)).status).toBe(403);
    const revoked = await post("/api/tools/revoke_sessions", { user: "bob" }, alice);
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toMatchObject({ user: "bob", sessions_revoked_at: expect.any(String) });
    expect(await me(bob2)).toBe(401);
    expect(await me(alice)).toBe(200);
    expect(await me(await session("bob"))).toBe(200); // signing in again works
  });

  it("SCIM: needs its token, provisions users, deactivation revokes sessions and blocks sign-in", async () => {
    expect((await scim("/Users", "GET", undefined, "wrong")).status).toBe(401);
    expect((await req("/scim/v2/Users")).status).toBe(401);

    const bobSession = await session("bob");
    const created = await scim("/Users", "POST", { schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"], userName: "bob", externalId: "e-42", displayName: "Bob Durand", active: true });
    expect(created.status).toBe(201);
    expect(created.headers.get("content-type")).toBe("application/scim+json");
    const bob = (await created.json()) as Json;
    expect(bob).toMatchObject({ userName: "bob", externalId: "e-42", active: true, meta: { resourceType: "User", location: `http://calque.test/scim/v2/Users/${bob.id}` } });
    expect((await scim("/Users", "POST", { userName: "BOB" })).status).toBe(409);

    const found = (await (await scim(`/Users?filter=${encodeURIComponent('userName eq "Bob"')}`)).json()) as Json;
    expect(found).toMatchObject({ totalResults: 1, Resources: [{ id: bob.id }] });
    expect(((await (await scim(`/Users?filter=${encodeURIComponent('userName eq "nobody"')}`)).json()) as Json).totalResults).toBe(0);
    expect((await scim(`/Users?filter=${encodeURIComponent('emails co "x"')}`)).status).toBe(400);
    expect(await me(bobSession)).toBe(200); // provisioning alone changes nothing

    // Entra ID's deactivation
    const off = await scim(`/Users/${bob.id}`, "PATCH", { schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"], Operations: [{ op: "Replace", path: "active", value: "False" }] });
    expect(((await off.json()) as Json).active).toBe(false);
    expect(await me(bobSession)).toBe(401);
    expect((await req("/api/me", { bearer: await idp.token("bob") })).status).toBe(401);
    expect((await req("/mcp", { method: "POST", bearer: await idp.token("bob"), body: "{}" })).status).toBe(401);
    expect(((await signIn("bob")) as Response).status).toBe(403);
    expect(await me(await session("alice"))).toBe(200);

    // reactivated (Okta's form: no path); old sessions stay revoked
    await scim(`/Users/${bob.id}`, "PATCH", { Operations: [{ op: "replace", value: { active: true } }] });
    expect(await me(bobSession)).toBe(401);
    const again = await session("bob");
    expect(await me(again)).toBe(200);

    expect((await scim(`/Users/${bob.id}`, "DELETE")).status).toBe(204);
    expect((await scim(`/Users/${bob.id}`)).status).toBe(404);
    expect(await me(again)).toBe(401);
    expect(((await signIn("bob")) as Response).status).toBe(403);
  });
});
