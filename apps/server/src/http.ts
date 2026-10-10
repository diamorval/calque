import { createReadStream, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, normalize } from "node:path";
import { Readable } from "node:stream";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { stream } from "hono/streaming";
import { Client } from "@modelcontextprotocol/client";
import { createMcpHandler, InMemoryTransport, oauthMetadataResponse } from "@modelcontextprotocol/server";
import { applyComments, chat, type Message } from "@calque/agent";
import { PROVIDERS, type ModelConfig, type ProviderId, type Step } from "@calque/llm";
import { z } from "zod";
import { auditLog } from "./audit.ts";
import { discovery, gate, userOf, type AuthConfig } from "./auth.ts";
import { Conflict } from "./decks.ts";
import { EngineError, REPO } from "./engine.ts";
import { attachment, MAX_UPLOAD, saveFile, ticketUser, TooLarge } from "./files.ts";
import { buildServer, UI_HTML } from "./mcp.ts";
import { InvalidModel, isAdmin } from "./models.ts";
import {
  addFont,
  archivePack,
  draftDir,
  draftPack,
  editPack,
  Forbidden,
  listPacks,
  NotFound,
  packVersions,
  publishDraft,
  replaceTemplate,
  replaceTokens,
  restorePack,
  setVisibility,
  type User,
} from "./packs.ts";
import { tokenUser } from "./preview.ts";
import { clientAddress, rateLimit } from "./ratelimit.ts";
import type { Sessions } from "./session.ts";
import { resetLink, setGeneralAccess, shares, transfer } from "./shares.ts";
import { TOOLS, toolNamed, type App } from "./tools.ts";

const LOCAL: User = { id: "local", name: "Local", teams: [], local: true };
export const WEB_DIST = join(REPO, "apps/web/dist");

