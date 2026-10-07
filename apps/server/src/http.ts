import { createReadStream, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { Hono, type Context } from "hono";
import { createMcpHandler, oauthMetadataResponse, type AuthInfo } from "@modelcontextprotocol/server";
import { z } from "zod";
import { discovery, gate, userOf, type AuthConfig } from "./auth.ts";
import { Conflict } from "./decks.ts";
import { EngineError } from "./engine.ts";
import { buildServer, UI_HTML } from "./mcp.ts";
import { NotFound, type User } from "./packs.ts";
import { TOOLS, toolNamed, type App } from "./tools.ts";

/** The preview link is a capability URL: knowing a deck's id (random UUID) opens its preview,
reads it and comments on it, nothing else. */
// ponytail: capability URL; a signed-in session (Keycloak, Phase 5) when the web app lands.
const PREVIEW: User = { id: "preview", teams: [], local: true };

function status(e: unknown): 400 | 404 | 409 | 422 {
  if (e instanceof NotFound) return 404;
  if (e instanceof Conflict) return 409;
  if (e instanceof EngineError || e instanceof z.ZodError) return 422;
  return 400;
}

function fail(c: Context, e: unknown) {
  const err = e as Error & { kind?: string; issues?: unknown };
  return c.json({ error: err.kind ?? err.name, message: err.message, issues: err.issues }, status(e));
}

export function createHttp(app: App, auth?: AuthConfig): Hono {
  const http = new Hono();
  const metadata = auth && discovery(auth);
  const check = auth && metadata && gate(auth, metadata);

  /** AuthInfo for this request, or the 401 challenge to return. No auth configured = local dev. */
  async function authenticate(req: Request): Promise<AuthInfo | Response | undefined> {
    return check ? check(req) : undefined;
  }

  const mcp = createMcpHandler(({ authInfo }) => buildServer(app, userOf(authInfo)));

  http.all("/mcp", async (c) => {
    const a = await authenticate(c.req.raw);
    if (a instanceof Response) return a;
    return mcp.fetch(c.req.raw, a ? { authInfo: a } : {});
  });

  if (auth && metadata) {
    http.get("/.well-known/*", async (c) => {
      const res = oauthMetadataResponse(c.req.raw, { oauthMetadata: await metadata(), resourceServerUrl: auth.resource });
      return res ?? c.notFound();
    });
  }

  // REST: the same tools as MCP, one endpoint each.
  http.get("/api/tools", (c) =>
    c.json(Object.entries(TOOLS).map(([name, t]) => ({ name, title: t.title, description: t.description, input: z.toJSONSchema(t.input) }))),
  );
  http.post("/api/tools/:name", async (c) => {
    const t = toolNamed(c.req.param("name"));
    if (!t) return c.json({ error: "NotFound", message: `no tool ${c.req.param("name")}` }, 404);
    const a = await authenticate(c.req.raw);
    if (a instanceof Response) return a;
    try {
      const args = t.input.parse(await c.req.json().catch(() => ({})));
      return c.json(await t.run(app, userOf(a), args));
    } catch (e) {
      return fail(c, e);
    }
  });

  // Web preview: the same slide UI as the MCP App, talking REST instead of the host bridge.
  http.get("/decks/:id", async (c) => {
    if (!existsSync(UI_HTML)) return c.text("slide UI not built: pnpm --filter @calque/slide-ui build", 500);
    return c.html(await readFile(UI_HTML, "utf8"));
  });
  http.get("/decks/:id/data", async (c) => {
    try {
      return c.json(await TOOLS.open_deck.run(app, PREVIEW, { deck_id: c.req.param("id"), render: true }));
    } catch (e) {
      return fail(c, e);
    }
  });
  http.post("/decks/:id/comments", async (c) => {
    try {
      const body = TOOLS.add_comment.input.parse({ ...(await c.req.json()), deck_id: c.req.param("id") });
      return c.json(await TOOLS.add_comment.run(app, PREVIEW, body));
    } catch (e) {
      return fail(c, e);
    }
  });
  http.get("/decks/:id/slides/:png", async (c) => {
    const n = Number(c.req.param("png").replace(/\.png$/, ""));
    try {
      const { slides } = await app.decks.render(PREVIEW, c.req.param("id"));
      const s = slides.find((x) => x.number === n);
      if (!s) return c.notFound();
      return new Response(Readable.toWeb(createReadStream(s.png)) as ReadableStream, {
        headers: { "content-type": "image/png", "cache-control": "no-cache" },
      });
    } catch (e) {
      return fail(c, e);
    }
  });
  http.get("/decks/:id/deck.pptx", async (c) => {
    try {
      const v = c.req.query("v");
      const { path, version } = await app.decks.exportPath(PREVIEW, c.req.param("id"), v ? Number(v) : undefined);
      const deck = await app.decks.deck(PREVIEW, c.req.param("id"));
      const name = `${deck.title.replace(/[^\p{L}\p{N} _-]+/gu, "").trim() || "deck"} v${version}.pptx`;
      return new Response(Readable.toWeb(createReadStream(path)) as ReadableStream, {
        headers: {
          "content-type": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
          "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
        },
      });
    } catch (e) {
      return fail(c, e);
    }
  });

  return http;
}
