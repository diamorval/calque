import { createReadStream, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, normalize } from "node:path";
import { Readable } from "node:stream";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { stream } from "hono/streaming";
import { Client } from "@modelcontextprotocol/client";
import { createMcpHandler, InMemoryTransport, oauthMetadataResponse } from "@modelcontextprotocol/server";
import { applyComments, chat, type Message } from "@calque/agent";
import { PROVIDERS, type ModelConfig, type ProviderId, type Step, type Usage } from "@calque/llm";
import { z } from "zod";
import { auditLog } from "./audit.ts";
import { adoptDraft, appendChat, decksIn, getChat, writable } from "./chats.ts";
import { compliance } from "./compliance.ts";
import { discovery, gate, identityOf, userOf, type AuthConfig } from "./auth.ts";
import { Conflict } from "./decks.ts";
import { EngineError, REPO } from "./engine.ts";
import { attachment, MAX_UPLOAD, saveFile, ticketUser, TooLarge } from "./files.ts";
import { imageFile } from "./images.ts";
import { librarySlide } from "./library.ts";
import { buildServer, UI_HTML } from "./mcp.ts";
import { InvalidModel, isAdmin } from "./models.ts";
import {
  addFont,
  archivePack,
  draftDir,
  draftPack,
  editPack,
  exemplarImage,
  Forbidden,
  listPacks,
  NotFound,
  packVersions,
  previewDraft,
  publishDraft,
  replaceLogo,
  replaceTemplate,
  replaceTokens,
  restorePack,
  setDefaultPack,
  setManagers,
  setVisibility,
  type User,
} from "./packs.ts";
import { imageType, packImage, packPortal, templateSlide } from "./portal.ts";
import { tokenUser } from "./preview.ts";
import { clientAddress, rateLimit } from "./ratelimit.ts";
import { scimRoutes } from "./scim.ts";
import { SESSION, type Sessions } from "./session.ts";
import { resetLink, setGeneralAccess, shares, transfer } from "./shares.ts";
import { TOOLS, toolNamed, type App } from "./tools.ts";
import { recordUsage, usageReport } from "./usage.ts";

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
  teams: z.array(z.string()).optional().describe("Restrict it to these teams ([]: everyone); unset keeps the stored ones."),
});
const ChatBody = z.object({
  messages: z.array(z.record(z.string(), z.unknown())).min(1).optional().describe("The conversation so far, kept by the client (nothing is stored)."),
  message: z
    .string()
    .min(1)
    .optional()
    .describe("Instead of `messages`: the new user message; the server holds the conversation (the deck's, else your new-deck draft) and adds this turn to it."),
  workflow: z.enum(["build-presentation", "storyline", "draft-slides", "edit-slides", "review-deck"]).optional(),
  pack_id: z.string().optional(),
  deck_id: z.string().optional(),
  model: z.string().optional().describe("A configured model id; default: the workspace default."),
  files: z.array(z.string()).optional().describe("Uploaded file ids attached to the conversation (POST /api/files)."),
}).refine((b) => !!b.messages !== (b.message !== undefined), "send either `messages` or `message`");
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

    /** CSRF: a state-changing /api or /decks request riding on the session cookie must come from the
    app's own origin (Origin, else Referer). Bearer requests (MCP, API clients) and preview calls with
    a per-user URL token (`?t=`, the MCP App) carry no ambient credential. */
    const origin = new URL(app.publicUrl).origin;
    const refererOrigin = (r?: string) => {
      try {
        return r ? new URL(r).origin : undefined;
      } catch {
        return undefined;
      }
    };
    const sameOrigin: MiddlewareHandler = async (c, next) => {
      if (["GET", "HEAD", "OPTIONS"].includes(c.req.method) || c.req.header("authorization") || c.req.query("t") || !getCookie(c, SESSION)) return next();
      if ((c.req.header("origin") ?? refererOrigin(c.req.header("referer"))) !== origin) {
        return c.json({ error: "Forbidden", message: `cross-site request refused: Origin must be ${origin}` }, 403);
      }
      return next();
    };
    http.use("/api/*", sameOrigin);
    http.use("/decks/*", sameOrigin);
  }

  // SCIM 2.0 deprovisioning (scim.ts), when the IdP has a token for it.
  const scimToken = process.env.CALQUE_SCIM_TOKEN;
  if (scimToken) scimRoutes(http, app.access, scimToken, app.publicUrl);

  // Microsoft 365 (m365.ts): each user connects their own account, in a browser signed in to
  // Calque (an MCP user signs in first: the link a tool gives goes through /auth/login). The login
  // state rides in a short-lived cookie scoped to /auth/m365.
  const M365_LOGIN = "calque_m365";
  const m365Cookie = { httpOnly: true, sameSite: "Lax", secure: app.publicUrl.startsWith("https:"), path: "/auth/m365" } as const;
  http.get("/auth/m365/connect", async (c) => {
    if (!app.m365) return c.text("Microsoft 365 is not set up on this server", 404);
    const user = await who(c);
    if (user instanceof Response) {
      const url = new URL(c.req.url);
      return sessions ? c.redirect(`/auth/login?return=${encodeURIComponent(url.pathname + url.search)}`) : user;
    }
    const back = c.req.query("return") ?? "/";
    // a path on this site only, as for sign-in
    const { url, state } = await app.m365.start(user, /^\/(?![/\\])\P{Cc}*$/u.test(back) ? back : "/");
    setCookie(c, M365_LOGIN, state, { ...m365Cookie, maxAge: 600 });
    return c.redirect(url);
  });
  http.get("/auth/m365/callback", async (c) => {
    if (!app.m365) return c.notFound();
    try {
      const q = c.req.query();
      const back = await app.m365.finish(getCookie(c, M365_LOGIN), { code: q.code, state: q.state, error_description: q.error_description ?? q.error });
      deleteCookie(c, M365_LOGIN, m365Cookie);
      return c.redirect(back);
    } catch (e) {
      return c.text(`Microsoft 365 connection failed: ${(e as Error).message}`, 400);
    }
  });

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
  // The app's name and logo in the web chrome, before sign-in too: neutral unless the deployment
  // white-labels it (CALQUE_APP_NAME, CALQUE_APP_LOGO: an image URL).
  const branding = { name: process.env.CALQUE_APP_NAME || "Calque", logo: process.env.CALQUE_APP_LOGO || null };
  http.get("/api/branding", (c) => c.json(branding));

  // The caller's Microsoft 365 connection: whether it is set up and connected, and to which account.
  const M365_OFF = { configured: false, connected: false, account: null };
  http.get("/api/m365", route(async (_, user) => (app.m365 ? app.m365.status(user) : M365_OFF)));
  http.delete("/api/m365", route(async (_, user) => (app.m365 ? app.m365.disconnect(user) : M365_OFF)));

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

  // ?q=: words in the title or slides; ?pack_id=: one pack (list_decks' query and pack_id)
  http.get("/api/decks", route(async (c, user) => ({ decks: await app.decks.list(user, { query: c.req.query("q"), pack_id: c.req.query("pack_id") }) })));
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
  // a draft's template slides (render/), and its sample deck previewed before publishing (preview/)
  for (const [route, folder] of [["slides", "render"], ["preview", "preview"]] as const)
    http.get(`/api/packs/drafts/:id/${route}/:png`, async (c) => {
      const user = await who(c);
      if (user instanceof Response) return user;
      try {
        const dir = await draftDir(user, app.data, param(c, "id"));
        const n = Number(param(c, "png").replace(/\.png$/, ""));
        const path = join(dir, folder, `slide-${n}.png`);
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
      const b = Visibility.extend({
        manifest: z.record(z.string(), z.unknown()),
        voice: z.string().optional(),
        exemplar: z.string().optional(),
        storyline: z.string().optional(),
        note: z.string().optional(),
      }).parse(await body(c));
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
  // Pack edits beyond the manifest: exemplar pages, the logo asset, a sample deck on the draft; co-managers.
  http.post(
    "/api/packs/drafts/:id/exemplar",
    limit,
    route(async (c, user) => {
      const f = await upload(c, "image");
      return exemplarImage(user, app.data, param(c, "id"), f.name, f.bytes);
    }),
  );
  http.post(
    "/api/packs/drafts/:id/exemplar/remove",
    route(async (c, user) => exemplarImage(user, app.data, param(c, "id"), z.object({ name: z.string() }).parse(await body(c)).name, null)),
  );
  http.post(
    "/api/packs/drafts/:id/logo",
    limit,
    route(async (c, user) => {
      const f = await upload(c, "logo");
      return replaceLogo(user, app.data, param(c, "id"), f.name, f.bytes);
    }),
  );
  http.post(
    "/api/packs/drafts/:id/preview",
    route(async (c, user) =>
      previewDraft(user, app.data, param(c, "id"), z.object({ manifest: z.record(z.string(), z.unknown()).optional() }).parse(await body(c)).manifest),
    ),
  );
  http.post(
    "/api/packs/:id/managers",
    route(async (c, user) => setManagers(app.db, user, param(c, "id"), z.object({ managers: z.array(z.string()) }).parse(await body(c)).managers)),
  );
  http.post(
    "/api/packs/:id/archive",
    route(async (c, user) => archivePack(app.db, user, param(c, "id"), z.object({ archived: z.boolean() }).parse(await body(c)).archived)),
  );
  // admins: the pack /new preselects ({default: false} clears it)
  http.post(
    "/api/packs/:id/default",
    route(async (c, user) => setDefaultPack(app.db, user, param(c, "id"), z.object({ default: z.boolean().default(true) }).parse(await body(c)).default)),
  );
  http.get("/api/packs/:id/versions", route((c, user) => packVersions(app.db, user, param(c, "id"))));
  http.post(
    "/api/packs/:id/restore",
    route(async (c, user) => {
      const b = z.object({ version: z.number().int().positive(), note: z.string().optional() }).parse(await body(c));
      return restorePack(app.db, user, param(c, "id"), b.version, b.note);
    }),
  );

  // The brand portal (read-only, anyone who sees the pack) and brand compliance (pack owners, admins).
  http.get("/api/packs/:id", route((c, user) => packPortal(app.db, user, param(c, "id"))));
  const file = (path: (c: Context, user: User) => Promise<string>, type: (path: string) => string) => async (c: Context) => {
    const user = await who(c);
    if (user instanceof Response) return user;
    try {
      const p = await path(c, user);
      return new Response(Readable.toWeb(createReadStream(p)) as ReadableStream, { headers: { "content-type": type(p), "cache-control": "no-cache" } });
    } catch (e) {
      return fail(c, e);
    }
  };
  http.get(
    "/api/packs/:id/slides/:png",
    file((c, user) => templateSlide(app.db, user, app.data, param(c, "id"), Number(param(c, "png").replace(/\.png$/, ""))), () => "image/png"),
  );
  for (const kind of ["exemplar", "icons"] as const)
    http.get(`/api/packs/:id/${kind}/:file`, file((c, user) => packImage(app.db, user, param(c, "id"), kind, param(c, "file")), imageType));
  http.get("/api/compliance", route((c, user) => compliance(app.db, app.decks, user, c.req.query("pack_id") || undefined)));

  // Settings > AI Models (PipesHub pattern). Keys go in, never out.
  // Everyone sees the models they may run (`your_default`: the one the agent runs for them); admins
  // see them all, and each team's default.
  http.get(
    "/api/models",
    route(async (_, user) => ({
      providers: app.models.catalog(),
      models: await app.models.list(user),
      ...(isAdmin(user) ? { team_defaults: await app.models.teamDefaults() } : {}),
    })),
  );
  http.post("/api/models", modelLimit, route(async (c, user) => app.models.configure(user, ModelBody.parse(await body(c)))));
  http.post("/api/models/:id/default", route((c, user) => app.models.setDefault(user, param(c, "id"))));
  http.post("/api/models/:id/teams", route(async (c, user) => app.models.restrict(user, param(c, "id"), z.object({ teams: z.array(z.string()) }).parse(await body(c)).teams)));
  http.post(
    "/api/models/team-defaults",
    route(async (c, user) => {
      const b = z.object({ team: z.string().min(1), model_id: z.string().nullable() }).parse(await body(c));
      return app.models.setTeamDefault(user, b.team, b.model_id);
    }),
  );
  // Usage metering (usage.ts): runs and tokens per user, team and model; ?since=&until= (ISO)
  http.get("/api/admin/usage", route(async (c, user) => usageReport(app.db, user, { since: c.req.query("since"), until: c.req.query("until") })));
  http.delete("/api/models/:id", route((c, user) => app.models.remove(user, param(c, "id"))));

  /** Run the web agent as `user` (a `name` run, metered in usage.ts). With `Accept: application/x-ndjson`,
  streams one line per step ({"step": {tools}}), then {"done": result} or {"error": …}; else answers JSON when done. */
  const agent =
    (
      name: string,
      parse: (b: unknown) => { model?: string | undefined; deck_id?: string | undefined },
      run: (client: Client, model: ModelConfig, b: never, onStep: OnStep, user: User) => Promise<{ usage: Usage }>,
    ) =>
    async (c: Context) => {
      const user = await who(c);
      if (user instanceof Response) return user;
      const go = async (onStep: OnStep) => {
        const b = parse(await body(c));
        const model = await app.models.resolve(b.model, user);
        const client = await connect(app, user);
        const started = Date.now();
        try {
          const r = await run(client, model, b as never, onStep, user);
          await recordUsage(app.db, user, { model_id: model.id, run: name, deck_id: b.deck_id, ...r.usage, duration_ms: Date.now() - started });
          return { model: model.id, ...r };
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
    agent("chat", (x) => ChatBody.parse(x), async (client, model, b: z.infer<typeof ChatBody>, onStep, user) => {
      const files = await Promise.all((b.files ?? []).map((id) => attachment(app.db, app.data, user, id)));
      if (b.message === undefined)
        return chat({ client, model, onStep, messages: b.messages as Message[], workflow: b.workflow, pack_id: b.pack_id, deck_id: b.deck_id, files });
      // the conversation held here (chats.ts): the files attached earlier come along, those a
      // colleague uploaded (theirs only) left out
      await writable(app.decks, user, b.deck_id);
      const held = await getChat(app.db, app.decks, user, b.deck_id);
      const before = await Promise.all(held.files.filter((id) => !b.files?.includes(id)).map((id) => attachment(app.db, app.data, user, id).catch(() => undefined)));
      const asked: Message = { role: "user", content: b.message };
      const since = new Date();
      const r = await chat({
        client,
        model,
        onStep,
        messages: [...held.messages, asked],
        workflow: b.workflow,
        pack_id: b.pack_id,
        deck_id: b.deck_id,
        files: [...before.filter((f) => f !== undefined), ...files],
      });
      await appendChat(app.db, user, b.deck_id, [asked, ...r.messages], b.files ?? []);
      // a draft that made a deck becomes that deck's conversation
      const created = b.deck_id ? undefined : await adoptDraft(app.db, user, decksIn(r.messages), since);
      return { ...r, ...(created ? { deck_id: created } : {}) };
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
    agent("apply-comments", ApplyBody.parse, (client, model, b: z.infer<typeof ApplyBody>, onStep) =>
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

  // A slide library entry's image (library_list's thumbnail_url), for whoever may see the entry.
  http.get("/api/library/:id/slide.png", async (c) => {
    const user = await who(c);
    if (user instanceof Response) return user;
    try {
      const png = await librarySlide(app, user, param(c, "id"));
      return new Response(Readable.toWeb(createReadStream(png)) as ReadableStream, { headers: { "content-type": "image/png", "cache-control": "no-cache" } });
    } catch (e) {
      return fail(c, e);
    }
  });

  // An image library image (image_library_list's image_url), for whoever may see it. Sandboxed:
  // an SVG opened on its own runs no script.
  http.get("/api/library/images/:id", async (c) => {
    const user = await who(c);
    if (user instanceof Response) return user;
    try {
      const f = await imageFile(app, user, param(c, "id"));
      return new Response(Readable.toWeb(createReadStream(f.path)) as ReadableStream, {
        headers: { "content-type": f.type, "cache-control": "no-cache", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox", "x-content-type-options": "nosniff" },
      });
    } catch (e) {
      return fail(c, e);
    }
  });

  // The web app (apps/web): its built files, and index.html for its client-side routes.
  const TYPES: Record<string, string> = { js: "text/javascript", css: "text/css", svg: "image/svg+xml", woff2: "font/woff2", png: "image/png", ico: "image/x-icon", webmanifest: "application/manifest+json" };
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
