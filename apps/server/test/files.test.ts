import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REPO } from "../src/engine.ts";
import { MAX_UPLOAD } from "../src/files.ts";
import { createHttp } from "../src/http.ts";
import { NotFound, type User } from "../src/packs.ts";
import { TOOLS, type App } from "../src/tools.ts";
import { acmeDeck, ENGINE_TIMEOUT, testApp } from "./helpers.ts";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const ISSUER = "https://sso.test/realms/acme";
const TEMPLATE = readFileSync(join(REPO, "packs/acme-test/template.pptx"));
const alice: User = { id: "alice", teams: ["sales"] };
const bob: User = { id: "bob", teams: ["sales"] };

describe("uploads", { timeout: ENGINE_TIMEOUT }, () => {
  let app: App;
  let http: ReturnType<typeof createHttp>;
  let token: (sub: string) => Promise<string>;
  beforeAll(async () => {
    app = await testApp();
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };
    token = (sub) =>
      new SignJWT({ groups: ["/sales"] }).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(ISSUER).setAudience("calque")
        .setSubject(sub).setExpirationTime("5m").sign(privateKey);
    http = createHttp(app, {
      issuer: ISSUER,
      audience: "calque",
      resource: new URL("http://calque.test/mcp"),
      teamsClaim: "groups",
      keys: createLocalJWKSet({ keys: [jwk] }),
      metadata: { issuer: ISSUER, authorization_endpoint: `${ISSUER}/auth`, token_endpoint: `${ISSUER}/token`, response_types_supported: ["code"] },
    });
  });
  afterAll(() => app.db.close());

  const post = (path: string, bytes: Buffer, name: string, headers: Record<string, string> = {}) => {
    const form = new FormData();
    form.append("file", new File([new Uint8Array(bytes)], name, { type: "application/vnd.openxmlformats-officedocument.presentationml.presentation" }));
    return http.request(path, { method: "POST", body: form, headers });
  };

  it("uploads a file, then imports it by file_id; only its uploader can use it", async () => {
    expect((await post("/api/files", TEMPLATE, "deck.pptx")).status).toBe(401);
    const res = await post("/api/files", TEMPLATE, "deck.pptx", { authorization: `Bearer ${await token("alice")}` });
    expect(res.status).toBe(200);
    const f = (await res.json()) as Json;
    expect(f).toMatchObject({ name: "deck.pptx", size: TEMPLATE.length });

    const r = await TOOLS.import_pptx.run(app, alice, { file: { file_id: f.file_id }, pack_id: "acme-test", language: "en" });
    expect(r.deck_id).toBeTruthy();
    expect((r.slides as string[]).length).toBe(4);

    await expect(TOOLS.import_pptx.run(app, bob, { file: { file_id: f.file_id }, pack_id: "acme-test", language: "en" })).rejects.toThrow(NotFound);
    await expect(TOOLS.import_pack.run(app, bob, TOOLS.import_pack.input.parse({ template: { file_id: f.file_id } }) as never)).rejects.toThrow(NotFound);
  });

  it("refuses another user's file as a DeckSpec image", async () => {
    const res = await post("/api/files", TEMPLATE, "logo.png", { authorization: `Bearer ${await token("alice")}` });
    const { file_id } = (await res.json()) as Json;
    const deck = acmeDeck();
    const cover = deck.slides[0] as Json;
    cover.source.values["2"] = { image: `file:${file_id}` };
    await expect(TOOLS.create_deck.run(app, bob, { deck })).rejects.toThrow(/no file/);
  });

  it("uploads with a ticket from upload_url, as the user who asked for it", async () => {
    const { upload_url } = (await TOOLS.upload_url.run(app, bob, {})) as { upload_url: string };
    const url = new URL(upload_url);
    expect(url.origin).toBe("http://calque.test");
    const f = (await (await post(url.pathname + url.search, TEMPLATE, "t.pptx")).json()) as Json;
    const draft = await TOOLS.import_pack.run(app, bob, TOOLS.import_pack.input.parse({ template: { file_id: f.file_id } }) as never);
    expect(draft.status).toBe("draft");
    expect((await post("/api/files?ticket=forged", TEMPLATE, "t.pptx")).status).toBe(401);
  });

  it("refuses a file over the size cap", async () => {
    const res = await post("/api/files", Buffer.alloc(MAX_UPLOAD + 2 * 1024 * 1024), "big.pptx", { authorization: `Bearer ${await token("alice")}` });
    expect(res.status).toBe(413);
  });
});
