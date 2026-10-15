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

describe("designs: documents of the deck store", { timeout: ENGINE_TIMEOUT }, () => {
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
    // a document like a deck: listed with its medium and cover, linted by lint_deck
    const listed = (await run("list_decks", app, { medium: "design" })).decks;
    expect(listed).toEqual([expect.objectContaining({ id, medium: "design", cover: "post", artboards: 2, role: "owner" })]);
    expect((await run("list_decks", app, { medium: "deck" })).decks).toEqual([]);
    const lint = await run("lint_deck", app, { deck_id: id });
    expect(lint.findings).toContainEqual(expect.objectContaining({ slide_id: "banner", node: "cta1__cta-label", check: "contrast" }));
    // the deck tools that read slides say so
    await expect(run("open_deck", app, { deck_id: id })).rejects.toThrow(/is a design, not a deck/);
  });

  it("patches as new versions, undoes with restore_version, and keeps every version", async () => {
    const p = await run("patch_design", app, { design_id: id, ops: [{ op: "set_artboard", artboard: "banner", props: { mode: null } }], note: "light banner" });
    expect(p.version).toBe(2);
    expect(p.errors.filter((f: Json) => f.check === "contrast")).toEqual([]);
    const adapted = await run("patch_design", app, { design_id: id, ops: [{ op: "adapt_artboard", artboard: "post", id: "story", format: "story" }] });
    expect(adapted.artboards.map((a: Json) => a.id)).toEqual(["post", "story", "banner"]);
    const back = await run("restore_version", app, { deck_id: id, version: 1 });
    expect(back.version).toBe(4);
    const open = await run("open_design", app, { design_id: id });
    expect(open.spec).toEqual(campaign());
    expect(open.versions.map((v: Json) => v.note)).toEqual(["create", "light banner", "patch", "restore v1"]);
    await expect(run("patch_design", app, { design_id: id, ops: [{ op: "delete_node", artboard: "post", node_id: "nope" }] })).rejects.toThrow(/nope/);
    expect((await run("open_design", app, { design_id: id })).head).toBe(4);
  });

  it("exports files behind the preview token, the whole design as one PDF, and code inline", async () => {
    const http = createHttp(app);
    const svg = await run("export_design", app, { design_id: id, format: "svg", artboard: "post" });
    expect(svg.files).toHaveLength(1);
    const res = await http.request(svg.files[0].url);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment/);
    expect(await res.text()).toContain("<text");
    const pdf = await run("export_design", app, { design_id: id, format: "pdf" });
    const whole = await http.request(pdf.pdf_url);
    expect(whole.headers.get("content-type")).toBe("application/pdf");
    expect(Buffer.from(await whole.arrayBuffer()).subarray(0, 4).toString()).toBe("%PDF");
    const viaDeckTool = await run("export_pdf", app, { deck_id: id });
    expect(viaDeckTool.version).toBe(4);
    const png = await http.request((await run("open_design", app, { design_id: id })).artboards[0].image_url);
    expect(png.headers.get("content-type")).toBe("image/png");
    const react = await run("export_design", app, { design_id: id, format: "react", artboard: "post" });
    expect(react.code).toContain("export default function");
    await expect(run("export_design", app, { design_id: id, format: "tailwind" })).rejects.toThrow(/pass artboard/);
    expect((await http.request(`/designs/${id}/post.exe`)).status).toBe(404);
    // a deck link to a design opens the design page
    const redirect = await http.request(`/decks/${id}?k=abc`);
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("location")).toBe(`/designs/${id}?k=abc`);
  });

  it("is shared like a deck: viewer reads, commenter comments on a node, editor patches and resolves", async () => {
    const bob = { id: "bob", teams: ["design"] };
    await expect(run("open_design", app, { design_id: id }, bob)).rejects.toThrow(/no deck/);
    await run("share_deck", app, { deck_id: id, principal_type: "team", principal: "design", role: "viewer" });
    expect((await run("open_design", app, { design_id: id }, bob)).role).toBe("viewer");
    expect((await run("list_decks", app, { medium: "design" }, bob)).decks).toEqual([expect.objectContaining({ id, role: "viewer", owner: "local" })]);
    await expect(run("add_comment", app, { deck_id: id, slide_id: "post", text: "x" }, bob)).rejects.toThrow(/commenter access needed/);

    await run("share_deck", app, { deck_id: id, principal_type: "user", principal: "bob", role: "commenter" });
    const { comment } = await run("add_comment", app, { deck_id: id, slide_id: "post", node: "headline", text: "Shorter headline" }, bob);
    expect(comment).toMatchObject({ slide_id: "post", node: "headline", status: "open", author: "bob" });
    const reply = await run("add_comment", app, { deck_id: id, parent_id: comment.id, text: "Max 5 words" });
    expect(reply.comment).toMatchObject({ slide_id: "post", node: "headline", parent_id: comment.id });
    await expect(run("add_comment", app, { deck_id: id, slide_id: "nope", text: "x" }, bob)).rejects.toThrow(/no artboard/);
    await expect(run("patch_design", app, { design_id: id, ops: [{ op: "set_field", field: "title", value: "x" }] }, bob)).rejects.toThrow(/editor access needed/);
    const open = await run("open_design", app, { design_id: id });
    expect(open.open_comments).toEqual([expect.objectContaining({ id: comment.id, replies: [expect.objectContaining({ text: "Max 5 words" })] })]);

    await run("share_deck", app, { deck_id: id, principal_type: "user", principal: "bob", role: "editor" });
    const p = await run("patch_design", app, { design_id: id, ops: [{ op: "set_node", artboard: "post", node_id: "headline", props: { text: "Decks on brand" } }], resolves: [comment.id] }, bob);
    expect(p.resolved).toEqual([comment.id]);
    expect((await run("list_comments", app, { deck_id: id })).comments).toEqual([]);

    // anyone with the link may comment: a guest presenting the key
    await run("set_general_access", app, { deck_id: id, access: "anyone", role: "commenter" });
    const key = (await app.db.query<{ link_key: string }>("select link_key from decks where id = $1", [id])).rows[0]?.link_key;
    const guest = { id: "guest", teams: [], anonymous: true, key: key as string };
    expect((await run("open_design", app, { design_id: id }, guest)).role).toBe("commenter");
    await run("set_general_access", app, { deck_id: id, access: "private" });
    await expect(run("open_design", app, { design_id: id }, guest)).rejects.toThrow(/no deck/);
  });

  it("renames, duplicates, copies artboards and moves to another pack release like a deck", async () => {
    expect((await run("rename_deck", app, { deck_id: id, title: "Launch Q4" })).title).toBe("Launch Q4");
    const dup = await run("duplicate_deck", app, { deck_id: id });
    expect(dup.title).toBe("Launch Q4 (copy)");
    const copied = await run("copy_slides", app, { from_deck: id, slides: ["banner"], deck_id: dup.deck_id });
    expect(copied.copied).toEqual({ banner: "banner-copy" });
    expect((await run("open_design", app, { design_id: dup.deck_id })).artboards.map((a: Json) => a.id)).toEqual(["post", "banner", "banner-copy"]);
    const deck = JSON.parse(readFileSync(join(REPO, "packs/acme-test/tests/golden/basics-en.json"), "utf8"));
    const { deck_id: deckId } = await run("create_deck", app, { deck });
    await expect(run("copy_slides", app, { from_deck: deckId, slides: ["regions"], deck_id: id })).rejects.toThrow(/artboards between designs/);
    await run("delete_deck", app, { deck_id: dup.deck_id });
    await expect(run("open_design", app, { design_id: dup.deck_id })).rejects.toThrow(/no deck/);
  });

  it("feeds the pack library: an artboard becomes a design template, inserted or started from", async () => {
    const e = await run("library_add", app, { deck_id: id, slide_id: "banner", title: "Webinar banner", tags: ["ad"] });
    expect(e).toMatchObject({ status: "approved", medium: "design" });
    expect((await run("library_list", app, { pack_id: "acme-test", medium: "design" })).entries.map((x: Json) => x.title)).toEqual(["Webinar banner"]);
    expect((await run("library_list", app, { pack_id: "acme-test", medium: "deck" })).entries).toEqual([]);
    const http = createHttp(app);
    expect((await http.request(`/api/library/${e.entry_id}/slide.png`)).headers.get("content-type")).toBe("image/png");
    // start a new design from it (a template), then insert it again into that design
    const started = await run("library_insert", app, { entry_id: e.entry_id, title: "Spring webinar" });
    const fresh = await run("open_design", app, { design_id: started.deck_id });
    expect([fresh.title, fresh.artboards.map((a: Json) => a.id)]).toEqual(["Spring webinar", ["banner"]]);
    await run("library_insert", app, { entry_id: e.entry_id, deck_id: started.deck_id });
    expect((await run("open_design", app, { design_id: started.deck_id })).artboards.map((a: Json) => a.id)).toEqual(["banner", "banner-copy"]);
    // its type and the compliance report, as a deck's
    await run("set_deck_kind", app, { deck_id: started.deck_id, kind: "marketing" });
    expect((await run("open_design", app, { design_id: started.deck_id })).kind).toBe("marketing");
    const report = await run("compliance_report", app, {});
    const rows = report.packs.find((p: Json) => p.pack_id === "acme-test").decks;
    expect(rows).toContainEqual(expect.objectContaining({ id: started.deck_id, medium: "design" }));
  });

  it("moves to another pack, and opens for its share link through the design page's tools", async () => {
    const moved = await run("rebrand_deck", app, { deck_id: id, pack_id: "diametral" });
    expect(moved.version).toBeGreaterThan(4);
    expect((await run("open_design", app, { design_id: id })).pack_id).toBe("diametral");
    await run("set_general_access", app, { deck_id: id, access: "anyone", role: "commenter" });
    const key = (await app.db.query<{ link_key: string }>("select link_key from decks where id = $1", [id])).rows[0]?.link_key as string;
    const http = createHttp(app);
    const call = (name: string, body: Json = {}) =>
      http.request(`/designs/${id}/tools/${name}?k=${key}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    // auth off here: the caller is the local user (the e2e checks a guest with the link)
    const opened = (await (await call("open_design")).json()) as Json;
    expect(opened.title).toBe("Launch Q4");
    expect((await call("add_comment", { slide_id: "post", text: "From the link" })).status).toBe(200);
    expect((await call("patch_design", { ops: [] })).status).toBe(404); // not a link tool
    await run("set_general_access", app, { deck_id: id, access: "private" });
  });

  it("places its owner's uploads only", async () => {
    const spec = campaign();
    spec.artboards[0]?.children.push({ type: "image", id: "pic", src: "file:someone-elses", alt: "", width: 10, height: 10 });
    await expect(run("create_design", app, { design: spec })).rejects.toThrow(/no file/);
  });
});
