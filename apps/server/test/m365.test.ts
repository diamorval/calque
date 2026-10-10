import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REPO } from "../src/engine.ts";
import { getFile } from "../src/files.ts";
import { createHttp } from "../src/http.ts";
import { M365, M365NotConnected, type M365Config } from "../src/m365.ts";
import type { User } from "../src/packs.ts";
import type { Sessions } from "../src/session.ts";
import { toolNamed, type App } from "../src/tools.ts";
import { fakeGraph } from "./fakes.ts";
import { acmeDeck, ENGINE_TIMEOUT, LOCAL, testApp } from "./helpers.ts";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const run = (app: App, name: string, args: Json = {}, user: User = LOCAL) =>
  toolNamed(name)?.run(app, user, toolNamed(name)?.input.parse(args) as never) as Promise<Json>;

describe("Microsoft 365: OneDrive and SharePoint in and out", { timeout: ENGINE_TIMEOUT }, () => {
  let app: App;
  let graph: Awaited<ReturnType<typeof fakeGraph>>;
  let cfg: M365Config;
  let http: ReturnType<typeof createHttp>;
  beforeAll(async () => {
    app = await testApp();
    graph = await fakeGraph();
    cfg = { clientId: "calque-m365", tenant: "contoso.test", authority: graph.authority, graph: graph.graph };
    app.m365 = new M365(app.db, app.secret, app.publicUrl, cfg);
    http = createHttp(app); // no sign-in: the local user
  });
  afterAll(async () => {
    graph.server.close();
    await app.db.close();
  });

  /** Follow a connect link through Entra and back to Calque's callback; returns where Calque sends the browser. */
  async function connect(path: string) {
    const start = await http.request(path);
    expect(start.status).toBe(302);
    const authorize = new URL(start.headers.get("location") as string);
    expect(authorize.href.startsWith(`${graph.authority}/contoso.test/oauth2/v2.0/authorize`)).toBe(true);
    expect(authorize.searchParams.get("scope")).toContain("offline_access");
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    const cookie = (start.headers.get("set-cookie") as string).split(";")[0] as string;
    const consent = await fetch(authorize, { redirect: "manual" });
    const callback = new URL(consent.headers.get("location") as string);
    expect(callback.origin + callback.pathname).toBe("http://calque.test/auth/m365/callback");
    // without the login cookie (another browser) the answer is refused
    expect((await http.request(callback.pathname + callback.search)).status).toBe(400);
    return http.request(callback.pathname + callback.search, { headers: { cookie } });
  }

  it("asks to connect first, in a browser signed in to Calque", async () => {
    expect(await (await http.request("/api/m365")).json()).toEqual({ configured: true, connected: false, account: null });
    const err = await run(app, "m365_list").catch((e) => e);
    expect(err).toBeInstanceOf(M365NotConnected);
    expect(err.message).toMatch(/open http:\/\/calque\.test\/auth\/m365\/connect in a browser signed in to Calque/);

    const back = await connect(new URL(err.connect_url).pathname);
    expect(back.status).toBe(302);
    expect(back.headers.get("location")).toBe("/");
    expect(await (await http.request("/api/m365")).json()).toEqual({ configured: true, connected: true, account: "alice@contoso.test" });
    // the refresh token is kept sealed
    const { rows } = await app.db.query<{ refresh_token: string }>("select refresh_token from m365_tokens where user_id = 'local'");
    expect(rows[0]?.refresh_token).not.toMatch(/^rt-/);
  });

  it("goes back to the page that asked, never off the site", async () => {
    expect((await connect("/auth/m365/connect?return=/d/abc")).headers.get("location")).toBe("/d/abc");
    expect((await connect("/auth/m365/connect?return=//evil.test")).headers.get("location")).toBe("/");
  });

  it("sends a browser that is not signed in to Calque to sign in first", async () => {
    const issuer = "https://sso.test/realms/acme";
    const jwk = { ...(await exportJWK((await generateKeyPair("RS256")).publicKey)), kid: "k1", alg: "RS256" };
    const auth = {
      issuer,
      audience: "calque",
      resource: new URL("http://calque.test/mcp"),
      teamsClaim: "groups",
      keys: createLocalJWKSet({ keys: [jwk] }),
      metadata: { issuer, authorization_endpoint: `${issuer}/auth`, token_endpoint: `${issuer}/token`, response_types_supported: ["code"] },
    };
    const signedOut = { user: async () => undefined } as unknown as Sessions;
    const res = await createHttp(app, auth, signedOut).request("/auth/m365/connect?return=/d/1");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/auth/login?return=${encodeURIComponent("/auth/m365/connect?return=/d/1")}`);
  });

  it("browses OneDrive, searches it, finds SharePoint sites and their libraries", async () => {
    const root = await run(app, "m365_list");
    expect(root.items.map((i: Json) => [i.name, i.folder])).toEqual([["Decks", true], ["Brief T2.docx", false], ["setup.exe", false]]);
    expect((await run(app, "m365_list", { search: "brief" })).items.map((i: Json) => i.item_id)).toEqual(["brief"]);
    expect((await run(app, "m365_list", { sites: "sales" })).sites).toEqual([{ site_id: "site-sales", name: "Sales", web_url: "https://contoso.sharepoint.test/sites/sales" }]);
    expect((await run(app, "m365_list", { site_id: "site-sales" })).drives.map((d: Json) => d.drive_id)).toEqual(["sales-docs"]);
    expect((await run(app, "m365_list", { drive_id: "sales-docs" })).items.map((i: Json) => i.name)).toEqual(["Q3 figures.xlsx"]);
    expect(graph.requests.at(-1)?.auth).toMatch(/^Bearer at-/);
  });

  it("imports a file as a file_id that import_pptx, attachments and images take", async () => {
    const f = await run(app, "m365_import", { drive_id: "sales-docs", item_id: "q3" });
    expect(f).toMatchObject({ name: "Q3 figures.xlsx", source: { drive_id: "sales-docs", item_id: "q3" } });
    expect(readFileSync((await getFile(app.db, app.data, LOCAL, f.file_id)).path, "utf8")).toBe("PK fake xlsx");
    await expect(run(app, "m365_import", { item_id: "tool" })).rejects.toThrow(/Calque takes PowerPoint/);
    await expect(run(app, "m365_import", { item_id: "decks" })).rejects.toThrow(/is a folder/);
    await expect(run(app, "m365_import", { item_id: "nope" })).rejects.toThrow(/could not be found/);

    graph.items.set("tpl", { id: "tpl", name: "Client deck.pptx", drive: "me", parent: "me-root", bytes: readFileSync(join(REPO, "packs/acme-test/template.pptx")) });
    const pptx = await run(app, "m365_import", { item_id: "tpl" });
    const imp = await run(app, "import_pptx", { file: { file_id: pptx.file_id }, pack_id: "acme-test", language: "en" });
    expect(imp.slides).toHaveLength(4);
  });

  it("saves a deck to a folder as PPTX or PDF, never overwriting, and returns its web URL", async () => {
    const deck = (await run(app, "create_deck", { deck: acmeDeck() })).deck_id;
    const r = await run(app, "m365_save", { deck_id: deck, folder_id: "decks" });
    expect(r).toMatchObject({ version: 1, name: `${acmeDeck().title} v1.pptx`, drive_id: "me", lint_errors: 0 });
    expect(r.web_url).toMatch(/^https:\/\/contoso\.sharepoint\.test\//);
    const exported = readFileSync((await run(app, "export_pptx", { deck_id: deck })).path);
    expect(graph.items.get(r.item_id)?.bytes?.equals(exported)).toBe(true);
    expect((await run(app, "m365_save", { deck_id: deck, folder_id: "decks" })).name).toBe(`${acmeDeck().title} v1 1.pptx`);

    const pdf = await run(app, "m365_save", { deck_id: deck, format: "pdf", drive_id: "sales-docs", name: "Board: final?.pdf" });
    expect(pdf).toMatchObject({ name: "Board final.pdf", drive_id: "sales-docs" });
    expect(graph.items.get(pdf.item_id)?.bytes?.subarray(0, 4).toString()).toBe("%PDF");
    const { rows } = await app.db.query<Json>("select detail from audit where action = 'save_m365' and target_id = $1", [deck]);
    expect(rows.map((x) => x.detail.format)).toEqual(["pptx", "pptx", "pdf"]);
  });

  it("refreshes the access token from the stored refresh token, and asks to reconnect once it is revoked", async () => {
    const fresh = new M365(app.db, app.secret, app.publicUrl, cfg); // a restart: no access token cached
    app.m365 = fresh;
    expect((await run(app, "m365_list")).items).toHaveLength(4);
    graph.revoke();
    app.m365 = new M365(app.db, app.secret, app.publicUrl, cfg);
    await expect(run(app, "m365_list")).rejects.toThrow(M365NotConnected);
    expect(await (await http.request("/api/m365")).json()).toMatchObject({ connected: false });
  });

  it("disconnects, and says when the server has no Microsoft 365 set up", async () => {
    await connect("/auth/m365/connect");
    expect(await (await http.request("/api/m365", { method: "DELETE" })).json()).toMatchObject({ connected: false });
    await expect(run(app, "m365_list")).rejects.toThrow(M365NotConnected);
    app.m365 = undefined;
    expect(await (await http.request("/api/m365")).json()).toEqual({ configured: false, connected: false, account: null });
    await expect(run(app, "m365_list")).rejects.toThrow(/not set up on this server/);
    expect((await http.request("/auth/m365/connect")).status).toBe(404);
  });
});
