import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DesignSpec } from "@calque/deckspec";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REPO } from "../src/engine.ts";
import { createHttp } from "../src/http.ts";
import type { User } from "../src/packs.ts";
import { TOOLS, type App } from "../src/tools.ts";
import { ENGINE_TIMEOUT, LOCAL, testApp } from "./helpers.ts";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const campaign = (): DesignSpec => JSON.parse(readFileSync(join(REPO, "packages/deckspec/fixtures/design/valid/campaign.json"), "utf8"));
/** A tool call as MCP and REST make it: input parsed (defaults filled), then run. */
const run = (name: keyof typeof TOOLS, app: App, args: Json, user: User = LOCAL): Promise<Json> => {
  const t = TOOLS[name] as unknown as { input: { parse: (x: Json) => Json }; run: (a: App, u: User, x: Json) => Promise<Json> };
  return t.run(app, user, t.input.parse(args));
};

describe("designs", { timeout: ENGINE_TIMEOUT }, () => {
  let app: App;
  let id: string;
  beforeAll(async () => {
    app = await testApp();
  });
  afterAll(() => app.db.close());

  it("lists formats with the pack's roles and modes", async () => {
    const r = await run("list_formats", app, { pack_id: "acme-test" });
    expect(r.formats.map((f: Json) => f.id)).toContain("story");
    expect(r.modes).toEqual(["dark"]);
    expect(r.color_roles).toContain("accent");
    expect(r.ok).toBeUndefined();
  });

  it("creates a design, rendered and linted", async () => {
    const r = await run("create_design", app, { design: campaign() });
    id = r.design_id;
    expect(r.version).toBe(1);
    expect(r.artboards.map((a: Json) => [a.id, a.width, a.height])).toEqual([
      ["post", 1080, 1080],
      ["banner", 728, 90],
    ]);
    expect(r.artboards[0].image_url).toMatch(new RegExp(`^http://calque.test/designs/${id}/post.png\\?v=1&`));
    // the outline button's accent label on the dark banner
    expect(r.errors).toContainEqual(expect.objectContaining({ artboard: "banner", node: "cta1__cta-label", check: "contrast" }));
  });

  it("patches as new versions, restores, and keeps every version", async () => {
    const p = await run("patch_design", app, { design_id: id, ops: [{ op: "set_artboard", artboard: "banner", props: { mode: null } }], note: "light banner" });
    expect(p.version).toBe(2);
    expect(p.errors.filter((f: Json) => f.check === "contrast")).toEqual([]);
    const adapted = await run("patch_design", app, { design_id: id, ops: [{ op: "adapt_artboard", artboard: "post", id: "story", format: "story" }] });
    expect(adapted.artboards.map((a: Json) => a.id)).toEqual(["post", "story", "banner"]);
    const back = await run("restore_design", app, { design_id: id, version: 1 });
    expect(back.version).toBe(4);
    const open = await run("open_design", app, { design_id: id });
    expect(open.spec).toEqual(campaign());
    expect(open.versions.map((v: Json) => v.note)).toEqual(["create", "light banner", "patch", "restore v1"]);
    await expect(run("patch_design", app, { design_id: id, ops: [{ op: "delete_node", artboard: "post", node_id: "nope" }] })).rejects.toThrow(/nope/);
    expect((await run("open_design", app, { design_id: id })).head).toBe(4);
  });

  it("exports files behind the preview token, and code inline", async () => {
    const http = createHttp(app);
    const svg = await run("export_design", app, { design_id: id, format: "svg", artboard: "post" });
    expect(svg.files).toHaveLength(1);
    const res = await http.request(svg.files[0].url);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment/);
    expect(await res.text()).toContain("<text");
    const png = await http.request((await run("open_design", app, { design_id: id })).artboards[0].image_url);
    expect(png.headers.get("content-type")).toBe("image/png");
    const react = await run("export_design", app, { design_id: id, format: "react", artboard: "post" });
    expect(react.code).toContain("export default function");
    await expect(run("export_design", app, { design_id: id, format: "tailwind" })).rejects.toThrow(/pass artboard/);
    expect((await http.request(`/designs/${id}/post.exe`)).status).toBe(404);
  });

  it("is the owner's only, and their uploads only", async () => {
    const other = { id: "other", teams: [] };
    await expect(run("open_design", app, { design_id: id }, other)).rejects.toThrow(/no design/);
    expect((await run("list_designs", app, {}, other)).designs).toEqual([]);
    expect((await run("list_designs", app, {})).designs).toEqual([
      expect.objectContaining({ design_id: id, title: "Launch campaign", version: 4, cover: "post", artboards: 2 }),
    ]);
    const spec = campaign();
    spec.artboards[0]?.children.push({ type: "image", id: "pic", src: "file:someone-elses", alt: "", width: 10, height: 10 });
    await expect(run("create_design", app, { design: spec })).rejects.toThrow(/no file/);
  });
});
