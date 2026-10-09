import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REPO } from "../src/engine.ts";
import { fontFamily, type User } from "../src/packs.ts";
import { toolNamed, type App } from "../src/tools.ts";
import { acmeDeck, ENGINE_TIMEOUT, fakeFont, testApp } from "./helpers.ts";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const run = (app: App, user: User, name: string, args: Json = {}) =>
  toolNamed(name)?.run(app, user, toolNamed(name)?.input.parse(args) as never) as Promise<Json>;

const ACME = join(REPO, "packs/acme-test");
const alice: User = { id: "alice", teams: ["sales"] };
const bob: User = { id: "bob", teams: ["ops"] };
const template = { base64: readFileSync(join(ACME, "template.pptx")).toString("base64") };

describe("import_pack and pack visibility", { timeout: ENGINE_TIMEOUT }, () => {
  let app: App;
  beforeAll(async () => {
    app = await testApp();
  });
  afterAll(() => app.db.close());

  it("drafts the template map and tokens when no manifest is given", async () => {
    const r = await run(app, alice, "import_pack", { template });
    expect(r.status).toBe("draft");
    expect(r.template_map.slides).toHaveLength(4);
    expect(r.tokens.theme).toBeDefined();
    expect(r.review.fonts["role.font.body"]).toBeTruthy();
  });

  it("reads a .potx, and reviews the company's own tokens.json", async () => {
    // acme-test's template saved with the template content type, as PowerPoint saves a .potx
    const potx = { base64: readFileSync(join(import.meta.dirname, "fixtures/acme-test.potx")).toString("base64") };
    const tokens = JSON.parse(readFileSync(join(ACME, "tokens.json"), "utf8"));
    const r = await run(app, alice, "import_pack", { template: potx, tokens });
    expect(r.status).toBe("draft");
    expect(r.template_map.slides).toHaveLength(4);
    expect(r.tokens).toEqual(tokens);
    expect(Object.keys(r.review.colors)).toContain("role.color.accent");
  });

  it("reads a font file's family name", () => {
    expect(fontFamily(fakeFont("Brand Sans"))).toBe("Brand Sans");
    expect(fontFamily(Buffer.from("not a font"))).toBeNull();
  });

  it("refuses a pack whose roles point at missing slides", async () => {
    const manifest = { ...parse(readFileSync(join(ACME, "pack.yaml"), "utf8")), id: "broken" };
    manifest.roles.closing = [9];
    await expect(run(app, alice, "import_pack", { template, manifest })).rejects.toThrow(/9/);
    expect((await run(app, alice, "list_packs")).packs.map((p: Json) => p.id)).not.toContain("broken");
  });

  it("publishes a valid pack to the importer's teams only", async () => {
    const manifest = { ...parse(readFileSync(join(ACME, "pack.yaml"), "utf8")), id: "acme-sales" };
    const r = await run(app, alice, "import_pack", {
      template,
      manifest,
      tokens: JSON.parse(readFileSync(join(ACME, "tokens.json"), "utf8")),
      template_map: parse(readFileSync(join(ACME, "template-map.yaml"), "utf8")),
    });
    expect(r).toMatchObject({ status: "published", id: "acme-sales", visibility: "team", teams: ["sales"] });

    expect((await run(app, alice, "list_packs")).packs.map((p: Json) => p.id)).toContain("acme-sales");
    expect((await run(app, bob, "list_packs")).packs.map((p: Json) => p.id)).toEqual(["acme-test", "diametral"]);

    const deck = { ...acmeDeck(), pack_id: "acme-sales" };
    const made = await run(app, alice, "create_deck", { deck });
    await expect(run(app, bob, "create_deck", { deck })).rejects.toThrow(/no pack "acme-sales"/);
    await expect(run(app, bob, "open_deck", { deck_id: made.deck_id })).rejects.toThrow(/no deck/); // not his deck
    await expect(run(app, alice, "import_pack", { template: { path: join(ACME, "template.pptx") } })).rejects.toThrow(/base64/);
  });
});
