import { createReadStream, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, normalize } from "node:path";
import { Readable } from "node:stream";
import { Hono, type Context } from "hono";
import { getCookie } from "hono/cookie";
import { stream } from "hono/streaming";
import { Client } from "@modelcontextprotocol/client";
import { createMcpHandler, InMemoryTransport, oauthMetadataResponse } from "@modelcontextprotocol/server";
import { applyComments, chat, type Message } from "@calque/agent";
import { PROVIDERS, type ModelConfig, type ProviderId } from "@calque/llm";
import { z } from "zod";
import { discovery, gate, identityOf, userOf, type AuthConfig } from "./auth.ts";
import { Conflict } from "./decks.ts";
import { EngineError, REPO } from "./engine.ts";
import { buildServer, UI_HTML } from "./mcp.ts";
import { InvalidModel, isAdmin } from "./models.ts";
import { addFont, draftDir, draftPack, editPack, Forbidden, NotFound, publishDraft, setVisibility, type User } from "./packs.ts";
import { scimRoutes } from "./scim.ts";
import { SESSION, type Sessions } from "./session.ts";
import { TOOLS, toolNamed, type App } from "./tools.ts";

/** The preview link is a capability URL: knowing a deck's id (random UUID) opens its preview,
reads it and comments on it, nothing else. The MCP App inside Claude loads its PNGs from here,
where no web session exists. */
const PREVIEW: User = { id: "preview", teams: [], local: true };
const LOCAL: User = { id: "local", name: "Local", teams: [], local: true };
export const WEB_DIST = join(REPO, "apps/web/dist");

function status(e: unknown): 400 | 403 | 404 | 409 | 422 {
  if (e instanceof Forbidden) return 403;
  if (e instanceof NotFound) return 404;
  if (e instanceof Conflict) return 409;
  if (e instanceof EngineError || e instanceof InvalidModel || e instanceof z.ZodError) return 422;
  return 400;
}

const failure = (e: unknown) => {
  const err = e as Error & { kind?: string; issues?: unknown };
  return { error: err.kind ?? err.name, message: err.message, issues: err.issues };
};
const fail = (c: Context, e: unknown) => c.json(failure(e), status(e));

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
  deck_id: z.string().optional(),
  model: z.string().optional().describe("A configured model id; default: the workspace default."),
});
const Visibility = z.object({ visibility: z.enum(["workspace", "team"]), teams: z.array(z.string()).optional() });

