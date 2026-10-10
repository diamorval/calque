import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REPO } from "../src/engine.ts";
import { getFile, saveFile } from "../src/files.ts";
import { createHttp } from "../src/http.ts";
import { libraryUser } from "../src/library.ts";
import type { User } from "../src/packs.ts";
import { purge } from "../src/retention.ts";
import { toolNamed, type App } from "../src/tools.ts";
import { acmeDeck, ENGINE_TIMEOUT, testApp } from "./helpers.ts";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const run = (app: App, user: User, name: string, args: Json = {}) =>
  toolNamed(name)?.run(app, user, toolNamed(name)?.input.parse(args) as never) as Promise<Json>;

const admin: User = { id: "carol", teams: ["calque-admins"] };
const alice: User = { id: "alice", teams: ["sales"] };
const bob: User = { id: "bob", teams: ["ops"] };

// A client deck with a photo on its first slide, and the photo to replace it with.
const PICTURE = `
import sys
from PIL import Image
from pptx import Presentation
from pptx.util import Inches
Image.new("RGB", (40, 20), "red").save(sys.argv[2] + ".png")
prs = Presentation(sys.argv[1])
prs.slides[0].shapes.add_picture(sys.argv[2] + ".png", Inches(1), Inches(1), Inches(2), Inches(1))
prs.save(sys.argv[2])
Image.new("RGB", (40, 20), "blue").save(sys.argv[2] + ".blue.png")
`;

