import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REPO } from "../src/engine.ts";
import { getFile, saveFile, uploadPath } from "../src/files.ts";
import { createHttp } from "../src/http.ts";
import { libraryImages } from "../src/images.ts";
import type { User } from "../src/packs.ts";
import { purge } from "../src/retention.ts";
import { toolNamed, type App } from "../src/tools.ts";
import { ENGINE_TIMEOUT, testApp } from "./helpers.ts";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const run = (app: App, user: User, name: string, args: Json = {}) =>
  toolNamed(name)?.run(app, user, toolNamed(name)?.input.parse(args) as never) as Promise<Json>;

const admin: User = { id: "carol", teams: ["calque-admins"] };
const alice: User = { id: "alice", teams: ["sales"] };
const bob: User = { id: "bob", teams: ["ops"] };

// A client deck with a photo on its first slide, and two photos to place in it.
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
Image.new("RGB", (40, 20), "green").save(sys.argv[2] + ".green.png")
`;

describe("image library", { timeout: ENGINE_TIMEOUT }, () => {
  let app: App;
  let src = "";
  const upload = (user: User, name: string, path: string, type = "image/png") => saveFile(app.db, app.data, user, name, type, readFileSync(path));
  beforeAll(async () => {
    app = await testApp();
    src = join(app.data, "client.pptx");
    execFileSync("uv", ["run", "--quiet", "python", "-c", PICTURE, join(REPO, "packs/acme-test/template.pptx"), src], { cwd: join(REPO, "engine") });
  });
  afterAll(() => app.db.close());

  it("takes uploads proposed by anyone who sees the pack, approved by its managers, then lists them to everyone", async () => {
    const blue = await upload(alice, "office.png", `${src}.blue.png`);
    const i = await run(app, alice, "image_library_add", { pack_id: "acme-test", file_id: blue.file_id, title: "Paris office, lobby", tags: ["Photo", "office"] });
    expect(i).toMatchObject({ status: "pending", tags: ["photo", "office"], added_by: "alice", type: "image/png", ref: expect.stringMatching(/^file:/) });
    // a copy, owned by the library: not the upload
    expect(i.ref).not.toBe(`file:${blue.file_id}`);

    // only images, only the caller's own uploads
    const doc = await saveFile(app.db, app.data, alice, "notes.txt", "text/plain", Buffer.from("hi"));
    await expect(run(app, alice, "image_library_add", { pack_id: "acme-test", file_id: doc.file_id, title: "x" })).rejects.toThrow(/not an image/);
    await expect(run(app, bob, "image_library_add", { pack_id: "acme-test", file_id: blue.file_id, title: "x" })).rejects.toThrow(/no file/);
    await expect(run(app, { id: "guest", teams: [], anonymous: true }, "image_library_add", { pack_id: "acme-test", file_id: blue.file_id, title: "x" })).rejects.toThrow(/sign in/);

    // pending: its author and the managers see it; only a manager approves it
    expect((await run(app, bob, "image_library_list", { status: "all" })).images).toEqual([]);
    expect((await run(app, alice, "image_library_list", { status: "pending" })).images.map((x: Json) => x.image_id)).toEqual([i.image_id]);
    await expect(run(app, alice, "image_library_review", { image_id: i.image_id, action: "approve" })).rejects.toThrow(/only the owner of acme-test or an admin/);
    expect(await run(app, admin, "image_library_review", { image_id: i.image_id, action: "approve" })).toMatchObject({ status: "approved", approved_by: "carol" });

    // a manager's own addition is approved at once; search by words and tags
    const green = await upload(admin, "logo.png", `${src}.green.png`);
    await run(app, admin, "image_library_add", { pack_id: "acme-test", file_id: green.file_id, title: "Client logo, Acme", tags: ["client-logo"] });
    expect((await run(app, bob, "image_library_list")).images.map((x: Json) => x.title)).toEqual(["Client logo, Acme", "Paris office, lobby"]);
    expect((await run(app, bob, "image_library_list", { query: "office paris" })).images.map((x: Json) => x.title)).toEqual(["Paris office, lobby"]);
    expect((await run(app, bob, "image_library_list", { tags: ["client-logo"] })).images.map((x: Json) => x.title)).toEqual(["Client logo, Acme"]);
    await expect(run(app, bob, "image_library_list", { pack_id: "nope" })).rejects.toThrow(/no pack/);

    // retention keeps the library's files
    await purge(app, 1, new Date(Date.now() + 10 * 86_400_000));
    expect((await run(app, bob, "image_library_list")).images).toHaveLength(2);
  });

  it("serves an image to whoever may see it, sandboxed", async () => {
    const [i] = (await run(app, bob, "image_library_list", { query: "office" })).images;
    const http = createHttp(app);
    const res = await http.request(new URL(i.image_url).pathname);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect((await http.request("/api/library/images/00000000-0000-0000-0000-000000000000")).status).toBe(404);
  });

  it("places an approved image by its ref: the deck gets its own copy, which outlives the library's", async () => {
    const file = await saveFile(app.db, app.data, alice, "client.pptx", "application/octet-stream", readFileSync(src));
    const imp = await run(app, alice, "import_pptx", { file: { file_id: file.file_id }, pack_id: "acme-test", language: "en" });
    const first = (await app.decks.spec(imp.deck_id, 1)).slides[0] as Json;
    const pic = Math.max(...(await run(app, alice, "open_deck", { deck_id: imp.deck_id })).slides[0].shapes.map((s: Json) => s.shape_id));
    const [office] = (await run(app, alice, "image_library_list", { query: "office" })).images;

    const r = await run(app, alice, "patch_deck", { deck_id: imp.deck_id, ops: [{ op: "set", slide: first.id, shape_id: pic, value: { image: office.ref } }] });
    const ref = ((await app.decks.spec(imp.deck_id, r.version)).slides[0] as Json).source.values[String(pic)].image as string;
    expect(ref).not.toBe(office.ref);
    const own = await getFile(app.db, app.data, alice, ref.slice("file:".length));
    expect(own.name).toBe("office.png");

    // removed from the library: its file goes, the deck keeps building and changing
    await expect(run(app, alice, "image_library_review", { image_id: office.image_id, action: "remove" })).rejects.toThrow(/only the owner/);
    expect(await run(app, admin, "image_library_review", { image_id: office.image_id, action: "remove" })).toEqual({ image_id: office.image_id, removed: true });
    expect(existsSync(uploadPath(app.data, office.ref.slice("file:".length)))).toBe(false);
    expect((await run(app, alice, "image_library_list", { query: "office" })).images).toEqual([]);
    const again = await run(app, alice, "patch_deck", { deck_id: imp.deck_id, ops: [{ op: "set", slide: first.id, shape_id: 2, value: "Our office" }] });
    expect((await run(app, alice, "lint_deck", { deck_id: imp.deck_id })).version).toBe(again.version);
  });

  it("never places a pending image, nor one on a pack the writer does not see; the author withdraws a pending one", async () => {
    const blue = await upload(bob, "draft.png", `${src}.blue.png`);
    const p = await run(app, bob, "image_library_add", { pack_id: "acme-test", file_id: blue.file_id, title: "Draft photo" });
    const file = await saveFile(app.db, app.data, alice, "client.pptx", "application/octet-stream", readFileSync(src));
    const imp = await run(app, alice, "import_pptx", { file: { file_id: file.file_id }, pack_id: "acme-test", language: "en" });
    const first = (await app.decks.spec(imp.deck_id, 1)).slides[0] as Json;
    const pic = Math.max(...(await run(app, alice, "open_deck", { deck_id: imp.deck_id })).slides[0].shapes.map((s: Json) => s.shape_id));
    const place = (ref: string) => run(app, alice, "patch_deck", { deck_id: imp.deck_id, ops: [{ op: "set", slide: first.id, shape_id: pic, value: { image: ref } }] });
    await expect(place(p.ref)).rejects.toThrow(/no file/);

    const [logo] = (await run(app, alice, "image_library_list", { query: "logo" })).images;
    await app.db.query("update packs set visibility = 'team', teams = '[\"ops\"]' where id = 'acme-test'");
    try {
      await expect(run(app, alice, "image_library_list")).resolves.toEqual({ images: [] });
      expect(await libraryImages(app, alice, [logo.ref.slice("file:".length)])).toEqual([]);
      expect(await libraryImages(app, bob, [logo.ref.slice("file:".length), "not-a-uuid"])).toEqual([logo.ref.slice("file:".length)]);
    } finally {
      await app.db.query("update packs set visibility = 'workspace', teams = '[]' where id = 'acme-test'");
    }
    expect((await place(logo.ref)).version).toBe(2);

    expect(await run(app, bob, "image_library_review", { image_id: p.image_id, action: "remove" })).toEqual({ image_id: p.image_id, removed: true });
  });
});
