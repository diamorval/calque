import { createReadStream, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { Hono, type Context } from "hono";
import { Client } from "@modelcontextprotocol/client";
import { createMcpHandler, InMemoryTransport, oauthMetadataResponse, type AuthInfo } from "@modelcontextprotocol/server";
import { applyComments, chat, type Message } from "@calque/agent";
import { PROVIDERS, type ModelConfig, type ProviderId } from "@calque/llm";
import { z } from "zod";
import { discovery, gate, userOf, type AuthConfig } from "./auth.ts";
import { Conflict } from "./decks.ts";
import { EngineError } from "./engine.ts";
import { buildServer, UI_HTML } from "./mcp.ts";
import { Forbidden, InvalidModel } from "./models.ts";
import { NotFound, type User } from "./packs.ts";
import { TOOLS, toolNamed, type App } from "./tools.ts";

/** The preview link is a capability URL: knowing a deck's id (random UUID) opens its preview,
reads it and comments on it, nothing else. */
// ponytail: capability URL; a signed-in session (Keycloak, Phase 5) when the web app lands.
const PREVIEW: User = { id: "preview", teams: [], local: true };

function status(e: unknown): 400 | 403 | 404 | 409 | 422 {
  if (e instanceof Forbidden) return 403;
  if (e instanceof NotFound) return 404;
  if (e instanceof Conflict) return 409;
  if (e instanceof EngineError || e instanceof InvalidModel || e instanceof z.ZodError) return 422;
  return 400;
}

function fail(c: Context, e: unknown) {
  const err = e as Error & { kind?: string; issues?: unknown };
  return c.json({ error: err.kind ?? err.name, message: err.message, issues: err.issues }, status(e));
}

/** The web agent's door into the tools: an MCP client on this server, in process, as `user`. */
export async function connect(app: App, user: User): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await (await buildServer(app, user)).connect(serverSide);
  const client = new Client({ name: "calque-agent", version: "0.1.0" });
  await client.connect(clientSide);
  return client;
}

const ModelBody = z.object({
  provider: z.enum(Object.keys(PROVIDERS) as [ProviderId, ...ProviderId[]]),
  model: z.string().min(1),
  api_key: z.string().optional(),
  base_url: z.string().url().optional(),
  default: z.boolean().optional(),
});
const ChatBody = z.object({
  messages: z.array(z.record(z.string(), z.unknown())).min(1).describe("The conversation so far (the client keeps it)."),
  workflow: z.enum(["build-presentation", "storyline", "draft-slides", "edit-slides", "review-deck"]).optional(),
  pack_id: z.string().optional(),
  model: z.string().optional().describe("A configured model id; default: the workspace default."),
});

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

  /** REST handler: authenticate, run, map errors to statuses. */
  const route = (fn: (c: Context, user: User) => Promise<unknown>) => async (c: Context) => {
    const a = await authenticate(c.req.raw);
    if (a instanceof Response) return a;
    try {
      return c.json((await fn(c, userOf(a))) ?? { ok: true });
    } catch (e) {
      return fail(c, e);
    }
  };
  const body = async (c: Context) => c.req.json().catch(() => ({}));

  // Settings > AI Models (PipesHub pattern). Keys go in, never out.
  http.get("/api/models", route(async () => ({ providers: app.models.catalog(), models: await app.models.list() })));
  http.post("/api/models", route(async (c, user) => app.models.configure(user, ModelBody.parse(await body(c)))));
  http.post("/api/models/:id/default", route((c, user) => app.models.setDefault(user, c.req.param("id") as string)));
  http.delete("/api/models/:id", route((c, user) => app.models.remove(user, c.req.param("id") as string)));

  // The web agent: one user turn, or apply a deck's open comments. Same tools as MCP, as this user.
  const agent = async (user: User, modelId: string | undefined, run: (client: Client, model: ModelConfig) => Promise<object>) => {
    const model = await app.models.resolve(modelId);
    const client = await connect(app, user);
    try {
      return { model: model.id, ...(await run(client, model)) };
    } finally {
      await client.close();
    }
  };
  http.post(
    "/api/agent/chat",
    route(async (c, user) => {
      const b = ChatBody.parse(await body(c));
      return agent(user, b.model, (client, model) =>
        chat({ client, model, messages: b.messages as Message[], workflow: b.workflow, pack_id: b.pack_id }),
      );
    }),
  );
  http.post(
    "/api/agent/apply-comments",
    route(async (c, user) => {
      const b = z.object({ deck_id: z.string(), model: z.string().optional() }).parse(await body(c));
      return agent(user, b.model, (client, model) => applyComments({ client, model, deck_id: b.deck_id }));
    }),
  );

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
