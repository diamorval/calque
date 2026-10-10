import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { REPO } from "../src/engine.ts";
import { saveFile } from "../src/files.ts";
import { createHttp } from "../src/http.ts";
import { archivePack, listPacks, seedPacks, setDefaultPack, type User } from "../src/packs.ts";
import { TOOLS, type App } from "../src/tools.ts";
import { fakeOidc } from "./fakes.ts";
import { acmeDeck, ENGINE_TIMEOUT, testApp } from "./helpers.ts";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const alice: User = { id: "alice", teams: ["sales"] };
const bob: User = { id: "bob", teams: ["ops"] };
const carol: User = { id: "carol", teams: ["ops"] };
const root: User = { id: "root", teams: ["calque-admins"] };

describe("deck management: rename, duplicate, search", { timeout: ENGINE_TIMEOUT }, () => {
  let app: App;
  let http: ReturnType<typeof createHttp>;
  let idp: Awaited<ReturnType<typeof fakeOidc>>;
  let id = "";
  const call = (user: User, name: keyof typeof TOOLS, args: Json = {}): Promise<Json> => {
    const t = TOOLS[name];
    return t.run(app, user, t.input.parse(args) as never);
  };
  const titles = async (user: User, args: Json = {}) => (await call(user, "list_decks", args)).decks.map((d: Json) => d.title);

  beforeAll(async () => {
    app = await testApp();
    idp = await fakeOidc();
    http = createHttp(app, { issuer: idp.issuer, audience: "calque", resource: new URL("/mcp", app.publicUrl), teamsClaim: "groups" });
    id = (await call(alice, "create_deck", { deck: acmeDeck() })).deck_id;
  });
  afterAll(async () => {
    idp.server.close();
    await app.db.close();
  });

  it("renames a deck without a new version; the DeckSpec title stays the default", async () => {
    expect(await titles(alice)).toEqual(["Quarterly review"]);
    expect(await call(alice, "rename_deck", { deck_id: id, title: "  Copil Société Générale  " })).toEqual({ deck_id: id, title: "Copil Société Générale" });
    expect((await call(alice, "list_decks")).decks).toMatchObject([{ id, title: "Copil Société Générale", head: 1 }]);
    expect((await call(alice, "open_deck", { deck_id: id, render: false })).title).toBe("Copil Société Générale");
    // a later version keeps the name
    await call(alice, "patch_deck", { deck_id: id, ops: [{ op: "set", slide: "cover", shape_id: 2, value: "Growth where we invested" }] });
    expect(await titles(alice)).toEqual(["Copil Société Générale"]);
    expect(await call(alice, "rename_deck", { deck_id: id, title: "" })).toEqual({ deck_id: id, title: "Quarterly review" });
    await call(alice, "rename_deck", { deck_id: id, title: "Copil Société Générale" });
  });

  it("serves the app's branding before sign-in, the rest of the API not", async () => {
    expect((await http.request("/api/branding")).status).toBe(200);
    expect((await http.request("/api/decks")).status).toBe(401);
  });

  it("renames only with editor access", async () => {
    await expect(call(bob, "rename_deck", { deck_id: id, title: "Mine" })).rejects.toThrow(/no deck/);
    await call(alice, "share_deck", { deck_id: id, principal_type: "user", principal: "bob", role: "viewer" });
    await expect(call(bob, "rename_deck", { deck_id: id, title: "Mine" })).rejects.toThrow(/editor access needed/);
    await call(alice, "share_deck", { deck_id: id, principal_type: "user", principal: "bob", role: "editor" });
    expect((await call(bob, "rename_deck", { deck_id: id, title: "Copil SG" })).title).toBe("Copil SG");
    await call(alice, "share_deck", { deck_id: id, principal_type: "user", principal: "bob", role: "viewer" });
  });

  it("finds decks by words in their name or slides, accents and case ignored, and by pack", async () => {
    const other = acmeDeck();
    other.title = "Kickoff";
    (other.slides[0] as Json).source.values["3"] = "Projet Crédit Agricole";
    await call(alice, "create_deck", { deck: other });
    expect(await titles(alice)).toEqual(["Kickoff", "Copil SG"]);
    expect(await titles(alice, { query: "copil" })).toEqual(["Copil SG"]);
    expect(await titles(alice, { query: "credit AGRICOLE" })).toEqual(["Kickoff"]); // cover text
    expect(await titles(alice, { query: "north" })).toEqual(["Kickoff", "Copil SG"]); // chart categories
    expect(await titles(alice, { query: "credit copil" })).toEqual([]);
    expect(await titles(alice, { pack_id: "acme-test" })).toHaveLength(2);
    expect(await titles(alice, { pack_id: "diametral" })).toEqual([]);
    // shared decks are searched too; REST takes ?q= and ?pack_id=
    expect(await titles(bob, { query: "copil" })).toEqual(["Copil SG"]);
    const res = await http.request("/api/decks?q=agricole&pack_id=acme-test", { headers: { authorization: `Bearer ${await idp.token("alice")}` } });
    expect(((await res.json()) as Json).decks.map((d: Json) => d.title)).toEqual(["Kickoff"]);
  });

  it("duplicates a deck the caller sees into a new deck they own, history starting fresh", async () => {
    await call(alice, "add_comment", { deck_id: id, slide_id: "cover", text: "check the date" });
    await expect(call(carol, "duplicate_deck", { deck_id: id })).rejects.toThrow(/no deck/);
    const r = await call(bob, "duplicate_deck", { deck_id: id });
    expect(r).toMatchObject({ version: 1, title: "Copil SG (copy)", duplicated_from: id });
    expect(r.preview_url).toContain(`/decks/${r.deck_id}?`);
    const copy = await call(bob, "open_deck", { deck_id: r.deck_id, render: false });
    const orig = await call(alice, "open_deck", { deck_id: id, render: false });
    expect(copy).toMatchObject({ title: "Copil SG (copy)", role: "owner", head: 1, open_comments: [] });
    expect(copy.versions).toHaveLength(1);
    expect(copy.spec).toEqual(orig.spec);
    expect((await call(bob, "list_shares", { deck_id: r.deck_id })).people).toEqual([]);
    // the original is untouched, and the copy is not alice's
    expect(orig).toMatchObject({ head: 2, title: "Copil SG" });
    await expect(call(alice, "open_deck", { deck_id: r.deck_id, render: false })).rejects.toThrow(/no deck/);
    expect((await call(bob, "duplicate_deck", { deck_id: id, title: "Copil v2" })).title).toBe("Copil v2");
  });

  it("duplicates an imported deck with its file and the images it places, copied to the new owner", async () => {
    // an exported deck, a picture added in PowerPoint, imported back as a new deck
    const src = (await app.decks.exportPath(alice, id)).path;
    const pptx = join(app.data, "with-picture.pptx");
    const png = join(app.data, "logo.png");
    const shape = execFileSync(
      "uv",
      ["run", "--quiet", "python", "-c",
        "import sys; from PIL import Image; from pptx import Presentation; from pptx.util import Inches\n" +
        "Image.new('RGB', (40, 20), 'red').save(sys.argv[3]); p = Presentation(sys.argv[1])\n" +
        "pic = p.slides[0].shapes.add_picture(sys.argv[3], Inches(1), Inches(1), Inches(2), Inches(1)); p.save(sys.argv[2]); print(pic.shape_id)",
        src, pptx, png],
      { cwd: join(REPO, "engine") },
    ).toString().trim();
    const imported = (await call(alice, "import_pptx", { file: { base64: readFileSync(pptx).toString("base64") }, pack_id: "acme-test", language: "en" })).deck_id;
    const logo = await saveFile(app.db, app.data, alice, "logo.png", "image/png", readFileSync(png));
    const cover = (await call(alice, "open_deck", { deck_id: imported, render: false })).spec.slides[0].id;
    await call(alice, "patch_deck", { deck_id: imported, ops: [{ op: "set", slide: cover, shape_id: Number(shape), value: { image: `file:${logo.file_id}` } }] });
    await call(alice, "share_deck", { deck_id: imported, principal_type: "user", principal: "bob", role: "viewer" });

    const r = await call(bob, "duplicate_deck", { deck_id: imported });
    const spec = (await call(bob, "open_deck", { deck_id: r.deck_id, render: false })).spec;
    const image: string = spec.slides[0].source.values[shape].image;
    expect(image).toMatch(/^file:/);
    expect(image).not.toBe(`file:${logo.file_id}`);
    const { rows } = await app.db.query<{ owner: string }>("select owner from files where id = $1", [image.slice(5)]);
    expect(rows[0]?.owner).toBe("bob");
    // the copy edits on its own: its base file and images are bob's
    await call(bob, "patch_deck", { deck_id: r.deck_id, ops: [{ op: "set_field", slide: cover, field: "notes", value: "mine now" }] });
    expect((await call(bob, "lint_deck", { deck_id: r.deck_id })).version).toBe(2);
  });
});

