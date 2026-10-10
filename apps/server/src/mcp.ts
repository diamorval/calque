import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { McpServer, ResourceTemplate, type CallToolResult } from "@modelcontextprotocol/server";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { stringify } from "yaml";
import { z } from "zod";
import { REPO } from "./engine.ts";
import { getPack, listPacks, type User } from "./packs.ts";
import { imageType, packImage, packImages, resolvePack } from "./portal.ts";
import { TOOLS, type App } from "./tools.ts";

export const UI_URI = "ui://calque/deck.html";
export const UI_HTML = join(REPO, "packages/slide-ui/dist/app.html");

/** pack://<id>/<name> -> file in the pack. The names the workflows in core/ read. */
const PACK_FILES: Record<string, { file: string; mime: string }> = {
  manifest: { file: "pack.yaml", mime: "application/yaml" },
  "DESIGN.md": { file: "DESIGN.md", mime: "text/markdown" },
  voice: { file: "voice.md", mime: "text/markdown" },
  exemplar: { file: "exemplar.md", mime: "text/markdown" },
  storyline: { file: "storyline.md", mime: "text/markdown" },
  "template-map": { file: "template-map.yaml", mime: "application/yaml" },
  tokens: { file: "tokens.json", mime: "application/json" },
};

/** Prompt name -> core workflow. The prompts are the product's skills, valid for every pack. */
const PROMPTS: Record<string, { workflow: string; title: string }> = {
  "build-presentation": { workflow: "build", title: "Build a presentation" },
  storyline: { workflow: "storyline", title: "Design a deck storyline" },
  "draft-slides": { workflow: "draft", title: "Draft one or a few slides" },
  "edit-slides": { workflow: "edit", title: "Edit an existing deck" },
  "review-deck": { workflow: "review", title: "Review a deck" },
};

async function coreFiles(): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(join(REPO, "core"), { recursive: true, withFileTypes: true })) {
    if (e.isFile() && /\.(md|yaml)$/.test(e.name)) out.push(relative(join(REPO, "core"), join(e.parentPath, e.name)));
  }
  return out.sort();
}

const asResult = (data: Record<string, unknown>): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data) }],
  structuredContent: data,
});