export function createHttp(app: App, auth?: AuthConfig, sessions?: Sessions): Hono {
  const http = new Hono();
  const metadata = auth && discovery(auth);
  const check = auth && metadata && gate(auth, metadata);

  /** The caller: a web session, else a bearer token; the 401 to return otherwise. No auth = local dev. */
  async function who(c: Context): Promise<User | Response> {
    if (!check) return LOCAL;
    const s = await sessions?.user(c);
    if (s) return s;
    const a = await check(c.req.raw);
    if (a instanceof Response) return a;
    return (await app.access.blocked(identityOf(a))) ? deactivated(c) : userOf(a);
  }
  const deactivated = (c: Context) => c.json({ error: "Unauthorized", message: "this account is deactivated" }, 401);

  const mcp = createMcpHandler(({ authInfo }) => buildServer(app, userOf(authInfo)));
  http.all("/mcp", async (c) => {
    const a = check ? await check(c.req.raw) : undefined;
    if (a instanceof Response) return a;
    if (a && (await app.access.blocked(identityOf(a)))) return deactivated(c);
    return mcp.fetch(c.req.raw, a ? { authInfo: a } : {});
  });

  if (auth && metadata) {
    http.get("/.well-known/*", async (c) => {
      const res = oauthMetadataResponse(c.req.raw, { oauthMetadata: await metadata(), resourceServerUrl: auth.resource });
      return res ?? c.notFound();
    });
  }

  if (sessions) {
    http.get("/auth/login", (c) => sessions.login(c));
    http.get("/auth/callback", async (c) => {
      try {
        return await sessions.callback(c);
      } catch (e) {
        return c.text(`sign-in failed: ${(e as Error).message}`, 400);
      }
    });
    http.get("/auth/logout", (c) => sessions.logout(c));

    /** CSRF: a state-changing /api request riding on the session cookie must come from the app's own
    origin (Origin, else Referer). Bearer requests (MCP, API clients) carry no ambient credential. */
    const origin = new URL(app.publicUrl).origin;
    const refererOrigin = (r?: string) => {
      try {
        return r ? new URL(r).origin : undefined;
      } catch {
        return undefined;
      }
    };
    http.use("/api/*", async (c, next) => {
      if (["GET", "HEAD", "OPTIONS"].includes(c.req.method) || c.req.header("authorization") || !getCookie(c, SESSION)) return next();
      if ((c.req.header("origin") ?? refererOrigin(c.req.header("referer"))) !== origin) {
        return c.json({ error: "Forbidden", message: `cross-site request refused: Origin must be ${origin}` }, 403);
      }
      return next();
    });
  }

  // SCIM 2.0 deprovisioning (scim.ts), when the IdP has a token for it.
  const scimToken = process.env.CALQUE_SCIM_TOKEN;
  if (scimToken) scimRoutes(http, app.access, scimToken, app.publicUrl);

  /** REST handler: authenticate, run, map errors to statuses. */
  const route = (fn: (c: Context, user: User) => Promise<unknown>) => async (c: Context) => {
    const user = await who(c);
    if (user instanceof Response) return user;
    try {
      return c.json((await fn(c, user)) ?? { ok: true });
    } catch (e) {
      return fail(c, e);
    }
  };
  const body = async (c: Context) => c.req.json().catch(() => ({}));
  const param = (c: Context, name: string) => c.req.param(name) as string;
  /** A multipart form and its file `field`. */
  const upload = async (c: Context, field: string) => {
    const form = await c.req.parseBody();
    const f = form[field];
    if (!(f instanceof File)) throw new Error(`missing file field ${JSON.stringify(field)}`);
    return { form, name: f.name, bytes: Buffer.from(await f.arrayBuffer()) };
  };

  http.get("/api/me", route(async (_, user) => ({ ...user, admin: isAdmin(user), auth: !!check })));

  // REST: the same tools as MCP, one endpoint each.
  http.get("/api/tools", (c) =>
    c.json(Object.entries(TOOLS).map(([name, t]) => ({ name, title: t.title, description: t.description, input: z.toJSONSchema(t.input) }))),
  );
  http.post(
    "/api/tools/:name",
    route(async (c, user) => {
      const t = toolNamed(param(c, "name"));
      if (!t) throw new NotFound(`no tool ${param(c, "name")}`);
      return t.run(app, user, t.input.parse(await body(c)));
    }),
  );

  http.get("/api/decks", route(async (_, user) => ({ decks: await app.decks.list(user) })));

  // Settings > Brand packs: draft from a template, review, publish; visibility per pack.
  http.post(
    "/api/packs/drafts",
    route(async (c, user) => {
      const { form, bytes } = await upload(c, "template");
      return draftPack(user, app.data, bytes, String(form.id ?? ""), String(form.name ?? form.id ?? ""));
    }),
  );
  http.get("/api/packs/drafts/:id/slides/:png", async (c) => {
    const user = await who(c);
    if (user instanceof Response) return user;
    try {
      const dir = await draftDir(user, app.data, param(c, "id"));
      const n = Number(param(c, "png").replace(/\.png$/, ""));
      const path = join(dir, "render", `slide-${n}.png`);
      if (!Number.isInteger(n) || !existsSync(path)) return c.notFound();
      return new Response(Readable.toWeb(createReadStream(path)) as ReadableStream, { headers: { "content-type": "image/png" } });
    } catch (e) {
      return fail(c, e);
    }
  });
  http.post(
    "/api/packs/drafts/:id/fonts",
    route(async (c, user) => {
      const f = await upload(c, "font");
      return addFont(user, app.data, param(c, "id"), f.name, f.bytes);
    }),
  );
  http.post(
    "/api/packs/drafts/:id/publish",
    route(async (c, user) => {
      const b = Visibility.extend({ manifest: z.record(z.string(), z.unknown()), voice: z.string().optional() }).parse(await body(c));
      return publishDraft(app.db, user, app.data, param(c, "id"), b);
    }),
  );
  http.post("/api/packs/:id/edit", route((c, user) => editPack(app.db, user, app.data, param(c, "id"))));
  http.post(
    "/api/packs/:id/visibility",
    route(async (c, user) => {
      const b = Visibility.parse(await body(c));
      return setVisibility(app.db, user, param(c, "id"), b.visibility, b.teams ?? user.teams);
    }),
  );

  // Settings > AI Models (PipesHub pattern). Keys go in, never out.
  http.get("/api/models", route(async () => ({ providers: app.models.catalog(), models: await app.models.list() })));
  http.post("/api/models", route(async (c, user) => app.models.configure(user, ModelBody.parse(await body(c)))));
  http.post("/api/models/:id/default", route((c, user) => app.models.setDefault(user, param(c, "id"))));
  http.delete("/api/models/:id", route((c, user) => app.models.remove(user, param(c, "id"))));

  /** Run the web agent as `user`. With `Accept: application/x-ndjson`, streams one line per step
  ({"step": {tools}}), then {"done": result} or {"error": …}; else answers JSON when done. */
  const agent =
    (parse: (b: unknown) => { model?: string | undefined }, run: (client: Client, model: ModelConfig, b: never, onStep: OnStep) => Promise<object>) =>
    async (c: Context) => {
      const user = await who(c);
      if (user instanceof Response) return user;
      const go = async (onStep: OnStep) => {
        const b = parse(await body(c));
        const model = await app.models.resolve(b.model);
        const client = await connect(app, user);
        try {
          return { model: model.id, ...(await run(client, model, b as never, onStep)) };
        } finally {
          await client.close();
        }
      };
      if (!c.req.header("accept")?.includes("application/x-ndjson")) {
        try {
          return c.json(await go(() => {}));
        } catch (e) {
          return fail(c, e);
        }
      }
      c.header("content-type", "application/x-ndjson");
      return stream(c, async (s) => {
        const line = (o: object) => s.write(`${JSON.stringify(o)}\n`);
        try {
          await line({ done: await go((st) => void line({ step: { text: st.text, tools: st.toolCalls.map((t) => t.toolName) } })) });
        } catch (e) {
          await line({ error: failure(e) });
        }
      });
    };
  type OnStep = (s: { text: string; toolCalls: { toolName: string }[] }) => void;

  http.post(
    "/api/agent/chat",
    agent(ChatBody.parse, (client, model, b: z.infer<typeof ChatBody>, onStep) =>
      chat({ client, model, onStep, messages: b.messages as Message[], workflow: b.workflow, pack_id: b.pack_id, deck_id: b.deck_id }),
    ),
  );
  const ApplyBody = z.object({ deck_id: z.string(), model: z.string().optional() });
  http.post(
    "/api/agent/apply-comments",
    agent(ApplyBody.parse, (client, model, b: z.infer<typeof ApplyBody>, onStep) => applyComments({ client, model, onStep, deck_id: b.deck_id })),
  );

  // Web preview: the same slide UI as the MCP App, talking REST instead of the host bridge.
  http.get("/decks/:id", async (c) => {
    if (!existsSync(UI_HTML)) return c.text("slide UI not built: pnpm --filter @calque/slide-ui build", 500);
    return c.html(await readFile(UI_HTML, "utf8"));
  });
  http.get("/decks/:id/data", async (c) => {
    try {
      return c.json(await TOOLS.open_deck.run(app, PREVIEW, { deck_id: param(c, "id"), render: true }));
    } catch (e) {
      return fail(c, e);
    }
  });
  http.post("/decks/:id/comments", async (c) => {
    try {
      const b = TOOLS.add_comment.input.parse({ ...(await c.req.json()), deck_id: param(c, "id") });
      return c.json(await TOOLS.add_comment.run(app, PREVIEW, b));
    } catch (e) {
      return fail(c, e);
    }
  });
  http.get("/decks/:id/slides/:png", async (c) => {
    const n = Number(param(c, "png").replace(/\.png$/, ""));
    try {
      const { slides } = await app.decks.render(PREVIEW, param(c, "id"));
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
      const { path, version } = await app.decks.exportPath(PREVIEW, param(c, "id"), v ? Number(v) : undefined);
      const deck = await app.decks.deck(PREVIEW, param(c, "id"));
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

  // The web app (apps/web): its built files, and index.html for its client-side routes.
  const TYPES: Record<string, string> = { js: "text/javascript", css: "text/css", svg: "image/svg+xml", woff2: "font/woff2", png: "image/png", ico: "image/x-icon" };
  http.get("*", async (c) => {
    const path = normalize(join(WEB_DIST, new URL(c.req.url).pathname));
    const ext = path.split(".").pop() ?? "";
    if (path.startsWith(WEB_DIST) && TYPES[ext] && existsSync(path)) {
      return new Response(Readable.toWeb(createReadStream(path)) as ReadableStream, {
        headers: { "content-type": TYPES[ext], "cache-control": path.includes("/assets/") ? "max-age=31536000, immutable" : "no-cache" },
      });
    }
    const index = join(WEB_DIST, "index.html");
    if (c.req.path.startsWith("/api/") || !existsSync(index)) return c.notFound();
    return c.html(await readFile(index, "utf8"));
  });

  return http;
}
