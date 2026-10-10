import { readFileSync } from "node:fs";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHttp } from "../src/http.ts";
import type { App } from "../src/tools.ts";
import { acmeDeck, ENGINE_TIMEOUT, testApp } from "./helpers.ts";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("MCP server over Streamable HTTP", { timeout: ENGINE_TIMEOUT }, () => {
  let app: App;
  let client: Client;
  let http: ReturnType<typeof createHttp>;
  beforeAll(async () => {
    app = await testApp();
    http = createHttp(app);
    client = new Client({ name: "test", version: "0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL("http://calque.test/mcp"), {
        fetch: async (url, init) => http.request(String(url), init),
      }),
    );
  });
  afterAll(async () => {
    await client.close();
    await app.db.close();
  });

  const call = async (name: string, args: Json = {}): Promise<Json> => {
    const r = await client.callTool({ name, arguments: args });
    if (r.isError) throw new Error(JSON.stringify(r.structuredContent));
    return r.structuredContent as Json;
  };

  it("lists every tool, prompt and resource", async () => {
    const tools = (await client.listTools()).tools;
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "add_comment", "add_slides", "copy_slides", "create_deck", "delete_deck", "export_pdf", "export_pptx", "import_pack", "import_pptx", "lint_deck", "rebrand_deck",
        "list_comments", "list_packs", "open_deck", "patch_deck", "restore_version", "review_deck", "upload_url",
        "list_decks", "share_deck", "unshare_deck", "list_shares", "set_general_access", "reset_link", "transfer_deck",
        "resolve_comments", "set_approval", "rename_deck", "duplicate_deck",
        "open_pack", "compliance_report",
      ].sort(),
    );
    const open = tools.find((t) => t.name === "open_deck");
    expect(open?._meta?.ui).toMatchObject({ resourceUri: "ui://calque/deck.html" });
    expect(tools.find((t) => t.name === "add_comment")?._meta?.ui).toMatchObject({ visibility: ["app"] });

    const prompts = (await client.listPrompts()).prompts.map((p) => p.name).sort();
    expect(prompts).toEqual(["build-presentation", "draft-slides", "edit-slides", "review-deck", "storyline"]);
    const prompt = await client.getPrompt({ name: "review-deck", arguments: { pack_id: "acme-test" } });
    const text = (prompt.messages[0]?.content as { text: string }).text;
    expect(text).toContain("# Workflow: review");
    expect(text).toContain("pack://acme-test/DESIGN.md");

    const uris = (await client.listResources()).resources.map((r) => r.uri);
    expect(uris).toContain("core://doctrine");
    expect(uris).toContain("core://workflows/build");
    expect(uris).toContain("pack://diametral/voice");
    expect(uris).toContain("pack://acme-test/template-map");
    expect(uris).toContain("pack://diametral/exemplar/exemplar-s1-s9.jpg");
    expect(uris).toContain("pack://diametral/icons/compass.png");
    const icon = (await client.readResource({ uri: "pack://diametral/icons/compass.png" })).contents[0] as Json;
    expect(icon.mimeType).toBe("image/png");
    expect(Buffer.from(icon.blob, "base64").subarray(1, 4).toString()).toBe("PNG");
    await expect(client.readResource({ uri: "pack://diametral/icons/..%2Fpack.yaml" })).rejects.toThrow(/no icons image/);
    const ui = (await client.readResource({ uri: "ui://calque/deck.html" })).contents[0] as Json;
    expect(ui.mimeType).toBe("text/html;profile=mcp-app");
    expect(ui.text).toContain('<div id="root">');
    expect(ui._meta.ui.csp.resourceDomains).toEqual(["http://calque.test"]);

    const design = await client.readResource({ uri: "pack://acme-test/DESIGN.md" });
    expect((design.contents[0] as { text: string }).text).toContain("Acme");
  });

  it("works a deck end to end: create, open, comment, patch, lint, add, undo, export, import", async () => {
    expect((await call("list_packs")).packs.map((p: Json) => p.id)).toEqual(["acme-test", "diametral"]);

    const created = await call("create_deck", { deck: acmeDeck() });
    const id = created.deck_id;
    expect(created.preview_url).toMatch(new RegExp(`^http://calque.test/decks/${id}\\?t=[\\w-]+\\.[\\w-]+$`));

    const opened = await call("open_deck", { deck_id: id });
    expect(opened.slides).toHaveLength(acmeDeck().slides.length);
    const cover = opened.slides[0];
    expect(cover.image_url).toMatch(new RegExp(`^http://calque.test/decks/${id}/slides/1\\.png\\?v=1&t=`));
    expect(cover.shapes.some((s: Json) => s.shape_id === 2)).toBe(true);

    const comment = (await call("add_comment", { deck_id: id, slide_id: "cover", shape_id: 2, text: "Say 'grew 12%'" })).comment;
    expect((await call("list_comments", { deck_id: id })).comments).toHaveLength(1);

    const patched = await call("patch_deck", {
      deck_id: id,
      ops: [{ op: "set", slide: "cover", shape_id: 2, value: "Sales grew 12% where we invested" }],
      resolves: [comment.id],
    });
    expect(patched.version).toBe(2);
    expect((await call("list_comments", { deck_id: id })).comments).toHaveLength(0);
    expect((await call("lint_deck", { deck_id: id })).errors).toBe(0);

    const added = await call("add_slides", {
      deck_id: id,
      slides: [{ id: "extra", message: "One more divider", message_type: "divider", form: "divider", source: { kind: "clone", role: "divider", values: { "2": "Next" } } }],
    });
    const spec = (await call("open_deck", { deck_id: id, render: false })).spec;
    expect(spec.slides.at(-2).id).toBe("extra"); // before the closing slide
    expect(added.version).toBe(3);

    const undone = await call("restore_version", { deck_id: id });
    expect(undone.slides).not.toContain("extra");

    const exported = await call("export_pptx", { deck_id: id });
    expect(exported.path).toMatch(/v4\.pptx$/);
    const res = await http.request(exported.download_url);
    expect(res.headers.get("content-type")).toContain("presentationml");

    const pdf = await call("export_pdf", { deck_id: id });
    expect(pdf).toMatchObject({ version: 4, path: expect.stringMatching(/v4\.pdf$/) });
    const got = await http.request(pdf.download_url);
    expect(got.headers.get("content-type")).toBe("application/pdf");
    expect(got.headers.get("content-disposition")).toMatch(/v4\.pdf$/);
    expect(Buffer.from(await got.arrayBuffer()).subarray(0, 4).toString()).toBe("%PDF");

    const imported = await call("import_pptx", {
      file: { base64: readFileSync(exported.path).toString("base64") },
      pack_id: "acme-test",
      language: "en",
    });
    expect(imported.slides).toHaveLength(acmeDeck().slides.length);
    expect((await call("lint_deck", { deck_id: imported.deck_id })).errors).toBe(0);
  });

  it("serves the web preview without auth (local only): data, PNGs and comments read back by list_comments", async () => {
    const { deck_id } = await call("create_deck", { deck: acmeDeck() });
    const data = (await (await http.request(`/decks/${deck_id}/data`)).json()) as Json;
    expect(data.slides.length).toBeGreaterThan(0);
    const png = await http.request(`/decks/${deck_id}/slides/1.png`);
    expect(png.headers.get("content-type")).toBe("image/png");
    const posted = await http.request(`/decks/${deck_id}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slide_id: "regions", text: "Sort by growth" }),
    });
    expect(posted.status).toBe(200);
    const comments = (await call("list_comments", { deck_id })).comments;
    expect(comments).toMatchObject([{ slide_id: "regions", text: "Sort by growth", author: "local" }]);
  });

  it("returns tool errors as results, with the engine's issues", async () => {
    const bad = acmeDeck();
    (bad.slides[2] as { form: string }).form = "pie";
    const r = await client.callTool({ name: "create_deck", arguments: { deck: bad } });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.structuredContent)).toContain("regions");
  });

  it("exposes the same tools over REST", async () => {
    const list = (await (await http.request("/api/tools")).json()) as Json[];
    expect(list.map((t) => t.name)).toContain("patch_deck");
    const res = await http.request("/api/tools/list_packs", { method: "POST", body: "{}" });
    expect(((await res.json()) as Json).packs).toHaveLength(2);
    const missing = await http.request("/api/tools/open_deck", {
      method: "POST",
      body: JSON.stringify({ deck_id: "00000000-0000-4000-8000-000000000000" }),
    });
    expect(missing.status).toBe(404);
  });
});