export async function buildServer(app: App, user: User): Promise<McpServer> {
  const server = new McpServer({ name: "calque", version: "0.1.0" });

  for (const [name, t] of Object.entries(TOOLS)) {
    const ui = t.ui || t.appOnly ? { resourceUri: UI_URI, ...(t.appOnly ? { visibility: ["app"] } : {}) } : undefined;
    server.registerTool(
      name,
      {
        title: t.title,
        description: t.description,
        inputSchema: t.input,
        annotations: { readOnlyHint: t.readOnly ?? false },
        ...(ui ? { _meta: { ui } } : {}),
      },
      async (args: unknown) => {
        try {
          return asResult(await t.run(app, user, args as never));
        } catch (e) {
          const err = e as Error & { kind?: string; issues?: unknown };
          return { ...asResult({ error: err.kind ?? err.name, message: err.message, issues: err.issues }), isError: true };
        }
      },
    );
  }

  for (const path of await coreFiles()) {
    const uri = `core://${path.replace(/\.(md|yaml)$/, "")}`;
    server.registerResource(path, uri, { mimeType: path.endsWith(".md") ? "text/markdown" : "application/yaml" }, async () => ({
      contents: [{ uri, text: await readFile(join(REPO, "core", path), "utf8") }],
    }));
  }

  server.registerResource(
    "pack",
    new ResourceTemplate("pack://{id}/{name}", {
      list: async () => ({
        resources: (await listPacks(app.db, user)).flatMap((p) =>
          Object.entries(PACK_FILES).map(([name, f]) => ({ uri: `pack://${p.id}/${name}`, name: `${p.id} ${name}`, mimeType: f.mime })),
        ),
      }),
    }),
    {
      description:
        "A brand pack's charter (DESIGN.md), voice, exemplar, storyline, template-map, tokens and manifest. A pack that extends a group pack shows the voice, exemplar, storyline and slop rules it inherits.",
    },
    async (uri, vars) => {
      const pack = await getPack(app.db, user, String(vars.id));
      const name = String(vars.name);
      const f = PACK_FILES[name];
      if (!f) throw new Error(`pack resources: ${Object.keys(PACK_FILES).join(", ")}`);
      // inherited from the parent pack: docs, and the manifest's slop rules
      const r = ["voice", "exemplar", "storyline", "manifest"].includes(name) ? await resolvePack(pack.dir) : null;
      if (r && name === "manifest" && r.extends.length) return { contents: [{ uri: uri.href, mimeType: f.mime, text: stringify(r.manifest) }] };
      const path = r && name !== "manifest" ? r.docs[name as keyof typeof r.docs] : join(pack.dir, f.file);
      const text = path && existsSync(path) ? await readFile(path, "utf8") : `(${pack.id} has no ${f.file})`;
      return { contents: [{ uri: uri.href, mimeType: f.mime, text }] };
    },
  );

  // the pack's images: exemplar pages (inherited with the exemplar) and icons
  for (const kind of ["exemplar", "icons"] as const) {
    server.registerResource(
      `pack-${kind}`,
      new ResourceTemplate(`pack://{id}/${kind}/{file}`, {
        list: async () => ({
          resources: (
            await Promise.all(
              (await listPacks(app.db, user)).map(async (p) =>
                (await packImages((await getPack(app.db, user, p.id)).dir, kind)).map((img) => ({
                  uri: `pack://${p.id}/${kind}/${encodeURIComponent(img.name)}`,
                  name: `${p.id} ${kind} ${img.name}`,
                  mimeType: imageType(img.name),
                })),
              ),
            )
          ).flat(),
        }),
      }),
      { description: kind === "icons" ? "A brand pack's icons." : "A brand pack's exemplar pages: what a good deck on it looks like." },
      async (uri, vars) => {
        const file = decodeURIComponent(String(vars.file));
        const path = await packImage(app.db, user, String(vars.id), kind, file);
        return { contents: [{ uri: uri.href, mimeType: imageType(file), blob: (await readFile(path)).toString("base64") }] };
      },
    );
  }

  for (const [name, p] of Object.entries(PROMPTS)) {
    server.registerPrompt(
      name,
      {
        title: p.title,
        description: `core/workflows/${p.workflow}.md on the chosen pack`,
        argsSchema: z.object({
          pack_id: z.string().optional().describe("Brand pack (list_packs)."),
          request: z.string().optional().describe("What the user wants."),
        }),
      },
      async ({ pack_id, request }) => {
        const workflow = await readFile(join(REPO, "core/workflows", `${p.workflow}.md`), "utf8");
        const pack = pack_id
          ? `Active pack: \`${pack_id}\`. Read its resources (pack://${pack_id}/DESIGN.md, voice, template-map) as the workflow says.`
          : "No pack chosen yet: call list_packs and ask which one, unless the request makes it obvious.";
        const text = [workflow, "---", pack, "Core knowledge: core://doctrine, core://compositions, core://anti-slop, core://forms.", request ? `Request: ${request}` : ""]
          .filter(Boolean)
          .join("\n\n");
        return { messages: [{ role: "user", content: { type: "text", text } }] };
      },
    );
  }

  server.registerResource(
    "deck-ui",
    UI_URI,
    { mimeType: RESOURCE_MIME_TYPE, description: "Rendered deck: slides, inspector, comments." },
    async () => ({
      contents: [
        {
          uri: UI_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: await readFile(UI_HTML, "utf8"),
          // slide PNGs are served by this server
          _meta: { ui: { csp: { resourceDomains: [app.publicUrl] } } },
        },
      ],
    }),
  );

  return server;
}