function status(e: unknown): 400 | 403 | 404 | 409 | 413 | 422 {
  if (e instanceof Forbidden) return 403;
  if (e instanceof TooLarge) return 413;
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
  id: z.string().optional().describe("Edit this configuration; unset: a new one."),
  provider: z.enum(Object.keys(PROVIDERS) as [ProviderId, ...ProviderId[]]),
  model: z.string().min(1),
  label: z.string().max(40).optional(),
  api_key: z.string().optional(),
  base_url: z.string().url().optional(),
  headers: z.record(z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/, "invalid header name"), z.string()).optional(),
  resource: z.string().regex(/^[a-z0-9-]+$/i).optional(),
  api_version: z.string().regex(/^(v1|\d{4}-\d{2}-\d{2}(-preview)?)$/, "api_version: v1 or YYYY-MM-DD[-preview]").optional(),
  managed_identity: z.boolean().optional(),
  default: z.boolean().optional(),
});
const ChatBody = z.object({
  messages: z.array(z.record(z.string(), z.unknown())).min(1).describe("The conversation so far (the client keeps it)."),
  workflow: z.enum(["build-presentation", "storyline", "draft-slides", "edit-slides", "review-deck"]).optional(),
  pack_id: z.string().optional(),
  deck_id: z.string().optional(),
  model: z.string().optional().describe("A configured model id; default: the workspace default."),
  files: z.array(z.string()).optional().describe("Uploaded file ids attached to the conversation (POST /api/files)."),
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
    return a instanceof Response ? a : userOf(a);
  }

  /** A preview route's caller: the user a per-user URL token (`?t=`) was minted for; else, with the
  deck's share link key (`?k=`), the signed-in caller or an anonymous one presenting it; else `who`.
  Their access to the deck is checked as usual. Without auth (local only) neither is checked. */
  async function viewer(c: Context): Promise<User | Response> {
    if (!check) return who(c);
    const t = c.req.query("t");
    if (t) return tokenUser(app.secret, t, param(c, "id")) ?? c.json({ error: "Unauthorized", message: "preview link expired or invalid" }, 401);
    const k = c.req.query("k");
    if (!k) return who(c);
    const user = await who(c);
    return user instanceof Response ? { id: "guest", teams: [], anonymous: true, key: k } : { ...user, key: k };
  }

  // Body caps, checked before a body is read: a file upload (multipart), and a JSON call that may
  // carry a file in base64 (import_pptx, import_pack), 4/3 of its size.
  const tooLarge = (max: number) => (c: Context) => c.json({ error: "TooLarge", message: `request over ${Math.round(max / 1024 / 1024)} MB` }, 413);
  const limit = bodyLimit({ maxSize: MAX_UPLOAD + 1024 * 1024, onError: tooLarge(MAX_UPLOAD) }); // + multipart framing; saveFile checks the file itself
  const jsonLimit = bodyLimit({ maxSize: Math.ceil((MAX_UPLOAD * 4) / 3) + 1024 * 1024, onError: tooLarge(MAX_UPLOAD) });
  // Throttles (per minute): sign-in per address, agent runs and model tests (a provider call) per caller.
  const perUser = async (c: Context) => {
    const u = await who(c);
    return u instanceof Response ? clientAddress(c) : `user:${u.id}`;
  };
  const agentLimit = rateLimit({ max: 30, key: perUser });
  const modelLimit = rateLimit({ max: 10, key: perUser });

  const mcp = createMcpHandler(({ authInfo }) => buildServer(app, userOf(authInfo)));
  http.all("/mcp", jsonLimit, async (c) => {
    const a = check ? await check(c.req.raw) : undefined;
    if (a instanceof Response) return a;
    return mcp.fetch(c.req.raw, a ? { authInfo: a } : {});
  });

  if (auth && metadata) {
    http.get("/.well-known/*", async (c) => {
      const res = oauthMetadataResponse(c.req.raw, { oauthMetadata: await metadata(), resourceServerUrl: auth.resource });
      return res ?? c.notFound();
    });
  }

  if (sessions) {
    http.use("/auth/*", rateLimit({ max: 30 }));
    http.get("/auth/login", (c) => sessions.login(c));
    http.get("/auth/callback", async (c) => {
      try {
        return await sessions.callback(c);
      } catch (e) {
        return c.text(`sign-in failed: ${(e as Error).message}`, 400);
      }
    });
    http.get("/auth/logout", (c) => sessions.logout(c));
  }

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
    return { form, name: f.name, type: f.type, bytes: Buffer.from(await f.arrayBuffer()) };
  };

  http.get("/api/me", route(async (_, user) => ({ ...user, admin: isAdmin(user), auth: !!check })));

  // Uploads: a file in (multipart field `file`), its file_id out, usable only by its uploader.
  // `?ticket=` (from the upload_url tool) stands in for the caller's credentials.
  http.post("/api/files", limit, async (c) => {
    const ticket = c.req.query("ticket");
    const user = ticket ? await ticketUser(app.secret, ticket) : await who(c);
    if (!user) return c.json({ error: "Unauthorized", message: "invalid or expired upload ticket" }, 401);
    if (user instanceof Response) return user;
    try {
      const f = await upload(c, "file");
      return c.json(await saveFile(app.db, app.data, user, f.name, f.type || "application/octet-stream", f.bytes));
    } catch (e) {
      return fail(c, e);
    }
  });

  // REST: the same tools as MCP, one endpoint each.
  http.get("/api/tools", (c) =>
    c.json(Object.entries(TOOLS).map(([name, t]) => ({ name, title: t.title, description: t.description, input: z.toJSONSchema(t.input) }))),
  );
  http.post(
    "/api/tools/:name",
    jsonLimit,
    route(async (c, user) => {
      const t = toolNamed(param(c, "name"));
      if (!t) throw new NotFound(`no tool ${param(c, "name")}`);
      return t.run(app, user, t.input.parse(await body(c)));
    }),
  );

  http.get("/api/decks", route(async (_, user) => ({ decks: await app.decks.list(user) })));
  // the owner, or an admin
  http.delete("/api/decks/:id", route((c, user) => app.decks.remove(user, param(c, "id"))));

  // Admins (CALQUE_ADMIN_TEAM): who has access to a deck (never its link nor its content), make it
  // private, reset its link, transfer it.
  const admin = (fn: (c: Context, user: User) => Promise<unknown>) =>
    route(async (c, user) => {
      if (!isAdmin(user)) throw new Forbidden("admins only");
      return fn(c, user);
    });
  // The audit log, newest first: ?actor=&action=&target_type=&target_id=&since=&until=&limit=
  http.get(
    "/api/admin/audit",
    admin(async (c) => {
      const q = c.req.query();
      return { events: await auditLog(app.db, { ...q, limit: q.limit ? Number(q.limit) : undefined }) };
    }),
  );
  http.get(
    "/api/admin/decks/:id/access",
    admin(async (c, user) => {
      const { owner, people, general } = await shares(app.decks, user, param(c, "id")); // never the link, even to an owner
      return { owner, people, general };
    }),
  );
  http.post("/api/admin/decks/:id/private", admin((c, user) => setGeneralAccess(app.decks, user, param(c, "id"), "private", "viewer")));
  http.post(
    "/api/admin/decks/:id/reset-link",
    admin(async (c, user) => {
      await resetLink(app.decks, user, param(c, "id"));
      return { deck_id: param(c, "id"), reset: true };
    }),
  );
  http.post(
    "/api/admin/decks/:id/transfer",
    admin(async (c, user) => transfer(app.decks, user, param(c, "id"), z.object({ to: z.string().min(1) }).parse(await body(c)).to)),
  );

  // Settings > Brand packs: draft from a template, review, publish; visibility per pack.
  http.post(
    "/api/packs/drafts",
    limit,
    route(async (c, user) => {
      const { form, bytes } = await upload(c, "template");
      // optional: the company's own tokens.json instead of the drafted one
      const tokens = form.tokens instanceof File ? (JSON.parse(await form.tokens.text()) as Record<string, unknown>) : undefined;
      return draftPack(user, app.data, bytes, String(form.id ?? ""), String(form.name ?? form.id ?? ""), tokens);
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
    limit,
    route(async (c, user) => {
      const f = await upload(c, "font");
      return addFont(user, app.data, param(c, "id"), f.name, f.bytes);
    }),
  );
  http.post(
    "/api/packs/drafts/:id/publish",
    route(async (c, user) => {
      const b = Visibility.extend({ manifest: z.record(z.string(), z.unknown()), voice: z.string().optional(), note: z.string().optional() }).parse(await body(c));
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
  // Pack governance: every pack one manages (archived too), template/tokens swaps, archive, releases.
  http.get("/api/packs", route(async (_, user) => ({ packs: await listPacks(app.db, user, { manage: true }) })));
  http.post(
    "/api/packs/drafts/:id/template",
    route(async (c, user) => replaceTemplate(user, app.data, param(c, "id"), (await upload(c, "template")).bytes)),
  );
  http.post(
    "/api/packs/drafts/:id/tokens",
    route(async (c, user) => replaceTokens(user, app.data, param(c, "id"), (await upload(c, "tokens")).bytes)),
  );
  http.post(
    "/api/packs/:id/archive",
    route(async (c, user) => archivePack(app.db, user, param(c, "id"), z.object({ archived: z.boolean() }).parse(await body(c)).archived)),
  );
  http.get("/api/packs/:id/versions", route((c, user) => packVersions(app.db, user, param(c, "id"))));
  http.post(
    "/api/packs/:id/restore",
    route(async (c, user) => {
      const b = z.object({ version: z.number().int().positive(), note: z.string().optional() }).parse(await body(c));
      return restorePack(app.db, user, param(c, "id"), b.version, b.note);
    }),
  );

  // Settings > AI Models (PipesHub pattern). Keys go in, never out.
  http.get("/api/models", route(async () => ({ providers: app.models.catalog(), models: await app.models.list() })));
  http.post("/api/models", modelLimit, route(async (c, user) => app.models.configure(user, ModelBody.parse(await body(c)))));
  http.post("/api/models/:id/default", route((c, user) => app.models.setDefault(user, param(c, "id"))));
  http.delete("/api/models/:id", route((c, user) => app.models.remove(user, param(c, "id"))));

  /** Run the web agent as `user`. With `Accept: application/x-ndjson`, streams one line per step
  ({"step": {tools}}), then {"done": result} or {"error": …}; else answers JSON when done. */
  const agent =
    (parse: (b: unknown) => { model?: string | undefined }, run: (client: Client, model: ModelConfig, b: never, onStep: OnStep, user: User) => Promise<object>) =>
    async (c: Context) => {
      const user = await who(c);
      if (user instanceof Response) return user;
      const go = async (onStep: OnStep) => {
        const b = parse(await body(c));
        const model = await app.models.resolve(b.model);
        const client = await connect(app, user);
        try {
          return { model: model.id, ...(await run(client, model, b as never, onStep, user)) };
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
          // each tool: its name, and its error when it failed
          const tools = (st: Step) => st.toolCalls.map((t) => ({ name: t.toolName, ...(t.error !== undefined ? { error: t.error } : {}) }));
          await line({ done: await go((st) => void line({ step: { text: st.text, tools: tools(st) } })) });
        } catch (e) {
          await line({ error: failure(e) });
        }
      });
    };
  type OnStep = (s: Step) => void;

  http.post(
    "/api/agent/chat",
    agentLimit,
    agent(ChatBody.parse, async (client, model, b: z.infer<typeof ChatBody>, onStep, user) => {
      const files = await Promise.all((b.files ?? []).map((id) => attachment(app.db, app.data, user, id)));
      return chat({ client, model, onStep, messages: b.messages as Message[], workflow: b.workflow, pack_id: b.pack_id, deck_id: b.deck_id, files });
    }),
  );
  const ApplyBody = z.object({
    deck_id: z.string(),
    model: z.string().optional(),
    comment_ids: z.array(z.number().int()).min(1).optional().describe("Apply these open comments only; default: every open comment."),
  });
  http.post(
    "/api/agent/apply-comments",
    agentLimit,
    agent(ApplyBody.parse, (client, model, b: z.infer<typeof ApplyBody>, onStep) =>
      applyComments({ client, model, onStep, deck_id: b.deck_id, ...(b.comment_ids ? { comment_ids: b.comment_ids } : {}) }),
    ),
  );

  // Web preview: the same slide UI as the MCP App, talking REST instead of the host bridge.
  http.get("/decks/:id", async (c) => {
    if (!existsSync(UI_HTML)) return c.text("slide UI not built: pnpm --filter @calque/slide-ui build", 500);
    return c.html(await readFile(UI_HTML, "utf8"));
  });
  http.get("/decks/:id/data", async (c) => {
    const user = await viewer(c);
    if (user instanceof Response) return user;
    try {
      return c.json(await TOOLS.open_deck.run(app, user, { deck_id: param(c, "id"), render: true }));
    } catch (e) {
      return fail(c, e);
    }
  });
  http.post("/decks/:id/comments", async (c) => {
    const user = await viewer(c);
    if (user instanceof Response) return user;
    try {
      const b = TOOLS.add_comment.input.parse({ ...(await c.req.json()), deck_id: param(c, "id") });
      return c.json(await TOOLS.add_comment.run(app, user, b));
    } catch (e) {
      return fail(c, e);
    }
  });
  http.post("/decks/:id/comments/resolve", async (c) => {
    const user = await viewer(c);
    if (user instanceof Response) return user;
    try {
      const b = TOOLS.resolve_comments.input.parse({ ...(await c.req.json()), deck_id: param(c, "id") });
      return c.json(await TOOLS.resolve_comments.run(app, user, b));
    } catch (e) {
      return fail(c, e);
    }
  });
  http.get("/decks/:id/slides/:png", async (c) => {
    const user = await viewer(c);
    if (user instanceof Response) return user;
    const n = Number(param(c, "png").replace(/\.png$/, ""));
    try {
      const { slides } = await app.decks.render(user, param(c, "id"));
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
    const user = await viewer(c);
    if (user instanceof Response) return user;
    try {
      const v = c.req.query("v");
      const { path, version } = await app.decks.exportPath(user, param(c, "id"), v ? Number(v) : undefined);
      const deck = await app.decks.deck(user, param(c, "id"), "viewer");
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
  http.get("/decks/:id/deck.pdf", async (c) => {
    const user = await viewer(c);
    if (user instanceof Response) return user;
    try {
      const v = c.req.query("v");
      const { path, version } = await app.decks.exportPdf(user, param(c, "id"), v ? Number(v) : undefined);
      const deck = await app.decks.deck(user, param(c, "id"), "viewer");
      const name = `${deck.title.replace(/[^\p{L}\p{N} _-]+/gu, "").trim() || "deck"} v${version}.pdf`;
      return new Response(Readable.toWeb(createReadStream(path)) as ReadableStream, {
        headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}` },
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
