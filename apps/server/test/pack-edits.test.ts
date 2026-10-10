import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REPO } from "../src/engine.ts";
import { createHttp } from "../src/http.ts";
import {
  draftDir,
  editPack,
  exemplarImage,
  getPack,
  listPacks,
  previewDraft,
  publishDraft,
  replaceLogo,
  setManagers,
  setVisibility,
  type User,
} from "../src/packs.ts";
import { toolNamed, type App } from "../src/tools.ts";
import { acmeDeck, ENGINE_TIMEOUT, testApp } from "./helpers.ts";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const run = (app: App, user: User, name: string, args: Json = {}) =>
  toolNamed(name)?.run(app, user, toolNamed(name)?.input.parse(args) as never) as Promise<Json>;

const ACME = join(REPO, "packs/acme-test");
const admin: User = { id: "carol", teams: ["calque-admins"] };
const alice: User = { id: "alice", teams: ["sales"] };
const bob: User = { id: "bob", teams: ["ops"] };
// "Sales grew where we invested" is on the acme deck's cover
const GREW = { severity: "ERROR", lang: "any", pattern: "\\bgrew\\b", note: "say how much it grew" };
const grew = (findings: Json[]) => findings.filter((f) => f.message.includes("say how much it grew")).length;

describe("pack edits: docs, slop rules, logo, preview; decks pinned to a release; managers", { timeout: ENGINE_TIMEOUT }, () => {
  let app: App;
  const publish = (user: User, draft: Json, extra: Json = {}) =>
    publishDraft(app.db, user, app.data, draft.draft_id, { manifest: draft.manifest, voice: draft.voice, visibility: "workspace", ...extra });

  beforeAll(async () => {
    app = await testApp();
  });
  afterAll(() => app.db.close());

  it("edits the exemplar, storyline and slop rules as a release, refusing a rule that does not compile", async () => {
    const draft = await editPack(app.db, admin, app.data, "acme-test");
    expect(draft).toMatchObject({ exemplar: "", storyline: "", exemplar_images: [], logo: null });

    const bad = { ...draft, manifest: { ...draft.manifest, lint: { ...(draft.manifest.lint as object), slop_rules: [{ ...GREW, pattern: "(grew" }] } } };
    await expect(publish(admin, bad)).rejects.toThrow(/slop_rules\[0\] pattern '\(grew'/);
    expect((await getPack(app.db, admin, "acme-test")).version).toBe(1);

    expect(await exemplarImage(admin, app.data, draft.draft_id, "page-1.png", Buffer.from("png"))).toEqual({ exemplar_images: ["page-1.png"] });
    await exemplarImage(admin, app.data, draft.draft_id, "page-2.png", Buffer.from("png"));
    expect(await exemplarImage(admin, app.data, draft.draft_id, "page-1.png", null)).toEqual({ exemplar_images: ["page-2.png"] });
    await expect(exemplarImage(admin, app.data, draft.draft_id, "../evil.png", Buffer.from("x"))).rejects.toThrow(/image file/);
    await expect(exemplarImage(bob, app.data, draft.draft_id, "x.png", Buffer.from("x"))).rejects.toThrow(/no draft/);

    const good = { ...draft, manifest: { ...draft.manifest, lint: { ...(draft.manifest.lint as object), slop_rules: [GREW] } } };
    const r = await publish(admin, good, { exemplar: "# Good decks\n", storyline: "# Arc\n", note: "rules and docs" });
    expect(r).toMatchObject({ status: "published", version: 2 });
    const dir = (await getPack(app.db, admin, "acme-test")).dir;
    const m = parse(readFileSync(join(dir, "pack.yaml"), "utf8"));
    expect(m.docs).toEqual({ exemplar: "exemplar.md", storyline: "storyline.md" });
    expect(m.lint.slop_rules).toEqual([GREW]);
    expect(readFileSync(join(dir, "storyline.md"), "utf8")).toBe("# Arc\n");
    expect(existsSync(join(dir, "exemplar", "page-2.png"))).toBe(true);
    expect(existsSync(join(dir, "preview"))).toBe(false);

    // an empty doc is removed (a subsidiary would inherit its group's again)
    const again = await editPack(app.db, admin, app.data, "acme-test");
    expect(again).toMatchObject({ exemplar: "# Good decks\n", storyline: "# Arc\n", exemplar_images: ["page-2.png"] });
    await publish(admin, again, { storyline: "" });
    const v3 = (await getPack(app.db, admin, "acme-test")).dir;
    expect(parse(readFileSync(join(v3, "pack.yaml"), "utf8")).docs).toEqual({ exemplar: "exemplar.md" });
    expect(existsSync(join(v3, "storyline.md"))).toBe(false);
  });

  it("replaces a logo asset, when the pack has one", async () => {
    const draft = await editPack(app.db, admin, app.data, "acme-test");
    await expect(replaceLogo(admin, app.data, draft.draft_id, "logo.png", Buffer.from("png"))).rejects.toThrow(/no logo asset/);
    writeFileSync(join(await draftDir(admin, app.data, draft.draft_id), "logo.png"), "old");
    await expect(replaceLogo(admin, app.data, draft.draft_id, "logo.gif", Buffer.from("gif"))).rejects.toThrow(/\.png, \.svg or \.jpg/);
    expect(await replaceLogo(admin, app.data, draft.draft_id, "new-mark.svg", Buffer.from("<svg/>"))).toEqual({ logo: "logo.svg" });
    const dir = await draftDir(admin, app.data, draft.draft_id);
    expect([existsSync(join(dir, "logo.png")), readFileSync(join(dir, "logo.svg"), "utf8")]).toEqual([false, "<svg/>"]);
  });

  it("previews a pending edit on a sample deck before publishing", async () => {
    const draft = await editPack(app.db, admin, app.data, "acme-test");
    const p = await previewDraft(admin, app.data, draft.draft_id, draft.manifest);
    expect(p.slides.map((s) => s.number)).toEqual([1, 2, 3]);
    const http = createHttp(app);
    const res = await http.request(p.slides[0]?.image_url ?? "");
    expect([res.status, res.headers.get("content-type")]).toEqual([200, "image/png"]);
    expect((await http.request(`/api/packs/drafts/${draft.draft_id}/preview/9.png`)).status).toBe(404);
    await expect(previewDraft(bob, app.data, draft.draft_id)).rejects.toThrow(/no draft/);
  });

  it("builds and lints a deck on its pack release until it is updated to the latest", async () => {
    const before = (await getPack(app.db, admin, "acme-test")).version;
    const deck = await run(app, alice, "create_deck", { deck: acmeDeck() });
    const id = deck.deck_id as string;
    expect(grew((await run(app, alice, "lint_deck", { deck_id: id })).findings)).toBe(1);

    // the pack drops the rule: the deck stays on its release, edits included
    const draft = await editPack(app.db, admin, app.data, "acme-test");
    const lint = { ...(draft.manifest.lint as object), slop_rules: [] };
    expect(await publish(admin, { ...draft, manifest: { ...draft.manifest, lint } })).toMatchObject({ version: before + 1 });
    expect(grew((await run(app, alice, "lint_deck", { deck_id: id })).findings)).toBe(1);
    await run(app, alice, "patch_deck", { deck_id: id, ops: [{ op: "set", slide: "cover", shape_id: 3, value: "Q4 2026 review" }] });
    expect(grew((await run(app, alice, "lint_deck", { deck_id: id })).findings)).toBe(1);
    expect(await run(app, alice, "open_deck", { deck_id: id, render: false })).toMatchObject({ head: 2, pack_version: before, pack_latest: before + 1 });

    // an explicit update: a new version on the latest release, the older ones keep theirs
    await expect(run(app, bob, "update_pack_release", { deck_id: id })).rejects.toThrow(/no deck/);
    const up = await run(app, alice, "update_pack_release", { deck_id: id });
    expect(up).toMatchObject({ version: 3, pack_version: before + 1, previous_pack_version: before });
    expect(up.rebrand).toBeUndefined(); // same template: the slides rebuild as they are
    expect(grew((await run(app, alice, "lint_deck", { deck_id: id })).findings)).toBe(0);
    expect(grew((await run(app, alice, "lint_deck", { deck_id: id, version: 2 })).findings)).toBe(1);
    expect((await app.decks.versions(id)).map((v) => [v.version, v.pack_version])).toEqual([
      [1, before],
      [2, before],
      [3, before + 1],
    ]);
    await expect(run(app, alice, "update_pack_release", { deck_id: id })).rejects.toThrow(/already on the latest release/);

    // restoring a version goes back to the release it was on
    await run(app, alice, "restore_version", { deck_id: id, version: 1 });
    expect(await run(app, alice, "open_deck", { deck_id: id, render: false })).toMatchObject({ head: 4, pack_version: before });
    expect(grew((await run(app, alice, "lint_deck", { deck_id: id })).findings)).toBe(1);
  });

  it("lets only admins publish to the whole workspace, and an owner add co-managers", async () => {
    const manifest = { ...parse(readFileSync(join(ACME, "pack.yaml"), "utf8")), id: "client-y" };
    const args = {
      template: { base64: readFileSync(join(ACME, "template.pptx")).toString("base64") },
      manifest,
      tokens: JSON.parse(readFileSync(join(ACME, "tokens.json"), "utf8")),
      template_map: parse(readFileSync(join(ACME, "template-map.yaml"), "utf8")),
    };
    await expect(run(app, alice, "import_pack", { ...args, visibility: "workspace" })).rejects.toThrow(/only calque-admins publish a pack to the whole workspace/);
    expect(await run(app, alice, "import_pack", args)).toMatchObject({ status: "published", id: "client-y", teams: ["sales"] });
    await expect(setVisibility(app.db, alice, "client-y", "workspace", [])).rejects.toThrow(/whole workspace/);

    // a co-manager edits it like its owner; only the owner or an admin changes the managers
    await expect(editPack(app.db, bob, app.data, "client-y")).rejects.toThrow(/no pack/);
    expect(await setManagers(app.db, alice, "client-y", [" bob ", "bob", "alice"])).toEqual({ id: "client-y", managers: ["bob"] });
    expect((await listPacks(app.db, bob)).find((p) => p.id === "client-y")).toMatchObject({ owner: "alice", managers: ["bob"], editable: true });
    expect((await editPack(app.db, bob, app.data, "client-y")).manifest.id).toBe("client-y");
    expect(await setVisibility(app.db, bob, "client-y", "team", ["sales", "ops"])).toMatchObject({ teams: ["sales", "ops"] });
    await expect(setManagers(app.db, bob, "client-y", [])).rejects.toThrow(/only the owner of client-y or calque-admins change its managers/);
    expect(await setVisibility(app.db, admin, "client-y", "workspace", [])).toMatchObject({ visibility: "workspace" });

    const http = createHttp(app);
    const res = await http.request("/api/packs/client-y/managers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ managers: [] }) });
    expect(await res.json()).toEqual({ id: "client-y", managers: [] });
  });
});