describe("workspace packs: test packs, the default pack, branding", { timeout: ENGINE_TIMEOUT }, () => {
  let app: App;
  beforeAll(async () => {
    app = await testApp();
  });
  afterAll(() => app.db.close());

  it("seeds test packs only with CALQUE_TEST_PACKS=1, and archives one seeded before", async () => {
    const prod = await createApp({ data: app.data, db: "memory://", publicUrl: "http://calque.test" });
    try {
      const fresh = (await prod.db.query<{ id: string }>("select id from packs")).rows.map((r) => r.id);
      expect(fresh).toContain("acme-test"); // the tests' env (vitest.config.ts) seeds it
      await seedPacks(prod.db, join(REPO, "packs"), { tests: false, defaultPack: undefined });
      expect((await listPacks(prod.db, alice)).map((p) => p.id)).toEqual(["diametral"]);
    } finally {
      await prod.db.close();
    }
  });

  it("the default pack: from CALQUE_DEFAULT_PACK unless an admin chose one, admins only", async () => {
    expect((await listPacks(app.db, alice)).filter((p) => p.default)).toEqual([]);
    await seedPacks(app.db, join(REPO, "packs"), { tests: true, defaultPack: "diametral" });
    expect((await listPacks(app.db, alice)).find((p) => p.default)?.id).toBe("diametral");
    await expect(setDefaultPack(app.db, alice, "acme-test")).rejects.toThrow(/calque-admins/);
    expect(await setDefaultPack(app.db, root, "acme-test")).toEqual({ id: "acme-test", default: true });
    await seedPacks(app.db, join(REPO, "packs"), { tests: true, defaultPack: "diametral" }); // a restart keeps the admin's choice
    expect((await listPacks(app.db, alice)).filter((p) => p.default).map((p) => p.id)).toEqual(["acme-test"]);
    await setDefaultPack(app.db, root, "diametral", false); // not the default: nothing changes
    expect((await listPacks(app.db, alice)).filter((p) => p.default).map((p) => p.id)).toEqual(["acme-test"]);
    await archivePack(app.db, root, "acme-test", true);
    expect((await listPacks(app.db, root, { manage: true })).filter((p) => p.default)).toEqual([]);
    await expect(setDefaultPack(app.db, root, "acme-test")).rejects.toThrow(/not archived/);
    await archivePack(app.db, root, "acme-test", false);

    const http = createHttp(app);
    const res = await http.request("/api/packs/diametral/default", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(await res.json()).toEqual({ id: "diametral", default: true });
    expect(((await (await http.request("/api/tools/list_packs", { method: "POST", body: "{}" })).json()) as Json).packs.find((p: Json) => p.default).id).toBe("diametral");
  });

  it("serves a neutral app name, white-labelled by CALQUE_APP_NAME and CALQUE_APP_LOGO", async () => {
    expect(await (await createHttp(app).request("/api/branding")).json()).toEqual({ name: "Calque", logo: null });
    process.env.CALQUE_APP_NAME = "Acme Slides";
    process.env.CALQUE_APP_LOGO = "https://acme.example/logo.svg";
    try {
      expect(await (await createHttp(app).request("/api/branding")).json()).toEqual({ name: "Acme Slides", logo: "https://acme.example/logo.svg" });
    } finally {
      delete process.env.CALQUE_APP_NAME;
      delete process.env.CALQUE_APP_LOGO;
    }
  });
});
