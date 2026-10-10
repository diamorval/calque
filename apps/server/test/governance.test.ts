import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REPO } from "../src/engine.ts";
import { createHttp } from "../src/http.ts";
import {
  archivePack,
  editPack,
  getPack,
  listPacks,
  packVersions,
  publishDraft,
  replaceTemplate,
  replaceTokens,
  restorePack,
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
const acmeTokens = readFileSync(join(ACME, "tokens.json"));

describe("pack governance: admins, releases, template swaps, archive", { timeout: ENGINE_TIMEOUT }, () => {
  let app: App;
  const publish = (user: User, draft: Json, extra: Json = {}) =>
    publishDraft(app.db, user, app.data, draft.draft_id, { manifest: draft.manifest, voice: draft.voice, visibility: "workspace", ...extra });

  beforeAll(async () => {
    app = await testApp();
  });
  afterAll(() => app.db.close());

  it("lets an admin edit and share a seeded pack (no owner); others get 403", async () => {
    expect((await listPacks(app.db, admin)).find((p) => p.id === "acme-test")).toMatchObject({ owner: null, editable: true, pack_version: 1 });
    expect((await listPacks(app.db, bob)).find((p) => p.id === "acme-test")).toMatchObject({ editable: false });
    await expect(editPack(app.db, bob, app.data, "acme-test")).rejects.toThrow(/only the owner of acme-test or calque-admins/);
    await expect(setVisibility(app.db, bob, "acme-test", "team", ["ops"])).rejects.toThrow(/calque-admins/);

    expect(await setVisibility(app.db, admin, "acme-test", "team", ["calque-admins"])).toMatchObject({ visibility: "team" });
    expect((await listPacks(app.db, bob)).map((p) => p.id)).not.toContain("acme-test");
    await setVisibility(app.db, admin, "acme-test", "workspace", []);
  });

  it("publishes every edit as a release with a note, records it on new decks, and rolls back", async () => {
    expect(await packVersions(app.db, admin, "acme-test")).toMatchObject({ current: 1, versions: [{ version: 1, note: "initial version", author: null }] });
    const seeded = (await getPack(app.db, admin, "acme-test")).dir;

    const draft = await editPack(app.db, admin, app.data, "acme-test");
    const r = await publish(admin, { ...draft, manifest: { ...draft.manifest, name: "Acme Renamed" } }, { note: "rename for the rebrand" });
    expect(r).toMatchObject({ status: "published", id: "acme-test", version: 2 });
    const v2 = await getPack(app.db, admin, "acme-test");
    expect(v2.version).toBe(2);
    expect(v2.dir).not.toBe(seeded);
    expect(existsSync(join(v2.dir, "DESIGN.md"))).toBe(true);
    expect(existsSync(join(seeded, "pack.yaml"))).toBe(true); // the previous release is kept

    const deck = await run(app, alice, "create_deck", { deck: acmeDeck() });
    expect((await app.decks.list(alice)).find((d) => d.id === deck.deck_id)).toMatchObject({ pack_version: 2 });

    await expect(restorePack(app.db, bob, "acme-test", 1)).rejects.toThrow(/calque-admins/);
    await expect(restorePack(app.db, admin, "acme-test", 9)).rejects.toThrow(/no version 9/);
    expect(await restorePack(app.db, admin, "acme-test", 1)).toEqual({ id: "acme-test", version: 3 });
    expect((await listPacks(app.db, alice)).find((p) => p.id === "acme-test")).toMatchObject({ name: "Acme Test", pack_version: 3 });
    expect((await getPack(app.db, admin, "acme-test")).dir).toBe(seeded);
    expect((await packVersions(app.db, admin, "acme-test")).versions.map((v) => [v.version, v.note, v.author])).toEqual([
      [3, "restore v1", "carol"],
      [2, "rename for the rebrand", "carol"],
      [1, "initial version", null],
    ]);
    // the deck made on release 2 still opens and keeps its record
    expect((await run(app, alice, "open_deck", { deck_id: deck.deck_id })).deck_id).toBe(deck.deck_id);
    expect((await app.decks.list(alice)).find((d) => d.id === deck.deck_id)).toMatchObject({ pack_version: 2 });
  });

  it("replaces the template and tokens of a pack in an edit, and validates them before publishing", async () => {
    const draft = await editPack(app.db, admin, app.data, "acme-test");
    await expect(replaceTokens(admin, app.data, draft.draft_id, Buffer.from("{nope"))).rejects.toThrow(/not valid JSON/);
    await expect(replaceTokens(bob, app.data, draft.draft_id, acmeTokens)).rejects.toThrow(/no draft/);

    // a broken token tree: the release is refused, the current one stays
    const broken = JSON.parse(acmeTokens.toString());
    broken.theme.accent1.$value = "#12345";
    await replaceTokens(admin, app.data, draft.draft_id, Buffer.from(JSON.stringify(broken)));
    await expect(publish(admin, draft)).rejects.toThrow();
    expect((await getPack(app.db, admin, "acme-test")).version).toBe(3);

    // the template is swapped (re-extracted roles and map), the tokens put back: lint passes, release 4
    const swapped = await replaceTemplate(admin, app.data, draft.draft_id, readFileSync(join(ACME, "template.pptx")));
    expect(swapped.manifest).toMatchObject({ id: "acme-test", name: "Acme Test", roles: { cover: [1], divider: [2], content: [3], closing: [4] } });
    expect(swapped.slides).toHaveLength(4);
    expect(await replaceTokens(admin, app.data, draft.draft_id, acmeTokens)).toEqual({ tokens: expect.arrayContaining(["role", "theme"]) });
    const r = await publish(admin, swapped, { note: "new template" });
    expect(r).toMatchObject({ status: "published", version: 4 });
    const dir = (await getPack(app.db, admin, "acme-test")).dir;
    expect(parse(readFileSync(join(dir, "pack.yaml"), "utf8")).grid).toBeDefined();
    expect(readFileSync(join(dir, "tokens.json"), "utf8")).toBe(JSON.stringify(JSON.parse(acmeTokens.toString()), null, 2) + "\n");
  });

  it("archives a client pack: hidden from pickers and new decks, its decks still open", async () => {
    const manifest = { ...parse(readFileSync(join(ACME, "pack.yaml"), "utf8")), id: "client-x" };
    const made = await run(app, alice, "import_pack", {
      template: { base64: readFileSync(join(ACME, "template.pptx")).toString("base64") },
      manifest,
      tokens: JSON.parse(acmeTokens.toString()),
      template_map: parse(readFileSync(join(ACME, "template-map.yaml"), "utf8")),
    });
    expect(made).toMatchObject({ status: "published", id: "client-x", version: 1 });
    const deck = await run(app, alice, "create_deck", { deck: { ...acmeDeck(), pack_id: "client-x" } });

    await expect(archivePack(app.db, bob, "client-x", true)).rejects.toThrow(/no pack/);
    expect(await archivePack(app.db, alice, "client-x", true)).toEqual({ id: "client-x", archived: true });
    expect((await run(app, alice, "list_packs")).packs.map((p: Json) => p.id)).not.toContain("client-x");
    await expect(run(app, alice, "create_deck", { deck: { ...acmeDeck(), pack_id: "client-x" } })).rejects.toThrow(/archived/);
    expect((await run(app, alice, "open_deck", { deck_id: deck.deck_id })).deck_id).toBe(deck.deck_id);
    expect((await app.decks.list(alice)).map((d) => d.id)).toContain(deck.deck_id);

    // the Brand packs page lists it, with its owner; an admin outside the team manages it too
    expect((await listPacks(app.db, alice, { manage: true })).find((p) => p.id === "client-x")).toMatchObject({ owner: "alice", archived: true, editable: true });
    expect((await listPacks(app.db, admin, { manage: true })).find((p) => p.id === "client-x")).toMatchObject({ archived: true, editable: true });
    expect((await listPacks(app.db, admin)).map((p) => p.id)).not.toContain("client-x");
    await archivePack(app.db, admin, "client-x", false);
    expect((await run(app, alice, "list_packs")).packs.map((p: Json) => p.id)).toContain("client-x");
  });

  it("serves the governance routes", async () => {
    const http = createHttp(app);
    const call = async (path: string, body?: unknown) => {
      const res = await http.request(path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      return { status: res.status, body: (await res.json()) as Json };
    };
    expect((await call("/api/packs")).body.packs.map((p: Json) => p.id)).toContain("client-x");
    expect((await call("/api/packs/client-x/archive", { archived: true })).body).toEqual({ id: "client-x", archived: true });
    expect((await call("/api/packs/acme-test/versions")).body).toMatchObject({ current: 4 });
    expect((await call("/api/packs/acme-test/restore", { version: 2 })).body).toEqual({ id: "acme-test", version: 5 });
    expect((await call("/api/packs/acme-test/restore", { version: 0 })).status).toBe(422);
  });
});
