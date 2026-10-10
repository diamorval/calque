import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compliance } from "../src/compliance.ts";
import { REPO } from "../src/engine.ts";
import { connect, createHttp } from "../src/http.ts";
import { editPack, importPack, listPacks, publishDraft, type User } from "../src/packs.ts";
import { packPortal } from "../src/portal.ts";
import { toolNamed, type App } from "../src/tools.ts";
import { acmeDeck, ENGINE_TIMEOUT, testApp } from "./helpers.ts";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const run = (app: App, user: User, name: string, args: Json = {}) =>
  toolNamed(name)?.run(app, user, toolNamed(name)?.input.parse(args) as never) as Promise<Json>;

const ACME = join(REPO, "packs/acme-test");
const admin: User = { id: "carol", teams: ["calque-admins"] };
const alice: User = { id: "alice", name: "Alice", teams: ["sales"] };
const dave: User = { id: "dave", teams: ["sales", "north"] };
const bob: User = { id: "bob", teams: ["ops"] };
const RULE = { severity: "ERROR", lang: "any", pattern: "zorglub", note: "group banned word" };

describe("brand portal, group packs and compliance", { timeout: ENGINE_TIMEOUT }, () => {
  let app: App;
  /** A pack on the acme-test template, by `user`, visible to the sales team. */
  const acmePack = (user: User, id: string, manifest: Json = {}, voice?: string) =>
    importPack(app.db, user, app.data, {
      template: join(ACME, "template.pptx"),
      manifest: { ...parse(readFileSync(join(ACME, "pack.yaml"), "utf8")), id, name: id, ...manifest },
      tokens: JSON.parse(readFileSync(join(ACME, "tokens.json"), "utf8")),
      template_map: parse(readFileSync(join(ACME, "template-map.yaml"), "utf8")),
      visibility: "team",
      teams: ["sales"],
      voice,
    });

  beforeAll(async () => {
    app = await testApp();
  });
  afterAll(() => app.db.close());

  it("shows a pack's charter, read-only, to anyone who sees it (M17)", async () => {
    const p = await packPortal(app.db, bob, "diametral");
    expect(p).toMatchObject({ id: "diametral", extends: [], inherited: [] });
    expect(p.design_md).toMatch(/^# /);
    expect(p.voice && p.storyline && p.exemplar).toBeTruthy();
    expect(p.colors.find((c) => c.path === "role.color.accent")).toMatchObject({ role: true, hex: expect.stringMatching(/^[0-9A-F]{6}$/) });
    expect(p.fonts.map((f) => f.role)).toEqual(expect.arrayContaining(["display", "body", "label"]));
    expect(p.slides.find((s) => s.number === 1)).toMatchObject({ roles: ["cover"], image_url: "/api/packs/diametral/slides/1.png" });
    expect(p.slides.find((s) => s.number === 59)).toMatchObject({ never_clone: true });
    expect(p.exemplar_images.map((i) => i.name)).toContain("exemplar-s1-s9.jpg");
    expect(p.icons.find((i) => i.name === "compass.png")).toEqual({ name: "compass.png", url: "/api/packs/diametral/icons/compass.png" });
    expect(p.rules.length).toBeGreaterThan(0);
    expect(await run(app, bob, "open_pack", { pack_id: "acme-test" })).toMatchObject({ id: "acme-test", icons: [], exemplar_images: [] });

    const http = createHttp(app);
    expect((await http.request("/api/packs/acme-test")).status).toBe(200);
    expect((await http.request("/api/packs/nope")).status).toBe(404);
    const slide = await http.request("/api/packs/acme-test/slides/1.png");
    expect(slide.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await slide.arrayBuffer()).subarray(1, 4).toString()).toBe("PNG");
    expect((await http.request("/api/packs/acme-test/slides/9.png")).status).toBe(404);
    const page = await http.request("/api/packs/diametral/exemplar/exemplar-s1-s9.jpg");
    expect([page.status, page.headers.get("content-type")]).toEqual([200, "image/jpeg"]);
    expect((await http.request("/api/packs/diametral/icons/..%2Fpack.yaml")).status).toBe(404);
  });

  it("lets a subsidiary pack inherit its group pack's voice and slop rules, its template its own (S12)", async () => {
    expect(await acmePack(alice, "group", { lint: { slop_rules: [RULE] } }, "Group voice: plain words.\n")).toMatchObject({ status: "published" });
    expect(await acmePack(alice, "group-sub", { extends: "group" })).toMatchObject({ status: "published" });
    // a pack extends only a pack its publisher sees
    await expect(acmePack(bob, "ops-sub", { extends: "group" })).rejects.toThrow(/no pack "group"/);
    expect((await listPacks(app.db, alice)).find((p) => p.id === "group-sub")).toMatchObject({ extends: "group" });

    // the agent's context: pack:// resources read through the inheritance
    const client = await connect(app, alice);
    const read = async (uri: string) => ((await client.readResource({ uri })).contents[0] as { text: string }).text;
    expect(await read("pack://group-sub/voice")).toBe("Group voice: plain words.\n");
    expect(await read("pack://group-sub/manifest")).toContain("group banned word");
    await client.close();

    // lint: the inherited rule applies to decks on the subsidiary
    const deck = acmeDeck();
    const cover = deck.slides[0]?.source as { values: Record<string, string> };
    cover.values["2"] = "Zorglub grew where we invested";
    const made = await run(app, alice, "create_deck", { deck: { ...deck, pack_id: "group-sub" } });
    const lint = await run(app, alice, "lint_deck", { deck_id: made.deck_id });
    expect(lint.findings.filter((f: Json) => f.severity === "ERROR").map((f: Json) => f.message)).toEqual([expect.stringContaining("group banned word")]);

    expect(await packPortal(app.db, alice, "group-sub")).toMatchObject({ extends: ["group"], inherited: ["voice", "slop_rules"], voice: "Group voice: plain words.\n" });
    // its own voice overrides the group's
    const draft = await editPack(app.db, alice, app.data, "group-sub");
    expect(draft.manifest.extends).toBe("group");
    const r = await publishDraft(app.db, alice, app.data, draft.draft_id, { manifest: draft.manifest, voice: "Subsidiary voice.\n", visibility: "team" });
    expect(r).toMatchObject({ status: "published", version: 2 });
    expect(await packPortal(app.db, alice, "group-sub")).toMatchObject({ inherited: ["slop_rules"], voice: "Subsidiary voice.\n" });
  });

  it("reports brand compliance per pack to its owner and admins only (M16)", async () => {
    await run(app, dave, "create_deck", { deck: { ...acmeDeck(), pack_id: "group-sub", title: "Clean one" } }); // not linted yet

    const [sub] = (await compliance(app.db, app.decks, alice, "group-sub")).packs;
    expect(sub).toMatchObject({ pack_id: "group-sub", summary: { decks: 2, linted: 2, clean: 1, errors: 1 }, approval: null });
    expect(sub?.by_owner).toEqual(
      expect.arrayContaining([
        { owner: "alice", name: "Alice", decks: 1, errors: 1, warns: expect.any(Number) },
        { owner: "dave", name: null, decks: 1, errors: 0, warns: expect.any(Number) },
      ]),
    );
    expect(sub?.by_team.map((t) => [t.team, t.decks])).toEqual(expect.arrayContaining([["sales", 2], ["north", 1]]));
    expect(sub?.trend[0]).toMatchObject({ versions: 2, decks: 2, errors: 1, week: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
    expect(sub?.decks.map((d) => d.title).sort()).toEqual(["Clean one", "Quarterly review"]);

    // not the pack's manager: no report, and a pack they do not see does not exist
    await expect(compliance(app.db, app.decks, dave, "group-sub")).rejects.toThrow(/only the owner of group-sub/);
    await expect(compliance(app.db, app.decks, bob, "group-sub")).rejects.toThrow(/no pack/);
    await expect(run(app, bob, "compliance_report")).rejects.toThrow(/only pack owners and admins/);
    expect((await compliance(app.db, app.decks, admin)).packs.map((p) => p.pack_id)).toEqual(expect.arrayContaining(["acme-test", "diametral", "group", "group-sub"]));

    const res = await createHttp(app).request("/api/compliance?pack_id=group-sub");
    expect(((await res.json()) as Json).packs[0].summary.decks).toBe(2);
  });
});