describe("slide library", { timeout: ENGINE_TIMEOUT }, () => {
  let app: App;
  let aliceDeck: string;
  let bobDeck: string;
  beforeAll(async () => {
    app = await testApp();
    aliceDeck = (await run(app, alice, "create_deck", { deck: acmeDeck() })).deck_id;
    bobDeck = (await run(app, bob, "create_deck", { deck: acmeDeck() })).deck_id;
  });
  afterAll(() => app.db.close());

  it("takes proposals from editors, approved by the pack's managers, then lists them to everyone", async () => {
    const e = await run(app, alice, "library_add", { deck_id: aliceDeck, slide_id: "regions", title: "Regional growth, Acme 2025", tags: ["Case-study", "retail"] });
    expect(e).toMatchObject({ status: "pending", tags: ["case-study", "retail"], source: { deck_id: aliceDeck, slide_id: "regions" } });
    // a viewer of the deck cannot propose its slides
    await expect(run(app, bob, "library_add", { deck_id: aliceDeck, slide_id: "regions", title: "x" })).rejects.toThrow(/no deck/);

    // pending: its author and the managers see it, nobody else; only a manager approves it
    expect((await run(app, bob, "library_list", { status: "all" })).entries).toEqual([]);
    expect((await run(app, alice, "library_list", { status: "pending" })).entries.map((x: Json) => x.entry_id)).toEqual([e.entry_id]);
    expect((await run(app, admin, "library_list", { pack_id: "acme-test", status: "pending" })).entries).toHaveLength(1);
    await expect(run(app, alice, "library_review", { entry_id: e.entry_id, action: "approve" })).rejects.toThrow(/only the owner of acme-test or an admin/);
    await expect(run(app, bob, "library_insert", { entry_id: e.entry_id, deck_id: bobDeck })).rejects.toThrow(/no library entry/);
    expect(await run(app, admin, "library_review", { entry_id: e.entry_id, action: "approve" })).toMatchObject({ status: "approved", approved_by: "carol" });

    // a manager's own addition is approved at once; search by words and tags
    await run(app, admin, "library_add", { deck_id: (await run(app, admin, "create_deck", { deck: acmeDeck() })).deck_id, slide_id: "plan", title: "Our delivery plan", tags: ["boilerplate"] });
    expect((await run(app, bob, "library_list", {})).entries.map((x: Json) => x.title)).toEqual(["Our delivery plan", "Regional growth, Acme 2025"]);
    expect((await run(app, bob, "library_list", { query: "growth acme" })).entries.map((x: Json) => x.title)).toEqual(["Regional growth, Acme 2025"]);
    expect((await run(app, bob, "library_list", { tags: ["boilerplate"] })).entries.map((x: Json) => x.title)).toEqual(["Our delivery plan"]);

    // the entry is a copy: the source deck changing or going away does not touch it
    await run(app, alice, "delete_deck", { deck_id: aliceDeck });
    const r = await run(app, bob, "library_insert", { entry_id: e.entry_id, deck_id: bobDeck, at: 1 });
    expect(r.copied).toEqual({ regions: "regions-copy" });
    const spec = await app.decks.spec(bobDeck, r.version);
    expect(spec.slides[1]).toMatchObject({ id: "regions-copy", source: { kind: "chart" } });

    // library decks are nobody's decks, and retention keeps them
    expect((await run(app, bob, "list_decks")).decks.map((d: Json) => d.id)).toEqual([bobDeck]);
    await purge(app, 1, new Date(Date.now() + 10 * 86_400_000));
    expect((await run(app, bob, "library_list", {})).entries).toHaveLength(2);
  });

  it("serves an entry's image to whoever may see the entry", async () => {
    const [e] = (await run(app, bob, "library_list", { query: "plan" })).entries;
    const http = createHttp(app);
    const res = await http.request(new URL(e.thumbnail_url).pathname);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect((await http.request("/api/library/00000000-0000-0000-0000-000000000000/slide.png")).status).toBe(404);
  });

  it("copies an imported slide with its picture: grafted, and the image becomes the inserter's own", async () => {
    const src = join(app.data, "client.pptx");
    execFileSync("uv", ["run", "--quiet", "python", "-c", PICTURE, join(REPO, "packs/acme-test/template.pptx"), src], { cwd: join(REPO, "engine") });
    const file = await saveFile(app.db, app.data, alice, "client.pptx", "application/octet-stream", readFileSync(src));
    const photo = await saveFile(app.db, app.data, alice, "blue.png", "image/png", readFileSync(`${src}.blue.png`));
    const imp = await run(app, alice, "import_pptx", { file: { file_id: file.file_id }, pack_id: "acme-test", language: "en" });
    const first = (await app.decks.spec(imp.deck_id, 1)).slides[0] as Json;
    const pic = Math.max(...(await run(app, alice, "open_deck", { deck_id: imp.deck_id })).slides[0].shapes.map((s: Json) => s.shape_id));
    await run(app, alice, "patch_deck", { deck_id: imp.deck_id, ops: [{ op: "set", slide: first.id, shape_id: pic, value: { image: `file:${photo.file_id}` } }] });

    const e = await run(app, alice, "library_add", { deck_id: imp.deck_id, slide_id: first.id, title: "Client photo", tags: ["reference"] });
    await run(app, admin, "library_review", { entry_id: e.entry_id, action: "approve" });
    const target = (await run(app, bob, "import_pptx", { file: { file_id: (await saveFile(app.db, app.data, bob, "t.pptx", "application/octet-stream", readFileSync(join(REPO, "packs/acme-test/template.pptx")))).file_id }, pack_id: "acme-test", language: "en" })).deck_id;
    const r = await run(app, bob, "library_insert", { entry_id: e.entry_id, deck_id: target, at: 0 });
    const spec = await app.decks.spec(target, r.version);
    const placed = spec.slides[0] as Json;
    expect(placed.source).toMatchObject({ kind: "clone", from: "base" });
    const ref = placed.source.values[String(pic)].image as string;
    expect(ref).not.toBe(`file:${photo.file_id}`);
    expect((await getFile(app.db, app.data, bob, ref.slice("file:".length))).name).toBe("blue.png");
    expect((await run(app, bob, "lint_deck", { deck_id: target })).version).toBe(r.version);
  });

  it("lets the author withdraw a pending proposal and a manager remove an entry, with its deck", async () => {
    const deck = (await run(app, alice, "create_deck", { deck: acmeDeck() })).deck_id;
    const e = await run(app, alice, "library_add", { deck_id: deck, slide_id: "mix", title: "Mix" });
    const lib = libraryUser("acme-test");
    const { rows } = await app.db.query<{ deck_id: string }>("select deck_id from library where id = $1", [e.entry_id]);
    const libDeck = rows[0]?.deck_id as string;
    expect((await app.decks.deck(lib, libDeck, "viewer")).owner).toBe("library:acme-test");
    expect(await run(app, alice, "library_review", { entry_id: e.entry_id, action: "remove" })).toEqual({ entry_id: e.entry_id, removed: true });
    expect(existsSync(app.decks.dir(libDeck))).toBe(false);

    const [plan] = (await run(app, alice, "library_list", { query: "plan" })).entries;
    await expect(run(app, alice, "library_review", { entry_id: plan.entry_id, action: "remove" })).rejects.toThrow(/only the owner/);
    await run(app, admin, "library_review", { entry_id: plan.entry_id, action: "remove" });
    expect((await run(app, alice, "library_list", { query: "plan" })).entries).toEqual([]);
  });
});
